import type { CookieOptions, Response } from "express";
import jwt from "jsonwebtoken";
import { Config } from "../config/index.js";

/**
 * `httpOnly` keeps the tokens out of reach of any script on the page (so an XSS
 * bug cannot exfiltrate them), `sameSite: strict` stops them riding along on
 * cross-site requests, and `secure` forces HTTPS-only. The domain is
 * configurable instead of hard-coded to "localhost", which is what the original
 * version did - that cookie was silently dropped anywhere else.
 *
 * `secure` is `!IS_LOCAL`, not `IS_PRODUCTION`, and the direction is the point.
 * Keyed off an allow-list of production spellings, `NODE_ENV=staging` or a
 * value with a stray space means "not production", and the session cookie ships
 * over plain HTTP in a deployed environment - the exact failure nobody notices,
 * because everything still works. Keyed off an allow-list of local spellings,
 * an unrecognised value gets `secure` and the failure is a developer whose
 * cookie will not set over http://.
 */
const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: !Config.IS_LOCAL,
  domain: Config.COOKIE_DOMAIN,
  path: "/",
};

const ONE_HOUR_MS = 1000 * 60 * 60;

/**
 * How long the access-token cookie may live: exactly as long as the token
 * inside it.
 *
 * This used to be a hard-coded hour while the token's lifetime came from
 * `ACCESS_TOKEN_EXPIRY` - two sources of truth for one number, agreeing only at
 * the default. Set `ACCESS_TOKEN_EXPIRY=15m` and the cookie outlived the token
 * by forty-five minutes: three quarters of an hour in which the browser keeps
 * presenting a credential the service will refuse, so the user gets 401s from a
 * session that looks live instead of being logged out and asked to sign in.
 *
 * The lifetime is read off the token rather than re-derived from the config
 * string, because re-deriving it means a second implementation of
 * jsonwebtoken's `expiresIn` parsing - "15m", "2 days", "120" - and a second
 * implementation is a second thing that can drift from the first. The token
 * already carries the answer as two numbers this service signed a moment ago,
 * so `decode` is enough; there is nothing here to verify that we did not just
 * assert ourselves.
 *
 * A token carrying no `exp` gets no `maxAge`, which makes it a session cookie
 * that dies with the browser. That is the safe direction to fail in: shorter
 * than the credential, never longer.
 */
export const accessTokenCookieMaxAge = (
  accessToken: string,
): number | undefined => {
  const decoded = jwt.decode(accessToken);
  if (decoded === null || typeof decoded !== "object") return undefined;

  const { exp, iat } = decoded as { exp?: unknown; iat?: unknown };
  if (typeof exp !== "number" || typeof iat !== "number") return undefined;
  if (exp <= iat) return undefined;

  return (exp - iat) * 1000;
};

export const setAuthCookies = (
  res: Response,
  accessToken: string,
  refreshToken: string,
) => {
  const maxAge = accessTokenCookieMaxAge(accessToken);

  res.cookie("accessToken", accessToken, {
    ...baseCookieOptions,
    ...(maxAge === undefined ? {} : { maxAge }),
  });
  res.cookie("refreshToken", refreshToken, {
    ...baseCookieOptions,
    maxAge: Config.REFRESH_TOKEN_EXPIRY_DAYS * 24 * ONE_HOUR_MS,
  });
};

export const clearAuthCookies = (res: Response) => {
  res.clearCookie("accessToken", baseCookieOptions);
  res.clearCookie("refreshToken", baseCookieOptions);
};
