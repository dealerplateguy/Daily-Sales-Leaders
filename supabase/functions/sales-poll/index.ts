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
// Writes ONE row per (store, day) into public.sales_daily for the whole window, so the
// board can show Yesterday / Today / any picked day / MTD (summed client-side).
//
// Auth: caller must send `x-live-poll-token: <LIVE_POLL_TOKEN>` (pg_cron does).
// Reuses the SAME token + verify_live_poll_token RPC as the advisor live-poll.
// Query flags: ?force=1 bypass business-hours gate ; ?dry=1 compute but don't write ;
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD  override the window (backfill past months).
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

// Counted sale types. HOUSE ("house deals") is included: Tekion counts house deals
// in BOTH the Sales Recap and the daily Deals report. Verified 2026-08-14 — adding
// HOUSE makes Indiana Aug 11-12 tie to the Recap on New AND Used to the exact dollar
// (New 42/$137,141, Used 44/$117,283) and matches the daily per-store counts
// (Schaumburg Kia 7, Schaumburg Honda 13, FW Kia 10). Still excludes WHOLESALE,
// DEALER_TRADE, FLEET, ONLY_FINANCE_AND_INSURANCE, ONLY_TRADES (not retail units).
const RETAIL_TYPES = ['PERSONAL', 'BUSINESS', 'INTERNET', 'EMPLOYEE_PURCHASE', 'HOUSE'];
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

// ── Sales query: one row per store × vehicle_type × DAY over [start,end] ──
function salesSql(start: string, end: string): string {
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
        AND ${CDATE} BETWEEN '${start}' AND '${end}'
    )
    SELECT DEALER_ID, TO_CHAR(CDATE,'YYYY-MM-DD') AS D, VEHICLE_TYPE,
      COUNT(*)                      AS UNITS,
      COALESCE(SUM(FRONT_GROSS),0)  AS FRONT,
      COALESCE(SUM(BACK_GROSS),0)   AS BACK,
      COALESCE(SUM(TOTAL_GROSS),0)  AS TOTAL
    FROM deals
    WHERE CDATE IS NOT NULL
    GROUP BY 1,2,3`;
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
  // Default window = this month to date; ?start&?end override it (backfill).
  const start = url.searchParams.get('start') || mtdStart;
  const end = url.searchParams.get('end') || et.dateStr;

  try {
    const jwt = await makeJwt();
    const raw = await sfQuery(jwt, salesSql(start, end));

    // Fold (dealer × day × vehicle_type) rows into one row per (dealer, day).
    const blank = () => ({
      new_units: 0, new_front: 0, new_back: 0, new_total: 0,
      used_units: 0, used_front: 0, used_back: 0, used_total: 0,
    });
    const byKey = new Map<string, Record<string, unknown>>();
    for (const [dealer, day, vt, units, front, back, total] of raw) {
      if (!STORES[dealer]) continue;
      const key = `${dealer}|${day}`;
      let s = byKey.get(key);
      if (!s) {
        s = { dealer_id: dealer, sale_date: day, store_name: STORES[dealer].name, region: STORES[dealer].region, ...blank() };
        byKey.set(key, s);
      }
      const k = vt === 'NEW' ? 'new' : 'used';
      s[`${k}_units`] = Number(units) || 0;
      s[`${k}_front`] = n(front); s[`${k}_back`] = n(back); s[`${k}_total`] = n(total);
    }

    const nowIso = new Date().toISOString();
    const rows = [...byKey.values()].map((s) => ({ ...s, updated_at: nowIso }));

    if (dry) return json({ ok: true, dry: true, et, start, end, rows: rows.length, sample: rows.slice(0, 6) });

    // Upsert only changed (dealer, day) rows in the window (keeps Realtime cheap).
    const { data: prev } = await db.from('sales_daily').select('*').gte('sale_date', start).lte('sale_date', end);
    const prevByKey = new Map<string, Record<string, unknown>>();
    for (const p of prev || []) prevByKey.set(`${p.dealer_id}|${p.sale_date}`, p);
    const NUM = ['new_units', 'new_front', 'new_back', 'new_total', 'used_units', 'used_front', 'used_back', 'used_total'];
    const changed = rows.filter((r) => {
      const p = prevByKey.get(`${r.dealer_id}|${r.sale_date}`);
      if (!p) return true;
      return NUM.some((c) => Number(p[c]) !== Number((r as Record<string, unknown>)[c]));
    });
    // Rows in the DB window that Snowflake no longer returns are UNWOUND
    // days: every deal that made the row got deleted or lost sold status.
    // Upsert-only left them standing forever, which had sales_daily running
    // ~1% above the source (found reconciling the CEO brief, 2026-08-26:
    // MTD 1424/1293 here vs 1400/1280 in Snowflake, plus a phantom selling
    // day). Delete them so the derived table converges on the truth.
    const gone = [...prevByKey.keys()].filter((k) => !byKey.has(k));
    // Blast-radius guard: a partitioned/truncated Snowflake result once made
    // half the window look "unwound" (2026-08-26, one 3.5-month call). If
    // more than 20% of existing rows would vanish, something is wrong with
    // the RESULT, not the deals - keep the rows and say so.
    if (gone.length > Math.max(5, (prevByKey.size * 0.2))) {
      return json({ ok: false, error: 'refusing_mass_delete', wouldRemove: gone.length, windowRows: prevByKey.size, start, end }, 500);
    }
    for (const k of gone) {
      const [dealer_id, sale_date] = k.split('|');
      const { error: delErr } = await db.from('sales_daily').delete()
        .eq('dealer_id', dealer_id).eq('sale_date', sale_date);
      if (delErr) throw delErr;
    }

    if (changed.length > 0) {
      const { error: upErr } = await db.from('sales_daily').upsert(changed, { onConflict: 'dealer_id,sale_date' });
      if (upErr) throw upErr;
    }

    await db.from('sales_live_meta').upsert({
      id: 1, last_poll_at: nowIso, last_poll_status: 'ok',
      period_key: periodKey, board_date: et.dateStr, rows_changed: changed.length, note: null, updated_at: nowIso,
    }, { onConflict: 'id' });

    return json({ ok: true, et, start, end, storeDays: rows.length, changed: changed.length, removed: gone.length });
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
