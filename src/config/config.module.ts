import { Global, Module } from "@nestjs/common";
import { loadConfig } from "./app-config";

/** DI token for the validated {@link AppConfig}. */
export const APP_CONFIG = Symbol("APP_CONFIG");

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
