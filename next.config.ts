import type { NextConfig } from 'next';

// Gate `output: 'standalone'` behind an env var so the Docker build
// (which copies .next/standalone into the runner image) gets it while
// local `next start` workflows are not regressed — `next start` is
// incompatible with the standalone output and crashes the middleware
// bundle with "Native module not found" on every request.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

const nextConfig: NextConfig = {
  ...(standalone
    ? {
        output: 'standalone' as const,
        // `aitp` is the published `@agentidentitytrustprotocol/aitp` NAPI
        // loader (installed as a normal node_modules package via an npm
        // alias). The loader `require()`s a separate per-platform binary
        // package at runtime (e.g. `@agentidentitytrustprotocol/aitp-
        // linux-x64-gnu`). Next's file tracing resolves the binary for
        // the build host's platform, but we force-include the Linux
        // packages so the standalone output always ships the native
        // `.node` for the container — including for multi-arch images
        // built on a different host arch. Globs that don't match on the
        // build host (e.g. on macOS dev) are simply skipped.
        outputFileTracingIncludes: {
          '*': [
            './node_modules/@agentidentitytrustprotocol/aitp-linux-x64-gnu/**',
            './node_modules/@agentidentitytrustprotocol/aitp-linux-arm64-gnu/**',
          ],
        },
      }
    : {}),

  // Packages that Node should `require()` at runtime instead of letting
  // webpack bundle them. `aitp` ships a native NAPI binary; the OTel
  // SDK pulls in @grpc/grpc-js which uses Node built-ins (fs, net, tls)
  // that webpack can't bundle for the server target.
  serverExternalPackages: [
    'aitp',
    '@opentelemetry/sdk-node',
    '@opentelemetry/auto-instrumentations-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/resources',
    '@opentelemetry/semantic-conventions',
    '@grpc/grpc-js',
  ],

  // OTel / gRPC handling depends on which Next.js runtime is being
  // compiled:
  //
  //   - Node.js runtime (route handlers + the Node side of
  //     instrumentation.ts): externalize @opentelemetry/* and @grpc/*
  //     as commonjs requires. Without this webpack tries to bundle
  //     @grpc/proto-loader and chokes on Node built-ins (fs, path).
  //     Also externalize the `aitp` NAPI loader so webpack never tries
  //     to parse `aitp.<platform>.node`.
  //
  //   - Edge runtime (middleware bundle): can NEITHER bundle these
  //     packages (no fs/path) NOR do `commonjs require()` at runtime
  //     (that's what threw "Native module not found:
  //     @opentelemetry/api" on every request and 500'd the service).
  //     Stub them out with empty modules. middleware.ts never reaches
  //     OTel code in practice — the import graph only sees these
  //     packages because webpack statically traces instrumentation.ts
  //     before the runtime guard runs.
  webpack: (config, { isServer, nextRuntime, webpack }) => {
    if (isServer && nextRuntime === 'nodejs') {
      const externals = Array.isArray(config.externals)
        ? config.externals
        : config.externals
          ? [config.externals]
          : [];
      externals.push({ aitp: 'commonjs aitp' });
      externals.push(
        ({ request }: { request?: string }, callback: (err?: Error | null, result?: string) => void) => {
          if (request && (/^@opentelemetry\//.test(request) || /^@grpc\//.test(request))) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
      );
      config.externals = externals;
    }
    if (nextRuntime === 'edge') {
      // Stub ONLY the Node-only OTel / gRPC / NAPI packages. The
      // portable ones (@opentelemetry/api, @opentelemetry/core,
      // resources, semantic-conventions) must remain real — Next's
      // built-in middleware tracing wrapper imports
      // `@opentelemetry/api` directly and crashes with
      // "createContextKey is not a function" if it's stubbed.
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^(@grpc\/|@opentelemetry\/(sdk-|exporter-|auto-instrumentations-|instrumentation-)|aitp$)/,
          require.resolve('./src/lib/empty-shim.js'),
        ),
      );
    }
    return config;
  },

  async rewrites() {
    return [
      {
        source: '/.well-known/aitp-manifest',
        destination: '/api/well-known/aitp-manifest',
      },
      {
        source: '/.well-known/aitp-revocation-list',
        destination: '/api/well-known/aitp-revocation-list',
      },
    ];
  },
  // NOTE: CORS headers are intentionally NOT set here. Next evaluates
  // `headers()` at BUILD time and freezes the result into
  // routes-manifest.json, so CORS_ORIGIN would be baked into the image
  // (defeating runtime config on Railway/Docker). CORS is instead applied
  // per-request in src/middleware.ts, which reads CORS_ORIGIN at runtime.
};

export default nextConfig;
