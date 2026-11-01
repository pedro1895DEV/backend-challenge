import { OutboxMessage } from "../../../../domain/messaging/outbox-message";
import type { OutboxMessageEntity } from "../schemas/outbox-message.schema";

export class OutboxMessageMapper {
  static toDomain(entity: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: entity.id,
      aggregateId: entity.aggregateId,
      eventType: entity.eventType,
      payload: entity.payload,
      occurredAt: entity.occurredAt,
      attempts: entity.attempts,
      nextAttemptAt: entity.nextAttemptAt ?? undefined,
      publishedAt: entity.publishedAt ?? undefined,
    });
  }

  static toEntity(message: OutboxMessage): OutboxMessageEntity {
    const state = message.toState();
    return {
      id: state.id,
      aggregateId: state.aggregateId,
      eventType: state.eventType,
      payload: { ...state.payload },
      occurredAt: state.occurredAt,
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt ?? null,
      publishedAt: state.publishedAt ?? null,
    };
  }
}
