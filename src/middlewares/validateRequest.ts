import type { NextFunction, Request, Response } from "express";
import { validationResult } from "express-validator";

/**
 * Turns the result of the express-validator chains registered on a route into a
 * 400 response. Keeping it in one middleware means no handler can forget to
 * check - the previous version checked inside each controller method.
 */
export const validateRequest = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).json({ errors: result.array() });
  }
  next();
};
