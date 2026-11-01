/** Retry policy for transactions waiting on an out-of-order reference (README §7.1). */
export interface ReferenceRetryPolicy {
  /** Total resolution attempts (including the first) before rejecting with REFERENCE_NOT_FOUND. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * 10 attempts with exponential backoff 1s, 2s, 4s … capped at 5 min.
 * Total window ≈ 1+2+4+…+256 s ≈ 8.5 min — long enough to absorb broker
 * redelivery/reordering, short enough that a provider gets a final answer
 * well within a game round's settlement window.
 */
export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = Object.freeze({
  maxAttempts: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
});

/** Delay before the next attempt, given how many attempts were already made (≥ 1). */
export function referenceRetryDelayMs(attemptsMade: number, policy: ReferenceRetryPolicy): number {
  const exponent = Math.max(0, attemptsMade - 1);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}
