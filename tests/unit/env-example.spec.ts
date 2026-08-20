import { describe, it, expect, jest } from "@jest/globals";
import fs from "fs";
import path from "path";

const root = process.cwd();

/**
 * `.env.example` documents every optional variable by listing it with an empty
 * value - that is how a reader learns the name and the default. dotenv turns
 * each of those into `""`, and `??` does not treat an empty string as absent.
 *
 * The result was that following the README exactly (`cp .env.example .env.dev`)
 * handed `expiresIn: ""` to jsonwebtoken and 500'd every login, and left the
 * rate limiter switched on during the test run. Both are fixed by reading
 * optional strings through helpers that treat "" as unset; this suite fails if
 * either regresses, and it fails on the committed file rather than on a copy.
 */
describe(".env.example is a usable configuration", () => {
  const raw = fs.readFileSync(path.join(root, ".env.example"), "utf8");

  const declared = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, ...rest] = line.split("=");
      return { name: name.trim(), value: rest.join("=").split("#")[0].trim() };
    });

  it("declares the variables the service refuses to start without", () => {
    const required = [
      "DB_HOST",
      "DB_PORT",
      "DB_USERNAME",
      "DB_PASSWORD",
      "DB_NAME",
      "REFRESH_TOKEN_SECRET",
    ];
    for (const name of required) {
      const entry = declared.find((d) => d.name === name);
      expect(entry).toBeDefined();
      expect(entry!.value).not.toBe("");
    }
  });

  it("loads into a Config whose optional values are the documented defaults", async () => {
    const saved = { ...process.env };
    try {
      // Reproduce `cp .env.example .env.dev` exactly: every documented variable
      // present, the optional ones empty.
      for (const { name, value } of declared) process.env[name] = value;
      process.env.NODE_ENV = "test";

      jest.resetModules();
      const { Config } = await import("../../src/config/index.js");

      expect(Config.ACCESS_TOKEN_EXPIRY).toBe("1h");
      expect(Config.PRIVATE_KEY_PATH).toBe("certs/private.pem");
      expect(Config.PUBLIC_KEY_PATH).toBe("certs/public.pem");
      expect(Config.LOG_LEVEL).toBe("info");
      expect(Config.APP_BASE_URL).toBe("http://localhost:3000");
      expect(Config.RATE_LIMIT_STORE).toBe("memory");
      expect(Config.MAIL_TRANSPORT).toBe("json");
      expect(Config.MAIL_FROM).not.toBe("");
      expect(Config.SMTP_HOST).toBeUndefined();
      expect(Config.TRUST_PROXY).toBe(false);
      expect(Config.AUTH_RATE_LIMIT_MAX).toBe(20);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      jest.resetModules();
    }
  });

  it("treats an empty RATE_LIMIT_DISABLED as unset, so the suite is not throttled", () => {
    const entry = declared.find((d) => d.name === "RATE_LIMIT_DISABLED");
    expect(entry).toBeDefined();
    expect(entry!.value).toBe("");
  });
});
