import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import { Config } from "../config/index.js";
import { createRateLimitStore } from "./rateLimitStore.js";

/**
 * Both limiters take their counter store from `RATE_LIMIT_STORE`. The default,
 * `memory`, is express-rate-limit's own in-process store: right for a single
 * instance, and worth nothing across replicas, where N instances mean N times
 * the budget. `postgres` puts the counters in the database every replica
 * already shares. See `rateLimitStore.ts` and DECISIONS.md decision 13.
 */

/**
 * Rate limiting is skipped under `NODE_ENV=test` so the integration suite is not
 * throttled by its own traffic. `tests/users/rate-limit.spec.ts` sets
 * RATE_LIMIT_DISABLED=false to switch it back on and assert it works - the flag
 * is read per request, not at import time, which is what makes that possible.
 */
const rateLimitingDisabled = () => {
  // `.env.example` lists this variable empty to document it, and dotenv turns
  // that into "", which `??` does not treat as absent. An empty value means
  // "unset", not "false".
  const flag = process.env.RATE_LIMIT_DISABLED?.trim();
  return (
    (flag === undefined || flag === "" ? String(Config.IS_TEST) : flag) ===
    "true"
  );
};

const tooManyRequests = (req: Request, res: Response) => {
  req.log?.warn("rate limit exceeded", { path: req.originalUrl, ip: req.ip });
  res.status(429).json({
    errors: [
      {
        type: "TooManyRequestsError",
        msg: "Too many requests. Please try again later.",
        path: "",
        location: "",
        requestId: req.id,
      },
    ],
  });
};

/**
 * Per-IP cap on the credential endpoints. This blunts distributed guessing;
 * the per-account lockout in AuthController.login handles an attacker who
 * rotates IPs against one victim. The two are complementary.
 */
export const authLimiter = rateLimit({
  windowMs: Config.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  limit: Config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: rateLimitingDisabled,
  handler: tooManyRequests,
  store: createRateLimitStore(Config.RATE_LIMIT_STORE, "auth"),
});

/**
 * `POST /auth/refresh` gets its own budget rather than sharing the credential
 * one. It mints an access token and writes two rows on every call, so leaving
 * it unlimited was the largest uncapped database cost in the service - but the
 * traffic is machine-driven rather than human, one call per access-token
 * lifetime per session, so a shared office or mobile network behind a single
 * NAT address produces far more refreshes than logins. Putting it in the
 * 20-per-15-minutes credential bucket would have throttled ordinary users
 * before it throttled anyone worth throttling.
 *
 * The number to reason about is sessions-per-egress-address: at the default
 * `ACCESS_TOKEN_EXPIRY` of 1h, 120 per 15 minutes is roughly 480 concurrent
 * sessions behind one address. Lower it for a service with a narrower
 * audience; the point of the separate budget is that it can be tuned without
 * touching the login limit.
 */
export const refreshLimiter = rateLimit({
  windowMs: Config.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  limit: Config.REFRESH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: rateLimitingDisabled,
  handler: tooManyRequests,
  store: createRateLimitStore(Config.RATE_LIMIT_STORE, "refresh"),
});
