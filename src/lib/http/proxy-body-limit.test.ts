import nextConfig from '../../../next.config';
import { ADMIN_JSON_MAX_BYTES, MANIFEST_BODY_MAX_BYTES } from './read-body';

/**
 * Next clones every proxied request body up to `proxyClientMaxBodySize` and
 * TRUNCATES silently beyond it (next.config.ts). A route only answers 413 if
 * it receives more than its own ceiling, so the clone cap must exceed the
 * largest route ceiling by more than one socket chunk (64 KiB), or an
 * oversized body would reach the route cut off and be parsed as if whole.
 */
const SOCKET_CHUNK = 64 * 1024;
const EVENTS_MAX_BYTES = 256 * 1024; // src/app/api/events/route.ts MAX_BATCH_BYTES

const UNIT: Record<string, number> = { b: 1, kb: 1024, mb: 1024 * 1024 };

function bytes(v: string | number | undefined): number {
  if (typeof v === 'number') return v;
  const m = /^(\d+)(b|kb|mb)$/i.exec(v ?? '');
  if (!m) throw new Error(`unparseable proxyClientMaxBodySize: ${String(v)}`);
  return Number(m[1]) * UNIT[m[2].toLowerCase()];
}

describe('proxyClientMaxBodySize (#150)', () => {
  const cap = bytes(nextConfig.experimental?.proxyClientMaxBodySize as string | number | undefined);

  it('is set, so the per-request clone is not Next’s 10 MB default', () => {
    expect(cap).toBeLessThan(10 * 1024 * 1024);
  });

  it.each([
    ['manifest routes', MANIFEST_BODY_MAX_BYTES],
    ['admin JSON routes', ADMIN_JSON_MAX_BYTES],
    ['POST /api/events', EVENTS_MAX_BYTES],
  ])('exceeds the %s ceiling by more than one socket chunk', (_name, ceiling) => {
    expect(cap - SOCKET_CHUNK).toBeGreaterThan(ceiling);
  });
});
