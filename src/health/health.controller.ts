import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Public } from "../infrastructure/http/auth/public.decorator";
import { SqsService } from "../infrastructure/messaging/sqs/sqs.service";
import { DATA_SOURCE } from "../infrastructure/persistence/database.module";

export interface ReadinessResponse {
  status: "ok" | "degraded";
  components: {
    database: "up" | "down";
    sqs: "up" | "down";
  };
}

/**
 * Health endpoints are unauthenticated (README §2 / §9).
 * - /health/live: process is alive
 * - /health/ready: PostgreSQL and SQS queue are reachable
 */
@Public()
@Controller("health")
export class HealthController {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly sqsService: SqsService,
  ) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<ReadinessResponse> {
    let dbStatus: "up" | "down" = "down";
    let sqsStatus: "up" | "down" = "down";

    // 1. Check PostgreSQL
    try {
      if (this.dataSource.isInitialized) {
        await this.dataSource.query("SELECT 1");
        dbStatus = "up";
      }
    } catch {
      dbStatus = "down";
    }

    // 2. Check SQS (verifies real SQS protocol reachability & queue URL resolution)
    if (await this.sqsService.checkHealth()) {
      sqsStatus = "up";
    }

    const isReady = dbStatus === "up" && sqsStatus === "up";
    const response: ReadinessResponse = {
      status: isReady ? "ok" : "degraded",
      components: {
        database: dbStatus,
        sqs: sqsStatus,
      },
    };

    if (!isReady) {
      throw new ServiceUnavailableException(response);
    }

    return response;
  }
}
