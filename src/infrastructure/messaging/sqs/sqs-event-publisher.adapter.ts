import { Inject, Injectable } from "@nestjs/common";
import type { EventPublisherPort } from "../../../application/ports/event-publisher.port";
import type { AppConfig } from "../../../config/app-config";
import { APP_CONFIG } from "../../../config/config.module";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { SqsService } from "./sqs.service";

/**
 * Publishes committed Transactional Outbox events to the `wager-events.fifo`
 * SQS FIFO queue (README §11).
 *
 *  - `MessageGroupId` = `aggregateId` (`walletId`), preserving per-wallet event order.
 *  - `MessageDeduplicationId` = `OutboxMessage.id` (`eventId`), making duplicate
 *    publications after a pre-commit worker crash idempotent at both broker and
 *    consumer levels.
 */
@Injectable()
export class SqsEventPublisherAdapter implements EventPublisherPort {
  constructor(
    private readonly sqsService: SqsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqsService.sendFifoMessage(this.config.sqs.outboxQueueName, {
      body: JSON.stringify(message.payload),
      messageGroupId: message.aggregateId,
      messageDeduplicationId: message.id,
      attributes: {
        EventType: message.eventType,
        EventId: message.id,
        AggregateId: message.aggregateId,
      },
    });
  }
}
