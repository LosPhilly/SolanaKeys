import { NextResponse } from 'next/server';
import { Connection } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';

const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(rpcUrl, 'confirmed');

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

export async function POST(req: Request) {
  try {
    const EXPECTED_MERCHANT_WALLET = process.env.NEXT_PUBLIC_ADMIN_WALLET;
    
    if (!EXPECTED_MERCHANT_WALLET) {
      console.error("Server misconfiguration: NEXT_PUBLIC_ADMIN_WALLET is missing.");
      return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 });
    }

    const { signature, userWallet, prefix, suffix, priceSol, clientPubkey, isSuperUserMode } = await req.json();

    if (!signature || !userWallet || (!prefix && !suffix) || priceSol === undefined) {
      return NextResponse.json({ error: 'Missing mandatory fields (Requires Signature, Wallet, Price, and Target)' }, { status: 400 });
    }

    if (!clientPubkey) {
      return NextResponse.json({ error: 'Missing Zero-Knowledge Encryption Lock' }, { status: 400 });
    }

    // --- HARD SERVER-SIDE VALIDATION & INPUT SANITIZATION ---
    // Strict Base58 cleanup to derive accurate compute profiles
    const cleanPrefix = (prefix || '').replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    const cleanSuffix = (suffix || '').replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    const combinedLength = cleanPrefix.length + cleanSuffix.length;

    if (combinedLength === 0) {
      return NextResponse.json({ error: 'Valid matching target length cannot be 0.' }, { status: 400 });
    }

    // Standard Retail Cap check
    if (combinedLength > 5 && !isSuperUserMode) {
      return NextResponse.json({ 
        error: `Requested search parameters (${combinedLength} chars) exceed the standard 5-character limit. Please enable Super Search mode to scale compute hardware.` 
      }, { status: 400 });
    }

    // Absolute Safety Infrastructure Ceiling (Prevents impossible calculations)
    if (isSuperUserMode && combinedLength > 10) {
      return NextResponse.json({ 
        error: `Search phrase pattern (${combinedLength} chars) exceeds absolute limits for a 24-hour search window.` 
      }, { status: 400 });
    }
    // --------------------------------------------------------

    const expectedLamports = Math.round(priceSol * 1_000_000_000);

    console.log(`Verifying GPU Cluster Fee: ${priceSol} SOL...`);
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Initial blockchain propagation wait

    // --- Resilient RPC Retry Loop ---
    let tx = null;
    let retries = 3;
    
    while (retries > 0 && !tx) {
      try {
        console.log(`Fetching transaction from Solana... (${retries} attempts remaining)`);
        tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });
        
        if (tx) break; // Success! Break out of the loop
        
      } catch (rpcError) {
        console.warn(`RPC fetch timed out or failed. Retrying...`);
      }
      
      retries--;
      if (retries > 0) {
        // Wait 2 seconds before trying the RPC again
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    if (!tx || tx.meta?.err) {
      return NextResponse.json({ error: 'Transaction signature not found or failed on-chain after multiple retries.' }, { status: 400 });
    }
    // -------------------------------------

    let paymentValid = false;
    const messageInstructions = tx.transaction.message.instructions;

    for (const inst of messageInstructions) {
      if ('parsed' in inst && inst.program === 'system' && inst.parsed.type === 'transfer') {
        const { destination, lamports, source } = inst.parsed.info;

        if (
          destination === EXPECTED_MERCHANT_WALLET &&
          lamports >= expectedLamports && 
          source === userWallet
        ) {
          paymentValid = true;
          break;
        }
      }
    }

    if (!paymentValid) {
      return NextResponse.json({ error: 'Payment details audit mismatch' }, { status: 400 });
    }

    console.log(`✅ Custom Generation Payment Verified! Routing to GPU Cluster [Super Search: ${!!isSuperUserMode}]`);

    // Write parameters cleanly using existing schemas without schema updates
    const { error: insertError } = await supabase
      .from('vanity_jobs')
      .insert({
        customer_wallet: userWallet,
        prefix: cleanPrefix || null,
        suffix: cleanSuffix || null,
        target_length: combinedLength,
        status: 'PENDING',
        payment_signature: signature,
        client_pubkey: clientPubkey,
        price_sol: priceSol,       // Populates pricing fields for full alignment
        price_paid: priceSol,      
        result_payload: isSuperUserMode ? 'SUPER_SEARCH_PENDING' : null, // Flags workers without schema changes
        created_at: new Date().toISOString()
      });

    if (insertError) {
      console.error('Queue insertion error:', insertError);
      return NextResponse.json({ error: 'Payment approved, but job queue registration failed.' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('System API processing error:', error);
    return NextResponse.json({ error: 'Internal server processing crash' }, { status: 500 });
  }
}