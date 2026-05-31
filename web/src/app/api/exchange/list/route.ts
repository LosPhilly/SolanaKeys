import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export async function POST(req: Request) {
  try {
    const { jobId, userWallet, rawPrivateKey, priceSol, paymentSignature } = await req.json();

    if (!jobId || !rawPrivateKey || !priceSol) {
      return NextResponse.json({ error: 'Missing listing data' }, { status: 400 });
    }

    // Optional: Add logic here to verify `paymentSignature` on the blockchain 
    // to ensure the listing fee was actually paid before proceeding.

    // 1. Verify the item hasn't been revealed
    const { data: job } = await supabase.from('vanity_jobs').select('*').eq('id', jobId).single();
    if (job.is_revealed) {
      return NextResponse.json({ error: 'Revealed keys cannot be listed.' }, { status: 403 });
    }

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
    
    // Combine nonce and box so it perfectly matches how the purchase route decrypts
    const fullMessage = new Uint8Array(nonce.length + encryptedBox.length);
    fullMessage.set(nonce);
    fullMessage.set(encryptedBox, nonce.length);
    
    // THE FIX: Encode to Base64 and prepend the active version tag!
    const rawEscrowPayload = util.encodeBase64(fullMessage);
    const safeEscrowPayload = `${activeVersion}:${rawEscrowPayload}`;

    // 3. Update the database to push it to the Exchange tab
    await supabase.from('vanity_jobs').update({
      is_listed: true,
      listing_price: priceSol,
      escrow_payload: safeEscrowPayload,
      result_payload: 'MOVED_TO_ESCROW' // Burn the local ZK payload to prevent double-spending
    }).eq('id', jobId).eq('customer_wallet', userWallet);

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Listing error:', error);
    return NextResponse.json({ error: 'Failed to process listing' }, { status: 500 });
  }
}