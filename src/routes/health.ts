import express from "express";
import { AppDataSource } from "../config/data-source.js";

const router = express.Router();

/** Liveness: is the process up. Never touches the database. */
router.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptimeSeconds: process.uptime() });
});

/**
 * Readiness: can this instance actually serve traffic. An orchestrator should
 * pull it out of the load balancer while this is failing, without restarting
 * it - which is exactly why it is a different endpoint from /health.
 */
router.get("/ready", async (req, res) => {
  try {
    if (!AppDataSource.isInitialized) {
      throw new Error("Database connection is not initialised");
    }
    await AppDataSource.query("SELECT 1");
    res.status(200).json({ status: "ready", database: "up" });
  } catch (err) {
    req.log?.error("readiness check failed", {
      message: (err as Error).message,
    });
    res.status(503).json({ status: "not-ready", database: "down" });
  }
});

export default router;
