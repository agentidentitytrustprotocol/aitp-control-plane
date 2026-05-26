import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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

  // Belt-and-suspenders for the same reason: webpack still tries to
  // trace require() calls inside the externalized packages at build
  // time. The regex externals tell it "anything under @opentelemetry/*
  // or @grpc/* is a runtime require — don't follow the imports."
  // Also externalize the `aitp` NAPI loader so webpack never tries to
  // parse `aitp.<platform>.node`.
  webpack: (config, { isServer }) => {
    if (isServer) {
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
