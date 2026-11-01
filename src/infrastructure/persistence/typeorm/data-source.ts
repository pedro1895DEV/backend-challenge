import { DataSource, type DataSourceOptions } from "typeorm";
import type { DatabaseConfig } from "../../../config/app-config";
import { WalletEntitySchema } from "./schemas/wallet.schema";
import { WalletLedgerEntryEntitySchema } from "./schemas/wallet-ledger-entry.schema";
import { WagerTransactionEntitySchema } from "./schemas/wager-transaction.schema";
import { InboxMessageEntitySchema } from "./schemas/inbox-message.schema";
import { OutboxMessageEntitySchema } from "./schemas/outbox-message.schema";
import { InitialSchema1730380000000 } from "./migrations/1730380000000-InitialSchema";
import { AddBalanceAfterCurrency1730380001000 } from "./migrations/1730380001000-AddBalanceAfterCurrency";

export const ALL_SCHEMAS = [
  WalletEntitySchema,
  WalletLedgerEntryEntitySchema,
  WagerTransactionEntitySchema,
  InboxMessageEntitySchema,
  OutboxMessageEntitySchema,
];

export const ALL_MIGRATIONS = [
  InitialSchema1730380000000,
  AddBalanceAfterCurrency1730380001000,
];

export function createDataSourceOptions(config: DatabaseConfig): DataSourceOptions {
  return {
    type: "postgres",
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    database: config.name,
    entities: ALL_SCHEMAS,
    migrations: ALL_MIGRATIONS,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    extra: {
      max: 15,
      connectionTimeoutMillis: 5_000,
      lock_timeout: 5_000,
    },
  };
}

export function createDataSource(config: DatabaseConfig): DataSource {
  return new DataSource(createDataSourceOptions(config));
}
