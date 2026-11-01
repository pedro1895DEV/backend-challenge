import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type {
  ConsumeMessageDecision,
  ConsumeWagerMessageUseCase,
} from "../../application/use-cases/consume-wager-message.use-case";
import type { AppConfig } from "../../config/app-config";
import { APP_CONFIG } from "../../config/config.module";
import { CONSUME_WAGER_MESSAGE_USE_CASE } from "../http/use-case.tokens";
import { SqsService, type ReceivedSqsMessage } from "../messaging/sqs/sqs.service";

export interface ProcessSqsBatchOptions {
  queueName?: string;
  dlqName?: string;
  maxMessages?: number;
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
  /**
   * Optional lifecycle hook invoked strictly AFTER PostgreSQL COMMIT and BEFORE
   * SQS `DeleteMessage` (ack), enabling deterministic crash-recovery tests for
   * README §13 item 5 ("worker killed after commit and before ack").
   */
  afterCommitBeforeAck?: (
    message: ReceivedSqsMessage,
    decision: ConsumeMessageDecision,
  ) => Promise<void>;
}

/**
 * Long-polling SQS FIFO consumer for `wager-transactions.fifo` (README §10).
 *
 * Guarantees:
 *  - Calls `DeleteMessage` (ack) **strictly after** PostgreSQL transaction commit.
 *  - Business outcomes (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`) and
 *    deduplicated inbox redeliveries are ACKed.
 *  - Transient failures extend/adjust visibility with exponential backoff via
 *    `ChangeMessageVisibility` up to `maxReceiveCount`, then move to DLQ.
 *  - Permanent failures (malformed JSON, invalid envelope/domain contract,
 *    idempotency payload conflict) move immediately to `wager-transactions-dlq.fifo`
 *    and are ACKed from the main queue so the FIFO `MessageGroupId` does not stall.
 *  - On `SIGTERM` (`onModuleDestroy`), aborts idle long-polling, awaits the
 *    in-flight message up to the shutdown grace window (or releases its
 *    visibility on timeout), and releases visibility (`VisibilityTimeout = 0`)
 *    for any fetched messages that had not started processing yet.
 */
