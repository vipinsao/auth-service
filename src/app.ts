import "reflect-metadata";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";

import { Config } from "./config/index.js";
import { requestContext } from "./middlewares/requestContext.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { openApiDocument } from "./docs/openapi.js";
import authRouter from "./routes/auth.js";
import userRouter from "./routes/users.js";
import healthRouter from "./routes/health.js";

const app = express();

// Behind a proxy or load balancer, express must trust X-Forwarded-For or every
// client looks like the proxy and the per-IP rate limiter becomes useless.
app.set("trust proxy", 1);

// First, so that even a 404 or a rejected request carries a request id.
app.use(requestContext);

// Swagger UI needs inline styles and scripts, so it gets its own relaxed CSP
// rather than loosening the policy for the whole API. It is mounted before the
// global helmet and terminates the request, so the strict policy never applies.
app.use(
  "/api-docs",
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
      },
    },
  }),
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument),
);

app.use(helmet());
app.use(
  cors({
    origin: Config.CORS_ORIGINS,
    credentials: true,
  }),
);
// A body cap keeps a single request from allocating unbounded memory.
app.use(express.json({ limit: "16kb" }));
app.use(cookieParser());

app.use(healthRouter);

app.get("/", (_req, res) => {
  res.json({
    service: "auth-service",
    docs: "/api-docs",
    health: "/health",
  });
});

app.use("/auth", authRouter);
app.use("/users", userRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
