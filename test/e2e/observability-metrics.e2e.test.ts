import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { DataSource } from "typeorm";
import { AppModule } from "../../src/app.module";
import { generateUuidV7 } from "../../src/domain/shared/uuid-v7";
import { SqsService } from "../../src/infrastructure/messaging/sqs/sqs.service";
import {
  MetricsRegistry,
  type MetricsSnapshot,
} from "../../src/infrastructure/observability/metrics.registry";
import { StructuredJsonLogger } from "../../src/infrastructure/observability/structured-json-logger";
import { DATA_SOURCE } from "../../src/infrastructure/persistence/database.module";
import { OutboxPublisherWorker } from "../../src/infrastructure/workers/outbox-publisher.worker";
import { SqsWagerConsumerWorker } from "../../src/infrastructure/workers/sqs-wager-consumer.worker";

describe("Observability E2E — Structured JSON Logs & /metrics (PostgreSQL + MiniStack SQS)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let dataSource: DataSource;
  let metricsRegistry: MetricsRegistry;
  let sqsService: SqsService;
  let consumerWorker: SqsWagerConsumerWorker;
  let outboxWorker: OutboxPublisherWorker;
  const capturedLogs: Array<Record<string, unknown>> = [];

  const prevConsumerEnabled = process.env.SQS_CONSUMER_ENABLED;
  const prevOutboxPoll = process.env.OUTBOX_POLL_INTERVAL_MS;

  beforeAll(async () => {
    process.env.SQS_CONSUMER_ENABLED = "false";
    process.env.OUTBOX_POLL_INTERVAL_MS = "0";

    const testLogger = new StructuredJsonLogger((jsonLine) => {
      try {
        capturedLogs.push(JSON.parse(jsonLine) as Record<string, unknown>);
      } catch {
        // Every emitted log line must be valid JSON — assert below
        capturedLogs.push({ __invalidJsonLine: jsonLine });
      }
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: testLogger });
    await app.listen(0);
    baseUrl = await app.getUrl();

    dataSource = app.get<DataSource>(DATA_SOURCE);
    metricsRegistry = app.get(MetricsRegistry);
    sqsService = app.get(SqsService);
    consumerWorker = app.get(SqsWagerConsumerWorker);
    outboxWorker = app.get(OutboxPublisherWorker);
  });

  afterAll(async () => {
    await app?.close();
    if (prevConsumerEnabled === undefined) delete process.env.SQS_CONSUMER_ENABLED;
    else process.env.SQS_CONSUMER_ENABLED = prevConsumerEnabled;

    if (prevOutboxPoll === undefined) delete process.env.OUTBOX_POLL_INTERVAL_MS;
    else process.env.OUTBOX_POLL_INTERVAL_MS = prevOutboxPoll;
  });

  it("exposes Prometheus text and JSON snapshots at GET /metrics and emits sanitized JSON logs with correlation IDs", async () => {
    await dataSource.query(
      "TRUNCATE TABLE inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE",
    );
    metricsRegistry.reset();
    capturedLogs.length = 0;

    // 1. Open wallet with 100.00 BRL
    const openRes = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": "corr-obs-open",
      },
      body: JSON.stringify({
        playerId: `player-obs-${generateUuidV7()}`,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(openRes.status).toBe(201);
    const wallet = (await openRes.json()) as {
      id: string;
      playerId: string;
      balance: { amount: string; currency: string };
    };

    // 2. Concurrent hot-wallet bets (two 80.00 BRL bets -> 1 PROCESSED, 1 REJECTED) + 1 idempotent replay
    const betKey1 = `obs:${generateUuidV7()}`;
    const betKey2 = `obs:${generateUuidV7()}`;
    const betBody1 = {
      providerId: "provider-obs",
      externalTransactionId: `ext-1-${generateUuidV7()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-obs-1",
      gameId: "chimp-gold",
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
    };
    const betBody2 = {
      ...betBody1,
      externalTransactionId: `ext-2-${generateUuidV7()}`,
    };

    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": betKey1,
          "X-Correlation-Id": "corr-obs-bet-1",
        },
        body: JSON.stringify(betBody1),
      }),
      fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": betKey2,
          "X-Correlation-Id": "corr-obs-bet-2",
        },
        body: JSON.stringify(betBody2),
      }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 422]);

    // Replay bet 1
    const replayRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": betKey1,
        "X-Correlation-Id": "corr-obs-replay",
      },
      body: JSON.stringify(betBody1),
    });
    const replayPayload = (await replayRes.json()) as { idempotentReplay: boolean };
    expect(replayPayload.idempotentReplay).toBe(true);

    // 3. Before draining outbox, verify live outbox lag is > 0 via GET /metrics?format=json
    const metricsBeforeDrainRes = await fetch(`${baseUrl}/metrics?format=json`);
    expect(metricsBeforeDrainRes.status).toBe(200);
    const beforeDrain = (await metricsBeforeDrainRes.json()) as MetricsSnapshot;

    expect(beforeDrain.transactions.byStatus.PROCESSED).toBe(1);
    expect(beforeDrain.transactions.byStatus.REJECTED).toBe(1);
    expect(beforeDrain.transactions.rejectionsByFailureCode.INSUFFICIENT_FUNDS).toBe(1);
    expect(beforeDrain.duplicatesDetected.bySource.http_idempotency).toBe(1);
    expect(beforeDrain.lockConflicts.byType.hot_wallet_contention).toBeGreaterThanOrEqual(1);
    expect(beforeDrain.outbox.pendingMessages).toBeGreaterThanOrEqual(3); // WalletBalanceChanged + Processed + Rejected
    expect(beforeDrain.processingLatencyMs.http_wager?.count).toBe(3);

    // 4. Send 1 valid SQS WIN + 1 malformed SQS message (DLQ) on isolated FIFO pair
    const suffix = generateUuidV7().slice(-8);
    const qMain = `obs-main-${suffix}.fifo`;
    const qDlq = `obs-dlq-${suffix}.fifo`;
    await sqsService.createFifoQueuePair({
      queueName: qMain,
      dlqName: qDlq,
      maxReceiveCount: 5,
    });

    const sqsMsgId = `msg-obs-${generateUuidV7()}`;
    await sqsService.sendFifoMessage(qMain, {
      messageGroupId: wallet.id,
      messageDeduplicationId: sqsMsgId,
      body: JSON.stringify({
        messageId: sqsMsgId,
        correlationId: "corr-obs-sqs-win",
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "provider-obs",
          externalTransactionId: `ext-sqs-${generateUuidV7()}`,
          idempotencyKey: `obs:sqs:${generateUuidV7()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "round-obs-1",
          gameId: "chimp-gold",
          kind: "WIN",
          money: { amount: "35.00", currency: "BRL" },
        },
      }),
    });

    await sqsService.sendFifoMessage(qMain, {
      messageGroupId: `${wallet.id}-bad`,
      messageDeduplicationId: `bad-${generateUuidV7()}`,
      body: "{not-json",
    });

    await consumerWorker.processBatchOnce({
      queueName: qMain,
      dlqName: qDlq,
      maxMessages: 10,
      waitTimeSeconds: 0,
    });
    // Second poll in case MiniStack returns 1 message per FIFO group per call
    await consumerWorker.processBatchOnce({
      queueName: qMain,
      dlqName: qDlq,
      maxMessages: 10,
      waitTimeSeconds: 0,
    });

    // 5. Drain outbox and reconcile wallet
    await outboxWorker.publishOnce(50);

    const recRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
      headers: { "X-Correlation-Id": "corr-obs-reconcile" },
    });
    expect(recRes.status).toBe(200);
    const recBody = (await recRes.json()) as {
      consistent: boolean;
      difference: { amount: string; currency: string };
      storedBalance: { amount: string; currency: string };
    };
    expect(recBody.consistent).toBe(true);
    expect(recBody.difference.amount).toBe("0.00");
    expect(recBody.storedBalance.amount).toBe("55.00"); // 100 - 80 + 35

    // 6. Verify Prometheus text endpoint and post-drain JSON metrics
    const promRes = await fetch(`${baseUrl}/metrics`);
    expect(promRes.status).toBe(200);
    expect(promRes.headers.get("content-type")).toContain("text/plain");
    const promText = await promRes.text();
    expect(promText).toContain("wager_transactions_total");
    expect(promText).toContain("wager_duplicates_detected_total");
    expect(promText).toContain("sqs_dlq_messages_total");
    expect(promText).toContain("db_lock_conflicts_total");
    expect(promText).toContain("outbox_pending_messages 0");
    expect(promText).toContain("wager_processing_duration_ms_bucket");

    const afterDrainRes = await fetch(`${baseUrl}/metrics`, {
      headers: { Accept: "application/json" },
    });
    const afterDrain = (await afterDrainRes.json()) as MetricsSnapshot;
    expect(afterDrain.transactions.byStatus.PROCESSED).toBe(2); // 1 HTTP BET + 1 SQS WIN
    expect(afterDrain.dlqMessages.byCategory.PERMANENT).toBe(1);
    expect(afterDrain.outbox.pendingMessages).toBe(0);
    expect(afterDrain.outbox.publishedTotal).toBeGreaterThanOrEqual(5);
    expect(afterDrain.reconciliations.total).toBe(1);
    expect(afterDrain.reconciliations.divergencesTotal).toBe(0);

    // 7. Verify structured JSON logs: every log is valid JSON, carries correlation fields,
    // and ZERO monetary amounts ("80.00", "35.00", "55.00", "100.00") leaked into logs!
    expect(capturedLogs.length).toBeGreaterThan(0);
    for (const entry of capturedLogs) {
      expect(entry.__invalidJsonLine).toBeUndefined();
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("80.00");
      expect(serialized).not.toContain("35.00");
      expect(serialized).not.toContain("55.00");
      expect(serialized).not.toContain("100.00");
    }

    const sqsAckLog = capturedLogs.find(
      (l) => l.event === "sqs_message_acked" && l.messageId === sqsMsgId,
    );
    expect(sqsAckLog).toBeDefined();
    expect(sqsAckLog?.correlationId).toBe("corr-obs-sqs-win");
    expect(sqsAckLog?.walletId).toBe(wallet.id);
    expect(sqsAckLog?.providerId).toBe("provider-obs");
    expect(typeof sqsAckLog?.transactionId).toBe("string");
  });
});