@Injectable()
export class SqsWagerConsumerWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("SqsWagerConsumerWorker");
  private loopPromise: Promise<void> | null = null;
  private pollAbortController: AbortController | null = null;
  private currentInFlight: {
    queueName: string;
    receiptHandle: string;
    promise: Promise<void>;
  } | null = null;
  private stopping = false;

  constructor(
    private readonly sqsService: SqsService,
    @Inject(CONSUME_WAGER_MESSAGE_USE_CASE)
    private readonly consumeUseCase: ConsumeWagerMessageUseCase,
    @Inject(APP_CONFIG)
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = (process.env.SQS_CONSUMER_ENABLED ?? "true").trim().toLowerCase();
    if (enabled === "false" || enabled === "0") return;

    this.stopping = false;
    this.loopPromise = this.runLoop();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async stop(graceTimeoutMs = 20_000): Promise<void> {
    this.stopping = true;
    this.pollAbortController?.abort();

    if (this.currentInFlight) {
      const active = this.currentInFlight;
      let timedOut = false;
      await Promise.race([
        active.promise,
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            timedOut = true;
            resolve();
          }, graceTimeoutMs);
          t.unref?.();
        }),
      ]);

      if (timedOut) {
        await this.releaseVisibilitySafely(active.queueName, active.receiptHandle);
      }
    }

    if (this.loopPromise) {
      await Promise.race([
        this.loopPromise,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2_000);
          t.unref?.();
        }),
      ]);
      this.loopPromise = null;
    }
  }

  async processBatchOnce(opts?: ProcessSqsBatchOptions): Promise<number> {
    const queueName = opts?.queueName ?? this.config.sqs.queueName;
    const dlqName = opts?.dlqName ?? this.config.sqs.dlqName;
    const waitTimeSeconds =
      opts?.waitTimeSeconds ?? (this.config.nodeEnv === "test" ? 0 : 2);

    this.pollAbortController = new AbortController();
    let messages: ReceivedSqsMessage[];
    try {
      messages = await this.sqsService.receiveMessages(queueName, {
        maxMessages: opts?.maxMessages ?? 10,
        waitTimeSeconds,
        visibilityTimeoutSeconds: opts?.visibilityTimeoutSeconds,
        autoCreateFifo: false,
        abortSignal: this.pollAbortController.signal,
      });
    } catch (error) {
      if (this.stopping || isAbortError(error)) return 0;
      throw error;
    } finally {
      this.pollAbortController = null;
    }

    let handled = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;

      // If SIGTERM arrived before starting this message, return visibility (0s)
      // for it and all remaining messages in the batch immediately.
      if (this.stopping) {
        await Promise.all(
          messages
            .slice(i)
            .map((unstarted) =>
              this.releaseVisibilitySafely(queueName, unstarted.receiptHandle),
            ),
        );
        break;
      }

      const workPromise = this.handleSingleMessage(queueName, dlqName, msg, opts);
      this.currentInFlight = {
        queueName,
        receiptHandle: msg.receiptHandle,
        promise: workPromise,
      };
      try {
        await workPromise;
        handled += 1;
      } finally {
        this.currentInFlight = null;
      }
    }

    return handled;
  }

  private async handleSingleMessage(
    queueName: string,
    dlqName: string,
    msg: ReceivedSqsMessage,
    opts?: ProcessSqsBatchOptions,
  ): Promise<void> {
    const decision = await this.consumeUseCase.execute({
      transportMessageId: msg.transportMessageId,
      body: msg.body,
      receiveCount: msg.receiveCount,
      messageGroupId: msg.messageGroupId,
    });

    if (decision.disposition === "ack") {
      if (opts?.afterCommitBeforeAck) {
        await opts.afterCommitBeforeAck(msg, decision);
      }
      await this.sqsService.deleteMessage(queueName, msg.receiptHandle);

      this.logger.log(
        JSON.stringify({
          event: "sqs_message_acked",
          correlationId: decision.correlationId,
          messageId: decision.logicalMessageId,
          transactionId: decision.result?.transactionId ?? null,
          walletId: decision.walletId ?? null,
          providerId: decision.providerId ?? null,
          reason: decision.reason,
          status: decision.result?.status ?? null,
          failureCode: decision.result?.failureCode ?? null,
          idempotentReplay: decision.result?.idempotentReplay ?? null,
        }),
      );
      return;
    }

    if (decision.disposition === "dlq") {
      await this.sqsService.sendFifoMessage(dlqName, {
        body: msg.body,
        messageGroupId:
          msg.messageGroupId || decision.logicalMessageId || msg.transportMessageId || "dlq",
        messageDeduplicationId: `dlq:${decision.logicalMessageId || msg.transportMessageId}:${msg.receiveCount}`,
        attributes: {
          FailureCategory: decision.category,
          FailureReason: decision.reason,
          ErrorMessage: decision.errorMessage,
          OriginalTransportMessageId: msg.transportMessageId,
          ReceiveCount: String(msg.receiveCount),
          CorrelationId: decision.correlationId,
        },
      });
      await this.sqsService.deleteMessage(queueName, msg.receiptHandle);

      this.logger.warn(
        JSON.stringify({
          event: "sqs_message_routed_to_dlq",
          correlationId: decision.correlationId,
          messageId: decision.logicalMessageId ?? msg.transportMessageId,
          transactionId: null,
          walletId: decision.walletId ?? null,
          providerId: decision.providerId ?? null,
          category: decision.category,
          reason: decision.reason,
          receiveCount: msg.receiveCount,
        }),
      );
      return;
    }

    // Transient failure -> adjust visibility timeout with exponential backoff (NO ack)
    await this.sqsService.changeMessageVisibility(
      queueName,
      msg.receiptHandle,
      decision.backoffSeconds,
    );

    this.logger.warn(
      JSON.stringify({
        event: "sqs_message_retry_scheduled",
        correlationId: decision.correlationId,
        messageId: decision.logicalMessageId ?? msg.transportMessageId,
        transactionId: null,
        walletId: decision.walletId ?? null,
        providerId: decision.providerId ?? null,
        reason: decision.reason,
        receiveCount: msg.receiveCount,
        backoffSeconds: decision.backoffSeconds,
      }),
    );
  }

  private async runLoop(): Promise<void> {
    const idleSleepMs = this.config.nodeEnv === "test" ? 100 : 250;
    while (!this.stopping) {
      try {
        const count = await this.processBatchOnce();
        if (count === 0 && !this.stopping) {
          await sleep(idleSleepMs);
        }
      } catch (error) {
        if (this.stopping) break;
        this.logger.error(
          JSON.stringify({
            event: "sqs_consumer_poll_error",
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
        );
        await sleep(500);
      }
    }
  }

  private async releaseVisibilitySafely(
    queueName: string,
    receiptHandle: string,
  ): Promise<void> {
    try {
      await this.sqsService.changeMessageVisibility(queueName, receiptHandle, 0);
      this.logger.log(
        JSON.stringify({
          event: "sqs_message_visibility_released",
          queueName,
        }),
      );
    } catch {
      // Best-effort on shutdown; SQS visibility timeout remains the fallback
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
