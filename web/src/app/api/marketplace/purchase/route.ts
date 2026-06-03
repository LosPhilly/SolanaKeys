import { NextResponse } from 'next/server';
import { Connection } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import sealedBox from 'tweetnacl-sealedbox-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const connection = new Connection(
  process.env.SERVER_SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);
const EXPECTED_MERCHANT_WALLET = process.env.NEXT_PUBLIC_ADMIN_WALLET;

export async function POST(req: Request) {
  try {
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

    // blockhash/lastValidBlockHeight accepted for client compatibility but not used
    // server-side — confirmTransaction uses WebSocket which 401s on restricted RPC keys.
    const { signature, userWallet, itemId, clientPubkey } = await req.json();

    if (!signature || !userWallet || !itemId || !clientPubkey) {
      return NextResponse.json({ error: 'Missing purchase metadata or encryption lock' }, { status: 400 });
    }

    // 1. Fetch the targeted item to know how much SOL to expect
    const { data: item, error: itemError } = await supabase
      .from('premium_inventory')
      .select('*')
      .eq('id', itemId)
      .single();

    if (itemError || !item) {
      return NextResponse.json({ error: 'Inventory item not found or already sold' }, { status: 404 });
    }

    const expectedLamports = Math.round(item.price_sol * 1_000_000_000);

    // 2. Fetch the confirmed transaction — client already confirmed before POSTing.
    // Skip confirmTransaction (WebSocket, 401s on restricted RPC keys).
    // Retry getParsedTransaction directly over HTTPS instead.
    console.log(`[routeMarket] Fetching confirmed payment tx: ${signature}`);
    let tx = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!tx || tx.meta?.err) {
      return NextResponse.json({ error: 'Could not retrieve confirmed transaction details.' }, { status: 400 });
    }

    // 3. Verify the transfer instruction
    let paymentValid = false;
    for (const inst of tx.transaction.message.instructions) {
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

    // 4. Decrypt master payload and re-encrypt for buyer's vault
    let finalZeroKnowledgePayload = item.encrypted_payload;

    try {
      const keysEnv = process.env.MASTER_KEYS || `v1:${process.env.MASTER_INVENTORY_KEY}`;
      const masterKeyDict = Object.fromEntries(keysEnv.split(',').map(k => k.split(':')));

      const rawPayload = item.encrypted_payload;
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
      const encryptedStockBytes = util.decodeBase64(ciphertextBase64);
      const nonce = encryptedStockBytes.slice(0, nacl.secretbox.nonceLength);
      const ciphertext = encryptedStockBytes.slice(nacl.secretbox.nonceLength);
      const decryptedBytes = nacl.secretbox.open(ciphertext, nonce, masterKeyBytes);

      if (!decryptedBytes) throw new Error(`Master decryption failed for version ${version}`);

      const clientPublicKeyBytes = util.decodeBase64(clientPubkey);
      const sealedForBuyer = sealedBox.seal(decryptedBytes, clientPublicKeyBytes);
      finalZeroKnowledgePayload = util.encodeBase64(sealedForBuyer);

      console.log("🔒 E2EE Payload successfully sealed for buyer's browser.");
    } catch (encError) {
      console.error("Cryptographic Handover Failed:", encError);
      return NextResponse.json({ error: 'Failed to securely encrypt key for delivery' }, { status: 500 });
    }

    // 5. Move item from inventory to the user's vault
    const { error: insertError } = await supabase
      .from('vanity_jobs')
      .insert({
        customer_wallet: userWallet,
        prefix: item.pattern_location === 'PREFIX' ? item.matched_pattern : null,
        suffix: item.pattern_location === 'SUFFIX' ? item.matched_pattern : null,
        target_length: item.matched_pattern.length,
        status: 'COMPLETED',
        result_address: item.display_address,
        result_payload: finalZeroKnowledgePayload,
        payment_signature: signature,
        completed_at: new Date().toISOString()
      });

    if (insertError) {
      console.error('Vault delivery error:', insertError);
      return NextResponse.json({ error: 'Payment verified, but vault delivery failed' }, { status: 500 });
    }

    // 6. Burn the item from marketplace inventory permanently
    await supabase.from('premium_inventory').delete().eq('id', itemId);

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Purchase route crashed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}