import request from "supertest";
import { DataSource } from "typeorm";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import app from "../../src/app.js";
import { AppDataSource } from "../../src/config/data-source.js";
import { Config } from "../../src/config/index.js";

/**
 * Rate limiting is off by default under NODE_ENV=test so the rest of the suite
 * is not throttled by its own traffic. The middleware reads the flag on every
 * request, so this file can switch it back on and prove the limiter works.
 */
describe("Per-IP rate limiting on /auth", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
    await connection.dropDatabase();
    await connection.synchronize();
    process.env.RATE_LIMIT_DISABLED = "false";
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    await connection.destroy();
  });

  it("should answer 429 once the window budget is spent", async () => {
    const attempt = () =>
      request(app)
        .post("/auth/login")
        .send({ email: "nobody@example.com", password: "whatever" });

    for (let i = 0; i < Config.AUTH_RATE_LIMIT_MAX; i++) {
      const response = await attempt();
      expect(response.statusCode).toBe(400);
    }

    const throttled = await attempt();
    expect(throttled.statusCode).toBe(429);
    expect(throttled.body.errors[0].type).toBe("TooManyRequestsError");
  });

  /**
   * /auth/refresh has its own budget, so spending the credential budget above
   * must not have spent this one - that separation is the reason the endpoint
   * could be limited at all without throttling ordinary users behind a NAT.
   */
  it("meters /auth/refresh on a separate, larger budget", async () => {
    const attempt = () => request(app).post("/auth/refresh");

    for (let i = 0; i < Config.REFRESH_RATE_LIMIT_MAX; i++) {
      const response = await attempt();
      // No cookie, so every one of these is rejected on its merits, not by the
      // limiter - which is what makes the 429 below attributable to the limiter.
      expect(response.statusCode).toBe(401);
    }

    const throttled = await attempt();
    expect(throttled.statusCode).toBe(429);
    expect(throttled.body.errors[0].type).toBe("TooManyRequestsError");
  });

  /**
   * The credential budget was spent by the first case in this file, so anything
   * still answering 400 here would be a caller who has been handed a fresh
   * bucket. `trust proxy` defaults to false, so X-Forwarded-For is not believed
   * and cannot be used to pick one - which is the whole point, since the header
   * is chosen by the caller and Express does not check it is even an address.
   */
  it("does not let X-Forwarded-For buy a fresh budget", async () => {
    const spoofs = [
      "203.0.113.9",
      "198.51.100.7, 203.0.113.9",
      "not-an-ip-at-all",
      "A".repeat(300),
    ];

    for (const spoof of spoofs) {
      const response = await request(app)
        .post("/auth/login")
        .set("X-Forwarded-For", spoof)
        .send({ email: "nobody@example.com", password: "whatever" });

      expect(response.statusCode).toBe(429);
    }
  });
});
