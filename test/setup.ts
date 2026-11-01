import "reflect-metadata";

// Provide local Docker Compose fallback defaults during `bun test` when `.env`
// has not yet been copied from `.env.example` on a fresh repository clone.
process.env.DB_HOST ??= "localhost";
process.env.DB_PORT ??= "5432";
process.env.DB_USER ??= "wagering";
process.env.DB_PASSWORD ??= "wagering";
process.env.DB_NAME ??= "wagering";
process.env.AWS_REGION ??= "us-east-1";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
