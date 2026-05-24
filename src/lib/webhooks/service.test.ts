import { createHmac } from 'node:crypto';
import { signPayload } from './service';

describe('signPayload', () => {
  it('produces a stable HMAC-SHA256 hex digest', () => {
    const secret = 'shared-secret';
    const body = '{"hello":"world"}';
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(signPayload(secret, body)).toBe(expected);
  });

  it('changes when the body changes', () => {
    const a = signPayload('s', '{"a":1}');
    const b = signPayload('s', '{"a":2}');
    expect(a).not.toBe(b);
  });

  it('changes when the secret changes', () => {
    const a = signPayload('s1', '{}');
    const b = signPayload('s2', '{}');
    expect(a).not.toBe(b);
  });
});
