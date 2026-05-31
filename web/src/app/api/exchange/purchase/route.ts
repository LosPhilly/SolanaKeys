import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import sealedBox from 'tweetnacl-sealedbox-js';
import { Connection } from '@solana/web3.js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

// Explicitly set connection commitment to 'confirmed'
const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

export async function POST(req: Request) {
  try {
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
    
    // Demand the 'confirmed' version of the transaction so it doesn't wait 30 seconds for 'finalized'
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    if (!tx || !tx.meta) {
      return NextResponse.json({ error: 'Transaction not found or unconfirmed' }, { status: 400 });
    }

    if (tx.meta.err) {
      return NextResponse.json({ error: 'Transaction failed on-chain' }, { status: 400 });
    }

    // 3. THE HANDOVER: Decrypt Master Payload and Re-Encrypt for Buyer
    
    // Parse the Key Dictionary from the environment
    const keysEnv = process.env.MASTER_KEYS || `v1:${process.env.MASTER_INVENTORY_KEY}`;
    const masterKeyDict = Object.fromEntries(keysEnv.split(',').map(k => k.split(':')));

    const rawPayload = job.escrow_payload;
    let version = 'v1';
    let ciphertextBase64 = rawPayload;

    // Check if this payload was encrypted using the new versioning system
    if (rawPayload.includes(':')) {
      [version, ciphertextBase64] = rawPayload.split(':');
    }

    const masterKeyString = masterKeyDict[version];
    if (!masterKeyString) {
      throw new Error(`CRITICAL: Missing historical master key for version ${version}`);
    }

    // Proceed with decryption using the mathematically correct historical key
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
      customer_wallet: buyerWallet, // Transfer ownership!
      is_listed: false,
      listing_price: 0,
      escrow_payload: null,
      result_payload: safeEncryptedPayload // Give them the newly encrypted key
    }).eq('id', itemId);

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Purchase error:', error);
    return NextResponse.json({ error: 'Failed to complete P2P handover' }, { status: 500 });
  }
}