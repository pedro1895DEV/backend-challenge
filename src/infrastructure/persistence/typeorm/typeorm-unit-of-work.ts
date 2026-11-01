import type { DataSource, EntityManager } from "typeorm";
import {
  TransientInfrastructureError,
  UniqueConstraintError,
} from "../../../application/errors/application-errors";
import {
  NOOP_METRICS_PORT,
  type MetricsPort,
} from "../../../application/ports/metrics.port";
import type {
  TransactionalContext,
  UnitOfWork,
} from "../../../application/ports/unit-of-work.port";
import {
  getUniqueConstraintName,
  isDatabaseLockConflictError,
  isTransientDatabaseError,
} from "./postgres-error";
import { TypeOrmInboxRepository } from "./repositories/typeorm-inbox.repository";
import { TypeOrmOutboxRepository } from "./repositories/typeorm-outbox.repository";
import { TypeOrmWagerTransactionRepository } from "./repositories/typeorm-wager-transaction.repository";
import { TypeOrmWalletLedgerRepository } from "./repositories/typeorm-wallet-ledger.repository";
import { TypeOrmWalletRepository } from "./repositories/typeorm-wallet.repository";

export class TypeOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsPort = NOOP_METRICS_PORT,
  ) {}

  async runInTransaction<T>(work: (tx: TransactionalContext) => Promise<T>): Promise<T> {
    try {
      return await this.dataSource.transaction("READ COMMITTED", async (em) =>
        work(this.createContext(em)),
      );
    } catch (error) {
      const constraint = getUniqueConstraintName(error);
      if (constraint !== undefined) {
        this.metrics.recordLockConflict("unique_constraint_race");
        throw new UniqueConstraintError(constraint || undefined, error);
      }
      if (isDatabaseLockConflictError(error)) {
        this.metrics.recordLockConflict("lock_timeout_or_deadlock");
      }
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError(
          "Temporary database unavailability or lock timeout",
          1,
          error,
        );
      }
      throw error;
    }
  }

  async runReadOnlySnapshot<T>(work: (tx: TransactionalContext) => Promise<T>): Promise<T> {
    try {
      return await this.dataSource.transaction("REPEATABLE READ", async (em) => {
        await em.query("SET TRANSACTION READ ONLY");
        return work(this.createContext(em));
      });
    } catch (error) {
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError(
          "Temporary database unavailability",
          1,
          error,
        );
      }
      throw error;
    }
  }

  private createContext(em: EntityManager): TransactionalContext {
    return {
      wallets: new TypeOrmWalletRepository(em),
      ledger: new TypeOrmWalletLedgerRepository(em),
      transactions: new TypeOrmWagerTransactionRepository(em),
      inbox: new TypeOrmInboxRepository(em),
      outbox: new TypeOrmOutboxRepository(em),
    };
  }
}
