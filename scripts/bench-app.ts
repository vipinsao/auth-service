/**
 * The Express app on a port, with telemetry started and NO database.
 *
 * `src/server.ts` connects to PostgreSQL before it listens, which is right for
 * the service and wrong for a benchmark: it would make the measurement depend
 * on a database that `GET /health` never touches. This boots the same `app`,
 * through the same `requestContext` middleware and the same telemetry
 * configuration, and nothing else.
 *
 * Only `scripts/bench-telemetry.js` runs this. It is not a way to run the
 * service - every route except /health will fail without a connection.
 */
import { startTelemetry } from "../src/config/telemetry.js";
import app from "../src/app.js";

const port = Number(process.env.PORT || 5599);

await startTelemetry();
app.listen(port, () => {
  process.stderr.write(`bench app listening on ${port}\n`);
});
