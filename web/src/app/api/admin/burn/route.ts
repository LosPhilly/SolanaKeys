import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export async function POST(req: Request) {
  try {
    const { itemId, table, adminWallet, passphrase } = await req.json();

    // 1. Check the wallet address
    if (adminWallet !== process.env.NEXT_PUBLIC_ADMIN_WALLET) {
      return NextResponse.json({ error: 'Unauthorized wallet.' }, { status: 403 });
    }

    // 2. THE VAULT LOCK: Check the strict server passphrase
    if (passphrase !== process.env.ADMIN_PASSPHRASE) {
      return NextResponse.json({ error: 'Invalid admin passphrase.' }, { status: 403 });
    }

    if (!itemId || !table) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    // Execute the deletion
    const { error } = await supabase.from(table).delete().eq('id', itemId);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Admin burn error:', error);
    return NextResponse.json({ error: 'Failed to burn item from database' }, { status: 500 });
  }
}