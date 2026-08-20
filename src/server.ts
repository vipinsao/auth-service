import { Config } from "./config/index.js";
import app from "./app.js";
import logger from "./config/logger.js";
import { AppDataSource } from "./config/data-source.js";

/** How long a shutdown may take before the process is killed anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const startServer = async () => {
  try {
    await AppDataSource.initialize();
    logger.info("Database connected successfully");

    const server = app.listen(Config.PORT, () => {
      logger.info("Server is listening", {
        port: Config.PORT,
        env: Config.NODE_ENV,
      });
    });

    let shuttingDown = false;

    /**
     * Stop accepting connections, let in-flight requests finish, then close the
     * database pool. Without this a rolling deploy cuts requests off mid-flight
     * and leaves Postgres connections to time out on their own.
     */
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("Shutdown signal received", { signal });

      const forceExit = setTimeout(() => {
        logger.error("Graceful shutdown timed out, forcing exit");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExit.unref();

      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        if (AppDataSource.isInitialized) {
          await AppDataSource.destroy();
        }
        logger.info("Shutdown complete");
        process.exit(0);
      } catch (err) {
        logger.error("Shutdown failed", { message: (err as Error).message });
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));

    // A rejection nobody handled is a bug; log it instead of letting Node print
    // a bare stack trace and (from Node 15 on) kill the process silently.
    process.on("unhandledRejection", (reason) => {
      logger.error("Unhandled promise rejection", { reason: String(reason) });
    });
    process.on("uncaughtException", (err: Error) => {
      logger.error("Uncaught exception", {
        message: err.message,
        stack: err.stack,
      });
      void shutdown("uncaughtException");
    });
  } catch (err) {
    logger.error("Failed to start server", {
      message: (err as Error).message,
    });
    process.exit(1);
  }
};

void startServer();
