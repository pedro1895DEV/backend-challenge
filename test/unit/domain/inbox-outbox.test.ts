import { describe, expect, it } from "bun:test";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../../src/domain/messaging/integration-event";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { Money } from "../../../src/domain/money/money";
import {
  InvalidInboxMessageError,
  InvalidOutboxMessageError,
} from "../../../src/domain/shared/errors";
import { BusinessFailureCode } from "../../../src/domain/wagering/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../../src/domain/wallet/wallet";

describe("InboxMessage", () => {
  const now = new Date("2026-10-31T12:00:00.000Z");

  it("receives an unprocessed message and transitions once to processed", () => {
    const msg = InboxMessage.receive({
      consumerName: "sqs-wager-consumer",
      messageId: "msg-1",
      payloadHash: "sha256-abc",
      receivedAt: now,
    });

    expect(msg.isProcessed()).toBe(false);
    expect(msg.processedAt).toBeUndefined();
    expect(msg.matchesPayload("sha256-abc")).toBe(true);
    expect(msg.matchesPayload("sha256-other")).toBe(false);

    const processedAt = new Date("2026-10-31T12:00:01.000Z");
    msg.markProcessed(processedAt);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt?.toISOString()).toBe(processedAt.toISOString());

    expect(() => msg.markProcessed(processedAt)).toThrow(InvalidInboxMessageError);
  });

  it("rejects empty identifiers or payloadHash", () => {
    expect(() =>
      InboxMessage.receive({
        consumerName: "",
        messageId: "msg-1",
        payloadHash: "hash",
        receivedAt: now,
      }),
    ).toThrow(InvalidInboxMessageError);

    expect(() =>
      InboxMessage.receive({
        consumerName: "c1",
        messageId: "   ",
        payloadHash: "hash",
        receivedAt: now,
      }),
    ).toThrow(InvalidInboxMessageError);
  });
});

describe("IntegrationEvent & OutboxMessage", () => {
  const now = new Date("2026-10-31T12:00:00.000Z");

  it("serializes concrete subclasses with MoneyProps decimal strings (never numbers)", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      at: now,
      opening: { transactionId: "tx-open", ledgerEntryId: "le-open" },
    });

    const betEntry = wallet.debit({
      money: Money.from({ amount: "25.50", currency: "BRL" }),
      transactionId: "tx-bet-1",
      ledgerEntryId: "le-bet-1",
      at: now,
    });

    expect(openingEntry).toBeDefined();

    const balanceChanged = WalletBalanceChanged.from(wallet, betEntry, {
      eventId: "evt-bal-1",
      correlationId: "corr-1",
      occurredAt: now,
    });
    const balanceJson = balanceChanged.toJSON();
    expect(balanceJson).toEqual({
      eventId: "evt-bal-1",
      eventType: "WalletBalanceChanged",
      aggregateId: "w-1",
      correlationId: "corr-1",
      causationId: "tx-bet-1",
      occurredAt: now.toISOString(),
      version: 1,
      data: {
        walletId: "w-1",
        transactionId: "tx-bet-1",
        direction: betEntry.direction,
        money: { amount: "25.50", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "74.50", currency: "BRL" },
        walletVersion: 2,
      },
    });
    expect(typeof balanceJson.data.money.amount).toBe("string");

    // WagerTransactionProcessed
    const processedTx = WagerTransaction.create({
      id: "tx-bet-1",
      providerId: "prov-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "prov-a:ext-1",
      payloadHash: "hash-1",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.50", currency: "BRL" }),
      createdAt: now,
    });
    processedTx.markProcessed({ balanceAfter: wallet.balance, at: now });

    const processedEvent = WagerTransactionProcessed.from(processedTx, wallet.balance, {
      eventId: "evt-proc-1",
      correlationId: "corr-1",
      occurredAt: now,
    });
    expect(processedEvent.toJSON().eventType).toBe("WagerTransactionProcessed");
    expect(processedEvent.toJSON().data.observedBalance).toEqual({
      amount: "74.50",
      currency: "BRL",
    });

    // WagerTransactionRejected
    const rejectedTx = WagerTransaction.create({
      id: "tx-rej-1",
      providerId: "prov-a",
      externalTransactionId: "ext-2",
      idempotencyKey: "prov-a:ext-2",
      payloadHash: "hash-2",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "999.00", currency: "BRL" }),
      createdAt: now,
    });
    rejectedTx.reject(BusinessFailureCode.InsufficientFunds, {
      at: now,
      observedBalance: wallet.balance,
    });

    const rejectedEvent = WagerTransactionRejected.from(rejectedTx, wallet.balance, {
      eventId: "evt-rej-1",
      correlationId: "corr-1",
      occurredAt: now,
    });
    expect(rejectedEvent.toJSON().eventType).toBe("WagerTransactionRejected");
    expect(rejectedEvent.toJSON().data.failureCode).toBe(BusinessFailureCode.InsufficientFunds);

    // WagerTransactionPendingReference
    const pendingTx = WagerTransaction.create({
      id: "tx-pend-1",
      providerId: "prov-a",
      externalTransactionId: "ext-3",
      idempotencyKey: "prov-a:ext-3",
      payloadHash: "hash-3",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "25.50", currency: "BRL" }),
      referenceExternalTransactionId: "ext-missing",
      createdAt: now,
    });
    pendingTx.markPendingReference(now, undefined, wallet.balance);

    const pendingEvent = WagerTransactionPendingReference.from(pendingTx, wallet.balance, {
      eventId: "evt-pend-1",
      correlationId: "corr-1",
      occurredAt: now,
    });
    expect(pendingEvent.toJSON().eventType).toBe("WagerTransactionPendingReference");
    expect(pendingEvent.toJSON().data.referenceExternalTransactionId).toBe("ext-missing");
  });

  it("manages OutboxMessage retry backoff and terminal publication", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w-out",
      playerId: "p-out",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
      at: now,
      opening: { transactionId: "tx-o", ledgerEntryId: "le-o" },
    });

    const evt = WalletBalanceChanged.from(wallet, openingEntry!, {
      eventId: "evt-out-1",
      correlationId: "corr-out",
      occurredAt: now,
    });

    const outbox = OutboxMessage.enqueue(evt);
    expect(outbox.id).toBe("evt-out-1");
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(now)).toBe(true);
    expect(outbox.attempts).toBe(0);

    outbox.scheduleRetry(now, { baseDelayMs: 1_000, maxDelayMs: 10_000 });
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(now)).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 1_000))).toBe(true);

    outbox.scheduleRetry(new Date(now.getTime() + 1_000), {
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
    });
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 1_000 + 2_000);

    const pubTime = new Date(now.getTime() + 5_000);
    outbox.markPublished(pubTime);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(pubTime)).toBe(false);
    expect(outbox.publishedAt?.getTime()).toBe(pubTime.getTime());

    expect(() => outbox.markPublished(pubTime)).toThrow(InvalidOutboxMessageError);
    expect(() => outbox.scheduleRetry(pubTime)).toThrow(InvalidOutboxMessageError);
  });
});
