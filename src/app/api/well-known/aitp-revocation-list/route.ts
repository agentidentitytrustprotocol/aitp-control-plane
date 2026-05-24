import { revocationProducer } from '@/lib/revocation/producer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const envelope = await revocationProducer.getEnvelopeJson();
  return new Response(envelope, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=60',
    },
  });
}
