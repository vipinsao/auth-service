import { describe, it, expect, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import type { CookieOptions, Response } from "express";

/**
 * One lifetime, one source of truth.
 *
 * The accessToken cookie's `maxAge` was hard-coded to one hour while the token
 * inside it expired after `ACCESS_TOKEN_EXPIRY`. They agree at the default and
 * diverge the moment anyone changes the variable: `ACCESS_TOKEN_EXPIRY=15m`
 * left the cookie alive for forty-five minutes after the credential in it had
 * expired, so the browser kept presenting a token the service refuses and the
 * user got 401s from a session that still looked live.
 *
 * These fix the number to the token rather than to the configuration, so
 * changing the configuration moves both by construction.
 */

interface SetCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

/** Just enough of express's Response to record what was set. */
const recordingResponse = (into: SetCookie[]): Response =>
  ({
    cookie(name: string, value: string, options: CookieOptions) {
      into.push({ name, value, options });
      return this;
    },
  }) as unknown as Response;

/**
 * Re-imports config, the token service and the cookie helper with
 * ACCESS_TOKEN_EXPIRY set to `expiry`, and returns what setAuthCookies wrote.
 * The same jest.resetModules dance tests/unit/env-example.spec.ts uses, for the
 * same reason: Config is read once at module load.
 */
const cookiesFor = async (expiry: string) => {
  const saved = process.env.ACCESS_TOKEN_EXPIRY;
  try {
    process.env.ACCESS_TOKEN_EXPIRY = expiry;
    jest.resetModules();

    const { TokenService } = await import("../../src/services/TokenService.js");
    const { setAuthCookies } = await import("../../src/utils/cookies.js");

    // generateAccessToken does not touch the repository.
    const tokens = new TokenService(null as never);
    const accessToken = tokens.generateAccessToken({
      sub: "1",
      role: "customer",
    });

    const written: SetCookie[] = [];
    setAuthCookies(recordingResponse(written), accessToken, "refresh-token");

    const access = written.find((cookie) => cookie.name === "accessToken")!;
    const claims = jwt.decode(accessToken) as { exp: number; iat: number };

    return { access, claims, all: written };
  } finally {
    if (saved === undefined) delete process.env.ACCESS_TOKEN_EXPIRY;
    else process.env.ACCESS_TOKEN_EXPIRY = saved;
    jest.resetModules();
  }
};

describe("the accessToken cookie's lifetime", () => {
  it("matches the token at the shipped default", async () => {
    const { access, claims } = await cookiesFor("1h");

    expect(access.options.maxAge).toBe(60 * 60 * 1000);
    expect(access.options.maxAge).toBe((claims.exp - claims.iat) * 1000);
  });

  it("moves when ACCESS_TOKEN_EXPIRY moves, rather than staying at an hour", async () => {
    // The reproduction. This was 3600000 against a token good for 900 seconds:
    // the cookie outlived its own contents by forty-five minutes.
    const { access, claims } = await cookiesFor("15m");

    expect(access.options.maxAge).toBe(15 * 60 * 1000);
    expect(access.options.maxAge).toBe((claims.exp - claims.iat) * 1000);
  });

  it("moves upwards too, so a longer token is not truncated to an hour", async () => {
    const { access, claims } = await cookiesFor("2d");

    expect(access.options.maxAge).toBe(2 * 24 * 60 * 60 * 1000);
    expect(access.options.maxAge).toBe((claims.exp - claims.iat) * 1000);
  });

  it("leaves the refresh cookie on its own configured lifetime", async () => {
    // Two tokens, two lifetimes: deriving one must not disturb the other.
    const { all } = await cookiesFor("15m");
    const { Config } = await import("../../src/config/index.js");

    const refresh = all.find((cookie) => cookie.name === "refreshToken")!;
    expect(refresh.options.maxAge).toBe(
      Config.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it("keeps every other cookie attribute", async () => {
    const { all } = await cookiesFor("15m");

    for (const cookie of all) {
      expect(cookie.options.httpOnly).toBe(true);
      expect(cookie.options.sameSite).toBe("strict");
      expect(cookie.options.path).toBe("/");
    }
  });
});

describe("accessTokenCookieMaxAge", () => {
  it("gives a token with no expiry no maxAge at all, making it a session cookie", async () => {
    // Failing towards a shorter cookie than the credential, never a longer one.
    const { accessTokenCookieMaxAge } = await import(
      "../../src/utils/cookies.js"
    );
    const noExpiry = jwt.sign({ sub: "1" }, "secret");

    expect(accessTokenCookieMaxAge(noExpiry)).toBeUndefined();
  });

  it("gives an unreadable token no maxAge either", async () => {
    const { accessTokenCookieMaxAge } = await import(
      "../../src/utils/cookies.js"
    );

    expect(accessTokenCookieMaxAge("not-a-jwt")).toBeUndefined();
    expect(accessTokenCookieMaxAge("")).toBeUndefined();
  });

  it("omits maxAge from the cookie when the token carries no expiry", async () => {
    const { setAuthCookies } = await import("../../src/utils/cookies.js");
    const written: SetCookie[] = [];

    setAuthCookies(
      recordingResponse(written),
      jwt.sign({ sub: "1" }, "secret"),
      "refresh",
    );

    const access = written.find((cookie) => cookie.name === "accessToken")!;
    expect(access.options).not.toHaveProperty("maxAge");
  });
});
