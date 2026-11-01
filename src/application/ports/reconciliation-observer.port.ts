import type { MoneyProps } from "../../domain/money/money";

export const RECONCILIATION_OBSERVER = Symbol("RECONCILIATION_OBSERVER");

export interface ReconciliationDivergenceEvent {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly checkedEntries: number;
  readonly correlationId?: string;
}

/**
 * Port invoked whenever wallet reconciliation detects a mismatch between the
 * materialized wallet balance and the reconstructed ledger sum (README §9).
 */
export interface ReconciliationObserver {
  onDivergenceDetected(event: ReconciliationDivergenceEvent): void;
}
