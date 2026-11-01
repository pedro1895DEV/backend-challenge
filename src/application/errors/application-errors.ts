/**
 * Application-layer error hierarchy.
 *
 * Transport-agnostic: HTTP maps these to deterministic status codes (§9) and
 * SQS maps them to ack / retry / DLQ (§10) without parsing error strings.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly code: string;
  readonly details: readonly string[] | undefined;

  constructor(
    message: string,
    code = "VALIDATION_ERROR",
    details?: readonly string[],
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class UnauthenticatedError extends ApplicationError {
  readonly code = "UNAUTHENTICATED";

  constructor(message = "Authentication required") {
    super(message);
  }
}

export class ForbiddenProviderError extends ApplicationError {
  readonly code = "PROVIDER_IDENTITY_MISMATCH";

  constructor(authenticatedProviderId: string, requestedProviderId: string) {
    super(
      `Authenticated provider "${authenticatedProviderId}" is not authorized to act as "${requestedProviderId}"`,
    );
  }
}

export abstract class ResourceNotFoundError extends ApplicationError {}

export class WalletNotFoundError extends ResourceNotFoundError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(public readonly walletId: string) {
    super(`Wallet "${walletId}" was not found`);
  }
}

export class WagerTransactionNotFoundError extends ResourceNotFoundError {
  readonly code = "TRANSACTION_NOT_FOUND";

  constructor(identifier: string) {
    super(`Wager transaction "${identifier}" was not found`);
  }
}

export abstract class ConflictError extends ApplicationError {}

export class DuplicateWalletError extends ConflictError {
  readonly code = "DUPLICATE_WALLET";

  constructor(
    public readonly playerId: string,
    public readonly currency: string,
  ) {
    super(`Wallet already exists for player "${playerId}" and currency "${currency}"`);
  }
}

export class IdempotencyConflictError extends ConflictError {
  readonly code = "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH";

  constructor(public readonly idempotencyKey: string) {
    super(
      `Idempotency-Key "${idempotencyKey}" was already used with a different business payload`,
    );
  }
}

export class DuplicateExternalTransactionError extends ConflictError {
  readonly code = "DUPLICATE_EXTERNAL_TRANSACTION";

  constructor(
    public readonly providerId: string,
    public readonly externalTransactionId: string,
  ) {
    super(
      `External transaction "${externalTransactionId}" for provider "${providerId}" already exists under a different Idempotency-Key`,
    );
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TRANSIENT_INFRASTRUCTURE_ERROR";

  constructor(
    message: string,
    public readonly retryAfterSeconds = 1,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

/**
 * Raised by persistence adapters when a database unique constraint fires,
 * allowing application use cases to handle races without importing driver code.
 */
export class UniqueConstraintError extends ApplicationError {
  readonly code = "UNIQUE_CONSTRAINT_VIOLATION";

  constructor(
    public readonly constraint: string | undefined,
    cause?: unknown,
  ) {
    super(`Unique constraint violation${constraint ? `: ${constraint}` : ""}`, {
      cause,
    });
  }
}
