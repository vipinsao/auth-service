/**
 * What the OpenTelemetry instrumentation costs this service.
 *
 *   npm run bench:telemetry [requests]
 *
 * Instrumentation that slows the thing it measures is a bad trade, and "it is
 * probably negligible" is not a measurement.
 *
 * It measures `GET /health` on purpose. That route touches no database and does
 * no bcrypt, so what remains is almost entirely the middleware under test: the
 * request id, the server span, the child logger and one histogram record. On
 * `POST /auth/login` the same overhead would sit next to a deliberate ~60ms
 * bcrypt compare and nothing would be resolvable - which is the reassuring
 * result, but not a measured one.
 *
 * No database is needed: scripts/bench-app.ts boots the same Express app
 * without connecting to one.
 *
 * Every number printed is wall clock measured by the client on this machine.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const requests = Number(process.argv[2] || 2000);

const CONFIGURATIONS = [
  {
    label: "off",
    env: { OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none" },
  },
  { label: "console (default)", env: {} },
  {
    label: "console, 1s metrics",
    env: { OTEL_METRIC_EXPORT_INTERVAL: "1000" },
  },
];

async function waitForHealth(port, deadlineMs = 120000) {
  const started = performance.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (performance.now() - started > deadlineMs) {
      throw new Error("bench app never became healthy");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function get(port) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return performance.now() - started;
}

const percentile = (sorted, quantile) =>
  sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];

console.log(
  `node ${process.version} on ${os.cpus()[0]?.model ?? "unknown cpu"}, ${os.availableParallelism()} cores`,
);
console.log(`${requests} GET /health per configuration\n`);

const results = [];

for (const configuration of CONFIGURATIONS) {
  const port = 5700 + Math.floor(Math.random() * 200);
  const child = spawn(
    process.execPath,
    [
      "--loader",
      "ts-node/esm",
      "--no-warnings",
      path.join(here, "bench-app.ts"),
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "dev",
        PORT: String(port),
        LOG_LEVEL: "error",
        // Required by config/index.ts, and never used: /health opens no
        // connection.
        DB_HOST: "127.0.0.1",
        DB_PORT: "5432",
        DB_USERNAME: "bench",
        DB_PASSWORD: "bench",
        DB_NAME: "bench",
        REFRESH_TOKEN_SECRET:
          "a-benchmark-only-secret-long-enough-to-pass-the-entropy-gate",
        ENABLE_API_DOCS: "false",
        // Span output is part of what the default configuration costs, so it is
        // produced and discarded rather than suppressed.
        ...configuration.env,
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );

  try {
    await waitForHealth(port);
    for (let i = 0; i < 50; i += 1) await get(port); // warm the JIT

    const samples = [];
    for (let i = 0; i < requests; i += 1) samples.push(await get(port));
    samples.sort((a, b) => a - b);

    results.push({
      label: configuration.label,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      mean: samples.reduce((total, value) => total + value, 0) / samples.length,
    });
  } finally {
    child.kill("SIGKILL");
  }
}

const width = Math.max(...results.map((row) => row.label.length), 13);
console.log(`${"configuration".padEnd(width)} |  p50 ms |  p95 ms | mean ms`);
console.log(`${"-".repeat(width)}-+---------+---------+--------`);
for (const row of results) {
  console.log(
    `${row.label.padEnd(width)} | ${row.p50.toFixed(3).padStart(7)} | ` +
      `${row.p95.toFixed(3).padStart(7)} | ${row.mean.toFixed(3).padStart(7)}`,
  );
}

const [off, ...instrumented] = results;
console.log("\nagainst the uninstrumented floor:");
for (const row of instrumented) {
  const p50 = row.p50 - off.p50;
  const mean = row.mean - off.mean;
  console.log(
    `  ${row.label.padEnd(width)}  p50 ${p50 >= 0 ? "+" : ""}${p50.toFixed(3)}ms  ` +
      `mean ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}ms`,
  );
}
console.log(
  "\nRead these against the path they sit on. A login spends ~60ms in bcrypt by\n" +
    "design, and a refresh takes a pessimistic row lock; the figures above are\n" +
    "three orders of magnitude below either.",
);
