import { createHash } from "node:crypto";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { DomainError } from "../../domain/shared/errors";
import { generateUuidV7 } from "../../domain/shared/uuid-v7";
import { canonicalJson } from "../../domain/wagering/payload-hash";
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  UniqueConstraintError,
  ValidationError,
  WalletNotFoundError,
} from "../errors/application-errors";
import type { InboxRepository } from "../ports/inbox.repository";
import { NOOP_METRICS_PORT, type MetricsPort } from "../ports/metrics.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type {
  ProcessWagerTransactionOutput,
  ProcessWagerTransactionUseCase,
} from "./process-wager-transaction.use-case";

export const SQS_WAGER_CONSUMER_NAME = "sqs-wager-transactions";
export const WAGER_REQUESTED_MESSAGE_TYPE = "WagerTransactionRequested";

export interface SqsConsumerRetryPolicy {
  readonly maxReceiveCount: number;
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
}

export const DEFAULT_SQS_CONSUMER_RETRY_POLICY: SqsConsumerRetryPolicy = Object.freeze({
  maxReceiveCount: 5,
  baseDelaySeconds: 1,
  maxDelaySeconds: 30,
});

export interface InboundQueueMessage {
  transportMessageId: string;
  body: string;
  receiveCount: number;
  messageGroupId?: string;
}

export type ConsumeMessageDecision =
  | {
      disposition: "ack";
      reason: "PROCESSED" | "DUPLICATE_INBOX";
      logicalMessageId: string;
      correlationId: string;
      walletId?: string;
      providerId?: string;
      kind?: string;
      result?: ProcessWagerTransactionOutput;
    }
  | {
      disposition: "retry";
      reason: string;
      errorMessage: string;
      logicalMessageId?: string;
      correlationId: string;
      backoffSeconds: number;
      walletId?: string;
      providerId?: string;
      kind?: string;
    }
  | {
      disposition: "dlq";
      category: "PERMANENT" | "MAX_RETRIES_EXCEEDED";
      reason: string;
      errorMessage: string;
      logicalMessageId?: string;
      correlationId: string;
      walletId?: string;
      providerId?: string;
      kind?: string;
    };

class InboxPayloadMismatchError extends Error {
  readonly code = "INBOX_PAYLOAD_MISMATCH";
  constructor(messageId: string) {
    super(`Message "${messageId}" was already received with a different payload`);
    this.name = "InboxPayloadMismatchError";
  }
}

/**
 * Consumes an inbound SQS wager message atomically with persistent Inbox,
 * financial settlement ({@link ProcessWagerTransactionUseCase}), ledger, and
 * Transactional Outbox (README §10 & §11).
 *
 * Returns a deterministic broker disposition (`ack`, `retry` with backoff, or
 * `dlq`) that the SQS worker executes **after** the SQL transaction commits or
 * rolls back — never ACKing before commit.
 */
