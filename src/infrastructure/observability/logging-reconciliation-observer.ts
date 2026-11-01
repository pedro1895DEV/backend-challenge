import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  METRICS_PORT,
  NOOP_METRICS_PORT,
  type MetricsPort,
} from "../../application/ports/metrics.port";
import type {
  ReconciliationDivergenceEvent,
  ReconciliationObserver,
} from "../../application/ports/reconciliation-observer.port";

/**
 * Logs reconciliation divergences as structured JSON (without dumping full
 * sensitive payloads or monetary amounts — README §12) and increments both
 * an in-process counter and the central {@link MetricsPort}.
 */
@Injectable()
export class LoggingReconciliationObserver implements ReconciliationObserver {
  private readonly logger = new Logger("WalletReconciliation");
  private readonly metrics: MetricsPort;
  private _divergencesTotal = 0;

  constructor(@Optional() @Inject(METRICS_PORT) metrics?: MetricsPort) {
    this.metrics = metrics ?? NOOP_METRICS_PORT;
  }

  get divergencesTotal(): number {
    return this._divergencesTotal;
  }

  onDivergenceDetected(event: ReconciliationDivergenceEvent): void {
    this._divergencesTotal += 1;
    this.metrics.recordReconciliation(false);

    this.logger.error(
      JSON.stringify({
        event: "wallet_reconciliation_divergence",
        correlationId: event.correlationId ?? null,
        messageId: null,
        transactionId: null,
        walletId: event.walletId,
        providerId: null,
        currency: event.difference.currency,
        checkedEntries: event.checkedEntries,
        consistent: false,
        divergencesTotal: this._divergencesTotal,
      }),
    );
  }
}
