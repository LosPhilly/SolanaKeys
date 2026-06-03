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
      console.error('Server misconfiguration: NEXT_PUBLIC_ADMIN_WALLET is missing.');
      return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 });
    }

    const {
      signature, userWallet, prefix, suffix, priceSol,
      clientPubkey, isSuperUserMode, blockhash, lastValidBlockHeight
    } = await req.json();

    if (!signature || !userWallet || (!prefix && !suffix) || priceSol === undefined) {
      return NextResponse.json({ error: 'Missing mandatory fields (Requires Signature, Wallet, Price, and Target)' }, { status: 400 });
    }

    if (!clientPubkey) {
      return NextResponse.json({ error: 'Missing Zero-Knowledge Encryption Lock' }, { status: 400 });
    }

    if (!blockhash || !lastValidBlockHeight) {
      return NextResponse.json({ error: 'Missing transaction confirmation parameters (blockhash / lastValidBlockHeight).' }, { status: 400 });
    }

    // --- HARD SERVER-SIDE VALIDATION & INPUT SANITIZATION ---
    const cleanPrefix = (prefix || '').replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    const cleanSuffix = (suffix || '').replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    const combinedLength = cleanPrefix.length + cleanSuffix.length;

    if (combinedLength === 0) {
      return NextResponse.json({ error: 'Valid matching target length cannot be 0.' }, { status: 400 });
    }

    if (combinedLength > 5 && !isSuperUserMode) {
      return NextResponse.json({
        error: `Requested search parameters (${combinedLength} chars) exceed the standard 5-character limit. Please enable Super Search mode to scale compute hardware.`
      }, { status: 400 });
    }

    if (isSuperUserMode && combinedLength > 10) {
      return NextResponse.json({
        error: `Search phrase pattern (${combinedLength} chars) exceeds absolute limits for a 24-hour search window.`
      }, { status: 400 });
    }
    // ---------------------------------------------------------

    // DUPLICATE JOB GUARD — check server-side before payment is accepted into the queue.
    // Prevents double-click or rapid retry from creating two paid jobs simultaneously.
    // Note: GeneratorView also checks this client-side, but the server is the real gate.
    const { data: activeJobs, error: activeCheckError } = await supabase
      .from('vanity_jobs')
      .select('id, status, prefix, suffix')
      .eq('customer_wallet', userWallet)
      .in('status', ['PENDING', 'STARTING', 'PROCESSING'])
      .limit(1);

    if (!activeCheckError && activeJobs && activeJobs.length > 0) {
      const existing = activeJobs[0];
      const pattern = [existing.prefix, existing.suffix].filter(Boolean).join('...');
      console.warn(`[routeSearch] Duplicate job blocked for wallet ${userWallet} — existing job ${existing.id} (${existing.status})`);
      return NextResponse.json({
        error: `You already have an active generation job running (${pattern || 'Custom'}). Please wait for it to complete or cancel it before starting a new one.`
      }, { status: 409 });
    }

    // Also guard against signature replay — reject if this exact tx was already used
    const { data: sigCheck } = await supabase
      .from('vanity_jobs')
      .select('id')
      .eq('payment_signature', signature)
      .limit(1);

    if (sigCheck && sigCheck.length > 0) {
      console.warn(`[routeSearch] Replayed payment signature blocked: ${signature}`);
      return NextResponse.json({ error: 'This payment signature has already been used.' }, { status: 409 });
    }

    // --- CONFIRM PAYMENT ON-CHAIN ---
    console.log(`[routeSearch] Confirming payment tx: ${signature}`);
    try {
      const result = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      if (result.value.err) {
        console.error('[routeSearch] Transaction failed on-chain:', result.value.err);
        return NextResponse.json({ error: 'Payment transaction failed on-chain.' }, { status: 400 });
      }
    } catch (confirmErr: any) {
      console.error('[routeSearch] confirmTransaction error:', confirmErr.message);
      return NextResponse.json({ error: 'Payment transaction could not be confirmed. It may have expired — please try again.' }, { status: 400 });
    }

    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx || tx.meta?.err) {
      return NextResponse.json({ error: 'Could not retrieve confirmed transaction details.' }, { status: 400 });
    }
    // --------------------------------

    const expectedLamports = Math.round(priceSol * 1_000_000_000);
    let paymentValid = false;

    for (const inst of tx.transaction.message.instructions) {
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
      return NextResponse.json({ error: 'Payment details audit mismatch.' }, { status: 400 });
    }

    console.log(`[routeSearch] Payment verified. Routing to GPU cluster [Super Search: ${!!isSuperUserMode}]`);

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
        price_sol: priceSol,
        price_paid: priceSol,
        result_payload: isSuperUserMode ? 'SUPER_SEARCH_PENDING' : null,
        created_at: new Date().toISOString()
      });

    if (insertError) {
      console.error('[routeSearch] Queue insertion error:', insertError);
      return NextResponse.json({ error: 'Payment approved, but job queue registration failed.' }, { status: 500 });
    }

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('[routeSearch] Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server processing crash' }, { status: 500 });
  }
}
