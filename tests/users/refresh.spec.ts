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
import { RefreshToken } from "../../src/entity/RefreshToken.js";
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
