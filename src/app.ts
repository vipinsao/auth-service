import "reflect-metadata";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import path from "path";
import { fileURLToPath } from "url";

import { Config } from "./config/index.js";
import { requestContext } from "./middlewares/requestContext.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { openApiDocument } from "./docs/openapi.js";
import authRouter from "./routes/auth.js";
import userRouter from "./routes/users.js";
import healthRouter from "./routes/health.js";
import { mountWebApp } from "./utils/webApp.js";

// __dirname is not defined in ES modules. src/app.ts and build/app.js both sit
// one level below the repository root, so ../web/dist resolves from either.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Whether X-Forwarded-For is believed, and therefore what `req.ip` is - which
// is what the rate limiters key on.
//
// This used to be hard-coded to 1. Nothing in the shipped Compose stack puts a
// proxy in front of the service, so the header was attacker-controlled: any
// caller could send their own X-Forwarded-For, land in a rate-limit bucket of
// their choosing, and never be throttled. Express does not validate the value
// either, so the "IP" did not have to be an IP.
//
// It now defaults to false and is opt-in via TRUST_PROXY, because a service
// that under-counts a proxy's clients is a worse deployment, while a service
// that trusts a forged header is a broken rate limiter. Setting it is only safe
// where the port is unreachable except through the proxy - see the precondition
// written out over `trustProxy` in config/index.ts.
app.set("trust proxy", Config.TRUST_PROXY);

// First, so that even a 404 or a rejected request carries a request id.
app.use(requestContext);

// Swagger UI enumerates every endpoint, its parameters and its request bodies.
// Locally that is the point; on a public deployment it is a free map of the
// attack surface, so it is mounted only when ENABLE_API_DOCS says so, which
// defaults to local environments.
//
// It needs inline styles and scripts, so it gets its own relaxed CSP rather
// than loosening the policy for the whole API. Being mounted before the global
// helmet, and terminating the request, means the strict policy never applies.
if (Config.ENABLE_API_DOCS) {
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
}

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

// The demo UI, when it has been built (npm run build:web). Mounted after
// helmet so its pages get the strict CSP, and before the JSON index below so
// that / serves the UI when there is one and the service summary when not.
mountWebApp(app, path.resolve(__dirname, "../web/dist"));

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
