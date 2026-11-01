import { Module } from "@nestjs/common";
import {
  EVENT_PUBLISHER_PORT,
  type EventPublisherPort,
} from "../../application/ports/event-publisher.port";
import {
  INBOX_REPOSITORY,
  type InboxRepository,
} from "../../application/ports/inbox.repository";
import { METRICS_PORT, type MetricsPort } from "../../application/ports/metrics.port";
import { UNIT_OF_WORK, type UnitOfWork } from "../../application/ports/unit-of-work.port";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "../../application/ports/wager-transaction.repository";
import {
  ConsumeWagerMessageUseCase,
  DEFAULT_SQS_CONSUMER_RETRY_POLICY,
  SQS_WAGER_CONSUMER_NAME,
} from "../../application/use-cases/consume-wager-message.use-case";
import { ProcessPendingReferencesUseCase } from "../../application/use-cases/process-pending-references.use-case";
import type { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { PublishOutboxBatchUseCase } from "../../application/use-cases/publish-outbox-batch.use-case";
import { DEFAULT_OUTBOX_BACKOFF_POLICY } from "../../domain/messaging/outbox-message";
import { HttpApiModule } from "../http/http.module";
import {
  CONSUME_WAGER_MESSAGE_USE_CASE,
  PROCESS_PENDING_REFERENCES_USE_CASE,
  PROCESS_WAGER_TRANSACTION_USE_CASE,
  PUBLISH_OUTBOX_BATCH_USE_CASE,
} from "../http/use-case.tokens";
import { OutboxPublisherWorker } from "./outbox-publisher.worker";
import { PendingReferenceWorker } from "./pending-reference.worker";
import { SqsWagerConsumerWorker } from "./sqs-wager-consumer.worker";

@Module({
  imports: [HttpApiModule],
  providers: [
    {
      provide: PROCESS_PENDING_REFERENCES_USE_CASE,
      useFactory: (
        uow: UnitOfWork,
        txRepo: WagerTransactionRepository,
        metrics: MetricsPort,
      ) => new ProcessPendingReferencesUseCase(uow, txRepo, undefined, metrics),
      inject: [UNIT_OF_WORK, WAGER_TRANSACTION_REPOSITORY, METRICS_PORT],
    },
    {
      provide: CONSUME_WAGER_MESSAGE_USE_CASE,
      useFactory: (
        uow: UnitOfWork,
        inboxRepo: InboxRepository,
        processWager: ProcessWagerTransactionUseCase,
        metrics: MetricsPort,
      ) =>
        new ConsumeWagerMessageUseCase(
          uow,
          inboxRepo,
          processWager,
          DEFAULT_SQS_CONSUMER_RETRY_POLICY,
          SQS_WAGER_CONSUMER_NAME,
          metrics,
        ),
      inject: [
        UNIT_OF_WORK,
        INBOX_REPOSITORY,
        PROCESS_WAGER_TRANSACTION_USE_CASE,
        METRICS_PORT,
      ],
    },
    {
      provide: PUBLISH_OUTBOX_BATCH_USE_CASE,
      useFactory: (
        uow: UnitOfWork,
        publisher: EventPublisherPort,
        metrics: MetricsPort,
      ) =>
        new PublishOutboxBatchUseCase(
          uow,
          publisher,
          DEFAULT_OUTBOX_BACKOFF_POLICY,
          metrics,
        ),
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER_PORT, METRICS_PORT],
    },
    PendingReferenceWorker,
    OutboxPublisherWorker,
    SqsWagerConsumerWorker,
  ],
  exports: [
    PROCESS_PENDING_REFERENCES_USE_CASE,
    CONSUME_WAGER_MESSAGE_USE_CASE,
    PUBLISH_OUTBOX_BATCH_USE_CASE,
    PendingReferenceWorker,
    OutboxPublisherWorker,
    SqsWagerConsumerWorker,
  ],
})
export class WorkersModule {}
