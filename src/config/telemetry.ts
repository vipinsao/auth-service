import {
  trace,
  metrics,
  context,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-node";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

/**
 * OpenTelemetry traces and metrics, exporting to the console by default so this
 * works with no collector, no account and no credit card.
 *
 * WHAT IS INSTRUMENTED, AND WHY IT IS SO LITTLE
 *
 * This service already logs one structured line per request with method, path,
 * status and duration. That answers "how long", so tracing only earns its place
 * where it answers "how long doing WHAT" - and on an auth service there are
 * exactly three answers worth having:
 *
 *   credential.compare   bcrypt at cost 10, ~60ms, deliberately. It is the
 *                        largest single cost of a login by an order of
 *                        magnitude, and it is the number to look at before
 *                        anyone proposes lowering the cost factor.
 *   token.*              the refresh path writes two rows inside a transaction
 *                        that takes a pessimistic row lock. That lock is where
 *                        a concurrent-refresh storm would show up, and it is
 *                        invisible in a request duration.
 *   mail.send            an outbound network call on the registration and
 *                        password-reset paths, wrapped in a try/catch that
 *                        deliberately swallows failures. A span is the only
 *                        place a swallowed failure is still visible.
 *
 * Nothing else is instrumented. A span around a single indexed SELECT would add
 * noise to every trace and tell nobody anything.
 *
 * MANUAL, NOT `@opentelemetry/auto-instrumentations-node`
 *
 * The build is ESM ("type": "module", module: esnext). Auto-instrumentation
 * patches CommonJS `require`, so under ESM it needs
 * `--experimental-loader @opentelemetry/instrumentation/hook.mjs` threaded
 * through `npm start`, nodemon, the Dockerfile and Jest. That is four places to
 * forget, in exchange for spans around `pg` and `http` that would not have
 * changed any of the three answers above.
 *
 * CONFIGURATION (the names are OpenTelemetry's own, not invented here)
 *
 *   OTEL_SERVICE_NAME             defaults to auth-service
 *   OTEL_TRACES_EXPORTER          console (default) | otlp | none
 *   OTEL_METRICS_EXPORTER         console (default) | otlp | none
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. http://localhost:4318 - setting this
 *                                 switches both exporters to otlp unless they
 *                                 were named explicitly
 *   OTEL_METRIC_EXPORT_INTERVAL   milliseconds between metric exports (60000)
 *
 * They are read from `process.env` directly rather than through `Config`,
 * because they are the OpenTelemetry specification's variables and belong to
 * the SDK rather than to this application.
 *
 * Under NODE_ENV=test everything defaults to `none`: the suite runs hundreds of
 * requests and would otherwise print a span apiece.
 */

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "auth-service";

const chosenExporter = (variable: string): string => {
  const explicit = process.env[variable]?.trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "test") return "none";
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return "otlp";
  return "console";
};

type Providers = {
  traces?: string;
  meters?: string;
  shutdown: () => Promise<void>;
};

let providers: Providers | null = null;

/**
 * Start the SDK. Returns a shutdown function, which `server.ts` calls on
 * SIGTERM so a batch of spans is not lost on a rolling deploy.
 *
 * Safe never to call: every span and metric below goes through the
 * `@opentelemetry/api` facade, which is a no-op implementation until a provider
 * is registered. No other file branches on whether telemetry is on.
 */
export const startTelemetry = async (): Promise<() => Promise<void>> => {
  if (providers) return providers.shutdown;

  const traces = chosenExporter("OTEL_TRACES_EXPORTER");
  const meters = chosenExporter("OTEL_METRICS_EXPORTER");
  if (traces === "none" && meters === "none") {
    providers = { shutdown: async () => {} };
    return providers.shutdown;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.0.0",
  });

  const shutdowns: Array<() => Promise<void>> = [];

  if (traces !== "none") {
    // Imported only when it will be used, so the default console path never
    // loads an HTTP exporter it will not call.
    const exporter =
      traces === "otlp"
        ? new (
            await import("@opentelemetry/exporter-trace-otlp-http")
          ).OTLPTraceExporter()
        : new ConsoleSpanExporter();

    // Batch, not Simple: a SimpleSpanProcessor serialises and writes on the
    // request thread as each span ends, putting the exporter inside the path it
    // is supposed to be observing.
    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    // register() also installs the AsyncLocalStorage context manager, which is
    // what lets a span started in the request middleware become the parent of
    // one started inside CredentialService without a handle being threaded
    // through four constructors.
    provider.register();
    shutdowns.push(() => provider.shutdown());
  }

  if (meters !== "none") {
    const exporter =
      meters === "otlp"
        ? new (
            await import("@opentelemetry/exporter-metrics-otlp-http")
          ).OTLPMetricExporter()
        : new ConsoleMetricExporter();

    const provider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis:
            Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 60_000,
        }),
      ],
    });
    metrics.setGlobalMeterProvider(provider);
    shutdowns.push(() => provider.shutdown());
  }

  providers = {
    traces,
    meters,
    shutdown: async () => {
      for (const stop of shutdowns) await stop().catch(() => {});
    },
  };
  return providers.shutdown;
};

