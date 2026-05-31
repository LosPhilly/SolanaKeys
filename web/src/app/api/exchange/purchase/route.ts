import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import sealedBox from 'tweetnacl-sealedbox-js';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

// The wallet where the 5% platform fee should go
const PLATFORM_FEE_WALLET = process.env.NEXT_PUBLIC_ADMIN_WALLET;

export async function POST(req: Request) {
  try {
    if (!PLATFORM_FEE_WALLET) {
      return NextResponse.json({ error: 'Server misconfiguration: Missing Admin Wallet.' }, { status: 500 });
    }

    const { signature, buyerWallet, sellerWallet, itemId, priceSol, clientPubkey } = await req.json();

    if (!signature || !buyerWallet || !itemId || !clientPubkey) {
      return NextResponse.json({ error: 'Missing required purchase data' }, { status: 400 });
    }

    // 1. Verify the Escrow State
    const { data: job, error: jobError } = await supabase
      .from('vanity_jobs')
      .select('*')
      .eq('id', itemId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Listing not found.' }, { status: 404 });
    }

    if (!job.is_listed || job.is_revealed) {
      return NextResponse.json({ error: 'Item is not available for purchase.' }, { status: 400 });
    }

    if (job.customer_wallet !== sellerWallet) {
       return NextResponse.json({ error: 'Seller mismatch.' }, { status: 400 });
    }

    // 2. Cryptographically Verify the Solana Transaction
    console.log("Waiting 5 seconds for Solana RPC to sync the exchange transaction...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Fetch the parsed transaction to read the transfer instructions
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    if (!tx || !tx.meta) {
      return NextResponse.json({ error: 'Transaction not found or unconfirmed' }, { status: 400 });
    }

    if (tx.meta.err) {
      return NextResponse.json({ error: 'Transaction failed on-chain' }, { status: 400 });
    }

    // --- NEW SECURITY CHECK: Verify the 95% Seller Payout and 5% Admin Fee ---
    const totalLamports = Math.round(priceSol * LAMPORTS_PER_SOL);
    const expectedFee = Math.round(totalLamports * 0.05);
    const expectedSellerPayout = totalLamports - expectedFee;

    let sellerPaid = false;
    let feePaid = false;

    const messageInstructions = tx.transaction.message.instructions;

    for (const inst of messageInstructions) {
      if ('parsed' in inst && inst.program === 'system' && inst.parsed.type === 'transfer') {
        const { destination, lamports, source } = inst.parsed.info;

        // Ensure the buyer is the one sending the money
        if (source === buyerWallet) {
          // Check if seller got exactly 95%
          if (destination === sellerWallet && lamports === expectedSellerPayout) {
            sellerPaid = true;
          }
          // Check if admin got exactly 5%
          if (destination === PLATFORM_FEE_WALLET && lamports === expectedFee) {
            feePaid = true;
          }
        }
      }
    }

    if (!sellerPaid || !feePaid) {
      console.error("Payment Verification Failed. Expected transfers missing.");
      return NextResponse.json({ error: 'Fraud detected: Transaction amounts or destinations are invalid.' }, { status: 400 });
    }
    // --------------------------------------------------------------------------

    // 3. THE HANDOVER: Decrypt Master Payload and Re-Encrypt for Buyer
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
      throw new Error(`Master decryption sequence failed to open escrow box for version ${version}`);
    }

    // 4. Re-Encrypt for the Buyer's local Vault
    const clientPublicKeyBytes = util.decodeBase64(clientPubkey);
    const newVaultPayloadBytes = sealedBox.seal(decryptedBytes, clientPublicKeyBytes);
    const safeEncryptedPayload = util.encodeBase64(newVaultPayloadBytes);

    // 5. Transfer Ownership in Database
    await supabase.from('vanity_jobs').update({
      customer_wallet: buyerWallet,
      is_listed: false,
      listing_price: 0,
      escrow_payload: null,
      result_payload: safeEncryptedPayload
    }).eq('id', itemId);

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Purchase error:', error);
    return NextResponse.json({ error: 'Failed to complete P2P handover' }, { status: 500 });
  }
}