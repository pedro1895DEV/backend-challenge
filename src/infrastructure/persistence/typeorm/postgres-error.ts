const TRANSIENT_PG_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
]);

const TRANSIENT_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
]);

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  driverError?: PgLikeError;
  cause?: PgLikeError;
}

function unwrapDriverError(error: unknown): PgLikeError | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as PgLikeError;
  return candidate.driverError ?? candidate;
}

export function getUniqueConstraintName(error: unknown): string | undefined {
  const pg = unwrapDriverError(error);
  if (!pg || pg.code !== "23505") return undefined;
  return typeof pg.constraint === "string" ? pg.constraint : "";
}

export function isUniqueConstraintViolation(error: unknown, constraintName?: string): boolean {
  const pg = unwrapDriverError(error);
  if (!pg || pg.code !== "23505") return false;
  if (constraintName === undefined) return true;
  return pg.constraint === constraintName;
}

const LOCK_CONFLICT_PG_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (lock_timeout)
]);

export function isDatabaseLockConflictError(error: unknown): boolean {
  const pg = unwrapDriverError(error);
  return Boolean(pg && typeof pg.code === "string" && LOCK_CONFLICT_PG_CODES.has(pg.code));
}

export function isTransientDatabaseError(error: unknown): boolean {
  const pg = unwrapDriverError(error);
  if (!pg) return false;

  if (typeof pg.code === "string") {
    if (TRANSIENT_PG_CODES.has(pg.code) || pg.code.startsWith("08")) return true;
    if (TRANSIENT_NODE_CODES.has(pg.code)) return true;
  }

  const nestedCode = pg.cause?.code;
  if (typeof nestedCode === "string" && TRANSIENT_NODE_CODES.has(nestedCode)) {
    return true;
  }

  if (typeof pg.message === "string") {
    if (
      /Connection terminated|timeout expired|connect ECONNREFUSED|terminating connection/i.test(
        pg.message,
      )
    ) {
      return true;
    }
  }

  return false;
}
