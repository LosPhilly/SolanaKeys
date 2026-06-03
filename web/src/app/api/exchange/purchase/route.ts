import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import sealedBox from 'tweetnacl-sealedbox-js';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const connection = new Connection(
  process.env.SERVER_SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);

const PLATFORM_FEE_WALLET = process.env.NEXT_PUBLIC_ADMIN_WALLET;

export async function POST(req: Request) {
  try {
    if (!PLATFORM_FEE_WALLET) {
      return NextResponse.json({ error: 'Server misconfiguration: Missing Admin Wallet.' }, { status: 500 });
    }

    // priceSol is intentionally NOT accepted from the client — the price is read
    // from the DB record so a buyer cannot manipulate the verified amount.
    const { signature, buyerWallet, sellerWallet, itemId, clientPubkey, blockhash, lastValidBlockHeight } = await req.json();

    if (!signature || !buyerWallet || !sellerWallet || !itemId || !clientPubkey) {
      return NextResponse.json({ error: 'Missing required purchase data.' }, { status: 400 });
    }

    // blockhash/lastValidBlockHeight accepted but not used server-side —
    // client confirms before POSTing so the window may already be closed.

    // 1. Fetch the listing and verify escrow state
    const { data: job, error: jobError } = await supabase
      .from('vanity_jobs')
      .select('customer_wallet, escrow_payload, is_listed, is_revealed, listing_price')
      .eq('id', itemId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Listing not found.' }, { status: 404 });
    }

    if (!job.is_listed || job.is_revealed) {
      return NextResponse.json({ error: 'Item is not available for purchase.' }, { status: 400 });
    }

    // Validate sellerWallet against the DB record — not the client's claim
    if (job.customer_wallet !== sellerWallet) {
      return NextResponse.json({ error: 'Seller mismatch.' }, { status: 400 });
    }

    // Prevent self-purchase
    if (buyerWallet === sellerWallet) {
      return NextResponse.json({ error: 'Cannot purchase your own listing.' }, { status: 400 });
    }

    // Price is authoritative from the DB — buyer cannot send a lower value
    const priceSol: number = job.listing_price;
    if (!priceSol || priceSol <= 0) {
      return NextResponse.json({ error: 'Invalid listing price.' }, { status: 400 });
    }

    // 2. Fetch the confirmed transaction — the client already confirmed it before POSTing,
    // so we skip server-side confirmTransaction (which can fail if the blockhash window
    // has expired by the time the server processes the request).
    // Retry up to 5 times with 2s intervals to handle RPC propagation delay.
    console.log(`[exchange/purchase] Fetching confirmed purchase tx: ${signature}`);
    let tx = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!tx || !tx.meta) {
      return NextResponse.json({ error: 'Could not retrieve confirmed transaction details. Please try again.' }, { status: 400 });
    }

    if (tx.meta.err) {
      return NextResponse.json({ error: 'Purchase transaction failed on-chain.' }, { status: 400 });
    }

    // 3. Verify the exact split: 95% to seller, 5% platform fee.
    // Amounts derived entirely from DB listing_price — not from anything the client sent.
    const totalLamports = Math.round(priceSol * LAMPORTS_PER_SOL);
    const expectedFee = Math.round(totalLamports * 0.05);
    const expectedSellerPayout = totalLamports - expectedFee;

    let sellerPaid = false;
    let feePaid = false;

    for (const inst of tx.transaction.message.instructions) {
      if ('parsed' in inst && inst.program === 'system' && inst.parsed.type === 'transfer') {
        const { destination, lamports, source } = inst.parsed.info;

        if (source === buyerWallet) {
          if (destination === sellerWallet && lamports === expectedSellerPayout) {
            sellerPaid = true;
          }
          if (destination === PLATFORM_FEE_WALLET && lamports === expectedFee) {
            feePaid = true;
          }
        }
      }
    }

    if (!sellerPaid || !feePaid) {
      console.error(
        `[exchange/purchase] Payment verification failed for ${itemId}. ` +
        `Expected ${expectedSellerPayout} lamports to seller and ${expectedFee} to platform.`
      );
      return NextResponse.json({ error: 'Fraud detected: Transaction amounts or destinations are invalid.' }, { status: 400 });
    }

    // 4. Decrypt escrow payload and re-encrypt for the buyer's vault
    const keysEnv = process.env.MASTER_KEYS || `v1:${process.env.MASTER_INVENTORY_KEY}`;
    const masterKeyDict = Object.fromEntries(keysEnv.split(',').map(k => k.split(':')));

    const rawPayload = job.escrow_payload as string;
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

    const clientPublicKeyBytes = util.decodeBase64(clientPubkey);
    const newVaultPayloadBytes = sealedBox.seal(decryptedBytes, clientPublicKeyBytes);
    const safeEncryptedPayload = util.encodeBase64(newVaultPayloadBytes);

    // 5. Transfer ownership — triple guard prevents race condition where two buyers
    // hit simultaneously: only the first will match all three conditions.
    const { error: updateError } = await supabase
      .from('vanity_jobs')
      .update({
        customer_wallet: buyerWallet,
        is_listed: false,
        listing_price: 0,
        escrow_payload: null,
        result_payload: safeEncryptedPayload,
      })
      .eq('id', itemId)
      .eq('customer_wallet', sellerWallet)
      .eq('is_listed', true);

    if (updateError) {
      console.error('[exchange/purchase] Ownership transfer failed:', updateError);
      return NextResponse.json({ error: 'Failed to transfer ownership.' }, { status: 500 });
    }

    console.log(`[exchange/purchase] Sale complete: ${itemId} from ${sellerWallet} to ${buyerWallet} for ${priceSol} SOL`);
    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[exchange/purchase] Unexpected error:', error);
    return NextResponse.json({ error: 'Failed to complete P2P handover.' }, { status: 500 });
  }
}