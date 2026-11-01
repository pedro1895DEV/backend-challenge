import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/app-config";
import { INBOX_REPOSITORY } from "../../application/ports/inbox.repository";
import { METRICS_PORT, type MetricsPort } from "../../application/ports/metrics.port";
import { OUTBOX_REPOSITORY } from "../../application/ports/outbox.repository";
import { UNIT_OF_WORK } from "../../application/ports/unit-of-work.port";
import { WALLET_REPOSITORY } from "../../application/ports/wallet.repository";
import { WALLET_LEDGER_REPOSITORY } from "../../application/ports/wallet-ledger.repository";
import { WAGER_TRANSACTION_REPOSITORY } from "../../application/ports/wager-transaction.repository";
import { createDataSource } from "./typeorm/data-source";
import { TypeOrmUnitOfWork } from "./typeorm/typeorm-unit-of-work";
import { TypeOrmInboxRepository } from "./typeorm/repositories/typeorm-inbox.repository";
import { TypeOrmOutboxRepository } from "./typeorm/repositories/typeorm-outbox.repository";
import { TypeOrmWalletRepository } from "./typeorm/repositories/typeorm-wallet.repository";
import { TypeOrmWalletLedgerRepository } from "./typeorm/repositories/typeorm-wallet-ledger.repository";
import { TypeOrmWagerTransactionRepository } from "./typeorm/repositories/typeorm-wager-transaction.repository";

export const DATA_SOURCE = Symbol("DATA_SOURCE");

@Global()
@Module({
  providers: [
    {
      provide: DATA_SOURCE,
      useFactory: async (config: AppConfig): Promise<DataSource> => {
        const ds = createDataSource(config.database);
        await ds.initialize();
        // Serialize boot-time migrations across >= 3 simultaneous replicas
        // using a session-level PostgreSQL advisory lock.
        const lockRunner = ds.createQueryRunner();
        await lockRunner.connect();
        try {
          await lockRunner.query("SELECT pg_advisory_lock(74839201)");
          try {
            await ds.runMigrations();
          } finally {
            await lockRunner.query("SELECT pg_advisory_unlock(74839201)");
          }
        } finally {
          await lockRunner.release();
        }
        return ds;
      },
      inject: [APP_CONFIG],
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (ds: DataSource, metrics: MetricsPort) => new TypeOrmUnitOfWork(ds, metrics),
      inject: [DATA_SOURCE, METRICS_PORT],
    },
    {
      provide: WALLET_REPOSITORY,
      useFactory: (ds: DataSource) => new TypeOrmWalletRepository(ds),
      inject: [DATA_SOURCE],
    },
    {
      provide: WALLET_LEDGER_REPOSITORY,
      useFactory: (ds: DataSource) => new TypeOrmWalletLedgerRepository(ds),
      inject: [DATA_SOURCE],
    },
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      useFactory: (ds: DataSource) => new TypeOrmWagerTransactionRepository(ds),
      inject: [DATA_SOURCE],
    },
    {
      provide: INBOX_REPOSITORY,
      useFactory: (ds: DataSource) => new TypeOrmInboxRepository(ds),
      inject: [DATA_SOURCE],
    },
    {
      provide: OUTBOX_REPOSITORY,
      useFactory: (ds: DataSource) => new TypeOrmOutboxRepository(ds),
      inject: [DATA_SOURCE],
    },
  ],
  exports: [
    DATA_SOURCE,
    UNIT_OF_WORK,
    WALLET_REPOSITORY,
    WALLET_LEDGER_REPOSITORY,
    WAGER_TRANSACTION_REPOSITORY,
    INBOX_REPOSITORY,
    OUTBOX_REPOSITORY,
  ],
})
export class DatabaseModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      await this.dataSource.initialize();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}
