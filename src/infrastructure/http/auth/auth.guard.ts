import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ForbiddenProviderError } from "../../../application/errors/application-errors";
import {
  PROVIDER_IDENTITY_PORT,
  type AuthenticatedCaller,
  type HttpHeadersMap,
  type ProviderIdentityPort,
} from "../../../application/ports/provider-identity.port";
import { IS_PUBLIC_ROUTE } from "./public.decorator";

export interface AuthenticatedRequest {
  headers: HttpHeadersMap;
  caller?: AuthenticatedCaller;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly identityPort: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.caller = await this.identityPort.authenticate(request.headers ?? {});
    return true;
  }
}

/**
 * Enforces that an M2M caller scoped to a specific `providerId` cannot submit
 * or inspect transactions belonging to another game provider.
 */
export function assertCallerMatchesProvider(
  caller: AuthenticatedCaller | undefined,
  requestedProviderId: unknown,
): void {
  if (!caller?.providerId) return;
  if (typeof requestedProviderId !== "string") return;
  const trimmed = requestedProviderId.trim();
  if (trimmed && caller.providerId !== trimmed) {
    throw new ForbiddenProviderError(caller.providerId, trimmed);
  }
}
