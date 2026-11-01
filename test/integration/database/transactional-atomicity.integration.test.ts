import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { DataSource } from "typeorm";
import { OpenWalletUseCase } from "../../../src/application/use-cases/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../../src/application/use-cases/reconcile-wallet.use-case";
import { loadConfig } from "../../../src/config/app-config";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { generateUuidV7 } from "../../../src/domain/shared/uuid-v7";
import { computeWagerPayloadHash } from "../../../src/domain/wagering/payload-hash";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction";
import { createDataSource } from "../../../src/infrastructure/persistence/typeorm/data-source";
import { TypeOrmInboxRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-inbox.repository";
import { TypeOrmOutboxRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-outbox.repository";
import { TypeOrmWagerTransactionRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-wager-transaction.repository";
import { TypeOrmWalletLedgerRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-wallet-ledger.repository";
import { TypeOrmWalletRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-wallet.repository";
import { TypeOrmUnitOfWork } from "../../../src/infrastructure/persistence/typeorm/typeorm-unit-of-work";

describe("Transactional Atomicity — Wallet, Ledger, Inbox & Outbox (Integration)", () => {
  let dataSource: DataSource;
  let uow: TypeOrmUnitOfWork;
  let walletRepo: TypeOrmWalletRepository;
  let ledgerRepo: TypeOrmWalletLedgerRepository;
  let txRepo: TypeOrmWagerTransactionRepository;
  let inboxRepo: TypeOrmInboxRepository;
  let outboxRepo: TypeOrmOutboxRepository;
  let openWallet: OpenWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;
  let reconcileWallet: ReconcileWalletUseCase;

  beforeAll(async () => {
    process.env.DB_HOST ??= "localhost";
    process.env.DB_PORT ??= "5432";
    process.env.DB_USER ??= "wagering";
    process.env.DB_PASSWORD ??= "wagering";
    process.env.DB_NAME ??= "wagering";

    const config = loadConfig(process.env);
    dataSource = createDataSource(config.database);
    await dataSource.initialize();
    await dataSource.runMigrations();

    uow = new TypeOrmUnitOfWork(dataSource);
    walletRepo = new TypeOrmWalletRepository(dataSource);
    ledgerRepo = new TypeOrmWalletLedgerRepository(dataSource);
    txRepo = new TypeOrmWagerTransactionRepository(dataSource);
    inboxRepo = new TypeOrmInboxRepository(dataSource);
    outboxRepo = new TypeOrmOutboxRepository(dataSource);

    openWallet = new OpenWalletUseCase(uow);
    processWager = new ProcessWagerTransactionUseCase(uow, walletRepo, txRepo);
    reconcileWallet = new ReconcileWalletUseCase(uow, {
      onDivergenceDetected: () => {},
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("commits wallet, ledger, wager_transaction, inbox, and outbox atomically in a single SQL transaction", async () => {
    const playerId = `player-atom-${generateUuidV7()}`;
    const providerId = `prov-atom-${generateUuidV7().slice(0, 8)}`;

    const opened = await openWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
      correlationId: "corr-open-atom",
    });

    const messageId = `sqs-msg-${generateUuidV7()}`;
    const consumerName = "sqs-wager-consumer";
    const externalTransactionId = `ext-${generateUuidV7()}`;
    const idempotencyKey = `${providerId}:${externalTransactionId}`;

    const payloadHash = computeWagerPayloadHash({
      providerId,
      externalTransactionId,
      playerId,
      walletId: opened.id,
      roundId: "round-atom-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "35.00", currency: "BRL" },
    });

    const output = await uow.runInTransaction(async (tx) => {
      const inbox = InboxMessage.receive({
        consumerName,
        messageId,
        payloadHash,
        receivedAt: new Date(),
      });
      await tx.inbox.insert(inbox);

      const settled = await processWager.executeInTransaction(
        {
          idempotencyKey,
          providerId,
          externalTransactionId,
          playerId,
          walletId: opened.id,
          roundId: "round-atom-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "35.00", currency: "BRL" },
          correlationId: "corr-bet-atom",
          causationId: messageId,
        },
        tx,
      );

      inbox.markProcessed(new Date());
      await tx.inbox.update(inbox);
      return settled;
    });

    expect(output.status).toBe(WagerTransactionStatus.Processed);
    expect(output.balance).toEqual({ amount: "65.00", currency: "BRL" });

    // Verify all 5 tables reflect the committed state
    const storedInbox = await inboxRepo.findByConsumerAndMessageId(consumerName, messageId);
    expect(storedInbox).not.toBeNull();
    expect(storedInbox?.isProcessed()).toBe(true);

    const outboxEvents = await outboxRepo.findByAggregateId(opened.id);
    // 2 from OPENING (WalletBalanceChanged + WagerTransactionProcessed) + 2 from BET
    expect(outboxEvents).toHaveLength(4);
    expect(outboxEvents.map((e) => e.eventType)).toEqual([
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
    ]);

    const recon = await reconcileWallet.execute({ walletId: opened.id });
    expect(recon.consistent).toBe(true);
    expect(recon.calculatedBalance).toEqual({ amount: "65.00", currency: "BRL" });
    expect(recon.checkedEntries).toBe(2);
  });

  it("rolls back wallet, ledger, wager_transaction, inbox, and outbox together if any step throws before commit", async () => {
    const playerId = `player-rb-${generateUuidV7()}`;
    const providerId = `prov-rb-${generateUuidV7().slice(0, 8)}`;

    const opened = await openWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const messageId = `sqs-crash-${generateUuidV7()}`;
    const consumerName = "sqs-wager-consumer";
    const externalTransactionId = `ext-crash-${generateUuidV7()}`;
    const idempotencyKey = `${providerId}:${externalTransactionId}`;

    await expect(
      uow.runInTransaction(async (tx) => {
        const inbox = InboxMessage.receive({
          consumerName,
          messageId,
          payloadHash: "sha256-crash",
          receivedAt: new Date(),
        });
        await tx.inbox.insert(inbox);

        await processWager.executeInTransaction(
          {
            idempotencyKey,
            providerId,
            externalTransactionId,
            playerId,
            walletId: opened.id,
            roundId: "round-crash",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "40.00", currency: "BRL" },
          },
          tx,
        );

        // Simulated crash AFTER wallet update, ledger insert, inbox insert, and outbox insert!
        throw new Error("Simulated crash right before SQL COMMIT");
      }),
    ).rejects.toThrow("Simulated crash right before SQL COMMIT");

    // Verify 100% rollback across every table
    const walletAfter = await walletRepo.findById(opened.id);
    expect(walletAfter?.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(walletAfter?.version).toBe(1);

    const ledgerPage = await ledgerRepo.findByWalletId(opened.id, { limit: 10 });
    expect(ledgerPage.entries).toHaveLength(1); // Only the initial OPENING entry

    const crashedTx = await txRepo.findByIdempotencyKey(idempotencyKey);
    expect(crashedTx).toBeNull();

    const crashedInbox = await inboxRepo.findByConsumerAndMessageId(consumerName, messageId);
    expect(crashedInbox).toBeNull();

    const outboxAfter = await outboxRepo.findByAggregateId(opened.id);
    expect(outboxAfter).toHaveLength(2); // Only the 2 initial OPENING events!

    const recon = await reconcileWallet.execute({ walletId: opened.id });
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance).toEqual({ amount: "100.00", currency: "BRL" });
  });

  it("distributes due outbox messages across concurrent publishers via FOR UPDATE SKIP LOCKED without overlap", async () => {
    const playerId = `player-skip-${generateUuidV7()}`;
    const opened = await openWallet.execute({
      playerId,
      initialBalance: { amount: "200.00", currency: "BRL" },
    });

    // Generate 4 more outbox messages (2 BETs => 4 events; total 6 unpublished events for this wallet)
    const providerId = `prov-skip-${generateUuidV7().slice(0, 8)}`;
    for (let i = 1; i <= 2; i++) {
      await processWager.execute({
        idempotencyKey: `${providerId}:skip-${i}`,
        providerId,
        externalTransactionId: `skip-${i}`,
        playerId,
        walletId: opened.id,
        roundId: `round-skip-${i}`,
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      });
    }

    // Use a barrier so Worker A holds its SKIP LOCKED rows while Worker B executes claimDueBatch!
    let releaseWorkerA!: () => void;
    const workerAHoldingLocks = new Promise<void>((resolve) => {
      releaseWorkerA = resolve;
    });
    let signalWorkerALocked!: () => void;
    const workerALocked = new Promise<void>((resolve) => {
      signalWorkerALocked = resolve;
    });

    const now = new Date(Date.now() + 5_000);

    const [claimedA, claimedB] = await Promise.all([
      uow.runInTransaction(async (txA) => {
        const batch = await txA.outbox.claimDueBatch(now, 3);
        signalWorkerALocked();
        await workerAHoldingLocks;
        return batch.map((m) => m.id);
      }),
      (async () => {
        await workerALocked;
        try {
          return await uow.runInTransaction(async (txB) => {
            const batch = await txB.outbox.claimDueBatch(now, 3);
            return batch.map((m) => m.id);
          });
        } finally {
          releaseWorkerA();
        }
      })(),
    ]);

    expect(claimedA).toHaveLength(3);
    expect(claimedB).toHaveLength(3);
    const overlap = claimedA.filter((id) => claimedB.includes(id));
    expect(overlap).toHaveLength(0);

    const recon = await reconcileWallet.execute({ walletId: opened.id });
    expect(recon.consistent).toBe(true);
  });
});
