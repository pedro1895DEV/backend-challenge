import { EntitySchema } from "typeorm";

export interface OutboxMessageEntity {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageEntitySchema = new EntitySchema<OutboxMessageEntity>({
  name: "OutboxMessageEntity",
  tableName: "outbox_messages",
  columns: {
    id: {
      type: "varchar",
      length: 36,
      primary: true,
    },
    aggregateId: {
      type: "varchar",
      length: 36,
      name: "aggregate_id",
    },
    eventType: {
      type: "varchar",
      length: 128,
      name: "event_type",
    },
    payload: {
      type: "jsonb",
    },
    occurredAt: {
      type: "timestamptz",
      name: "occurred_at",
    },
    attempts: {
      type: "int",
      default: 0,
    },
    nextAttemptAt: {
      type: "timestamptz",
      nullable: true,
      name: "next_attempt_at",
    },
    publishedAt: {
      type: "timestamptz",
      nullable: true,
      name: "published_at",
    },
  },
});
