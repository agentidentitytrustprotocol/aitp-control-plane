import { insecureLocalhostDangerous } from './insecure-localhost';

const VAR = 'AITP_INSECURE_LOCALHOST_DANGEROUS';

describe('insecureLocalhostDangerous', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[VAR];
  });

  function withNodeEnv(value: string | undefined): void {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: value } as NodeJS.ProcessEnv);
  }

  it('is off by default', () => {
    delete process.env[VAR];
    expect(insecureLocalhostDangerous()).toBe(false);
  });

  it.each(['development', 'test'])('turns on in NODE_ENV=%s when set to true', (nodeEnv) => {
    process.env[VAR] = 'true';
    withNodeEnv(nodeEnv);
    expect(insecureLocalhostDangerous()).toBe(true);
  });

  it.each(['production', 'production ', 'staging', '', undefined])(
    'stays off in NODE_ENV=%j even when set to true',
    (nodeEnv) => {
      process.env[VAR] = 'true';
      withNodeEnv(nodeEnv);
      expect(insecureLocalhostDangerous()).toBe(false);
    },
  );

  it.each(['1', 'TRUE', 'yes', ''])('treats %j as off', (value) => {
    process.env[VAR] = value;
    expect(insecureLocalhostDangerous()).toBe(false);
  });
});
