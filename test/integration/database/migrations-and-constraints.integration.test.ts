import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { DataSource } from "typeorm";
import { loadConfig } from "../../../src/config/app-config";
import { ALL_MIGRATIONS, createDataSource } from "../../../src/infrastructure/persistence/typeorm/data-source";

describe("Database Migrations & Schema Constraints (Integration)", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const config = loadConfig(process.env);
    dataSource = createDataSource(config.database);
    await dataSource.initialize();
    // Run all migrations up to ensure clean baseline
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe("wallets constraints", () => {
    it("enforces non-negative balance (chk_wallets_balance_non_negative)", async () => {
      await expect(
        dataSource.query(`
          INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
          VALUES ('w-neg', 'p-1', 'BRL', -10.00, 1, NOW(), NOW());
        `),
      ).rejects.toThrow(/chk_wallets_balance_non_negative/);
    });

    it("enforces unique (player_id, currency)", async () => {
      await dataSource.query(`
        INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
        VALUES ('w-uniq-1', 'player-uniq', 'BRL', 100.00, 1, NOW(), NOW());
      `);

      await expect(
        dataSource.query(`
          INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
          VALUES ('w-uniq-2', 'player-uniq', 'BRL', 50.00, 1, NOW(), NOW());
        `),
      ).rejects.toThrow(/uq_wallets_player_currency/);
    });

    it("enforces version >= 1", async () => {
      await expect(
        dataSource.query(`
          INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
          VALUES ('w-ver-0', 'p-ver', 'BRL', 100.00, 0, NOW(), NOW());
        `),
      ).rejects.toThrow(/chk_wallets_version_positive/);
    });
  });

  describe("wallet_ledger_entries constraints & append-only trigger", () => {
    const walletId = "w-ledger-test";

    beforeAll(async () => {
      await dataSource.query(`
        INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
        VALUES ('${walletId}', 'p-ledger', 'BRL', 100.00, 1, NOW(), NOW());
      `);
    });

    it("accepts balanced CREDIT and DEBIT entries", async () => {
      // CREDIT: 0.00 + 100.00 = 100.00
      await dataSource.query(`
        INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
        VALUES ('e-1', '${walletId}', 'tx-1', 'CREDIT', 100.00, 'BRL', 0.00, 100.00, NOW());
      `);

      // DEBIT: 100.00 - 30.00 = 70.00
      await dataSource.query(`
        INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
        VALUES ('e-2', '${walletId}', 'tx-2', 'DEBIT', 30.00, 'BRL', 100.00, 70.00, NOW());
      `);
    });

    it("rejects mathematically unbalanced ledger entries (chk_ledger_balanced)", async () => {
      await expect(
        dataSource.query(`
          INSERT INTO wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
          VALUES ('e-unbalanced', '${walletId}', 'tx-unb', 'CREDIT', 100.00, 'BRL', 0.00, 90.00, NOW());
        `),
      ).rejects.toThrow(/chk_ledger_balanced/);
    });

    it("enforces at most one entry per (wallet_id, transaction_id)", async () => {
      await expect(
        dataSource.query(`
          INSERT INTO wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
          VALUES ('e-dup', '${walletId}', 'tx-1', 'CREDIT', 10.00, 'BRL', 100.00, 110.00, NOW());
        `),
      ).rejects.toThrow(/uq_ledger_wallet_transaction/);
    });

    it("BLOCKS UPDATE on wallet_ledger_entries via trigger (append-only immutability)", async () => {
      await expect(
        dataSource.query(`
          UPDATE wallet_ledger_entries SET amount = 999.00 WHERE id = 'e-1';
        `),
      ).rejects.toThrow(/Ledger entries are strictly append-only/);
    });

    it("BLOCKS DELETE on wallet_ledger_entries via trigger", async () => {
      await expect(
        dataSource.query(`
          DELETE FROM wallet_ledger_entries WHERE id = 'e-1';
        `),
      ).rejects.toThrow(/Ledger entries are strictly append-only/);
    });
  });

  describe("wager_transactions constraints", () => {
    it("enforces unique (provider_id, external_transaction_id)", async () => {
      await dataSource.query(`
        INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
        VALUES ('t-1', 'prov-a', 'ext-1', 'k-1', 'hash-1', 'w-ledger-test', 'p-1', 'r-1', 'g-1', 'BET', 10.00, 'BRL', 'PROCESSED', NOW());
      `);

      await expect(
        dataSource.query(`
          INSERT INTO wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
          VALUES ('t-2', 'prov-a', 'ext-1', 'k-2', 'hash-2', 'w-ledger-test', 'p-1', 'r-1', 'g-1', 'BET', 10.00, 'BRL', 'PROCESSED', NOW());
        `),
      ).rejects.toThrow(/uq_transactions_provider_ext_id/);
    });

    it("enforces reference_external_transaction_id for REFUND and ROLLBACK", async () => {
      await expect(
        dataSource.query(`
          INSERT INTO wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
          VALUES ('t-ref-missing', 'prov-a', 'ext-refund-1', 'k-ref-1', 'hash-ref', 'w-ledger-test', 'p-1', 'r-1', 'g-1', 'REFUND', 10.00, 'BRL', 'PENDING', NOW());
        `),
      ).rejects.toThrow(/chk_transactions_reference_required/);
    });

    it("enforces partial unique index: cannot revert the same reference twice", async () => {
      // First reversal of 't-1' processed
      await dataSource.query(`
        INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, created_at)
        VALUES ('t-rev-1', 'prov-a', 'ext-rev-1', 'k-rev-1', 'hash-r1', 'w-ledger-test', 'p-1', 'r-1', 'g-1', 'REFUND', 10.00, 'BRL', 'ext-1', 't-1', 'PROCESSED', NOW());
      `);

      // Attempt second processed reversal of same reference 't-1'
      await expect(
        dataSource.query(`
          INSERT INTO wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, created_at)
          VALUES ('t-rev-2', 'prov-a', 'ext-rev-2', 'k-rev-2', 'hash-r2', 'w-ledger-test', 'p-1', 'r-1', 'g-1', 'REFUND', 10.00, 'BRL', 'ext-1', 't-1', 'PROCESSED', NOW());
        `),
      ).rejects.toThrow(/uq_transactions_processed_reversal/);
    });
  });

  describe("migration reversibility", () => {
    it("can roll back all migrations cleanly via down() and re-run up()", async () => {
      for (let i = 0; i < ALL_MIGRATIONS.length; i++) {
        await dataSource.undoLastMigration();
      }

      // Verify tables no longer exist
      const checkTables = await dataSource.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('wallets', 'wallet_ledger_entries', 'wager_transactions');
      `);
      expect(checkTables).toHaveLength(0);

      // Re-run up()
      await dataSource.runMigrations();

      const restoredTables = await dataSource.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('wallets', 'wallet_ledger_entries', 'wager_transactions');
      `);
      expect(restoredTables.length).toBeGreaterThanOrEqual(3);
    });
  });
});
