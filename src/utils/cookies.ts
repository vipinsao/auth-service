import type { CookieOptions, Response } from "express";
import { Config } from "../config/index.js";

/**
 * `httpOnly` keeps the tokens out of reach of any script on the page (so an XSS
 * bug cannot exfiltrate them), `sameSite: strict` stops them riding along on
 * cross-site requests, and `secure` forces HTTPS-only in production. The domain
 * is configurable instead of hard-coded to "localhost", which is what the
 * original version did - that cookie was silently dropped anywhere else.
 */
const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: Config.IS_PRODUCTION,
  domain: Config.COOKIE_DOMAIN,
  path: "/",
};

const ONE_HOUR_MS = 1000 * 60 * 60;

export const setAuthCookies = (
  res: Response,
  accessToken: string,
  refreshToken: string,
) => {
  res.cookie("accessToken", accessToken, {
    ...baseCookieOptions,
    maxAge: ONE_HOUR_MS,
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
