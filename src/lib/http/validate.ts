/**
 * Shared request-validation helpers for route handlers.
 *
 * Every helper here exists to turn an input Postgres would reject (and the
 * route would therefore surface as an unclassified 500) into a classified
 * `400` BEFORE the database sees it:
 *
 *   - a non-UUID in a `uuid` column               -> 22P02
 *   - a value longer than a `varchar(n)` column   -> 22001
 *   - U+0000 in any text column                   -> 22021
 *   - a JSON body that is `null` / not an object  -> TypeError on `body.x`
 *
 * Error codes follow the API's conventions (docs/api.md): `ID_INVALID` for a
 * path id, `BODY_INVALID` for a body field, `BAD_REQUEST` for a query param.
 */

/**
 * RFC 4122 versions 1-5 only — the rule the `jti` / `root_jti` / `parent_jti`
 * checks have always applied (delegations, revocation entries, the TCT
 * projection). Kept byte-identical to the copies it replaced; a v6/v7/v8 UUID
 * is rejected. Do NOT use this for path ids: see {@link isUuid}.
 */
export const JTI_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Canonical 8-4-4-4-12 hex form, any version / variant, any case. */
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SYNTAX-ONLY check for a path id that is looked up in a Postgres `uuid`
 * column. Postgres stores any version, so this accepts any version and
 * variant — its only job is to keep a value Postgres cannot parse (22P02 ->
 * 500) away from the query. Only the canonical hyphenated form is accepted;
 * every id this service hands out (`randomUUID()`) is in that form.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && ANY_UUID_RE.test(value);
}

/** The `400 ID_INVALID` answer for a path id that is not a UUID. */
export function invalidId(): Response {
  return Response.json({ error: 'id must be a UUID', code: 'ID_INVALID' }, { status: 400 });
}

/**
 * Validate a string bound for a text/varchar column. Returns a human error
 * message, or `null` when the value is storable.
 *
 * `max` counts CODE POINTS — the unit `varchar(n)` counts — not UTF-16 code
 * units: 65 astral characters (130 UTF-16 units) fit a varchar(65). A
 * `.length` test would invent 400s for input the column accepts.
 *
 * `maxBytes` (optional) additionally caps the UTF-8 encoding, for a value that
 * sits in a btree index, whose row-size limit is in bytes.
 *
 * U+0000 is rejected for every column: Postgres cannot store it in any
 * character type. (A lone surrogate is fine — Node's UTF-8 encoder substitutes
 * U+FFFD before Postgres sees it.)
 */
export function checkColumnString(
  value: string,
  opts: { field: string; max: number; maxBytes?: number },
): string | null {
  if (value.includes('\u0000')) {
    return `${opts.field} must not contain a NUL character`;
  }
  if ([...value].length > opts.max) {
    return `${opts.field} exceeds ${opts.max} character limit`;
  }
  if (opts.maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > opts.maxBytes) {
    return `${opts.field} exceeds ${opts.maxBytes} byte limit`;
  }
  return null;
}

/**
 * Validate a query-string value that reaches a text comparison. Returns a
 * human error message (answer `400 BAD_REQUEST`), or `null` when it is fine
 * (including when the parameter is absent).
 */
export function checkQueryParam(value: string | null, name: string): string | null {
  if (value !== null && value.includes('\u0000')) {
    return `${name} must not contain a NUL character`;
  }
  return null;
}

/** `400` with the standard `{error, code}` body. */
export function badRequest(error: string, code = 'BODY_INVALID'): Response {
  return Response.json({ error, code }, { status: 400 });
}

export type JsonObjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

/**
 * Parse the request body as a JSON OBJECT. A body that is not JSON, or is JSON
 * but not a plain object (`null`, an array, a string, a number, a boolean),
 * yields a `400 BODY_INVALID` response for the caller to return as-is.
 */
export async function readJsonObject(req: Request): Promise<JsonObjectResult> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, response: badRequest('body must be JSON') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: badRequest('body must be a JSON object') };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** True when `err` is a Postgres unique violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

/**
 * The `http(s)://` prefix rule trust-anchor URLs are checked against (a
 * syntax check only; SSRF is enforced at fetch time by the JWKS refresher).
 */
export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}
