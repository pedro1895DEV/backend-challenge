import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { ProcessPendingReferencesUseCase } from "../../application/use-cases/process-pending-references.use-case";
import { PROCESS_PENDING_REFERENCES_USE_CASE } from "../http/use-case.tokens";

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("PendingReferenceWorker");
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlightTick: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @Inject(PROCESS_PENDING_REFERENCES_USE_CASE)
    private readonly useCase: ProcessPendingReferencesUseCase,
  ) {}

  onApplicationBootstrap(): void {
    const rawInterval = process.env.PENDING_REFERENCE_POLL_INTERVAL_MS?.trim();
    const intervalMs = rawInterval && /^\d+$/.test(rawInterval) ? Number(rawInterval) : 250;
    if (intervalMs <= 0) return;

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

  private async runTick(): Promise<void> {
    try {
      const result = await this.useCase.executeBatch(new Date(), 50);
      if (result.traces) {
        for (const trace of result.traces) {
          const payload = JSON.stringify({
            event:
              trace.outcome === "rescheduled"
                ? "pending_reference_retry_scheduled"
                : "pending_reference_settled",
            correlationId: null,
            messageId: null,
            transactionId: trace.transactionId,
            walletId: trace.walletId,
            providerId: trace.providerId,
            kind: trace.kind,
            status: trace.status,
            failureCode: trace.failureCode ?? null,
            attempts: trace.attempts,
          });
          if (trace.outcome === "rescheduled") {
            this.logger.warn(payload);
          } else {
            this.logger.log(payload);
          }
        }
      }
    } catch (error) {
      if (this.stopping) return;
      this.logger.error(
        JSON.stringify({
          event: "pending_references_tick_error",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
