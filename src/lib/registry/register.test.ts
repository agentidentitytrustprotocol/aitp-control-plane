// Unit tests for registerConsumingJti (#151): the consume and the upsert run
// on the SAME transaction handle, a replay writes nothing, and an upsert fault
// propagates out of the transaction callback (which is what rolls it back).
// The real rollback and the concurrency behaviour are proven against Postgres
// in src/e2e/enrollment-token.integration.test.ts.

import { jest } from '@jest/globals';

const TX = { tx: true };
const consumeMock = jest.fn(async (_jti: string, _exp: number, _ex: unknown) => true);
const upsertMock = jest.fn(async (_input: unknown, _ex: unknown) => undefined);

jest.mock('../db', () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(TX) },
}));
jest.mock('./jti-store', () => ({
  consumeEnrollmentJti: (jti: string, exp: number, ex: unknown) => consumeMock(jti, exp, ex),
}));
jest.mock('./store', () => ({
  upsertAgent: (input: unknown, ex: unknown) => upsertMock(input, ex),
}));

import { registerConsumingJti } from './register';
import type { RegisterInput } from './store';

const input = { aid: 'aid:test:1' } as RegisterInput;
const token = { jti: 'j', exp: 123 };

beforeEach(() => {
  consumeMock.mockReset();
  consumeMock.mockResolvedValue(true);
  upsertMock.mockReset();
  upsertMock.mockResolvedValue(undefined);
});

it('consumes then upserts on the same transaction handle', async () => {
  await expect(registerConsumingJti(token, input)).resolves.toBe(true);
  expect(consumeMock).toHaveBeenCalledWith('j', 123, TX);
  expect(upsertMock).toHaveBeenCalledWith(input, TX);
});

it('returns false and writes nothing for a replayed jti', async () => {
  consumeMock.mockResolvedValue(false);
  await expect(registerConsumingJti(token, input)).resolves.toBe(false);
  expect(upsertMock).not.toHaveBeenCalled();
});

it('propagates an upsert fault out of the transaction', async () => {
  upsertMock.mockRejectedValue(new Error('db down'));
  await expect(registerConsumingJti(token, input)).rejects.toThrow('db down');
});
