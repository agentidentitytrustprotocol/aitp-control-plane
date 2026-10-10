import { createHash, randomUUID } from 'node:crypto';

/**
 * Event ids for `POST /api/events` — content-derived id recipe **v1**.
 *
 * Producers never send an event id, and they re-send events: the playground
 * flushes a run's log mid-run and posts the whole log again when the run ends
 * (a prefix, then a superset), and any client retries after a timeout. With a
 * random id per ingest every re-send was a new history row, a new SSE frame
 * and — for deliverable types — a second webhook delivery.
 *
 * So an event that carries a valid `ts` gets an id derived from what was sent:
 *
 *   uuidv8( SHA-256( "aitp-event:v1\0" + producerKey + "\0" + canonicalJson(rawEvent) ) )
 *
 * - `producerKey` is the bearer-token fingerprint from `actorIdFromAuthHeader`
 *   (src/lib/audit-log/actor.ts) (same `Bearer `/raw parsing as the proxy), or `""` with none. Two
 *   API-key holders sending identical bytes therefore get different ids: one
 *   producer can never suppress another's events. Rotating a key changes the
 *   ids of everything sent after the rotation.
 * - `rawEvent` is the event object AS RECEIVED (after JSON.parse), not the
 *   normalized record: normalization truncates `ts` to milliseconds and fills
 *   defaults, which would merge events the producer considered distinct.
 * - `canonicalJson` sorts object keys, so key order on the wire is irrelevant.
 * - The first 16 bytes of the digest become an RFC 9562 version-8 UUID
 *   (version nibble 8, variant 10). Not v5: v5 is SHA-1 over a namespace.
 *
 * An event WITHOUT a valid `ts` (absent, unparseable, out of range — exactly
 * the cases where the stored `ts` falls back to ingest time) keeps a random
 * id: two identical ts-less events are most likely two real occurrences.
 *
 * The `v1` tag is part of the hashed input, so a future recipe (`v2`) yields
 * disjoint ids; rows written under an earlier recipe keep theirs.
 */
export const EVENT_ID_RECIPE_TAG = 'aitp-event:v1';

/**
 * A `Date` the `ts` column can store: a valid instant (a number beyond the
 * ECMAScript range of +-8.64e15 ms yields an Invalid Date, whose
 * `toISOString()` throws) whose UTC year is 0001-9999 (outside that,
 * `toISOString()` renders an expanded `+010000-...` / `-000001-...` year).
 */
function inStorableRange(d: Date): boolean {
  if (Number.isNaN(d.getTime())) return false;
  const year = d.getUTCFullYear();
  return year >= 1 && year <= 9999;
}

/**
 * The event's `ts` as ISO-8601, or `null` when it is absent, unparseable or
 * out of range (see {@link inStorableRange}). Numbers below 1e12 are seconds.
 */
export function parseEventTimestamp(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (inStorableRange(d)) return d.toISOString();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    if (inStorableRange(d)) return d.toISOString();
  }
  return null;
}

type Frame = { lit: string } | { value: unknown };

/**
 * Canonical JSON for a JSON.parse result: object keys sorted (UTF-16 code
 * unit order), no whitespace, strings and numbers as JSON.stringify writes
 * them (lone surrogates escaped, so distinct strings never collide). ITERATIVE
 * — an explicit stack, no recursion — so a deeply nested value cannot
 * overflow the call stack. Values JSON cannot represent (undefined,
 * functions) do not occur in parsed input; they serialize as `null`.
 */
export function canonicalJson(root: unknown): string {
  const out: string[] = [];
  const stack: Frame[] = [{ value: root }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if ('lit' in frame) {
      out.push(frame.lit);
      continue;
    }
    const v = frame.value;
    if (v === null || typeof v !== 'object') {
      out.push(
        typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
          ? JSON.stringify(v)
          : 'null',
      );
      continue;
    }
    if (Array.isArray(v)) {
      out.push('[');
      stack.push({ lit: ']' });
      for (let i = v.length - 1; i >= 0; i -= 1) {
        stack.push({ value: v[i] });
        if (i > 0) stack.push({ lit: ',' });
      }
      continue;
    }
    const keys = Object.keys(v).sort();
    out.push('{');
    stack.push({ lit: '}' });
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      stack.push({ value: (v as Record<string, unknown>)[keys[i]] });
      stack.push({ lit: `${JSON.stringify(keys[i])}:` });
      if (i > 0) stack.push({ lit: ',' });
    }
  }
  return out.join('');
}

/** RFC 9562 version-8 UUID from the first 16 bytes of `digest`. */
function uuidV8(digest: Buffer): string {
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x80; // version 8
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 9562 variant (10xx)
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * The id for one raw ingested event under recipe v1: content-derived when the
 * event has a valid `ts`, random otherwise. `producerKey` is the bearer-token
 * fingerprint (`actorIdFromAuthHeader`) or `null`.
 */
export function eventIdFor(
  rawEvent: Record<string, unknown>,
  producerKey: string | null,
): string {
  if (parseEventTimestamp(rawEvent.ts) === null) return randomUUID();
  const digest = createHash('sha256')
    .update(`${EVENT_ID_RECIPE_TAG}\0${producerKey ?? ''}\0`)
    .update(canonicalJson(rawEvent))
    .digest();
  return uuidV8(digest);
}
