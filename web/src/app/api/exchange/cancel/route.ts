import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import sealedBox from 'tweetnacl-sealedbox-js';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export async function POST(req: Request) {
  try {
    const { jobId, userWallet, clientPubkey, message, signature } = await req.json();

    if (!jobId || !userWallet || !clientPubkey || !message || !signature) {
      return NextResponse.json({ error: 'Missing cancellation data' }, { status: 400 });
    }

    // 1. Verify the message commits to exactly this cancel action on this job
    const expectedMessage = `Authenticate to SolanaKeys.\nAction: CANCEL_LISTING\nJob ID: ${jobId}`;
    if (message !== expectedMessage) {
      return NextResponse.json({ error: 'Invalid action message.' }, { status: 403 });
    }

    // 2. Cryptographically verify the caller owns the wallet they claim
    const signatureUint8 = bs58.decode(signature);
    const messageUint8 = new TextEncoder().encode(message);
    const pubKeyUint8 = new PublicKey(userWallet).toBytes();

    const isValid = nacl.sign.detached.verify(messageUint8, signatureUint8, pubKeyUint8);
    if (!isValid) {
      return NextResponse.json({ error: 'Signature verification failed.' }, { status: 401 });
    }

    // 3. Fetch the escrowed job and verify ownership
    const { data: job, error: fetchError } = await supabase
      .from('vanity_jobs')
      .select('customer_wallet, escrow_payload, is_listed')
      .eq('id', jobId)
      .single();

    if (fetchError || !job) {
      return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    }

    if (job.customer_wallet !== userWallet) {
      return NextResponse.json({ error: 'Unauthorized to cancel this listing.' }, { status: 403 });
    }

    if (!job.escrow_payload || !job.is_listed) {
      return NextResponse.json({ error: 'Item is not currently in escrow.' }, { status: 400 });
    }

    // 4. Decrypt master escrow payload (with key versioning)
    const keysEnv = process.env.MASTER_KEYS || `v1:${process.env.MASTER_INVENTORY_KEY}`;
    const masterKeyDict = Object.fromEntries(keysEnv.split(',').map(k => k.split(':')));

    const rawPayload = job.escrow_payload;
    let version = 'v1';
    let ciphertextBase64 = rawPayload;

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
      throw new Error(`Master decryption failed for version ${version}`);
    }

    // 5. Re-encrypt for the user's local vault (reverse handover)
    const clientPublicKeyBytes = util.decodeBase64(clientPubkey);
    const newVaultPayloadBytes = sealedBox.seal(decryptedBytes, clientPublicKeyBytes);
    const safeEncryptedPayload = util.encodeBase64(newVaultPayloadBytes);

    // 6. Return to vault — double-bind on customer_wallet at write time
    const { error: updateError } = await supabase
      .from('vanity_jobs')
      .update({
        is_listed: false,
        listing_price: 0,
        escrow_payload: null,
        result_payload: safeEncryptedPayload,
      })
      .eq('id', jobId)
      .eq('customer_wallet', userWallet);

    if (updateError) throw updateError;

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[routeCancle] Cancellation error:', error);
    return NextResponse.json({ error: 'Failed to cancel listing' }, { status: 500 });
  }
}
