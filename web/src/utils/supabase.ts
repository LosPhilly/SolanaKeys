import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// Cache the client in development to prevent memory leaks during hot-reloads
const globalForSupabase = global as unknown as { supabase: ReturnType<typeof createClient> };

export const supabase = globalForSupabase.supabase || createClient(supabaseUrl, supabaseKey);

if (process.env.NODE_ENV !== "production") globalForSupabase.supabase = supabase;