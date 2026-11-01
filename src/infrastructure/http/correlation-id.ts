import type { HttpHeadersMap } from "../../application/ports/provider-identity.port";
import { generateUuidV7 } from "../../domain/shared/uuid-v7";

export const CORRELATION_ID_HEADER = "x-correlation-id";

export interface MinimalHttpResponse {
  status(code: number): this;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export function resolveCorrelationId(
  headers: HttpHeadersMap,
  response?: MinimalHttpResponse,
): string {
  const raw = headers[CORRELATION_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof candidate === "string" ? candidate.trim() : "";
  const correlationId = trimmed.length > 0 && trimmed.length <= 128 ? trimmed : generateUuidV7();
  response?.setHeader("X-Correlation-Id", correlationId);
  return correlationId;
}
