import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../shared/errors";
import type { Wallet } from "../wallet/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { BusinessFailureCode } from "./failure-code";
import { DEFAULT_REFERENCE_RETRY_POLICY, type ReferenceRetryPolicy } from "./reference-retry-policy";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";

export interface SettleWagerInput {
  /** Wallet already loaded under a row lock by the caller. */
  wallet: Wallet;
  /** Transaction in PENDING or PENDING_REFERENCE. */
  transaction: WagerTransaction;
  /** Resolved by `(providerId, referenceExternalTransactionId)`; undefined if not found. */
  reference: WagerTransaction | undefined;
  /** Whether `reference` was already reverted by a PROCESSED REFUND/ROLLBACK. */
  referenceAlreadyReversed: boolean;
  /** Id to use if a ledger entry is produced. */
  ledgerEntryId: string;
  now: Date;
  retryPolicy?: ReferenceRetryPolicy;
}

export interface SettlementResult {
  /** Same instance as the input transaction, after its state transition. */
  transaction: WagerTransaction;
  /** Present only when the balance changed. */
  ledgerEntry: WalletLedgerEntry | undefined;
}

/** Which referenced kinds each operation may target (README §7 rule 3). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

/**
 * Domain service that applies a wager transaction to a wallet (README §7).
 *
 * Pure and deterministic: it only mutates the given aggregates. Persistence,
 * locking and outbox writes are the caller's responsibility, inside a single
 * SQL transaction.
 *
 * Interpretations adopted (documented in ARCHITECTURE.md):
 *  - Only REFUND/ROLLBACK *wait* for references. A WIN/LOSS reference is
 *    optional: if found and PROCESSED it is validated and linked; if missing
 *    or not processed the transaction proceeds unlinked.
 *  - A transaction can be reverted at most once overall (by a REFUND *or* a
 *    ROLLBACK). This is stricter than "once per operation type" and prevents
 *    a BET from being credited back twice.
 */
export function settleWagerTransaction(input: SettleWagerInput): SettlementResult {
  const { wallet, transaction: tx, now } = input;
  const policy = input.retryPolicy ?? DEFAULT_REFERENCE_RETRY_POLICY;

  if (tx.isTerminal()) {
    throw new InvalidTransactionStateError(tx.id, tx.status, "settlement");
  }
  if (tx.walletId !== wallet.id) {
    throw new InvalidWagerTransactionError(
      `Transaction ${tx.id} targets wallet ${tx.walletId}, but wallet ${wallet.id} was provided`,
    );
  }

  const reject = (code: BusinessFailureCode): SettlementResult => {
    tx.reject(code, { at: now, observedBalance: wallet.balance });
    return { transaction: tx, ledgerEntry: undefined };
  };

  if (tx.playerId !== wallet.playerId) return reject(BusinessFailureCode.PlayerWalletMismatch);
  if (tx.money.currency !== wallet.currency) return reject(BusinessFailureCode.CurrencyMismatch);

  // ---- reference resolution
  let linkedReference: WagerTransaction | undefined;

  if (tx.referenceExternalTransactionId !== undefined) {
    const { reference } = input;
    const referenceIsSettled = reference?.status === WagerTransactionStatus.Processed;
    const referenceIsInFlight =
      reference === undefined ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference;

    if (tx.requiresReference()) {
      if (referenceIsInFlight) {
        if (tx.hasExhaustedReferenceAttempts(policy)) {
          return reject(BusinessFailureCode.ReferenceNotFound);
        }
        tx.markPendingReference(now, policy, wallet.balance);
        return { transaction: tx, ledgerEntry: undefined };
      }
      if (!referenceIsSettled) return reject(BusinessFailureCode.ReferenceNotProcessed);
    }

    if (reference && referenceIsSettled) {
      const violation = validateReference(tx, reference, input.referenceAlreadyReversed);
      if (violation) return reject(violation);
      linkedReference = reference;
    }
  }

  // ---- outcome without balance effect
  if (!tx.affectsBalance()) {
    tx.markProcessed({
      referenceTransactionId: linkedReference?.id,
      balanceAfter: wallet.balance,
      at: now,
    });
    return { transaction: tx, ledgerEntry: undefined };
  }

  // ---- balance movement
  const direction = tx.ledgerDirectionFor(linkedReference);
  const movement = {
    money: tx.money,
    transactionId: tx.id,
    ledgerEntryId: input.ledgerEntryId,
    at: now,
  };

  let ledgerEntry: WalletLedgerEntry;
  if (direction === LedgerDirection.Debit) {
    if (!wallet.canDebit(tx.money)) {
      return reject(
        tx.kind === WagerTransactionKind.Bet
          ? BusinessFailureCode.InsufficientFunds
          : BusinessFailureCode.ReversalInsufficientFunds,
      );
    }
    ledgerEntry = wallet.debit(movement);
  } else {
    ledgerEntry = wallet.credit(movement);
  }

  tx.markProcessed({
    referenceTransactionId: linkedReference?.id,
    balanceAfter: wallet.balance,
    at: now,
  });
  return { transaction: tx, ledgerEntry };
}

function validateReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): BusinessFailureCode | undefined {
  const sameContext =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameContext) return BusinessFailureCode.ReferenceMismatch;

  const allowedKinds = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
  if (!allowedKinds.includes(reference.kind)) return BusinessFailureCode.ReferenceKindNotAllowed;

  if (tx.requiresReference()) {
    if (!reference.money.equals(tx.money)) return BusinessFailureCode.ReferenceAmountMismatch;
    if (alreadyReversed) return BusinessFailureCode.ReferenceAlreadyReversed;
  }
  return undefined;
}
