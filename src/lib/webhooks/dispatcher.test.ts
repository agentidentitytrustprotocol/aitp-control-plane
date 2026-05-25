// Verifies the batched dispatcher only enqueues for matching active
// webhooks and skips event types outside DELIVERABLE_EVENT_TYPES.

import { jest } from '@jest/globals';

const insertCalls: unknown[][] = [];
jest.mock('../db', () => {
  const insertChain: Record<string, unknown> = {};
  insertChain.values = (...args: unknown[]) => {
    insertCalls.push(args);
    return Promise.resolve(undefined);
  };
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => Promise.resolve([]);
  selectChain.limit = () => Promise.resolve([]);
  const updateChain: Record<string, unknown> = {};
  updateChain.set = () => updateChain;
  updateChain.where = () => Promise.resolve(undefined);
  return {
    db: {
      insert: () => insertChain,
      select: () => selectChain,
      update: () => updateChain,
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    },
  };
});

// Avoid the network attempt and the follow-up DB writes.
global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as never;

import { dispatchWebhooksWithList } from './service';

const ts = new Date().toISOString();

describe('dispatchWebhooksWithList', () => {
  beforeEach(() => insertCalls.splice(0, insertCalls.length));

  it('skips non-deliverable event types', async () => {
    await dispatchWebhooksWithList(
      { id: '1', type: 'llm.started', ts, payload: {} },
      [
        {
          id: 'wh-1', url: 'http://x', events: [], secret: 's', active: true,
          createdAt: ts, updatedAt: ts,
        },
      ],
    );
    expect(insertCalls.length).toBe(0);
  });

  it('skips inactive webhooks and webhooks not subscribed to the type', async () => {
    await dispatchWebhooksWithList(
      { id: '1', type: 'handshake.complete', ts, payload: {} },
      [
        { id: 'inactive', url: 'http://x', events: [], secret: 's', active: false,
          createdAt: ts, updatedAt: ts },
        { id: 'mismatch', url: 'http://x', events: ['tct.revoked'], secret: 's', active: true,
          createdAt: ts, updatedAt: ts },
      ],
    );
    expect(insertCalls.length).toBe(0);
  });

  it('enqueues for matching active webhooks (empty events = all)', async () => {
    await dispatchWebhooksWithList(
      { id: '1', type: 'agent.registered', ts, payload: {} },
      [
        { id: 'all', url: 'http://x', events: [], secret: 's', active: true,
          createdAt: ts, updatedAt: ts },
        { id: 'specific', url: 'http://x', events: ['agent.registered'], secret: 's', active: true,
          createdAt: ts, updatedAt: ts },
      ],
    );
    expect(insertCalls.length).toBe(2);
  });
});
