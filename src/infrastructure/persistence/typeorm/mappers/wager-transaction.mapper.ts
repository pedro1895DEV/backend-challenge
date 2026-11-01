import { Money } from "../../../../domain/money/money";
import type { FailureCode } from "../../../../domain/wagering/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../../../domain/wagering/wager-transaction";
import type { WagerTransactionEntity } from "../schemas/wager-transaction.schema";

export class WagerTransactionMapper {
  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const currency = entity.currency.trim();
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      money: Money.from({ amount: entity.amount, currency }),
      referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
      createdAt: entity.createdAt,
      status: entity.status as WagerTransactionStatus,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode: (entity.failureCode as FailureCode) ?? undefined,
      processedAt: entity.processedAt ?? undefined,
      balanceAfter: entity.balanceAfter
        ? Money.fromSigned({
            amount: entity.balanceAfter,
            currency: entity.balanceAfterCurrency?.trim() || currency,
          })
        : undefined,
      referenceAttempts: entity.referenceAttempts,
      nextReferenceAttemptAt: entity.nextReferenceAttemptAt ?? undefined,
    });
  }

  static toEntity(tx: WagerTransaction): WagerTransactionEntity {
    const state = tx.toState();
    return {
      id: state.id,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      idempotencyKey: state.idempotencyKey,
      payloadHash: state.payloadHash,
      walletId: state.walletId,
      playerId: state.playerId,
      roundId: state.roundId,
      gameId: state.gameId,
      kind: state.kind,
      amount: state.money.amount,
      currency: state.money.currency,
      referenceExternalTransactionId: state.referenceExternalTransactionId ?? null,
      referenceTransactionId: state.referenceTransactionId ?? null,
      status: state.status,
      failureCode: state.failureCode ?? null,
      balanceAfter: state.balanceAfter ? state.balanceAfter.amount : null,
      balanceAfterCurrency: state.balanceAfter ? state.balanceAfter.currency : null,
      referenceAttempts: state.referenceAttempts,
      nextReferenceAttemptAt: state.nextReferenceAttemptAt ?? null,
      createdAt: state.createdAt,
      processedAt: state.processedAt ?? null,
    };
  }
}
