import { describe, expect, it } from "bun:test";
import { MetricsRegistry } from "../../../src/infrastructure/observability/metrics.registry";
import { StructuredJsonLogger } from "../../../src/infrastructure/observability/structured-json-logger";

describe("Observability — StructuredJsonLogger & MetricsRegistry", () => {
  describe("StructuredJsonLogger", () => {
    it("emits valid single-line JSON carrying correlationId, messageId, transactionId, walletId, and providerId", () => {
      const captured: Array<{ line: string; level: string }> = [];
      const logger = new StructuredJsonLogger((line, level) => {
        captured.push({ line, level });
      });

      logger.log(
        JSON.stringify({
          event: "wager_transaction_settled",
          correlationId: "corr-001",
          messageId: "msg-001",
          transactionId: "tx-001",
          walletId: "wallet-001",
          providerId: "provider-a",
          kind: "BET",
          status: "PROCESSED",
        }),
        "WageringController",
      );

      expect(captured).toHaveLength(1);
      expect(captured[0]!.level).toBe("info");
      expect(captured[0]!.line.includes("\n")).toBe(false);

      const parsed = JSON.parse(captured[0]!.line) as Record<string, unknown>;
      expect(typeof parsed.timestamp).toBe("string");
      expect(parsed.level).toBe("info");
      expect(parsed.context).toBe("WageringController");
      expect(parsed.event).toBe("wager_transaction_settled");
      expect(parsed.correlationId).toBe("corr-001");
      expect(parsed.messageId).toBe("msg-001");
      expect(parsed.transactionId).toBe("tx-001");
      expect(parsed.walletId).toBe("wallet-001");
      expect(parsed.providerId).toBe("provider-a");
    });

    it("strips sensitive credentials and full financial payloads/amounts recursively", () => {
      const captured: string[] = [];
      const logger = new StructuredJsonLogger((line) => {
        captured.push(line);
      });

      logger.warn(
        {
          event: "suspicious_input",
          correlationId: "corr-sec-1",
          walletId: "wallet-99",
          providerId: "provider-x",
          Authorization: "Bearer super-secret-jwt",
          clientSecret: "top-secret",
          money: { amount: "9999.99", currency: "BRL" },
          balance: { amount: "5000.00", currency: "BRL" },
          initialBalance: { amount: "1000.00", currency: "BRL" },
          nested: {
            token: "hidden-token",
            amount: "250.00",
            payload: { card: "4111" },
            safeField: "kept",
          },
        },
        "SecurityAudit",
      );

      expect(captured).toHaveLength(1);
      const raw = captured[0]!;
      expect(raw).not.toContain("super-secret-jwt");
      expect(raw).not.toContain("top-secret");
      expect(raw).not.toContain("9999.99");
      expect(raw).not.toContain("5000.00");
      expect(raw).not.toContain("1000.00");
      expect(raw).not.toContain("250.00");
      expect(raw).not.toContain("hidden-token");
      expect(raw).not.toContain("4111");

      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.correlationId).toBe("corr-sec-1");
      expect(parsed.walletId).toBe("wallet-99");
      expect(parsed.providerId).toBe("provider-x");
      expect((parsed.nested as Record<string, unknown>).safeField).toBe("kept");
    });
  });

  describe("MetricsRegistry", () => {
    it("aggregates counters, gauges, and latency percentiles and renders valid Prometheus text & JSON", () => {
      const registry = new MetricsRegistry();

      registry.recordTransactionOutcome({
        status: "PROCESSED",
        kind: "BET",
        channel: "http",
      });
      registry.recordTransactionOutcome({
        status: "PROCESSED",
        kind: "WIN",
        channel: "sqs",
      });
      registry.recordTransactionOutcome({
        status: "REJECTED",
        kind: "BET",
        channel: "http",
        failureCode: "INSUFFICIENT_FUNDS",
      });
      registry.recordTransactionOutcome({
        status: "PENDING_REFERENCE",
        kind: "REFUND",
        channel: "http",
      });

      registry.recordDuplicateDetected("http_idempotency");
      registry.recordDuplicateDetected("http_idempotency");
      registry.recordDuplicateDetected("sqs_inbox");

      registry.recordRetry("sqs_consumer", "TRANSIENT_INFRASTRUCTURE_ERROR");
      registry.recordRetry("outbox_publisher", "broker_publish_failed");
      registry.recordRetry("pending_reference", "reference_still_missing");

      registry.recordDlqMessage("PERMANENT", "MALFORMED_JSON");
      registry.recordDlqMessage("MAX_RETRIES_EXCEEDED", "TRANSIENT_INFRASTRUCTURE_ERROR");

      registry.recordLockConflict("hot_wallet_contention");
      registry.recordLockConflict("unique_constraint_race");

      registry.recordReconciliation(true);
      registry.recordReconciliation(false);

      registry.recordOutboxPublished(12);
      registry.recordOutboxPublished(38);

      for (const sample of [2, 4, 6, 8, 10, 20, 40, 80, 120, 200]) {
        registry.recordProcessingDuration("http_wager", sample);
      }

      const snapshot = registry.toSnapshot({
        pendingCount: 3,
        oldestPendingAgeMs: 1450,
      });

      expect(snapshot.transactions.byStatus.PROCESSED).toBe(2);
      expect(snapshot.transactions.byStatus.REJECTED).toBe(1);
      expect(snapshot.transactions.byStatus.PENDING_REFERENCE).toBe(1);
      expect(snapshot.transactions.rejectionsByFailureCode.INSUFFICIENT_FUNDS).toBe(1);

      expect(snapshot.duplicatesDetected.total).toBe(3);
      expect(snapshot.duplicatesDetected.bySource.http_idempotency).toBe(2);
      expect(snapshot.duplicatesDetected.bySource.sqs_inbox).toBe(1);

      expect(snapshot.retries.total).toBe(3);
      expect(snapshot.dlqMessages.total).toBe(2);
      expect(snapshot.lockConflicts.total).toBe(2);
      expect(snapshot.reconciliations.total).toBe(2);
      expect(snapshot.reconciliations.divergencesTotal).toBe(1);

      expect(snapshot.outbox.publishedTotal).toBe(2);
      expect(snapshot.outbox.pendingMessages).toBe(3);
      expect(snapshot.outbox.oldestPendingAgeMs).toBe(1450);
      expect(snapshot.outbox.oldestPendingAgeSeconds).toBe(1.45);
      expect(snapshot.outbox.deliveryLagMs.count).toBe(2);

      const httpHist = snapshot.processingLatencyMs.http_wager!;
      expect(httpHist.count).toBe(10);
      expect(httpHist.minMs).toBe(2);
      expect(httpHist.maxMs).toBe(200);
      expect(httpHist.p50Ms).toBe(10);
      expect(httpHist.p95Ms).toBe(200);

      const prom = registry.toPrometheusText({
        pendingCount: 3,
        oldestPendingAgeMs: 1450,
      });

      expect(prom).toContain('wager_transactions_total{status="PROCESSED",kind="BET",channel="http"} 1');
      expect(prom).toContain('wager_transaction_rejections_total{failure_code="INSUFFICIENT_FUNDS"} 1');
      expect(prom).toContain('wager_duplicates_detected_total{source="http_idempotency"} 2');
      expect(prom).toContain('wager_duplicates_detected_total{source="sqs_inbox"} 1');
      expect(prom).toContain('sqs_dlq_messages_total{category="PERMANENT",reason="MALFORMED_JSON"} 1');
      expect(prom).toContain('db_lock_conflicts_total{type="hot_wallet_contention"} 1');
      expect(prom).toContain("wallet_reconciliation_divergences_total 1");
      expect(prom).toContain("outbox_pending_messages 3");
      expect(prom).toContain("outbox_oldest_pending_age_ms 1450");
      expect(prom).toContain('wager_processing_duration_ms_count{operation="http_wager"} 10');
    });
  });
});
