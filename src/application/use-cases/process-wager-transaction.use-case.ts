import { Money, type MoneyProps } from "../../domain/money/money";
import { generateUuidV7 } from "../../domain/shared/uuid-v7";
import type { FailureCode } from "../../domain/wagering/failure-code";
import { computeWagerPayloadHash } from "../../domain/wagering/payload-hash";
import { settleWagerTransaction } from "../../domain/wagering/wager-settlement";
import {
  WagerTransaction,
  type SubmittableKind,
  type WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  UniqueConstraintError,
  WalletNotFoundError,
} from "../errors/application-errors";
import { NOOP_METRICS_PORT, type MetricsPort } from "../ports/metrics.port";
import type { TransactionalContext, UnitOfWork } from "../ports/unit-of-work.port";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import type { WalletRepository } from "../ports/wallet.repository";
import { buildSettlementOutboxMessages } from "../shared/outbox-events";
import {
  optionalTrimmedString,
  requireMoneyProps,
  requireNonEmptyString,
} from "../shared/validation";

export interface ProcessWagerTransactionInput {
  idempotencyKey: unknown;
  providerId: unknown;
  externalTransactionId: unknown;
  playerId: unknown;
  walletId: unknown;
  roundId: unknown;
  gameId: unknown;
  kind: unknown;
  money: unknown;
  referenceExternalTransactionId?: unknown;
  correlationId?: string;
  causationId?: string;
  now?: Date;
}

export interface ProcessWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

interface ParsedWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  payloadHash: string;
  candidate: WagerTransaction;
  correlationId?: string;
  causationId?: string;
  now: Date;
}

/**
 * Shared wager settlement use case invoked by both the HTTP API (§9) and the
 * SQS consumer (§10).
 *
 * Concurrency & idempotency guarantees:
 *  1. Fast-path lookup by `Idempotency-Key` and `(providerId, externalTransactionId)`
 *     before acquiring any row lock.
 *  2. Per-wallet pessimistic row lock (`SELECT ... FOR UPDATE`) inside a single
 *     SQL transaction — different wallets execute in parallel without global locks.
 *  3. Re-check of `Idempotency-Key` *after* acquiring the wallet lock so 50
 *     parallel identical requests serialize cleanly into 1 settlement + 49 replays.
 *  4. Fallback handling of unique constraint violations (`23505`) for cross-wallet
 *     idempotency key races.
 */
