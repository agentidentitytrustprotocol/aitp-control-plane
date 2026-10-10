import { checkColumnString } from '@/lib/http/validate';

/**
 * Column limits (src/lib/db/schema.ts `trustAnchors`): `namespace` and `label`
 * are varchar(128); `issuer_url` / `jwks_url` are text, but `issuer_url` sits
 * in the unique btree `trust_anchors_namespace_issuer_uniq`, whose row limit is
 * 2704 BYTES — measured: a 3008-byte issuer fails with 54000. 2048 bytes plus a
 * 128-code-point namespace (<= 512 bytes) stays under it. `jwks_url` gets the
 * same 2048 code-point cap for symmetry. Shared by the collection and [id] routes
 * (a route module may only export route fields, so these live here).
 */
export const NAME_MAX = 128;
export const URL_MAX = 2048;

export function checkIssuerUrl(v: string): string | null {
  return checkColumnString(v, { field: 'issuerUrl', max: URL_MAX, maxBytes: URL_MAX });
}

export function checkJwksUrl(v: string): string | null {
  return checkColumnString(v, { field: 'jwksUrl', max: URL_MAX });
}
