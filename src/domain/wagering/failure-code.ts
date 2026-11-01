/**
 * Stable, machine-readable failure codes (README §7.2).
 *
 * Split by type so the compiler enforces the state machine:
 *  - {@link BusinessFailureCode} → `REJECTED` (business rule violation)
 *  - {@link InfrastructureFailureCode} → `FAILED` (permanent infra error)
 *
 * Values are part of the public contract: never rename, only add.
 */
export enum BusinessFailureCode {
  /** BET larger than the available balance. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** REFUND/ROLLBACK whose debit would make the balance negative (distinct from a BET — §7 rule 9). */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  /** Operation currency differs from wallet currency. */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** `playerId` does not own `walletId`. */
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  /** Referenced transaction never arrived within the retry window (§7.1). */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** Reference belongs to another player, wallet, currency or round. */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** REFUND must reference a BET; ROLLBACK a BET, WIN or REFUND; WIN only a BET. */
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  /** Reference exists but was REJECTED/FAILED, so there is nothing to revert. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** Reference was already reverted. */
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  /** Reversal amount differs from the reference amount (partial reversals are out of scope). */
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
}

export enum InfrastructureFailureCode {
  /** Unrecoverable processing error after exhausting retries (poison message). */
  PermanentProcessingFailure = "PERMANENT_PROCESSING_FAILURE",
}

export type FailureCode = BusinessFailureCode | InfrastructureFailureCode;

/** What the provider should do when it receives a given code. */
export enum ProviderAction {
  /** Final answer; resending the same operation will replay the same result. */
  DoNotRetry = "DO_NOT_RETRY",
  /** Payload is wrong; correct it and send a NEW operation (new idempotency key). */
  FixPayload = "FIX_PAYLOAD",
  /** Requires operator investigation. */
  ContactSupport = "CONTACT_SUPPORT",
}

export const FAILURE_CODE_CATALOG: Readonly<
  Record<FailureCode, { readonly action: ProviderAction; readonly description: string }>
> = {
  [BusinessFailureCode.InsufficientFunds]: {
    action: ProviderAction.DoNotRetry,
    description: "Wallet balance is lower than the bet amount.",
  },
  [BusinessFailureCode.ReversalInsufficientFunds]: {
    action: ProviderAction.ContactSupport,
    description: "Reverting the referenced transaction would make the balance negative.",
  },
  [BusinessFailureCode.CurrencyMismatch]: {
    action: ProviderAction.FixPayload,
    description: "Operation currency differs from the wallet currency.",
  },
  [BusinessFailureCode.PlayerWalletMismatch]: {
    action: ProviderAction.FixPayload,
    description: "The wallet does not belong to the given player.",
  },
  [BusinessFailureCode.ReferenceNotFound]: {
    action: ProviderAction.FixPayload,
    description: "Referenced transaction was not received within the retry window.",
  },
  [BusinessFailureCode.ReferenceMismatch]: {
    action: ProviderAction.FixPayload,
    description: "Referenced transaction belongs to another player, wallet, currency or round.",
  },
  [BusinessFailureCode.ReferenceKindNotAllowed]: {
    action: ProviderAction.FixPayload,
    description: "Referenced transaction kind cannot be targeted by this operation.",
  },
  [BusinessFailureCode.ReferenceNotProcessed]: {
    action: ProviderAction.DoNotRetry,
    description: "Referenced transaction was rejected or failed; there is nothing to revert.",
  },
  [BusinessFailureCode.ReferenceAlreadyReversed]: {
    action: ProviderAction.DoNotRetry,
    description: "Referenced transaction has already been reverted.",
  },
  [BusinessFailureCode.ReferenceAmountMismatch]: {
    action: ProviderAction.FixPayload,
    description: "Reversal amount must equal the referenced transaction amount.",
  },
  [InfrastructureFailureCode.PermanentProcessingFailure]: {
    action: ProviderAction.ContactSupport,
    description: "Processing failed permanently after exhausting retries.",
  },
};
