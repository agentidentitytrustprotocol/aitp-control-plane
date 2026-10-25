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
 *
 * Labels must be unique. A label used by two keys makes their audit rows
 * indistinguishable, so it is a boot ERROR, not a warning: the process refuses
 * to start (src/lib/key-labels-config.ts). Rotate by adding the new key under a
 * NEW label (`console-20261024` -> `console-20261124`).
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
  /** Problems that refuse boot. They never contain a secret. */
  errors: string[];
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
  const errors: string[] = [];
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
      errors.push(
        `API_KEYS entry ${position}: label "${label}" is already used by an earlier entry; ` +
          'labels must be unique, or their audit rows cannot be told apart',
      );
    }
    seenKeys.add(s.key);
    seenLabels.add(label);
    entries.push({ label, key: s.key });
  });

  return { entries, warnings, errors };
}

/** Build a key -> label lookup. The first entry for a key wins. */
export function labelIndex(entries: readonly ApiKeyEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) if (!m.has(e.key)) m.set(e.key, e.label);
  return m;
}

/**
 * Issuer-bound keys (`ISSUER_KEYS`): one per issuing agent, for the revocation
 * relay (`GET /api/revocations?iss=`). Comma-separated `label@aid=key` entries.
 *
 * Kept in a list SEPARATE from `API_KEYS` on purpose: an issuer key is not an
 * admin key, and the gate (src/proxy.ts) accepts it on that one route only, so
 * no entry here can ever open an admin route by mistake.
 *
 * The AID is the bound identity: the route answers only `iss=<that aid>` for
 * this key. An AID (`aid:pubkey:...`) contains neither `@` nor `=`, so the
 * entry splits on the first of each. A malformed entry, or one whose key is
 * also an `API_KEYS` key, is skipped with a boot warning (never a secret).
 *
 * Labels are unique, so each label (one metric series) has exactly one AID. A
 * label used twice, for the same AID or a different one, is a boot ERROR. One
 * AID may have several labels: that is the rotation overlap (`r-1@aid=old`,
 * `r-2@aid=new`, then drop `r-1`).
 */

export interface IssuerKeyEntry extends ApiKeyEntry {
  /** The issuer AID this key may pull revocations for. */
  aid: string;
}

export interface ParsedIssuerKeys {
  entries: IssuerKeyEntry[];
  warnings: string[];
  errors: string[];
}

/** The AID shapes the SDK mints (`aid:pubkey:<b64url>`, `aid:pubkey:p256:<b64url>`). */
export const AID_RE = /^aid:[A-Za-z0-9:._-]{1,500}$/;

export function parseIssuerKeys(
  raw: string | undefined,
  adminKeys: readonly string[] = [],
): ParsedIssuerKeys {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const entries: IssuerKeyEntry[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const seenKeys = new Set<string>();
  const seenLabels = new Set<string>();

  items.forEach((item, i) => {
    const position = i + 1;
    const at = item.indexOf('@');
    const eq = at > 0 ? item.indexOf('=', at) : -1;
    const label = at > 0 ? item.slice(0, at) : '';
    const aid = eq > at ? item.slice(at + 1, eq) : '';
    const key = eq > at ? item.slice(eq + 1).trim() : '';
    if (!LABEL_RE.test(label) || !AID_RE.test(aid) || key.length === 0) {
      warnings.push(
        `ISSUER_KEYS entry ${position}: not of the form label@aid=key; skipped`,
      );
      return;
    }
    if (looksLikeSecret(label, [key, ...adminKeys])) {
      warnings.push(
        `ISSUER_KEYS entry ${position}: its label is part of a configured key; skipped`,
      );
      return;
    }
    if (adminKeys.includes(key)) {
      warnings.push(
        `ISSUER_KEYS entry ${position} (${label}): its key is also an API_KEYS key; ` +
          'skipped (an issuer key must not be an admin key)',
      );
      return;
    }
    if (seenKeys.has(key)) {
      warnings.push(`ISSUER_KEYS entry ${position} (${label}): duplicate key; skipped`);
      return;
    }
    if (seenLabels.has(label)) {
      errors.push(
        `ISSUER_KEYS entry ${position}: label "${label}" is already used by an earlier entry; ` +
          'labels must be unique (rotate an AID\'s key under a new label)',
      );
    }
    seenKeys.add(key);
    seenLabels.add(label);
    entries.push({ label, aid, key });
  });

  return { entries, warnings, errors };
}

/** Build a key -> entry lookup for issuer keys. */
export function issuerKeyIndex(
  entries: readonly IssuerKeyEntry[],
): Map<string, IssuerKeyEntry> {
  return new Map(entries.map((e) => [e.key, e]));
}
