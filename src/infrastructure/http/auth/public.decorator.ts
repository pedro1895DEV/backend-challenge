import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_ROUTE = Symbol("IS_PUBLIC_ROUTE");

/**
 * Marks a controller or route handler as exempt from authentication
 * (e.g. `/health/live` and `/health/ready` — README §2 & §9).
 */
export const Public = (): ClassDecorator & MethodDecorator =>
  SetMetadata(IS_PUBLIC_ROUTE, true);
