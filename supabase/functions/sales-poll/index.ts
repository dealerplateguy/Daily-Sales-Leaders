// Supabase Edge Function — sales-poll
//
// Live intraday refresh of the Daily Sales Leaders board. Fires every 30 min
// during business hours (via pg_cron), pulls store sales straight from Snowflake
// (Tekion DMS), and upserts per-rooftop tallies into public.sales_live_tallies.
// Supabase Realtime pushes changes to every open board.
//
// Reconciled to Tekion's Sales Recap (verified 2026-08-13, New tied to the dollar):
//   basis  = CONTRACT DATE (CONTRACT_DATE_SPLIT_YEAR/MONTH/DAY -> a real DATE)
//   status = DEAL_STATUS IN ('BOOKED','CLOSED_OR_SOLD')      (booked-or-beyond)
//   types  = DEAL_TYPE IN ('PERSONAL','BUSINESS','INTERNET','EMPLOYEE_PURCHASE')  (retail)
//   gross  = raw FRONT_GROSS / BACK_GROSS / TOTAL_GROSS
// Two windows in one query: MTD (1st-of-month .. today) and today only.
//
// Auth: caller must send `x-live-poll-token: <LIVE_POLL_TOKEN>` (pg_cron does).
// Reuses the SAME token + verify_live_poll_token RPC as the advisor live-poll.
// Query flags: ?force=1 bypass business-hours gate ; ?dry=1 compute but don't write.
//
// Deploy: supabase functions deploy sales-poll --no-verify-jwt
// Secrets (shared with live-poll): SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_ROLE,
//   SNOWFLAKE_WAREHOUSE, SNOWFLAKE_PUBLIC_KEY_FP, SNOWFLAKE_PRIVATE_KEY, LIVE_POLL_TOKEN.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Config ───────────────────────────────────────────────────────────────
const SF_ACCOUNT   = Deno.env.get('SNOWFLAKE_ACCOUNT')!;
const SF_USER      = Deno.env.get('SNOWFLAKE_USER')!;
const SF_ROLE      = Deno.env.get('SNOWFLAKE_ROLE') || 'FIXEDOPS_READONLY';
const SF_WAREHOUSE = Deno.env.get('SNOWFLAKE_WAREHOUSE') || 'COMPUTE_WH';
const SF_FP        = Deno.env.get('SNOWFLAKE_PUBLIC_KEY_FP')!;
const SF_PRIVATE_KEY = Deno.env.get('SNOWFLAKE_PRIVATE_KEY')!;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SF_HOST = `${SF_ACCOUNT}.snowflakecomputing.com`;
const SF_DATABASE = 'TEKION_SOURCE';
const SF_SCHEMA = 'PUBLIC';

// The 19 group rooftops (same list as the Rohr50 board). name + region for display.
// Region is coarse (illinois / indiana) to match how Tekion groups the Recap; the
// board ranks group-wide, region is stored for a future filter.
const STORES: Record<string, { name: string; region: string }> = {
  '1701': { name: 'Arlington Acura',            region: 'illinois' },
  '1702': { name: 'Arlington Nissan',           region: 'illinois' },
  '1703': { name: 'Lexus of Arlington',         region: 'illinois' },
  '1704': { name: 'Gurnee Hyundai',             region: 'illinois' },
  '1705': { name: 'Gurnee Volkswagen',          region: 'illinois' },
  '1706': { name: 'Kenosha Nissan',             region: 'illinois' },
  '1707': { name: 'Schaumburg Honda',           region: 'illinois' },
  '1708': { name: 'Schaumburg Ford',            region: 'illinois' },
  '1710': { name: 'Bob Rohrman Schaumburg Kia', region: 'illinois' },
  '1711': { name: 'Oakbrook Toyota',            region: 'illinois' },
  '1712': { name: 'Bob Rohrman Honda',          region: 'indiana' },
  '1713': { name: 'Rohrman Toyota',             region: 'indiana' },
  '1714': { name: 'Bob Rohrman Kia',            region: 'indiana' },
  '1715': { name: 'Bob Rohrman Hyundai Genesis', region: 'indiana' },
  '1717': { name: 'Indy Honda',                 region: 'indiana' },
  '1718': { name: 'Bob Rohrman Indy Hyundai',   region: 'indiana' },
  '1719': { name: 'Fort Wayne Toyota Lexus',    region: 'indiana' },
  '1720': { name: 'Fort Wayne Kia',             region: 'indiana' },
  '1722': { name: 'Fort Wayne Nissan',          region: 'indiana' },
};
const STORE_IDS = Object.keys(STORES);

const RETAIL_TYPES = ['PERSONAL', 'BUSINESS', 'INTERNET', 'EMPLOYEE_PURCHASE'];
const SOLD_STATUSES = ['BOOKED', 'CLOSED_OR_SOLD'];

