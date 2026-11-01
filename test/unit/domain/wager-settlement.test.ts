import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { InvalidTransactionStateError } from "../../../src/domain/shared/errors";
import { BusinessFailureCode } from "../../../src/domain/wagering/failure-code";
import { settleWagerTransaction } from "../../../src/domain/wagering/wager-settlement";
import {
  WagerTransactionStatus,
  type WagerTransaction,
} from "../../../src/domain/wagering/wager-transaction";
import type { Wallet } from "../../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../../src/domain/wallet/wallet-ledger-entry";
import { Bet, Loss, NOW, Refund, Rollback, Win, brl, nextId, openWallet, wager } from "./fixtures";

function settle(
  wallet: Wallet,
  transaction: WagerTransaction,
  options: { reference?: WagerTransaction; referenceAlreadyReversed?: boolean; retryPolicy?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } } = {},
) {
  return settleWagerTransaction({
    wallet,
    transaction,
    reference: options.reference,
    referenceAlreadyReversed: options.referenceAlreadyReversed ?? false,
    ledgerEntryId: nextId("entry"),
    now: NOW,
    retryPolicy: options.retryPolicy,
  });
}

/** Settles a fresh transaction and asserts it was PROCESSED. */
function processed(wallet: Wallet, tx: WagerTransaction, reference?: WagerTransaction) {
  const result = settle(wallet, tx, { reference });
  expect(tx.status).toBe(WagerTransactionStatus.Processed);
  return result;
}

