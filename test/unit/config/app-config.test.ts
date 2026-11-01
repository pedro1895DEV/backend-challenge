import { describe, expect, it } from "bun:test";
import { ConfigValidationError, loadConfig, type EnvSource } from "../../../src/config/app-config";

const validEnv: EnvSource = {
  NODE_ENV: "test",
  PORT: "4000",
  DB_HOST: "localhost",
  DB_PORT: "5433",
  DB_USER: "user",
  DB_PASSWORD: "secret",
  DB_NAME: "db",
};

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    expect(loadConfig(validEnv)).toEqual({
      nodeEnv: "test",
      port: 4000,
      database: { host: "localhost", port: 5433, user: "user", password: "secret", name: "db" },
      sqs: {
        region: "us-east-1",
        endpoint: undefined,
        queueName: "wager-transactions.fifo",
        dlqName: "wager-transactions-dlq.fifo",
        outboxQueueName: "wager-events.fifo",
      },
    });
  });

  it("parses SQS settings", () => {
    const config = loadConfig({
      ...validEnv,
      AWS_REGION: "sa-east-1",
      AWS_ENDPOINT_URL: "http://localhost:4566",
      SQS_QUEUE_NAME: "q.fifo",
      SQS_DLQ_NAME: "dlq.fifo",
      SQS_OUTBOX_QUEUE_NAME: "events.fifo",
    });
    expect(config.sqs).toEqual({
      region: "sa-east-1",
      endpoint: "http://localhost:4566",
      queueName: "q.fifo",
      dlqName: "dlq.fifo",
      outboxQueueName: "events.fifo",
    });
  });

  it("rejects an invalid SQS endpoint and non-FIFO queue names", () => {
    try {
      loadConfig({ ...validEnv, AWS_ENDPOINT_URL: "localhost:4566", SQS_QUEUE_NAME: "standard" });
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      expect((error as ConfigValidationError).issues).toEqual([
        'AWS_ENDPOINT_URL must be an http(s) URL, got "localhost:4566"',
        'SQS_QUEUE_NAME must be a FIFO queue name ending in ".fifo"',
      ]);
    }
  });

  it("applies defaults for NODE_ENV, PORT and DB_PORT", () => {
    const config = loadConfig({ ...validEnv, NODE_ENV: undefined, PORT: undefined, DB_PORT: "" });
    expect(config.nodeEnv).toBe("development");
    expect(config.port).toBe(3000);
    expect(config.database.port).toBe(5432);
  });

  it("reports every missing required variable at once", () => {
    try {
      loadConfig({ NODE_ENV: "test" });
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toEqual([
        "DB_HOST is required",
        "DB_USER is required",
        "DB_PASSWORD is required",
        "DB_NAME is required",
      ]);
    }
  });

  it.each(["abc", "1.5", "0", "70000", "-1"])("rejects invalid port %p", (port) => {
    expect(() => loadConfig({ ...validEnv, PORT: port })).toThrow(ConfigValidationError);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
