import request from "supertest";
import { DataSource, IsNull, Not } from "typeorm";
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
import { RefreshToken } from "../../src/entity/RefreshToken.js";
import { TokenService } from "../../src/services/TokenService.js";
import { asCookieHeader, cookiesFrom, cookieValue } from "../utils/index.js";

const credentials = {
  firstName: "Vipin",
  lastName: "Sao",
  email: "vipinsao3@gmail.com",
  password: "secret123",
};

const login = async () => {
  const response = await request(app)
    .post("/auth/login")
    .send({ email: credentials.email, password: credentials.password });
  return cookiesFrom(response);
};

describe("POST /auth/refresh", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  beforeEach(async () => {
    await connection.dropDatabase();
    await connection.synchronize();
    await request(app).post("/auth/register").send(credentials);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it("should return 401 without a refresh cookie", async () => {
    const response = await request(app).post("/auth/refresh");
    expect(response.statusCode).toBe(401);
  });

  it("should return 401 for a refresh token this service did not sign", async () => {
    const response = await request(app)
      .post("/auth/refresh")
      .set("Cookie", ["refreshToken=not.a.jwt"]);
    expect(response.statusCode).toBe(401);
  });

  it("should issue a different refresh token and revoke the old row", async () => {
    const first = await login();
    const firstToken = cookieValue(first, "refreshToken");

    const response = await request(app)
      .post("/auth/refresh")
      .set("Cookie", asCookieHeader(first));

    expect(response.statusCode).toBe(200);
    const secondToken = cookieValue(cookiesFrom(response), "refreshToken");
    expect(secondToken).not.toBeNull();
    expect(secondToken).not.toBe(firstToken);

    // Registration already opened a family, so only the last two rows belong to
    // the session this test logged in with.
    const rows = await connection
      .getRepository(RefreshToken)
      .find({ order: { id: "ASC" } });
    const [spent, replacement] = rows.slice(-2);

    expect(spent.revokedAt).not.toBeNull();
    expect(spent.replacedByTokenId).toBe(replacement.id);
    expect(replacement.revokedAt).toBeNull();
    // The successor stays in the same family as the token it replaced.
    expect(replacement.familyId).toBe(spent.familyId);
  });

  it("should keep the new access token working after rotation", async () => {
    const first = await login();
    const rotated = await request(app)
      .post("/auth/refresh")
      .set("Cookie", asCookieHeader(first));

    const self = await request(app)
      .get("/auth/self")
      .set("Cookie", asCookieHeader(cookiesFrom(rotated)));

    expect(self.statusCode).toBe(200);
  });

  describe("reuse detection", () => {
    it("should revoke the whole family when a rotated token is replayed", async () => {
      const first = await login();
      const rotated = await request(app)
        .post("/auth/refresh")
        .set("Cookie", asCookieHeader(first));
      expect(rotated.statusCode).toBe(200);

      // An attacker replays the token that was already exchanged.
      const replay = await request(app)
        .post("/auth/refresh")
        .set("Cookie", asCookieHeader(first));

      expect(replay.statusCode).toBe(401);
      expect(replay.body.errors[0].msg).toBe("Refresh token reuse detected");

      // The legitimate holder of the rotated token is logged out too: we cannot
      // tell which of the two parties is the thief.
      const legitimate = await request(app)
        .post("/auth/refresh")
        .set("Cookie", asCookieHeader(cookiesFrom(rotated)));
      expect(legitimate.statusCode).toBe(401);

      const rows = await connection
        .getRepository(RefreshToken)
        .find({ order: { id: "ASC" } });
      const compromisedFamily = rows[rows.length - 1].familyId;
      const inFamily = rows.filter((row) => row.familyId === compromisedFamily);

      expect(inFamily).toHaveLength(2);
      expect(inFamily.every((row) => row.revokedAt !== null)).toBe(true);
      // Families outside the compromised one are untouched.
      expect(
        rows
          .filter((row) => row.familyId !== compromisedFamily)
          .every((row) => row.revokedAt === null),
      ).toBe(true);
    });

    it("should leave other sessions of the same user alone", async () => {
      const compromised = await login();
      const otherDevice = await login();

      await request(app)
        .post("/auth/refresh")
        .set("Cookie", asCookieHeader(compromised));
      await request(app)
        .post("/auth/refresh")
        .set("Cookie", asCookieHeader(compromised));

      // The second device, a separate family, is unaffected.
      const stillValid = await request(app)
        .post("/auth/refresh")
        .set("Cookie", asCookieHeader(otherDevice));
      expect(stillValid.statusCode).toBe(200);
    });

    /**
     * Rotation used to read the row, see revokedAt was null, and only then
     * write. Two refreshes arriving together both passed that read, so both
     * rotated: the family ended up with two live successors and the replay
     * that should have burned it went undetected.
     *
     * Rotation now runs in a transaction that takes a write lock on the row it
     * is spending, so the second caller waits instead of racing. The lock also
     * has to be held until commit, which this test is what proved: with only a
     * conditional UPDATE, the loser revoked the family in the window before the
     * winner's successor was committed, and that successor quietly survived a
     * detected replay.
     */
    it("lets only one of two simultaneous refreshes win", async () => {
      const session = await login();
      const cookie = asCookieHeader(session);

      const [first, second] = await Promise.all([
        request(app).post("/auth/refresh").set("Cookie", cookie),
        request(app).post("/auth/refresh").set("Cookie", cookie),
      ]);

      const codes = [first.statusCode, second.statusCode].sort();
      expect(codes).toEqual([200, 401]);

      // Scoped to this login's family: registering also opens a session, and
      // that one is a different family which must be left alone.
      const repository = connection.getRepository(RefreshToken);
      const winner = await repository.findOne({
        where: { replacedByTokenId: Not(IsNull()) },
      });
      const family = winner!.familyId;

      // Exactly one successor was created - not two, which is what the race
      // produced before the row lock.
      expect(await repository.count({ where: { familyId: family } })).toBe(2);

      // And the loser being treated as a replay burned the whole family,
      // including the successor the winner had just committed. That last part
      // is the reason rotation holds the row lock until it commits: revoking
      // the family a moment earlier would have missed the new row.
      expect(
        await repository.count({
          where: { familyId: family, revokedAt: IsNull() },
        }),
      ).toBe(0);

      // The unrelated session opened by registering is untouched.
      expect(await repository.count({ where: { revokedAt: IsNull() } })).toBe(
        1,
      );
    });
  });
});

describe("POST /auth/logout", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  beforeEach(async () => {
    await connection.dropDatabase();
    await connection.synchronize();
    await request(app).post("/auth/register").send(credentials);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it("should clear the cookies and make the refresh token unusable", async () => {
    const session = await login();

    const logout = await request(app)
      .post("/auth/logout")
      .set("Cookie", asCookieHeader(session));

    expect(logout.statusCode).toBe(200);
    expect(cookieValue(cookiesFrom(logout), "accessToken")).toBeNull();
    expect(cookieValue(cookiesFrom(logout), "refreshToken")).toBeNull();

    const afterLogout = await request(app)
      .post("/auth/refresh")
      .set("Cookie", asCookieHeader(session));
    expect(afterLogout.statusCode).toBe(401);
  });

  it("should succeed even without a refresh cookie", async () => {
    const response = await request(app).post("/auth/logout");
    expect(response.statusCode).toBe(200);
  });
});

/**
 * Revoking a set of tokens while a rotation of one of them is still in flight.
 *
 * The race above proves the lock `rotate` takes; these prove the one the
 * revokers were missing. Every revocation path in the service - reuse detected
 * on refresh, logout, and the `revokeAllForUser` a password reset runs - ends
 * in a bulk `UPDATE ... WHERE revokedAt IS NULL`, and at READ COMMITTED that
 * statement's snapshot is fixed before the rotation inserts the successor. The
 * UPDATE blocks on the predecessor, is released when the rotation commits, and
 * revokes nothing: the predecessor is spent by then and the successor was never
 * in its snapshot. The family is reported revoked and a live token remains.
 *
 * The interleaving is driven by hand rather than raced, because a race that
 * only reproduces sometimes is a test that only fails sometimes. A second
 * connection takes the write lock `rotate` would hold, the revoke is started
 * and confirmed to be waiting on that lock (`pg_stat_activity`), and only then
 * does the first connection insert the successor and commit.
 */
describe("revoking tokens while a rotation is in flight", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  beforeEach(async () => {
    await connection.dropDatabase();
    await connection.synchronize();
    await request(app).post("/auth/register").send(credentials);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  /** Fails rather than proceeding, so a revoke that did not block cannot pass. */
  const waitUntilBlocked = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = (await connection.query(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )) as { waiting: number }[];
      if (rows[0].waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the revoke never blocked on the locked row");
  };

  /**
   * Everything `rotate` does, on a connection this test controls: hold the
   * write lock on the row being spent, let the revoke queue behind it, then
   * insert the successor and spend the predecessor in the same transaction.
   */
  const rotateByHand = async (predecessor: RefreshToken) => {
    const runner = connection.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(
      `SELECT "id" FROM "refresh_token" WHERE "id" = $1 FOR UPDATE`,
      [predecessor.id],
    );

    return {
      async finish() {
        const inserted = (await runner.query(
          `INSERT INTO "refresh_token" ("userId", "familyId", "expiresAt")
           VALUES ($1, $2, now() + interval '30 days')
           RETURNING "id"`,
          [predecessor.userId, predecessor.familyId],
        )) as { id: number }[];

        await runner.query(
          `UPDATE "refresh_token"
              SET "revokedAt" = now(), "replacedByTokenId" = $2
            WHERE "id" = $1`,
          [predecessor.id, inserted[0].id],
        );

        await runner.commitTransaction();
        await runner.release();
        return inserted[0].id;
      },
    };
  };

  const liveToken = async () => {
    const repository = connection.getRepository(RefreshToken);
    const row = await repository.findOne({
      where: { revokedAt: IsNull() },
      order: { id: "DESC" },
    });
    return row!;
  };

  it("revokes a successor the rotation inserts after the revoke has started", async () => {
    const repository = connection.getRepository(RefreshToken);
    const tokenService = new TokenService(repository);

    await login();
    const predecessor = await liveToken();

    const rotation = await rotateByHand(predecessor);

    const revoked = tokenService.revokeFamily(predecessor.familyId);
    await waitUntilBlocked();

    const successorId = await rotation.finish();
    await revoked;

    // Without the lock the revoke reports zero rows changed and this successor
    // is still live behind a family the service has declared revoked.
    const successor = await repository.findOne({ where: { id: successorId } });
    expect(successor!.revokedAt).not.toBeNull();
    expect(
      await repository.count({
        where: { familyId: predecessor.familyId, revokedAt: IsNull() },
      }),
    ).toBe(0);
  });

  /**
   * The same hole under `revokeAllForUser`, which is the one a password reset
   * runs. Worst case of the four: the user has just changed their password
   * because they believe someone else has it, and the attacker keeps a refresh
   * token good for thirty days.
   */
  it("revokes every session of a user, including one mid-rotation", async () => {
    const repository = connection.getRepository(RefreshToken);
    const tokenService = new TokenService(repository);

    await login();
    const predecessor = await liveToken();

    const rotation = await rotateByHand(predecessor);

    const revoked = tokenService.revokeAllForUser(predecessor.userId);
    await waitUntilBlocked();

    const successorId = await rotation.finish();
    await revoked;

    const successor = await repository.findOne({ where: { id: successorId } });
    expect(successor!.revokedAt).not.toBeNull();
    expect(
      await repository.count({
        where: { userId: predecessor.userId, revokedAt: IsNull() },
      }),
    ).toBe(0);
  });
});
