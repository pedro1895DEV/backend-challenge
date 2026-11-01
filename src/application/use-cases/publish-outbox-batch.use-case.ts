import {
  DEFAULT_OUTBOX_BACKOFF_POLICY,
  type OutboxBackoffPolicy,
  type OutboxMessage,
} from "../../domain/messaging/outbox-message";
import type { EventPublisherPort } from "../ports/event-publisher.port";
import { NOOP_METRICS_PORT, type MetricsPort } from "../ports/metrics.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";

export interface OutboxPublishEventTrace {
  eventId: string;
  eventType: string;
  correlationId: string | null;
  transactionId: string | null;
  walletId: string;
  providerId: string | null;
  outcome: "published" | "retried";
  attempts: number;
  deliveryLagMs: number;
}

export interface PublishOutboxBatchResult {
  claimed: number;
  published: number;
  retried: number;
  traces?: readonly OutboxPublishEventTrace[];
}

function extractTrace(
  message: OutboxMessage,
  outcome: "published" | "retried",
  deliveryLagMs: number,
): OutboxPublishEventTrace {
  const payload = message.payload;
  const correlationId =
    typeof payload.correlationId === "string" ? payload.correlationId : null;
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : null;

  const transactionId =
    data && typeof data.transactionId === "string" ? data.transactionId : null;
  const walletId =
    data && typeof data.walletId === "string" ? data.walletId : message.aggregateId;
  const providerId =
    data && typeof data.providerId === "string" ? data.providerId : null;

  return {
    eventId: message.id,
    eventType: message.eventType,
    correlationId,
    transactionId,
    walletId,
    providerId,
    outcome,
    attempts: message.attempts,
    deliveryLagMs,
  };
}

/**
 * Claims due unpublished outbox events via `FOR UPDATE SKIP LOCKED`, publishes
 * them through {@link EventPublisherPort}, and persists either `published_at`
 * or exponential-backoff retry state (`attempts`, `next_attempt_at`) (README §11).
 *
 * Safe across `>= 3` concurrent publisher workers:
 *  - `FOR UPDATE SKIP LOCKED` guarantees disjoint batches among active workers.
 *  - If a worker crashes after `publisher.publish` and before SQL `COMMIT`,
 *    PostgreSQL releases the row lock and another worker republishes with the
 *    exact same `eventId` (`OutboxMessage.id`), preserving at-least-once safety.
 */
export class PublishOutboxBatchUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisherPort,
    private readonly backoffPolicy: OutboxBackoffPolicy = DEFAULT_OUTBOX_BACKOFF_POLICY,
    private readonly metrics: MetricsPort = NOOP_METRICS_PORT,
  ) {}

  async executeBatch(
    now: Date = new Date(),
    batchSize = 25,
  ): Promise<PublishOutboxBatchResult> {
    const startedAt = performance.now();

    const committed = await this.unitOfWork.runInTransaction(async (tx) => {
      const batch = await tx.outbox.claimDueBatch(now, batchSize);
      let published = 0;
      let retried = 0;
      const traces: OutboxPublishEventTrace[] = [];

      for (const message of batch) {
        const deliveryLagMs = Math.max(0, now.getTime() - message.occurredAt.getTime());
        try {
          await this.publisher.publish(message);
          message.markPublished(now);
          await tx.outbox.update(message);
          published += 1;
          traces.push(extractTrace(message, "published", deliveryLagMs));
        } catch {
          message.scheduleRetry(now, this.backoffPolicy);
          await tx.outbox.update(message);
          retried += 1;
          traces.push(extractTrace(message, "retried", deliveryLagMs));
        }
      }

      return {
        claimed: batch.length,
        published,
        retried,
        traces,
      };
    });

    this.metrics.recordProcessingDuration(
      "outbox_publish_batch",
      performance.now() - startedAt,
    );

    for (const trace of committed.traces) {
      if (trace.outcome === "published") {
        this.metrics.recordOutboxPublished(trace.deliveryLagMs);
      } else {
        this.metrics.recordRetry("outbox_publisher", "broker_publish_failed");
      }
    }

    return committed;
  }
}
