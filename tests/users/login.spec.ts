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
