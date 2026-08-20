import { createHash } from "crypto";
import type { Store, ClientRateLimitInfo, Options } from "express-rate-limit";
import { AppDataSource } from "../config/data-source.js";
import logger from "../config/logger.js";

/**
 * A rate-limit store backed by the PostgreSQL database the service already
 * depends on.
 *
 * `express-rate-limit`'s default store keeps its counters in the process, so
 * with N replicas an attacker gets N times the budget and a limit of 20 is
 * really a limit of 20N. The usual answer is Redis, which means another piece
 * of infrastructure to run. This service already has a database that every
 * replica shares, and a counter is a row, so the shared store costs one table
 * and one statement per request.
 *
 * That statement is the whole design:
 *
 *   INSERT ... ON CONFLICT DO UPDATE ... RETURNING
 *
 * a single round trip that inserts the first hit of a window or increments an
 * existing one, decides inside the statement whether the stored window has
 * expired, and returns the resulting count. Reading, deciding and writing in
 * one statement is what makes it correct with several replicas incrementing
 * the same key at once; a read-then-write would let two replicas both see 19
 * and both write 20.
 */
export class PostgresRateLimitStore implements Store {
  /** Set by express-rate-limit from the limiter's own options. */
  private windowMs = 60_000;

  /**
   * express-rate-limit does NOT prepend this to the keys it passes in - it only
   * reads it to avoid a false positive in its double-count check. Applying it
   * is the store's job, which is what `scope()` below does. Getting this wrong
   * is not a subtle bug: without it every limiter writes to the key `1.2.3.4`
   * and they silently share one budget.
   */
  public prefix: string;

  /** The keys live in the database, not in this process. */
  public localKeys = false;

  private lastSweep = 0;

  constructor(prefix: string) {
    this.prefix = `${prefix}:`;
  }

  /**
   * `auth` + `1.2.3.4` -> `auth:<sha256 of 1.2.3.4>`.
   *
   * Two jobs. The prefix keeps limiters apart, so `authLimiter` and
   * `refreshLimiter` never share a budget. The hash makes the stored key a
   * fixed 64 characters whatever arrives.
   *
   * The length is the security-relevant half. The client key comes from
   * `req.ip`, and behind a trusted proxy that is `X-Forwarded-For`, which
   * Express neither validates nor bounds. A header of a couple of hundred
   * characters would overflow the `varchar(160)` column, Postgres would raise
   * `22001 string_data_right_truncation`, and express-rate-limit would hand
   * that to `next(err)` - an unauthenticated 500 on every credential endpoint,
   * from one header. Hashing means the column cannot be the failure mode no
   * matter what feeds it.
   *
   * Truncating instead would also fit, but two different long values could
   * truncate to the same key, which hands an attacker a way to land in a
   * victim's bucket deliberately. SHA-256 is not doing anything secret here -
   * the input is a public IP address - it is being used for a fixed width and
   * a collision resistance that truncation does not have.
   *
   * The cost is that the table no longer shows which address a row belongs to.
   * `SELECT encode(sha256('1.2.3.4'), 'hex')` gets it back when debugging.
   */
  private scope(key: string): string {
    return `${this.prefix}${createHash("sha256").update(key).digest("hex")}`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const windowSeconds = this.windowMs / 1000;

    const rows = (await AppDataSource.query(
      `INSERT INTO "rate_limit_hit" ("key", "hits", "expiresAt")
       VALUES ($1, 1, now() + ($2 || ' seconds')::interval)
       ON CONFLICT ("key") DO UPDATE SET
         "hits" = CASE
           WHEN "rate_limit_hit"."expiresAt" <= now() THEN 1
           ELSE "rate_limit_hit"."hits" + 1
         END,
         "expiresAt" = CASE
           WHEN "rate_limit_hit"."expiresAt" <= now()
             THEN now() + ($2 || ' seconds')::interval
           ELSE "rate_limit_hit"."expiresAt"
         END
       RETURNING "hits", "expiresAt"`,
      [this.scope(key), String(windowSeconds)],
    )) as { hits: number; expiresAt: Date }[];

    void this.sweepExpired();

    return { totalHits: rows[0].hits, resetTime: rows[0].expiresAt };
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const rows = (await AppDataSource.query(
      `SELECT "hits", "expiresAt" FROM "rate_limit_hit"
       WHERE "key" = $1 AND "expiresAt" > now()`,
      [this.scope(key)],
    )) as { hits: number; expiresAt: Date }[];

    if (rows.length === 0) return undefined;
    return { totalHits: rows[0].hits, resetTime: rows[0].expiresAt };
  }

  /**
   * express-rate-limit calls this to refund a request that turned out not to
   * count, so it must never take a counter below zero.
   */
  async decrement(key: string): Promise<void> {
    await AppDataSource.query(
      `UPDATE "rate_limit_hit" SET "hits" = greatest("hits" - 1, 0)
       WHERE "key" = $1 AND "expiresAt" > now()`,
      [this.scope(key)],
    );
  }

  async resetKey(key: string): Promise<void> {
    await AppDataSource.query(`DELETE FROM "rate_limit_hit" WHERE "key" = $1`, [
      this.scope(key),
    ]);
  }

  async resetAll(): Promise<void> {
    await AppDataSource.query(
      `DELETE FROM "rate_limit_hit" WHERE "key" LIKE $1`,
      [`${this.prefix}%`],
    );
  }

  /**
   * Rows for clients that stopped calling are dead weight. Sweeping them on a
   * timer would need a scheduler; sweeping them on every request would double
   * the cost of the limiter. So a request sweeps at most once per window, and
   * the sweep is not awaited - the caller's answer does not depend on it.
   *
   * A failed sweep is logged and ignored on purpose: leaving stale rows behind
   * is a housekeeping problem, and failing the request the user actually made
   * would turn it into an outage.
   */
  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;

    try {
      // No grace period: an expired row carries no information, because
      // `increment` re-inserts it from scratch. The row used to be kept an
      // extra hour for no reason beyond churn, which tripled how long a row
      // written by a one-off caller stayed in the auth database.
      await AppDataSource.query(
        `DELETE FROM "rate_limit_hit" WHERE "expiresAt" <= now()`,
      );
    } catch (err) {
      logger.warn("rate limit sweep failed", {
        message: (err as Error).message,
      });
    }
  }
}

/**
 * Returns the store for a limiter, or `undefined` to let express-rate-limit use
 * its own in-process memory store.
 *
 * Memory is the default because it needs nothing and is right for a single
 * instance. Anything running more than one replica should set
 * `RATE_LIMIT_STORE=postgres`, where "more than one replica" includes a rolling
 * deploy, during which two are live at once.
 */
export const createRateLimitStore = (
  kind: string,
  prefix: string,
): Store | undefined =>
  kind === "postgres" ? new PostgresRateLimitStore(prefix) : undefined;
