import { InvalidInboxMessageError } from "../shared/errors";

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/**
 * Persistent Inbox record ensuring idempotent message consumption per
 * `(consumerName, messageId)` inside the same SQL transaction as financial
 * settlement (README §6.5 & §10).
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId?.trim()) {
      throw new InvalidInboxMessageError("InboxMessage messageId is required");
    }
    if (!props.consumerName?.trim()) {
      throw new InvalidInboxMessageError("InboxMessage consumerName is required");
    }
    if (!props.payloadHash?.trim()) {
      throw new InvalidInboxMessageError("InboxMessage payloadHash is required");
    }

    return new InboxMessage(
      props.messageId.trim(),
      props.consumerName.trim(),
      props.payloadHash.trim(),
      new Date(props.receivedAt),
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new InvalidInboxMessageError(
        `InboxMessage ${this.consumerName}:${this.messageId} is already processed`,
      );
    }
    this._processedAt = new Date(at);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  toState(): InboxMessageState {
    return {
      messageId: this.messageId,
      consumerName: this.consumerName,
      payloadHash: this.payloadHash,
      receivedAt: new Date(this.receivedAt),
      processedAt: this._processedAt ? new Date(this._processedAt) : undefined,
    };
  }
}
