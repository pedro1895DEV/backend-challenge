import { EntitySchema } from "typeorm";

export interface WalletLedgerEntryEntity {
  id: string;
  walletId: string;
  transactionId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const WalletLedgerEntryEntitySchema = new EntitySchema<WalletLedgerEntryEntity>({
  name: "WalletLedgerEntryEntity",
  tableName: "wallet_ledger_entries",
  columns: {
    id: {
      type: "varchar",
      length: 36,
      primary: true,
    },
    walletId: {
      type: "varchar",
      length: 36,
      name: "wallet_id",
    },
    transactionId: {
      type: "varchar",
      length: 36,
      name: "transaction_id",
    },
    direction: {
      type: "varchar",
      length: 10,
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
    balanceBefore: {
      type: "numeric",
      precision: 19,
      scale: 2,
      name: "balance_before",
    },
    balanceAfter: {
      type: "numeric",
      precision: 19,
      scale: 2,
      name: "balance_after",
    },
    createdAt: {
      type: "timestamptz",
      name: "created_at",
    },
  },
  uniques: [
    {
      name: "uq_ledger_wallet_transaction",
      columns: ["walletId", "transactionId"],
    },
  ],
});
