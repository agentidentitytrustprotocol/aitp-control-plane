import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { trustAnchors } from '@/lib/db/schema';

/**
 * The id of the anchor holding `(namespace, issuerUrl)`, for the `409
 * ALREADY_EXISTS` answer after a `trust_anchors_namespace_issuer_uniq`
 * violation (POST and PATCH). `undefined` if it vanished in between.
 */
export async function findAnchorIdByIssuer(
  namespace: string,
  issuerUrl: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ id: trustAnchors.id })
    .from(trustAnchors)
    .where(and(eq(trustAnchors.namespace, namespace), eq(trustAnchors.issuerUrl, issuerUrl)))
    .limit(1);
  return rows[0]?.id;
}

/** The `409 ALREADY_EXISTS` body shared by POST and PATCH. */
export function alreadyExistsBody(existingId: string | undefined) {
  return {
    error:
      'trust anchor already exists for this (namespace, issuerUrl) — PATCH the existing id to update',
    code: 'ALREADY_EXISTS',
    existing: existingId ? { id: existingId } : undefined,
  };
}
