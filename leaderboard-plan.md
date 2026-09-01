# Leaderboard Page — Implementation Plan (v3, final)

Status: **awaiting your go-ahead**. All open questions resolved (§12). Do not start coding
until you say go.

---

## 1. Goal

Add a public page **`/leaderboard`** to `the-yg-trader-hunt` showing live competition
standings, built **only from the people who entered via the form** (`trader.txt`), matched
into Elefin by email and scored on % return.

- **Top 3 podium** (medal cards).
- **Standings table** — Top 50: rank, trader, country, % return, net P/L, trades.
- A background job pulls Elefin data **every 4 hours**, scores + ranks the registered
  traders, stores a snapshot in **MongoDB** (`yg_trader_hunt` DB).
- The browser re-fetches that snapshot from our own API **every 1 hour** and re-renders in
  place (no extra Elefin load).
- Visual style matches the existing dark "Modernist" look of `index.html` / `form.html`
  (`#0c0e0d` ground, `#c6fb3e` lime, Archivo, 1px `#232925` rules, square corners,
  uppercase tracked micro-labels).

### Decisions locked in

| Topic | Decision |
| --- | --- |
| Whose data | **Only form registrants** (`trader.txt` → `participants`), matched to Elefin **by email**. Not all referred clients. |
| Elefin pull cadence | **Every 4 hours** (backend cron). Browser polls our API hourly. |
| Scoring formula | **`return_pct = trading.net_profit / funding.net_deposit × 100`** |
| Name display | **Masked** — first name + last initial (`Rahul S.`). Email never shown. |
| Database | **Dedicated `yg_trader_hunt`** DB on the same Atlas cluster. |
| Keeping participants current | **Manual re-import** of `trader.txt` (`npm run import:participants`). No form wiring. |
| Competition window | **2026-09-03 00:00 IST → 2026-09-10 23:59 IST.** Drives the countdown; P/L is **not** date-bounded (see §5). |
| Table length | **Top 50**, single page. |
| Country column | **Yes** — flag emoji + country name, hidden on narrow screens. |
| Prod host | **Same host as now, one Node instance** → in-process `node-cron` is enough; add that host's IP to the Atlas allow-list. |

---

## 2. Data sources

### 2a. Participants — `trader.txt`
Tab-separated export of the Google Sheet the entry form feeds
(`Timestamp, Name, Phone, Email, Capital, Whatsapp Message, Call Done, Status, amit remarks`).

- ~113 rows → **~90 unique valid emails** after: lowercase, trim, drop rows whose `Status` is
  `Duplicate` / `Duplicate Lead`, and flag malformed addresses (`…@gamil.vom`, `…@gmail.con`,
  `…@gmail.comi`) as `email_valid: false` — reported, never queried.
- Imported into `participants` by a **re-runnable** script (`scripts/import-participants.js`),
  upsert keyed on `email`. Re-run whenever you drop in a fresh export.
- File lives at `data/trader.txt` (git-ignored — PII). A `data/trader.sample.txt` of fake
  rows is committed.

### 2b. Elefin API (from the shared reference)
Reference: `tele_approval_bot/scripts/*.py`, `bot/services/elefin_service.py`, `elefin_v2.txt`.

- Base `https://el.theloginarea.com/api/v1`, auth `Authorization: Bearer <KEY>.<SECRET>`,
  `Accept: application/json`.
- `GET /clients?page=<n>&per_page=100` — paginated, auto-scoped to **our referred clients
  only**. Stop paging when a page returns `< per_page` rows.
- Envelope: `{ success, data: { data: [rows], meta: { total } } }`.
- Each row already carries every aggregate we need — **no `/accounts/{login}` calls**:
  ```jsonc
  { "client_id": 10001, "name": "Rahul Sharma", "email": "...", "country": "IN",
    "status": "active", "registered_at": "...", "referred_at": "...",
    "funding":  { "currency": "USD", "deposits": 500, "withdrawals": 0,
                  "net_deposit": 500, "is_funded": true },
    "accounts": { "count": 1, "logins": ["12345678"], "balance": 640.2, "equity": 655.1 },
    "trading":  { "lots": 12.4, "trades": 37, "net_profit": 140.2, "last_trade_at": "..." },
    "commission_earned": 3.1 }
  ```
- `GET /me` once per run = credential/health check + log rate-limit headroom.

### 2c. How the two are joined
The job fetches **all** referred clients once (a few paged requests), builds an
`emailLower → clientRow` map, then walks `participants`:

