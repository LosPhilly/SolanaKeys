import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import sealedBox from 'tweetnacl-sealedbox-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export async function POST(req: Request) {
  try {
    const { jobId, userWallet, clientPubkey } = await req.json();

    if (!jobId || !userWallet || !clientPubkey) {
      return NextResponse.json({ error: 'Missing cancellation data' }, { status: 400 });
    }

    // 1. Fetch the Escrowed Job
    const { data: job } = await supabase.from('vanity_jobs').select('*').eq('id', jobId).single();
    
    if (job.customer_wallet !== userWallet) {
      return NextResponse.json({ error: 'Unauthorized to cancel this listing.' }, { status: 403 });
    }

    if (!job.escrow_payload) {
      return NextResponse.json({ error: 'Item is not currently in escrow.' }, { status: 400 });
    }

    // 2. CRYPTOGRAPHIC HANDOVER: Decrypt Master Escrow (With Key Versioning)
    const keysEnv = process.env.MASTER_KEYS || `v1:${process.env.MASTER_INVENTORY_KEY}`;
    const masterKeyDict = Object.fromEntries(keysEnv.split(',').map(k => k.split(':')));

    const rawPayload = job.escrow_payload;
    let version = 'v1';
    let ciphertextBase64 = rawPayload;

    // Check if this payload has a version tag (e.g., v2:base64string...)
    if (rawPayload.includes(':')) {
      [version, ciphertextBase64] = rawPayload.split(':');
    }

    const masterKeyString = masterKeyDict[version];
    if (!masterKeyString) {
      throw new Error(`CRITICAL: Missing historical master key for version ${version}`);
    }

    const masterKeyBytes = util.decodeBase64(masterKeyString);
    const escrowBytes = util.decodeBase64(ciphertextBase64);
    
    const nonce = escrowBytes.slice(0, nacl.secretbox.nonceLength);
    const box = escrowBytes.slice(nacl.secretbox.nonceLength);
    const decryptedBytes = nacl.secretbox.open(box, nonce, masterKeyBytes);

    if (!decryptedBytes) {
      throw new Error(`Master decryption sequence failed to open escrow box for version ${version}`);
    }

    // 3. Re-Encrypt for the User's local Vault (Reverse Handover)
    const clientPublicKeyBytes = util.decodeBase64(clientPubkey);
    const newVaultPayloadBytes = sealedBox.seal(decryptedBytes, clientPublicKeyBytes);
    const safeEncryptedPayload = util.encodeBase64(newVaultPayloadBytes);

    // 4. Update the database to return it to the Vault
    await supabase.from('vanity_jobs').update({
      is_listed: false,
      listing_price: 0,
      escrow_payload: null,
      result_payload: safeEncryptedPayload // Safely restored!
    }).eq('id', jobId);

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Cancellation error:', error);
    return NextResponse.json({ error: 'Failed to cancel listing' }, { status: 500 });
  }
}