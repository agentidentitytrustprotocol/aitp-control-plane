import {
  revocationProducer,
  RevocationUnavailableError,
} from '@/lib/revocation/producer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let envelope: string;
  try {
    envelope = await revocationProducer.getEnvelopeJson();
  } catch (err) {
    if (err instanceof RevocationUnavailableError) {
      // Fail closed: never assert "nothing is revoked" without reading the
      // store. Classified 503 (not a bare 500), fixed body, no DB detail.
      return Response.json(
        { error: err.message, code: err.code },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' },
        },
      );
    }
    throw err;
  }
  return new Response(envelope, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=60',
    },
  });
}
