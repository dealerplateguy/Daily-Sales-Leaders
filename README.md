# Daily Sales Leaders

Live, group-wide **store** sales leaderboard for the Rohrman Auto Group. Ranks all 19 rooftops on daily sales performance, refreshed every 30 minutes from Snowflake (Tekion DMS). Sibling to the Advisor Rank Board.

- **Metrics:** New units + gross, Used units + gross, Total Gross, Front PVR, Back PVR, Total PVR.
- **Views:** Today ⇄ Month-to-date, All / New / Used, Leaders (podium + mini-boards) / Table.
- **Access:** Supabase Auth magic-link login, gated to an allow-list of emails (gross/PVR is sensitive). All protection is server-side RLS.

## How the numbers are built

Reconciled to Tekion's Sales Recap (New tied to the exact dollar, verified 2026-08-13):

> Contract date (`CONTRACT_DATE_SPLIT_*`) + `DEAL_STATUS IN ('BOOKED','CLOSED_OR_SOLD')` + retail deal types (`PERSONAL`/`BUSINESS`/`INTERNET`/`EMPLOYEE_PURCHASE`) + raw `FRONT_GROSS`/`BACK_GROSS`/`TOTAL_GROSS`.

The `sales-poll` Supabase edge function runs that query every 30 min (pg_cron) and writes per-store tallies to `sales_live_tallies`, which the board reads over Supabase Realtime.

## Dev

```bash
npm install
npm run dev   # http://localhost:5175/Daily-Sales-Leaders/
```

Append `?preview=1` in dev to view the board with sample data (no login). This path is tree-shaken out of the production build.

## Architecture

- Frontend: Vite + React 19, deployed to GitHub Pages.
- Backend: shared with the Advisor Rank Board Supabase project (`sales_*` tables + `sales-poll` edge function). Snowflake read-only service user `SVC_FIXEDOPS_RO`.
