// Boundary tests for checkManifestColumns' expires_at rule (the other fields
// are covered through /enroll in enrollment-guards.test.ts and through the
// register route in agents.test.ts).

import { checkManifestColumns } from './manifest-columns';

const base = {
  aid: 'aid:pubkey:ed25519:abc',
  handshake_endpoint: 'https://cp.example/api/aitp/handshake/hello',
  offered_capabilities: [],
};

describe('checkManifestColumns expires_at', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['0 (stored as NULL by the route)', 0],
    ['year 0001-01-01T00:00:00Z', -62135596800],
    ['year 9999-12-31T23:59:59Z', 253402300799],
    ['an ordinary timestamp', 1_900_000_000],
  ])('accepts %s', (_l, expires_at) => {
    expect(checkManifestColumns({ ...base, expires_at })).toBeNull();
  });

  it.each([
    ['one second before year 0001', -62135596801],
    ['year 10000', 253402300800],
    ['1e13', 1e13],
    ['a numeric string', '1700000000'],
    ['NaN', NaN],
    ['an object', {}],
  ])('rejects %s', (_l, expires_at) => {
    expect(checkManifestColumns({ ...base, expires_at })).toMatch(/expires_at must be a Unix timestamp/);
  });

  it('every accepted value renders through toISOString', () => {
    for (const e of [-62135596800, 253402300799]) {
      expect(() => new Date(e * 1000).toISOString()).not.toThrow();
    }
  });
});
