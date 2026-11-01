import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/shared/errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  describe("parsing and scale", () => {
    it.each([
      ["25.00", "25.00"],
      ["25", "25.00"],
      ["25.5", "25.50"],
      ["0", "0.00"],
      ["0.01", "0.01"],
      ["99999999999999999.99", "99999999999999999.99"],
    ])("accepts %p and serializes with fixed scale 2 as %p", (input, expected) => {
      expect(brl(input).amount).toBe(expected);
      expect(brl(input).toJSON()).toEqual({ amount: expected, currency: "BRL" });
    });

    it.each([
      ["empty string", ""],
      ["NaN", "NaN"],
      ["Infinity", "Infinity"],
      ["-Infinity", "-Infinity"],
      ["scientific notation", "1e3"],
      ["scientific notation with decimals", "2.5E2"],
      ["more than 2 decimals", "10.001"],
      ["trailing dot", "10."],
      ["leading dot", ".50"],
      ["leading zeros", "010.00"],
      ["explicit plus sign", "+10.00"],
      ["whitespace", " 10.00"],
      ["comma decimal separator", "10,00"],
      ["thousand separators", "1,000.00"],
      ["hex", "0x10"],
      ["too many integer digits", "123456789012345678.00"],
    ])("rejects %s (%p)", (_label, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it("rejects numbers passed where a decimal string is required", () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(
        InvalidMoneyError,
      );
    });

    it("rejects negative values in input contracts", () => {
      expect(() => brl("-1.00")).toThrow(/negative/);
    });

    it("allows negative values through fromSigned (internal use)", () => {
      expect(Money.fromSigned({ amount: "-1.50", currency: "BRL" }).amount).toBe("-1.50");
    });

    it.each(["brl", "BR", "BRLL", "", "12A"])("rejects invalid currency %p", (currency) => {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
    });
  });

  describe("arithmetic", () => {
    it("is exact where floating point is not (0.10 + 0.20 = 0.30)", () => {
      expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
    });

    it("adds and subtracts", () => {
      expect(brl("100.00").subtract(brl("80.00")).amount).toBe("20.00");
      expect(brl("19.99").add(brl("0.01")).amount).toBe("20.00");
    });

    it("can go negative through subtraction and negate", () => {
      expect(brl("1.00").subtract(brl("2.50")).amount).toBe("-1.50");
      expect(brl("2.50").negate().amount).toBe("-2.50");
      expect(brl("2.50").negate().negate().equals(brl("2.50"))).toBe(true);
    });

    it("handles large values without precision loss", () => {
      const big = brl("99999999999999999.99");
      expect(big.subtract(brl("0.01")).amount).toBe("99999999999999999.98");
    });

    it("is immutable: operations return new instances", () => {
      const a = brl("10.00");
      const b = a.add(brl("5.00"));
      expect(a.amount).toBe("10.00");
      expect(b).not.toBe(a);
      expect(Object.isFrozen(a)).toBe(true);
    });
  });

  describe("comparisons", () => {
    it("reports sign", () => {
      expect(Money.zero("BRL").isZero()).toBe(true);
      expect(brl("0.01").isPositive()).toBe(true);
      expect(brl("0.01").negate().isNegative()).toBe(true);
    });

    it("compares values", () => {
      expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
      expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
    });

    it("treats different currencies as not equal", () => {
      expect(brl("1.00").equals(Money.from({ amount: "1.00", currency: "USD" }))).toBe(false);
    });
  });

  describe("currency conflicts", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });

    it.each([
      ["add", () => brl("1.00").add(usd)],
      ["subtract", () => brl("1.00").subtract(usd)],
      ["isLessThan", () => brl("1.00").isLessThan(usd)],
    ])("%s between different currencies throws", (_op, operation) => {
      expect(operation).toThrow(CurrencyMismatchError);
    });
  });

  it("serializes to JSON as decimal string, never a number", () => {
    expect(JSON.stringify({ money: brl("25") })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(brl("25").toString()).toBe("25.00 BRL");
  });
});
