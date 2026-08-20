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
import { RefreshToken } from "../../src/entity/RefreshToken.js";
import { Roles } from "../../src/constants/index.js";
import { cookiesFrom, cookieValue, isJwt } from "../utils/index.js";
import { clearOutbox } from "../../src/services/MailService.js";

const userData = {
  firstName: "Vipin",
  lastName: "Sao",
  email: "vipinsao3@gmail.com",
  password: "secret123",
};

describe("POST /auth/register", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  // Each test starts from an empty schema so nothing leaks between cases.
  beforeEach(async () => {
    await connection.dropDatabase();
    await connection.synchronize();
    clearOutbox();
  });

  afterAll(async () => {
    await connection.destroy();
  });

  describe("Given all fields", () => {
    it("should return 201 and JSON", async () => {
      const response = await request(app).post("/auth/register").send(userData);

      expect(response.statusCode).toBe(201);
      expect(response.headers["content-type"]).toContain("json");
      expect(response.body).toHaveProperty("userId");
    });

    it("should persist the user", async () => {
      const response = await request(app).post("/auth/register").send(userData);

      const users = await connection.getRepository(User).find();
      expect(users).toHaveLength(1);
      expect(users[0].firstName).toBe(userData.firstName);
      expect(users[0].lastName).toBe(userData.lastName);
      expect(users[0].email).toBe(userData.email);
      expect(response.body.userId).toBe(users[0].id);
    });

    it("should assign the customer role and leave the email unverified", async () => {
      await request(app).post("/auth/register").send(userData);

      const users = await connection.getRepository(User).find();
      expect(users[0].role).toBe(Roles.CUSTOMER);
      expect(users[0].emailVerified).toBe(false);
    });

    it("should store a bcrypt hash, never the plaintext password", async () => {
      await request(app).post("/auth/register").send(userData);

      const users = await connection.getRepository(User).find();
      expect(users[0].password).not.toBe(userData.password);
      expect(users[0].password).toHaveLength(60);
      expect(users[0].password).toMatch(/^\$2[aby]\$\d+\$/);
    });

    it("should return 400 if the email is already registered", async () => {
      await request(app).post("/auth/register").send(userData);
      const response = await request(app).post("/auth/register").send(userData);

      const users = await connection.getRepository(User).find();
      expect(response.statusCode).toBe(400);
      expect(users).toHaveLength(1);
    });

    it("should set httpOnly access and refresh token cookies", async () => {
      const response = await request(app).post("/auth/register").send(userData);
      const cookies = cookiesFrom(response);

      expect(isJwt(cookieValue(cookies, "accessToken"))).toBe(true);
      expect(isJwt(cookieValue(cookies, "refreshToken"))).toBe(true);
      expect(cookies.every((cookie) => cookie.includes("HttpOnly"))).toBe(true);
      expect(
        cookies.every((cookie) => cookie.includes("SameSite=Strict")),
      ).toBe(true);
    });

    it("should persist exactly one refresh token row for the new user", async () => {
      const response = await request(app).post("/auth/register").send(userData);

      const tokens = await connection
        .getRepository(RefreshToken)
        .find({ where: { userId: response.body.userId as number } });

      expect(tokens).toHaveLength(1);
      expect(tokens[0].revokedAt).toBeNull();
      expect(tokens[0].familyId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe("Fields are missing", () => {
    it.each(["email", "firstName", "lastName", "password"])(
      "should return 400 when %s is empty",
      async (field) => {
        const response = await request(app)
          .post("/auth/register")
          .send({ ...userData, [field]: "" });

        expect(response.statusCode).toBe(400);
        const users = await connection.getRepository(User).find();
        expect(users).toHaveLength(0);
      },
    );
  });

  describe("Fields are not in the expected format", () => {
    it("should trim surrounding whitespace off the email", async () => {
      await request(app)
        .post("/auth/register")
        .send({ ...userData, email: " vipinsao3@gmail.com " });

      const users = await connection.getRepository(User).find();
      expect(users[0].email).toBe("vipinsao3@gmail.com");
    });

    it("should return 400 for an invalid email", async () => {
      const response = await request(app)
        .post("/auth/register")
        .send({ ...userData, email: "vipinsao3" });

      expect(response.statusCode).toBe(400);
      const users = await connection.getRepository(User).find();
      expect(users).toHaveLength(0);
    });

    it("should return 400 for a password shorter than 8 characters", async () => {
      const response = await request(app)
        .post("/auth/register")
        .send({ ...userData, password: "pass" });

      expect(response.statusCode).toBe(400);
      const users = await connection.getRepository(User).find();
      expect(users).toHaveLength(0);
    });

    it("should return the failures in an errors array", async () => {
      const response = await request(app)
        .post("/auth/register")
        .send({ ...userData, email: "vipinsao3", password: "pass" });

      expect(response.body).toHaveProperty("errors");
      expect(response.body.errors.length).toBeGreaterThan(0);
    });
  });
});
