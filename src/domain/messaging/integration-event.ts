import type { Money, MoneyProps } from "../money/money";
import { InvalidOutboxMessageError } from "../shared/errors";
import { generateUuidV7 } from "../shared/uuid-v7";
import type { FailureCode } from "../wagering/failure-code";
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from "../wagering/wager-transaction";
import type { Wallet } from "../wallet/wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../wallet/wallet-ledger-entry";

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface EventContext {
  eventId?: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Abstract base class for every integration event persisted in the
 * Transactional Outbox (README §11).
 *
 * `eventType` and `version` live on concrete subclasses (never as ad-hoc strings
 * at call sites), and `data` carries `MoneyProps` decimal strings — never raw
 * `Money` instances or JS `number`s.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    if (!props.eventId?.trim()) {
      throw new InvalidOutboxMessageError("IntegrationEvent eventId is required");
    }
    if (!props.aggregateId?.trim()) {
      throw new InvalidOutboxMessageError("IntegrationEvent aggregateId is required");
    }
    if (!props.correlationId?.trim()) {
      throw new InvalidOutboxMessageError("IntegrationEvent correlationId is required");
    }
    this.eventId = props.eventId.trim();
    this.aggregateId = props.aggregateId.trim();
    this.correlationId = props.correlationId.trim();
    this.causationId = props.causationId?.trim() || undefined;
    this.occurredAt = new Date(props.occurredAt);
    this.data = Object.freeze({ ...props.data });
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: { ...this.data },
    };
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId ?? generateUuidV7(ctx.occurredAt),
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? entry.transactionId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  observedBalance: MoneyProps;
  referenceTransactionId: string | null;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    observedBalance: Money,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed) {
      throw new InvalidOutboxMessageError(
        `WagerTransactionProcessed requires PROCESSED status, got ${tx.status}`,
      );
    }
    const balance = tx.balanceAfter ?? observedBalance;
    return new WagerTransactionProcessed({
      eventId: ctx.eventId ?? generateUuidV7(ctx.occurredAt),
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? tx.id,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        observedBalance: balance.toJSON(),
        referenceTransactionId: tx.referenceTransactionId ?? null,
      },
    });
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  observedBalance: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    observedBalance: Money,
    ctx: EventContext,
  ): WagerTransactionRejected {
    if (tx.status !== WagerTransactionStatus.Rejected || !tx.failureCode) {
      throw new InvalidOutboxMessageError(
        `WagerTransactionRejected requires REJECTED status with failureCode, got ${tx.status}`,
      );
    }
    const balance = tx.balanceAfter ?? observedBalance;
    return new WagerTransactionRejected({
      eventId: ctx.eventId ?? generateUuidV7(ctx.occurredAt),
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? tx.id,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        observedBalance: balance.toJSON(),
        failureCode: tx.failureCode,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  observedBalance: MoneyProps;
  referenceExternalTransactionId: string;
  nextReferenceAttemptAt: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    observedBalance: Money,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (
      tx.status !== WagerTransactionStatus.PendingReference ||
      !tx.referenceExternalTransactionId
    ) {
      throw new InvalidOutboxMessageError(
        `WagerTransactionPendingReference requires PENDING_REFERENCE status, got ${tx.status}`,
      );
    }
    const balance = tx.balanceAfter ?? observedBalance;
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId ?? generateUuidV7(ctx.occurredAt),
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? tx.id,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        observedBalance: balance.toJSON(),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextReferenceAttemptAt: tx.nextReferenceAttemptAt
          ? tx.nextReferenceAttemptAt.toISOString()
          : null,
      },
    });
  }
}
