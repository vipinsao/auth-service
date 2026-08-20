import request from "supertest";
import { DataSource } from "typeorm";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import app from "../../src/app.js";
import { AppDataSource } from "../../src/config/data-source.js";

describe("Operational endpoints", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it("GET /health reports the process is up", async () => {
    const response = await request(app).get("/health");
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("GET /ready reports the database is reachable", async () => {
    const response = await request(app).get("/ready");
    expect(response.statusCode).toBe(200);
    expect(response.body.database).toBe("up");
  });

  it("GET /ready reports 503 once the connection is gone", async () => {
    await connection.destroy();
    const response = await request(app).get("/ready");
    expect(response.statusCode).toBe(503);
    expect(response.body.status).toBe("not-ready");
    await AppDataSource.initialize();
  });

  it("returns a correlation id on every response", async () => {
    const response = await request(app).get("/health");
    expect(response.headers["x-request-id"]).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("echoes back a caller supplied correlation id", async () => {
    const response = await request(app)
      .get("/health")
      .set("x-request-id", "trace-abc-123");
    expect(response.headers["x-request-id"]).toBe("trace-abc-123");
  });

  it("sets security headers from helmet", async () => {
    const response = await request(app).get("/health");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers).not.toHaveProperty("x-powered-by");
  });

  it("serves the OpenAPI UI at /api-docs", async () => {
    const response = await request(app).get("/api-docs/");
    expect(response.statusCode).toBe(200);
    expect(response.text).toContain("swagger");
  });

  it("answers 404 with the standard error envelope for unknown routes", async () => {
    const response = await request(app).get("/does-not-exist");
    expect(response.statusCode).toBe(404);
    expect(response.body.errors[0].requestId).toBeDefined();
  });
});
