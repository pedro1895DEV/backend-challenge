import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export const EVENT_PUBLISHER_PORT = Symbol("EVENT_PUBLISHER_PORT");

/**
 * Outbound port used by the Transactional Outbox publisher worker to deliver
 * committed integration events to the external message broker (README §11).
 */
export interface EventPublisherPort {
  publish(message: OutboxMessage): Promise<void>;
}
