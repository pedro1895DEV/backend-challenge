import { Global, Module } from "@nestjs/common";
import { EVENT_PUBLISHER_PORT } from "../../../application/ports/event-publisher.port";
import { SqsEventPublisherAdapter } from "./sqs-event-publisher.adapter";
import { SqsService } from "./sqs.service";

@Global()
@Module({
  providers: [
    SqsService,
    SqsEventPublisherAdapter,
    {
      provide: EVENT_PUBLISHER_PORT,
      useExisting: SqsEventPublisherAdapter,
    },
  ],
  exports: [SqsService, SqsEventPublisherAdapter, EVENT_PUBLISHER_PORT],
})
export class SqsModule {}
