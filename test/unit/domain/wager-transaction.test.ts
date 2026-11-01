import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../../src/domain/shared/errors";
import {
  BusinessFailureCode,
  FAILURE_CODE_CATALOG,
  InfrastructureFailureCode,
} from "../../../src/domain/wagering/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/wagering/wager-transaction";
import { LedgerDirection } from "../../../src/domain/wallet/wallet-ledger-entry";
import { Bet, Loss, NOW, Refund, Rollback, Win, brl, wager } from "./fixtures";

const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("WagerTransaction", () => {
  describe("create", () => {
    it("is born PENDING", () => {
      const tx = wager(Bet, "10.00");
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.isTerminal()).toBe(false);
    });

    it("cannot be submitted as OPENING", () => {
      expect(() =>
        wager(WagerTransactionKind.Opening as unknown as typeof Bet, "10.00"),
      ).toThrow(/OPENING is internal/);
    });

    it.each([Refund, Rollback])("%s requires referenceExternalTransactionId", (kind) => {
      expect(() => wager(kind, "10.00")).toThrow(InvalidWagerTransactionError);
      expect(() => wager(kind, "10.00", { referenceExternalTransactionId: "  " })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it("BET cannot carry a reference", () => {
      expect(() => wager(Bet, "10.00", { referenceExternalTransactionId: "x" })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it("cannot reference itself", () => {
      expect(() =>
        wager(Refund, "1.00", { externalTransactionId: "a", referenceExternalTransactionId: "a" }),
      ).toThrow(/itself/);
    });

    it("requires a positive amount, except LOSS which accepts 0.00", () => {
      expect(() => wager(Bet, "0.00")).toThrow(InvalidWagerTransactionError);
      expect(wager(Loss, "0.00").money.isZero()).toBe(true);
    });

    it.each(["providerId", "externalTransactionId", "walletId", "playerId", "roundId", "gameId"])(
      "requires %s",
      (field) => {
        expect(() => wager(Bet, "1.00", { [field]: "" })).toThrow(`${field} is required`);
      },
    );
  });

  describe("state machine", () => {
    it("PENDING → PROCESSED records balance snapshot and timestamp", () => {
      const tx = wager(Bet, "10.00");
      tx.markProcessed({ balanceAfter: brl("90.00"), at: NOW });
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.balanceAfter?.amount).toBe("90.00");
      expect(tx.processedAt).toEqual(NOW);
      expect(tx.isTerminal()).toBe(true);
    });

    it("PENDING → REJECTED carries a business failure code", () => {
      const tx = wager(Bet, "10.00");
      tx.reject(BusinessFailureCode.InsufficientFunds, { at: NOW, observedBalance: brl("5.00") });
      expect(tx.status).toBe(WagerTransactionStatus.Rejected);
      expect(tx.failureCode).toBe(BusinessFailureCode.InsufficientFunds);
    });

    it("PENDING → FAILED carries an infrastructure failure code", () => {
      const tx = wager(Bet, "10.00");
      tx.fail(InfrastructureFailureCode.PermanentProcessingFailure, NOW);
      expect(tx.status).toBe(WagerTransactionStatus.Failed);
    });

    it.each([
      ["PROCESSED", (tx: WagerTransaction) => tx.markProcessed({ balanceAfter: brl("1.00"), at: NOW })],
      ["REJECTED", (tx: WagerTransaction) => tx.reject(BusinessFailureCode.InsufficientFunds, { at: NOW })],
      ["FAILED", (tx: WagerTransaction) => tx.fail(InfrastructureFailureCode.PermanentProcessingFailure, NOW)],
    ])("%s is terminal: any further transition throws", (_state, toTerminal) => {
      const tx = wager(Refund, "10.00", { referenceExternalTransactionId: "bet-1" });
      toTerminal(tx);
      expect(() => tx.markProcessed({ balanceAfter: brl("1.00"), at: NOW })).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(BusinessFailureCode.InsufficientFunds, { at: NOW })).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.fail(InfrastructureFailureCode.PermanentProcessingFailure, NOW)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it("PENDING_REFERENCE schedules retries with exponential backoff", () => {
      const policy = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 3_000 };
      const tx = wager(Refund, "10.00", { referenceExternalTransactionId: "bet-1" });

      tx.markPendingReference(NOW, policy);
      expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
      expect(tx.referenceAttempts).toBe(1);
      expect(tx.nextReferenceAttemptAt).toEqual(later(1_000));
      expect(tx.isDueForReferenceRetry(later(999))).toBe(false);
      expect(tx.isDueForReferenceRetry(later(1_000))).toBe(true);

      tx.markPendingReference(NOW, policy);
      expect(tx.nextReferenceAttemptAt).toEqual(later(2_000));
      tx.markPendingReference(NOW, policy);
      expect(tx.nextReferenceAttemptAt).toEqual(later(3_000)); // capped (would be 4s)
      expect(tx.hasExhaustedReferenceAttempts(policy)).toBe(false);
      tx.markPendingReference(NOW, policy);
      expect(tx.hasExhaustedReferenceAttempts(policy)).toBe(true);
    });

    it("only REFUND/ROLLBACK can wait for a reference", () => {
      expect(() => wager(Win, "1.00").markPendingReference(NOW)).toThrow(InvalidWagerTransactionError);
    });
  });

  describe("domain queries", () => {
    it("affectsBalance is false only for LOSS", () => {
      expect(wager(Loss, "0.00").affectsBalance()).toBe(false);
      expect(wager(Bet, "1.00").affectsBalance()).toBe(true);
      expect(wager(Win, "1.00").affectsBalance()).toBe(true);
    });

    it("ledgerDirectionFor maps each kind", () => {
      const bet = wager(Bet, "1.00");
      const win = wager(Win, "1.00");
      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(wager(Refund, "1.00", { referenceExternalTransactionId: "r" }).ledgerDirectionFor()).toBe(
        LedgerDirection.Credit,
      );

      const rollback = wager(Rollback, "1.00", { referenceExternalTransactionId: "r" });
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
      expect(() => wager(Loss, "0.00").ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    });
  });

  it("OPENING factory is internal and born PROCESSED", () => {
    const tx = WagerTransaction.opening({
      id: "t",
      walletId: "w",
      playerId: "p",
      money: brl("10.00"),
      at: NOW,
    });
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => WagerTransaction.opening({ id: "t", walletId: "w", playerId: "p", money: Money.zero("BRL"), at: NOW })).toThrow();
  });

  it("rehydrates the exact persisted state", () => {
    const tx = wager(Refund, "10.00", { referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(NOW);
    const copy = WagerTransaction.rehydrate(tx.toState());
    expect(copy.toState()).toEqual(tx.toState());
  });

  it("every failure code is documented in the catalog", () => {
    for (const code of [...Object.values(BusinessFailureCode), ...Object.values(InfrastructureFailureCode)]) {
      expect(FAILURE_CODE_CATALOG[code]).toBeDefined();
    }
  });
});
