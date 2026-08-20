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
import { Roles } from "../../src/constants/index.js";
import { asCookieHeader, cookiesFrom } from "../utils/index.js";

const password = "secret123";

const registerAndLogin = async (email: string, role?: string) => {
  await request(app)
    .post("/auth/register")
    .send({ firstName: "Test", lastName: "User", email, password });

  if (role) {
    await AppDataSource.getRepository(User).update({ email }, { role });
  }

  const login = await request(app)
    .post("/auth/login")
    .send({ email, password });
  return asCookieHeader(cookiesFrom(login));
};

describe("Role based access control", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  beforeEach(async () => {
    await connection.dropDatabase();
    await connection.synchronize();
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it("should assign the customer role on registration", async () => {
    await request(app).post("/auth/register").send({
      firstName: "Test",
      lastName: "User",
      email: "customer@example.com",
      password,
    });

    const user = await connection
      .getRepository(User)
      .findOne({ where: { email: "customer@example.com" } });
    expect(user?.role).toBe(Roles.CUSTOMER);
  });

  it("should answer 401 on GET /users without a token", async () => {
    const response = await request(app).get("/users");
    expect(response.statusCode).toBe(401);
  });

  it("should answer 401 on GET /users for a forged token", async () => {
    const response = await request(app)
      .get("/users")
      .set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.signature");
    expect(response.statusCode).toBe(401);
  });

  it("should answer 403 on GET /users for a customer", async () => {
    const cookies = await registerAndLogin("customer@example.com");
    const response = await request(app).get("/users").set("Cookie", cookies);
    expect(response.statusCode).toBe(403);
  });

  it("should answer 200 on GET /users for an admin", async () => {
    const cookies = await registerAndLogin("admin@example.com", Roles.ADMIN);
    const response = await request(app).get("/users").set("Cookie", cookies);

    expect(response.statusCode).toBe(200);
    expect(response.body.users).toHaveLength(1);
    expect(response.body.users[0]).not.toHaveProperty("password");
  });

  it("should accept the access token as a bearer header too", async () => {
    const cookies = await registerAndLogin("admin2@example.com", Roles.ADMIN);
    const accessToken = cookies
      .find((cookie) => cookie.startsWith("accessToken="))!
      .slice("accessToken=".length);

    const response = await request(app)
      .get("/users")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(response.statusCode).toBe(200);
  });

  it("should answer 401 on GET /auth/self without a token", async () => {
    const response = await request(app).get("/auth/self");
    expect(response.statusCode).toBe(401);
  });
});
