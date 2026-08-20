import type { NextFunction, Request, Response } from "express";
import createHttpError from "http-errors";
import type { TokenService } from "../services/TokenService.js";
import type { AuthPayload } from "../types/index.js";

/**
 * Verifies the RS256 access token, taken from the `accessToken` cookie or an
 * `Authorization: Bearer` header. Signature, issuer and expiry are all checked
 * by `TokenService.verifyAccessToken`; anything that fails is a flat 401.
 */
export const authenticate =
  (tokenService: TokenService) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    const bearer = header?.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : undefined;
    const token = bearer ?? (req.cookies?.accessToken as string | undefined);

    if (!token) {
      return next(createHttpError(401, "Access token is missing"));
    }

    try {
      const payload = tokenService.verifyAccessToken(token);
      req.auth = { sub: String(payload.sub), role: String(payload.role) };
      next();
    } catch {
      next(createHttpError(401, "Access token is invalid or expired"));
    }
  };

export type { AuthPayload };
