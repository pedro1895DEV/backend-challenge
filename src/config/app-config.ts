/**
 * Typed, validated application configuration.
 *
 * Parsing is a pure function over an env-like record so it can be unit-tested
 * without touching `process.env`. The app fails fast at boot on invalid config.
 */

export type NodeEnv = "development" | "test" | "production";

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly name: string;
}

export interface SqsConfig {
  readonly region: string;
  /** Custom endpoint (MiniStack/LocalStack). Undefined → real AWS. */
  readonly endpoint: string | undefined;
  readonly queueName: string;
  readonly dlqName: string;
  readonly outboxQueueName: string;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly database: DatabaseConfig;
  readonly sqs: SqsConfig;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class ConfigValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid configuration:\n - ${issues.join("\n - ")}`);
    this.name = "ConfigValidationError";
  }
}

const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];

export function loadConfig(env: EnvSource): AppConfig {
  const issues: string[] = [];

  const requireString = (key: string, fallback?: string): string => {
    const raw = env[key]?.trim();
    if (raw) return raw;
    if (fallback !== undefined) return fallback;
    issues.push(`${key} is required`);
    return "";
  };

  const requirePort = (key: string, fallback: number): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw)) {
      issues.push(`${key} must be an integer, got "${raw}"`);
      return fallback;
    }
    const value = Number(raw);
    if (value < 1 || value > 65_535) {
      issues.push(`${key} must be between 1 and 65535, got ${value}`);
      return fallback;
    }
    return value;
  };

  const optionalUrl = (key: string): string | undefined => {
    const raw = env[key]?.trim();
    if (!raw) return undefined;
    if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol)) {
      issues.push(`${key} must be an http(s) URL, got "${raw}"`);
      return undefined;
    }
    return raw;
  };

  const requireFifoQueue = (key: string, fallback: string): string => {
    const value = requireString(key, fallback);
    if (!value.endsWith(".fifo")) issues.push(`${key} must be a FIFO queue name ending in ".fifo"`);
    return value;
  };

  const rawNodeEnv = requireString("NODE_ENV", "development");
  if (!NODE_ENVS.includes(rawNodeEnv as NodeEnv)) {
    issues.push(`NODE_ENV must be one of ${NODE_ENVS.join(", ")}, got "${rawNodeEnv}"`);
  }

  const config: AppConfig = {
    nodeEnv: rawNodeEnv as NodeEnv,
    port: requirePort("PORT", 3000),
    database: {
      host: requireString("DB_HOST"),
      port: requirePort("DB_PORT", 5432),
      user: requireString("DB_USER"),
      password: requireString("DB_PASSWORD"),
      name: requireString("DB_NAME"),
    },
    sqs: {
      region: requireString("AWS_REGION", "us-east-1"),
      endpoint: optionalUrl("AWS_ENDPOINT_URL"),
      queueName: requireFifoQueue("SQS_QUEUE_NAME", "wager-transactions.fifo"),
      dlqName: requireFifoQueue("SQS_DLQ_NAME", "wager-transactions-dlq.fifo"),
      outboxQueueName: requireFifoQueue("SQS_OUTBOX_QUEUE_NAME", "wager-events.fifo"),
    },
  };

  if (issues.length > 0) throw new ConfigValidationError(issues);
  return config;
}