export class ConsumeWagerMessageUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly inboxRepo: InboxRepository,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly retryPolicy: SqsConsumerRetryPolicy = DEFAULT_SQS_CONSUMER_RETRY_POLICY,
    private readonly consumerName: string = SQS_WAGER_CONSUMER_NAME,
    private readonly metrics: MetricsPort = NOOP_METRICS_PORT,
  ) {}

  async execute(
    raw: InboundQueueMessage,
    now: Date = new Date(),
  ): Promise<ConsumeMessageDecision> {
    const startedAt = performance.now();

    // 1. Parse JSON body
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.body);
    } catch (error) {
      return this.finalizeDecision(
        {
          disposition: "dlq",
          category: "PERMANENT",
          reason: "MALFORMED_JSON",
          errorMessage: error instanceof Error ? error.message : "Invalid JSON body",
          correlationId: raw.transportMessageId || generateUuidV7(now),
        },
        startedAt,
      );
    }

    if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
      return this.finalizeDecision(
        {
          disposition: "dlq",
          category: "PERMANENT",
          reason: "INVALID_MESSAGE_ENVELOPE",
          errorMessage: "Message body must be a JSON object",
          correlationId: raw.transportMessageId || generateUuidV7(now),
        },
        startedAt,
      );
    }

    const envelope = parsedJson as Record<string, unknown>;
    const logicalMessageId =
      typeof envelope.messageId === "string" ? envelope.messageId.trim() : "";
    const messageType = typeof envelope.type === "string" ? envelope.type.trim() : "";
    const data = envelope.data;

    const correlationId =
      (typeof envelope.correlationId === "string" && envelope.correlationId.trim()) ||
      logicalMessageId ||
      raw.transportMessageId ||
      generateUuidV7(now);

    if (
      !logicalMessageId ||
      logicalMessageId.length > 128 ||
      messageType !== WAGER_REQUESTED_MESSAGE_TYPE ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      return this.finalizeDecision(
        {
          disposition: "dlq",
          category: "PERMANENT",
          reason: "INVALID_MESSAGE_ENVELOPE",
          errorMessage:
            "Envelope requires non-empty messageId (<=128 chars), type='WagerTransactionRequested', and object data",
          logicalMessageId: logicalMessageId || undefined,
          correlationId,
        },
        startedAt,
      );
    }

    const payloadRecord = data as Record<string, unknown>;
    const walletId =
      typeof payloadRecord.walletId === "string" && payloadRecord.walletId.trim()
        ? payloadRecord.walletId.trim()
        : undefined;
    const providerId =
      typeof payloadRecord.providerId === "string" && payloadRecord.providerId.trim()
        ? payloadRecord.providerId.trim()
        : undefined;
    const kind =
      typeof payloadRecord.kind === "string" && payloadRecord.kind.trim()
        ? payloadRecord.kind.trim()
        : undefined;

    const inboxPayloadHash = createHash("sha256")
      .update(
        canonicalJson({
          messageId: logicalMessageId,
          type: messageType,
          data: payloadRecord,
        }),
        "utf8",
      )
      .digest("hex");

    // 2. Atomic SQL transaction: Inbox + Wallet + Ledger + WagerTransaction + Outbox
    try {
      const committedDecision = await this.unitOfWork.runInTransaction(async (tx) => {
        const existingInbox = await tx.inbox.findByConsumerAndMessageId(
          this.consumerName,
          logicalMessageId,
        );

        if (existingInbox) {
          if (!existingInbox.matchesPayload(inboxPayloadHash)) {
            throw new InboxPayloadMismatchError(logicalMessageId);
          }
          if (existingInbox.isProcessed()) {
            return {
              disposition: "ack" as const,
              reason: "DUPLICATE_INBOX" as const,
              logicalMessageId,
              correlationId,
              walletId,
              providerId,
              kind,
            };
          }
        }

        const inbox =
          existingInbox ??
          InboxMessage.receive({
            consumerName: this.consumerName,
            messageId: logicalMessageId,
            payloadHash: inboxPayloadHash,
            receivedAt: now,
          });

        if (!existingInbox) {
          await tx.inbox.insert(inbox);
        }

        const result = await this.processWagerUseCase.executeInTransaction(
          {
            idempotencyKey: payloadRecord.idempotencyKey,
            providerId: payloadRecord.providerId,
            externalTransactionId: payloadRecord.externalTransactionId,
            playerId: payloadRecord.playerId,
            walletId: payloadRecord.walletId,
            roundId: payloadRecord.roundId,
            gameId: payloadRecord.gameId,
            kind: payloadRecord.kind,
            money: payloadRecord.money,
            referenceExternalTransactionId: payloadRecord.referenceExternalTransactionId,
            correlationId,
            causationId: logicalMessageId,
            now,
          },
          tx,
        );

        inbox.markProcessed(now);
        await tx.inbox.update(inbox);

        return {
          disposition: "ack" as const,
          reason: "PROCESSED" as const,
          logicalMessageId,
          correlationId,
          walletId,
          providerId,
          kind,
          result,
        };
      });

      return this.finalizeDecision(committedDecision, startedAt);
    } catch (error) {
      const failureDecision = await this.classifyFailure(
        error,
        logicalMessageId,
        inboxPayloadHash,
        correlationId,
        raw.receiveCount,
        { walletId, providerId, kind },
      );
      return this.finalizeDecision(failureDecision, startedAt);
    }
  }

  private async classifyFailure(
    error: unknown,
    logicalMessageId: string,
    inboxPayloadHash: string,
    correlationId: string,
    receiveCount: number,
    meta: { walletId?: string; providerId?: string; kind?: string },
  ): Promise<ConsumeMessageDecision> {
    // Handle concurrent redelivery race on inbox primary key
    if (error instanceof UniqueConstraintError) {
      const winnerInbox = await this.inboxRepo.findByConsumerAndMessageId(
        this.consumerName,
        logicalMessageId,
      );
      if (winnerInbox) {
        if (winnerInbox.matchesPayload(inboxPayloadHash) && winnerInbox.isProcessed()) {
          return {
            disposition: "ack",
            reason: "DUPLICATE_INBOX",
            logicalMessageId,
            correlationId,
            ...meta,
          };
        }
        if (!winnerInbox.matchesPayload(inboxPayloadHash)) {
          return {
            disposition: "dlq",
            category: "PERMANENT",
            reason: "INBOX_PAYLOAD_MISMATCH",
            errorMessage: `Message "${logicalMessageId}" payload conflicts with existing inbox record`,
            logicalMessageId,
            correlationId,
            ...meta,
          };
        }
      }
      if (error.constraint === "uq_transactions_provider_ext_id") {
        // Could be either concurrent identical idempotencyKey or duplicate external tx;
        // if receiveCount allows, one fast retry resolves deterministically via checkExisting.
        if (receiveCount < this.retryPolicy.maxReceiveCount) {
          return {
            disposition: "retry",
            reason: "CONCURRENT_UNIQUE_RACE",
            errorMessage: error.message,
            logicalMessageId,
            correlationId,
            backoffSeconds: this.computeBackoffSeconds(receiveCount),
            ...meta,
          };
        }
      }
    }

    // Permanent contract, domain, or conflict errors -> immediate DLQ (no wasted retries)
    if (
      error instanceof InboxPayloadMismatchError ||
      error instanceof ValidationError ||
      error instanceof DomainError ||
      error instanceof IdempotencyConflictError ||
      error instanceof DuplicateExternalTransactionError ||
      error instanceof WalletNotFoundError
    ) {
      const code =
        "code" in error && typeof error.code === "string" ? error.code : "PERMANENT_ERROR";
      return {
        disposition: "dlq",
        category: "PERMANENT",
        reason: code,
        errorMessage: error.message,
        logicalMessageId,
        correlationId,
        ...meta,
      };
    }

    // Transient / infrastructure errors -> retry with exponential backoff up to maxReceiveCount
    const reason =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "TRANSIENT_PROCESSING_ERROR";
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (receiveCount >= this.retryPolicy.maxReceiveCount) {
      return {
        disposition: "dlq",
        category: "MAX_RETRIES_EXCEEDED",
        reason,
        errorMessage,
        logicalMessageId,
        correlationId,
        ...meta,
      };
    }

    return {
      disposition: "retry",
      reason,
      errorMessage,
      logicalMessageId,
      correlationId,
      backoffSeconds: this.computeBackoffSeconds(receiveCount),
      ...meta,
    };
  }

  private finalizeDecision(
    decision: ConsumeMessageDecision,
    startedAt: number,
  ): ConsumeMessageDecision {
    this.metrics.recordProcessingDuration("sqs_wager", performance.now() - startedAt);

    if (decision.disposition === "ack") {
      if (decision.reason === "DUPLICATE_INBOX") {
        this.metrics.recordDuplicateDetected("sqs_inbox");
      } else if (decision.result) {
        if (decision.result.idempotentReplay) {
          this.metrics.recordDuplicateDetected("sqs_idempotency");
        } else {
          this.metrics.recordTransactionOutcome({
            status: decision.result.status,
            kind: decision.kind ?? "UNKNOWN",
            channel: "sqs",
            failureCode: decision.result.failureCode,
          });
        }
      }
    } else if (decision.disposition === "retry") {
      this.metrics.recordRetry("sqs_consumer", decision.reason);
    } else if (decision.disposition === "dlq") {
      this.metrics.recordDlqMessage(decision.category, decision.reason);
    }

    return decision;
  }

  private computeBackoffSeconds(receiveCount: number): number {
    const exponent = Math.min(Math.max(0, receiveCount - 1), 10);
    const delay = this.retryPolicy.baseDelaySeconds * 2 ** exponent;
    return Math.min(delay, this.retryPolicy.maxDelaySeconds);
  }
}
