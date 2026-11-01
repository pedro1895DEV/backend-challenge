import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export const OUTBOX_REPOSITORY = Symbol("OUTBOX_REPOSITORY");

export interface OutboxLagStats {
  pendingCount: number;
  oldestPendingAgeMs: number;
}

export interface OutboxRepository {
  findById(id: string): Promise<OutboxMessage | null>;
  findByAggregateId(aggregateId: string): Promise<OutboxMessage[]>;
  insert(message: OutboxMessage): Promise<void>;
  insertMany(messages: readonly OutboxMessage[]): Promise<void>;
  update(message: OutboxMessage): Promise<void>;
  /**
   * Claims due unpublished outbox rows using `FOR UPDATE SKIP LOCKED` inside an
   * active SQL transaction so multiple publisher workers can run concurrently
   * without blocking or duplicating work on the same batch.
   */
  claimDueBatch(now: Date, limit?: number): Promise<OutboxMessage[]>;
  countPending(): Promise<number>;
  getLagStats(now?: Date): Promise<OutboxLagStats>;
}
