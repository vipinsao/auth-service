import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
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
import app from "../../src/app.js";
import { AppDataSource } from "../../src/config/data-source.js";
import { migrations } from "../../src/migrations/index.js";

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/migrations",
);

const registered = migrations as (new () => object)[];

describe("Database migrations", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  // Start from genuinely nothing: no tables, and no `migrations` bookkeeping
  // table either, so `runMigrations` is exercised the way it is on a brand new
  // production database rather than as a no-op.
  beforeEach(async () => {
    await connection.dropDatabase();
  });

  // Leave the schema behind for whichever suite runs next, since the others
  // build it with `synchronize` in their own beforeEach and this one does not.
  afterAll(async () => {
    await connection.dropDatabase();
    await connection.synchronize();
    await connection.destroy();
  });

  it("registers every migration file in src/migrations/index.ts", async () => {
    const files = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith(".ts") && file !== "index.ts")
      .sort();

    // `1787212846340-InitialSchema.ts` exports `InitialSchema1787212846340`.
    const expected = files.map((file) => {
      const [timestamp, rest] = file.replace(/\.ts$/, "").split("-");
      return `${rest}${timestamp}`;
    });

    expect(files.length).toBeGreaterThan(0);
    expect(registered.map((migration) => migration.name)).toEqual(expected);
  });

  it("builds the whole schema from empty", async () => {
    const applied = await connection.runMigrations();
    expect(applied.map((migration) => migration.name)).toEqual(
      registered.map((migration) => migration.name),
    );

    const queryRunner = connection.createQueryRunner();
    try {
      for (const table of ["user", "refresh_token", "verification_token"]) {
        expect(await queryRunner.hasTable(table)).toBe(true);
      }
    } finally {
      await queryRunner.release();
    }
  });

  it("leaves nothing for synchronize to change, so it matches the entities", async () => {
    await connection.runMigrations();

    // This is the check that catches a migration drifting from the entity
    // classes: the schema builder reports the DDL `synchronize` would still run
    // to make the database match the entities. After the migrations there must
    // be none - if an entity gains a column and no migration is written, this
    // fails with that ALTER TABLE in the message.
    const pending = await connection.driver.createSchemaBuilder().log();

    expect(pending.upQueries.map((query) => query.query)).toEqual([]);
  });

  it("serves the full auth flow on a migration-built schema", async () => {
    await connection.runMigrations();

    const credentials = {
      email: "migrated@example.com",
      password: "secret123",
    };

    const register = await request(app)
      .post("/auth/register")
      .send({ firstName: "Mig", lastName: "Rated", ...credentials });
    expect(register.statusCode).toBe(201);

    const login = await request(app).post("/auth/login").send(credentials);
    expect(login.statusCode).toBe(200);

    const cookies = (login.headers["set-cookie"] as unknown as string[]).map(
      (cookie) => cookie.split(";")[0],
    );

    const refresh = await request(app)
      .post("/auth/refresh")
      .set("Cookie", cookies);
    expect(refresh.statusCode).toBe(200);

    // Replaying the token the refresh above burned proves the reuse detection
    // still works, which depends on the familyId column and its index.
    const replay = await request(app)
      .post("/auth/refresh")
      .set("Cookie", cookies);
    expect(replay.statusCode).toBe(401);
  });

  it("reverts cleanly, dropping every table it created", async () => {
    await connection.runMigrations();

    for (let i = 0; i < registered.length; i++) {
      await connection.undoLastMigration();
    }

    const queryRunner = connection.createQueryRunner();
    try {
      for (const table of ["user", "refresh_token", "verification_token"]) {
        expect(await queryRunner.hasTable(table)).toBe(false);
      }
      // TypeORM never drops its own bookkeeping table, but it must be empty.
      const rows = await queryRunner.query(`SELECT * FROM "migrations"`);
      expect(rows).toEqual([]);
    } finally {
      await queryRunner.release();
    }
  });
});
