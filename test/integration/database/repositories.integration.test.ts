import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { DataSource } from "typeorm";
import { loadConfig } from "../../../src/config/app-config";
import { Money } from "../../../src/domain/money/money";
import { Wallet } from "../../../src/domain/wallet/wallet";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../../src/domain/wagering/wager-transaction";
import { createDataSource } from "../../../src/infrastructure/persistence/typeorm/data-source";
import { TypeOrmWalletLedgerRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-wallet-ledger.repository";
import { TypeOrmWalletRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-wallet.repository";
import { TypeOrmWagerTransactionRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-wager-transaction.repository";

describe("TypeORM Repositories (Integration)", () => {
  let dataSource: DataSource;
  let walletRepo: TypeOrmWalletRepository;
  let ledgerRepo: TypeOrmWalletLedgerRepository;
  let txRepo: TypeOrmWagerTransactionRepository;

  const now = new Date("2026-07-29T12:00:00.000Z");

  beforeAll(async () => {
    const config = loadConfig(process.env);
    dataSource = createDataSource(config.database);
    await dataSource.initialize();
    await dataSource.runMigrations();

    walletRepo = new TypeOrmWalletRepository(dataSource);
    ledgerRepo = new TypeOrmWalletLedgerRepository(dataSource);
    txRepo = new TypeOrmWagerTransactionRepository(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe("WalletRepository", () => {
    it("saves and rehydrates a wallet with exact Money representation", async () => {
      const openResult = Wallet.open({
        id: "w-repo-1",
        playerId: "p-repo-1",
        initialBalance: Money.from({ amount: "250.75", currency: "BRL" }),
        at: now,
        opening: { transactionId: "tx-open-1", ledgerEntryId: "e-open-1" },
      });

      await walletRepo.save(openResult.wallet);
      if (openResult.openingEntry) {
        await ledgerRepo.save(openResult.openingEntry);
      }

      const found = await walletRepo.findById("w-repo-1");
      expect(found).not.toBeNull();
      expect(found!.id).toBe("w-repo-1");
      expect(found!.playerId).toBe("p-repo-1");
      expect(found!.currency).toBe("BRL");
      expect(found!.balance.amount).toBe("250.75");
      expect(found!.balance.currency).toBe("BRL");
      expect(found!.version).toBe(1);

      const byPlayer = await walletRepo.findByPlayerAndCurrency("p-repo-1", "BRL");
      expect(byPlayer?.id).toBe("w-repo-1");
    });
  });

  describe("WalletLedgerRepository", () => {
    it("paginates ledger entries with stable opaque cursor and calculates balance", async () => {
      const walletId = "w-ledger-page";
      const openResult = Wallet.open({
        id: walletId,
        playerId: "p-ledger-page",
        initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
        at: new Date("2026-07-29T10:00:00.000Z"),
        opening: { transactionId: "tx-o", ledgerEntryId: "e-o" },
      });
      await walletRepo.save(openResult.wallet);
      await ledgerRepo.save(openResult.openingEntry!);

      // Add 3 debit entries
      const wallet = openResult.wallet;
      for (let i = 1; i <= 3; i++) {
        const entry = wallet.debit({
          money: Money.from({ amount: "10.00", currency: "BRL" }),
          transactionId: `tx-d-${i}`,
          ledgerEntryId: `e-d-${i}`,
          at: new Date(`2026-07-29T10:0${i}:00.000Z`),
        });
        await walletRepo.save(wallet);
        await ledgerRepo.save(entry);
      }

      // Query page 1 (limit 2)
      const page1 = await ledgerRepo.findByWalletId(walletId, { limit: 2 });
      expect(page1.entries).toHaveLength(2);
      expect(page1.totalCount).toBe(4);
      expect(page1.nextCursor).toBeDefined();

      // Query page 2 with cursor
      const page2 = await ledgerRepo.findByWalletId(walletId, {
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.entries).toHaveLength(2);

      // Reconciled balance should be 100 - 30 = 70.00 BRL
      const calculated = await ledgerRepo.calculateBalance(walletId, "BRL");
      expect(calculated.balance.amount).toBe("70.00");
      expect(calculated.count).toBe(4);
      expect(calculated.balance.equals(wallet.balance)).toBe(true);
    });
  });

  describe("WagerTransactionRepository", () => {
    it("saves and finds transaction by idempotency key and external id", async () => {
      const tx = WagerTransaction.create({
        id: "tx-wager-repo-1",
        providerId: "prov-repo",
        externalTransactionId: "ext-tx-100",
        idempotencyKey: "prov-repo:ext-tx-100",
        payloadHash: "abc123hash",
        walletId: "w-repo-1",
        playerId: "p-repo-1",
        roundId: "r-100",
        gameId: "slots",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "15.50", currency: "BRL" }),
        createdAt: now,
      });

      await txRepo.save(tx);

      const byId = await txRepo.findById(tx.id);
      expect(byId).not.toBeNull();
      expect(byId!.externalTransactionId).toBe("ext-tx-100");
      expect(byId!.money.amount).toBe("15.50");

      const byKey = await txRepo.findByIdempotencyKey("prov-repo:ext-tx-100");
      expect(byKey?.id).toBe(tx.id);

      const byProviderExt = await txRepo.findByProviderAndExternalId("prov-repo", "ext-tx-100");
      expect(byProviderExt?.id).toBe(tx.id);
    });

    it("finds due pending reference transactions and reversal checks", async () => {
      const refundTx = WagerTransaction.create({
        id: "tx-refund-pending",
        providerId: "prov-repo",
        externalTransactionId: "ext-refund-999",
        idempotencyKey: "prov-repo:ext-refund-999",
        payloadHash: "hash-ref-999",
        walletId: "w-repo-1",
        playerId: "p-repo-1",
        roundId: "r-100",
        gameId: "slots",
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        referenceExternalTransactionId: "ext-tx-100",
        createdAt: now,
      });

      refundTx.markPendingReference(now);
      await txRepo.save(refundTx);

      // 2 seconds later, it should be due for retry
      const due = await txRepo.findDuePendingReferences(new Date(now.getTime() + 5000));
      expect(due.some((t) => t.id === "tx-refund-pending")).toBe(true);

      // Check reversal status
      const isReversedBefore = await txRepo.isReferenceAlreadyReversed("tx-wager-repo-1");
      expect(isReversedBefore).toBe(false);

      // Mark refund as PROCESSED targeting tx-wager-repo-1
      refundTx.markProcessed({
        referenceTransactionId: "tx-wager-repo-1",
        balanceAfter: Money.from({ amount: "250.75", currency: "BRL" }),
        at: now,
      });
      await txRepo.save(refundTx);

      const isReversedAfter = await txRepo.isReferenceAlreadyReversed("tx-wager-repo-1");
      expect(isReversedAfter).toBe(true);
    });
  });
});
