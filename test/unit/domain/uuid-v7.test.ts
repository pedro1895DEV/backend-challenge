import { describe, expect, it } from "bun:test";
import { generateUuidV7 } from "../../../src/domain/shared/uuid-v7";

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateUuidV7", () => {
  it("produces canonical RFC 9562 UUIDv7 strings", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateUuidV7();
      expect(id).toHaveLength(36);
      expect(UUID_V7_REGEX.test(id)).toBe(true);
    }
  });

  it("orders lexicographically by millisecond timestamp", () => {
    const earlier = generateUuidV7(new Date("2026-01-01T00:00:00.000Z"));
    const later = generateUuidV7(new Date("2026-01-01T00:00:01.000Z"));
    expect(earlier < later).toBe(true);
  });

  it("produces unique, strictly monotonic identifiers within the same millisecond", () => {
    const fixed = new Date("2026-10-31T12:00:00.000Z");
    const list = Array.from({ length: 100 }, () => generateUuidV7(fixed));
    expect(new Set(list).size).toBe(100);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]! < list[i]!).toBe(true);
    }
  });
});
