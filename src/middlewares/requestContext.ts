import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import logger from "../config/logger.js";
import {
  startRequestSpan,
  runInSpan,
  requestDuration,
  SpanStatusCode,
} from "../config/telemetry.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The route a request is attributed to, as a CLOSED set.
 *
 * Anything Express did not match is "other" rather than `req.originalUrl`,
 * because a metric attribute taken from an unauthenticated caller is a memory
 * leak: one scan of this service would mint a time series per probed URL and
 * they are never reclaimed. (The log line keeps `req.originalUrl` - a log is a
 * bounded stream of events, not an unbounded set of series, so the trade-off
 * runs the other way there.)
 *
 * The awkward part is recovering the mount prefix, and the first version of
 * this got it wrong. `${req.baseUrl}${req.route.path}` is correct while the
 * handler runs, but `res.on("finish")` fires after Express has restored
 * `req.baseUrl` to "" - and on the error path the response is written by the
 * app-level error handler, after the restore, so a successful login was
 * labelled "/auth/login" and a failed one "/login". The same endpoint under two
 * names, splitting exactly when a chart most needs them together.
 *
 * So the prefix is recovered from `req.originalUrl` instead, and the result is
 * still closed rather than caller-controlled: it is only used when it ends with
 * a path THIS SERVICE DECLARED, which is what `req.route.path` is, and the
 * routers here are mounted on literal prefixes. Case and trailing slashes are
 * normalised because Express matches both and they would otherwise be separate
 * series.
 */
const routeOf = (req: Request): string => {
  const declared = (req.route as { path?: string } | undefined)?.path;
  if (!declared) return "other";

  const pathname =
    (req.originalUrl.split("?")[0] || "/").toLowerCase().replace(/\/+$/, "") ||
    "/";

  // A router mounted at a prefix and answering "/" - `/users` - has no tail to
  // match on, and the pathname is already the whole route.
  if (declared === "/") return pathname;

  const tail = declared.toLowerCase();
  return pathname.endsWith(tail) ? pathname : declared;
};

/**
 * Gives every request a correlation id and a logger tagged with it, then logs
 * one line when the response finishes. An id supplied by an upstream proxy is
 * reused (so a trace survives across services) but only if it is a short, safe
 * token - otherwise an attacker could inject arbitrary text into the log.
 *
 * It also opens the server span. The span is what joins the log line to the
 * work the request did: `requestId` says which request wrote a line, `traceId`
 * says which spans belong to it, and without both the two halves of an
 * investigation cannot be put together.
 */
export const requestContext = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const incoming = req.header("x-request-id");
  req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("x-request-id", req.id);

  // Named for the method alone until Express has matched a route; renamed on
  // finish, when the declared path is known. A span named after the raw URL
  // would have exactly the cardinality problem `routeOf` exists to avoid.
  const span = startRequestSpan(req.method, {
    "http.request.method": req.method,
    "request.id": req.id,
  });
  const { traceId, spanId } = span.spanContext();
  res.setHeader("x-trace-id", traceId);

  req.log = logger.child({ requestId: req.id, traceId, spanId });

  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const route = routeOf(req);
    const outcome =
      res.statusCode < 400
        ? "ok"
        : res.statusCode < 500
          ? "client_error"
          : "server_error";

    req.log.info("request completed", {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });

    span.updateName(`${req.method} ${route}`);
    span.setAttribute("http.route", route);
    span.setAttribute("http.response.status_code", res.statusCode);
    if (outcome === "server_error")
      span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();

    requestDuration.record(durationMs, {
      "http.request.method": req.method,
      "http.route": route,
      "http.response.status_code": res.statusCode,
      outcome,
    });
  });

  // Everything downstream runs with this span active, so a span opened inside
  // a service attaches to the request without a handle being passed through.
  runInSpan(span, next);
};
