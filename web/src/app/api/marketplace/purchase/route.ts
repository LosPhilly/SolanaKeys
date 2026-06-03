import { NextResponse } from 'next/server';
import { Connection } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import sealedBox from 'tweetnacl-sealedbox-js';

// Initialize secure Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// Establish connection to Solana
const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';

console.log("BACKEND IS USING THIS RPC URL:", rpcUrl);
const connection = new Connection(rpcUrl, 'confirmed');

// Pull the wallet dynamically from the environment
const EXPECTED_MERCHANT_WALLET = process.env.NEXT_PUBLIC_ADMIN_WALLET;

export async function POST(req: Request) {
  try {
    // 1. Safety Check: Ensure the server environment is configured correctly
    if (!EXPECTED_MERCHANT_WALLET) {
      console.error("Server misconfiguration: NEXT_PUBLIC_ADMIN_WALLET is missing.");
      return NextResponse.json(
        { error: 'Server misconfiguration. Payment verification disabled.' }, 
        { status: 500 }
      );
    }

    if (!process.env.MASTER_INVENTORY_KEY && !process.env.MASTER_KEYS) {
      console.error("CRITICAL: MASTER_INVENTORY_KEY or MASTER_KEYS is missing from .env");
      return NextResponse.json({ error: 'Server encryption misconfiguration.' }, { status: 500 });
    }

    const { signature, userWallet, itemId, clientPubkey, blockhash, lastValidBlockHeight } = await req.json();

    if (!signature || !userWallet || !itemId || !clientPubkey) {
      return NextResponse.json({ error: 'Missing purchase metadata or encryption lock' }, { status: 400 });
    }

    if (!blockhash || !lastValidBlockHeight) {
      return NextResponse.json({ error: 'Missing transaction confirmation parameters (blockhash / lastValidBlockHeight).' }, { status: 400 });
    }

    // 2. Fetch the targeted item to know how much SOL to expect
    const { data: item, error: itemError } = await supabase
      .from('premium_inventory')
      .select('*')
      .eq('id', itemId)
      .single();

    if (itemError || !item) {
      return NextResponse.json({ error: 'Inventory item not found or already sold' }, { status: 404 });
    }

    const expectedLamports = Math.round(item.price_sol * 1_000_000_000);

    // Confirm the transaction using the blockhash window captured at send time.
    console.log(`[routeMarket] Confirming payment tx: ${signature}`);
    try {
      const result = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      if (result.value.err) {
        console.error('[routeMarket] Transaction failed on-chain:', result.value.err);
        return NextResponse.json({ error: 'Payment transaction failed on-chain.' }, { status: 400 });
      }
    } catch (confirmErr: any) {
      console.error('[routeMarket] confirmTransaction error:', confirmErr.message);
      return NextResponse.json({ error: 'Payment transaction could not be confirmed. It may have expired — please try again.' }, { status: 400 });
    }

    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx || tx.meta?.err) {
      return NextResponse.json({ error: 'Could not retrieve confirmed transaction details.' }, { status: 400 });
    }

    // 4. Verify the transfer instruction
    const messageInstructions = tx.transaction.message.instructions;
    let paymentValid = false;

    for (const inst of messageInstructions) {
      if ('parsed' in inst && inst.program === 'system' && inst.parsed.type === 'transfer') {
        const { destination, lamports, source } = inst.parsed.info;

        if (
          destination === EXPECTED_MERCHANT_WALLET &&
          lamports === expectedLamports &&
          source === userWallet
        ) {
          paymentValid = true;
          break;
        }
      }
    }

    if (!paymentValid) {
      return NextResponse.json(
        { error: 'Transaction details do not match the expected payment amount or destination' }, 
        { status: 400 }
      );
    }

    console.log("✅ PAYMENT VERIFIED! Executing Zero-Knowledge Handover...");

    // 5. THE HANDOVER: Decrypt Master Payload and Re-Encrypt for Buyer
    let finalZeroKnowledgePayload = item.encrypted_payload;

    try {
      // Parse the Key Dictionary from the environment
      const keysEnv = process.env.MASTER_KEYS || `v1:${process.env.MASTER_INVENTORY_KEY}`;
      const masterKeyDict = Object.fromEntries(keysEnv.split(',').map(k => k.split(':')));

      const rawPayload = item.encrypted_payload;
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
      const encryptedStockBytes = util.decodeBase64(ciphertextBase64);
      
      // PyNaCl appends the 24-byte nonce to the front of the ciphertext. Split it out.
      const nonce = encryptedStockBytes.slice(0, nacl.secretbox.nonceLength);
      const ciphertext = encryptedStockBytes.slice(nacl.secretbox.nonceLength);
      
      const decryptedBytes = nacl.secretbox.open(ciphertext, nonce, masterKeyBytes);
      if (!decryptedBytes) throw new Error(`Master decryption sequence failed to open box for version ${version}`);

      // Re-Encrypt for the Buyer's local Vault
      const clientPublicKeyBytes = util.decodeBase64(clientPubkey);
      const sealedForBuyer = sealedBox.seal(decryptedBytes, clientPublicKeyBytes);
      finalZeroKnowledgePayload = util.encodeBase64(sealedForBuyer);
      
      console.log("🔒 E2EE Payload successfully sealed for buyer's browser.");
    } catch (encError) {
      console.error("Cryptographic Handover Failed:", encError);
      return NextResponse.json({ error: 'Failed to securely encrypt key for delivery' }, { status: 500 });
    }

    // 6. Payment is verified & encrypted! Move item from inventory to the user's vault
    const { error: insertError } = await supabase
      .from('vanity_jobs')
      .insert({
        customer_wallet: userWallet,
        prefix: item.pattern_location === 'PREFIX' ? item.matched_pattern : null,
        suffix: item.pattern_location === 'SUFFIX' ? item.matched_pattern : null,
        target_length: item.matched_pattern.length,
        status: 'COMPLETED',
        result_address: item.display_address,
        result_payload: finalZeroKnowledgePayload, // <--- The mathematically sealed key
        payment_signature: signature,
        completed_at: new Date().toISOString()
      });

    if (insertError) {
      console.error('Vault delivery error:', insertError);
      return NextResponse.json({ error: 'Payment verified, but vault delivery failed' }, { status: 500 });
    }

    // 7. THE BURN PROTOCOL: Delete the purchased item from the marketplace inventory permanently
    await supabase.from('premium_inventory').delete().eq('id', itemId);

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Purchase route crashed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}