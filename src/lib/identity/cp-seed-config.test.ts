// Unit tests for src/lib/identity/cp-seed-config.ts — the rule deciding whether
// CP_AID_SEED_HEX is usable, the boot policy on it, and the production
// CP_BASE_URL warning.
//
// WHAT IS AT RISK: the acceptance rule must be EXACTLY the identity's
// pre-existing decode (`Buffer.from(raw, 'hex')` → 32 bytes). Stricter would
// make working deployments refuse to boot; any normalisation could change the
// bytes read and rotate a pinned identity. So every accepted input is also
// checked to produce the SAME AID — pinned as a literal, measured before this
// module existed — through the real `cp-agent.ts`.
//
// `config` snapshots process.env at import, hence jest.isolateModules (same
// mechanism as enrollment-config.test.ts).

import { AitpAgent } from 'aitp';
import { cpSeedNotCleanWarning, cpSeedProblem, decodeCpSeedHex } from './cp-seed-config';

const CLEAN = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
/** AitpAgent.fromSeed(Buffer.from(CLEAN, 'hex')).aid, measured on the pre-P6b code. */
const CLEAN_AID = 'aid:pubkey:PM0kHP_Js2GARLl9A22GFFk9iwF8NA8d7odzOFUXZUs';

/** Inputs today's decode accepts, all decoding to CLEAN's 32 bytes. */
const ACCEPTED: Array<[string, string, boolean]> = [
  // [label, value, clean?]
  ['64 lowercase hex', CLEAN, true],
  ['64 uppercase hex', CLEAN.toUpperCase(), true],
  ['64 hex + trailing junk', `${CLEAN}zz`, false],
  ['64 hex + trailing newline', `${CLEAN}\n`, false],
  ['64 hex + trailing space', `${CLEAN} `, false],
  ['65 hex', `${CLEAN}a`, false],
];

/** Inputs that have always failed (decode to != 32 bytes) — fatal in production. */
const REJECTED: Array<[string, string | undefined]> = [
  ['undefined', undefined],
  ['empty', ''],
  ['63 hex', CLEAN.slice(1)],
  ['66 hex', `${CLEAN}ab`],
  ['128 hex', CLEAN + CLEAN],
  ['0x-prefixed', `0x${CLEAN}`],
  ['leading whitespace', ` ${CLEAN}`],
  ['non-hex', 'z'.repeat(64)],
];

const mutableEnv = process.env as Record<string, string | undefined>;

function withEnv<T>(
  env: { NODE_ENV?: string; CP_AID_SEED_HEX?: string; CP_BASE_URL?: string },
  fn: () => T,
): T {
  const keys = ['NODE_ENV', 'CP_AID_SEED_HEX', 'CP_BASE_URL'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, mutableEnv[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete mutableEnv[k];
    else mutableEnv[k] = env[k];
  }
  try {
    let out!: T;
    jest.isolateModules(() => {
      out = fn();
    });
    return out;
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete mutableEnv[k];
      else mutableEnv[k] = saved[k];
    }
  }
}

function loadSeedConfig(): typeof import('./cp-seed-config') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./cp-seed-config') as typeof import('./cp-seed-config');
}

const g = globalThis as { __cpAgent?: unknown; __cpManifestJson?: unknown };

/** The AID the real cp-agent.ts builds for a seed, from a clean module + global state. */
function cpAgentAidFor(seed: string): string {
  delete g.__cpAgent;
  delete g.__cpManifestJson;
  try {
    return withEnv({ NODE_ENV: 'production', CP_AID_SEED_HEX: seed, CP_BASE_URL: 'https://cp.example.com' }, () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./cp-agent') as typeof import('./cp-agent');
      return mod.getCpAgent().aid;
    });
  } finally {
    delete g.__cpAgent;
    delete g.__cpManifestJson;
  }
}

