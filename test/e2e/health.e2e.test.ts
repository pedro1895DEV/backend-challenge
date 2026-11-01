import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";

describe("Health Endpoints (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.DB_HOST ??= "localhost";
    process.env.DB_PORT ??= "5432";
    process.env.DB_USER ??= "wagering";
    process.env.DB_PASSWORD ??= "wagering";
    process.env.DB_NAME ??= "wagering";
    process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("GET /health/live returns 200 with status ok", async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("GET /health/ready returns 200 with database and sqs up", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      components: { database: string; sqs: string };
    };
    expect(body.status).toBe("ok");
    expect(body.components.database).toBe("up");
    expect(body.components.sqs).toBe("up");
  });
});
