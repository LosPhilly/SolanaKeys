import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import bs58 from 'bs58';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

// The wallet that collects the listing fees
const PLATFORM_FEE_WALLET = process.env.NEXT_PUBLIC_ADMIN_WALLET;
// The required fee to list an item on the exchange
const LISTING_FEE_SOL = 0.025; 

export async function POST(req: Request) {
  try {
    if (!PLATFORM_FEE_WALLET) {
      return NextResponse.json({ error: 'Server misconfiguration: Missing Admin Wallet.' }, { status: 500 });
    }

    const { jobId, userWallet, rawPrivateKey, priceSol, paymentSignature } = await req.json();

    // Now we explicitly require the paymentSignature
    if (!jobId || !rawPrivateKey || !priceSol || !userWallet || !paymentSignature) {
      return NextResponse.json({ error: 'Missing listing data or payment signature' }, { status: 400 });
    }

    // 1. Fetch the job and ensure it exists and has not been compromised/revealed
    const { data: job, error: jobError } = await supabase
      .from('vanity_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Vanity job record not found.' }, { status: 404 });
    }

    if (job.is_revealed) {
      return NextResponse.json({ error: 'Revealed keys cannot be listed.' }, { status: 403 });
    }

    if (job.customer_wallet !== userWallet) {
      return NextResponse.json({ error: 'Unauthorized: Wallet mismatch.' }, { status: 401 });
    }

    // --- NEW: VERIFY THE LISTING FEE PAYMENT ON-CHAIN ---
    console.log("Waiting 5 seconds for Solana RPC to sync the listing fee transaction...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const tx = await connection.getParsedTransaction(paymentSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    if (!tx || !tx.meta) {
      return NextResponse.json({ error: 'Listing fee transaction not found or unconfirmed' }, { status: 400 });
    }

    if (tx.meta.err) {
      return NextResponse.json({ error: 'Listing fee transaction failed on-chain' }, { status: 400 });
    }

    const expectedLamports = Math.round(LISTING_FEE_SOL * LAMPORTS_PER_SOL);
    let feePaid = false;

    for (const inst of tx.transaction.message.instructions) {
      if ('parsed' in inst && inst.program === 'system' && inst.parsed.type === 'transfer') {
        const { destination, lamports, source } = inst.parsed.info;

        if (
          source === userWallet && 
          destination === PLATFORM_FEE_WALLET && 
          lamports === expectedLamports
        ) {
          feePaid = true;
          break;
        }
      }
    }

    if (!feePaid) {
      console.error("Listing fee verification failed.");
      return NextResponse.json({ error: `Fraud detected: Did not receive the ${LISTING_FEE_SOL} SOL listing fee.` }, { status: 400 });
    }
    // ----------------------------------------------------

    // --- CRYPTOGRAPHIC GUARD: Prevent Dud Key Uploads ---
    try {
      let privateKeyBytes: Uint8Array;

      if (rawPrivateKey.trim().startsWith('[')) {
        privateKeyBytes = new Uint8Array(JSON.parse(rawPrivateKey));
      } else {
        privateKeyBytes = bs58.decode(rawPrivateKey);
      }

      const derivedKeypair = Keypair.fromSecretKey(privateKeyBytes);
      const derivedAddress = derivedKeypair.publicKey.toBase58();

      if (derivedAddress !== job.result_address) {
        console.error(`Fraud Attempt Detected: Derived address ${derivedAddress} matches neither expected index ${job.result_address}`);
        return NextResponse.json({ error: 'Cryptographic validation failed: Private key does not match this vanity address.' }, { status: 400 });
      }
    } catch (cryptoErr) {
      console.error('Failed to parse or validate private key signature:', cryptoErr);
      return NextResponse.json({ error: 'Invalid private key data format submitted.' }, { status: 400 });
    }
    // --------------------------------------------------------

    // 2. Encrypt the raw key with the Server's ACTIVE Master Inventory Key for Escrow
    const keysEnv = process.env.MASTER_KEYS || `v1:${process.env.MASTER_INVENTORY_KEY}`;
    const activeVersion = process.env.ACTIVE_MASTER_KEY || 'v1';
    const masterKeyDict = Object.fromEntries(keysEnv.split(',').map(k => k.split(':')));

    const activeMasterKeyString = masterKeyDict[activeVersion];
    if (!activeMasterKeyString) {
      throw new Error(`CRITICAL: Active master key version ${activeVersion} not found in dictionary.`);
    }

    const masterKeyBytes = util.decodeBase64(activeMasterKeyString);
    const messageBytes = util.decodeUTF8(rawPrivateKey);
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    
    const encryptedBox = nacl.secretbox(messageBytes, nonce, masterKeyBytes);
    if (!encryptedBox) throw new Error('Escrow encryption process aborted: Encryption step failed.');
    
    // Combine nonce and box so it perfectly matches how the purchase route decrypts
    const fullMessage = new Uint8Array(nonce.length + encryptedBox.length);
    fullMessage.set(nonce);
    fullMessage.set(encryptedBox, nonce.length);
    
    const rawEscrowPayload = util.encodeBase64(fullMessage);
    const safeEscrowPayload = `${activeVersion}:${rawEscrowPayload}`;

    // 3. Update the database to push it to the Exchange tab
    const { error: updateError } = await supabase
      .from('vanity_jobs')
      .update({
        is_listed: true,
        listing_price: priceSol,
        escrow_payload: safeEscrowPayload,
        result_payload: 'MOVED_TO_ESCROW' // Burn the client-side ZK payload to permanently disable local wallet spending/double listings
      })
      .eq('id', jobId)
      .eq('customer_wallet', userWallet);

    if (updateError) {
      console.error('Database listing execution update failure:', updateError);
      return NextResponse.json({ error: 'Failed to synchronize listing status to the database.' }, { status: 500 });
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Listing route system error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}