import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PROVIDER_IDENTITY_PORT } from "../../../application/ports/provider-identity.port";
import { AuthGuard } from "./auth.guard";
import { NoopProviderIdentityAdapter } from "./noop-provider-identity.adapter";

@Module({
  providers: [
    {
      provide: PROVIDER_IDENTITY_PORT,
      useClass: NoopProviderIdentityAdapter,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [PROVIDER_IDENTITY_PORT],
})
export class AuthModule {}
