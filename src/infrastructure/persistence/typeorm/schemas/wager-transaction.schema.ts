import { EntitySchema } from "typeorm";

export interface WagerTransactionEntity {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status: string;
  failureCode?: string | null;
  balanceAfter?: string | null;
  balanceAfterCurrency?: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | null;
  createdAt: Date;
  processedAt?: Date | null;
}

export const WagerTransactionEntitySchema = new EntitySchema<WagerTransactionEntity>({
  name: "WagerTransactionEntity",
  tableName: "wager_transactions",
  columns: {
    id: {
      type: "varchar",
      length: 36,
      primary: true,
    },
    providerId: {
      type: "varchar",
      length: 64,
      name: "provider_id",
    },
    externalTransactionId: {
      type: "varchar",
      length: 128,
      name: "external_transaction_id",
    },
    idempotencyKey: {
      type: "varchar",
      length: 256,
      name: "idempotency_key",
    },
    payloadHash: {
      type: "varchar",
      length: 64,
      name: "payload_hash",
    },
    walletId: {
      type: "varchar",
      length: 36,
      name: "wallet_id",
    },
    playerId: {
      type: "varchar",
      length: 64,
      name: "player_id",
    },
    roundId: {
      type: "varchar",
      length: 128,
      name: "round_id",
    },
    gameId: {
      type: "varchar",
      length: 128,
      name: "game_id",
    },
    kind: {
      type: "varchar",
      length: 20,
    },
    amount: {
      type: "numeric",
      precision: 19,
      scale: 2,
    },
    currency: {
      type: "char",
      length: 3,
    },
    referenceExternalTransactionId: {
      type: "varchar",
      length: 128,
      nullable: true,
      name: "reference_external_transaction_id",
    },
    referenceTransactionId: {
      type: "varchar",
      length: 36,
      nullable: true,
      name: "reference_transaction_id",
    },
    status: {
      type: "varchar",
      length: 30,
    },
    failureCode: {
      type: "varchar",
      length: 64,
      nullable: true,
      name: "failure_code",
    },
    balanceAfter: {
      type: "numeric",
      precision: 19,
      scale: 2,
      nullable: true,
      name: "balance_after",
    },
    balanceAfterCurrency: {
      type: "char",
      length: 3,
      nullable: true,
      name: "balance_after_currency",
    },
    referenceAttempts: {
      type: "int",
      default: 0,
      name: "reference_attempts",
    },
    nextReferenceAttemptAt: {
      type: "timestamptz",
      nullable: true,
      name: "next_reference_attempt_at",
    },
    createdAt: {
      type: "timestamptz",
      name: "created_at",
    },
    processedAt: {
      type: "timestamptz",
      nullable: true,
      name: "processed_at",
    },
  },
  uniques: [
    {
      name: "uq_transactions_provider_ext_id",
      columns: ["providerId", "externalTransactionId"],
    },
    {
      name: "uq_transactions_idempotency_key",
      columns: ["idempotencyKey"],
    },
  ],
});