/** What startTelemetry decided, for the boot log. */
export const telemetryState = () =>
  providers
    ? {
        traces: providers.traces ?? "none",
        metrics: providers.meters ?? "none",
      }
    : { traces: "not started", metrics: "not started" };

const tracer = trace.getTracer(SERVICE_NAME);

/** Run `fn` inside a span, ending it however `fn` finishes. */
export const withSpan = async <T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> =>
  tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error)?.message,
      });
      throw error;
    } finally {
      span.end();
    }
  });

/**
 * The server span for one request. Separate from `withSpan` because an HTTP
 * span ends when the response finishes, not when the handler returns - and only
 * the finish event knows the status code.
 */
export const startRequestSpan = (name: string, attributes: Attributes): Span =>
  tracer.startSpan(name, { kind: SpanKind.SERVER, attributes });

/** Run `fn` with `span` active, so spans started downstream attach to it. */
export const runInSpan = <T>(span: Span, fn: () => T): T =>
  context.with(trace.setSpan(context.active(), span), fn);

const INVALID_TRACE_ID = "00000000000000000000000000000000";

/** The active trace id, or undefined when nothing is being traced. */
export const currentTraceId = (): string | undefined => {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext && spanContext.traceId !== INVALID_TRACE_ID
    ? spanContext.traceId
    : undefined;
};

export { SpanStatusCode };

/**
 * INSTRUMENTS RESOLVE ON FIRST USE, NEVER AT IMPORT.
 *
 * Not a style choice. `trace.getTracer()` returns a proxy that picks up a
 * provider registered later, which is why a module-scope tracer works.
 * `metrics.getMeter()` does not: called before `setGlobalMeterProvider` it
 * returns a NoopMeter, and every instrument built from it is permanently and
 * silently a no-op - traces appear, metrics do not, and nothing reports an
 * error. This exact bug was written and caught in the sibling service during
 * this work. Resolving on the first `add`/`record`, which happens inside a
 * request, makes the ordering impossible to get wrong.
 */
const lazily = <T>(
  create: (meter: ReturnType<typeof metrics.getMeter>) => T,
) => {
  let resolved: T | null = null;
  return () => (resolved ??= create(metrics.getMeter(SERVICE_NAME)));
};

const counter = (name: string, description: string) => {
  const resolve = lazily((meter) => meter.createCounter(name, { description }));
  return {
    add: (value: number, attributes?: Attributes) =>
      resolve().add(value, attributes),
  };
};

const histogram = (name: string, description: string, unit: string) => {
  const resolve = lazily((meter) =>
    meter.createHistogram(name, { description, unit }),
  );
  return {
    record: (value: number, attributes?: Attributes) =>
      resolve().record(value, attributes),
  };
};

/** How long a request took, split by route and by how it ended. */
export const requestDuration = histogram(
  "http.server.request.duration",
  "Request duration by route and outcome",
  "ms",
);

/**
 * Requests the rate limiter refused, by which budget refused them.
 *
 * A rejection is fast, so it is invisible in a duration histogram, and it is
 * the only externally visible sign that the limiter is doing anything at all.
 */
export const rateLimitRejections = counter(
  "auth.rate_limit.rejections",
  "Requests refused by a rate limiter, by limiter",
);

/**
 * Refresh-token families revoked because a spent token was presented again.
 *
 * The single most security-relevant number this service produces: it is either
 * always zero, or somebody is replaying tokens. Nothing else here deserves an
 * alert and this does.
 */
export const tokenReuseDetections = counter(
  "auth.token.reuse_detected",
  "Refresh token families revoked after a reuse was detected",
);

export default {
  startTelemetry,
  telemetryState,
  withSpan,
  startRequestSpan,
  runInSpan,
  currentTraceId,
};
