import type { InboxMessage } from "../../domain/messaging/inbox-message";

export const INBOX_REPOSITORY = Symbol("INBOX_REPOSITORY");

export interface InboxRepository {
  findByConsumerAndMessageId(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null>;
  insert(message: InboxMessage): Promise<void>;
  update(message: InboxMessage): Promise<void>;
}
