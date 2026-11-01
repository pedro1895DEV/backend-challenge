import type { MoneyProps } from "../../domain/money/money";
import type { FailureCode } from "../../domain/wagering/failure-code";
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import { WagerTransactionNotFoundError } from "../errors/application-errors";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import { requireNonEmptyString } from "../shared/validation";

export interface WagerTransactionDetailsOutput {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  balance: MoneyProps | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  createdAt: string;
  processedAt: string | null;
}

export class GetWagerTransactionUseCase {
  constructor(private readonly txRepo: WagerTransactionRepository) {}

  async getById(rawTransactionId: unknown): Promise<WagerTransactionDetailsOutput> {
    const transactionId = requireNonEmptyString(rawTransactionId, "transactionId", 64);
    const tx = await this.txRepo.findById(transactionId);
    if (!tx) {
      throw new WagerTransactionNotFoundError(transactionId);
    }
    return this.toOutput(tx);
  }

  async getByProviderAndExternalId(
    rawProviderId: unknown,
    rawExternalTransactionId: unknown,
  ): Promise<WagerTransactionDetailsOutput> {
    const providerId = requireNonEmptyString(rawProviderId, "providerId", 64);
    const externalTransactionId = requireNonEmptyString(
      rawExternalTransactionId,
      "externalTransactionId",
      128,
    );
    const tx = await this.txRepo.findByProviderAndExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new WagerTransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    }
    return this.toOutput(tx);
  }

  private toOutput(tx: WagerTransaction): WagerTransactionDetailsOutput {
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: tx.status,
      money: tx.money.toJSON(),
      balance: tx.balanceAfter ? tx.balanceAfter.toJSON() : null,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt ? tx.processedAt.toISOString() : null,
    };
  }
}
