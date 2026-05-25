import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['aitp'],

  // Belt-and-suspenders: even with serverExternalPackages, webpack will
  // try to parse `aitp.<platform>.node` because of how the NAPI loader
  // resolves it. Mark the package as a CommonJS external so webpack
  // never traces into the native binary at build time.
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externals = Array.isArray(config.externals)
        ? config.externals
        : config.externals
          ? [config.externals]
          : [];
      externals.push({ aitp: 'commonjs aitp' });
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
        '[aitp-cp] CORS_ORIGIN not set in production — defaulting to "*". Set CORS_ORIGIN to the UI plane origin.',
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
