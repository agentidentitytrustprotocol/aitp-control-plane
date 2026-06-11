import type { AuditEventRecord } from './stream';
// Pull the bus indirectly so the singleton initialises with the
// process-wide default backlog cap; the basic semantics we test
// (publish + replay + unsubscribe) don't depend on the cap value.
// `EventBus` is imported directly so the drop-count test can use a fresh
// instance with a deterministic, small cap.
import { EventBus, eventBus } from './stream';

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

  it('counts exactly the events evicted past a known backlog cap', () => {
    // A fresh bus with a tiny cap makes the drop count exact, unlike the
    // shared singleton whose prior state is unknown. Cap 3, publish 10 →
    // the first 7 are evicted as the 8th..10th arrive (10 - 3 = 7).
    const bus = new EventBus(3);
    for (let i = 0; i < 10; i += 1) bus.publish(makeEvent(`drop-${i}`));
    expect(bus.getDroppedCount()).toBe(7);
    // Backlog retains only the most recent `cap` events, in order.
    expect(bus.getBacklog(100).map((e) => e.id)).toEqual([
      'drop-7',
      'drop-8',
      'drop-9',
    ]);
  });

  it('reports zero drops while within the cap', () => {
    const bus = new EventBus(5);
    for (let i = 0; i < 5; i += 1) bus.publish(makeEvent(`keep-${i}`));
    expect(bus.getDroppedCount()).toBe(0);
  });
});
