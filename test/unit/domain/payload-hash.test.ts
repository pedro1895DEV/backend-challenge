import { describe, expect, it } from "bun:test";
import { canonicalJson, computeWagerPayloadHash } from "../../../src/domain/wagering/payload-hash";
import { Bet, wager } from "./fixtures";

const payload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  it("sorts keys recursively and omits undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("computeWagerPayloadHash", () => {
  const hash = computeWagerPayloadHash(payload);

  it("is a SHA-256 hex digest", () => {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on key order", () => {
    const reordered = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: payload.walletId,
      playerId: payload.playerId,
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
    };
    expect(computeWagerPayloadHash(reordered)).toBe(hash);
  });

  it("normalizes equivalent amounts (25 ≡ 25.00)", () => {
    expect(computeWagerPayloadHash({ ...payload, money: { amount: "25", currency: "BRL" } })).toBe(hash);
  });

  it("ignores non-business / transport fields", () => {
    const withTransport = { ...payload, messageId: "msg-1", idempotencyKey: "k", occurredAt: "now" };
    expect(computeWagerPayloadHash(withTransport)).toBe(hash);
  });

  it.each([
    ["amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["currency", { money: { amount: "25.00", currency: "USD" } }],
    ["kind", { kind: "WIN" }],
    ["walletId", { walletId: "other" }],
    ["roundId", { roundId: "other" }],
    ["reference", { referenceExternalTransactionId: "x" }],
  ])("changes when %s changes", (_field, change) => {
    expect(computeWagerPayloadHash({ ...payload, ...change })).not.toBe(hash);
  });
});

describe("idempotency key with divergent payload", () => {
  it("an existing transaction matches only the identical payload", () => {
    const existing = wager(Bet, "25.00", { externalTransactionId: "transaction-123" });
    const sameRequest = computeWagerPayloadHash({
      providerId: existing.providerId,
      externalTransactionId: existing.externalTransactionId,
      playerId: existing.playerId,
      walletId: existing.walletId,
      roundId: existing.roundId,
      gameId: existing.gameId,
      kind: existing.kind,
      money: existing.money.toJSON(),
    });
    const divergent = computeWagerPayloadHash({
      providerId: existing.providerId,
      externalTransactionId: existing.externalTransactionId,
      playerId: existing.playerId,
      walletId: existing.walletId,
      roundId: existing.roundId,
      gameId: existing.gameId,
      kind: existing.kind,
      money: { amount: "250.00", currency: "BRL" },
    });

    expect(existing.matchesPayload(sameRequest)).toBe(true); // → replay
    expect(existing.matchesPayload(divergent)).toBe(false); // → conflict, not replay
  });
});
