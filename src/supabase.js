import { createClient } from '@supabase/supabase-js';

// Public browser client. The publishable key is designed to ship in the bundle;
// all real protection is server-side RLS (only allow-listed authenticated users
// can read the sales tables). Auth is magic-link email.
const SUPABASE_URL = 'https://oseqfvxemajuontjftui.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_hF-BbPDM6NOZ9I0SoDU44A__c0STUW8';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
