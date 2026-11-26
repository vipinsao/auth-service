import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { mountWebApp } from "../../src/utils/webApp.js";

describe("mountWebApp", () => {
  let distDir: string;
  let emptyDir: string;

  beforeAll(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-dist-"));
    fs.mkdirSync(path.join(distDir, "assets"));
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      "<!doctype html><title>demo ui</title>",
    );
    fs.writeFileSync(
      path.join(distDir, "assets", "index-abc123.js"),
      "console.log(1)",
    );
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-empty-"));
  });

  afterAll(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("serves index.html at / without caching it", async () => {
    const app = express();
    expect(mountWebApp(app, distDir)).toBe(true);

    const response = await request(app).get("/");

    expect(response.statusCode).toBe(200);
    expect(response.text).toContain("demo ui");
    expect(response.headers["cache-control"]).toBe("no-cache");
  });

  it("serves fingerprinted assets as immutable", async () => {
    const app = express();
    mountWebApp(app, distDir);

    const response = await request(app).get("/assets/index-abc123.js");

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("immutable");
  });

  it("mounts nothing when there is no build, leaving / to the API", async () => {
    const app = express();
    expect(mountWebApp(app, emptyDir)).toBe(false);
    app.get("/", (_req, res) => {
      res.json({ service: "auth-service" });
    });

    const response = await request(app).get("/");

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ service: "auth-service" });
  });
});
