import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `balance_after_currency` to `wager_transactions` so that rejected
 * transactions with `CURRENCY_MISMATCH` preserve the wallet's true currency
 * (`observedBalance.currency`) across idempotent replays and GET queries,
 * distinct from the submitted transaction's `currency`.
 */
export class AddBalanceAfterCurrency1730380001000 implements MigrationInterface {
  name = "AddBalanceAfterCurrency1730380001000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wager_transactions
      ADD COLUMN balance_after_currency CHAR(3) NULL;
    `);
    await queryRunner.query(`
      UPDATE wager_transactions
      SET balance_after_currency = currency
      WHERE balance_after IS NOT NULL AND balance_after_currency IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wager_transactions
      DROP COLUMN IF EXISTS balance_after_currency;
    `);
  }
}
