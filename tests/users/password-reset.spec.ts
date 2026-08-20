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
import { VerificationToken } from "../../src/entity/VerificationToken.js";
import { clearOutbox, getOutbox } from "../../src/services/MailService.js";
import {
  asCookieHeader,
  cookiesFrom,
  tokenFromMailBody,
} from "../utils/index.js";

const credentials = {
  firstName: "Vipin",
  lastName: "Sao",
  email: "vipinsao3@gmail.com",
  password: "secret123",
};

const requestReset = async (email: string) => {
  clearOutbox();
  const response = await request(app)
    .post("/auth/forgot-password")
    .send({ email });
  const mail = getOutbox().find((message) => message.to === email);
  return { response, token: mail ? tokenFromMailBody(mail.text) : null };
};

describe("Password reset", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  beforeEach(async () => {
    await connection.dropDatabase();
    await connection.synchronize();
    clearOutbox();
    await request(app).post("/auth/register").send(credentials);
  });

  afterAll(async () => {
    await connection.destroy();
    clearOutbox();
  });

  it("should answer 202 and send nothing for an unknown address", async () => {
    const { response, token } = await requestReset("nobody@example.com");
    expect(response.statusCode).toBe(202);
    expect(token).toBeNull();
    expect(getOutbox()).toHaveLength(0);
  });

  it("should answer 202 and email a token for a known address", async () => {
    const { response, token } = await requestReset(credentials.email);
    expect(response.statusCode).toBe(202);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should store only the hash of the token", async () => {
    const { token } = await requestReset(credentials.email);
    const rows = await connection.getRepository(VerificationToken).find();
    const stored = rows.map((row) => row.tokenHash);
    expect(stored).not.toContain(token);
    expect(stored.every((hash) => hash.length === 64)).toBe(true);
  });

  it("should change the password and invalidate the old one", async () => {
    const { token } = await requestReset(credentials.email);

    const reset = await request(app)
      .post("/auth/reset-password")
      .send({ token, password: "brand-new-secret" });
    expect(reset.statusCode).toBe(200);

    const oldPassword = await request(app)
      .post("/auth/login")
      .send({ email: credentials.email, password: credentials.password });
    expect(oldPassword.statusCode).toBe(400);

    const newPassword = await request(app)
      .post("/auth/login")
      .send({ email: credentials.email, password: "brand-new-secret" });
    expect(newPassword.statusCode).toBe(200);
  });

  it("should refuse a token that has already been used", async () => {
    const { token } = await requestReset(credentials.email);

    await request(app)
      .post("/auth/reset-password")
      .send({ token, password: "brand-new-secret" });

    const replay = await request(app)
      .post("/auth/reset-password")
      .send({ token, password: "another-secret" });

    expect(replay.statusCode).toBe(400);
  });

  it("should invalidate the previous token when a new one is requested", async () => {
    const first = await requestReset(credentials.email);
    const second = await requestReset(credentials.email);

    const withOldToken = await request(app)
      .post("/auth/reset-password")
      .send({ token: first.token, password: "brand-new-secret" });
    expect(withOldToken.statusCode).toBe(400);

    const withNewToken = await request(app)
      .post("/auth/reset-password")
      .send({ token: second.token, password: "brand-new-secret" });
    expect(withNewToken.statusCode).toBe(200);
  });

  it("should refuse a malformed token before touching the database", async () => {
    const response = await request(app)
      .post("/auth/reset-password")
      .send({ token: "short", password: "brand-new-secret" });
    expect(response.statusCode).toBe(400);
    expect(response.body.errors.length).toBeGreaterThan(0);
  });

  it("should kill every existing session of that user", async () => {
    const login = await request(app)
      .post("/auth/login")
      .send({ email: credentials.email, password: credentials.password });
    const session = asCookieHeader(cookiesFrom(login));

    const { token } = await requestReset(credentials.email);
    await request(app)
      .post("/auth/reset-password")
      .send({ token, password: "brand-new-secret" });

    const afterReset = await request(app)
      .post("/auth/refresh")
      .set("Cookie", session);
    expect(afterReset.statusCode).toBe(401);
  });
});

describe("Email verification", () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = await AppDataSource.initialize();
  });

  beforeEach(async () => {
    await connection.dropDatabase();
    await connection.synchronize();
    clearOutbox();
  });

  afterAll(async () => {
    await connection.destroy();
    clearOutbox();
  });

  it("should email a verification token on registration", async () => {
    await request(app).post("/auth/register").send(credentials);
    const mail = getOutbox().find(
      (message) => message.to === credentials.email,
    );
    expect(mail).toBeDefined();
    expect(tokenFromMailBody(mail!.text)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should mark the address verified and refuse the token afterwards", async () => {
    await request(app).post("/auth/register").send(credentials);
    const token = tokenFromMailBody(getOutbox()[0].text);

    const verify = await request(app)
      .post("/auth/verify-email")
      .send({ token });
    expect(verify.statusCode).toBe(200);

    const login = await request(app)
      .post("/auth/login")
      .send({ email: credentials.email, password: credentials.password });
    const self = await request(app)
      .get("/auth/self")
      .set("Cookie", asCookieHeader(cookiesFrom(login)));
    expect(self.body.emailVerified).toBe(true);

    const replay = await request(app)
      .post("/auth/verify-email")
      .send({ token });
    expect(replay.statusCode).toBe(400);
  });

  it("should send a fresh token on resend and answer 202 for unknown addresses", async () => {
    await request(app).post("/auth/register").send(credentials);
    clearOutbox();

    const resend = await request(app)
      .post("/auth/resend-verification")
      .send({ email: credentials.email });
    expect(resend.statusCode).toBe(202);
    expect(getOutbox()).toHaveLength(1);

    clearOutbox();
    const unknown = await request(app)
      .post("/auth/resend-verification")
      .send({ email: "nobody@example.com" });
    expect(unknown.statusCode).toBe(202);
    expect(getOutbox()).toHaveLength(0);
  });
});