| participant email in Elefin map? | result |
| --- | --- |
| yes, eligible | scored + ranked → on the board; `participant.elefin` snapshot updated |
| yes, not eligible (no deposit / no trade / inactive) | `matched, not_eligible`; off board |
| no | `matched: false` — registered but not under referral yet; off board |

---

## 3. Architecture

Everything inside this Node/Express project. Python bot is reference only; no Python at
runtime. One long-running process; `node-cron` runs in-process.

```
Browser ──GET /leaderboard────────▶ leaderboard.html (static, themed)
Browser ──GET /api/leaderboard────▶ Express route ──▶ Mongo: lb_current (1 doc)
                                                    │
one-off: node scripts/import-participants.js ──────▶ Mongo: participants
                                                    │
node-cron (0 */4 * * *) ─▶ refreshLeaderboard() ────┤ reads participants + Elefin
   1. GET /me (health)                              ├─▶ Mongo: participants     (match status)
   2. page GET /clients (all referred)             ├─▶ Mongo: lb_snapshots     (history)
   3. join by email, filter, score, rank           ├─▶ Mongo: lb_current       (fast read)
   4. write current + snapshot + job_run           └─▶ Mongo: lb_job_runs      (observability)
```

- Mongo TTL lock (`lb_locks`) guards against a double run if a second instance is ever
  started.
- **On boot:** newest snapshot missing or older than the interval → run once now; else wait
  for the next tick.
- **Stale-while-error:** a failed run keeps serving the last good `lb_current` with
  `is_stale: true` + `last_error`. The server never crashes on a bad Elefin/Mongo response.

---

## 4. MongoDB — DB `yg_trader_hunt`

### `participants` — one doc per registered email
```jsonc
{
  "_id": "rahul.sharma@gmail.com",
  "name_form": "Rahul Sharma",
  "phone": "9560818929",
  "capital_stated": 200,          // "N/A" -> null
  "form_status": "Pending",
  "remarks": "will add funds tuesday",
  "email_valid": true,
  "source": "form_sheet",
  "imported_at": "...",
  "elefin": {                      // null until matched
    "matched": true, "client_id": 10001, "name": "Rahul Sharma",
    "country": "IN", "status": "active", "currency": "USD",
    "net_deposit": 500, "deposits": 500, "withdrawals": 0,
    "balance": 640.2, "equity": 655.1,
    "net_profit": 140.2, "trades": 37, "lots": 12.4,
    "return_pct": 28.04, "eligible": true,
    "last_trade_at": "...", "checked_at": "..."
  }
}
```

### `lb_snapshots` — append-only history (one per successful run)
```jsonc
{ "_id": ObjectId, "generated_at": "...", "run_id": "...",
  "participants_total": 90, "matched": 41, "eligible": 33,
  "formula": "net_profit/net_deposit",
  "top3": [ {entry}, {entry}, {entry} ],
  "entries": [ {entry}, ... up to 50 ],
  "stats": { "participants": 33, "avg_return_pct": 6.1, "in_profit": 18, "total_lots": 812.5 },
  "duration_ms": 2650 }
```
`entry` (also the API row):
```jsonc
{ "rank": 1, "client_id": 10001, "name": "Rahul S.", "country": "IN",
  "return_pct": 28.04, "net_profit": 140.2, "net_deposit": 500, "equity": 655.1,
  "trades": 37, "shortlisted": true }
```

### `lb_current` — single doc, O(1) read for the API
Snapshot body + `is_stale`, `last_error`, `next_refresh_at`. Replaced each successful run; on
a failed run only its flags update.

### `lb_job_runs` — observability
```jsonc
{ "_id": ObjectId, "run_id": "...", "started_at": "...", "finished_at": "...",
  "ok": true, "clients_fetched": 123, "matched": 41, "eligible": 33,
  "error": null, "rate_limit_remaining": 480 }
```

### `lb_locks` — TTL lock, `expireAfterSeconds ~600`
`{ "_id": "refresh", "acquired_at": "...", "holder": "<host/pid>" }`

### Indexes
`participants`: `{ "elefin.return_pct": -1 }`, `{ "elefin.matched": 1 }` ·
`lb_snapshots`: `{ generated_at: -1 }` · `lb_job_runs`: `{ started_at: -1 }` ·
`lb_locks`: TTL on `acquired_at`.

---

## 5. Scoring & eligibility

