import { NextRequest } from 'next/server';
import { getEnrollmentService } from '@/lib/registry/enrollment';

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
    return Response.json(
      { error: message, code: 'MANIFEST_INVALID' },
      { status: 400 },
    );
  }
}
