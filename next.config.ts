import path from 'node:path';
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
        // The CP imports the `aitp` NAPI binding via a `file:` dep that
        // points at a sibling repo. Setting the tracing root one
        // directory up tells Next to include sibling-workspace files in
        // the standalone output (and preserves the `aitp-control-plane/`
        // prefix the Dockerfile's CMD expects:
        //   `node aitp-control-plane/server.js`)
        outputFileTracingRoot: path.join(__dirname, '..'),
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

  async headers() {
    // CORS_ORIGIN is required in production; we log a one-time warning
    // when missing rather than blocking startup, so misconfigured
    // deploys still serve traffic instead of erroring at boot.
    const corsOrigin = process.env.CORS_ORIGIN ?? '*';
    if (!process.env.CORS_ORIGIN && process.env.NODE_ENV === 'production') {
      console.warn(
        '[aitp-control-plane] CORS_ORIGIN not set in production — defaulting to "*". Set CORS_ORIGIN to the UI plane origin.',
      );
    }
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: corsOrigin },
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET,POST,PATCH,DELETE,OPTIONS',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'authorization,content-type,x-request-id,x-aitp-namespace',
          },
          {
            key: 'Access-Control-Expose-Headers',
            value: 'x-request-id',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
