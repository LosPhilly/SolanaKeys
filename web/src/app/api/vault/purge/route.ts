import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// Use the Service Role Key here to bypass RLS securely on the server
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

    // 1. Reconstruct the exact message the user was supposed to sign
    const expectedMessage = `Authenticate to SolanaKeys.\nAction: PURGE\nJob ID: ${jobId}`;
    if (message !== expectedMessage) {
      return NextResponse.json({ error: 'Invalid message payload' }, { status: 403 });
    }

    // 2. Cryptographically verify the signature
    const signatureUint8 = bs58.decode(signature);
    const messageUint8 = new TextEncoder().encode(message);
    const pubKeyUint8 = new PublicKey(publicKey).toBytes();

    const isValid = nacl.sign.detached.verify(messageUint8, signatureUint8, pubKeyUint8);

    if (!isValid) {
      return NextResponse.json({ error: 'Invalid signature. Nice try, hacker.' }, { status: 401 });
    }

    // 3. Verify the user actually owns this specific job before deleting
    const { data: job } = await supabase
      .from('vanity_jobs')
      .select('customer_wallet')
      .eq('id', jobId)
      .single();

    if (!job || job.customer_wallet !== publicKey) {
      return NextResponse.json({ error: 'Unauthorized to delete this record' }, { status: 403 });
    }

    // 4. Execute the Hard Purge
    const { error } = await supabase
      .from('vanity_jobs')
      .delete() // Changed to an actual physical DELETE instead of UPDATE
      .eq('id', jobId);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (err: any) {
    console.error("Purge Error:", err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}