describe("settleWagerTransaction", () => {
  describe("BET", () => {
    it("debits the wallet and produces one DEBIT entry", () => {
      const wallet = openWallet("100.00");
      const tx = wager(Bet, "25.00");
      const { ledgerEntry } = processed(wallet, tx);

      expect(wallet.balance.amount).toBe("75.00");
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(ledgerEntry?.transactionId).toBe(tx.id);
      expect(tx.balanceAfter?.amount).toBe("75.00");
    });

    it("is REJECTED with INSUFFICIENT_FUNDS without touching the wallet", () => {
      const wallet = openWallet("10.00");
      const tx = wager(Bet, "10.01");
      const { ledgerEntry } = settle(wallet, tx);

      expect(tx.status).toBe(WagerTransactionStatus.Rejected);
      expect(tx.failureCode).toBe(BusinessFailureCode.InsufficientFunds);
      expect(tx.balanceAfter?.amount).toBe("10.00"); // observed balance, for replay
      expect(ledgerEntry).toBeUndefined();
      expect(wallet.balance.amount).toBe("10.00");
      expect(wallet.version).toBe(1);
    });

    it("README §8 scenario (sequential form): 100.00 and two 80.00 bets → one processed, one rejected", () => {
      const wallet = openWallet("100.00");
      const first = wager(Bet, "80.00");
      const second = wager(Bet, "80.00");

      const r1 = settle(wallet, first);
      const r2 = settle(wallet, second);

      expect(first.status).toBe(WagerTransactionStatus.Processed);
      expect(second.status).toBe(WagerTransactionStatus.Rejected);
      expect(second.failureCode).toBe(BusinessFailureCode.InsufficientFunds);
      expect(wallet.balance.amount).toBe("20.00");
      expect([r1.ledgerEntry, r2.ledgerEntry].filter(Boolean)).toHaveLength(1);
    });
  });

  describe("WIN", () => {
    it("credits the wallet", () => {
      const wallet = openWallet("100.00");
      const { ledgerEntry } = processed(wallet, wager(Win, "50.00"));
      expect(wallet.balance.amount).toBe("150.00");
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    });

    it("links a processed BET of the same round", () => {
      const wallet = openWallet("100.00");
      const bet = wager(Bet, "10.00", { externalTransactionId: "bet-1" });
      processed(wallet, bet);
      const win = wager(Win, "30.00", { referenceExternalTransactionId: "bet-1" });
      processed(wallet, win, bet);
      expect(win.referenceTransactionId).toBe(bet.id);
    });

    it("proceeds unlinked when its optional reference has not arrived", () => {
      const wallet = openWallet("100.00");
      const win = wager(Win, "30.00", { referenceExternalTransactionId: "missing" });
      processed(wallet, win);
      expect(win.referenceTransactionId).toBeUndefined();
    });

    it("is rejected when its reference is from another round", () => {
      const wallet = openWallet("100.00");
      const bet = wager(Bet, "10.00", { externalTransactionId: "bet-1", roundId: "other-round" });
      processed(wallet, bet);
      const win = wager(Win, "30.00", { referenceExternalTransactionId: "bet-1" });
      settle(wallet, win, { reference: bet });
      expect(win.failureCode).toBe(BusinessFailureCode.ReferenceMismatch);
    });
  });

  describe("LOSS", () => {
    it("is PROCESSED without balance change, version change or ledger entry", () => {
      const wallet = openWallet("100.00");
      const tx = wager(Loss, "0.00");
      const { ledgerEntry } = processed(wallet, tx);
      expect(ledgerEntry).toBeUndefined();
      expect(wallet.balance.amount).toBe("100.00");
      expect(wallet.version).toBe(1);
      expect(tx.balanceAfter?.amount).toBe("100.00");
    });
  });

  describe("REFUND", () => {
    const setup = () => {
      const wallet = openWallet("100.00");
      const bet = wager(Bet, "40.00", { externalTransactionId: "bet-1" });
      processed(wallet, bet);
      return { wallet, bet };
    };

    it("credits back a processed BET and links it", () => {
      const { wallet, bet } = setup();
      const refund = wager(Refund, "40.00", { referenceExternalTransactionId: "bet-1" });
      const { ledgerEntry } = processed(wallet, refund, bet);

      expect(wallet.balance.amount).toBe("100.00");
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(refund.referenceTransactionId).toBe(bet.id);
    });

    it("cannot revert the same BET twice", () => {
      const { wallet, bet } = setup();
      const refund = wager(Refund, "40.00", { referenceExternalTransactionId: "bet-1" });
      settle(wallet, refund, { reference: bet, referenceAlreadyReversed: true });
      expect(refund.failureCode).toBe(BusinessFailureCode.ReferenceAlreadyReversed);
      expect(wallet.balance.amount).toBe("60.00");
    });

    it("only references a BET", () => {
      const wallet = openWallet("100.00");
      const win = wager(Win, "40.00", { externalTransactionId: "win-1" });
      processed(wallet, win);
      const refund = wager(Refund, "40.00", { referenceExternalTransactionId: "win-1" });
      settle(wallet, refund, { reference: win });
      expect(refund.failureCode).toBe(BusinessFailureCode.ReferenceKindNotAllowed);
    });

    it("must match the referenced amount (no partial reversal)", () => {
      const { wallet, bet } = setup();
      const refund = wager(Refund, "39.99", { referenceExternalTransactionId: "bet-1" });
      settle(wallet, refund, { reference: bet });
      expect(refund.failureCode).toBe(BusinessFailureCode.ReferenceAmountMismatch);
    });

    it.each([
      ["player", { playerId: "player-2" }],
      ["round", { roundId: "round-2" }],
      ["provider", { providerId: "provider-b" }],
    ])("rejects a reference from another %s", (_label, overrides) => {
      const wallet = openWallet("100.00");
      const bet = wager(Bet, "40.00", { externalTransactionId: "bet-1", ...overrides });
      // Settle the foreign BET on its own wallet so it is PROCESSED.
      settle(openWallet("100.00", { playerId: bet.playerId }), bet);
      const refund = wager(Refund, "40.00", { referenceExternalTransactionId: "bet-1" });
      settle(wallet, refund, { reference: bet });
      expect(refund.failureCode).toBe(BusinessFailureCode.ReferenceMismatch);
    });

    it("is rejected when the referenced BET was itself rejected", () => {
      const wallet = openWallet("10.00");
      const bet = wager(Bet, "40.00", { externalTransactionId: "bet-1" });
      settle(wallet, bet);
      expect(bet.status).toBe(WagerTransactionStatus.Rejected);

      const refund = wager(Refund, "40.00", { referenceExternalTransactionId: "bet-1" });
      settle(wallet, refund, { reference: bet });
      expect(refund.failureCode).toBe(BusinessFailureCode.ReferenceNotProcessed);
      expect(wallet.balance.amount).toBe("10.00");
    });
  });

  describe("ROLLBACK", () => {
    it("of a BET credits the amount back", () => {
      const wallet = openWallet("100.00");
      const bet = wager(Bet, "30.00", { externalTransactionId: "bet-1" });
      processed(wallet, bet);
      const rollback = wager(Rollback, "30.00", { referenceExternalTransactionId: "bet-1" });
      const { ledgerEntry } = processed(wallet, rollback, bet);
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.amount).toBe("100.00");
    });

    it("of a WIN debits the amount back", () => {
      const wallet = openWallet("100.00");
      const win = wager(Win, "50.00", { externalTransactionId: "win-1" });
      processed(wallet, win);
      const rollback = wager(Rollback, "50.00", { referenceExternalTransactionId: "win-1" });
      const { ledgerEntry } = processed(wallet, rollback, win);
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.amount).toBe("100.00");
    });

    it("of a REFUND debits the refunded amount", () => {
      const wallet = openWallet("100.00");
      const bet = wager(Bet, "30.00", { externalTransactionId: "bet-1" });
      processed(wallet, bet);
      const refund = wager(Refund, "30.00", { externalTransactionId: "refund-1", referenceExternalTransactionId: "bet-1" });
      processed(wallet, refund, bet);
      const rollback = wager(Rollback, "30.00", { referenceExternalTransactionId: "refund-1" });
      processed(wallet, rollback, refund);
      expect(wallet.balance.amount).toBe("70.00");
    });

    it("that would make the balance negative is rejected with a code distinct from a BET", () => {
      const wallet = openWallet("0.00");
      const win = wager(Win, "50.00", { externalTransactionId: "win-1" });
      processed(wallet, win);
      processed(wallet, wager(Bet, "45.00")); // balance now 5.00

      const rollback = wager(Rollback, "50.00", { referenceExternalTransactionId: "win-1" });
      const { ledgerEntry } = settle(wallet, rollback, { reference: win });

      expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
      expect(rollback.failureCode).toBe(BusinessFailureCode.ReversalInsufficientFunds);
      expect(rollback.failureCode).not.toBe(BusinessFailureCode.InsufficientFunds);
      expect(ledgerEntry).toBeUndefined();
      expect(wallet.balance.amount).toBe("5.00");
    });

    it("cannot target a LOSS", () => {
      const wallet = openWallet("100.00");
      const loss = wager(Loss, "0.00", { externalTransactionId: "loss-1" });
      processed(wallet, loss);
      const rollback = wager(Rollback, "1.00", { referenceExternalTransactionId: "loss-1" });
      settle(wallet, rollback, { reference: loss });
      expect(rollback.failureCode).toBe(BusinessFailureCode.ReferenceKindNotAllowed);
    });
  });

  describe("out-of-order references (§7.1)", () => {
    const policy = { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 10_000 };

    it("waits in PENDING_REFERENCE, then processes once the reference arrives", () => {
      const wallet = openWallet("100.00");
      const refund = wager(Refund, "40.00", { referenceExternalTransactionId: "bet-1" });

      const first = settle(wallet, refund, { retryPolicy: policy });
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
      expect(first.ledgerEntry).toBeUndefined();
      expect(wallet.balance.amount).toBe("100.00");

      const bet = wager(Bet, "40.00", { externalTransactionId: "bet-1" });
      processed(wallet, bet);
      processed(wallet, refund, bet);
      expect(wallet.balance.amount).toBe("100.00");
    });

    it("also waits while the reference is itself still pending", () => {
      const wallet = openWallet("100.00");
      const pendingBet = wager(Bet, "40.00", { externalTransactionId: "bet-1" });
      const refund = wager(Refund, "40.00", { referenceExternalTransactionId: "bet-1" });
      settle(wallet, refund, { reference: pendingBet, retryPolicy: policy });
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    });

    it("is REJECTED with REFERENCE_NOT_FOUND after exhausting attempts", () => {
      const wallet = openWallet("100.00");
      const refund = wager(Refund, "40.00", { referenceExternalTransactionId: "bet-1" });

      settle(wallet, refund, { retryPolicy: policy });
      settle(wallet, refund, { retryPolicy: policy });
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
      settle(wallet, refund, { retryPolicy: policy });

      expect(refund.status).toBe(WagerTransactionStatus.Rejected);
      expect(refund.failureCode).toBe(BusinessFailureCode.ReferenceNotFound);
    });
  });

  describe("guards", () => {
    it("rejects a currency conflict with CURRENCY_MISMATCH", () => {
      const wallet = openWallet("100.00");
      const tx = wager(Bet, "1.00", { money: Money.from({ amount: "1.00", currency: "USD" }) });
      settle(wallet, tx);
      expect(tx.failureCode).toBe(BusinessFailureCode.CurrencyMismatch);
      expect(wallet.balance.amount).toBe("100.00");
    });

    it("rejects a player that does not own the wallet", () => {
      const wallet = openWallet("100.00");
      const tx = wager(Bet, "1.00", { playerId: "intruder" });
      settle(wallet, tx);
      expect(tx.failureCode).toBe(BusinessFailureCode.PlayerWalletMismatch);
    });

    it("refuses to settle a terminal transaction (no double application)", () => {
      const wallet = openWallet("100.00");
      const tx = wager(Bet, "10.00");
      processed(wallet, tx);
      expect(() => settle(wallet, tx)).toThrow(InvalidTransactionStateError);
      expect(wallet.balance.amount).toBe("90.00");
    });
  });

  it("keeps balance == ledger replay across a full round", () => {
    const wallet = openWallet("0.00");
    const entries = [];
    const bet = wager(Bet, "0.01", { externalTransactionId: "b0" });
    const credit = wager(Win, "100.00");
    entries.push(processed(wallet, credit).ledgerEntry);
    entries.push(processed(wallet, bet).ledgerEntry);
    const refund = wager(Refund, "0.01", { referenceExternalTransactionId: "b0" });
    entries.push(processed(wallet, refund, bet).ledgerEntry);
    entries.push(processed(wallet, wager(Bet, "33.33")).ledgerEntry);
    processed(wallet, wager(Loss, "0.00"));

    const replayed = entries.reduce((acc, e) => acc.add(e!.signedAmount()), brl("0.00"));
    expect(replayed.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe("66.67");
  });
});
