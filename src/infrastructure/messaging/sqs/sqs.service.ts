import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
  type MessageAttributeValue,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { AppConfig } from "../../../config/app-config";
import { APP_CONFIG } from "../../../config/config.module";

export interface ReceivedSqsMessage {
  transportMessageId: string;
  receiptHandle: string;
  body: string;
  receiveCount: number;
  messageGroupId?: string;
  attributes: Record<string, string>;
}

export interface SendFifoMessageParams {
  body: string;
  messageGroupId: string;
  messageDeduplicationId: string;
  attributes?: Record<string, string>;
}

export function sanitizeFifoToken(raw: string | undefined, fallback: string): string {
  const candidate = (raw ?? "").trim().replace(/[^a-zA-Z0-9\-_.:]/g, "_");
  const base = candidate.length > 0 ? candidate : fallback;
  if (base.length <= 128) return base;
  return createHash("sha256").update(base, "utf8").digest("hex");
}

@Injectable()
export class SqsService implements OnModuleDestroy {
  private readonly client: SQSClient;
  private readonly queueUrlCache = new Map<string, string>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = new SQSClient({
      region: config.sqs.region,
      ...(config.sqs.endpoint
        ? {
            endpoint: config.sqs.endpoint,
            useQueueUrlAsEndpoint: false,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim() || "test",
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY?.trim() || "test",
            },
          }
        : {}),
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.resolveQueueUrl(this.config.sqs.queueName, {
        autoCreateFifo: false,
        abortSignal: AbortSignal.timeout(2_000),
      });
      return true;
    } catch {
      return false;
    }
  }

  async resolveQueueUrl(
    queueName: string,
    opts?: { autoCreateFifo?: boolean; abortSignal?: AbortSignal },
  ): Promise<string> {
    const cached = this.queueUrlCache.get(queueName);
    if (cached) return cached;

    try {
      const response = await this.client.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
        opts?.abortSignal ? { abortSignal: opts.abortSignal } : undefined,
      );
      if (response.QueueUrl) {
        const normalized = this.normalizeQueueUrl(response.QueueUrl);
        this.queueUrlCache.set(queueName, normalized);
        return normalized;
      }
    } catch (error) {
      if (!opts?.autoCreateFifo) {
        throw error;
      }
    }

    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: queueName.endsWith(".fifo")
          ? {
              FifoQueue: "true",
              ContentBasedDeduplication: "false",
            }
          : undefined,
      }),
    );
    if (!created.QueueUrl) {
      throw new Error(`Failed to resolve or create SQS queue "${queueName}"`);
    }
    const normalized = this.normalizeQueueUrl(created.QueueUrl);
    this.queueUrlCache.set(queueName, normalized);
    return normalized;
  }

  async createFifoQueuePair(params: {
    queueName: string;
    dlqName: string;
    visibilityTimeoutSeconds?: number;
    maxReceiveCount?: number;
  }): Promise<{ queueUrl: string; dlqUrl: string }> {
    const dlqUrl = await this.resolveQueueUrl(params.dlqName, { autoCreateFifo: true });
    const dlqAttrs = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const dlqArn = dlqAttrs.Attributes?.QueueArn;

    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: params.queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: String(params.visibilityTimeoutSeconds ?? 30),
          ...(dlqArn
            ? {
                RedrivePolicy: JSON.stringify({
                  deadLetterTargetArn: dlqArn,
                  maxReceiveCount: String(params.maxReceiveCount ?? 5),
                }),
              }
            : {}),
        },
      }),
    );

    if (!created.QueueUrl) {
      throw new Error(`Failed to create FIFO queue "${params.queueName}"`);
    }
    const queueUrl = this.normalizeQueueUrl(created.QueueUrl);
    this.queueUrlCache.set(params.queueName, queueUrl);
    return { queueUrl, dlqUrl };
  }

  async receiveMessages(
    queueName: string,
    opts?: {
      maxMessages?: number;
      waitTimeSeconds?: number;
      visibilityTimeoutSeconds?: number;
      autoCreateFifo?: boolean;
      abortSignal?: AbortSignal;
    },
  ): Promise<ReceivedSqsMessage[]> {
    const queueUrl = await this.resolveQueueUrl(queueName, {
      autoCreateFifo: opts?.autoCreateFifo ?? true,
      abortSignal: opts?.abortSignal,
    });

    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: Math.min(Math.max(opts?.maxMessages ?? 10, 1), 10),
        WaitTimeSeconds: opts?.waitTimeSeconds ?? 1,
        ...(opts?.visibilityTimeoutSeconds !== undefined
          ? { VisibilityTimeout: opts.visibilityTimeoutSeconds }
          : {}),
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
      opts?.abortSignal ? { abortSignal: opts.abortSignal } : undefined,
    );

    const messages = response.Messages ?? [];
    return messages
      .filter((m) => Boolean(m.ReceiptHandle))
      .map((m) => {
        const rawCount = m.Attributes?.ApproximateReceiveCount;
        const parsedCount = rawCount && /^\d+$/.test(rawCount) ? Number(rawCount) : 1;
        const msgAttrs: Record<string, string> = {};
        if (m.MessageAttributes) {
          for (const [key, val] of Object.entries(m.MessageAttributes)) {
            if (val?.StringValue !== undefined) {
              msgAttrs[key] = val.StringValue;
            }
          }
        }
        return {
          transportMessageId: m.MessageId ?? "",
          receiptHandle: m.ReceiptHandle!,
          body: m.Body ?? "",
          receiveCount: Math.max(1, parsedCount),
          messageGroupId: m.Attributes?.MessageGroupId,
          attributes: msgAttrs,
        };
      });
  }

  async deleteMessage(queueName: string, receiptHandle: string): Promise<void> {
    const queueUrl = await this.resolveQueueUrl(queueName, { autoCreateFifo: false });
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async changeMessageVisibility(
    queueName: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    const queueUrl = await this.resolveQueueUrl(queueName, { autoCreateFifo: false });
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.floor(visibilityTimeoutSeconds)),
      }),
    );
  }

  async sendFifoMessage(queueName: string, params: SendFifoMessageParams): Promise<string> {
    const queueUrl = await this.resolveQueueUrl(queueName, { autoCreateFifo: true });
    const messageAttributes: Record<string, MessageAttributeValue> = {};
    if (params.attributes) {
      for (const [key, value] of Object.entries(params.attributes)) {
        if (value) {
          messageAttributes[key] = {
            DataType: "String",
            StringValue: value.slice(0, 256),
          };
        }
      }
    }

    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: params.body,
        MessageGroupId: sanitizeFifoToken(params.messageGroupId, "default-group"),
        MessageDeduplicationId: sanitizeFifoToken(
          params.messageDeduplicationId,
          crypto.randomUUID(),
        ),
        ...(Object.keys(messageAttributes).length > 0
          ? { MessageAttributes: messageAttributes }
          : {}),
      }),
    );

    return result.MessageId ?? "";
  }

  private normalizeQueueUrl(rawUrl: string): string {
    if (!this.config.sqs.endpoint) return rawUrl;
    try {
      const target = new URL(this.config.sqs.endpoint);
      const parsed = new URL(rawUrl);
      parsed.protocol = target.protocol;
      parsed.host = target.host;
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }
}
