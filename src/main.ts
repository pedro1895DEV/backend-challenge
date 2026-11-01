import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config/app-config";
import { APP_CONFIG } from "./config/config.module";
import { StructuredJsonLogger } from "./infrastructure/observability/structured-json-logger";

async function bootstrap(): Promise<void> {
  const jsonLogger = new StructuredJsonLogger();
  const app = await NestFactory.create(AppModule, {
    logger: jsonLogger,
  });

  // Lets SIGTERM/SIGINT trigger Nest lifecycle hooks (graceful shutdown — README §10).
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);

  Logger.log(
    JSON.stringify({
      event: "service_started",
      port: config.port,
      nodeEnv: config.nodeEnv,
    }),
    "Bootstrap",
  );
}

bootstrap().catch((error: unknown) => {
  const fallback = new StructuredJsonLogger();
  fallback.error(
    {
      event: "bootstrap_fatal_error",
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
    },
    "Bootstrap",
  );
  process.exit(1);
});