export class ProcessWagerTransactionUseCase {
  private readonly inFlightWalletLocks = new Map<string, number>();

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly walletRepo: WalletRepository,
    private readonly txRepo: WagerTransactionRepository,
    private readonly metrics: MetricsPort = NOOP_METRICS_PORT,
  ) {}

  async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionOutput> {
    const startedAt = performance.now();
    const parsed = this.parseAndValidate(input);

    // 1. Fast-path idempotency check before taking any row lock
    const preExisting = await this.checkExisting(
      parsed,
      this.txRepo,
      this.walletRepo,
    );
    if (preExisting) {
      this.metrics.recordDuplicateDetected("http_idempotency");
      this.metrics.recordProcessingDuration("http_wager", performance.now() - startedAt);
      return preExisting;
    }

    // 2. Transactional execution under per-wallet `SELECT ... FOR UPDATE`
    let output: ProcessWagerTransactionOutput;
    try {
      output = await this.unitOfWork.runInTransaction((tx) =>
        this.settleUnderWalletLock(parsed, tx),
      );
    } catch (error) {
      if (
        error instanceof UniqueConstraintError &&
        (error.constraint === "uq_transactions_idempotency_key" ||
          error.constraint === "uq_transactions_provider_ext_id")
      ) {
        const winnerByKey = await this.txRepo.findByIdempotencyKey(parsed.idempotencyKey);
        if (winnerByKey) {
          if (winnerByKey.matchesPayload(parsed.payloadHash)) {
            const replay = await this.resolveReplayOutput(winnerByKey, this.walletRepo);
            this.metrics.recordDuplicateDetected("http_idempotency");
            this.metrics.recordProcessingDuration("http_wager", performance.now() - startedAt);
            return replay;
          }
          throw new IdempotencyConflictError(parsed.idempotencyKey);
        }
        if (error.constraint === "uq_transactions_provider_ext_id") {
          throw new DuplicateExternalTransactionError(
            parsed.providerId,
            parsed.externalTransactionId,
          );
        }
      }
      throw error;
    }

    // Recorded strictly AFTER PostgreSQL COMMIT
    if (output.idempotentReplay) {
      this.metrics.recordDuplicateDetected("http_idempotency");
    } else {
      this.metrics.recordTransactionOutcome({
        status: output.status,
        kind: parsed.candidate.kind,
        channel: "http",
        failureCode: output.failureCode,
      });
    }
    this.metrics.recordProcessingDuration("http_wager", performance.now() - startedAt);
    return output;
  }

  /**
   * Executes inside an already-opened {@link TransactionalContext} (used by the
   * SQS Inbox/Outbox consumer in Phase 6 so inbox + settlement + outbox share
   * one atomic SQL transaction).
   */
  async executeInTransaction(
    input: ProcessWagerTransactionInput,
    tx: TransactionalContext,
  ): Promise<ProcessWagerTransactionOutput> {
    const parsed = this.parseAndValidate(input);
    const preExisting = await this.checkExisting(parsed, tx.transactions, tx.wallets);
    if (preExisting) return preExisting;
    return this.settleUnderWalletLock(parsed, tx);
  }

  private parseAndValidate(input: ProcessWagerTransactionInput): ParsedWagerCommand {
    const idempotencyKey = requireNonEmptyString(
      input.idempotencyKey,
      "Idempotency-Key",
      256,
      "MISSING_IDEMPOTENCY_KEY",
    );
    const providerId = requireNonEmptyString(input.providerId, "providerId", 64);
    const externalTransactionId = requireNonEmptyString(
      input.externalTransactionId,
      "externalTransactionId",
      128,
    );
    const playerId = requireNonEmptyString(input.playerId, "playerId", 64);
    const walletId = requireNonEmptyString(input.walletId, "walletId", 64);
    const roundId = requireNonEmptyString(input.roundId, "roundId", 128);
    const gameId = requireNonEmptyString(input.gameId, "gameId", 128);
    const kind = requireNonEmptyString(input.kind, "kind", 20);
    const referenceExternalTransactionId = optionalTrimmedString(
      input.referenceExternalTransactionId,
      "referenceExternalTransactionId",
      128,
    );
    const moneyProps = requireMoneyProps(input.money, "money");
    const money = Money.from(moneyProps);
    const now = input.now ?? new Date();

    const payloadHash = computeWagerPayloadHash({
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId,
    });

    const candidate = WagerTransaction.create({
      id: generateUuidV7(now),
      providerId,
      externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId,
      playerId,
      roundId,
      gameId,
      kind: kind as SubmittableKind,
      money,
      referenceExternalTransactionId,
      createdAt: now,
    });

    return {
      idempotencyKey,
      providerId,
      externalTransactionId,
      walletId,
      payloadHash,
      candidate,
      correlationId: input.correlationId,
      causationId: input.causationId,
      now,
    };
  }

  private async settleUnderWalletLock(
    parsed: ParsedWagerCommand,
    tx: TransactionalContext,
  ): Promise<ProcessWagerTransactionOutput> {
    const activeWaiters = this.inFlightWalletLocks.get(parsed.walletId) ?? 0;
    if (activeWaiters > 0) {
      this.metrics.recordLockConflict("hot_wallet_contention");
    }
    this.inFlightWalletLocks.set(parsed.walletId, activeWaiters + 1);

    try {
      const lockStart = performance.now();
      const wallet = await tx.wallets.findByIdForUpdate(parsed.walletId);
      this.metrics.recordProcessingDuration(
        "wallet_lock_acquire",
        performance.now() - lockStart,
      );

      if (!wallet) {
        throw new WalletNotFoundError(parsed.walletId);
      }

      // Re-check idempotency AFTER acquiring the wallet lock so concurrent duplicates
      // on the same wallet observe the committed winner and replay cleanly.
      const existingAfterLock = await this.checkExisting(
        parsed,
        tx.transactions,
        tx.wallets,
        wallet.balance,
      );
      if (existingAfterLock) return existingAfterLock;

      let reference: WagerTransaction | undefined;
      let referenceAlreadyReversed = false;

      if (parsed.candidate.referenceExternalTransactionId !== undefined) {
        reference =
          (await tx.transactions.findByProviderAndExternalId(
            parsed.providerId,
            parsed.candidate.referenceExternalTransactionId,
          )) ?? undefined;

        if (reference) {
          referenceAlreadyReversed = await tx.transactions.isReferenceAlreadyReversed(
            reference.id,
          );
        }
      }

      const { transaction, ledgerEntry } = settleWagerTransaction({
        wallet,
        transaction: parsed.candidate,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: generateUuidV7(parsed.now),
        now: parsed.now,
      });

      if (ledgerEntry) {
        await tx.wallets.update(wallet);
      }
      await tx.transactions.insert(transaction);
      if (ledgerEntry) {
        await tx.ledger.insert(ledgerEntry);
      }

      const outboxMessages = buildSettlementOutboxMessages({
        wallet,
        transaction,
        ledgerEntry,
        correlationId: parsed.correlationId,
        causationId: parsed.causationId,
        occurredAt: parsed.now,
        emitPendingReferenceEvent: true,
      });
      await tx.outbox.insertMany(outboxMessages);

      return this.formatOutput(transaction, wallet.balance, false);
    } finally {
      const remaining = (this.inFlightWalletLocks.get(parsed.walletId) ?? 1) - 1;
      if (remaining <= 0) {
        this.inFlightWalletLocks.delete(parsed.walletId);
      } else {
        this.inFlightWalletLocks.set(parsed.walletId, remaining);
      }
    }
  }

  private async checkExisting(
    parsed: ParsedWagerCommand,
    txRepo: WagerTransactionRepository,
    walletRepo: WalletRepository,
    fallbackBalance?: Money,
  ): Promise<ProcessWagerTransactionOutput | null> {
    const existingByKey = await txRepo.findByIdempotencyKey(parsed.idempotencyKey);
    if (existingByKey) {
      if (!existingByKey.matchesPayload(parsed.payloadHash)) {
        throw new IdempotencyConflictError(parsed.idempotencyKey);
      }
      if (fallbackBalance) {
        return this.formatOutput(existingByKey, fallbackBalance, true);
      }
      return this.resolveReplayOutput(existingByKey, walletRepo);
    }

    const existingByExternal = await txRepo.findByProviderAndExternalId(
      parsed.providerId,
      parsed.externalTransactionId,
    );
    if (existingByExternal) {
      if (existingByExternal.idempotencyKey === parsed.idempotencyKey) {
        if (!existingByExternal.matchesPayload(parsed.payloadHash)) {
          throw new IdempotencyConflictError(parsed.idempotencyKey);
        }
        if (fallbackBalance) {
          return this.formatOutput(existingByExternal, fallbackBalance, true);
        }
        return this.resolveReplayOutput(existingByExternal, walletRepo);
      }
      throw new DuplicateExternalTransactionError(
        parsed.providerId,
        parsed.externalTransactionId,
      );
    }

    return null;
  }

  private async resolveReplayOutput(
    existing: WagerTransaction,
    walletRepo: WalletRepository,
  ): Promise<ProcessWagerTransactionOutput> {
    if (existing.balanceAfter) {
      return this.formatOutput(existing, existing.balanceAfter, true);
    }
    const wallet = await walletRepo.findById(existing.walletId);
    const fallback = wallet?.balance ?? Money.zero(existing.money.currency);
    return this.formatOutput(existing, fallback, true);
  }

  private formatOutput(
    tx: WagerTransaction,
    fallbackBalance: Money,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionOutput {
    const observedBalance = tx.balanceAfter ?? fallbackBalance;
    const output: ProcessWagerTransactionOutput = {
      transactionId: tx.id,
      status: tx.status,
      balance: observedBalance.toJSON(),
      idempotentReplay,
    };
    if (tx.failureCode !== undefined) {
      output.failureCode = tx.failureCode;
    }
    return output;
  }
}
