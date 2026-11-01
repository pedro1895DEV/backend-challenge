import type { MoneyProps } from "../../domain/money/money";
import { WalletNotFoundError } from "../errors/application-errors";
import { NOOP_METRICS_PORT, type MetricsPort } from "../ports/metrics.port";
import type { ReconciliationObserver } from "../ports/reconciliation-observer.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import { requireNonEmptyString } from "../shared/validation";

export interface ReconcileWalletInput {
  walletId: unknown;
  correlationId?: string;
}

export interface ReconcileWalletOutput {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Reconciles the materialized wallet balance against the sum of its ledger
 * entries inside a `REPEATABLE READ` snapshot (README §9).
 *
 * Divergences are NEVER silently auto-corrected: they are logged, recorded in
 * metrics via {@link ReconciliationObserver} / {@link MetricsPort}, and flagged
 * in the response.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly observer: ReconciliationObserver,
    private readonly metrics: MetricsPort = NOOP_METRICS_PORT,
  ) {}

  async execute(input: ReconcileWalletInput): Promise<ReconcileWalletOutput> {
    const startedAt = performance.now();
    const walletId = requireNonEmptyString(input.walletId, "walletId", 64);

    const snapshot = await this.unitOfWork.runReadOnlySnapshot(async (tx) => {
      const wallet = await tx.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      const { balance: calculatedBalance, count: checkedEntries } =
        await tx.ledger.calculateBalance(wallet.id, wallet.currency);

      const difference = wallet.balance.subtract(calculatedBalance);
      const consistent = difference.isZero();

      return {
        walletId: wallet.id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries,
      };
    });

    if (snapshot.consistent) {
      this.metrics.recordReconciliation(true);
    } else {
      this.observer.onDivergenceDetected({
        walletId: snapshot.walletId,
        storedBalance: snapshot.storedBalance,
        calculatedBalance: snapshot.calculatedBalance,
        difference: snapshot.difference,
        checkedEntries: snapshot.checkedEntries,
        correlationId: input.correlationId,
      });
    }

    this.metrics.recordProcessingDuration(
      "wallet_reconciliation",
      performance.now() - startedAt,
    );

    return snapshot;
  }
}
