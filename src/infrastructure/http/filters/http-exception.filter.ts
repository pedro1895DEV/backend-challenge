import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import {
  ConflictError,
  ForbiddenProviderError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  UnauthenticatedError,
  ValidationError,
} from "../../../application/errors/application-errors";
import type { HttpHeadersMap } from "../../../application/ports/provider-identity.port";
import { DomainError } from "../../../domain/shared/errors";
import { isTransientDatabaseError } from "../../persistence/typeorm/postgres-error";
import { resolveCorrelationId, type MinimalHttpResponse } from "../correlation-id";

export interface HttpErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    correlationId: string;
    details?: readonly string[];
  };
}

/**
 * Deterministic HTTP status and error mapping (README §9):
 *  - 400: syntactic / contract / domain input validation failure
 *  - 401: missing or invalid authentication credentials
 *  - 403: authenticated provider acting outside its own providerId
 *  - 404: wallet or transaction not found
 *  - 409: idempotency payload conflict, duplicate external tx, or duplicate wallet
 *  - 503: transient database / broker unavailability (includes `Retry-After`)
 *  - 500: unexpected internal failure
 *
 * Business rule rejections (`REJECTED` transactions) are NOT exceptions: they
 * commit in PostgreSQL and return `422 Unprocessable Entity` from the controller.
 */
@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("HttpExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ headers?: HttpHeadersMap; method?: string; url?: string }>();
    const response = http.getResponse<MinimalHttpResponse & { json(body: unknown): void }>();

    const correlationId = resolveCorrelationId(request.headers ?? {}, response);

    // Preserve structured NestJS HttpExceptions (e.g. /health/ready 503, 404 unknown route, malformed JSON 400)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const rawResponse = exception.getResponse();

      // Keep `/health/ready` payload verbatim when degraded
      if (
        status === HttpStatus.SERVICE_UNAVAILABLE &&
        rawResponse &&
        typeof rawResponse === "object" &&
        "components" in rawResponse
      ) {
        response.status(status).json(rawResponse);
        return;
      }

      const message =
        typeof rawResponse === "string"
          ? rawResponse
          : typeof (rawResponse as { message?: unknown })?.message === "string"
            ? ((rawResponse as { message: string }).message)
            : exception.message;

      const code =
        status === HttpStatus.BAD_REQUEST
          ? "INVALID_PAYLOAD"
          : status === HttpStatus.NOT_FOUND
            ? "ROUTE_NOT_FOUND"
            : `HTTP_${status}`;

      response.status(status).json({
        error: {
          code,
          message,
          retryable: status === HttpStatus.SERVICE_UNAVAILABLE,
          correlationId,
        },
      } satisfies HttpErrorEnvelope);
      return;
    }

    if (exception instanceof ValidationError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
          ...(exception.details ? { details: exception.details } : {}),
        },
      } satisfies HttpErrorEnvelope);
      return;
    }

    if (exception instanceof DomainError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
        },
      } satisfies HttpErrorEnvelope);
      return;
    }

    if (exception instanceof UnauthenticatedError) {
      response.status(HttpStatus.UNAUTHORIZED).json({
        error: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
        },
      } satisfies HttpErrorEnvelope);
      return;
    }

    if (exception instanceof ForbiddenProviderError) {
      response.status(HttpStatus.FORBIDDEN).json({
        error: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
        },
      } satisfies HttpErrorEnvelope);
      return;
    }

    if (exception instanceof ResourceNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        error: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
        },
      } satisfies HttpErrorEnvelope);
      return;
    }

    if (exception instanceof ConflictError) {
      response.status(HttpStatus.CONFLICT).json({
        error: {
          code: exception.code,
          message: exception.message,
          retryable: false,
          correlationId,
        },
      } satisfies HttpErrorEnvelope);
      return;
    }

    if (exception instanceof TransientInfrastructureError || isTransientDatabaseError(exception)) {
      const retryAfter =
        exception instanceof TransientInfrastructureError ? exception.retryAfterSeconds : 1;
      response.setHeader("Retry-After", String(retryAfter));
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: {
          code: "TRANSIENT_INFRASTRUCTURE_ERROR",
          message: "Service temporarily unavailable; safe to retry with the same Idempotency-Key",
          retryable: true,
          correlationId,
        },
      } satisfies HttpErrorEnvelope);
      return;
    }

    this.logger.error(
      JSON.stringify({
        event: "unhandled_http_exception",
        correlationId,
        method: request.method ?? null,
        path: request.url ?? null,
        errorName: exception instanceof Error ? exception.name : "UnknownError",
        errorMessage: exception instanceof Error ? exception.message : String(exception),
      }),
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected internal error occurred",
        retryable: false,
        correlationId,
      },
    } satisfies HttpErrorEnvelope);
  }
}
