import { Injectable } from "@nestjs/common";
import type {
  AuthenticatedCaller,
  HttpHeadersMap,
  ProviderIdentityPort,
} from "../../../application/ports/provider-identity.port";

const ALL_SCOPES = Object.freeze([
  "wallets:write",
  "wallets:read",
  "wagering:write",
  "wagering:read",
]);

/**
 * Default no-op identity adapter (README §2).
 *
 * Allows running and evaluating the service out of the box without booting an
 * external Identity Provider. Replacing this provider in DI with an OIDC/JWKS
 * adapter (Keycloak / Zitadel `client_credentials`) activates authentication
 * and per-provider tenant isolation across all non-public routes with zero
 * controller or use-case changes.
 */
@Injectable()
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  async authenticate(_headers: HttpHeadersMap): Promise<AuthenticatedCaller> {
    return {
      subject: "noop-anonymous",
      providerId: undefined,
      scopes: ALL_SCOPES,
    };
  }
}
