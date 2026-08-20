import type { NextFunction, Request, Response } from "express";
import createHttpError from "http-errors";

/**
 * Role check for routes that `authenticate` has already admitted. 401 means
 * "we do not know who you are", 403 means "we do and you may not" - keeping
 * them distinct matters to any client that auto-refreshes on 401.
 */
export const requireRole =
  (...allowed: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(createHttpError(401, "Authentication required"));
    }
    if (!allowed.includes(req.auth.role)) {
      return next(
        createHttpError(403, "You do not have permission to access this"),
      );
    }
    next();
  };
