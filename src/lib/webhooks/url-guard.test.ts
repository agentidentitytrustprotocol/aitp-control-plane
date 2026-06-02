import { jest } from '@jest/globals';

// Mock DNS so we can drive the hostname-resolution branch deterministically.
const lookupMock = jest.fn<() => Promise<Array<{ address: string; family: number }>>>();
jest.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => (lookupMock as (...a: unknown[]) => unknown)(...args),
}));

import {
  assertSafeWebhookUrl,
  isPrivateIp,
  UnsafeWebhookUrlError,
} from './url-guard';

beforeEach(() => {
  lookupMock.mockReset();
});

describe('isPrivateIp', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.5.5',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1', // multicast
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:10.0.0.1', // v4-mapped private
  ])('flags %s as private', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])(
    'allows public address %s',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});

describe('assertSafeWebhookUrl', () => {
  it('rejects a non-http(s) scheme', async () => {
    await expect(assertSafeWebhookUrl('ftp://example.com/x')).rejects.toBeInstanceOf(
      UnsafeWebhookUrlError,
    );
  });

  it('rejects a malformed URL', async () => {
    await expect(assertSafeWebhookUrl('not a url')).rejects.toBeInstanceOf(
      UnsafeWebhookUrlError,
    );
  });

  it('rejects a private IP literal without resolving DNS', async () => {
    await expect(
      assertSafeWebhookUrl('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('accepts a public IP literal', async () => {
    await expect(assertSafeWebhookUrl('https://8.8.8.8/hook')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(
      assertSafeWebhookUrl('https://rebind.example.com/hook'),
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it('rejects when ANY resolved address is private (mixed records)', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(
      assertSafeWebhookUrl('https://mixed.example.com/hook'),
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it('accepts a hostname that resolves to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      assertSafeWebhookUrl('https://good.example.com/hook'),
    ).resolves.toBeUndefined();
  });
});
