/**
 * A local PostgreSQL for people who do not have one.
 *
 *   npm run db:local
 *
 * `embedded-postgres` ships a real PostgreSQL binary for the current platform
 * and runs it out of a directory in this repository. No Docker, no system
 * package, no service to install, nothing to pay for. It exists because the
 * test suite is a real integration suite - it needs a database, and "install
 * PostgreSQL first" was the one thing standing between someone cloning this
 * repository and running it.
 *
 * This is a development convenience and nothing else. CI uses the `postgres`
 * service in .github/workflows/ci.yml and Docker Compose uses its own
 * container; neither goes anywhere near this script.
 *
 * It runs in the foreground on purpose. A backgrounded database leaves a PID
 * file, a stale lock and a "why is the port taken" puzzle for a later session;
 * Ctrl-C here stops the server and that is the whole lifecycle. Run it in its
 * own terminal, like `npm run dev`.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import EmbeddedPostgres from "embedded-postgres";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Gitignored. Delete it to start from an empty cluster. */
const dataDir = path.join(repoRoot, ".postgres");

const port = Number(process.env.DB_PORT ?? 5432);
const user = process.env.DB_USERNAME ?? "postgres";
const password = process.env.DB_PASSWORD ?? "postgres";

/** The databases .env.example points at. */
const databases = ["authservice_dev", "authservice_test"];

const postgres = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  // Keep the data between runs. Without this, `stop()` deletes the cluster and
  // every restart is an empty database - which would silently undo migrations.
  persistent: true,
});

/**
 * Running this twice is the easiest mistake to make, and PostgreSQL's own
 * complaint about it ("lock file postmaster.pid already exists") arrives as an
 * Error with no `message`, so the catch below can only report `undefined`.
 * Checking the lock file first turns the commonest failure into a sentence
 * that says what to do.
 */
const alreadyRunningPid = () => {
  const lockFile = path.join(dataDir, "postmaster.pid");
  if (!existsSync(lockFile)) return null;

  const pid = Number(readFileSync(lockFile, "utf8").split("\n")[0]);
  if (!Number.isInteger(pid)) return null;

  try {
    // Signal 0 checks the process exists without touching it.
    process.kill(pid, 0);
    return pid;
  } catch {
    // Stale lock file from a cluster that was killed rather than stopped.
    return null;
  }
};

const main = async () => {
  const running = alreadyRunningPid();
  if (running !== null) {
    process.stderr.write(
      `A local database is already running from ${dataDir} (PID ${running}).\n` +
        `It is probably this script in another terminal - use that one, or stop ` +
        `it with Ctrl-C and run this again.\n`,
    );
    process.exit(1);
  }

  // `initialise` populates an empty directory and fails on a populated one, so
  // it has to be the first run only.
  if (!existsSync(dataDir)) {
    process.stdout.write(`Creating a new PostgreSQL cluster in ${dataDir}\n`);
    await postgres.initialise();
  }

  await postgres.start();

  for (const database of databases) {
    try {
      await postgres.createDatabase(database);
      process.stdout.write(`Created database ${database}\n`);
    } catch (err) {
      // Already there from a previous run, which is the normal case.
      if (!/already exists/i.test(String(err))) throw err;
    }
  }

  process.stdout.write(
    [
      "",
      "PostgreSQL is running. Put these in .env.dev and .env.test:",
      "",
      `  DB_HOST=localhost`,
      `  DB_PORT=${port}`,
      `  DB_USERNAME=${user}`,
      `  DB_PASSWORD=${password}`,
      `  DB_NAME=authservice_dev      (.env.test: authservice_test)`,
      "",
      "Leave this running and use another terminal. Ctrl-C stops the server;",
      "the data stays in .postgres/ until you delete that directory.",
      "",
    ].join("\n"),
  );

  const shutdown = async () => {
    process.stdout.write("\nStopping PostgreSQL\n");
    try {
      await postgres.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
};

main().catch((err) => {
  // Not every failure here arrives as a well-formed Error - some carry no
  // message at all - so fall back to something printable rather than
  // "undefined".
  const message =
    (err instanceof Error && err.message) || String(err) || "unknown error";

  // By far the most likely failure, and the least obvious from the raw error.
  if (/EADDRINUSE|address already in use/i.test(message)) {
    process.stderr.write(
      `Port ${port} is already in use.\n` +
        `If that is your own PostgreSQL, you do not need this script - point ` +
        `.env.dev at it instead.\n` +
        `Otherwise run this with a different port, e.g. DB_PORT=5433 npm run db:local, ` +
        `and set DB_PORT to match in .env.dev and .env.test.\n`,
    );
    process.exit(1);
  }

  process.stderr.write(`Could not start the local database: ${message}\n`);
  process.exit(1);
});
