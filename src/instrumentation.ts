/**
 * Next.js runs this `register()` function exactly once per server
 * boot (Node.js or Edge runtime), before any route handler executes.
 * Use it to wire up OpenTelemetry so spans from route handlers, pg
 * pool calls, and outbound fetch (webhook deliveries) are exported
 * to the configured OTLP collector, to validate configuration that must
 * not be discovered one request at a time, and to register
 * process-level shutdown hooks.
 *
 * "Exactly once per server boot" is why the ENROLLMENT_SECRET check
 * below lives here rather than at `src/lib/config.ts` module scope:
 * this hook means BOOT, and Next deliberately does not run it during
 * the production build (its loader early-returns on
 * `NEXT_PHASE === 'phase-production-build'`). A check at config module
 * scope would fire whenever the first route module is evaluated, which
 * includes `next build` under NODE_ENV=production — turning the
 * Dockerfile's throwaway build placeholders into load-bearing values.
 *
 * OpenTelemetry is disabled by default: set OTEL_ENABLED=true to turn
 * it on. The SDK imports are dynamic so a deployment with OTel
 * disabled doesn't pay the cold-start cost of loading the
 * auto-instrumentations.
 *
 * Edge runtime cannot host the OpenTelemetry Node SDK; we only wire
 * it under the Node.js runtime. All route handlers in this project
 * already set `export const runtime = 'nodejs'`.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // FIRST, before anything else is started. A deployment whose
  // ENROLLMENT_SECRET is unset or too short used to boot, report ready,
  // pass its health checks, and then answer 503 SERVER_MISCONFIGURED to
  // every POST /api/registry/enroll and every POST /api/registry/agents
  // for as long as it ran — with no counter and no log line anywhere in
  // the process to say so (issue #99; see docs/operations.md's metrics
  // section for why that silence is deliberate on the request path).
  // This turns that into one loud failure at deploy time, before any
  // traffic.
  //
  // Everything about WHAT it does — the rule, the message, the
  // production-only gate, the `console.error`, the `process.exit(1)` —
  // lives in `enrollment-config.ts`, which is also the module
  // `EnrollmentService`'s constructor validates through, so boot and the
  // request path cannot disagree. Two further reasons it is not inlined
  // here: `jest.config.js` excludes this file from coverage, so a decision
  // made here is measured by nothing; and a literal `process.exit` in this
  // file makes the build warn that a Node API is unsupported on the Edge
  // runtime, about a line the guard above already makes unreachable there.
  //
  // Deliberately NOT in /api/readyz: a readiness probe is for conditions
  // that can CHANGE while a process runs, and this one cannot (the value is
  // snapshotted at import and the service memoizes on success), so failing
  // readiness on it could only ever mean "this process should never have
  // started" — while pulling the replica out of rotation for every route
  // over a fault that breaks two. See docs/operations.md.
  const { enforceEnrollmentSecretAtBoot } = await import(
    './lib/registry/enrollment-config'
  );
  enforceEnrollmentSecretAtBoot();

  // Shutdown hooks must always be wired — even with OTel off — so
  // readiness drains correctly on SIGTERM.
  const { registerShutdownHooks } = await import('./lib/shutdown');

  if (process.env.OTEL_ENABLED !== 'true') {
    registerShutdownHooks();
    return;
  }

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import(
    '@opentelemetry/exporter-trace-otlp-http'
  );
  const { getNodeAutoInstrumentations } = await import(
    '@opentelemetry/auto-instrumentations-node'
  );
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const semconv = await import('@opentelemetry/semantic-conventions');

  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'aitp-control-plane';
  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: serviceName,
      [semconv.ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'unknown',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({
      url: otlpEndpoint,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Don't instrument fs — too noisy, low value.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  // The OTel SDK flush runs as a shutdown hook so trace spans for the
  // request that triggered the signal still make it to the collector.
  registerShutdownHooks([() => sdk.shutdown()]);
}
