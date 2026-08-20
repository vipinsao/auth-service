import { createHash } from "crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { DataSource } from "typeorm";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "@jest/globals";
import { AppDataSource } from "../../src/config/data-source.js";
import { PostgresRateLimitStore } from "../../src/middlewares/rateLimitStore.js";

const WINDOW_MS = 60_000;
const LIMIT = 3;

/**
 * Stands in for one replica: its own Express app and its own store object,
 * exactly as a second process would have, sharing only the database.
 */
const replica = () => {
  const app = express();
  app.use(
    rateLimit({
      windowMs: WINDOW_MS,
      limit: LIMIT,
      keyGenerator: () => "client",
      store: new PostgresRateLimitStore("test"),
      validate: false,
    }),
  );
  app.get("/", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
};

describe("PostgresRateLimitStore", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  beforeEach(async () => {
    await connection.query(`DELETE FROM "rate_limit_hit"`);
  });

  afterAll(async () => {
    await connection.query(`DELETE FROM "rate_limit_hit"`);
    await connection.destroy();
  });

  it("shares one budget across independent replicas", async () => {
    const a = replica();
    const b = replica();

    // Spend the whole budget on the first replica.
    for (let i = 0; i < LIMIT; i++) {
      expect((await request(a).get("/")).statusCode).toBe(200);
    }

    // The second replica has served nothing, and must still refuse. With the
    // in-process default store this is a 200 - which is the bug this store
    // exists to fix.
    expect((await request(b).get("/")).statusCode).toBe(429);
  });

  /**
   * express-rate-limit hands the store a bare client key - it does not prepend
   * `store.prefix`, it only reads that field for its own double-count check.
   * So the same caller arrives at both limiters as the identical string, and
   * the store has to scope it. Without that, `authLimiter` and `refreshLimiter`
   * write to one row and silently share one budget.
   */
  it("keeps separate limiters on separate budgets", async () => {
    const auth = new PostgresRateLimitStore("auth");
    const refresh = new PostgresRateLimitStore("refresh");
    auth.init({ windowMs: WINDOW_MS } as never);
    refresh.init({ windowMs: WINDOW_MS } as never);

    // The same key both times, exactly as express-rate-limit would pass it.
    await auth.increment("1.2.3.4");
    await auth.increment("1.2.3.4");
    const other = await refresh.increment("1.2.3.4");

    expect(other.totalHits).toBe(1);
    expect((await auth.get("1.2.3.4"))?.totalHits).toBe(2);

    // Two rows, one per limiter: same client, same hash, different prefix.
    const rows = (await connection.query(
      `SELECT "key" FROM "rate_limit_hit" ORDER BY "key"`,
    )) as { key: string }[];
    const digest = createHash("sha256").update("1.2.3.4").digest("hex");
    expect(rows.map((row) => row.key)).toEqual([
      `auth:${digest}`,
      `refresh:${digest}`,
    ]);
  });

  it("starts a new window rather than carrying the count over", async () => {
    const store = new PostgresRateLimitStore("test");
    store.init({ windowMs: WINDOW_MS } as never);

    const first = await store.increment("client");
    expect(first.totalHits).toBe(1);

    // Age the row past its window instead of waiting for it. Matched on the
    // prefix because the rest of the stored key is a hash of the client key.
    await connection.query(
      `UPDATE "rate_limit_hit" SET "expiresAt" = now() - interval '1 second' WHERE "key" LIKE $1`,
      ["test:%"],
    );

    const afterExpiry = await store.increment("client");
    expect(afterExpiry.totalHits).toBe(1);
    expect(afterExpiry.resetTime!.getTime()).toBeGreaterThan(Date.now());
  });

  it("refunds a request without going below zero", async () => {
    const store = new PostgresRateLimitStore("test");
    store.init({ windowMs: WINDOW_MS } as never);

    await store.increment("client");
    await store.decrement("client");
    await store.decrement("client");

    expect((await store.get("client"))?.totalHits).toBe(0);
  });

  /**
   * The client key is `req.ip`, and behind a trusted proxy that is
   * X-Forwarded-For - a request header Express neither validates nor bounds.
   * Before the key was hashed, a long enough header overflowed the
   * varchar(160) primary key, Postgres raised 22001, and express-rate-limit
   * handed that to next(err): an unauthenticated 500 on every credential
   * endpoint, from one header.
   */
  it("survives a client key that is neither short nor an IP address", async () => {
    const store = new PostgresRateLimitStore("test");
    store.init({ windowMs: WINDOW_MS } as never);

    const hostile = [
      "A".repeat(4096),
      "'; DROP TABLE rate_limit_hit; --",
      "☃",
    ];

    for (const key of hostile) {
      const result = await store.increment(key);
      expect(result.totalHits).toBe(1);
    }

    // Still one row each, and every stored key is the fixed width the column
    // was sized for.
    const rows = (await connection.query(
      `SELECT "key" FROM "rate_limit_hit"`,
    )) as { key: string }[];
    expect(rows).toHaveLength(hostile.length);
    for (const row of rows) {
      expect(row.key).toMatch(/^test:[0-9a-f]{64}$/);
    }

    // The table is intact, which is the other half of the SQL-ish key above.
    expect(await store.get(hostile[1])).toBeDefined();
  });

  it("forgets a key on reset", async () => {
    const store = new PostgresRateLimitStore("test");
    store.init({ windowMs: WINDOW_MS } as never);

    await store.increment("client");
    await store.resetKey("client");

    expect(await store.get("client")).toBeUndefined();
  });
});
