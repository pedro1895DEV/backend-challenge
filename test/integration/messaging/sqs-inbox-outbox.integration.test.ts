import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { DataSource } from "typeorm";
import { TransientInfrastructureError } from "../../../src/application/errors/application-errors";
import type { EventPublisherPort } from "../../../src/application/ports/event-publisher.port";
import type { TransactionalContext, UnitOfWork } from "../../../src/application/ports/unit-of-work.port";
import {
  ConsumeWagerMessageUseCase,
  SQS_WAGER_CONSUMER_NAME,
} from "../../../src/application/use-cases/consume-wager-message.use-case";
import { OpenWalletUseCase } from "../../../src/application/use-cases/open-wallet.use-case";
import { ProcessPendingReferencesUseCase } from "../../../src/application/use-cases/process-pending-references.use-case";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import { PublishOutboxBatchUseCase } from "../../../src/application/use-cases/publish-outbox-batch.use-case";
import { ReconcileWalletUseCase } from "../../../src/application/use-cases/reconcile-wallet.use-case";
import { loadConfig, type AppConfig } from "../../../src/config/app-config";
import type { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { generateUuidV7 } from "../../../src/domain/shared/uuid-v7";
import { BusinessFailureCode } from "../../../src/domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction";
import { SqsEventPublisherAdapter } from "../../../src/infrastructure/messaging/sqs/sqs-event-publisher.adapter";
import { SqsService } from "../../../src/infrastructure/messaging/sqs/sqs.service";
import { createDataSource } from "../../../src/infrastructure/persistence/typeorm/data-source";
import { TypeOrmInboxRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-inbox.repository";
import { TypeOrmOutboxRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-outbox.repository";
import { TypeOrmWagerTransactionRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-wager-transaction.repository";
import { TypeOrmWalletLedgerRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-wallet-ledger.repository";
import { TypeOrmWalletRepository } from "../../../src/infrastructure/persistence/typeorm/repositories/typeorm-wallet.repository";
import { TypeOrmUnitOfWork } from "../../../src/infrastructure/persistence/typeorm/typeorm-unit-of-work";
import { SqsWagerConsumerWorker } from "../../../src/infrastructure/workers/sqs-wager-consumer.worker";

describe("SQS Consumer, Persistent Inbox, DLQ, Graceful Shutdown & Outbox Publisher (Integration — Real PostgreSQL & MiniStack SQS)", () => {
  let config: AppConfig;
  let dataSource: DataSource;
  let sqsService: SqsService;
  let uow: TypeOrmUnitOfWork;
  let walletRepo: TypeOrmWalletRepository;
  let ledgerRepo: TypeOrmWalletLedgerRepository;
  let txRepo: TypeOrmWagerTransactionRepository;
  let inboxRepo: TypeOrmInboxRepository;
  let outboxRepo: TypeOrmOutboxRepository;
  let openWallet: OpenWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;
  let reconcileWallet: ReconcileWalletUseCase;

  const createdWalletIds: string[] = [];

  beforeAll(async () => {
    process.env.DB_HOST ??= "localhost";
    process.env.DB_PORT ??= "5432";
    process.env.DB_USER ??= "wagering";
    process.env.DB_PASSWORD ??= "wagering";
    process.env.DB_NAME ??= "wagering";
    process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";

    config = loadConfig({ ...process.env, NODE_ENV: "test" });
    dataSource = createDataSource(config.database);
    await dataSource.initialize();
    await dataSource.runMigrations();

    sqsService = new SqsService(config);
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
    sqsService?.onModuleDestroy();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function createIsolatedQueues(tag: string) {
    const suffix = `${tag}-${generateUuidV7().slice(-8)}`;
    const queueName = `wager-tx-${suffix}.fifo`;
    const dlqName = `wager-dlq-${suffix}.fifo`;
    const eventsQueueName = `wager-evt-${suffix}.fifo`;

    await sqsService.createFifoQueuePair({
      queueName,
      dlqName,
      visibilityTimeoutSeconds: 5,
      maxReceiveCount: 5,
    });
    await sqsService.resolveQueueUrl(eventsQueueName, { autoCreateFifo: true });

    return { queueName, dlqName, eventsQueueName };
  }

  it("consumes PROCESSED and REJECTED (business error) messages from real SQS FIFO, deduplicates duplicates, and ACKs both without DLQing business rejections", async () => {
    const { queueName, dlqName } = await createIsolatedQueues("biz");
    const consumeUseCase = new ConsumeWagerMessageUseCase(uow, inboxRepo, processWager);
    const worker = new SqsWagerConsumerWorker(sqsService, consumeUseCase, config);

    const playerId = `p-sqs-${generateUuidV7()}`;
    const providerId = `prov-sqs-${generateUuidV7().slice(0, 8)}`;
    const wallet = await openWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    createdWalletIds.push(wallet.id);

    // 1. Valid BET of 30.00 BRL
    const msgId1 = `msg-${generateUuidV7()}`;
    await sqsService.sendFifoMessage(queueName, {
      messageGroupId: wallet.id,
      messageDeduplicationId: msgId1,
      body: JSON.stringify({
        messageId: msgId1,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId,
          externalTransactionId: "sqs-bet-1",
          idempotencyKey: `${providerId}:sqs-bet-1`,
          playerId,
          walletId: wallet.id,
          roundId: "r-sqs-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "30.00", currency: "BRL" },
        },
      }),
    });

    // 2. Business rejection: BET of 500.00 BRL (> 70.00 remaining) -> terminal REJECTED + ACK (not DLQ!)
    const msgId2 = `msg-${generateUuidV7()}`;
    await sqsService.sendFifoMessage(queueName, {
      messageGroupId: wallet.id,
      messageDeduplicationId: msgId2,
      body: JSON.stringify({
        messageId: msgId2,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId,
          externalTransactionId: "sqs-bet-over",
          idempotencyKey: `${providerId}:sqs-bet-over`,
          playerId,
          walletId: wallet.id,
          roundId: "r-sqs-2",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "500.00", currency: "BRL" },
        },
      }),
    });

    // 3. Different SQS messageId carrying the SAME idempotencyKey as msgId1 -> ACKed, zero double debit
    const msgId3 = `msg-${generateUuidV7()}`;
    await sqsService.sendFifoMessage(queueName, {
      messageGroupId: wallet.id,
      messageDeduplicationId: msgId3,
      body: JSON.stringify({
        messageId: msgId3,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId,
          externalTransactionId: "sqs-bet-1",
          idempotencyKey: `${providerId}:sqs-bet-1`,
          playerId,
          walletId: wallet.id,
          roundId: "r-sqs-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "30.00", currency: "BRL" },
        },
      }),
    });

    // Drain all 3 messages
    let totalHandled = 0;
    for (let i = 0; i < 5 && totalHandled < 3; i++) {
      totalHandled += await worker.processBatchOnce({
        queueName,
        dlqName,
        waitTimeSeconds: 0,
      });
    }
    expect(totalHandled).toBe(3);

    // Main queue and DLQ must both be empty
    const remainingMain = await sqsService.receiveMessages(queueName, { waitTimeSeconds: 0 });
    const remainingDlq = await sqsService.receiveMessages(dlqName, { waitTimeSeconds: 0 });
    expect(remainingMain).toHaveLength(0);
    expect(remainingDlq).toHaveLength(0);

    // Wallet debited once (100 - 30 = 70), rejected tx persisted as REJECTED, all 3 inbox rows processed
    const updatedWallet = await walletRepo.findById(wallet.id);
    expect(updatedWallet?.balance.toJSON()).toEqual({ amount: "70.00", currency: "BRL" });

    const rejectedTx = await txRepo.findByProviderAndExternalId(providerId, "sqs-bet-over");
    expect(rejectedTx?.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejectedTx?.failureCode).toBe(BusinessFailureCode.InsufficientFunds);

    for (const id of [msgId1, msgId2, msgId3]) {
      const inbox = await inboxRepo.findByConsumerAndMessageId(SQS_WAGER_CONSUMER_NAME, id);
      expect(inbox?.isProcessed()).toBe(true);
    }
  });

  it("§13.5: worker killed AFTER PostgreSQL commit and BEFORE SQS ack -> redelivery deduplicates via Inbox with zero double debit", async () => {
    const { queueName, dlqName } = await createIsolatedQueues("crash-ack");
    const consumeUseCase = new ConsumeWagerMessageUseCase(uow, inboxRepo, processWager);
    const worker1 = new SqsWagerConsumerWorker(sqsService, consumeUseCase, config);
    const worker2 = new SqsWagerConsumerWorker(sqsService, consumeUseCase, config);

    const playerId = `p-crash-${generateUuidV7()}`;
    const providerId = `prov-crash-${generateUuidV7().slice(0, 8)}`;
    const wallet = await openWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    createdWalletIds.push(wallet.id);

    const crashMsgId = `msg-crash-${generateUuidV7()}`;
    await sqsService.sendFifoMessage(queueName, {
      messageGroupId: wallet.id,
      messageDeduplicationId: crashMsgId,
      body: JSON.stringify({
        messageId: crashMsgId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId,
          externalTransactionId: "crash-bet-1",
          idempotencyKey: `${providerId}:crash-bet-1`,
          playerId,
          walletId: wallet.id,
          roundId: "r-crash",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
      }),
    });

    // Worker 1 commits in PostgreSQL and crashes right BEFORE DeleteMessage (visibilityTimeout = 1s)
    await expect(
      worker1.processBatchOnce({
        queueName,
        dlqName,
        waitTimeSeconds: 0,
        visibilityTimeoutSeconds: 1,
        afterCommitBeforeAck: async () => {
          throw new Error("Simulated SIGKILL after SQL COMMIT and before SQS DeleteMessage");
        },
      }),
    ).rejects.toThrow("Simulated SIGKILL after SQL COMMIT and before SQS DeleteMessage");

    // Verify commit ALREADY happened in PostgreSQL
    const walletMid = await walletRepo.findById(wallet.id);
    expect(walletMid?.balance.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });

    // Wait for SQS 1s visibility timeout to expire so MiniStack redelivers the message to Worker 2
    await Bun.sleep(1_300);

    let redeliveredDecisionReason = "";
    const handledByWorker2 = await worker2.processBatchOnce({
      queueName,
      dlqName,
      waitTimeSeconds: 1,
      afterCommitBeforeAck: async (_msg, decision) => {
        if (decision.disposition === "ack") {
          redeliveredDecisionReason = decision.reason;
        }
      },
    });

    expect(handledByWorker2).toBe(1);
    expect(redeliveredDecisionReason).toBe("DUPLICATE_INBOX");

    // Verify zero duplicate debit, zero duplicate ledger entry, zero duplicate outbox event
    const walletFinal = await walletRepo.findById(wallet.id);
    expect(walletFinal?.balance.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });
    expect(walletFinal?.version).toBe(2);

    const ledger = await ledgerRepo.findByWalletId(wallet.id, { limit: 10 });
    expect(ledger.entries.filter((e) => e.direction === "DEBIT")).toHaveLength(1);

    const outbox = await outboxRepo.findByAggregateId(wallet.id);
    // 2 from OPENING + 2 from the single BET
    expect(outbox).toHaveLength(4);
  }, 15_000);

  it("distinguishes permanent poison messages (immediate DLQ) from transient failures (exponential backoff retry -> eventual success or DLQ after maxReceiveCount)", async () => {
    const { queueName, dlqName } = await createIsolatedQueues("retry-dlq");
    const playerId = `p-dlq-${generateUuidV7()}`;
    const providerId = `prov-dlq-${generateUuidV7().slice(0, 8)}`;
    const wallet = await openWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    createdWalletIds.push(wallet.id);

    // Fault-injecting UnitOfWork wrapper to simulate transient PostgreSQL lock/connection failures
    const transientFailuresRemaining = new Map<string, number>();
    let currentAttemptKey = "";

    const flakyUow: UnitOfWork = {
      async runInTransaction<T>(work: (tx: TransactionalContext) => Promise<T>): Promise<T> {
        const remaining = transientFailuresRemaining.get(currentAttemptKey) ?? 0;
        if (remaining > 0) {
          transientFailuresRemaining.set(currentAttemptKey, remaining - 1);
          throw new TransientInfrastructureError("Simulated transient DB lock timeout");
        }
        return uow.runInTransaction(work);
      },
      runReadOnlySnapshot: (work) => uow.runReadOnlySnapshot(work),
    };

    const consumeUseCase = new ConsumeWagerMessageUseCase(flakyUow, inboxRepo, processWager, {
      maxReceiveCount: 3,
      baseDelaySeconds: 1,
      maxDelaySeconds: 2,
    });
    const worker = new SqsWagerConsumerWorker(sqsService, consumeUseCase, config);

    // Case A: Permanent poison messages (1. malformed JSON, 2. numeric money amount) -> immediate DLQ on attempt 1!
    await sqsService.sendFifoMessage(queueName, {
      messageGroupId: "grp-poison-1",
      messageDeduplicationId: "poison-json",
      body: "{bad-json",
    });
    await sqsService.sendFifoMessage(queueName, {
      messageGroupId: "grp-poison-2",
      messageDeduplicationId: "poison-number-money",
      body: JSON.stringify({
        messageId: `msg-num-${generateUuidV7()}`,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId,
          externalTransactionId: "num-money",
          idempotencyKey: `${providerId}:num-money`,
          playerId,
          walletId: wallet.id,
          roundId: "r-poison",
          gameId: "slots",
          kind: "BET",
          money: { amount: 25, currency: "BRL" }, // forbidden JS number!
        },
      }),
    });

    await worker.processBatchOnce({ queueName, dlqName, waitTimeSeconds: 0 });
    await worker.processBatchOnce({ queueName, dlqName, waitTimeSeconds: 0 });

    const dlqAfterPermanent = await sqsService.receiveMessages(dlqName, {
      maxMessages: 10,
      waitTimeSeconds: 1,
    });
    expect(dlqAfterPermanent).toHaveLength(2);
    for (const m of dlqAfterPermanent) {
      expect(m.attributes.FailureCategory).toBe("PERMANENT");
      await sqsService.deleteMessage(dlqName, m.receiptHandle);
    }

    // Case B: Transient error failing once (attempt 1 -> retry backoff 1s) then succeeding on attempt 2!
    const recoverMsgId = `msg-rec-${generateUuidV7()}`;
    currentAttemptKey = "recover";
    transientFailuresRemaining.set("recover", 1);

    await sqsService.sendFifoMessage(queueName, {
      messageGroupId: "grp-transient-recover",
      messageDeduplicationId: recoverMsgId,
      body: JSON.stringify({
        messageId: recoverMsgId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId,
          externalTransactionId: "tx-transient-ok",
          idempotencyKey: `${providerId}:tx-transient-ok`,
          playerId,
          walletId: wallet.id,
          roundId: "r-rec",
          gameId: "slots",
          kind: "BET",
          money: { amount: "20.00", currency: "BRL" },
        },
      }),
    });

    // Attempt 1 -> transient failure -> schedules 1s visibility backoff
    await worker.processBatchOnce({ queueName, dlqName, waitTimeSeconds: 0 });
    expect((await walletRepo.findById(wallet.id))?.balance.amount).toBe("100.00");

    await Bun.sleep(1_300);

    // Attempt 2 -> succeeds & ACKs!
    await worker.processBatchOnce({ queueName, dlqName, waitTimeSeconds: 1 });
    expect((await walletRepo.findById(wallet.id))?.balance.amount).toBe("80.00");

    // Case C: Transient error failing all 3 attempts (maxReceiveCount = 3) -> routed to DLQ!
    const exhaustMsgId = `msg-exh-${generateUuidV7()}`;
    currentAttemptKey = "exhaust";
    transientFailuresRemaining.set("exhaust", 10);

    await sqsService.sendFifoMessage(queueName, {
      messageGroupId: "grp-transient-exhaust",
      messageDeduplicationId: exhaustMsgId,
      body: JSON.stringify({
        messageId: exhaustMsgId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId,
          externalTransactionId: "tx-transient-dlq",
          idempotencyKey: `${providerId}:tx-transient-dlq`,
          playerId,
          walletId: wallet.id,
          roundId: "r-exh",
          gameId: "slots",
          kind: "BET",
          money: { amount: "20.00", currency: "BRL" },
        },
      }),
    });

    // Attempt 1 (backoff 1s) -> Attempt 2 (backoff 2s) -> Attempt 3 (receiveCount = 3 >= maxReceiveCount -> DLQ!)
    await worker.processBatchOnce({ queueName, dlqName, waitTimeSeconds: 0 });
    await Bun.sleep(1_250);
    await worker.processBatchOnce({ queueName, dlqName, waitTimeSeconds: 1 });
    await Bun.sleep(2_250);
    await worker.processBatchOnce({ queueName, dlqName, waitTimeSeconds: 1 });

    const dlqAfterExhaust = await sqsService.receiveMessages(dlqName, {
      maxMessages: 10,
      waitTimeSeconds: 1,
    });
    expect(dlqAfterExhaust).toHaveLength(1);
    expect(dlqAfterExhaust[0]?.attributes.FailureCategory).toBe("MAX_RETRIES_EXCEEDED");
    await sqsService.deleteMessage(dlqName, dlqAfterExhaust[0]!.receiptHandle);

    // Wallet balance remained 80.00 BRL (exhausted transient message produced zero partial writes)
    expect((await walletRepo.findById(wallet.id))?.balance.amount).toBe("80.00");
  }, 20_000);

  it("§10 SIGTERM graceful shutdown: concludes in-flight message and returns visibility (0s) of unstarted batch messages", async () => {
    const { queueName, dlqName } = await createIsolatedQueues("sigterm");
    const consumeUseCase = new ConsumeWagerMessageUseCase(uow, inboxRepo, processWager);
    const worker1 = new SqsWagerConsumerWorker(sqsService, consumeUseCase, config);
    const worker2 = new SqsWagerConsumerWorker(sqsService, consumeUseCase, config);

    const playerId = `p-term-${generateUuidV7()}`;
    const providerId = `prov-term-${generateUuidV7().slice(0, 8)}`;
    const wallet = await openWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    createdWalletIds.push(wallet.id);

    // Enqueue 2 messages in distinct MessageGroupIds so ReceiveMessage returns BOTH in one batch
    // with a long 30s visibility timeout.
    for (const idx of [1, 2]) {
      const mid = `msg-term-${idx}-${generateUuidV7()}`;
      await sqsService.sendFifoMessage(queueName, {
        messageGroupId: `grp-term-${idx}`,
        messageDeduplicationId: mid,
        body: JSON.stringify({
          messageId: mid,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId,
            externalTransactionId: `term-bet-${idx}`,
            idempotencyKey: `${providerId}:term-bet-${idx}`,
            playerId,
            walletId: wallet.id,
            roundId: `r-term-${idx}`,
            gameId: "slots",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          },
        }),
      });
    }

    // Trigger SIGTERM (worker1.stop()) while message #1 is finishing commit!
    let stopPromise: Promise<void> | null = null;
    const handledByWorker1 = await worker1.processBatchOnce({
      queueName,
      dlqName,
      maxMessages: 10,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 30,
      afterCommitBeforeAck: async () => {
        if (!stopPromise) {
          stopPromise = worker1.stop(5_000);
        }
        await Bun.sleep(50);
      },
    });
    await stopPromise;

    // Worker 1 concluded message #1 (100 -> 90) and returned visibility (0s) for unstarted message #2!
    expect(handledByWorker1).toBe(1);
    expect((await walletRepo.findById(wallet.id))?.balance.amount).toBe("90.00");

    // Because visibility was returned to 0s (instead of staying locked for 30s!), Worker 2 can pick up message #2 immediately!
    const handledByWorker2 = await worker2.processBatchOnce({
      queueName,
      dlqName,
      waitTimeSeconds: 1,
    });
    expect(handledByWorker2).toBe(1);
    expect((await walletRepo.findById(wallet.id))?.balance.amount).toBe("80.00");
  }, 15_000);

  it("§11 & §13.6: concurrent outbox publishers + retry backoff + crash after SQS publish & before SQL commit", async () => {
    const { eventsQueueName } = await createIsolatedQueues("outbox");
    const customConfig: AppConfig = {
      ...config,
      sqs: { ...config.sqs, outboxQueueName: eventsQueueName },
    };
    const realSqsPublisher = new SqsEventPublisherAdapter(sqsService, customConfig);

    // Drain any prior unpublished outbox rows in DB first so counts in this test are exact
    const initialDrain = new PublishOutboxBatchUseCase(uow, realSqsPublisher);
    while ((await initialDrain.executeBatch(new Date(Date.now() + 60_000), 100)).claimed > 0) {
      // drained
    }
    // Clear those drained messages from our isolated eventsQueueName
    while (true) {
      const drainedMsgs = await sqsService.receiveMessages(eventsQueueName, {
        maxMessages: 10,
        waitTimeSeconds: 0,
      });
      if (drainedMsgs.length === 0) break;
      await Promise.all(
        drainedMsgs.map((m) => sqsService.deleteMessage(eventsQueueName, m.receiptHandle)),
      );
    }

    // Create a wallet + 5 BETs => 12 new outbox events (2 OPENING + 10 BET events)
    const playerId = `p-outbox-${generateUuidV7()}`;
    const providerId = `prov-outbox-${generateUuidV7().slice(0, 8)}`;
    const wallet = await openWallet.execute({
      playerId,
      initialBalance: { amount: "200.00", currency: "BRL" },
    });
    createdWalletIds.push(wallet.id);

    for (let i = 1; i <= 5; i++) {
      await processWager.execute({
        idempotencyKey: `${providerId}:ob-bet-${i}`,
        providerId,
        externalTransactionId: `ob-bet-${i}`,
        playerId,
        walletId: wallet.id,
        roundId: `r-ob-${i}`,
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      });
    }

    // 1. Transient failure on first batch -> schedules retry backoff instead of losing events
    let failFirstCall = true;
    const flakyPublisher: EventPublisherPort = {
      async publish(msg: OutboxMessage): Promise<void> {
        if (failFirstCall) {
          failFirstCall = false;
          throw new Error("Simulated transient SQS 503 during outbox publish");
        }
        await realSqsPublisher.publish(msg);
      },
    };

    const publisherA = new PublishOutboxBatchUseCase(uow, flakyPublisher, {
      baseDelayMs: 200,
      maxDelayMs: 1_000,
    });
    const publisherB = new PublishOutboxBatchUseCase(uow, realSqsPublisher, {
      baseDelayMs: 200,
      maxDelayMs: 1_000,
    });

    // Run TWO concurrent publishers over the same outbox table!
    const [resA, resB] = await Promise.all([
      publisherA.executeBatch(new Date(), 6),
      publisherB.executeBatch(new Date(), 6),
    ]);

    expect(resA.claimed + resB.claimed).toBe(12);
    expect(resA.retried).toBe(1);
    expect(resA.published + resB.published).toBe(11);

    // Wait 250ms for the 1 retried event's backoff to expire, then publish it
    await Bun.sleep(260);
    const retryRes = await publisherB.executeBatch(new Date(), 10);
    expect(retryRes.published).toBe(1);
    expect(await outboxRepo.countPending()).toBe(0);

    // 2. Crash AFTER SQS publish and BEFORE SQL COMMIT (§11 5-step scenario):
    // Enqueue 1 LOSS transaction -> 1 WagerTransactionProcessed outbox event
    await processWager.execute({
      idempotencyKey: `${providerId}:ob-loss-crash`,
      providerId,
      externalTransactionId: "ob-loss-crash",
      playerId,
      walletId: wallet.id,
      roundId: "r-ob-crash",
      gameId: "fortune-chimp",
      kind: "LOSS",
      money: { amount: "0.00", currency: "BRL" },
    });

    let publishedEventIdBeforeCrash = "";
    await expect(
      uow.runInTransaction(async (tx) => {
        const due = await tx.outbox.claimDueBatch(new Date(), 5);
        expect(due).toHaveLength(1);
        publishedEventIdBeforeCrash = due[0]!.id;
        await realSqsPublisher.publish(due[0]!);
        // Process dies BEFORE marking published & committing!
        throw new Error("Simulated worker crash after SQS SendMessage and before SQL COMMIT");
      }),
    ).rejects.toThrow("Simulated worker crash after SQS SendMessage and before SQL COMMIT");

    // Outbox row is still pending in PostgreSQL because commit never happened
    expect(await outboxRepo.countPending()).toBe(1);

    // Another instance (publisherB) takes over, republishes with the EXACT SAME stable eventId, and commits!
    const recovered = await publisherB.executeBatch(new Date(), 5);
    expect(recovered.published).toBe(1);
    expect(await outboxRepo.countPending()).toBe(0);

    // Receive all published events from real MiniStack SQS `eventsQueueName` and verify envelopes
    const receivedEventIds = new Set<string>();
    for (let poll = 0; poll < 6; poll++) {
      const msgs = await sqsService.receiveMessages(eventsQueueName, {
        maxMessages: 10,
        waitTimeSeconds: 0,
      });
      if (msgs.length === 0) break;
      for (const m of msgs) {
        const envelope = JSON.parse(m.body) as { eventId: string; eventType: string };
        expect(typeof envelope.eventId).toBe("string");
        expect(typeof envelope.eventType).toBe("string");
        receivedEventIds.add(envelope.eventId);
        await sqsService.deleteMessage(eventsQueueName, m.receiptHandle);
      }
    }

    // All 13 unique integration events (12 + 1 crash-recovered event) arrived in real SQS with stable eventIds!
    expect(receivedEventIds.has(publishedEventIdBeforeCrash)).toBe(true);
    expect(receivedEventIds.size).toBe(13);
  }, 20_000);

  it("§7.1: PENDING_REFERENCE exhausting retry limit transitions to REJECTED (REFERENCE_NOT_FOUND) and enqueues WagerTransactionRejected", async () => {
    const playerId = `p-exp-${generateUuidV7()}`;
    const providerId = `prov-exp-${generateUuidV7().slice(0, 8)}`;
    const wallet = await openWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    createdWalletIds.push(wallet.id);

    // Submit REFUND referencing a BET that never arrives (attempt 1 recorded on submission)
    const pending = await processWager.execute({
      idempotencyKey: `${providerId}:orphan-refund`,
      providerId,
      externalTransactionId: "orphan-refund",
      playerId,
      walletId: wallet.id,
      roundId: "r-orphan",
      gameId: "fortune-chimp",
      kind: "REFUND",
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-never-sent",
    });
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    const fastExpiryPolicy = {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
    };
    const pendingProcessor = new ProcessPendingReferencesUseCase(uow, txRepo, fastExpiryPolicy);

    // Advance virtual `now` past attempt 1's scheduled retry -> attempt 2 rescheduled, then next tick exhausts maxAttempts=2 -> REJECTED!
    const t1 = new Date(Date.now() + 10_000);
    await pendingProcessor.executeBatch(t1, 50);

    const t2 = new Date(Date.now() + 20_000);
    await pendingProcessor.executeBatch(t2, 50);

    const finalTx = await txRepo.findById(pending.transactionId);
    expect(finalTx?.status).toBe(WagerTransactionStatus.Rejected);
    expect(finalTx?.failureCode).toBe(BusinessFailureCode.ReferenceNotFound);

    const walletEvents = await outboxRepo.findByAggregateId(wallet.id);
    const rejectedEvents = walletEvents.filter(
      (e) =>
        e.eventType === "WagerTransactionRejected" &&
        (e.payload.data as { transactionId?: string })?.transactionId === pending.transactionId,
    );
    expect(rejectedEvents).toHaveLength(1);
    expect((rejectedEvents[0]!.payload.data as { failureCode: string }).failureCode).toBe(
      "REFERENCE_NOT_FOUND",
    );
  });

  it("Final Invariant (§13): wallet.balance == ledger reconstructed balance across every wallet in the SQS/Outbox suite", async () => {
    expect(createdWalletIds.length).toBeGreaterThanOrEqual(6);
    for (const walletId of createdWalletIds) {
      const recon = await reconcileWallet.execute({ walletId });
      expect(recon.consistent).toBe(true);
      expect(recon.difference).toEqual({ amount: "0.00", currency: "BRL" });
    }
  });
});
