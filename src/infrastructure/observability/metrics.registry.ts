import { Injectable } from "@nestjs/common";
import type {
  DlqCategory,
  DuplicateSource,
  LockConflictType,
  MetricsPort,
  OperationLatencyName,
  RetryComponent,
  TransactionOutcomeMetric,
} from "../../application/ports/metrics.port";
import type { OutboxLagStats } from "../../application/ports/outbox.repository";

const DEFAULT_HISTOGRAM_BUCKETS_MS = [
  1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
] as const;

const RESERVOIR_MAX_SAMPLES = 2_048;

export interface HistogramSummary {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  buckets: Readonly<Record<string, number>>;
}

interface InternalHistogram {
  count: number;
  sum: number;
  min: number;
  max: number;
  bucketCounts: number[]; // cumulative or per-threshold? Store cumulative thresholds directly or non-cumulative and accumulate on export
  samples: number[];
  writeCursor: number;
}

export interface MetricsSnapshot {
  collectedAt: string;
  transactions: {
    byStatus: Record<string, number>;
    detailed: Array<{
      status: string;
      kind: string;
      channel: string;
      count: number;
    }>;
    rejectionsByFailureCode: Record<string, number>;
  };
  duplicatesDetected: {
    total: number;
    bySource: Record<string, number>;
  };
  retries: {
    total: number;
    byComponent: Record<string, number>;
    detailed: Array<{ component: string; reason: string; count: number }>;
  };
  dlqMessages: {
    total: number;
    byCategory: Record<string, number>;
    detailed: Array<{ category: string; reason: string; count: number }>;
  };
  lockConflicts: {
    total: number;
    byType: Record<string, number>;
  };
  reconciliations: {
    total: number;
    divergencesTotal: number;
  };
  outbox: {
    publishedTotal: number;
    pendingMessages: number;
    oldestPendingAgeMs: number;
    oldestPendingAgeSeconds: number;
    deliveryLagMs: HistogramSummary;
  };
  processingLatencyMs: Record<string, HistogramSummary>;
}

function createHistogram(): InternalHistogram {
  return {
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
    bucketCounts: DEFAULT_HISTOGRAM_BUCKETS_MS.map(() => 0),
    samples: [],
    writeCursor: 0,
  };
}

