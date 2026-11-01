import { Injectable, type LoggerService } from "@nestjs/common";

export type LogLevelName = "info" | "warn" | "error" | "debug" | "verbose";

export type LogSink = (jsonLine: string, level: LogLevelName) => void;

/**
 * Keys that must NEVER appear in application logs (README §12):
 *  - authentication / credential secrets
 *  - full financial payloads and monetary amounts
 */
const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "secret",
  "clientsecret",
  "client_secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "apikey",
  "api_key",
  "x-api-key",
  "money",
  "amount",
  "balance",
  "initialbalance",
  "storedbalance",
  "calculatedbalance",
  "difference",
  "balancebefore",
  "balanceafter",
  "payload",
  "body",
  "rawbody",
  "data",
]);

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[Truncated]";
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      errorName: value.name,
      errorMessage: value.message,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(normalizeKey(k))) {
        continue;
      }
      out[k] = sanitizeLogValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

const defaultSink: LogSink = (jsonLine, level) => {
  if (level === "error") {
    process.stderr.write(`${jsonLine}\n`);
  } else {
    process.stdout.write(`${jsonLine}\n`);
  }
};

/**
 * Structured single-line JSON logger for NestJS and background workers (README §12).
 *
 * Guarantees:
 *  - Valid single-line JSON output with `timestamp`, `level`, `context`, and correlation IDs.
 *  - Automatic unwrapping of pre-serialized JSON strings (prevents double-encoding).
 *  - Recursive stripping of sensitive credentials and financial payloads (`money`, `amount`, `balance`, etc.).
 */
@Injectable()
export class StructuredJsonLogger implements LoggerService {
  private readonly sink: LogSink;

  constructor(sink?: LogSink) {
    this.sink = sink ?? defaultSink;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("info", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("verbose", message, optionalParams);
  }

  private emit(level: LogLevelName, message: unknown, optionalParams: unknown[]): void {
    let context: string | null = null;
    let stack: string | undefined;

    if (optionalParams.length > 0) {
      const last = optionalParams[optionalParams.length - 1];
      if (typeof last === "string") {
        context = last;
      }
      if (level === "error" && optionalParams.length >= 2 && typeof optionalParams[0] === "string") {
        stack = optionalParams[0];
      }
    }

    const extracted = this.extractFields(message);
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      context,
      ...extracted,
    };

    if (stack) {
      record.stack = stack;
    }

    this.sink(JSON.stringify(record), level);
  }

  private extractFields(message: unknown): Record<string, unknown> {
    if (typeof message === "string") {
      const trimmed = message.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return sanitizeLogValue(parsed) as Record<string, unknown>;
          }
        } catch {
          // Plain text string starting with '{' — fall through
        }
      }
      return { message };
    }

    if (message && typeof message === "object" && !Array.isArray(message)) {
      if (message instanceof Error) {
        return {
          event: "error",
          errorName: message.name,
          message: message.message,
        };
      }
      return sanitizeLogValue(message) as Record<string, unknown>;
    }

    return { message: String(message) };
  }
}
