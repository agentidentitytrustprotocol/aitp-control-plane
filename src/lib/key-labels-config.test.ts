// Unit tests for src/lib/key-labels-config.ts: a duplicate key label refuses
// boot. `config` snapshots process.env at import, hence jest.isolateModules.
import { jest } from '@jest/globals';
import { keyLabelBootFailure } from './key-labels-config';

const mutableEnv = process.env as Record<string, string | undefined>;
const AID = 'aid:pubkey:O4nSX0IWKDbZqISunQN2NnEba2AnDIlxY2jjSmqMCMs';

function withKeys<T>(env: { API_KEYS?: string; ISSUER_KEYS?: string }, fn: () => T): T {
  const keys = ['API_KEYS', 'ISSUER_KEYS'] as const;
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

const load = () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./key-labels-config') as typeof import('./key-labels-config');

describe('keyLabelBootFailure', () => {
  it('is null when there are no errors', () => {
    expect(keyLabelBootFailure([])).toBeNull();
  });

  it('renders every error in one FATAL line', () => {
    const line = keyLabelBootFailure(['first', 'second']);
    expect(line).toMatch(/^\[aitp-cp\] FATAL: first; second\. Refusing to start/);
  });

  it('reads both lists from config', () => {
    const line = withKeys(
      { API_KEYS: 'console:k1,console:k2', ISSUER_KEYS: `r@${AID}=i1,r@${AID}=i2` },
      () => load().keyLabelBootFailure(),
    );
    expect(line).toMatch(/API_KEYS entry 2: label "console"/);
    expect(line).toMatch(/ISSUER_KEYS entry 2: label "r"/);
    expect(line).not.toMatch(/k1|k2|i1|i2/);
  });

  it('accepts unique labels, including one AID under two labels (rotation overlap)', () => {
    const line = withKeys(
      { API_KEYS: 'console-1:k1,console-2:k2', ISSUER_KEYS: `r-1@${AID}=old,r-2@${AID}=new` },
      () => load().keyLabelBootFailure(),
    );
    expect(line).toBeNull();
  });
});

describe('enforceKeyLabelsAtBoot', () => {
  // process.exit is ALWAYS mocked: unmocked, the fatal case kills the worker.
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => undefined) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('is silent with unique labels', () => {
    withKeys({ API_KEYS: 'a:k1,b:k2' }, () => load().enforceKeyLabelsAtBoot());
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.each(['production', 'development', 'test'])(
    'prints FATAL then exits 1 on a duplicate label (NODE_ENV=%s)',
    (nodeEnv) => {
      const order: string[] = [];
      errorSpy.mockImplementation(() => {
        order.push('error');
      });
      exitSpy.mockImplementation(((code?: number) => {
        order.push(`exit ${code}`);
        return undefined;
      }) as never);
      const savedNodeEnv = mutableEnv.NODE_ENV;
      mutableEnv.NODE_ENV = nodeEnv;
      try {
        withKeys({ ISSUER_KEYS: `r@${AID}=i1,r@aid:pubkey:other=i2` }, () =>
          load().enforceKeyLabelsAtBoot(),
        );
      } finally {
        mutableEnv.NODE_ENV = savedNodeEnv;
      }
      expect(order).toEqual(['error', 'exit 1']);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('FATAL');
    },
  );
});
