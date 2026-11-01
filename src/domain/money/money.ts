import { CurrencyMismatchError, InvalidMoneyError } from "../shared/errors";

/** Wire / persistence representation of money. Amount is always a decimal string. */
export interface MoneyProps {
  amount: string; // e.g. "25.00"
  currency: string; // ISO-4217, e.g. "BRL"
}

const SCALE = 2;
const MINOR_UNITS_PER_UNIT = 10n ** BigInt(SCALE);

/**
 * Max integer digits accepted. Matches the `NUMERIC(19,2)` column used for
 * persistence (19 total digits − 2 decimals), so no valid Money can overflow it.
 */
const MAX_INTEGER_DIGITS = 17;

/**
 * Plain decimal only: optional sign, integer part without leading zeros,
 * optional 1–2 decimal digits. Rejects "", "NaN", "Infinity", "1e3", "1.", ".5",
 * "01", " 1", "1.234", "+1".
 */
const AMOUNT_PATTERN = new RegExp(
  `^(-)?(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})(?:\\.(\\d{1,${SCALE}}))?$`,
);

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value object.
 *
 * Internally stored as an integer number of minor units (cents) in a `bigint`:
 * exact arithmetic, no floating point anywhere. Since inputs with more than two
 * decimals are rejected and the domain only adds/subtracts, no rounding is ever
 * needed — and therefore none is silently performed.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Factory for **input contracts** (API, queue, wallet opening).
   * Rejects negative amounts in addition to malformed input.
   */
  static from(props: MoneyProps): Money {
    const money = Money.parse(props);
    if (money.isNegative()) {
      throw new InvalidMoneyError(`Amount must not be negative, got "${props.amount}"`);
    }
    return money;
  }

  /**
   * Factory for internal values that may legitimately be negative
   * (e.g. reconciliation differences). Same format rules as {@link from}.
   */
  static fromSigned(props: MoneyProps): Money {
    return Money.parse(props);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const units = abs / MINOR_UNITS_PER_UNIT;
    const cents = (abs % MINOR_UNITS_PER_UNIT).toString().padStart(SCALE, "0");
    return `${negative ? "-" : ""}${units}.${cents}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Value equality. Different currencies are simply not equal (no throw). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parse(props: MoneyProps): Money {
    const currency = Money.assertCurrency(props?.currency);
    const amount: unknown = props?.amount;

    // Guard against `number` sneaking in through untyped JSON.
    if (typeof amount !== "string") {
      throw new InvalidMoneyError(`Amount must be a decimal string, got ${typeof amount}`);
    }

    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        `Invalid amount "${amount}": expected a plain decimal with at most ${SCALE} decimal places`,
      );
    }

    const [, sign, integerPart = "0", fractionPart = ""] = match;
    const minor =
      BigInt(integerPart) * MINOR_UNITS_PER_UNIT + BigInt(fractionPart.padEnd(SCALE, "0"));

    return new Money(sign ? -minor : minor, currency);
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid currency "${String(currency)}": expected ISO-4217 code (3 uppercase letters)`,
      );
    }
    return currency;
  }
}
