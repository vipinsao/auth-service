import { Entity, Column, Index, PrimaryColumn } from "typeorm";

/**
 * One row per rate-limit key per window.
 *
 * This is the shared counter behind `RATE_LIMIT_STORE=postgres`. The key is
 * scoped by the limiter that owns it (`auth:1.2.3.4`), so two limiters never
 * share a budget even though they share the table.
 *
 * Rows are not deleted when a window ends - the row is reused, with `hits`
 * reset - so an active client causes one row, not one row per window. Rows for
 * clients that stop calling are cleaned up by
 * `PostgresRateLimitStore.sweepExpired`.
 */
@Entity()
export class RateLimitHit {
  /**
   * `<limiter prefix>:<sha256 of the client key>` - `auth:` plus 64 hex
   * characters, so 69 or 72 in practice. The client key is hashed by
   * `PostgresRateLimitStore.scope` precisely so that this column has a fixed
   * width: it is fed from `req.ip`, which behind a trusted proxy is an
   * unvalidated, unbounded request header, and an over-long value here is a
   * `22001` from Postgres and a 500 out of the API. The declared 160 is
   * headroom for a longer prefix, not room for caller-supplied text.
   */
  @PrimaryColumn({ type: "varchar", length: 160 })
  key: string;

  @Column({ type: "int", default: 0 })
  hits: number;

  /** When the current window ends. Indexed because the sweep scans on it. */
  @Index()
  @Column({ type: "timestamptz" })
  expiresAt: Date;
}
