import { InvalidOutboxMessageError } from "../shared/errors";
import type { IntegrationEvent } from "./integration-event";

export interface OutboxBackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_OUTBOX_BACKOFF_POLICY: OutboxBackoffPolicy = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
});

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/**
 * Transactional Outbox entry persisted atomically alongside wallet, ledger,
 * and wager transaction mutations (README §6.5 & §11).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...envelope }),
      new Date(event.occurredAt),
      0,
      new Date(event.occurredAt),
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined,
      state.publishedAt ? new Date(state.publishedAt) : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt) : undefined;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt) : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (!this._nextAttemptAt) return true;
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (this._publishedAt !== undefined) {
      throw new InvalidOutboxMessageError(`OutboxMessage ${this.id} is already published`);
    }
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(
    now: Date,
    policy: OutboxBackoffPolicy = DEFAULT_OUTBOX_BACKOFF_POLICY,
  ): void {
    if (this._publishedAt !== undefined) {
      throw new InvalidOutboxMessageError(`Cannot retry already published OutboxMessage ${this.id}`);
    }
    const exponent = Math.min(this._attempts, 20);
    const delayMs = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: { ...this.payload },
      occurredAt: new Date(this.occurredAt),
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt ? new Date(this._nextAttemptAt) : undefined,
      publishedAt: this._publishedAt ? new Date(this._publishedAt) : undefined,
    };
  }
}
