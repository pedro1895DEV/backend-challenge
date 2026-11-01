import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./infrastructure/http/auth/auth.module";
import { HttpApiModule } from "./infrastructure/http/http.module";
import { SqsModule } from "./infrastructure/messaging/sqs/sqs.module";
import { ObservabilityModule } from "./infrastructure/observability/observability.module";
import { DatabaseModule } from "./infrastructure/persistence/database.module";
import { WorkersModule } from "./infrastructure/workers/workers.module";

@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,
    DatabaseModule,
    SqsModule,
    AuthModule,
    HealthModule,
    HttpApiModule,
    WorkersModule,
  ],
})
export class AppModule {}
