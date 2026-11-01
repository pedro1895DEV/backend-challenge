import { describe, expect, it } from "bun:test";
import { BadRequestException, type ArgumentsHost } from "@nestjs/common";
import {
  DuplicateExternalTransactionError,
  DuplicateWalletError,
  ForbiddenProviderError,
  IdempotencyConflictError,
  TransientInfrastructureError,
  UnauthenticatedError,
  ValidationError,
  WagerTransactionNotFoundError,
  WalletNotFoundError,
} from "../../../src/application/errors/application-errors";
import { InvalidMoneyError } from "../../../src/domain/shared/errors";
import {
  GlobalHttpExceptionFilter,
  type HttpErrorEnvelope,
} from "../../../src/infrastructure/http/filters/http-exception.filter";

function invokeFilter(
  exception: unknown,
  headers: Record<string, string> = {},
): {
  statusCode: number;
  headers: Record<string, string>;
  body: HttpErrorEnvelope;
} {
  const filter = new GlobalHttpExceptionFilter();
  let statusCode = 200;
  const responseHeaders: Record<string, string> = {};
  let capturedBody: unknown;

  const mockResponse = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      responseHeaders[name.toLowerCase()] = value;
    },
    json(body: unknown) {
      capturedBody = body;
    },
  };

  const mockHost = {
    switchToHttp: () => ({
      getRequest: () => ({ headers, method: "POST", url: "/wagering/transactions" }),
      getResponse: () => mockResponse,
    }),
  } as unknown as ArgumentsHost;

  filter.catch(exception, mockHost);

  return {
    statusCode,
    headers: responseHeaders,
    body: capturedBody as HttpErrorEnvelope,
  };
}

describe("GlobalHttpExceptionFilter", () => {
  it("maps ValidationError to 400 Bad Request with details and echoes X-Correlation-Id", () => {
    const res = invokeFilter(
      new ValidationError("Invalid money payload", "INVALID_MONEY", ["amount must be string"]),
      { "x-correlation-id": "corr-123" },
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers["x-correlation-id"]).toBe("corr-123");
    expect(res.body).toEqual({
      error: {
        code: "INVALID_MONEY",
        message: "Invalid money payload",
        retryable: false,
        correlationId: "corr-123",
        details: ["amount must be string"],
      },
    });
  });

  it("maps DomainError (e.g. InvalidMoneyError) to 400 Bad Request", () => {
    const res = invokeFilter(new InvalidMoneyError("More than 2 decimal places"));
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MONEY");
    expect(res.body.error.retryable).toBe(false);
    expect(res.body.error.correlationId).toHaveLength(36);
  });

  it("maps NestJS BadRequestException (malformed JSON) to 400 INVALID_PAYLOAD", () => {
    const res = invokeFilter(new BadRequestException("Unexpected token } in JSON"));
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
    expect(res.body.error.retryable).toBe(false);
  });

  it("maps UnauthenticatedError to 401 and ForbiddenProviderError to 403", () => {
    const unauth = invokeFilter(new UnauthenticatedError());
    expect(unauth.statusCode).toBe(401);
    expect(unauth.body.error.code).toBe("UNAUTHENTICATED");

    const forbidden = invokeFilter(new ForbiddenProviderError("provider-a", "provider-b"));
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body.error.code).toBe("PROVIDER_IDENTITY_MISMATCH");
  });

  it("maps WalletNotFoundError and WagerTransactionNotFoundError to 404", () => {
    expect(invokeFilter(new WalletNotFoundError("w-1")).statusCode).toBe(404);
    expect(invokeFilter(new WagerTransactionNotFoundError("tx-1")).statusCode).toBe(404);
  });

  it("maps idempotency, external tx, and wallet conflicts to 409 Conflict", () => {
    const idem = invokeFilter(new IdempotencyConflictError("key-1"));
    expect(idem.statusCode).toBe(409);
    expect(idem.body.error.code).toBe("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");

    const dupExt = invokeFilter(new DuplicateExternalTransactionError("prov-a", "tx-1"));
    expect(dupExt.statusCode).toBe(409);
    expect(dupExt.body.error.code).toBe("DUPLICATE_EXTERNAL_TRANSACTION");

    const dupWallet = invokeFilter(new DuplicateWalletError("player-1", "BRL"));
    expect(dupWallet.statusCode).toBe(409);
    expect(dupWallet.body.error.code).toBe("DUPLICATE_WALLET");
  });

  it("maps TransientInfrastructureError and PG lock/connection errors to 503 with Retry-After", () => {
    const transient = invokeFilter(new TransientInfrastructureError("DB lock timeout", 3));
    expect(transient.statusCode).toBe(503);
    expect(transient.headers["retry-after"]).toBe("3");
    expect(transient.body.error.code).toBe("TRANSIENT_INFRASTRUCTURE_ERROR");
    expect(transient.body.error.retryable).toBe(true);

    const pgLockError = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });
    const pgRes = invokeFilter(pgLockError);
    expect(pgRes.statusCode).toBe(503);
    expect(pgRes.headers["retry-after"]).toBe("1");
    expect(pgRes.body.error.retryable).toBe(true);
  });

  it("maps unexpected errors to 500 without leaking internal details", () => {
    const res = invokeFilter(new Error("SELECT * FROM secret_table failed"));
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(res.body.error.message).toBe("An unexpected internal error occurred");
    expect(res.body.error.retryable).toBe(false);
  });
});
