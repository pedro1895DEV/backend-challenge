import { Global, Module } from "@nestjs/common";
import { METRICS_PORT } from "../../application/ports/metrics.port";
import { RECONCILIATION_OBSERVER } from "../../application/ports/reconciliation-observer.port";
import { LoggingReconciliationObserver } from "./logging-reconciliation-observer";
import { MetricsController } from "./metrics.controller";
import { MetricsRegistry } from "./metrics.registry";
import { StructuredJsonLogger } from "./structured-json-logger";

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: StructuredJsonLogger,
      useFactory: () => new StructuredJsonLogger(),
    },
    MetricsRegistry,
    {
      provide: METRICS_PORT,
      useExisting: MetricsRegistry,
    },
    LoggingReconciliationObserver,
    {
      provide: RECONCILIATION_OBSERVER,
      useExisting: LoggingReconciliationObserver,
    },
  ],
  exports: [
    StructuredJsonLogger,
    MetricsRegistry,
    METRICS_PORT,
    LoggingReconciliationObserver,
    RECONCILIATION_OBSERVER,
  ],
})
export class ObservabilityModule {}
