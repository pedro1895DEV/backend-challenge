import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Initial database schema for the Distributed Wagering Processor.
 *
 * Implements strict constraints at the database level (README §5 item 9):
 *  - Non-negative wallet balance (CHECK)
 *  - Unique (player_id, currency) per wallet
 *  - Balanced ledger entries: balance_after = balance_before ± amount
 *  - Structural immutability on ledger: trigger preventing UPDATE/DELETE
 *  - Unique (provider_id, external_transaction_id) and idempotency_key
 *  - Partial unique index preventing duplicate reversals of the same reference
 *  - Primary key on inbox (consumer_name, message_id)
 *  - Index on outbox (published_at, next_attempt_at)
 *
 * Reversible: down() cleanly rolls back everything.
 */
export class InitialSchema1730380000000 implements MigrationInterface {
  name = "InitialSchema1730380000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Wallets table
    await queryRunner.query(`
      CREATE TABLE wallets (
        id VARCHAR(36) PRIMARY KEY,
        player_id VARCHAR(64) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance NUMERIC(19, 2) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      );
    `);

    // 2. Wallet Ledger Entries table (append-only ledger)
    await queryRunner.query(`
      CREATE TABLE wallet_ledger_entries (
        id VARCHAR(36) PRIMARY KEY,
        wallet_id VARCHAR(36) NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        transaction_id VARCHAR(36) NOT NULL,
        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_before NUMERIC(19, 2) NOT NULL,
        balance_after NUMERIC(19, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT chk_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
        ),
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_ledger_wallet_created ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
    `);

    // Append-only trigger for wallet_ledger_entries (disallows UPDATE and DELETE)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_ledger_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are strictly append-only and cannot be updated or deleted (id: %)', OLD.id;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();
    `);

    // 3. Wager Transactions table
    await queryRunner.query(`
      CREATE TABLE wager_transactions (
        id VARCHAR(36) PRIMARY KEY,
        provider_id VARCHAR(64) NOT NULL,
        external_transaction_id VARCHAR(128) NOT NULL,
        idempotency_key VARCHAR(256) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id VARCHAR(36) NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        player_id VARCHAR(64) NOT NULL,
        round_id VARCHAR(128) NOT NULL,
        game_id VARCHAR(128) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(128),
        reference_transaction_id VARCHAR(36) REFERENCES wager_transactions(id) ON DELETE SET NULL,
        status VARCHAR(30) NOT NULL,
        failure_code VARCHAR(64),
        balance_after NUMERIC(19, 2),
        reference_attempts INT NOT NULL DEFAULT 0,
        next_reference_attempt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        CONSTRAINT uq_transactions_provider_ext_id UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_transactions_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT chk_transactions_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT chk_transactions_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT chk_transactions_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT chk_transactions_reference_required CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        )
      );
    `);

    // Partial unique index: A transaction can be reverted by a PROCESSED REFUND/ROLLBACK at most once
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_transactions_processed_reversal
      ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX idx_transactions_pending_reference
      ON wager_transactions (next_reference_attempt_at)
      WHERE status = 'PENDING_REFERENCE';
    `);

    // 4. Inbox Messages table (SQS deduplication)
    await queryRunner.query(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(64) NOT NULL,
        message_id VARCHAR(128) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // 5. Outbox Messages table (Transactional outbox)
    await queryRunner.query(`
      CREATE TABLE outbox_messages (
        id VARCHAR(36) PRIMARY KEY,
        aggregate_id VARCHAR(36) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_outbox_pending
      ON outbox_messages (next_attempt_at)
      WHERE published_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_messages CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS inbox_messages CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wager_transactions CASCADE;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_ledger_modification();`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallets CASCADE;`);
  }
}
