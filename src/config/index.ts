import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// __dirname is not defined in ES modules, so it has to be derived from import.meta.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NODE_ENV = process.env.NODE_ENV ?? "dev";

/**
 * Configuration is loaded from a per-environment file: `.env.dev`, `.env.test`
 * or `.env.prod`. dotenv never overwrites a variable that is already present in
 * the real environment, so Docker Compose / CI / a hosting dashboard always win
 * over the file. That is why the Docker and CI setups do not ship an env file.
 */
config({
  path: path.join(__dirname, `../../.env.${NODE_ENV}`),
  debug: false,
  quiet: true,
});

const REQUIRED = [
  "DB_HOST",
  "DB_PORT",
  "DB_USERNAME",
  "DB_PASSWORD",
  "DB_NAME",
  "REFRESH_TOKEN_SECRET",
] as const;

// Fail fast and loudly rather than starting a service that cannot sign tokens.
const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}. ` +
      `Copy .env.example to .env.${NODE_ENV} and fill in the values.`,
  );
}

const csv = (value: string | undefined, fallback: string[]): string[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : fallback;

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const Config = {
  NODE_ENV,
  IS_PRODUCTION: NODE_ENV === "prod" || NODE_ENV === "production",
  IS_TEST: NODE_ENV === "test",
  PORT: num(process.env.PORT, 5501),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  APP_BASE_URL: process.env.APP_BASE_URL ?? "http://localhost:3000",

  // Database
  DB_HOST: process.env.DB_HOST as string,
  DB_PORT: num(process.env.DB_PORT, 5432),
  DB_USERNAME: process.env.DB_USERNAME as string,
  DB_PASSWORD: process.env.DB_PASSWORD as string,
  DB_NAME: process.env.DB_NAME as string,

  // Tokens
  PRIVATE_KEY_PATH: process.env.PRIVATE_KEY_PATH ?? "certs/private.pem",
  PUBLIC_KEY_PATH: process.env.PUBLIC_KEY_PATH ?? "certs/public.pem",
  REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET as string,
  ACCESS_TOKEN_EXPIRY: process.env.ACCESS_TOKEN_EXPIRY ?? "1h",
  REFRESH_TOKEN_EXPIRY_DAYS: num(process.env.REFRESH_TOKEN_EXPIRY_DAYS, 30),

  // Cookies / CORS
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || undefined,
  CORS_ORIGINS: csv(process.env.CORS_ORIGINS, ["http://localhost:3000"]),

  // Abuse protection
  AUTH_RATE_LIMIT_WINDOW_MINUTES: num(
    process.env.AUTH_RATE_LIMIT_WINDOW_MINUTES,
    15,
  ),
  AUTH_RATE_LIMIT_MAX: num(process.env.AUTH_RATE_LIMIT_MAX, 20),
  REFRESH_RATE_LIMIT_MAX: num(process.env.REFRESH_RATE_LIMIT_MAX, 120),
  MAX_FAILED_LOGIN_ATTEMPTS: num(process.env.MAX_FAILED_LOGIN_ATTEMPTS, 5),
  ACCOUNT_LOCK_MINUTES: num(process.env.ACCOUNT_LOCK_MINUTES, 15),

  // Email verification / password reset
  REQUIRE_EMAIL_VERIFICATION: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
  VERIFICATION_TOKEN_TTL_MINUTES: num(
    process.env.VERIFICATION_TOKEN_TTL_MINUTES,
    60,
  ),

  // Mail
  MAIL_TRANSPORT: (process.env.MAIL_TRANSPORT ?? "json") as
    | "json"
    | "ethereal"
    | "smtp",
  MAIL_FROM: process.env.MAIL_FROM ?? "Auth Service <no-reply@auth.local>",
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: num(process.env.SMTP_PORT, 587),
  SMTP_SECURE: process.env.SMTP_SECURE === "true",
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
};
