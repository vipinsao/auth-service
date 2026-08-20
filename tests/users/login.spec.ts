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
import { User } from "../../src/entity/User.js";
import { Config } from "../../src/config/index.js";
import {
  asCookieHeader,
  cookiesFrom,
  cookieValue,
  isJwt,
} from "../utils/index.js";

const credentials = {
  firstName: "Vipin",
  lastName: "Sao",
  email: "vipinsao3@gmail.com",
  password: "secret123",
};

describe("POST /auth/login", () => {
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

  it("should return 200 and the user id for correct credentials", async () => {
    const response = await request(app)
      .post("/auth/login")
      .send({ email: credentials.email, password: credentials.password });

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveProperty("id");
  });

  it("should set signed access and refresh token cookies", async () => {
    const response = await request(app)
      .post("/auth/login")
      .send({ email: credentials.email, password: credentials.password });

    const cookies = cookiesFrom(response);
    expect(isJwt(cookieValue(cookies, "accessToken"))).toBe(true);
    expect(isJwt(cookieValue(cookies, "refreshToken"))).toBe(true);
    expect(cookies.join(";")).toContain("HttpOnly");
    expect(cookies.join(";")).toContain("SameSite=Strict");
  });

  // Regression test. The handler used to call the async comparePassword without
  // awaiting it; the returned Promise is always truthy, so ANY password logged
  // the user in. This test failed with 200 before that fix.
  it("should reject a wrong password with 400", async () => {
    const response = await request(app).post("/auth/login").send({
      email: credentials.email,
      password: "definitely-not-the-password",
    });

    expect(response.statusCode).toBe(400);
    expect(cookieValue(cookiesFrom(response), "accessToken")).toBeNull();
  });

  it("should reject an unknown email with the same 400 message", async () => {
    const response = await request(app)
      .post("/auth/login")
      .send({ email: "nobody@example.com", password: credentials.password });

    expect(response.statusCode).toBe(400);
    expect(response.body.errors[0].msg).toBe(
      "Email or password does not match",
    );
  });

  it("should return 400 when the payload fails validation", async () => {
    const response = await request(app)
      .post("/auth/login")
      .send({ email: "not-an-email", password: "" });

    expect(response.statusCode).toBe(400);
    expect(response.body.errors.length).toBeGreaterThan(0);
  });

  /**
   * The error body for an unknown address and for a wrong password has always
   * been identical. The time taken was not: the unknown-address path returned
   * before bcrypt ran, so it answered in about 0ms while a real address cost a
   * bcrypt compare. That gap is far larger than network jitter and told an
   * attacker which addresses have accounts.
   *
   * The assertion is a ratio rather than a millisecond figure on purpose - both
   * paths now run one bcrypt compare at the same cost factor, so the ratio
   * holds whether the machine running this is fast or slow.
   */
  it("spends the same work on an unknown address as on a real one", async () => {
    const timed = async (email: string) => {
      const started = process.hrtime.bigint();
      const response = await request(app)
        .post("/auth/login")
        .send({ email, password: "definitely-not-the-password" });
      return {
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        response,
      };
    };

    const known = await timed(credentials.email);
    const unknown = await timed("nobody-at-all@example.com");

    // Same answer...
    expect(known.response.statusCode).toBe(400);
    expect(unknown.response.statusCode).toBe(400);
    expect(unknown.response.body.errors[0].msg).toBe(
      known.response.body.errors[0].msg,
    );

    // ...and the same order of magnitude of work behind it.
    expect(unknown.ms).toBeGreaterThan(known.ms * 0.5);
  });

  describe("account lockout", () => {
    it("should lock the account after the configured number of failures", async () => {
      for (
        let attempt = 0;
        attempt < Config.MAX_FAILED_LOGIN_ATTEMPTS;
        attempt++
      ) {
        const failure = await request(app)
          .post("/auth/login")
          .send({ email: credentials.email, password: "wrong-password" });
        expect(failure.statusCode).toBe(400);
      }

      // The correct password is now refused too - the lock is on the account,
      // not on the guess.
      const locked = await request(app)
        .post("/auth/login")
        .send({ email: credentials.email, password: credentials.password });

      expect(locked.statusCode).toBe(423);

      const user = await connection
        .getRepository(User)
        .findOne({ where: { email: credentials.email } });
      expect(user?.lockedUntil).not.toBeNull();
    });

    /**
     * The lock used to be a flat ACCOUNT_LOCK_MINUTES, which made it a denial
     * of service: anyone knowing an address could take it offline for fifteen
     * minutes with five requests. The first lock is now
     * ACCOUNT_LOCK_INITIAL_MINUTES and doubles from there, so the case a real
     * user hits - and the case a drive-by attacker causes - is short.
     */
    it("starts the lock short rather than at the maximum", async () => {
      for (
        let attempt = 0;
        attempt < Config.MAX_FAILED_LOGIN_ATTEMPTS;
        attempt++
      ) {
        await request(app)
          .post("/auth/login")
          .send({ email: credentials.email, password: "wrong-password" });
      }

      const user = await connection
        .getRepository(User)
        .findOne({ where: { email: credentials.email } });

      const lockedForMinutes =
        (user!.lockedUntil!.getTime() - Date.now()) / 60_000;

      expect(lockedForMinutes).toBeGreaterThan(0);
      // The initial lock, not the cap - with room for test execution time.
      expect(lockedForMinutes).toBeLessThan(
        Config.ACCOUNT_LOCK_INITIAL_MINUTES + 1,
      );
      expect(lockedForMinutes).toBeLessThan(Config.ACCOUNT_LOCK_MINUTES);
    });

    /**
     * Counting in JavaScript from a row read earlier in the request meant two
     * simultaneous failures both read the same value and both wrote the same
     * value, so the counter advanced by one instead of two and an attacker
     * sending guesses in parallel never tripped the cap. The increment is now
     * inside the UPDATE.
     */
    it("counts simultaneous failures individually", async () => {
      const failure = () =>
        request(app)
          .post("/auth/login")
          .send({ email: credentials.email, password: "wrong-password" });

      const concurrent = Config.MAX_FAILED_LOGIN_ATTEMPTS - 1;
      await Promise.all(Array.from({ length: concurrent }, failure));

      const user = await connection
        .getRepository(User)
        .findOne({ where: { email: credentials.email } });

      expect(user?.failedLoginAttempts).toBe(concurrent);
    });

    /**
     * 423 was a second enumeration oracle: five failures against a guessed
     * address returned 400 if nobody owned it and 423 if somebody did, so the
     * attacker learned the answer without ever knowing a password. The lock is
     * now reported only to a caller who has already proved they know it.
     */
    it("does not reveal the lock to someone who does not know the password", async () => {
      for (
        let attempt = 0;
        attempt < Config.MAX_FAILED_LOGIN_ATTEMPTS;
        attempt++
      ) {
        await request(app)
          .post("/auth/login")
          .send({ email: credentials.email, password: "wrong-password" });
      }

      const stillGuessing = await request(app)
        .post("/auth/login")
        .send({ email: credentials.email, password: "another-wrong-guess" });

      // Indistinguishable from an address that has no account at all.
      expect(stillGuessing.statusCode).toBe(400);

      const unknownAddress = await request(app)
        .post("/auth/login")
        .send({ email: "nobody-at-all@example.com", password: "whatever" });
      expect(unknownAddress.statusCode).toBe(400);
      expect(stillGuessing.body.errors[0].msg).toBe(
        unknownAddress.body.errors[0].msg,
      );
    });

    it("should clear the failure counter after a successful login", async () => {
      await request(app)
        .post("/auth/login")
        .send({ email: credentials.email, password: "wrong-password" });

      await request(app)
        .post("/auth/login")
        .send({ email: credentials.email, password: credentials.password });

      const user = await connection
        .getRepository(User)
        .findOne({ where: { email: credentials.email } });
      expect(user?.failedLoginAttempts).toBe(0);
      expect(user?.lockedUntil).toBeNull();
    });
  });

  describe("email verification gate", () => {
    afterAll(() => {
      Config.REQUIRE_EMAIL_VERIFICATION = false;
    });

    it("should refuse an unverified account when the gate is on", async () => {
      Config.REQUIRE_EMAIL_VERIFICATION = true;
      const response = await request(app)
        .post("/auth/login")
        .send({ email: credentials.email, password: credentials.password });

      expect(response.statusCode).toBe(403);
      Config.REQUIRE_EMAIL_VERIFICATION = false;
    });
  });

  it("should hand back a session usable on a protected route", async () => {
    const login = await request(app)
      .post("/auth/login")
      .send({ email: credentials.email, password: credentials.password });

    const self = await request(app)
      .get("/auth/self")
      .set("Cookie", asCookieHeader(cookiesFrom(login)));

    expect(self.statusCode).toBe(200);
    expect(self.body.email).toBe(credentials.email);
    expect(self.body).not.toHaveProperty("password");
  });
});
