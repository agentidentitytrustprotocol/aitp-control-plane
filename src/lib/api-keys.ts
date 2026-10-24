/**
 * Per-consumer API keys.
 *
 * `API_KEYS` is a comma-separated list. Each entry is either
 *
 *   - `label:key`: a labelled key. The label is a short, NON-SECRET name for the
 *     consumer (`console`, `playground`, `ops-alice`, `console-2026-10`). It is
 *     recorded as the actor on every admin audit row written by a request made
 *     with that key, so traffic is attributable per consumer.
 *   - `key`: a bare key, as before. It is labelled `unlabelled-<n>`, where `<n>`
 *     is its 1-based position in the list. That label is only as stable as the
 *     list order, which is one reason to label every key.
 *
 * A prefix is only taken as a label when it matches LABEL_RE. Anything else
 * (no colon, an empty or over-long prefix, a character outside the label set)
 * makes the whole entry a bare key, so a pre-existing bare key keeps working
 * byte for byte.
 *
 * Labels must never contain the secret. A label that equals any configured key,
 * or is a substring of one and at least SECRET_FRAGMENT_MIN chars long, is
 * refused and the entry falls back to `unlabelled-<n>` with a boot warning, so a reversed `key:label` typo cannot
 * write a secret into the audit log.
 */

export interface ApiKeyEntry {
  /** Non-secret consumer name; safe to log and to store in the audit log. */
  label: string;
  /** The bearer secret. Never log it. */
  key: string;
}

export interface ParsedApiKeys {
  entries: ApiKeyEntry[];
  /** Problems worth a boot warning. They never contain a secret. */
  warnings: string[];
}

/** 1 to 40 chars, starting alphanumeric; `.`, `_` and `-` allowed after that. */
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * Shorter labels are only refused when they EQUAL a key: a short word like `ops`
 * can occur inside a long random key by chance, and a few characters of a
 * 64+ char key are not a usable leak.
 */
const SECRET_FRAGMENT_MIN = 8;

function looksLikeSecret(label: string, keys: readonly string[]): boolean {
  return keys.some(
    (k) => k === label || (label.length >= SECRET_FRAGMENT_MIN && k.includes(label)),
  );
}

export function unlabelledLabel(position: number): string {
  return `unlabelled-${position}`;
}

export function parseApiKeys(raw: string | undefined): ParsedApiKeys {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const split = items.map((item) => {
    const idx = item.indexOf(':');
    if (idx > 0) {
      const label = item.slice(0, idx);
      const key = item.slice(idx + 1).trim();
      if (LABEL_RE.test(label) && key.length > 0) return { label, key };
    }
    return { label: null as string | null, key: item };
  });

  const allKeys = split.map((s) => s.key);
  const warnings: string[] = [];
  const entries: ApiKeyEntry[] = [];
  const seenKeys = new Set<string>();
  const seenLabels = new Set<string>();

  split.forEach((s, i) => {
    const position = i + 1;
    let label = s.label;
    if (label !== null && looksLikeSecret(label, allKeys)) {
      warnings.push(
        `API_KEYS entry ${position}: its label is part of a configured key and was ` +
          `refused (labels must never contain the secret); using ${unlabelledLabel(position)}`,
      );
      label = null;
    }
    if (label === null) label = unlabelledLabel(position);

    if (seenKeys.has(s.key)) {
      warnings.push(
        `API_KEYS entry ${position} (${label}): duplicate key; the first entry's label is used`,
      );
      return;
    }
    if (seenLabels.has(label)) {
      warnings.push(
        `API_KEYS entry ${position}: label "${label}" is used more than once, so its ` +
          `traffic is not distinguishable from the other key with that label`,
      );
    }
    seenKeys.add(s.key);
    seenLabels.add(label);
    entries.push({ label, key: s.key });
  });

  return { entries, warnings };
}

/** Build a key -> label lookup. The first entry for a key wins. */
export function labelIndex(entries: readonly ApiKeyEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) if (!m.has(e.key)) m.set(e.key, e.label);
  return m;
}
