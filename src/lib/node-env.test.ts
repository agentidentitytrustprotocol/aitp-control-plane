// Issue #116: NODE_ENV is the single switch for every production safeguard.
import { jest } from '@jest/globals';
import {
  isProductionNodeEnv,
  nodeEnvBootWarning,
  readNodeEnv,
  warnOnUnrecognisedNodeEnv,
} from './node-env';

// Next's generated next-env.d.ts types NODE_ENV read-only; write via a widened alias.
const env = process.env as Record<string, string | undefined>;
const saved = env.NODE_ENV;

afterEach(() => {
  if (saved === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = saved;
  jest.restoreAllMocks();
});

describe('readNodeEnv / isProductionNodeEnv', () => {
  it('trims, so "production " still arms the safeguards', () => {
    env.NODE_ENV = ' production\n';
    expect(readNodeEnv()).toBe('production');
    expect(isProductionNodeEnv()).toBe(true);
  });

  it.each(['prod', 'staging', 'Production', ''])('%j is not production', (v) => {
    env.NODE_ENV = v;
    expect(isProductionNodeEnv()).toBe(false);
  });

  it('treats unset as not production, as empty', () => {
    delete env.NODE_ENV;
    expect(readNodeEnv()).toBe('');
    expect(isProductionNodeEnv()).toBe(false);
  });
});

describe('nodeEnvBootWarning', () => {
  it.each(['production', ' production ', 'development', 'test'])('is silent for %j', (v) => {
    env.NODE_ENV = v;
    expect(nodeEnvBootWarning()).toBeNull();
  });

  it.each(['staging', 'prod', 'Production', ''])('warns for %j and quotes it', (v) => {
    env.NODE_ENV = v;
    const w = nodeEnvBootWarning();
    expect(w).toContain(`NODE_ENV is ${JSON.stringify(v)}`);
    expect(w).toContain('INACTIVE');
    expect(w).toContain('API_KEYS');
    expect(w).toContain('ENROLLMENT_SECRET');
    expect(w).toContain('CP_AID_SEED_HEX');
  });

  it('warns when unset and says so', () => {
    delete env.NODE_ENV;
    expect(nodeEnvBootWarning()).toContain('NODE_ENV is unset');
  });
});

describe('warnOnUnrecognisedNodeEnv', () => {
  it('logs once at error level for an unknown value', () => {
    env.NODE_ENV = 'staging';
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnOnUnrecognisedNodeEnv();
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('logs nothing for production', () => {
    env.NODE_ENV = 'production';
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnOnUnrecognisedNodeEnv();
    expect(err).not.toHaveBeenCalled();
  });
});
