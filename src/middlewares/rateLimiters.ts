import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import { Config } from "../config/index.js";

/**
 * Rate limiting is skipped under `NODE_ENV=test` so the integration suite is not
 * throttled by its own traffic. `tests/users/rate-limit.spec.ts` sets
 * RATE_LIMIT_DISABLED=false to switch it back on and assert it works - the flag
 * is read per request, not at import time, which is what makes that possible.
 */
const rateLimitingDisabled = () =>
  (process.env.RATE_LIMIT_DISABLED ?? String(Config.IS_TEST)) === "true";

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
});
