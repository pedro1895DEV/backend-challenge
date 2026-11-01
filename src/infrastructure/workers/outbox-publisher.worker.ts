import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { PublishOutboxBatchUseCase } from "../../application/use-cases/publish-outbox-batch.use-case";
import { PUBLISH_OUTBOX_BATCH_USE_CASE } from "../http/use-case.tokens";

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("OutboxPublisherWorker");
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlightTick: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @Inject(PUBLISH_OUTBOX_BATCH_USE_CASE)
    private readonly useCase: PublishOutboxBatchUseCase,
  ) {}

  onApplicationBootstrap(): void {
    const rawInterval = process.env.OUTBOX_POLL_INTERVAL_MS?.trim();
    const intervalMs = rawInterval && /^\d+$/.test(rawInterval) ? Number(rawInterval) : 250;
    if (intervalMs <= 0) return;

    this.stopping = false;
    this.timer = setInterval(() => {
      if (this.stopping || this.inFlightTick) return;
      this.inFlightTick = this.runTick().finally(() => {
        this.inFlightTick = null;
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlightTick) {
      await this.inFlightTick;
    }
  }

  async publishOnce(batchSize = 25): Promise<{ claimed: number; published: number; retried: number }> {
    return this.useCase.executeBatch(new Date(), batchSize);
  }

  private async runTick(): Promise<void> {
    try {
      const batchSize = 25;
      // Drain up to 4 consecutive full batches per tick when under heavy load
      for (let round = 0; round < 4 && !this.stopping; round++) {
        const result = await this.useCase.executeBatch(new Date(), batchSize);
        if (result.traces) {
          for (const trace of result.traces) {
            const payload = JSON.stringify({
              event:
                trace.outcome === "published"
                  ? "outbox_event_published"
                  : "outbox_event_retry_scheduled",
              correlationId: trace.correlationId,
              messageId: trace.eventId,
              transactionId: trace.transactionId,
              walletId: trace.walletId,
              providerId: trace.providerId,
              eventType: trace.eventType,
              attempts: trace.attempts,
              deliveryLagMs: trace.deliveryLagMs,
            });
            if (trace.outcome === "published") {
              this.logger.log(payload);
            } else {
              this.logger.warn(payload);
            }
          }
        }
        if (result.claimed < batchSize) break;
      }
    } catch (error) {
      if (this.stopping) return;
      this.logger.error(
        JSON.stringify({
          event: "outbox_publish_tick_error",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
