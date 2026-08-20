import type { NextFunction, Request, Response } from "express";
import createHttpError, { type HttpError } from "http-errors";
import { Config } from "../config/index.js";
import logger from "../config/logger.js";

/** Anything that reaches here matched no route. */
export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  next(createHttpError(404, `Cannot ${req.method} ${req.originalUrl}`));
};

/**
 * The single place an error turns into a response body. The shape
 * (`{ errors: [...] }`) matches express-validator's, so clients parse one
 * format whether the failure was validation or anything else.
 */
export const errorHandler = (
  err: HttpError,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const statusCode = err.status || err.statusCode || 500;
  const log = req.log ?? logger;

  if (statusCode >= 500) {
    log.error(err.message, { stack: err.stack, statusCode });
  } else {
    log.warn(err.message, { statusCode });
  }

  // Once headers are out the only correct action is to let Express tear the
  // connection down; writing a second body corrupts the response.
  if (res.headersSent) {
    return next(err);
  }

  // Internal failures must not leak stack details or SQL to the caller.
  //
  // Gated on `!IS_LOCAL` rather than `IS_PRODUCTION` so that an unrecognised
  // NODE_ENV hides the detail instead of publishing it. The old check listed
  // the production spellings, so `NODE_ENV=staging` echoed raw driver errors -
  // table and column names included - to unauthenticated callers.
  const message =
    statusCode >= 500 && !Config.IS_LOCAL
      ? "Internal server error"
      : err.message;

  res.status(statusCode).json({
    errors: [
      {
        type: err.name,
        msg: message,
        path: "",
        location: "",
        requestId: req.id,
      },
    ],
  });
};
