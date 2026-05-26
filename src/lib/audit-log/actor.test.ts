import { actorIdFromAuthHeader } from './actor';

describe('actorIdFromAuthHeader', () => {
  it('returns null for missing or empty headers', () => {
    expect(actorIdFromAuthHeader(null)).toBeNull();
    expect(actorIdFromAuthHeader('')).toBeNull();
    expect(actorIdFromAuthHeader('Bearer ')).toBeNull();
  });

  it('hashes the token after stripping the Bearer prefix', () => {
    const id = actorIdFromAuthHeader('Bearer some-secret-api-key-1234');
    expect(id).toMatch(/^apikey:[0-9a-f]{16}$/);
  });

  it('hashes a raw token without prefix', () => {
    const id = actorIdFromAuthHeader('some-secret-api-key-1234');
    expect(id).toMatch(/^apikey:[0-9a-f]{16}$/);
  });

  it('is stable for the same input', () => {
    const a = actorIdFromAuthHeader('Bearer k-1');
    const b = actorIdFromAuthHeader('Bearer k-1');
    expect(a).toBe(b);
  });

  it('differs for different inputs', () => {
    const a = actorIdFromAuthHeader('Bearer k-1');
    const b = actorIdFromAuthHeader('Bearer k-2');
    expect(a).not.toBe(b);
  });

  it('does not embed the secret in the output', () => {
    const secret = 'sup3r-secret-token-do-not-leak';
    const id = actorIdFromAuthHeader(`Bearer ${secret}`);
    expect(id).not.toContain(secret);
    expect(id).not.toContain(secret.slice(0, 8));
  });
});
