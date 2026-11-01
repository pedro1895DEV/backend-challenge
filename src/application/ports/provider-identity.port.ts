export const PROVIDER_IDENTITY_PORT = Symbol("PROVIDER_IDENTITY_PORT");

export type HttpHeadersMap = Readonly<Record<string, string | string[] | undefined>>;

export interface AuthenticatedCaller {
  /** Subject identifier from the Identity Provider (`sub` / `client_id` claim). */
  readonly subject: string;
  /**
   * Game provider bound to this M2M client (`provider-a`, etc.).
   * When present, the caller may only submit or query transactions for this provider.
   * `undefined` for unrestricted / internal / no-op identities.
   */
  readonly providerId?: string;
  readonly scopes: readonly string[];
}

/**
 * Outbound port for authenticating incoming HTTP requests against an external
 * Identity Provider (OIDC / JWKS — README §2).
 *
 * Wired to {@link NoopProviderIdentityAdapter} by default so the evaluator can
 * run the challenge without booting an external IdP, while keeping the exact
 * extension seam in place for Keycloak / Zitadel OAuth2 `client_credentials`.
 */
export interface ProviderIdentityPort {
  authenticate(headers: HttpHeadersMap): Promise<AuthenticatedCaller>;
}
