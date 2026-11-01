import type { WagerTransaction } from "../../domain/wagering/wager-transaction";

export const WAGER_TRANSACTION_REPOSITORY = Symbol("WAGER_TRANSACTION_REPOSITORY");

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
  save(transaction: WagerTransaction): Promise<void>;
  findDuePendingReferences(now: Date, limit?: number): Promise<WagerTransaction[]>;
  isReferenceAlreadyReversed(referenceTransactionId: string): Promise<boolean>;
}
