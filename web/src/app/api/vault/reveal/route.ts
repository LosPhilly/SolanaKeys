import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

export async function POST(req: Request) {
  try {
    const { jobId, publicKey, signature, message } = await req.json();

    if (!jobId || !publicKey || !signature || !message) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    // 1. Reconstruct the exact message the client signed
    const expectedMessage = `Authenticate to SolanaKeys.\nAction: REVEAL\nJob ID: ${jobId}`;
    if (message !== expectedMessage) {
      return NextResponse.json({ error: 'Invalid message payload' }, { status: 403 });
    }

    // 2. Cryptographically verify the signature
    const signatureUint8 = bs58.decode(signature);
    const messageUint8 = new TextEncoder().encode(message);
    const pubKeyUint8 = new PublicKey(publicKey).toBytes();

    const isValid = nacl.sign.detached.verify(messageUint8, signatureUint8, pubKeyUint8);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // 3. Verify ownership and check the key hasn't been listed
    const { data: job, error: fetchError } = await supabase
      .from('vanity_jobs')
      .select('customer_wallet, is_listed, is_revealed')
      .eq('id', jobId)
      .single();

    if (fetchError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.customer_wallet !== publicKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // A listed key must not be revealable — it lives in escrow
    if (job.is_listed) {
      return NextResponse.json({ error: 'Cannot reveal a key that is currently listed for sale.' }, { status: 400 });
    }

    // Already revealed — idempotent success
    if (job.is_revealed) {
      return NextResponse.json({ success: true });
    }

    // 4. Mark as revealed — permanently bans it from the exchange
    const { error: updateError } = await supabase
      .from('vanity_jobs')
      .update({ is_revealed: true })
      .eq('id', jobId)
      .eq('customer_wallet', publicKey); // double-check ownership at write time

    if (updateError) throw updateError;

    return NextResponse.json({ success: true });

  } catch (err: any) {
    console.error('Reveal error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}