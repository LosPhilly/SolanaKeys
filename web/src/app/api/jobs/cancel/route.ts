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
    const originalPaymentSol = job.price_sol || 0; // The amount they paid at checkout
    if (originalPaymentSol <= 0) {
        await supabase.from('vanity_jobs').update({ status: 'FAILED', result_payload: 'CANCELLED_NO_REFUND' }).eq('id', jobId);
        return NextResponse.json({ success: true, refundAmount: 0 });
    }

    const elapsedMinutes = (Date.now() - new Date(job.created_at).getTime()) / 60000;
    
    let refundMultiplier = 0.98; // Base case: refund less 2% network fee
    
    // Pro-Rated Protection: If it has been running for over an hour, reduce refund to cover raw server electricity/compute costs.
    if (elapsedMinutes > 60) {
        const hoursRunning = elapsedMinutes / 60;
        refundMultiplier = Math.max(0, 0.98 - (hoursRunning * 0.10)); // Drops 10% per hour running
    }

    const refundAmountSol = originalPaymentSol * refundMultiplier;
    const refundLamports = Math.round(refundAmountSol * LAMPORTS_PER_SOL);

    // 5. Execute On-Chain Refund
    if (refundLamports > 0) {
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: serverKeypair.publicKey,
            toPubkey: new PublicKey(userWallet),
            lamports: refundLamports,
          })
        );

        try {
            const txSignature = await sendAndConfirmTransaction(connection, transaction, [serverKeypair]);
            console.log(`Refund executed: ${txSignature}`);
        } catch (txError) {
            console.error("Solana refund transaction failed:", txError);
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