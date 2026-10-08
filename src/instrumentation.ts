/**
 * Next's instrumentation hooks. Two of them, with opposite lifecycles:
 * `register()` below runs once per boot, and `onRequestError` at the bottom of
 * this file runs once per unhandled route fault, for as long as the process
 * lives.
 *
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
 * the production build. `registerInstrumentation()` in
 * `next/dist/server/lib/router-utils/instrumentation-globals.external.js`
 * returns early on `NEXT_PHASE === 'phase-production-build'`, and every
 * server-side path funnels through it. A check at config module scope
 * would instead fire whenever the first route module is evaluated,
 * which includes `next build` under NODE_ENV=production — turning the
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

  // FIRST: say so if NODE_ENV is not a known environment (issue #116). Every
  // production safeguard keys on NODE_ENV === 'production', so an unexpected
  // value disables all of them at once; this makes that a log line instead of
  // an inference. Warn-only, deliberately: see node-env.ts.
  //
  // Then, before anything else is started. A deployment whose
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
  // production-only gate, the `console.error`/`console.warn` split and the
  // `process.exit(1)` — lives in `enrollment-config.ts`, which is also the
  // module `EnrollmentService`'s constructor validates through, so boot and
  // the request path cannot disagree. Two further reasons it is not inlined
  // here: `jest.config.js` excludes this file from coverage, so a decision
  // made here is measured by nothing; and a literal `process.exit` in this
  // file makes the build warn that a Node API is unsupported on the Edge
  // runtime, about a line the guard above already makes unreachable there.
  //
  // That this call happens AT ALL, and happens before the shutdown hooks, is
  // asserted by `src/instrumentation.test.ts` — the coverage exclusion above
  // suppresses the measurement, not the test, and every CI path supplies a
  // valid secret, so nothing else in the repo would notice this line going
  // missing.
  //
  // Deliberately NOT in /api/readyz: a readiness probe is for conditions
  // that can CHANGE while a process runs, and this one cannot (the value is
  // snapshotted at import and the service memoizes on success), so failing
  // readiness on it could only ever mean "this process should never have
  // started" — while pulling the replica out of rotation for every route
  // over a fault that breaks two. See docs/operations.md.
  const { warnOnUnrecognisedNodeEnv } = await import('./lib/node-env');
  warnOnUnrecognisedNodeEnv();

  const { enforceEnrollmentSecretAtBoot } = await import(
    './lib/registry/enrollment-config'
  );
  enforceEnrollmentSecretAtBoot();

  // Background JWKS cache refresh for OIDC trust anchors (no-op when
  // JWKS_REFRESH_ENABLED=false; idempotent; its interval is unref'd).
  const { startJwksRefresher } = await import('./lib/trust-anchors/jwks-refresher');
  startJwksRefresher();

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

/**
 * Next calls this once for every unhandled fault out of a route handler, page
 * render or server action, with the error plus the request and the router
 * context. It is this service's only observer of the `throw err` tails that
 * `registry/enroll`, `revocation/entries`, `webhooks`, `events` and
 * `events/history` deliberately end with (issue #114).
 *
 * Everything about WHAT it logs and what it refuses to log lives in
 * `./lib/request-error`, for the same reason `enforceEnrollmentSecretAtBoot`
 * lives in `enrollment-config.ts`: `jest.config.js` excludes this file from
 * coverage, so a decision made here is measured by nothing. This frame is only
 * the wiring, and `src/instrumentation.test.ts` asserts the delegation because
 * an `onRequestError` that exports fine and delegates nowhere is indistinguishable
 * from a working one at the type level.
 *
 * NO `NEXT_RUNTIME` GUARD, deliberately, and this is the one place it diverges
 * from `register()` above. That guard exists because `register()` must not reach
 * `process.exit` on the Edge runtime. Here the same guard would mean "log nothing
 * on a runtime where Next does call the hook", which is the defect rather than a
 * safeguard — and `reportRequestError` swallows internally, so a dynamic import
 * that cannot be satisfied in some future Edge compilation is already harmless
 * (Next's own `console.error` still reports the underlying error, so we would be
 * no worse off than before this hook existed).
 *
 * The import is dynamic, matching `register()`'s idiom: it keeps pino out of a
 * module that Next loads on every runtime, and it is resolved once and cached, so
 * only the first fault in a process pays for it.
 */
export async function onRequestError(
  ...args: Parameters<
    typeof import('./lib/request-error').reportRequestError
  >
): Promise<void> {
  try {
    const { reportRequestError } = await import('./lib/request-error');
    await reportRequestError(...args);
  } catch {
    // Unreachable in practice — `reportRequestError` swallows its own failures,
    // so only the import itself can fail here. Swallowed anyway: a throw from
    // this function is caught by Next and reported with the very
    // `console.error` this hook exists to replace.
  }
}
