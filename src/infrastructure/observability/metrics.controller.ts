import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import {
  OUTBOX_REPOSITORY,
  type OutboxLagStats,
  type OutboxRepository,
} from "../../application/ports/outbox.repository";
import type { HttpHeadersMap } from "../../application/ports/provider-identity.port";
import { Public } from "../http/auth/public.decorator";
import type { MinimalHttpResponse } from "../http/correlation-id";
import { MetricsRegistry } from "./metrics.registry";

interface MetricsHttpResponse extends MinimalHttpResponse {
  send(body: string): void;
}

@Public()
@Controller("metrics")
export class MetricsController {
  constructor(
    private readonly registry: MetricsRegistry,
    @Inject(OUTBOX_REPOSITORY)
    private readonly outboxRepo: OutboxRepository,
  ) {}

  @Get()
  async getMetrics(
    @Query("format") format: string | undefined,
    @Req() req: { headers?: HttpHeadersMap },
    @Res() res: MetricsHttpResponse,
  ): Promise<void> {
    let outboxLag: OutboxLagStats = { pendingCount: 0, oldestPendingAgeMs: 0 };
    try {
      outboxLag = await this.outboxRepo.getLagStats(new Date());
    } catch {
      // Keep /metrics scrapable even during transient DB outages
    }

    const rawAccept = req.headers?.["accept"];
    const accept = Array.isArray(rawAccept) ? rawAccept.join(",") : (rawAccept ?? "");
    const wantsJson =
      format?.trim().toLowerCase() === "json" ||
      (accept.includes("application/json") && !accept.includes("text/plain"));

    if (wantsJson) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200).json(this.registry.toSnapshot(outboxLag));
      return;
    }

    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(this.registry.toPrometheusText(outboxLag));
  }
}