// Business hours gate (ET, DST-aware). Match the advisor board cadence: Mon-Sat,
// a 7am rollover touch + the 10:00-22:00 active band. Sales runs later, but this
// mirrors the existing cron; widen later if evening deals need to land sooner.
const BIZ_TZ = 'America/New_York';
const ROLL_START_MIN = 7 * 60;
const ROLL_END_MIN = 7 * 60 + 9;
const DAY_START_MIN = 8 * 60;    // sales floors open earlier than the service lane
const DAY_END_MIN = 22 * 60;

function inList(vals: string[]): string {
  return '(' + vals.map((v) => `'${v.replace(/'/g, "''")}'`).join(',') + ')';
}

// ── ET clock helpers ─────────────────────────────────────────────────────
function etParts(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: BIZ_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit',
    hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value || '';
  const hour = parseInt(get('hour'), 10) % 24;
  return {
    weekday: get('weekday'), hour, minute: parseInt(get('minute'), 10),
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  };
}
function isBusinessHours(et: ReturnType<typeof etParts>): boolean {
  if (et.weekday === 'Sun') return false;
  const mins = et.hour * 60 + et.minute;
  if (mins >= ROLL_START_MIN && mins <= ROLL_END_MIN) return true;
  return mins >= DAY_START_MIN && mins <= DAY_END_MIN;
}
function periodBounds(dateStr: string) {
  const [y, m] = dateStr.split('-');
  return { mtdStart: `${y}-${m}-01`, periodKey: `${y}-${m}` };
}

// ── Snowflake key-pair JWT (RS256 via Web Crypto) ────────────────────────
function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str: string): string { return b64url(new TextEncoder().encode(str)); }

let cachedKey: CryptoKey | null = null;
async function getSigningKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'pkcs8', pemToDer(SF_PRIVATE_KEY) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  return cachedKey;
}
async function makeJwt(): Promise<string> {
  const account = SF_ACCOUNT.toUpperCase();
  const user = SF_USER.toUpperCase();
  const qualified = `${account}.${user}`;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: `${qualified}.${SF_FP}`, sub: qualified, iat: now, exp: now + 3540 };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', await getSigningKey(), new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

async function sfQuery(jwt: string, statement: string): Promise<string[][]> {
  const res = await fetch(`https://${SF_HOST}/api/v2/statements`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
      'Content-Type': 'application/json', 'Accept': 'application/json',
    },
    body: JSON.stringify({ statement, timeout: 60, database: SF_DATABASE, schema: SF_SCHEMA, warehouse: SF_WAREHOUSE, role: SF_ROLE }),
  });
  if (res.status === 200) return ((await res.json()).data || []) as string[][];
  if (res.status === 202) {
    const handle = (await res.json()).statementHandle;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const pr = await fetch(`https://${SF_HOST}/api/v2/statements/${handle}`, {
        headers: { 'Authorization': `Bearer ${jwt}`, 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT', 'Accept': 'application/json' },
      });
      if (pr.status === 200) return ((await pr.json()).data || []) as string[][];
      if (pr.status !== 202) throw new Error(`Snowflake poll failed ${pr.status}: ${await pr.text()}`);
    }
    throw new Error('Snowflake statement did not complete in time');
  }
  throw new Error(`Snowflake query failed ${res.status}: ${await res.text()}`);
}