**Score (ranking key):**
```
return_pct = (trading.net_profit / funding.net_deposit) * 100
```
- `net_deposit <= 0` → excluded.
- Ratio is currency-agnostic → no FX for ranking. `USDT_TO_INR_RATE` (102) applies **only** to
  the displayed USD net-P/L column for non-USD accounts (shown with a `≈` prefix).
- 2 dp for display, full precision for sort. Ties: higher `net_profit`, then earlier
  `referred_at`.

**Eligible for the board when all of:**
| Rule | Default | Env |
| --- | --- | --- |
| email in `participants` | required | — |
| matched to an Elefin referred client | required | — |
| `status == "active"` | on | — |
| `funding.net_deposit >= MIN_DEPOSIT_USD` (FX-normalised) | `100` | `MIN_DEPOSIT_USD` |
| `trading.trades > 0` | on | `REQUIRE_TRADE` |

**Competition window (`2026-09-03 → 2026-09-10 IST`)** drives the **countdown only**. The
Elefin `/clients` aggregates (`net_profit`, `trades`, …) are **lifetime**, not date-ranged, so
P/L is not bounded to the window in v1. True in-window P/L would need
`GET /accounts/{login}/trades` per account (documented, but N× more calls) — noted as a
follow-up, gated behind `WINDOW_FILTER=true` if you want it later.

**Name masking:** `"Rahul Sharma" → "Rahul S."`; one-word name → unchanged; empty →
`"Trader ####"` (last 4 of `client_id`). Uses the Elefin account name when matched, else the
form name.

---

## 6. Backend — new files

```
the-yg-trader-hunt/
├── .env                        # NEW (git-ignored) — from the values you supplied
├── .env.example                # committed, keys only
├── .gitignore                  # NEW — node_modules/, .env, data/trader.txt, uploads/*, .DS_Store
├── config.js                   # env parsing + defaults, single export
├── db/
│   └── mongo.js                # MongoClient singleton, getDb(), ensureIndexes()
├── services/
│   ├── elefin.js               # ElefinClient: me(), getAllClients({perPage})
│   └── scoring.js              # computeReturnPct, maskName, isEligible, rankEntries, countryLabel
├── jobs/
│   ├── refreshLeaderboard.js   # fetch → join participants → score → rank → persist
│   └── scheduler.js            # node-cron + run-on-boot-if-stale + Mongo lock
├── routes/
│   └── leaderboard.js          # GET /api/leaderboard, POST /api/leaderboard/refresh
├── scripts/
│   ├── import-participants.js  # data/trader.txt -> participants (idempotent upsert + summary)
│   └── refresh-once.js         # one manual job run, then exit
├── fixtures/
│   └── elefin-sample.json      # fake client rows for MOCK_ELEFIN / UI dev
├── data/
│   ├── trader.txt              # the real export (git-ignored)
│   └── trader.sample.txt       # committed fake rows (emails overlap the fixture)
└── leaderboard.html            # the page
```

- `services/elefin.js` — port of the Python client (global `fetch`, 30 s `AbortController`
  timeout, 1 retry w/ backoff on 429/5xx, 250 ms inter-page delay). `MOCK_ELEFIN=1` → serve
  `fixtures/elefin-sample.json`.
- `services/scoring.js` — also holds a small ISO-3166 → `{ flag, name }` map for the common
  codes (IN, US, GB, AE, PK, BD, NP, …); unknown code → code as-is, no flag.
- `scripts/import-participants.js` — parse TSV, clean/validate emails, upsert `participants`,
  print `imported / updated / skipped-duplicate / invalid-email`.
- `jobs/refreshLeaderboard.js` — lock → `me()` → `getAllClients()` → email map → walk
  `participants`, update each `.elefin` sub-doc, collect eligible → score/sort/rank/slice(50)
  → write `lb_snapshots` + `lb_current` + `lb_job_runs` → set `next_refresh_at`. On throw:
  `lb_job_runs.ok=false`, `lb_current.is_stale=true`, keep good `entries`. Release lock in
  `finally`.
