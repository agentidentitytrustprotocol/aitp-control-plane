import type { NextConfig } from 'next';

// Gate `output: 'standalone'` behind an env var so the Docker build
// (which copies .next/standalone into the runner image) gets it while
// local `next start` workflows are not regressed — `next start` is
// incompatible with the standalone output and crashes the proxy
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
        //
        // Re-verified under Turbopack on #54's removal of the manual
        // bundler externalization hook below: the traced `node_modules/aitp`
        // path resolves unhashed (not the `.next/node_modules/aitp-<hash>/`
        // layout that would indicate vercel/next.js#88844) in the local
        // standalone output and in both linux/amd64 (emulated) and
        // linux/arm64 (native) container images built from this Dockerfile.
        outputFileTracingIncludes: {
          '*': [
            './node_modules/@agentidentitytrustprotocol/aitp-linux-x64-gnu/**',
            './node_modules/@agentidentitytrustprotocol/aitp-linux-arm64-gnu/**',
          ],
        },
      }
    : {}),

  // Packages that Node should `require()` at runtime instead of letting
  // the bundler inline them. `aitp` ships a native NAPI binary; the OTel
  // SDK pulls in @grpc/grpc-js which uses Node built-ins (fs, net, tls)
  // that can't be bundled for the server target. This is now the only
  // externalization mechanism in the config — it used to duplicate a
  // manual bundler callback's `config.externals` push for the Node
  // runtime, plus a second branch stubbing these same packages for the
  // Edge runtime (dead since the proxy migration, #58, made the gate
  // Node-only). Both were removed in #54 once a 6-rung verification
  // ladder confirmed this option alone is sufficient: the native module
  // resolves cleanly, unhashed, in both the local standalone output and
  // Linux amd64/arm64 container images.
  serverExternalPackages: [
    'aitp',
    '@opentelemetry/sdk-node',
    '@opentelemetry/auto-instrumentations-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/resources',
    '@opentelemetry/semantic-conventions',
    '@grpc/grpc-js',
  ],

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
  // per-request in src/proxy.ts, which reads CORS_ORIGIN at runtime.
};

export default nextConfig;
