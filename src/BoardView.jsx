import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';

const MIN_UNITS_FOR_PVR = 3; // a store needs this many units to rank on a PVR board

// ── formatters ────────────────────────────────────────────────────────────
const usd = (v) => {
  const n = Math.round(Number(v) || 0);
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString();
};
const int = (v) => (Number(v) || 0).toLocaleString();

// Derive a store's numbers for the active window (today|mtd) + segment (all|new|used).
function derive(row, win, seg) {
  const g = (k) => Number(row[`${win}_${k}`]) || 0;
  const pick = (metric) =>
    seg === 'all' ? g(`new_${metric}`) + g(`used_${metric}`) : g(`${seg}_${metric}`);
  const units = pick('units');
  const front = pick('front');
  const back = pick('back');
  const total = pick('total');
  return {
    dealer_id: row.dealer_id, store: row.store_name, region: row.region,
    newUnits: g('new_units'), usedUnits: g('used_units'),
    units, front, back, total,
    frontPVR: units > 0 ? front / units : null,
    backPVR: units > 0 ? back / units : null,
    totalPVR: units > 0 ? total / units : null,
  };
}

// ── leaderboard card ─────────────────────────────────────────────────────
function MiniBoard({ title, rows, valueOf, fmt, note }) {
  const ranked = rows
    .filter((r) => valueOf(r) !== null && valueOf(r) !== undefined)
    .sort((a, b) => valueOf(b) - valueOf(a))
    .slice(0, 5);
  const medal = ['🥇', '🥈', '🥉'];
  return (
    <div className="mini">
      <div className="mini-title">{title}{note && <span className="mini-note">{note}</span>}</div>
      {ranked.length === 0 ? (
        <div className="mini-empty">No sales yet</div>
      ) : (
        <ol className="mini-list">
          {ranked.map((r, i) => (
            <li key={r.dealer_id} className={i === 0 ? 'lead' : ''}>
              <span className="rk">{medal[i] || i + 1}</span>
              <span className="nm">{r.store}</span>
              <span className="vl">{fmt(valueOf(r))}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function BoardView({ email, sampleRows, sampleMeta }) {
  const preview = Array.isArray(sampleRows);
  const [raw, setRaw] = useState(preview ? sampleRows : []);
  const [meta, setMeta] = useState(preview ? sampleMeta : null);
  const [win, setWin] = useState('today');     // today | mtd
  const [seg, setSeg] = useState('all');        // all | new | used
  const [layout, setLayout] = useState('boards'); // boards | table
  const [sort, setSort] = useState({ key: 'units', dir: 'desc' });
  const [loading, setLoading] = useState(!preview);

  async function load() {
    const [{ data: t }, { data: m }] = await Promise.all([
      supabase.from('sales_live_tallies').select('*'),
      supabase.from('sales_live_meta').select('*').eq('id', 1).maybeSingle(),
    ]);
    setRaw(t || []);
    setMeta(m || null);
    setLoading(false);
  }

  useEffect(() => {
    if (preview) return;
    load();
    const ch = supabase
      .channel('sales-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_live_tallies' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [preview]);

  // Default the layout to the table when viewing MTD, boards when viewing Today.
  useEffect(() => { setLayout(win === 'mtd' ? 'table' : 'boards'); }, [win]);

  const stores = useMemo(() => raw.map((r) => derive(r, win, seg)), [raw, win, seg]);

  const totals = useMemo(() => {
    const t = stores.reduce((a, s) => ({
      units: a.units + s.units, front: a.front + s.front, back: a.back + s.back, total: a.total + s.total,
    }), { units: 0, front: 0, back: 0, total: 0 });
    return {
      ...t,
      frontPVR: t.units ? t.front / t.units : null,
      backPVR: t.units ? t.back / t.units : null,
      totalPVR: t.units ? t.total / t.units : null,
    };
  }, [stores]);

  const tableRows = useMemo(() => {
    const withUnits = stores.filter((s) => s.units > 0 || win === 'mtd');
    const dir = sort.dir === 'desc' ? -1 : 1;
    const key = sort.key;
    return [...withUnits].sort((a, b) => {
      const av = a[key] ?? -Infinity, bv = b[key] ?? -Infinity;
      return av === bv ? 0 : (av < bv ? 1 : -1) * dir * -1;
    });
  }, [stores, sort, win]);

  const podium = useMemo(
    () => [...stores].filter((s) => s.units > 0).sort((a, b) => b.total - a.total).slice(0, 3),
    [stores],
  );

  function toggleSort(key) {
    setSort((s) => s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' });
  }

  const lastUpdated = meta?.last_poll_at
    ? new Date(meta.last_poll_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) + ' ET'
    : '—';

  const pvrNote = <span className="floor">≥{MIN_UNITS_FOR_PVR} units</span>;
  const eligiblePVR = stores.filter((s) => s.units >= MIN_UNITS_FOR_PVR);

  return (
    <div className="board">
      <header className="hdr">
        <div className="hdr-l">
          <span className="hdr-logo">📊</span>
          <div>
            <h1>Daily Sales Leaders</h1>
            <div className="hdr-sub">Group-wide · updated {lastUpdated}</div>
          </div>
        </div>
        <div className="hdr-r">
          <span className="who">{email}</span>
          <button className="btn-ghost sm" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>

      <div className="controls">
        <div className="seg">
          <button className={win === 'today' ? 'on' : ''} onClick={() => setWin('today')}>Today</button>
          <button className={win === 'mtd' ? 'on' : ''} onClick={() => setWin('mtd')}>Month to date</button>
        </div>
        <div className="seg">
          <button className={seg === 'all' ? 'on' : ''} onClick={() => setSeg('all')}>All</button>
          <button className={seg === 'new' ? 'on' : ''} onClick={() => setSeg('new')}>New</button>
          <button className={seg === 'used' ? 'on' : ''} onClick={() => setSeg('used')}>Used</button>
        </div>
        <div className="seg push">
          <button className={layout === 'boards' ? 'on' : ''} onClick={() => setLayout('boards')}>Leaders</button>
          <button className={layout === 'table' ? 'on' : ''} onClick={() => setLayout('table')}>Table</button>
        </div>
      </div>

      <div className="summary">
        <b>{int(totals.units)}</b> {seg === 'all' ? 'cars' : `${seg} cars`} sold
        {win === 'today' ? ' today' : ' this month'} · total gross <b>{usd(totals.total)}</b>
      </div>

      {loading ? (
        <div className="center-screen"><div className="spinner" /></div>
      ) : layout === 'boards' ? (
        <>
          {podium.length > 0 && (
            <div className="podium">
              {podium.map((s, i) => (
                <div key={s.dealer_id} className={`pod pod-${i + 1}`}>
                  <div className="pod-rk">{['🥇', '🥈', '🥉'][i]}</div>
                  <div className="pod-store">{s.store}</div>
                  <div className="pod-gross">{usd(s.total)}</div>
                  <div className="pod-units">{int(s.units)} {seg === 'all' ? 'cars' : seg} · {usd(s.totalPVR)} PVR</div>
                </div>
              ))}
            </div>
          )}
          <div className="minis">
            {seg === 'all' && (
              <MiniBoard title="New Units" rows={stores} valueOf={(r) => r.newUnits} fmt={int} />
            )}
            {seg === 'all' && (
              <MiniBoard title="Used Units" rows={stores} valueOf={(r) => r.usedUnits} fmt={int} />
            )}
            {seg !== 'all' && (
              <MiniBoard title={`${seg === 'new' ? 'New' : 'Used'} Units`} rows={stores} valueOf={(r) => r.units} fmt={int} />
            )}
            <MiniBoard title="Total Gross" rows={stores} valueOf={(r) => r.total} fmt={usd} />
            <MiniBoard title="Front PVR" rows={eligiblePVR} valueOf={(r) => r.frontPVR} fmt={usd} note={pvrNote} />
            <MiniBoard title="Back PVR" rows={eligiblePVR} valueOf={(r) => r.backPVR} fmt={usd} note={pvrNote} />
            <MiniBoard title="Total PVR" rows={eligiblePVR} valueOf={(r) => r.totalPVR} fmt={usd} note={pvrNote} />
          </div>
        </>
      ) : (
        <div className="tablewrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="l">Store</th>
                {[['units', 'Units'], ['total', 'Total Gross'], ['frontPVR', 'Front PVR'], ['backPVR', 'Back PVR'], ['totalPVR', 'Total PVR']].map(([k, label]) => (
                  <th key={k} className={`sortable ${sort.key === k ? 'active' : ''}`} onClick={() => toggleSort(k)}>
                    {label}{sort.key === k ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((s) => (
                <tr key={s.dealer_id}>
                  <td className="l">{s.store}</td>
                  <td>{int(s.units)}</td>
                  <td>{usd(s.total)}</td>
                  <td className={s.frontPVR < 0 ? 'neg' : ''}>{s.frontPVR === null ? '—' : usd(s.frontPVR)}</td>
                  <td className="hl">{s.backPVR === null ? '—' : usd(s.backPVR)}</td>
                  <td className="hl">{s.totalPVR === null ? '—' : usd(s.totalPVR)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="l">Total</td>
                <td>{int(totals.units)}</td>
                <td>{usd(totals.total)}</td>
                <td className={totals.frontPVR < 0 ? 'neg' : ''}>{usd(totals.frontPVR)}</td>
                <td>{usd(totals.backPVR)}</td>
                <td>{usd(totals.totalPVR)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <footer className="ftr">
        Sold-and-booked retail deals by contract date. Reconciled to Tekion's Sales Recap.
        Not official accounting; updates every 30 minutes during business hours.
      </footer>
    </div>
  );
}
