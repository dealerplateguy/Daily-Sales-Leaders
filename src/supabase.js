import { createClient } from '@supabase/supabase-js';

// Public browser client. The publishable key is designed to ship in the bundle;
// all real protection is server-side RLS (only allow-listed authenticated users
// can read the sales tables). Auth is magic-link email.
const SUPABASE_URL = 'https://fsswfdeorzmshgsvtcym.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_sL2lChTvFplQg5irrj3fbw_gXDT2LXP';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