// ── Sales tally query (MTD + today in one pass) ──────────────────────────
// One row per dealer_id × vehicle_type: MTD counts/gross + today counts/gross.
function salesSql(mtdStart: string, today: string): string {
  const CDATE =
    `TRY_TO_DATE(d.CONTRACT_DATE_SPLIT_YEAR||'-'||LPAD(d.CONTRACT_DATE_SPLIT_MONTH,2,'0')||'-'||LPAD(d.CONTRACT_DATE_SPLIT_DAY,2,'0'))`;
  return `
    WITH deals AS (
      SELECT d.DEALER_ID, d.VEHICLE_TYPE, ${CDATE} AS CDATE,
             f.FRONT_GROSS, f.BACK_GROSS, f.TOTAL_GROSS
      FROM TEKION_SOURCE.PUBLIC.DEAL_DETAILS_DIM d
      JOIN TEKION_SOURCE.PUBLIC.DEAL_FACT f
        ON d.DEAL_ID = f.DEAL_ID AND d.DEALER_ID = f.DEALER_ID
      WHERE d.DEALER_ID IN ${inList(STORE_IDS)}
        AND COALESCE(d.DELETED,FALSE)=FALSE
        AND d.DEAL_STATUS IN ${inList(SOLD_STATUSES)}
        AND d.DEAL_TYPE   IN ${inList(RETAIL_TYPES)}
        AND d.VEHICLE_TYPE IN ('NEW','USED')
        AND ${CDATE} BETWEEN '${mtdStart}' AND '${today}'
    )
    SELECT DEALER_ID, VEHICLE_TYPE,
      COUNT(*)                                                        AS MTD_UNITS,
      COALESCE(SUM(FRONT_GROSS),0)                                    AS MTD_FRONT,
      COALESCE(SUM(BACK_GROSS),0)                                     AS MTD_BACK,
      COALESCE(SUM(TOTAL_GROSS),0)                                    AS MTD_TOTAL,
      COUNT(CASE WHEN CDATE = '${today}' THEN 1 END)                  AS TODAY_UNITS,
      COALESCE(SUM(CASE WHEN CDATE = '${today}' THEN FRONT_GROSS END),0) AS TODAY_FRONT,
      COALESCE(SUM(CASE WHEN CDATE = '${today}' THEN BACK_GROSS  END),0) AS TODAY_BACK,
      COALESCE(SUM(CASE WHEN CDATE = '${today}' THEN TOTAL_GROSS END),0) AS TODAY_TOTAL
    FROM deals GROUP BY 1,2`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const n = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;

Deno.serve(async (req) => {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Auth: same Vault-stored token + RPC as the advisor live-poll.
  const token = req.headers.get('x-live-poll-token') || '';
  const { data: tokenOk, error: tokErr } = await db.rpc('verify_live_poll_token', { t: token });
  if (tokErr) return json({ error: 'auth check failed' }, 500);
  if (!tokenOk) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const dry = url.searchParams.get('dry') === '1';

  const et = etParts();
  if (!force && !isBusinessHours(et)) return json({ ok: true, skipped: 'outside business hours', et });

  const { mtdStart, periodKey } = periodBounds(et.dateStr);
  const today = et.dateStr;

  try {
    const jwt = await makeJwt();
    const raw = await sfQuery(jwt, salesSql(mtdStart, today));

    // Fold dealer × vehicle_type rows into one row per store.
    const byStore = new Map<string, Record<string, number>>();
    const blank = () => ({
      mtd_new_units: 0, mtd_new_front: 0, mtd_new_back: 0, mtd_new_total: 0,
      mtd_used_units: 0, mtd_used_front: 0, mtd_used_back: 0, mtd_used_total: 0,
      today_new_units: 0, today_new_front: 0, today_new_back: 0, today_new_total: 0,
      today_used_units: 0, today_used_front: 0, today_used_back: 0, today_used_total: 0,
    });
    for (const [dealer, vt, mu, mf, mb, mt, tu, tf, tb, tt] of raw) {
      if (!STORES[dealer]) continue;
      if (!byStore.has(dealer)) byStore.set(dealer, blank());
      const s = byStore.get(dealer)!;
      const k = vt === 'NEW' ? 'new' : 'used';
      s[`mtd_${k}_units`] = Number(mu) || 0;
      s[`mtd_${k}_front`] = n(mf); s[`mtd_${k}_back`] = n(mb); s[`mtd_${k}_total`] = n(mt);
      s[`today_${k}_units`] = Number(tu) || 0;
      s[`today_${k}_front`] = n(tf); s[`today_${k}_back`] = n(tb); s[`today_${k}_total`] = n(tt);
    }

    const nowIso = new Date().toISOString();
    // Every store gets a row (zeros if no deals), so the board shows the full field.
    const rows = STORE_IDS.map((dealer) => ({
      dealer_id: dealer,
      store_name: STORES[dealer].name,
      region: STORES[dealer].region,
      period_key: periodKey,
      board_date: today,
      ...(byStore.get(dealer) || blank()),
      updated_at: nowIso,
    }));

    if (dry) return json({ ok: true, dry: true, et, periodKey, count: rows.length, sample: rows.slice(0, 5) });

    // Upsert only changed rows (keeps Realtime cheap).
    const { data: prev } = await db.from('sales_live_tallies').select('*');
    const prevByDealer = new Map<string, Record<string, unknown>>();
    for (const p of prev || []) prevByDealer.set(p.dealer_id, p);
    const NUMERIC_COLS = Object.keys(blank());
    const changed = rows.filter((r) => {
      const p = prevByDealer.get(r.dealer_id);
      if (!p) return true;
      return NUMERIC_COLS.some((c) => Number((p as Record<string, unknown>)[c]) !== Number((r as Record<string, unknown>)[c]));
    });
    if (changed.length > 0) {
      const { error: upErr } = await db.from('sales_live_tallies').upsert(changed, { onConflict: 'dealer_id' });
      if (upErr) throw upErr;
    }

    await db.from('sales_live_meta').upsert({
      id: 1, last_poll_at: nowIso, last_poll_status: 'ok',
      period_key: periodKey, board_date: today, rows_changed: changed.length, note: null, updated_at: nowIso,
    }, { onConflict: 'id' });

    return json({ ok: true, et, periodKey, field: rows.length, changed: changed.length });
  } catch (err) {
    const msg = (err as Error).message || 'error';
    try {
      await db.from('sales_live_meta').upsert({
        id: 1, last_poll_at: new Date().toISOString(),
        last_poll_status: `error: ${msg}`.slice(0, 300), updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    } catch { /* ignore */ }
    return json({ error: msg }, 500);
  }
});
