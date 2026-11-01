import { createHash } from "node:crypto";
import { Money, type MoneyProps } from "../money/money";

/**
 * Business fields that define "the same request" for idempotency (README §9).
 * Transport metadata (headers, messageId, occurredAt, idempotency key) is
 * deliberately excluded.
 */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * Canonical JSON: object keys sorted lexicographically (recursively),
 * `undefined` members omitted, no whitespace. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Non-finite numbers cannot be canonicalized");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * `payloadHash = hex(SHA-256(UTF-8(canonicalJson(businessFields))))`.
 *
 * Fields are picked explicitly so extra properties on the input object can
 * never change the hash.
 */
export function computeWagerPayloadHash(fields: WagerPayloadFields): string {
  const business: WagerPayloadFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: Money.fromSigned(fields.money).toJSON(), // normalized: "25.0" ≡ "25.00"
    referenceExternalTransactionId: fields.referenceExternalTransactionId || undefined,
  };
  return createHash("sha256").update(canonicalJson(business), "utf8").digest("hex");
}
