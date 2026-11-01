import { InvalidLedgerEntryError } from "../shared/errors";
import { Money } from "../money/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Immutable, append-only ledger line.
 *
 * Immutability is structural: every field is `readonly`, the instance is frozen
 * and there are no transition methods. `create` validates the entry arithmetic;
 * `rehydrate` trusts persisted state (also guarded by DB CHECK constraints).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;

    if (!props.id || !props.walletId || !props.transactionId) {
      throw new InvalidLedgerEntryError("id, walletId and transactionId are required");
    }
    if (!Object.values(LedgerDirection).includes(props.direction)) {
      throw new InvalidLedgerEntryError(`Unknown ledger direction "${String(props.direction)}"`);
    }
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError("Entry amount and balances must share the same currency");
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError(`Entry amount must be positive, got ${money.toString()}`);
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("Balances must never be negative");
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      money,
      balanceBefore,
      balanceAfter,
      new Date(props.createdAt),
    );

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced entry: ${balanceBefore.toString()} ${props.direction} ${money.toString()} ≠ ${balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  /** `balanceBefore ± money === balanceAfter`. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect of this entry on the balance (credit +, debit −). Used by reconciliation. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
