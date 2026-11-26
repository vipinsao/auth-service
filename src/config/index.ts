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

/**
 * A refresh token is accepted on the strength of this secret alone, and its
 * `jti` is the row's sequential integer id - so anyone holding the secret can
 * mint a token for `jti = 1, 2, 3...` and land on real sessions belonging to
 * other users. That makes a weak or left-over-from-the-example secret a full
 * account-takeover, not a hardening detail, which is why this refuses to start
 * rather than warning.
 *
 * Local environments are exempt: the committed Compose file and CI both use an
 * obviously fake value on purpose, and making them fail would only teach people
 * to work around the check.
 */
const PLACEHOLDER_SECRETS = new Set([
  "local-only-change-me",
  "local-compose-refresh-secret-change-me",
  "ci-only-refresh-secret",
  "change-me",
  "secret",
]);

const MINIMUM_SECRET_LENGTH = 32;

const assertUsableSecret = (secret: string, isLocal: boolean) => {
  if (isLocal) return;

  if (PLACEHOLDER_SECRETS.has(secret)) {
    throw new Error(
      "REFRESH_TOKEN_SECRET is one of the example values shipped with this " +
        "repository. Generate a real one, e.g. `openssl rand -base64 48`.",
    );
  }

  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `REFRESH_TOKEN_SECRET must be at least ${MINIMUM_SECRET_LENGTH} ` +
        `characters outside development; it is ${secret.length}. ` +
        "Generate one with `openssl rand -base64 48`.",
    );
  }
};

const csv = (value: string | undefined, fallback: string[]): string[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : fallback;

/**
 * `.env.example` documents every optional variable by listing it with an empty
 * value, which is how a reader learns the name and the default. dotenv then
 * sets that variable to `""`, and `??` does not treat an empty string as
 * absent - so `cp .env.example .env.dev` used to hand `expiresIn: ""` to
 * jsonwebtoken and 500 every login. Every optional string reads through this.
 */
const str = <T extends string>(value: string | undefined, fallback: T): T =>
  value === undefined || value.trim() === "" ? fallback : (value as T);

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * The environments where it is safe to relax a protection.
 *
 * Every hardening decision is written as `!IS_LOCAL`, never as `IS_PRODUCTION`,
 * and the difference matters. An allow-list of production spellings fails open:
 * `NODE_ENV=staging`, `NODE_ENV=Production` or a value with a stray space is
 * none of them, so the check says "not production" and the protection is
 * silently off in a deployed environment. An allow-list of local spellings
 * fails closed: an unrecognised value is treated as deployed and gets the
 * strict behaviour. The worst case becomes a developer wondering why their
 * cookie needs HTTPS, instead of a production cookie shipped without `secure`.
 */
const LOCAL_ENVIRONMENTS = ["dev", "development", "test"];
const IS_LOCAL = LOCAL_ENVIRONMENTS.includes(NODE_ENV);

assertUsableSecret(process.env.REFRESH_TOKEN_SECRET as string, IS_LOCAL);

/**
 * `trust proxy` decides whether Express believes `X-Forwarded-For`, and
 * `req.ip` is what the rate limiters key on. Trusting it when nothing strips
 * the header lets any caller choose their own rate-limit bucket - and, since
 * Express does not validate the value, choose a bucket that is not an IP
 * address at all. Measured, 60 logins each with a unique forged header: unset,
 * 20 got through and 40 were throttled; with `TRUST_PROXY` set, all 60 got
 * through and the limiter never fired once. The 60 forged values also created
 * 62 rows in `rate_limit_hit`, each holding a full window - unbounded growth
 * from unauthenticated traffic.
 *
 * So it defaults to `false`: only the real socket address is believed.
 *
 * THE PRECONDITION FOR SETTING IT AT ALL is that this service's port cannot be
 * reached except through the proxy, and that the proxy overwrites
 * `X-Forwarded-For` rather than appending to it. A hop count is not a
 * statement about the network - Express just counts back from the right-hand
 * end of the header - so if anything can still open a socket to the port
 * directly, `TRUST_PROXY=1` hands that caller `req.ip` of their choosing and
 * the limiter is decorative again. The Compose stack in this repository
 * publishes 5501 with no proxy in front of it, so there it must stay unset.
 *
 * When the precondition does hold, set it to the number of proxies (`1` for a
 * single load balancer), or to an Express-recognised value such as `loopback`
 * or a subnet list. See DECISIONS.md decision 14.
 */
const trustProxy = (value: string | undefined): boolean | number | string => {
  if (value === undefined || value.trim() === "") return false;
  const trimmed = value.trim();
  if (trimmed === "false") return false;
  const hops = Number(trimmed);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  // "true" trusts every hop, so any client can name its own address. Refused.
  //
  // It is the one value that must not be accepted quietly: it is the worst
  // possible setting, it is what a reader reaches for when the variable looks
  // like a boolean, and express-rate-limit's own validator does not flag it
  // when it arrives through `app.set` this way. Falling back to `false` keeps
  // the limiter working; the warning is what tells the operator their intent
  // was refused rather than applied.
  if (trimmed === "true") {
    // Not `logger`: this module is what configures the logger, so importing it
    // here would be a cycle. One line on stderr, in the same JSON shape the
    // logger emits.
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: "warn",
        message:
          "TRUST_PROXY=true trusts every hop, so any caller can choose their " +
          "own rate-limit bucket; falling back to false",
        hint: "Use the number of proxies in front of this process, e.g. TRUST_PROXY=1",
      }),
    );
    return false;
  }
  // Express also accepts "loopback", "linklocal", "uniquelocal" and CIDR lists.
  return trimmed;
};

