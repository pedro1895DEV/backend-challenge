import { InboxMessage } from "../../../../domain/messaging/inbox-message";
import type { InboxMessageEntity } from "../schemas/inbox-message.schema";

export class InboxMessageMapper {
  static toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      processedAt: entity.processedAt ?? undefined,
    });
  }

  static toEntity(message: InboxMessage): InboxMessageEntity {
    const state = message.toState();
    return {
      consumerName: state.consumerName,
      messageId: state.messageId,
      payloadHash: state.payloadHash,
      receivedAt: state.receivedAt,
      processedAt: state.processedAt ?? null,
    };
  }
}
