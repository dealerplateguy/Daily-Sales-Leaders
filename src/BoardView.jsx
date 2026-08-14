import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { STORES, etToday, addDays, monthStart, prettyDate, isSunday, prevBusinessDay } from './constants.js';
import DailyChart from './DailyChart.jsx';

const MIN_UNITS_FOR_PVR = 3;
const LOOKBACK_DAYS = 92;

const usd = (v) => {
  const n = Math.round(Number(v) || 0);
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString();
};
const int = (v) => (Number(v) || 0).toLocaleString();
const NUM = ['new_units', 'new_front', 'new_back', 'new_total', 'used_units', 'used_front', 'used_back', 'used_total'];

export default function BoardView({ email, sampleDaily }) {
  const preview = Array.isArray(sampleDaily);
  const [rows, setRows] = useState(preview ? sampleDaily : []);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(!preview);

  const [mode, setMode] = useState('today');       // today | yesterday | mtd | day
  const [pickedDate, setPickedDate] = useState(null);
  const [seg, setSeg] = useState('all');           // all | new | used
  const [layout, setLayout] = useState('boards');  // boards | table
  const [sort, setSort] = useState({ key: 'units', dir: 'desc' });

  const today = etToday();

  async function load() {
    const since = addDays(today, -LOOKBACK_DAYS);
    const [{ data: d }, { data: m }] = await Promise.all([
      supabase.from('sales_daily').select('*').gte('sale_date', since),
      supabase.from('sales_live_meta').select('*').eq('id', 1).maybeSingle(),
    ]);
    setRows(d || []);
    setMeta(m || null);
    setLoading(false);
  }

  useEffect(() => {
    if (preview) return;
    load();
    const ch = supabase.channel('sales-daily')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_daily' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [preview]);

  useEffect(() => { setLayout(mode === 'mtd' ? 'table' : 'boards'); }, [mode]);

  // Index daily rows by dealer|date.
  const byKey = useMemo(() => {
    const m = new Map();
    for (const r of rows) m.set(`${r.dealer_id}|${r.sale_date}`, r);
    return m;
  }, [rows]);

  const yesterday = prevBusinessDay(today); // last open day (skips closed Sundays)
  const selectedDate = mode === 'today' ? today : mode === 'yesterday' ? yesterday : mode === 'day' ? pickedDate : null;

  // Dates to aggregate for the active window.
  const activeDates = useMemo(() => {
    if (mode === 'mtd') {
      const start = monthStart(today);
      const out = [];
      for (let d = start; d <= today; d = addDays(d, 1)) out.push(d);
      return out;
    }
    return selectedDate ? [selectedDate] : [];
  }, [mode, selectedDate, today]);

  // Per-store aggregation across the active dates, filtered by segment.
  const stores = useMemo(() => {
    return STORES.map((st) => {
      const sum = { new_units: 0, new_front: 0, new_back: 0, new_total: 0, used_units: 0, used_front: 0, used_back: 0, used_total: 0 };
      for (const d of activeDates) {
        const r = byKey.get(`${st.dealer_id}|${d}`);
        if (r) for (const k of NUM) sum[k] += Number(r[k]) || 0;
      }
      const pick = (mm) => seg === 'all' ? sum[`new_${mm}`] + sum[`used_${mm}`] : sum[`${seg}_${mm}`];
      const units = pick('units'), front = pick('front'), back = pick('back'), total = pick('total');
      return {
        dealer_id: st.dealer_id, store: st.name, region: st.region,
        newUnits: sum.new_units, usedUnits: sum.used_units,
        units, front, back, total,
        frontPVR: units > 0 ? front / units : null,
        backPVR: units > 0 ? back / units : null,
        totalPVR: units > 0 ? total / units : null,
      };
    });
  }, [byKey, activeDates, seg]);

  const totals = useMemo(() => {
    const t = stores.reduce((a, s) => ({ units: a.units + s.units, front: a.front + s.front, back: a.back + s.back, total: a.total + s.total }), { units: 0, front: 0, back: 0, total: 0 });
    return { ...t, frontPVR: t.units ? t.front / t.units : null, backPVR: t.units ? t.back / t.units : null, totalPVR: t.units ? t.total / t.units : null };
  }, [stores]);

  // Chart: the current month's daily group totals (respects the New/Used filter).
  const chartDays = useMemo(() => {
    const out = [];
    for (let d = monthStart(today); d <= today; d = addDays(d, 1)) {
      if (isSunday(d)) continue; // closed Sundays: keep the trend to open days
      let units = 0, gross = 0;
      for (const st of STORES) {
        const r = byKey.get(`${st.dealer_id}|${d}`);
        if (!r) continue;
        if (seg === 'all') { units += (r.new_units + r.used_units); gross += Number(r.new_total) + Number(r.used_total); }
        else { units += Number(r[`${seg}_units`]); gross += Number(r[`${seg}_total`]); }
      }
      out.push({ date: d, units, gross });
    }
    return out;
  }, [byKey, seg, today]);

  const tableRows = useMemo(() => {
    const list = stores.filter((s) => s.units > 0 || mode === 'mtd');
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const av = a[sort.key] ?? -Infinity, bv = b[sort.key] ?? -Infinity;
      return av === bv ? 0 : (av < bv ? -dir : dir);
    });
  }, [stores, sort, mode]);

  const podium = useMemo(() => [...stores].filter((s) => s.units > 0).sort((a, b) => b.total - a.total).slice(0, 3), [stores]);
  const eligiblePVR = stores.filter((s) => s.units >= MIN_UNITS_FOR_PVR);
  const pvrNote = <span className="floor">≥{MIN_UNITS_FOR_PVR} units</span>;

  function toggleSort(key) {
    setSort((s) => s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' });
  }
  function pickDay(dateStr) {
    if (!dateStr) return;
    setPickedDate(dateStr);
    setMode(dateStr === today ? 'today' : dateStr === yesterday ? 'yesterday' : 'day');
  }

  const lastUpdated = meta?.last_poll_at
    ? new Date(meta.last_poll_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) + ' ET'
    : '—';
  const windowLabel = mode === 'today' ? 'today' : mode === 'yesterday' ? 'yesterday'
    : mode === 'mtd' ? 'this month' : `on ${prettyDate(selectedDate)}`;

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
          <button className={mode === 'yesterday' ? 'on' : ''} onClick={() => setMode('yesterday')}>Yesterday</button>
          <button className={mode === 'today' ? 'on' : ''} onClick={() => setMode('today')}>Today</button>
          <button className={mode === 'mtd' ? 'on' : ''} onClick={() => setMode('mtd')}>Month to date</button>
        </div>
        <label className={`datepick${mode === 'day' ? ' on' : ''}`} title="Pick any day">
          <span className="cal">📅</span>
          <input type="date" max={today} min={addDays(today, -LOOKBACK_DAYS)}
            value={selectedDate || ''} onChange={(e) => pickDay(e.target.value)} />
        </label>
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
        <b>{int(totals.units)}</b> {seg === 'all' ? 'cars' : `${seg} cars`} sold {windowLabel} · total gross <b>{usd(totals.total)}</b>
      </div>

      {loading ? (
        <div className="center-screen"><div className="spinner" /></div>
      ) : (
        <>
          <DailyChart days={chartDays} selectedDate={selectedDate} onPick={pickDay} />

          {layout === 'boards' ? (
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
                {seg === 'all'
                  ? <>
                      <MiniBoard title="New Units" rows={stores} valueOf={(r) => r.newUnits} fmt={int} />
                      <MiniBoard title="Used Units" rows={stores} valueOf={(r) => r.usedUnits} fmt={int} />
                    </>
                  : <MiniBoard title={`${seg === 'new' ? 'New' : 'Used'} Units`} rows={stores} valueOf={(r) => r.units} fmt={int} />}
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
        </>
      )}

      <footer className="ftr">
        Sold-and-booked retail deals by contract date. Reconciled to Tekion's Sales Recap.
        Not official accounting; updates every 30 minutes during business hours.
      </footer>
    </div>
  );
}

function MiniBoard({ title, rows, valueOf, fmt, note }) {
  const ranked = rows.filter((r) => valueOf(r) !== null && valueOf(r) !== undefined && valueOf(r) !== 0)
    .sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 5);
  const medal = ['🥇', '🥈', '🥉'];
  return (
    <div className="mini">
      <div className="mini-title">{title}{note}</div>
      {ranked.length === 0 ? <div className="mini-empty">No sales yet</div> : (
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
