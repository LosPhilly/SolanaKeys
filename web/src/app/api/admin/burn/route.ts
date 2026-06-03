import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

// Tables the burn endpoint is allowed to touch — hard-coded allowlist.
// This prevents a crafted request from deleting from arbitrary tables.
const ALLOWED_TABLES = new Set(['premium_inventory', 'vanity_jobs']);

export async function POST(req: Request) {
  try {
    const { itemId, table, adminWallet, message, signature } = await req.json();

    if (!itemId || !table || !adminWallet || !message || !signature) {
      return NextResponse.json({ error: 'Missing required parameters.' }, { status: 400 });
    }

    // 1. Table allowlist — reject any attempt to burn from unlisted tables
    if (!ALLOWED_TABLES.has(table)) {
      return NextResponse.json({ error: 'Invalid table target.' }, { status: 400 });
    }

    // 2. Verify the claimed wallet is actually the configured admin wallet.
    // NEXT_PUBLIC_ADMIN_WALLET is public, but this check is now backed by
    // cryptographic proof (step 4) rather than being the sole guard.
    const configuredAdminWallet = process.env.NEXT_PUBLIC_ADMIN_WALLET;
    if (!configuredAdminWallet) {
      console.error('NEXT_PUBLIC_ADMIN_WALLET not configured.');
      return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 });
    }

    if (adminWallet !== configuredAdminWallet) {
      return NextResponse.json({ error: 'Unauthorized wallet.' }, { status: 403 });
    }

    // 3. Verify the message commits to exactly this action and this item.
    // This prevents a replayed signature from a different burn action being reused.
    const expectedMessage = `Authenticate to SolanaKeys Admin.\nAction: BURN\nItem ID: ${itemId}\nTable: ${table}`;
    if (message !== expectedMessage) {
      return NextResponse.json({ error: 'Invalid action message.' }, { status: 403 });
    }

    // 4. Cryptographically verify the signature matches the admin wallet.
    // This is the real guard — knowing the wallet address is not enough,
    // the caller must prove they hold the private key by signing the message.
    const signatureUint8 = bs58.decode(signature);
    const messageUint8 = new TextEncoder().encode(message);
    const pubKeyUint8 = new PublicKey(adminWallet).toBytes();

    const isValid = nacl.sign.detached.verify(messageUint8, signatureUint8, pubKeyUint8);
    if (!isValid) {
      console.warn(`[routeAdmin] Invalid signature for wallet ${adminWallet} on item ${itemId}`);
      return NextResponse.json({ error: 'Signature verification failed.' }, { status: 401 });
    }

    // 5. Execute the deletion — double-bind on id to prevent accidental bulk deletes
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('id', itemId);

    if (error) throw error;

    console.log(`[routeAdmin] BURN executed by ${adminWallet}: ${table}/${itemId}`);
    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[routeAdmin] Burn error:', error);
    return NextResponse.json({ error: 'Failed to burn item from database.' }, { status: 500 });
  }
}
