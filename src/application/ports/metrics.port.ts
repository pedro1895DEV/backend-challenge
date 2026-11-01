export const METRICS_PORT = Symbol("METRICS_PORT");

export type TransactionChannel = "http" | "sqs" | "pending_reference_worker";

export type DuplicateSource = "http_idempotency" | "sqs_inbox" | "sqs_idempotency";

export type RetryComponent = "sqs_consumer" | "outbox_publisher" | "pending_reference";

export type DlqCategory = "PERMANENT" | "MAX_RETRIES_EXCEEDED";

export type LockConflictType =
  | "hot_wallet_contention"
  | "lock_timeout_or_deadlock"
  | "unique_constraint_race";

export type OperationLatencyName =
  | "http_wager"
  | "sqs_wager"
  | "outbox_publish_batch"
  | "pending_reference_batch"
  | "wallet_reconciliation"
  | "wallet_lock_acquire";

export interface TransactionOutcomeMetric {
  status: string;
  kind: string;
  channel: TransactionChannel;
  failureCode?: string;
}

/**
 * Pure application port for operational metrics (README §12).
 *
 * Strictly forbids monetary amounts (`number` or financial payloads) — tracks
 * only event counts, statuses, lock contention, outbox lag, and durations.
 */
export interface MetricsPort {
  recordTransactionOutcome(outcome: TransactionOutcomeMetric): void;
  recordDuplicateDetected(source: DuplicateSource): void;
  recordRetry(component: RetryComponent, reason: string): void;
  recordDlqMessage(category: DlqCategory, reason: string): void;
  recordLockConflict(type: LockConflictType): void;
  recordOutboxPublished(deliveryLagMs: number): void;
  recordProcessingDuration(operation: OperationLatencyName, durationMs: number): void;
  recordReconciliation(consistent: boolean): void;
}

export const NOOP_METRICS_PORT: MetricsPort = Object.freeze({
  recordTransactionOutcome(): void {},
  recordDuplicateDetected(): void {},
  recordRetry(): void {},
  recordDlqMessage(): void {},
  recordLockConflict(): void {},
  recordOutboxPublished(): void {},
  recordProcessingDuration(): void {},
  recordReconciliation(): void {},
});
