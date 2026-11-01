import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidWalletError,
} from "../../../src/domain/shared/errors";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../../src/domain/wallet/wallet-ledger-entry";
import { NOW, brl, nextId, openWallet } from "./fixtures";

const movement = (amount: string) => ({
  money: brl(amount),
  transactionId: nextId("tx"),
  ledgerEntryId: nextId("entry"),
  at: NOW,
});

/** Reconstructs the balance from the ledger — the global invariant of README §13. */
const replay = (entries: WalletLedgerEntry[]): Money =>
  entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero("BRL"));

describe("Wallet", () => {
  describe("open", () => {
    it("starts at version 1 with an OPENING credit entry when the balance is positive", () => {
      const { wallet, openingEntry } = Wallet.open({
        id: "w1",
        playerId: "p1",
        initialBalance: brl("1000.00"),
        at: NOW,
        opening: { transactionId: "opening-tx", ledgerEntryId: "e1" },
      });

      expect(wallet.version).toBe(1);
      expect(wallet.balance.amount).toBe("1000.00");
      expect(wallet.currency).toBe("BRL");
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.balanceBefore.amount).toBe("0.00");
      expect(openingEntry?.balanceAfter.amount).toBe("1000.00");
      expect(openingEntry?.transactionId).toBe("opening-tx");
    });

    it("produces no ledger entry for a zero initial balance", () => {
      const { wallet, openingEntry } = Wallet.open({
        id: "w1",
        playerId: "p1",
        initialBalance: Money.zero("BRL"),
        at: NOW,
      });
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeUndefined();
    });

    it("requires OPENING ids for a positive initial balance", () => {
      expect(() =>
        Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("1.00"), at: NOW }),
      ).toThrow(InvalidWalletError);
    });

    it("rejects a negative initial balance", () => {
      expect(() =>
        Wallet.open({
          id: "w1",
          playerId: "p1",
          initialBalance: Money.fromSigned({ amount: "-1.00", currency: "BRL" }),
          at: NOW,
        }),
      ).toThrow(InvalidWalletError);
    });
  });

  describe("debit / credit", () => {
    it("debits, returns a balanced ledger entry and increments version", () => {
      const wallet = openWallet("100.00");
      const entry = wallet.debit(movement("80.00"));

      expect(wallet.balance.amount).toBe("20.00");
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.amount).toBe("100.00");
      expect(entry.balanceAfter.amount).toBe("20.00");
      expect(entry.isBalanced()).toBe(true);
    });

    it("credits and increments version", () => {
      const wallet = openWallet("100.00");
      const entry = wallet.credit(movement("50.00"));
      expect(wallet.balance.amount).toBe("150.00");
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
    });

    it("allows debiting the entire balance down to zero", () => {
      const wallet = openWallet("100.00");
      wallet.debit(movement("100.00"));
      expect(wallet.balance.isZero()).toBe(true);
    });

    it("never goes negative and leaves state untouched on failure", () => {
      const wallet = openWallet("100.00");
      expect(() => wallet.debit(movement("100.01"))).toThrow(InsufficientFundsError);
      expect(wallet.balance.amount).toBe("100.00");
      expect(wallet.version).toBe(1);
    });

    it("rejects operations in another currency", () => {
      const wallet = openWallet("100.00");
      const usd = { ...movement("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) };
      expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
      expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
    });

    it("rejects zero-amount movements (version only changes with balance)", () => {
      const wallet = openWallet("100.00");
      expect(() => wallet.credit(movement("0.00"))).toThrow(InvalidWalletError);
      expect(wallet.version).toBe(1);
    });

    it("keeps balance equal to the ledger replay", () => {
      const { wallet, openingEntry } = Wallet.open({
        id: "w1",
        playerId: "p1",
        initialBalance: brl("100.00"),
        at: NOW,
        opening: { transactionId: "o", ledgerEntryId: "e0" },
      });
      const entries = [openingEntry!];
      entries.push(wallet.debit(movement("25.00")));
      entries.push(wallet.credit(movement("60.10")));
      entries.push(wallet.debit(movement("0.10")));

      expect(wallet.balance.amount).toBe("135.00");
      expect(replay(entries).equals(wallet.balance)).toBe(true);
      expect(wallet.version).toBe(4);
    });
  });

  it("rehydrates without revalidation", () => {
    const original = openWallet("10.00");
    const copy = Wallet.rehydrate(original.toState());
    expect(copy.balance.equals(original.balance)).toBe(true);
    expect(copy.version).toBe(original.version);
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "e1",
    walletId: "w1",
    transactionId: "t1",
    direction: LedgerDirection.Debit,
    money: brl("10.00"),
    balanceBefore: brl("30.00"),
    balanceAfter: brl("20.00"),
    createdAt: NOW,
  };

  it("validates arithmetic on creation", () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("21.00") })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("rejects non-positive amounts and negative balances", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: brl("0.00"), balanceAfter: brl("30.00") }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        balanceBefore: brl("5.00"),
        balanceAfter: Money.fromSigned({ amount: "-5.00", currency: "BRL" }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("is structurally immutable", () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { money: Money }).money = brl("999.00");
    }).toThrow(TypeError);
  });
});
