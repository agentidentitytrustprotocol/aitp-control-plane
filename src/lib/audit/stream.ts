import { config } from '../config';

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

  constructor(maxBacklog: number) {
    this.maxBacklog = maxBacklog;
  }

  publish(event: AuditEventRecord): void {
    this.backlog.push(event);
    if (this.backlog.length > this.maxBacklog) this.backlog.shift();
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.warn('[eventBus] listener threw:', err);
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
}

declare global {
  // eslint-disable-next-line no-var
  var __eventBus: EventBus | undefined;
}

export const eventBus =
  globalThis.__eventBus ??
  (globalThis.__eventBus = new EventBus(config.maxAuditEventsInMemory));
