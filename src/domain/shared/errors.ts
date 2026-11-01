/**
 * Base class for every domain error.
 *
 * Domain errors signal violated invariants or programming errors inside the
 * domain model. Expected business outcomes (e.g. insufficient funds on a BET)
 * are NOT thrown — they become a `REJECTED` transaction with a failure code.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed monetary input: NaN, Infinity, scientific notation, >2 decimals, etc. */
export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
  constructor(message: string) {
    super(message);
  }
}

/** Arithmetic or comparison between different currencies. */
export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/** A debit would make the wallet balance negative. Guards the aggregate invariant. */
export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
  constructor(walletId: string) {
    super(`Wallet ${walletId} has insufficient funds for this debit`);
  }
}

export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";
  constructor(message: string) {
    super(message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
  constructor(message: string) {
    super(message);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
  constructor(message: string) {
    super(message);
  }
}

/** Attempt to transition a transaction out of a terminal (or otherwise disallowed) state. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
  constructor(transactionId: string, from: string, to: string) {
    super(`Transaction ${transactionId} cannot transition from ${from} to ${to}`);
  }
}

export class InvalidInboxMessageError extends DomainError {
  readonly code = "INVALID_INBOX_MESSAGE";
  constructor(message: string) {
    super(message);
  }
}

export class InvalidOutboxMessageError extends DomainError {
  readonly code = "INVALID_OUTBOX_MESSAGE";
  constructor(message: string) {
    super(message);
  }
}
