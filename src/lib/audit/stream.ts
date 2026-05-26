import { config } from '../config';
import { logger } from '../logger';

export interface AuditEventRecord {
  id: string;
  type: string;
  ts: string;
  aidA?: string;
  aidB?: string;
  sessionId?: string;
  runId?: string;
  grants?: string[];
  payload: Record<string, unknown>;
  source?: string;
}

type Listener = (event: AuditEventRecord) => void;

class EventBus {
  private listeners = new Set<Listener>();
  private backlog: AuditEventRecord[] = [];
  private readonly maxBacklog: number;
  private dropped = 0;

  constructor(maxBacklog: number) {
    this.maxBacklog = maxBacklog;
  }

  publish(event: AuditEventRecord): void {
    this.backlog.push(event);
    if (this.backlog.length > this.maxBacklog) {
      this.backlog.shift();
      this.dropped += 1;
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        logger.warn({ err, eventType: event.type }, 'eventBus listener threw');
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getBacklog(limit = 100): AuditEventRecord[] {
    return this.backlog.slice(-limit);
  }

  /** Total events evicted from the in-memory backlog since process start.
   * Eviction means a slow SSE subscriber that connected later may have
   * missed events — they should reconcile with `/api/events/history`. */
  getDroppedCount(): number {
    return this.dropped;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __eventBus: EventBus | undefined;
}

export const eventBus =
  globalThis.__eventBus ??
  (globalThis.__eventBus = new EventBus(config.maxAuditEventsInMemory));
