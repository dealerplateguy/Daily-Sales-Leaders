import { useState } from 'react';
import { prettyDate } from './constants.js';

const usd0 = (v) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString();

// Two single-series bar charts (units, dollars) over the same day axis. Different
// scales => two charts, never a dual axis. Click a bar to jump to that day.
export default function DailyChart({ days, selectedDate, onPick }) {
  const [hover, setHover] = useState(null);
  if (!days.length) return null;

  const maxU = Math.max(1, ...days.map((d) => d.units));
  const maxG = Math.max(1, ...days.map((d) => d.gross));
  const active = hover || selectedDate;
  const activeDay = days.find((d) => d.date === active);

  const Row = ({ label, value, max, color, fmt }) => (
    <div className="ch-row">
      <div className="ch-side">{label}</div>
      <div className="ch-bars">
        {days.map((d) => {
          const v = d[value];
          const dim = active && d.date !== active;
          const isSel = d.date === selectedDate;
          return (
            <div
              key={d.date}
              className={`ch-col${isSel ? ' sel' : ''}`}
              onMouseEnter={() => setHover(d.date)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick && onPick(d.date)}
              title={`${prettyDate(d.date)} — ${fmt(v)}`}
            >
              <div
                className="ch-bar"
                style={{
                  height: `${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%`,
                  background: color, opacity: dim ? 0.28 : 1,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="chart">
      <div className="ch-head">
        <span className="ch-title">Daily trend</span>
        <span className="ch-read">
          {activeDay
            ? `${prettyDate(activeDay.date)} · ${activeDay.units} cars · ${usd0(activeDay.gross)}`
            : 'Hover or tap a bar for a day'}
        </span>
      </div>
      <Row label="Units" value="units" max={maxU} color="var(--gold)" fmt={(v) => `${v} cars`} />
      <Row label="Gross" value="gross" max={maxG} color="var(--blue)" fmt={usd0} />
      <div className="ch-axis">
        {days.map((d, i) => (
          <div key={d.date} className="ch-tick">
            {i === 0 || i === days.length - 1 || d.date === active || Number(d.date.slice(-2)) % 5 === 0
              ? Number(d.date.slice(-2))
              : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
