// The 19 group rooftops (mirror of the sales-poll edge function's STORES map).
// Kept here so the board always renders the full field, even on days a store had
// no sales (sales_daily only carries non-zero store-days).
export const STORES = [
  { dealer_id: '1701', name: 'Arlington Acura',            region: 'illinois' },
  { dealer_id: '1702', name: 'Arlington Nissan',           region: 'illinois' },
  { dealer_id: '1703', name: 'Lexus of Arlington',         region: 'illinois' },
  { dealer_id: '1704', name: 'Gurnee Hyundai',             region: 'illinois' },
  { dealer_id: '1705', name: 'Gurnee Volkswagen',          region: 'illinois' },
  { dealer_id: '1706', name: 'Kenosha Nissan',             region: 'illinois' },
  { dealer_id: '1707', name: 'Schaumburg Honda',           region: 'illinois' },
  { dealer_id: '1708', name: 'Schaumburg Ford',            region: 'illinois' },
  { dealer_id: '1710', name: 'Bob Rohrman Schaumburg Kia', region: 'illinois' },
  { dealer_id: '1711', name: 'Oakbrook Toyota',            region: 'illinois' },
  { dealer_id: '1712', name: 'Bob Rohrman Honda',          region: 'indiana' },
  { dealer_id: '1713', name: 'Rohrman Toyota',             region: 'indiana' },
  { dealer_id: '1714', name: 'Bob Rohrman Kia',            region: 'indiana' },
  { dealer_id: '1715', name: 'Bob Rohrman Hyundai Genesis', region: 'indiana' },
  { dealer_id: '1717', name: 'Indy Honda',                 region: 'indiana' },
  { dealer_id: '1718', name: 'Bob Rohrman Indy Hyundai',   region: 'indiana' },
  { dealer_id: '1719', name: 'Fort Wayne Toyota Lexus',    region: 'indiana' },
  { dealer_id: '1720', name: 'Fort Wayne Kia',             region: 'indiana' },
  { dealer_id: '1722', name: 'Fort Wayne Nissan',          region: 'indiana' },
];
export const STORE_BY_ID = Object.fromEntries(STORES.map((s) => [s.dealer_id, s]));

// ── ET date helpers (the board_date basis is ET calendar day) ──────────────
export function etToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
export function monthStart(iso) {
  const [y, m] = iso.split('-');
  return `${y}-${m}-01`;
}
// Day of week (0 = Sunday). Stores are CLOSED Sundays.
export function dow(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function isSunday(iso) { return dow(iso) === 0; }
// Previous day the stores were open (skips Sundays).
export function prevBusinessDay(iso) {
  let p = addDays(iso, -1);
  while (isSunday(p)) p = addDays(p, -1);
  return p;
}
export function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  });
}