export const Config = {
  NODE_ENV,
  // There is deliberately no IS_PRODUCTION. It existed, it was an allow-list of
  // production spellings, and both places that used it - the `secure` cookie
  // flag and the 5xx message gate - failed open on any value that was not on
  // the list. Removing it stops the next person reaching for it.
  IS_LOCAL,
  IS_TEST: NODE_ENV === "test",
  PORT: num(process.env.PORT, 5501),
  LOG_LEVEL: str(process.env.LOG_LEVEL, "info"),
  APP_BASE_URL: str(process.env.APP_BASE_URL, "http://localhost:3000"),

  // Database
  DB_HOST: process.env.DB_HOST as string,
  DB_PORT: num(process.env.DB_PORT, 5432),
  DB_USERNAME: process.env.DB_USERNAME as string,
  DB_PASSWORD: process.env.DB_PASSWORD as string,
  DB_NAME: process.env.DB_NAME as string,
  /**
   * TLS to PostgreSQL. Off by default because the local and Compose databases
   * do not speak it; hosted Postgres (Neon, RDS, Render) requires it. When on,
   * the server certificate is verified: TLS without verification stops a
   * passive eavesdropper but not an impersonated database.
   */
  DB_SSL: process.env.DB_SSL === "true",

  // Tokens
  PRIVATE_KEY_PATH: str(process.env.PRIVATE_KEY_PATH, "certs/private.pem"),
  PUBLIC_KEY_PATH: str(process.env.PUBLIC_KEY_PATH, "certs/public.pem"),
  REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET as string,
  ACCESS_TOKEN_EXPIRY: str(process.env.ACCESS_TOKEN_EXPIRY, "1h"),
  REFRESH_TOKEN_EXPIRY_DAYS: num(process.env.REFRESH_TOKEN_EXPIRY_DAYS, 30),

  // Proxying
  TRUST_PROXY: trustProxy(process.env.TRUST_PROXY),

  /**
   * Swagger UI enumerates every endpoint and its request shape. That is
   * exactly what you want locally and a free reconnaissance page in a
   * deployment, so it defaults to local-only and has to be turned on
   * deliberately.
   */
  ENABLE_API_DOCS: process.env.ENABLE_API_DOCS
    ? process.env.ENABLE_API_DOCS === "true"
    : IS_LOCAL,

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
  RATE_LIMIT_STORE: str<"memory" | "postgres">(
    process.env.RATE_LIMIT_STORE,
    "memory",
  ),
  MAX_FAILED_LOGIN_ATTEMPTS: num(process.env.MAX_FAILED_LOGIN_ATTEMPTS, 5),
  /** The first lock. Each further failure doubles it, up to the cap below. */
  ACCOUNT_LOCK_INITIAL_MINUTES: num(
    process.env.ACCOUNT_LOCK_INITIAL_MINUTES,
    1,
  ),
  /** The cap the doubling stops at - not a flat duration any more. */
  ACCOUNT_LOCK_MINUTES: num(process.env.ACCOUNT_LOCK_MINUTES, 15),

  // Email verification / password reset
  REQUIRE_EMAIL_VERIFICATION: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
  VERIFICATION_TOKEN_TTL_MINUTES: num(
    process.env.VERIFICATION_TOKEN_TTL_MINUTES,
    60,
  ),

  // Mail
  MAIL_TRANSPORT: str<"json" | "ethereal" | "smtp">(
    process.env.MAIL_TRANSPORT,
    "json",
  ),
  MAIL_FROM: str(process.env.MAIL_FROM, "Auth Service <no-reply@auth.local>"),
  SMTP_HOST: process.env.SMTP_HOST || undefined,
  SMTP_PORT: num(process.env.SMTP_PORT, 587),
  SMTP_SECURE: process.env.SMTP_SECURE === "true",
  SMTP_USER: process.env.SMTP_USER || undefined,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD || undefined,
};
