import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from "../shared/errors";
import { Money } from "../money/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /**
   * Required when `initialBalance > 0`: ids for the internal `OPENING`
   * transaction and its `CREDIT` ledger entry, created atomically with the wallet.
   */
  opening?: { transactionId: string; ledgerEntryId: string };
}

export interface OpenWalletResult {
  wallet: Wallet;
  /** Present only when the initial balance is greater than zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface BalanceMovement {
  money: Money;
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

/**
 * Wallet aggregate root.
 *
 * Invariants:
 *  - balance is never negative;
 *  - every balance change produces exactly one ledger entry (returned by
 *    `debit`/`credit`), so balance and ledger cannot drift apart;
 *  - operation currency must equal wallet currency;
 *  - `version` starts at 1 and increments only when the balance changes
 *    (used for optimistic checks / auditing alongside the row lock).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenWalletResult {
    const { id, playerId, initialBalance, at } = props;

    if (!id || !playerId) {
      throw new InvalidWalletError("Wallet id and playerId are required");
    }
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError("Initial balance must not be negative");
    }

    const wallet = new Wallet(
      id,
      playerId,
      initialBalance.currency,
      initialBalance,
      1,
      new Date(at),
      new Date(at),
    );

    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }

    if (!props.opening) {
      throw new InvalidWalletError(
        "A positive initial balance requires an OPENING transaction and ledger entry",
      );
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.ledgerEntryId,
      walletId: id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: at,
    });

    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  /** Whether a debit of `money` keeps the balance non-negative. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: new Date(this.createdAt),
      updatedAt: new Date(this._updatedAt),
    };
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    if (!movement.money.isPositive()) {
      throw new InvalidWalletError(`Movement amount must be positive, got ${movement.money.toString()}`);
    }

    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);

    // Validates arithmetic and non-negativity before any state is mutated.
    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(movement.at);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
