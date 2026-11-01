import { ValidationError } from "../errors/application-errors";
import type { MoneyProps } from "../../domain/money/money";

export function requireNonEmptyString(
  value: unknown,
  fieldName: string,
  maxLength: number,
  errorCode = "VALIDATION_ERROR",
): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`, errorCode);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${fieldName} is required`, errorCode);
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(
      `${fieldName} must be at most ${maxLength} characters`,
      errorCode,
    );
  }
  return trimmed;
}

export function optionalTrimmedString(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${fieldName} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function requireMoneyProps(value: unknown, fieldName: string): MoneyProps {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an object with amount and currency`);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.amount !== "string") {
    throw new ValidationError(
      `${fieldName}.amount must be a decimal string (numbers are not accepted for monetary values)`,
      "INVALID_MONEY",
    );
  }
  if (typeof candidate.currency !== "string") {
    throw new ValidationError(`${fieldName}.currency must be an ISO-4217 string`, "INVALID_MONEY");
  }
  return { amount: candidate.amount, currency: candidate.currency };
}
