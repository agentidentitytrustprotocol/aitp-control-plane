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
        // WHAT THE TRACED LAYOUT ACTUALLY LOOKS LIKE (verified 2026-09-25
        // against the local standalone output and against linux/arm64 AND
        // linux/amd64 images built from this Dockerfile; an earlier version of
        // this comment asserted the opposite and was wrong).
        //
        // Turbopack DOES emit the hashed layout: every traced external lands
        // at `.next/node_modules/<name>-<16 hex>`, and the compiled server
        // chunks ask for that hashed specifier verbatim (e.g.
        // `require("aitp-be19fc45beda61d0")`; `pg` goes through Turbopack's
        // async-external helper with the same hashed string). Resolution is
        // nonetheless clean because each hashed entry is a **symlink** to the real
        // unhashed package under `node_modules/`, and Node resolves through
        // its realpath — so `aitp/index.js` still finds its sibling
        // `@agentidentitytrustprotocol/aitp-linux-<arch>-gnu`. The failure
        // mode of vercel/next.js#88844 is a hashed *copy*, which loses that
        // sibling; a hashed *symlink* does not. That distinction, not the
        // absence of a hash, is what makes this config sufficient.
        //
        // The eight specifiers traced this way, hash stripped:
        //   aitp, pg, pino, @opentelemetry/{sdk-node,
        //   auto-instrumentations-node, exporter-trace-otlp-http, resources,
        //   semantic-conventions}
        // Note `.next/node_modules/@opentelemetry` is a real DIRECTORY
        // holding five symlinks, not a symlink itself.
        //
        // That set is NOT the `serverExternalPackages` list below, and differs
        // in both directions: `pg` and `pino` are traced without being listed
        // (Next externalises them on its own), and `@grpc/grpc-js` is listed
        // but never appears in `.next/node_modules` at all (it is only reached
        // through the OTel tree). Do not read the two as the same eight names.
        //
        // The hash is Next's internal, path/name-derived detail — it was
        // byte-identical between the macOS build and the linux/arm64 image,
        // but a Next upgrade may change the scheme, so nothing may hardcode
        // it: anything checking this layout must derive the hash from the
        // artifact. Reproduce the layout by hand with
        // `ls -la .next/standalone/.next/node_modules/` (plus one more level
        // for the `@opentelemetry` scope directory).
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
  // resolves cleanly in both the local standalone output and Linux
  // amd64/arm64 container images — via a hashed symlink, not unhashed as
  // this comment used to claim; see the traced-layout block above.
  //
  // The set Next actually TRACES is a different set from this list, in both
  // directions — see the traced-layout block above before reasoning about
  // either one as the other.
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
