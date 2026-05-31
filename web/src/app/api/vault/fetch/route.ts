import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// Use the Service Role Key here to safely read records behind RLS barriers
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

export async function POST(req: Request) {
  try {
    const { publicKey, signature, message } = await req.json();

    if (!publicKey || !signature || !message) {
      return NextResponse.json({ error: 'Missing authentication payload' }, { status: 400 });
    }

    // 1. Reconstruct and validate the exact action message string
    const expectedMessage = `Authenticate to SolanaKeys.\nAction: FETCH_COMPLETED_KEYS\nWallet: ${publicKey}`;
    if (message !== expectedMessage) {
      return NextResponse.json({ error: 'Invalid challenge message handshake' }, { status: 403 });
    }

    // 2. Cryptographically verify the signature matches the claimed wallet
    const signatureUint8 = bs58.decode(signature);
    const messageUint8 = new TextEncoder().encode(message);
    const pubKeyUint8 = new PublicKey(publicKey).toBytes();

    const isValid = nacl.sign.detached.verify(messageUint8, signatureUint8, pubKeyUint8);

    if (!isValid) {
      return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 });
    }

    // 3. Signature is authentic. Fetch only completed assets for this specific wallet identity.
    // --> ADDED: is_revealed and is_listed to the select string
    const { data: completedJobs, error } = await supabase
      .from('vanity_jobs')
      .select('id, prefix, suffix, target_length, result_address, result_payload, completed_at, status, is_revealed, is_listed')
      .eq('customer_wallet', publicKey)
      .eq('status', 'COMPLETED')
      .order('completed_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ success: true, keys: completedJobs || [] });

  } catch (err: any) {
    console.error("Fetch Secure Vault Error:", err);
    return NextResponse.json({ error: 'Internal server safety exception' }, { status: 500 });
  }
}