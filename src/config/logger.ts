import winston from "winston";
import { Config } from "./index.js";

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

/**
 * One structured JSON line per event. Request-scoped child loggers (created in
 * `requestContext`) attach a `requestId`, so every line belonging to a single
 * request can be grepped together.
 */
const logger = winston.createLogger({
  level: Config.LOG_LEVEL,
  defaultMeta: { serviceName: "auth-service" },
  transports: [
    new winston.transports.File({
      level: "info",
      dirname: "logs",
      filename: "combined.log",
      format: jsonFormat,
      silent: Config.IS_TEST,
    }),
    new winston.transports.File({
      level: "error",
      dirname: "logs",
      filename: "error.log",
      format: jsonFormat,
      silent: Config.IS_TEST,
    }),
    new winston.transports.Console({
      level: Config.LOG_LEVEL,
      format: jsonFormat,
      silent: Config.IS_TEST,
    }),
  ],
});

export default logger;
