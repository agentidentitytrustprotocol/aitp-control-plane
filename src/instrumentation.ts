/**
 * Next.js runs this `register()` function exactly once per server
 * boot (Node.js or Edge runtime), before any route handler executes.
 * Use it to wire up OpenTelemetry so spans from route handlers, pg
 * pool calls, and outbound fetch (webhook deliveries) are exported
 * to the configured OTLP collector.
 *
 * Disabled by default: set OTEL_ENABLED=true to turn it on. The SDK
 * imports are dynamic so a deployment with OTel disabled doesn't pay
 * the cold-start cost of loading the auto-instrumentations.
 *
 * Edge runtime cannot host the OpenTelemetry Node SDK; we only wire
 * it under the Node.js runtime. All route handlers in this project
 * already set `export const runtime = 'nodejs'`.
 */

export async function register(): Promise<void> {
  if (process.env.OTEL_ENABLED !== 'true') return;
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import(
    '@opentelemetry/exporter-trace-otlp-http'
  );
  const { getNodeAutoInstrumentations } = await import(
    '@opentelemetry/auto-instrumentations-node'
  );
  const { Resource } = await import('@opentelemetry/resources');
  const semconv = await import('@opentelemetry/semantic-conventions');

  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'aitp-control-plane';
  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const sdk = new NodeSDK({
    resource: new Resource({
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

  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
