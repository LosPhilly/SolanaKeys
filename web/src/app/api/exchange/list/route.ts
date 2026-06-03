import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import bs58 from 'bs58';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const connection = new Connection(
  process.env.SERVER_SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);

const PLATFORM_FEE_WALLET = process.env.NEXT_PUBLIC_ADMIN_WALLET;
const LISTING_FEE_SOL = 0.025;

export async function POST(req: Request) {
  try {
    if (!PLATFORM_FEE_WALLET) {
      return NextResponse.json({ error: 'Server misconfiguration: Missing Admin Wallet.' }, { status: 500 });
    }

    // rawPrivateKey is intentionally absent — the server derives the escrow payload
    // from master_payload stored at job completion. The client never sends a raw key.
    const { jobId, userWallet, priceSol, paymentSignature, blockhash, lastValidBlockHeight } = await req.json();

    if (!jobId || !priceSol || !userWallet || !paymentSignature) {
      return NextResponse.json({ error: 'Missing listing data or payment signature.' }, { status: 400 });
    }

    // blockhash/lastValidBlockHeight accepted from client but not used for server confirmation —
    // client confirms before POSTing, so the window may already be closed by the time
    // the server processes the request. We fetch the confirmed tx directly instead.

    // 1. Fetch the job — need result_address, master_payload, and guard fields
    const { data: job, error: jobError } = await supabase
      .from('vanity_jobs')
      .select('customer_wallet, result_address, master_payload, is_revealed, is_listed')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Vanity job record not found.' }, { status: 404 });
    }

    if (job.customer_wallet !== userWallet) {
      return NextResponse.json({ error: 'Unauthorized: Wallet mismatch.' }, { status: 401 });
    }

    if (job.is_revealed) {
      return NextResponse.json({ error: 'Revealed keys cannot be listed.' }, { status: 403 });
    }

    if (job.is_listed) {
      return NextResponse.json({ error: 'This item is already listed.' }, { status: 409 });
    }

    // master_payload must exist — written by the worker at job completion.
    // Jobs pre-dating this architecture cannot be listed.
    if (!job.master_payload) {
      return NextResponse.json(
        { error: 'This job does not support server-side escrow. Please contact support.' },
        { status: 400 }
      );
    }

    // 2. Fetch the confirmed listing fee transaction — client already confirmed it before
    // POSTing, so we skip server-side confirmTransaction which can fail if the blockhash
    // window has expired by the time the server processes the request.
    console.log(`[routelist] Fetching confirmed listing fee tx: ${paymentSignature}`);
    let tx = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      tx = await connection.getParsedTransaction(paymentSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!tx || !tx.meta) {
      return NextResponse.json({ error: 'Could not retrieve confirmed listing fee transaction. Please try again.' }, { status: 400 });
    }

    if (tx.meta.err) {
      return NextResponse.json({ error: 'Listing fee transaction failed on-chain.' }, { status: 400 });
    }

    const expectedLamports = Math.round(LISTING_FEE_SOL * LAMPORTS_PER_SOL);
    let feePaid = false;

    for (const inst of tx.transaction.message.instructions) {
      if ('parsed' in inst && inst.program === 'system' && inst.parsed.type === 'transfer') {
        const { destination, lamports, source } = inst.parsed.info;
        if (source === userWallet && destination === PLATFORM_FEE_WALLET && lamports === expectedLamports) {
          feePaid = true;
          break;
        }
      }
    }

    if (!feePaid) {
      return NextResponse.json(
        { error: `Listing fee not received. Expected ${LISTING_FEE_SOL} SOL from ${userWallet} to platform wallet.` },
        { status: 400 }
      );
    }

    // 3. Decrypt master_payload to validate the key matches result_address.
    // Server-side integrity check — no raw key leaves the server.
    const keysEnv = process.env.MASTER_KEYS || `v1:${process.env.MASTER_INVENTORY_KEY}`;
    const masterKeyDict = Object.fromEntries(keysEnv.split(',').map(k => k.split(':')));

    const rawPayload = job.master_payload as string;
    let version = 'v1';
    let ciphertextBase64 = rawPayload;
    if (rawPayload.includes(':')) {
      [version, ciphertextBase64] = rawPayload.split(':');
    }

    const masterKeyString = masterKeyDict[version];
    if (!masterKeyString) {
      throw new Error(`CRITICAL: Master key version ${version} not found.`);
    }

    const masterKeyBytes = util.decodeBase64(masterKeyString);
    const encryptedBytes = util.decodeBase64(ciphertextBase64);
    const nonce = encryptedBytes.slice(0, nacl.secretbox.nonceLength);
    const box = encryptedBytes.slice(nacl.secretbox.nonceLength);
    const decryptedBytes = nacl.secretbox.open(box, nonce, masterKeyBytes);

    if (!decryptedBytes) {
      console.error(`[routelist] Failed to decrypt master_payload for job ${jobId}`);
      return NextResponse.json({ error: 'Server-side key validation failed.' }, { status: 500 });
    }

    // 4. Validate the decrypted key matches the stored vanity address
    try {
      const phantomBase58 = util.encodeUTF8(decryptedBytes).replace(/\0/g, '').trim();
      const privateKeyBytes = bs58.decode(phantomBase58);
      const derivedKeypair = Keypair.fromSecretKey(privateKeyBytes);
      const derivedAddress = derivedKeypair.publicKey.toBase58();

      if (derivedAddress !== job.result_address) {
        console.error(`[routelist] Address mismatch for job ${jobId}: derived ${derivedAddress}, expected ${job.result_address}`);
        return NextResponse.json(
          { error: 'Cryptographic validation failed: stored key does not match vanity address.' },
          { status: 500 }
        );
      }
    } catch (validationErr) {
      console.error('[routelist] Key validation error:', validationErr);
      return NextResponse.json({ error: 'Key format invalid during validation.' }, { status: 500 });
    }

    // 5. Move master_payload to escrow_payload — no re-encryption needed.
    // master_payload is already in SecretBox format that routePurchase/routeCancle expect.
    const activeVersion = process.env.ACTIVE_MASTER_KEY || version;
    const safeEscrowPayload = rawPayload.includes(':') ? rawPayload : `${activeVersion}:${rawPayload}`;

    const { error: updateError } = await supabase
      .from('vanity_jobs')
      .update({
        is_listed: true,
        listing_price: priceSol,
        escrow_payload: safeEscrowPayload,
        master_payload: null,              // Clear after moving to escrow
        result_payload: 'MOVED_TO_ESCROW', // Burn client SealedBox while listed
      })
      .eq('id', jobId)
      .eq('customer_wallet', userWallet);

    if (updateError) {
      console.error('[routelist] DB update failed:', updateError);
      return NextResponse.json({ error: 'Failed to update listing status.' }, { status: 500 });
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[routelist] Unexpected error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}