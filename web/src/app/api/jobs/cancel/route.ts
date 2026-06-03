import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

export async function POST(req: Request) {
  try {
    const { jobId, userWallet, message, signature } = await req.json();

    if (!jobId || !userWallet || !message || !signature) {
      return NextResponse.json({ error: 'Missing required cancellation parameters' }, { status: 400 });
    }

    // 1. Verify the wallet signature to prevent unauthorized cancellations
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(userWallet);
    const isVerified = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);

    if (!isVerified) {
      return NextResponse.json({ error: 'Invalid cryptographic signature' }, { status: 401 });
    }

    // 2. Fetch Job Details
    const { data: job, error: jobError } = await supabase
      .from('vanity_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.customer_wallet !== userWallet) {
      return NextResponse.json({ error: 'Unauthorized wallet' }, { status: 403 });
    }

    if (job.status === 'COMPLETED' || job.status === 'FAILED') {
      return NextResponse.json({ error: 'Job is already finalized and cannot be cancelled' }, { status: 400 });
    }

    // 3. Define the Server Payout Wallet (Hot Wallet for Refunds)
    const serverPrivateKeyBase58 = process.env.SERVER_PAYOUT_PRIVATE_KEY;
    if (!serverPrivateKeyBase58) {
      console.error("CRITICAL: SERVER_PAYOUT_PRIVATE_KEY missing from environment.");
      return NextResponse.json({ error: 'Server misconfiguration: Cannot process automated refunds.' }, { status: 500 });
    }
    const serverKeypair = Keypair.fromSecretKey(bs58.decode(serverPrivateKeyBase58));

    // 4. Calculate the Refund Amount
    const originalPaymentSol = job.price_sol || 0;
    if (originalPaymentSol <= 0) {
        await supabase.from('vanity_jobs').update({ status: 'FAILED', result_payload: 'CANCELLED_NO_REFUND' }).eq('id', jobId);
        return NextResponse.json({ success: true, refundAmount: 0 });
    }

    const elapsedMinutes = (Date.now() - new Date(job.created_at).getTime()) / 60000;

    // Base: 2% fee covers on-chain transaction costs.
    // Pro-rated: drops 10% per hour of GPU time consumed, floored at 0.
    const hoursRunning = elapsedMinutes / 60;
    const refundMultiplier = Math.max(0, Math.min(0.98, 0.98 - (hoursRunning > 1 ? (hoursRunning - 1) * 0.10 : 0)));

    const refundAmountSol = originalPaymentSol * refundMultiplier;
    // Hard floor: never send less than 5000 lamports (not worth the tx fee)
    const refundLamports = Math.round(refundAmountSol * LAMPORTS_PER_SOL);
    const MIN_REFUND_LAMPORTS = 5000;

    // 5. Balance check before attempting the on-chain refund
    if (refundLamports >= MIN_REFUND_LAMPORTS) {
        const walletBalance = await connection.getBalance(serverKeypair.publicKey);
        // Require balance to cover refund + estimated tx fee (5000 lamports)
        if (walletBalance < refundLamports + 5000) {
            console.error(
                `[routeJobsNew] Refund wallet underfunded. ` +
                `Balance: ${walletBalance} lamports, needed: ${refundLamports + 5000}`
            );
            // Mark cancelled but do not attempt a transaction we know will fail.
            // Support team should manually process the refund.
            await supabase.from('vanity_jobs')
                .update({ status: 'FAILED', result_payload: 'CANCELLED_REFUND_PENDING_MANUAL' })
                .eq('id', jobId);
            return NextResponse.json({
                error: 'Refund wallet temporarily underfunded. Your refund will be processed manually within 24 hours.',
                refundAmount: refundAmountSol
            }, { status: 503 });
        }

        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: serverKeypair.publicKey,
            toPubkey: new PublicKey(userWallet),
            lamports: refundLamports,
          })
        );

        try {
            const txSignature = await sendAndConfirmTransaction(connection, transaction, [serverKeypair]);
            console.log(`[routeJobsNew] Refund of ${refundAmountSol.toFixed(4)} SOL sent to ${userWallet}: ${txSignature}`);
        } catch (txError) {
            console.error("[routeJobsNew] Refund transaction failed:", txError);
            return NextResponse.json({ error: 'Failed to execute on-chain refund' }, { status: 500 });
        }
    }

    // 6. Update Database Status to kill the GPU worker loop
    await supabase.from('vanity_jobs')
      .update({ 
          status: 'FAILED', 
          result_payload: `CANCELLED_REFUNDED_${refundAmountSol.toFixed(4)}_SOL` 
      })
      .eq('id', jobId);

    return NextResponse.json({ success: true, refundAmount: refundAmountSol });

  } catch (error) {
    console.error('Cancellation error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}