import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import logger from "../config/logger.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Gives every request a correlation id and a logger tagged with it, then logs
 * one line when the response finishes. An id supplied by an upstream proxy is
 * reused (so a trace survives across services) but only if it is a short, safe
 * token - otherwise an attacker could inject arbitrary text into the log.
 */
export const requestContext = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const incoming = req.header("x-request-id");
  req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.log = logger.child({ requestId: req.id });
  res.setHeader("x-request-id", req.id);

  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    req.log.info("request completed", {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
};