- `jobs/scheduler.js` — cron from `REFRESH_CRON` (default `0 */4 * * *`); boot catch-up.
- `routes/leaderboard.js`:
  - `GET /api/leaderboard` → `lb_current` →
    `{ generated_at, next_refresh_at, is_stale, formula, competition:{start,end}, top3,
      entries, stats }`, `Cache-Control: public, max-age=300`. No snapshot yet →
    `200 { status:"pending", entries:[] }`.
  - `POST /api/leaderboard/refresh` → header `x-refresh-token === REFRESH_TOKEN` → triggers a
    run → `{ started:true }`. (Kept for manual/testing even though host cron isn't needed.)
- `server.js` changes: `require('dotenv').config()`; mount the router **before** `app.get('*')`;
  make the catch-all skip `/api/*` (JSON 404); add `app.get('/leaderboard', …)`; after
  `listen`, `ensureIndexes()` then `scheduler.start()`; all guarded so a Mongo/Elefin outage
  still serves the static site.
- `package.json`: deps `mongodb`, `node-cron`, `dotenv`; scripts `"import:participants"`,
  `"refresh"`, keep `"start"`.

---

## 7. Config (`config.js` / `.env`)

| Var | Value / default | Purpose |
| --- | --- | --- |
| `MONGO_URI` | *(yours)* | Atlas connection string |
| `MONGO_DB_NAME` | `yg_trader_hunt` | dedicated DB |
| `ELEFIN_API_KEY` / `ELEFIN_API_SECRET` | *(yours)* | partner credentials |
| `ELEFIN_API_BASE_URL` | `https://el.theloginarea.com/api/v1` | API base |
| `REFRESH_CRON` | `0 */4 * * *` | backend pull schedule |
| `UI_POLL_MINUTES` | `60` | browser re-fetch interval |
| `SCORE_FORMULA` | `net_profit` | `net_profit` \| `equity` (kept for flexibility) |
| `MIN_DEPOSIT_USD` | `100` | eligibility threshold |
| `REQUIRE_TRADE` | `true` | must have ≥1 trade |
| `USDT_TO_INR_RATE` | `102` | FX for displayed USD P/L only |
| `LEADERBOARD_SIZE` | `50` | rows in the table |
| `SHORTLIST_SIZE` | `5` | highlighted band |
| `COMPETITION_START` | `2026-09-03T00:00:00+05:30` | countdown / display |
| `COMPETITION_END` | `2026-09-10T23:59:59+05:30` | countdown / display |
| `WINDOW_FILTER` | `false` | future: bound P/L to the window via the trades endpoint |
| `REFRESH_TOKEN` | random | protects the manual-refresh route |
| `MOCK_ELEFIN` | unset | `1` = use fixtures |

`.env.example` ships every key with a comment; the real `.env` is git-ignored.

---

## 8. Credentials & security (you pasted real secrets in chat)

- Elefin + Mongo values go only into a **git-ignored `.env`** — never a committed file, the
  HTML, or client JS. The browser sees only masked names + aggregate numbers via
  `/api/leaderboard`.
- **The `.env` you pasted is now in plaintext chat history.** After the competition, rotate:
  the Elefin API secret, the Atlas DB password, and the Telegram `BOT_TOKEN`. (`XM_*` is not
  used by this project.)
- Atlas rejects the connection unless the **one prod host's IP is on the allow-list** — please
  add it (or confirm it's already there).
- `data/trader.txt` (names/phones/emails) → git-ignored, never served, never sent to browser.

---

## 9. Frontend — `leaderboard.html`

Standalone page, **vanilla JS** (`fetch` + DOM render — not the `x-dc`/`DCLogic` runtime), but
visually identical to `index.html`: inline `<style>` in a `<helmet>` block, Archivo webfont,
the GTM snippet copied from `index.html`.

### Layout (top → bottom)
1. **Header** — same lime square + `THE YG TRADER HUNT`; right nav `HOME · LEADERBOARD (active)`
   + lime `OPEN ELEFIN ACCOUNT →`.
2. **Title strip** — kicker `LIVE LEADERBOARD`; `<h1>` "The standings."; sub "Top 5 by % return
   get shortlisted — then one winner is drawn from those five."; **status row** (tabular-nums,
   `#9aa5a0`): `Updated 12 min ago · Next update in 3h 48m · 33 traders in the hunt` +
   `Ends in 4d 06h` (from `COMPETITION_END`); a lime dot pulses during a fetch; a small
   `REFRESH` button re-reads our API only.
3. **Top 3 podium** — 3 cells, 1px dividers, no radius, order **#2 · #1 · #3**; #1 cell has a
   `3px solid #c6fb3e` top border + faint lime wash. Each: big rank numeral, `GOLD/SILVER/
   BRONZE` micro-label, masked name (`20px/600`), big signed `return_pct` (`+28.04%` lime /
   negative `#ff8a6b`), then `NET P/L ≈$140.20 · 37 trades`. Stacks to one column ≤767px
   (order #1,#2,#3).
4. **Standings table** — header bar `FULL STANDINGS`:
   | Col | Notes |
   | --- | --- |
   | `#` | rank, tabular, `#6c7a72` |
   | `TRADER` | masked name; rank ≤ 5 gets a small lime `SHORTLIST` tag |
   | `COUNTRY` | flag emoji + name (map in `scoring.js`); hidden < 560px |
   | `RETURN %` | signed, coloured, right-aligned |
   | `NET P/L` | `≈$` USD, right-aligned; hidden < 480px |
   | `TRADES` | int, right-aligned; hidden < 640px |
   Sticky blurred `<thead>`, 1px row rules, row `:hover` lime 5% tint, a `SHORTLIST — TOP 5`
   divider after row 5, wrapped in `overflow-x:auto`. Top 50 rows, single page.
5. **States** — loading (skeleton podium + 6 shimmer rows); `pending` ("Standings open when the
   first results land."); `is_stale` (amber strip: "Live feed hiccuped — showing the last good
   update from {time}."); no-eligible ("No qualifying accounts yet — deposit $100+ and place a
   trade to appear.").
6. **Footer** — risk-disclaimer + social block copied verbatim from `index.html`.

### Client script
`load()` → `GET /api/leaderboard` → render podium + table + status. `setInterval(load,
UI_POLL_MINUTES*60000)`; a 30 s `setInterval` refreshes the "updated / next / ends-in" relative
strings; `REFRESH` button → `load()`. `Intl.NumberFormat` for all numbers; null-guards
everywhere.

---

## 10. Testing without hitting Elefin
- `MOCK_ELEFIN=1 npm start` → job runs vs `fixtures/elefin-sample.json` (emails overlap
  `data/trader.sample.txt`) → full UI works against a real Mongo.
- `npm run import:participants` → seed/refresh `participants`, prints summary.
- `npm run refresh` → one job run, prints a table, exits.
- `curl -XPOST localhost:3005/api/leaderboard/refresh -H "x-refresh-token: <token>"`.
- Cross-check `return_pct` against `tele_approval_bot/exports/elefin_clients.xlsx`.

---

## 11. Edge cases
- `net_deposit` ≤ 0 / missing → excluded (counted in `lb_job_runs`).
- Registered email not in Elefin → `participants.elefin.matched=false`; off board.
- Duplicate form rows / `Status: Duplicate*` → collapsed on import by email.
- Malformed emails in `trader.txt` → `email_valid=false`, reported, never queried.
- Elefin 401/403 → run aborts, `lb_current` untouched, `is_stale` set.
- Partial pagination failure → abort (no half-built board); previous snapshot stays.
- Non-USD accounts → ranking unaffected; USD P/L column FX-normalised with `≈`.
- Two Node instances → Mongo TTL lock → only one runs the job.
- Mongo down at boot → static site + `/form` still serve; `/api/leaderboard` → `503` friendly
  body; scheduler retries next tick.
- Long/RTL/emoji names → mask + `text-overflow: ellipsis` + `max-width`.

---

## 12. Resolved questions
1. DB → **dedicated `yg_trader_hunt`**.
2. Participants stay current via **manual `npm run import:participants`** after re-export; the
   form is left as-is (Google Apps Script only).
3. Competition window → **2026-09-03 00:00 IST → 2026-09-10 23:59 IST**; countdown only, P/L
   not date-bounded in v1.
4. Table length → **Top 50, single page**.
5. Country column → **yes, flag + name**.
6. Prod host → **one instance, same host** → in-process cron; add the host IP to Atlas
   allow-list.

---

## 13. Build order (once you say go)
1. `.gitignore`, `.env` (from your values), `.env.example`, `config.js`
2. `db/mongo.js` + `ensureIndexes()`
3. `data/trader.txt` in place + `scripts/import-participants.js` → seed `participants`
4. `services/elefin.js` + `fixtures/elefin-sample.json` + `data/trader.sample.txt`
5. `services/scoring.js` (score, mask, country map)
6. `jobs/refreshLeaderboard.js`
7. `jobs/scheduler.js` + Mongo lock
8. `routes/leaderboard.js`
9. `scripts/refresh-once.js`
10. `server.js` wiring
11. `package.json` deps + scripts, `npm install`
12. `leaderboard.html` (structure → theme → states → polling)
13. End-to-end in `MOCK_ELEFIN`, then with real creds
14. Add `LEADERBOARD` to `index.html` header nav
