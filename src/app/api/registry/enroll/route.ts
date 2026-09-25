import { NextRequest } from 'next/server';
import { getEnrollmentService } from '@/lib/registry/enrollment';
import { sdkVerifyCode } from '@/lib/registry/verify-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.text();
  // Pre-validate JSON shape so the caller gets "body must be ManifestEnvelope"
  // instead of a Rust serde error string when they POST something unrelated.
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed.manifest || typeof parsed.manifest !== 'object') {
      return Response.json(
        {
          error: 'body must be a ManifestEnvelope: {"manifest": {...}}',
          code: 'MANIFEST_INVALID',
        },
        { status: 400 },
      );
    }
  } catch {
    return Response.json(
      { error: 'body must be valid JSON', code: 'BODY_INVALID' },
      { status: 400 },
    );
  }
  try {
    const result = getEnrollmentService().verifyAndIssueToken(body);
    return Response.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `code` keeps its value. It is this repo's SCREAMING_SNAKE taxonomy
    // (BODY_INVALID, MANIFEST_EXPIRED, TOKEN_INVALID, RATE_LIMITED, …); the
    // SDK's codes are a lowercase_snake vocabulary owned by a different
    // project on a different release cadence. Writing one into the other
    // would break every client branching on `code` today and put two
    // unrelated vocabularies in one field. The case convention carries the
    // distinction: SCREAMING_SNAKE means this service classified it,
    // lowercase_snake means the SDK did.
    //
    // So `verifyCode` is an additive sibling field, following the
    // `{error, code, bucket}` shape src/proxy.ts already returns on a 429.
    const verifyCode = sdkVerifyCode(err);
    // Named errorBody, not body: `body` is already the request text read at
    // the top of this handler. Phase 5 adds a log line in this same catch,
    // and the obvious thing to reach for when logging a verification failure
    // is the request body — which must NOT be logged (it is unauthenticated
    // attacker-controlled input on a public route). Distinct names so that
    // mistake cannot be made silently.
    const errorBody: { error: string; code: string; verifyCode?: string } = {
      error: message,
      code: 'MANIFEST_INVALID',
    };
    // Semantics: `verifyCode` present ⇔ the aitp SDK rejected this manifest.
    // Its absence means one of our own guards did, which is information, not
    // a gap.
    //
    // Honest about what this line buys, because it is easy to overstate:
    // `JSON.stringify` already drops an explicitly-`undefined` value, so
    // assigning unconditionally would produce the SAME bytes, and no test can
    // tell the two apart. The conditional is therefore a statement of intent
    // and insurance against a future serializer that does NOT drop
    // `undefined` (or a caller reading this object before it is serialized) —
    // not a behavior the suite verifies.
    if (verifyCode !== undefined) errorBody.verifyCode = verifyCode;
    return Response.json(errorBody, { status: 400 });
  }
}
