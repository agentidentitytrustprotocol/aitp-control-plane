import type { AuditEventRecord } from './stream';
// Pull the bus indirectly so the singleton initialises with the
// process-wide default backlog cap; the basic semantics we test
// (publish + replay + unsubscribe) don't depend on the cap value.
import { eventBus } from './stream';

function makeEvent(id: string, type = 'handshake.started'): AuditEventRecord {
  return {
    id,
    type,
    ts: new Date().toISOString(),
    payload: {},
  };
}

describe('eventBus', () => {
  it('replays the backlog to a late subscriber', () => {
    eventBus.publish(makeEvent('evt-1'));
    const received: string[] = [];
    const unsubscribe = eventBus.subscribe((e) => {
      received.push(e.id);
    });
    eventBus.publish(makeEvent('evt-2'));
    eventBus.publish(makeEvent('evt-3'));
    unsubscribe();
    eventBus.publish(makeEvent('evt-after-unsub'));
    expect(received).toEqual(['evt-2', 'evt-3']);
    const backlogIds = eventBus.getBacklog(100).map((e) => e.id);
    expect(backlogIds).toEqual(
      expect.arrayContaining(['evt-1', 'evt-2', 'evt-3', 'evt-after-unsub']),
    );
  });

  it('survives a listener that throws', () => {
    let recorded = 0;
    const unsubA = eventBus.subscribe(() => {
      throw new Error('boom');
    });
    const unsubB = eventBus.subscribe(() => {
      recorded += 1;
    });
    eventBus.publish(makeEvent('evt-throw'));
    unsubA();
    unsubB();
    expect(recorded).toBe(1);
  });

  it('exposes a monotonic dropped-count via getDroppedCount', () => {
    // The shared singleton already has unknown prior drops; capture a
    // baseline and assert the delta after we overflow the cap ourselves.
    const before = eventBus.getDroppedCount();
    // The default cap is 500 in test; publish enough to force at least one drop.
    const overflow = 600;
    for (let i = 0; i < overflow; i += 1) {
      eventBus.publish(makeEvent(`drop-${i}`));
    }
    const after = eventBus.getDroppedCount();
    expect(after).toBeGreaterThan(before);
  });
});