describe('cpSeedProblem / decodeCpSeedHex — exactly today\'s acceptance', () => {
  it('pins the reference AID (guards the literal below)', () => {
    expect(AitpAgent.fromSeed(Buffer.from(CLEAN, 'hex')).aid).toBe(CLEAN_AID);
  });

  it.each(ACCEPTED)('accepts %s with the identical identity', (_label, value) => {
    expect(cpSeedProblem(value)).toBeNull();
    expect(decodeCpSeedHex(value).equals(Buffer.from(CLEAN, 'hex'))).toBe(true);
    // Through the real identity module, not just the decoder.
    expect(cpAgentAidFor(value)).toBe(CLEAN_AID);
  });

  it.each(REJECTED)('rejects %s', (_label, value) => {
    const problem = cpSeedProblem(value);
    expect(problem).not.toBeNull();
    expect(problem).toContain('CP_AID_SEED_HEX');
    // And today's decode indeed cannot build an identity from it.
    expect(() => AitpAgent.fromSeed(Buffer.from(value ?? '', 'hex'))).toThrow();
  });

  it('reports a missing seed as required, not as the wrong length', () => {
    expect(cpSeedProblem(undefined)).toMatch(/is required/);
    expect(cpSeedProblem('')).toMatch(/is required/);
    expect(cpSeedProblem(CLEAN.slice(1))).toMatch(/got 63 characters that decode to 31 bytes/);
  });

  it('never echoes the seed in any message', () => {
    const secretish = 'ab'.repeat(31) + 'cd';
    for (const v of [secretish.slice(1), `${secretish}zz`, `0x${secretish}`]) {
      for (const msg of [cpSeedProblem(v), cpSeedNotCleanWarning(v)]) {
        if (msg !== null) expect(msg).not.toContain(secretish.slice(0, 16));
      }
    }
  });

  it('cp-agent refuses a bad seed with the same verdict', () => {
    expect(() => cpAgentAidFor(`0x${CLEAN}`)).toThrow(/CP_AID_SEED_HEX must be 64 hex characters/);
  });
});

describe('cpSeedNotCleanWarning', () => {
  it.each(ACCEPTED)('%s → warning iff not exactly 64 hex digits', (_label, value, clean) => {
    const w = cpSeedNotCleanWarning(value);
    if (clean) expect(w).toBeNull();
    else expect(w).toMatch(/not exactly 64 hex digits.*identity is unaffected/s);
  });

  it.each(REJECTED)('is silent for the unusable %s (cpSeedProblem reports it)', (_l, value) => {
    expect(cpSeedNotCleanWarning(value)).toBeNull();
  });
});

describe('cpBaseUrlBootWarning', () => {
  it.each([
    ['unset (localhost default)', undefined, /loopback/],
    ['localhost', 'https://localhost:4000', /loopback/],
    ['127.0.0.1', 'https://127.0.0.1', /loopback/],
    ['[::1]', 'https://[::1]:4000', /loopback/],
    ['plain http', 'http://cp.example.com', /not https/],
    ['garbage', 'not a url', /not a valid URL/],
  ])('warns in production for %s', (_label, value, re) => {
    const w = withEnv({ NODE_ENV: 'production', CP_BASE_URL: value }, () =>
      loadSeedConfig().cpBaseUrlBootWarning(),
    );
    expect(w).toMatch(re);
    expect(w).toContain('[aitp-cp] CP_BASE_URL');
  });

  it('is silent for a public https origin', () => {
    const w = withEnv({ NODE_ENV: 'production', CP_BASE_URL: 'https://cp.example.com' }, () =>
      loadSeedConfig().cpBaseUrlBootWarning(),
    );
    expect(w).toBeNull();
  });

  it('is silent outside production, where localhost is normal', () => {
    const w = withEnv({ NODE_ENV: 'development', CP_BASE_URL: undefined }, () =>
      loadSeedConfig().cpBaseUrlBootWarning(),
    );
    expect(w).toBeNull();
  });
});