function observeHistogram(hist: InternalHistogram, rawValueMs: number): void {
  const value = Number.isFinite(rawValueMs) ? Math.max(0, rawValueMs) : 0;
  hist.count += 1;
  hist.sum += value;
  if (value < hist.min) hist.min = value;
  if (value > hist.max) hist.max = value;

  for (let i = 0; i < DEFAULT_HISTOGRAM_BUCKETS_MS.length; i++) {
    if (value <= DEFAULT_HISTOGRAM_BUCKETS_MS[i]!) {
      hist.bucketCounts[i]! += 1;
    }
  }

  if (hist.samples.length < RESERVOIR_MAX_SAMPLES) {
    hist.samples.push(value);
  } else {
    hist.samples[hist.writeCursor] = value;
    hist.writeCursor = (hist.writeCursor + 1) % RESERVOIR_MAX_SAMPLES;
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return round2(sorted[idx]!);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarizeHistogram(hist: InternalHistogram): HistogramSummary {
  const sorted = [...hist.samples].sort((a, b) => a - b);
  const buckets: Record<string, number> = {};
  for (let i = 0; i < DEFAULT_HISTOGRAM_BUCKETS_MS.length; i++) {
    buckets[String(DEFAULT_HISTOGRAM_BUCKETS_MS[i]!)] = hist.bucketCounts[i]!;
  }
  buckets["+Inf"] = hist.count;

  if (hist.count === 0) {
    return {
      count: 0,
      sumMs: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      buckets,
    };
  }

  return {
    count: hist.count,
    sumMs: round2(hist.sum),
    minMs: round2(hist.min),
    maxMs: round2(hist.max),
    meanMs: round2(hist.sum / hist.count),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    buckets,
  };
}

function escapePromLabel(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapePromLabel(v)}"`).join(",")}}`;
}

/**
 * In-process operational metrics registry implementing {@link MetricsPort} and
 * exporting both Prometheus text (`text/plain; version=0.0.4`) and structured
 * JSON snapshots (README §12).
 */
@Injectable()
export class MetricsRegistry implements MetricsPort {
  private readonly txDetailed = new Map<string, { status: string; kind: string; channel: string; count: number }>();
  private readonly txByStatus = new Map<string, number>();
  private readonly rejectionsByCode = new Map<string, number>();
  private readonly duplicatesBySource = new Map<string, number>();
  private readonly retriesDetailed = new Map<string, { component: string; reason: string; count: number }>();
  private readonly dlqDetailed = new Map<string, { category: string; reason: string; count: number }>();
  private readonly lockConflictsByType = new Map<string, number>();
  private readonly latencyHistograms = new Map<string, InternalHistogram>();
  private outboxPublishedTotal = 0;
  private outboxDeliveryLag = createHistogram();
  private reconciliationsConsistentTotal = 0;
  private reconciliationsDivergentTotal = 0;

  reset(): void {
    this.txDetailed.clear();
    this.txByStatus.clear();
    this.rejectionsByCode.clear();
    this.duplicatesBySource.clear();
    this.retriesDetailed.clear();
    this.dlqDetailed.clear();
    this.lockConflictsByType.clear();
    this.latencyHistograms.clear();
    this.outboxPublishedTotal = 0;
    this.outboxDeliveryLag = createHistogram();
    this.reconciliationsConsistentTotal = 0;
    this.reconciliationsDivergentTotal = 0;
  }

  recordTransactionOutcome(outcome: TransactionOutcomeMetric): void {
    const key = `${outcome.status}|${outcome.kind}|${outcome.channel}`;
    const existing = this.txDetailed.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.txDetailed.set(key, {
        status: outcome.status,
        kind: outcome.kind,
        channel: outcome.channel,
        count: 1,
      });
    }

    this.txByStatus.set(outcome.status, (this.txByStatus.get(outcome.status) ?? 0) + 1);

    if (outcome.failureCode) {
      this.rejectionsByCode.set(
        outcome.failureCode,
        (this.rejectionsByCode.get(outcome.failureCode) ?? 0) + 1,
      );
    }
  }

  recordDuplicateDetected(source: DuplicateSource): void {
    this.duplicatesBySource.set(source, (this.duplicatesBySource.get(source) ?? 0) + 1);
  }

  recordRetry(component: RetryComponent, reason: string): void {
    const safeReason = reason || "unspecified";
    const key = `${component}|${safeReason}`;
    const existing = this.retriesDetailed.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.retriesDetailed.set(key, { component, reason: safeReason, count: 1 });
    }
  }

  recordDlqMessage(category: DlqCategory, reason: string): void {
    const safeReason = reason || "unspecified";
    const key = `${category}|${safeReason}`;
    const existing = this.dlqDetailed.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.dlqDetailed.set(key, { category, reason: safeReason, count: 1 });
    }
  }

  recordLockConflict(type: LockConflictType): void {
    this.lockConflictsByType.set(type, (this.lockConflictsByType.get(type) ?? 0) + 1);
  }

  recordOutboxPublished(deliveryLagMs: number): void {
    this.outboxPublishedTotal += 1;
    observeHistogram(this.outboxDeliveryLag, deliveryLagMs);
  }

  recordProcessingDuration(operation: OperationLatencyName, durationMs: number): void {
    let hist = this.latencyHistograms.get(operation);
    if (!hist) {
      hist = createHistogram();
      this.latencyHistograms.set(operation, hist);
    }
    observeHistogram(hist, durationMs);
  }

  recordReconciliation(consistent: boolean): void {
    if (consistent) {
      this.reconciliationsConsistentTotal += 1;
    } else {
      this.reconciliationsDivergentTotal += 1;
    }
  }

  toSnapshot(outboxLag: OutboxLagStats = { pendingCount: 0, oldestPendingAgeMs: 0 }): MetricsSnapshot {
    const byStatus: Record<string, number> = {
      PROCESSED: this.txByStatus.get("PROCESSED") ?? 0,
      REJECTED: this.txByStatus.get("REJECTED") ?? 0,
      PENDING_REFERENCE: this.txByStatus.get("PENDING_REFERENCE") ?? 0,
      FAILED: this.txByStatus.get("FAILED") ?? 0,
    };
    for (const [status, count] of this.txByStatus.entries()) {
      byStatus[status] = count;
    }

    const rejectionsByFailureCode: Record<string, number> = {};
    for (const [code, count] of this.rejectionsByCode.entries()) {
      rejectionsByFailureCode[code] = count;
    }

    const duplicatesBySource: Record<string, number> = {
      http_idempotency: this.duplicatesBySource.get("http_idempotency") ?? 0,
      sqs_inbox: this.duplicatesBySource.get("sqs_inbox") ?? 0,
      sqs_idempotency: this.duplicatesBySource.get("sqs_idempotency") ?? 0,
    };
    let duplicatesTotal = 0;
    for (const [src, count] of this.duplicatesBySource.entries()) {
      duplicatesBySource[src] = count;
      duplicatesTotal += count;
    }

    const retriesByComponent: Record<string, number> = {
      sqs_consumer: 0,
      outbox_publisher: 0,
      pending_reference: 0,
    };
    let retriesTotal = 0;
    const retriesDetailed = [...this.retriesDetailed.values()];
    for (const item of retriesDetailed) {
      retriesByComponent[item.component] = (retriesByComponent[item.component] ?? 0) + item.count;
      retriesTotal += item.count;
    }

    const dlqByCategory: Record<string, number> = {
      PERMANENT: 0,
      MAX_RETRIES_EXCEEDED: 0,
    };
    let dlqTotal = 0;
    const dlqDetailed = [...this.dlqDetailed.values()];
    for (const item of dlqDetailed) {
      dlqByCategory[item.category] = (dlqByCategory[item.category] ?? 0) + item.count;
      dlqTotal += item.count;
    }

    const lockConflictsByType: Record<string, number> = {
      hot_wallet_contention: this.lockConflictsByType.get("hot_wallet_contention") ?? 0,
      lock_timeout_or_deadlock: this.lockConflictsByType.get("lock_timeout_or_deadlock") ?? 0,
      unique_constraint_race: this.lockConflictsByType.get("unique_constraint_race") ?? 0,
    };
    let lockConflictsTotal = 0;
    for (const [type, count] of this.lockConflictsByType.entries()) {
      lockConflictsByType[type] = count;
      lockConflictsTotal += count;
    }

    const processingLatencyMs: Record<string, HistogramSummary> = {};
    for (const [op, hist] of this.latencyHistograms.entries()) {
      processingLatencyMs[op] = summarizeHistogram(hist);
    }

    return {
      collectedAt: new Date().toISOString(),
      transactions: {
        byStatus,
        detailed: [...this.txDetailed.values()],
        rejectionsByFailureCode,
      },
      duplicatesDetected: {
        total: duplicatesTotal,
        bySource: duplicatesBySource,
      },
      retries: {
        total: retriesTotal,
        byComponent: retriesByComponent,
        detailed: retriesDetailed,
      },
      dlqMessages: {
        total: dlqTotal,
        byCategory: dlqByCategory,
        detailed: dlqDetailed,
      },
      lockConflicts: {
        total: lockConflictsTotal,
        byType: lockConflictsByType,
      },
      reconciliations: {
        total: this.reconciliationsConsistentTotal + this.reconciliationsDivergentTotal,
        divergencesTotal: this.reconciliationsDivergentTotal,
      },
      outbox: {
        publishedTotal: this.outboxPublishedTotal,
        pendingMessages: outboxLag.pendingCount,
        oldestPendingAgeMs: round2(outboxLag.oldestPendingAgeMs),
        oldestPendingAgeSeconds: round2(outboxLag.oldestPendingAgeMs / 1000),
        deliveryLagMs: summarizeHistogram(this.outboxDeliveryLag),
      },
      processingLatencyMs,
    };
  }

  toPrometheusText(outboxLag: OutboxLagStats = { pendingCount: 0, oldestPendingAgeMs: 0 }): string {
    const lines: string[] = [];

    // 1. Transactions by status
    lines.push("# HELP wager_transactions_total Total wager transactions settled by status, kind, and channel.");
    lines.push("# TYPE wager_transactions_total counter");
    if (this.txDetailed.size === 0) {
      for (const status of ["PROCESSED", "REJECTED", "PENDING_REFERENCE", "FAILED"]) {
        lines.push(`wager_transactions_total${formatLabels({ status, kind: "ALL", channel: "all" })} 0`);
      }
    } else {
      for (const item of this.txDetailed.values()) {
        lines.push(
          `wager_transactions_total${formatLabels({
            status: item.status,
            kind: item.kind,
            channel: item.channel,
          })} ${item.count}`,
        );
      }
    }

    // 2. Rejections by failureCode
    lines.push("# HELP wager_transaction_rejections_total Total business/infra rejections by failureCode.");
    lines.push("# TYPE wager_transaction_rejections_total counter");
    for (const [failureCode, count] of this.rejectionsByCode.entries()) {
      lines.push(`wager_transaction_rejections_total${formatLabels({ failure_code: failureCode })} ${count}`);
    }

    // 3. Duplicates detected
    lines.push("# HELP wager_duplicates_detected_total Duplicate requests or messages detected via persistent idempotency or inbox.");
    lines.push("# TYPE wager_duplicates_detected_total counter");
    for (const source of ["http_idempotency", "sqs_inbox", "sqs_idempotency"] as const) {
      lines.push(
        `wager_duplicates_detected_total${formatLabels({ source })} ${
          this.duplicatesBySource.get(source) ?? 0
        }`,
      );
    }

    // 4. Retries
    lines.push("# HELP wager_retries_total Scheduled retries across SQS consumer, outbox publisher, and pending_reference worker.");
    lines.push("# TYPE wager_retries_total counter");
    if (this.retriesDetailed.size === 0) {
      for (const component of ["sqs_consumer", "outbox_publisher", "pending_reference"]) {
        lines.push(`wager_retries_total${formatLabels({ component, reason: "none" })} 0`);
      }
    } else {
      for (const item of this.retriesDetailed.values()) {
        lines.push(
          `wager_retries_total${formatLabels({
            component: item.component,
            reason: item.reason,
          })} ${item.count}`,
        );
      }
    }

    // 5. DLQ messages
    lines.push("# HELP sqs_dlq_messages_total Messages routed to wager-transactions-dlq.fifo.");
    lines.push("# TYPE sqs_dlq_messages_total counter");
    if (this.dlqDetailed.size === 0) {
      for (const category of ["PERMANENT", "MAX_RETRIES_EXCEEDED"]) {
        lines.push(`sqs_dlq_messages_total${formatLabels({ category, reason: "none" })} 0`);
      }
    } else {
      for (const item of this.dlqDetailed.values()) {
        lines.push(
          `sqs_dlq_messages_total${formatLabels({
            category: item.category,
            reason: item.reason,
          })} ${item.count}`,
        );
      }
    }

    // 6. Lock conflicts
    lines.push("# HELP db_lock_conflicts_total Concurrency and row-lock conflicts observed on wallets and unique constraints.");
    lines.push("# TYPE db_lock_conflicts_total counter");
    for (const type of [
      "hot_wallet_contention",
      "lock_timeout_or_deadlock",
      "unique_constraint_race",
    ] as const) {
      lines.push(
        `db_lock_conflicts_total${formatLabels({ type })} ${
          this.lockConflictsByType.get(type) ?? 0
        }`,
      );
    }

    // 7. Reconciliations & divergences
    lines.push("# HELP wallet_reconciliation_divergences_total Total ledger vs wallet balance divergences detected.");
    lines.push("# TYPE wallet_reconciliation_divergences_total counter");
    lines.push(`wallet_reconciliation_divergences_total ${this.reconciliationsDivergentTotal}`);

    lines.push("# HELP wallet_reconciliations_total Total wallet reconciliation audits executed.");
    lines.push("# TYPE wallet_reconciliations_total counter");
    lines.push(`wallet_reconciliations_total{result="consistent"} ${this.reconciliationsConsistentTotal}`);
    lines.push(`wallet_reconciliations_total{result="divergent"} ${this.reconciliationsDivergentTotal}`);

    // 8. Outbox lag & published
    lines.push("# HELP outbox_published_total Total integration events published from outbox_messages.");
    lines.push("# TYPE outbox_published_total counter");
    lines.push(`outbox_published_total ${this.outboxPublishedTotal}`);

    lines.push("# HELP outbox_pending_messages Current number of unpublished events in outbox_messages.");
    lines.push("# TYPE outbox_pending_messages gauge");
    lines.push(`outbox_pending_messages ${outboxLag.pendingCount}`);

    lines.push("# HELP outbox_oldest_pending_age_ms Age in milliseconds of the oldest unpublished outbox message.");
    lines.push("# TYPE outbox_oldest_pending_age_ms gauge");
    lines.push(`outbox_oldest_pending_age_ms ${round2(outboxLag.oldestPendingAgeMs)}`);

    lines.push("# HELP outbox_oldest_pending_age_seconds Age in seconds of the oldest unpublished outbox message.");
    lines.push("# TYPE outbox_oldest_pending_age_seconds gauge");
    lines.push(`outbox_oldest_pending_age_seconds ${round2(outboxLag.oldestPendingAgeMs / 1000)}`);

    this.appendPrometheusHistogram(
      lines,
      "outbox_delivery_lag_ms",
      "End-to-end outbox publish lag (publishedAt - occurredAt) in milliseconds.",
      this.outboxDeliveryLag,
      {},
    );

    // 9. Processing latency histograms
    lines.push("# HELP wager_processing_duration_ms Processing latency in milliseconds by operation.");
    lines.push("# TYPE wager_processing_duration_ms histogram");
    for (const [operation, hist] of this.latencyHistograms.entries()) {
      this.appendPrometheusHistogramSeriesOnly(lines, "wager_processing_duration_ms", hist, {
        operation,
      });
    }

    return `${lines.join("\n")}\n`;
  }

  private appendPrometheusHistogram(
    lines: string[],
    name: string,
    help: string,
    hist: InternalHistogram,
    baseLabels: Record<string, string>,
  ): void {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} histogram`);
    this.appendPrometheusHistogramSeriesOnly(lines, name, hist, baseLabels);
  }

  private appendPrometheusHistogramSeriesOnly(
    lines: string[],
    name: string,
    hist: InternalHistogram,
    baseLabels: Record<string, string>,
  ): void {
    for (let i = 0; i < DEFAULT_HISTOGRAM_BUCKETS_MS.length; i++) {
      const le = String(DEFAULT_HISTOGRAM_BUCKETS_MS[i]!);
      lines.push(
        `${name}_bucket${formatLabels({ ...baseLabels, le })} ${hist.bucketCounts[i]!}`,
      );
    }
    lines.push(`${name}_bucket${formatLabels({ ...baseLabels, le: "+Inf" })} ${hist.count}`);
    lines.push(`${name}_sum${formatLabels(baseLabels)} ${round2(hist.sum)}`);
    lines.push(`${name}_count${formatLabels(baseLabels)} ${hist.count}`);
  }
}
