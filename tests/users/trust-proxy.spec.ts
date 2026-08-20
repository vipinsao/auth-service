import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { Express } from "express";
import type { DataSource } from "typeorm";

/**
 * `TRUST_PROXY` decides whether `X-Forwarded-For` is believed, and `req.ip` -
 * which is the only thing the rate limiters count against - is what changes
 * when it is.
 *
 * The default was already tested (`rate-limit.spec.ts`, "does not let
 * X-Forwarded-For buy a fresh budget"). What was not tested is what happens
 * when someone sets the variable, and the documentation invited them to: it
 * accepted `TRUST_PROXY=true`, which trusts every hop and therefore takes the
 * leftmost entry of a header the caller wrote. Measured on the compiled
 * service, 60 logins each with a unique forged value: unset gave `{400: 20,
 * 429: 40}`, and `true` gave `{400: 60}` - the limiter never fired once, and
 * the 60 forged values left 62 rows in `rate_limit_hit`.
 *
 * The app reads the setting once at import, so this file sets the environment
 * before importing anything from `src/`. Nothing here is a unit test of the
 * parser: what is asserted is that a service configured this way still
 * throttles.
 */
describe("TRUST_PROXY=true is refused rather than honoured", () => {
  let app: Express;
  let connection: DataSource;
  let authLimit: number;
  let configured: boolean | number | string;
  const warnings: string[] = [];

  beforeAll(async () => {
    process.env.TRUST_PROXY = "true";
    // Rate limiting is off by default under NODE_ENV=test so the rest of the
    // suite is not throttled by its own traffic.
    process.env.RATE_LIMIT_DISABLED = "false";

    // The refusal is a stderr line, because config/index.ts is what configures
    // the logger and cannot import it. Capturing it is the only way to assert
    // the operator is told their setting was refused rather than applied.
    /* eslint-disable no-console */
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    /* eslint-enable no-console */

    try {
      const { Config } = await import("../../src/config/index.js");
      configured = Config.TRUST_PROXY;
      authLimit = Config.AUTH_RATE_LIMIT_MAX;
    } finally {
      // eslint-disable-next-line no-console
      console.warn = realWarn;
    }

    const { AppDataSource } = await import("../../src/config/data-source.js");
    connection = await AppDataSource.initialize();
    await connection.dropDatabase();
    await connection.synchronize();

    app = (await import("../../src/app.js")).default;
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    delete process.env.RATE_LIMIT_DISABLED;
    await connection.destroy();
  });

  it("falls back to false and warns that it did", () => {
    expect(configured).toBe(false);
    expect(warnings.join("\n")).toContain("TRUST_PROXY=true");
  });

  it("keeps one budget across 60 requests that each forge a different address", async () => {
    const attempt = (index: number) =>
      request(app)
        .post("/auth/login")
        .set("X-Forwarded-For", `198.51.100.${index}`)
        .send({ email: "nobody@example.com", password: "whatever" });

    const codes: Record<number, number> = {};
    for (let index = 0; index < 60; index++) {
      const response = await attempt(index);
      codes[response.statusCode] = (codes[response.statusCode] ?? 0) + 1;
    }

    // Honouring the header would make this `{ 400: 60 }`: every request lands
    // in a bucket of its own and nothing is ever throttled.
    expect(codes).toEqual({ 400: authLimit, 429: 60 - authLimit });
  }, 60_000);
});
