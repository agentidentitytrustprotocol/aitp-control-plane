import { jest } from '@jest/globals';

const lookupMock = jest.fn<(host: string, opts: unknown) => Promise<{ address: string }[]>>();
jest.mock('node:dns/promises', () => ({
  lookup: (host: string, opts: unknown) => lookupMock(host, opts),
}));
// The refresher imports the db at module scope; this unit test never touches it.
jest.mock('../db', () => ({ db: {} }));

import { assertSafeJwksUrl, UnsafeJwksUrlError } from './jwks-refresher';

beforeEach(() => lookupMock.mockReset());

describe('assertSafeJwksUrl', () => {
  it.each([
    'http://127.0.0.1/jwks',
    'http://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/jwks',
    'http://[::1]/jwks',
    'ftp://example.com/jwks',
    'not a url',
  ])('rejects %s without needing DNS', async (u) => {
    await expect(assertSafeJwksUrl(u)).rejects.toBeInstanceOf(UnsafeJwksUrlError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects a hostname with ANY private resolved address', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34' }, { address: '10.1.2.3' }]);
    await expect(assertSafeJwksUrl('https://rebind.example.com/jwks')).rejects.toThrow(
      /non-public/,
    );
  });

  it('rejects an unresolvable host', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertSafeJwksUrl('https://nope.example.com/jwks')).rejects.toThrow(
      /could not be resolved/,
    );
  });

  it('accepts a public host', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);
    const u = await assertSafeJwksUrl('https://issuer.example.com/jwks');
    expect(u.hostname).toBe('issuer.example.com');
  });
});
