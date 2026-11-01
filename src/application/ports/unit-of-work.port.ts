import type { InboxRepository } from "./inbox.repository";
import type { OutboxRepository } from "./outbox.repository";
import type { WagerTransactionRepository } from "./wager-transaction.repository";
import type { WalletLedgerRepository } from "./wallet-ledger.repository";
import type { TransactionalWalletRepository } from "./wallet.repository";

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

export interface TransactionalContext {
  readonly wallets: TransactionalWalletRepository;
  readonly ledger: WalletLedgerRepository;
  readonly transactions: WagerTransactionRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWork {
  /**
   * Runs `work` inside a single `READ COMMITTED` SQL transaction.
   * Commits on resolve, rolls back on throw.
   */
  runInTransaction<T>(work: (tx: TransactionalContext) => Promise<T>): Promise<T>;

  /**
   * Runs `work` inside a `REPEATABLE READ` read-only snapshot so multiple
   * queries (e.g. wallet stored balance + ledger sum) observe the exact same
   * point-in-time state without blocking concurrent writers.
   */
  runReadOnlySnapshot<T>(work: (tx: TransactionalContext) => Promise<T>): Promise<T>;
}