describe('cpSeedBootFailure', () => {
  it('says nothing for a usable seed in either environment', () => {
    for (const NODE_ENV of ['production', 'development']) {
      expect(
        withEnv({ NODE_ENV, CP_AID_SEED_HEX: CLEAN }, () => loadSeedConfig().cpSeedBootFailure()),
      ).toBeNull();
    }
  });

  it.each(REJECTED)('is FATAL in production for %s', (_label, value) => {
    const f = withEnv({ NODE_ENV: 'production', CP_AID_SEED_HEX: value }, () =>
      loadSeedConfig().cpSeedBootFailure(),
    );
    expect(f?.fatal).toBe(true);
    expect(f?.message).toMatch(/^\[aitp-cp\] FATAL: CP_AID_SEED_HEX/);
  });

  it('is non-fatal outside production: ephemeral key when unset, warning when malformed', () => {
    const unset = withEnv({ NODE_ENV: 'development', CP_AID_SEED_HEX: undefined }, () =>
      loadSeedConfig().cpSeedBootFailure(),
    );
    expect(unset?.fatal).toBe(false);
    expect(unset?.message).toMatch(/ephemeral key/);
    const bad = withEnv({ NODE_ENV: 'test', CP_AID_SEED_HEX: '0x00' }, () =>
      loadSeedConfig().cpSeedBootFailure(),
    );
    expect(bad?.fatal).toBe(false);
    expect(bad?.message).toMatch(/Starting anyway/);
  });
});

describe('enforceCpSeedAtBoot', () => {
  // process.exit is ALWAYS mocked: unmocked, the fatal case kills the worker.
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => undefined) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const boot = (env: Parameters<typeof withEnv>[0]) =>
    withEnv(env, () => loadSeedConfig().enforceCpSeedAtBoot());

  it('is completely silent for a clean seed and a public https base URL in production', () => {
    boot({ NODE_ENV: 'production', CP_AID_SEED_HEX: CLEAN, CP_BASE_URL: 'https://cp.example.com' });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs at ERROR and exits 1 on a production boot with no seed', () => {
    boot({ NODE_ENV: 'production', CP_AID_SEED_HEX: undefined, CP_BASE_URL: 'https://cp.example.com' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('FATAL');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('exits 1 on a production boot with a seed that does not decode to 32 bytes', () => {
    boot({ NODE_ENV: 'production', CP_AID_SEED_HEX: CLEAN + CLEAN, CP_BASE_URL: 'https://cp.example.com' });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints before exiting, not after', () => {
    const order: string[] = [];
    errorSpy.mockImplementation(() => {
      order.push('error');
    });
    exitSpy.mockImplementation(((_code?: number) => {
      order.push('exit');
      return undefined;
    }) as never);
    boot({ NODE_ENV: 'production', CP_AID_SEED_HEX: '' });
    expect(order).toEqual(['error', 'exit']);
  });

  it('only warns outside production, never exits', () => {
    boot({ NODE_ENV: 'development', CP_AID_SEED_HEX: '' });
    boot({ NODE_ENV: 'development', CP_AID_SEED_HEX: `0x${CLEAN}` });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('starts (warning only) in production for an accepted-but-not-clean seed', () => {
    boot({ NODE_ENV: 'production', CP_AID_SEED_HEX: `${CLEAN}\n`, CP_BASE_URL: 'https://cp.example.com' });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('not exactly 64 hex digits');
  });

  it('warns but does not exit in production when CP_BASE_URL is the localhost default', () => {
    boot({ NODE_ENV: 'production', CP_AID_SEED_HEX: CLEAN, CP_BASE_URL: undefined });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('CP_BASE_URL');
  });
});

describe('cpBaseUrlBootWarning host and credential handling', () => {
  const env = process.env as Record<string, string | undefined>;
  const warn = (url: string) => {
    jest.resetModules();
    env.NODE_ENV = 'production';
    process.env.CP_BASE_URL = url;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('./cp-seed-config') as typeof import('./cp-seed-config')).cpBaseUrlBootWarning();
  };
  const saved = { n: process.env.NODE_ENV, u: process.env.CP_BASE_URL };
  afterAll(() => {
    env.NODE_ENV = saved.n;
    if (saved.u === undefined) delete process.env.CP_BASE_URL;
    else process.env.CP_BASE_URL = saved.u;
  });

  it('does not treat a hostname starting with 127. as loopback', () => {
    expect(warn('https://127.example.com')).toBeNull();
  });
  it('flags 127.0.0.1', () => {
    expect(warn('https://127.0.0.1:4000')).toMatch(/loopback/);
  });
  it('never prints userinfo from the URL', () => {
    const w = warn('http://user:secret@cp.example.com');
    expect(w).toMatch(/not https/);
    expect(w).not.toMatch(/secret/);
  });
});
