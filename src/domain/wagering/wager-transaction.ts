import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../shared/errors";
import { Money } from "../money/money";
import { LedgerDirection } from "../wallet/wallet-ledger-entry";
import type { BusinessFailureCode, FailureCode, InfrastructureFailureCode } from "./failure-code";
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  referenceRetryDelayMs,
  type ReferenceRetryPolicy,
} from "./reference-retry-policy";

export enum WagerTransactionKind {
  Opening = "OPENING", // internal: wallet opening credit
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // accepted, not applied yet
  PendingReference = "PENDING_REFERENCE", // waiting for the referenced transaction
  Processed = "PROCESSED", // applied (terminal)
  Rejected = "REJECTED", // business rule violation (terminal)
  Failed = "FAILED", // permanent infrastructure error (terminal, auditable)
}

/**
 * Valid transitions. Terminal states have none.
 *
 *   PENDING ──────────► PROCESSED | REJECTED | FAILED
 *      │
 *      ▼
 *   PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED
 *      ▲         │
 *      └─────────┘ (retry scheduled)
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Kinds that providers may submit (API / queue). OPENING is internal only. */
export type SubmittableKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  /** Provider-side id of the referenced transaction — not the internal id. */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  balanceAfter: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

/** Identifiers used for the internal OPENING transaction. */
export const INTERNAL_PROVIDER_ID = "internal";

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    /** Wallet balance observed when the transaction reached a final result (for idempotent replays). */
    private _balanceAfter: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Provider-submitted transaction. Born in PENDING. Validates reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const kind = props.kind as WagerTransactionKind;

    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    if (!Object.values(WagerTransactionKind).includes(kind)) {
      throw new InvalidWagerTransactionError(`Unknown transaction kind "${String(props.kind)}"`);
    }

    const required = {
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }

    const reference = props.referenceExternalTransactionId?.trim() || undefined;
    const requiresReference =
      kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;

    if (requiresReference && !reference) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if (kind === WagerTransactionKind.Bet && reference) {
      throw new InvalidWagerTransactionError("BET cannot reference another transaction");
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("A transaction cannot reference itself");
    }

    // LOSS only records the outcome, so 0.00 is acceptable; every other kind moves money.
    if (props.money.isNegative() || (kind !== WagerTransactionKind.Loss && props.money.isZero())) {
      throw new InvalidWagerTransactionError(
        `${kind} amount must be ${kind === WagerTransactionKind.Loss ? "non-negative" : "positive"}`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      kind,
      props.money,
      reference,
      new Date(props.createdAt),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /**
   * Internal OPENING credit created together with the wallet. It is born
   * already PROCESSED because it is applied atomically with `Wallet.open`.
   */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError("OPENING amount must be positive");
    }
    const externalId = `opening:${props.walletId}`;
    return new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      externalId,
      `${INTERNAL_PROVIDER_ID}:${externalId}`,
      "",
      props.walletId,
      props.playerId,
      externalId,
      INTERNAL_PROVIDER_ID,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      new Date(props.at),
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      new Date(props.at),
      props.money,
      0,
      undefined,
    );
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt) : undefined,
      state.balanceAfter,
      state.referenceAttempts,
      state.nextReferenceAttemptAt ? new Date(state.nextReferenceAttemptAt) : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  /** Moment the transaction reached a terminal state. */
  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt ? new Date(this._nextReferenceAttemptAt) : undefined;
  }

  // ---- transitions (throw InvalidTransactionStateError when not allowed)

  markProcessed(props: { referenceTransactionId?: string; balanceAfter: Money; at: Date }): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = props.referenceTransactionId;
    this._balanceAfter = props.balanceAfter;
    this._processedAt = new Date(props.at);
    this._nextReferenceAttemptAt = undefined;
  }

  /** Records one more failed reference resolution and schedules the next attempt. */
  markPendingReference(
    now: Date,
    policy: ReferenceRetryPolicy = DEFAULT_REFERENCE_RETRY_POLICY,
    observedBalance?: Money,
  ): void {
    if (!this.requiresReference()) {
      throw new InvalidWagerTransactionError(`${this.kind} does not wait for references`);
    }
    this.transitionTo(WagerTransactionStatus.PendingReference);
    if (observedBalance !== undefined) {
      this._balanceAfter = observedBalance;
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = new Date(
      now.getTime() + referenceRetryDelayMs(this._referenceAttempts, policy),
    );
  }

  reject(code: BusinessFailureCode, props: { at: Date; observedBalance?: Money }): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._balanceAfter = props.observedBalance;
    this._processedAt = new Date(props.at);
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: InfrastructureFailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = new Date(at);
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  /** false for LOSS — it records the round outcome without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasExhaustedReferenceAttempts(policy: ReferenceRetryPolicy = DEFAULT_REFERENCE_RETRY_POLICY): boolean {
    return this._referenceAttempts >= policy.maxAttempts;
  }

  isDueForReferenceRetry(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._nextReferenceAttemptAt !== undefined &&
      this._nextReferenceAttemptAt.getTime() <= now.getTime()
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError("ROLLBACK direction depends on its reference");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS has no ledger effect");
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: new Date(this.createdAt),
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this.processedAt,
      balanceAfter: this._balanceAfter,
      referenceAttempts: this._referenceAttempts,
      nextReferenceAttemptAt: this.nextReferenceAttemptAt,
    };
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
  }
}
