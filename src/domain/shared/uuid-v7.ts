import { randomBytes } from "node:crypto";

let lastTimestampMs = -1n;
let sequence = 0;

/**
 * Generates an RFC 9562 UUIDv7 (time-ordered, 128-bit identifier) with a
 * 12-bit monotonic sub-millisecond counter in `rand_a` (RFC 9562 §6.2 Method 1)
 * so identifiers generated within the same millisecond preserve strict causal
 * lexicographical ordering (`id1 < id2`).
 *
 * Layout:
 *  - 48 bits: Unix timestamp in milliseconds (big-endian)
 *  -  4 bits: version (0b0111 = 7)
 *  - 12 bits: monotonic sub-millisecond counter (`rand_a`)
 *  -  2 bits: variant (0b10)
 *  - 62 bits: cryptographic random (`rand_b`)
 */
export function generateUuidV7(now: Date = new Date()): string {
  let timestampMs = BigInt(now.getTime());
  const rand = randomBytes(10);

  if (timestampMs === lastTimestampMs) {
    sequence = (sequence + 1) & 0x0fff;
    if (sequence === 0) {
      // Counter rollover (>4096 IDs in 1ms): advance effective timestamp by 1ms per RFC 9562 §6.2
      timestampMs += 1n;
      lastTimestampMs = timestampMs;
    }
  } else {
    lastTimestampMs = timestampMs;
    // Seed lower 11 bits randomly so each new ms retains entropy with >=2048 headroom
    sequence = (((rand[0] ?? 0) << 8) | (rand[1] ?? 0)) & 0x07ff;
  }

  const bytes = new Uint8Array(16);

  // 48-bit big-endian timestamp
  bytes[0] = Number((timestampMs >> 40n) & 0xffn);
  bytes[1] = Number((timestampMs >> 32n) & 0xffn);
  bytes[2] = Number((timestampMs >> 24n) & 0xffn);
  bytes[3] = Number((timestampMs >> 16n) & 0xffn);
  bytes[4] = Number((timestampMs >> 8n) & 0xffn);
  bytes[5] = Number(timestampMs & 0xffn);

  // Version 7 (0111) + 12-bit monotonic sequence (rand_a)
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;

  // 62-bit cryptographic random (rand_b) with RFC 9562 variant (10xxxxxx)
  bytes.set(rand.subarray(2, 10), 8);
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
