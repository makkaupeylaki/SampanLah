# harbourlah

A dark, mobile-first board of ships arriving at and departing Singapore: ferries at HarbourFront and
Tanah Merah, cruise ships at Marina Bay and HarbourFront, and cargo vessels, plus a live Tracker map.
Same shape as flightlah, on the Cloudflare free tier:

```
Worker cron */10 ──► MPA OCEANS-X (due/actual arrivals + departures, departure declarations)
                 ──► Singapore Cruise Centre ferry board (HTML)
                 ──► normalise ──► Workers KV "snap" (1 write; failed feeds keep their last good copy)
                 ──► MPA positions snapshot ──► slim ──► Workers KV "positions" (1 write)
Worker cron 7 */6 ──► MPA reference data (vessel types, location codes) + particulars snapshot ──► KV
Pages (web/) ──► GET /api/board   (built from KV, no-store)
             ──► GET /api/positions (Tracker map, from KV, no-store)
             ──► GET /api/vessel?imo=  (particulars on tap, live + cached, never in KV)
```

| Path | What |
| --- | --- |
| `worker/src/mpa.js` | All MPA OCEANS-X logic: paths, `apikey` header, date encoding, normalisation. |
| `worker/src/scc.js` | Singapore Cruise Centre ferry board scraper. |
| `worker/src/board.js` | Merges due + actual movements, adds types/particulars, categories, staleness. Pure. |
| `worker/src/index.js` | Crons, KV, `/api/board`, `/api/vessel`, CORS. |
| `worker/test/` | `npm test`: offline tests with mocked MPA/SCC and in-memory KV. |
| `web/` | Static frontend (vanilla JS, no build step; Leaflet 1.9.4 from cdnjs, OSM tiles). `web/config.js` holds the Worker URL. |

## MPA OCEANS-X paths (checked against the live gateway, 8 Nov 2026)

The version sits right after the resource: `https://oceans-x.mpa.gov.sg/api/v1/<resource>/<version>/<path>`.

| Feed | Path |
| --- | --- |
| Due to arrive | `vessel/duetoarrive/1.0.0/date/{yyyy-MM-dd HH:mm:ss}/hours/{N}` (next N h) |
| Due to depart | `vessel/duetodepart/1.0.0/date/{…}/hours/{N}` (next N h) |
| Arrived | `vessel/arrivals/1.0.0/date/{…}/hours/{N}` (past N h) |
| Departed | `vessel/departure/1.0.0/date/{…}/hours/{N}` (past N h). **Singular**: `departures` 404s. |
| Next port / agent | `vessel/departuredeclaration/1.0.0/pastNhours?datetime=…&hours=N` (optional) |
| Types, sizes | `vessel/positions/1.0.0/snapshot` (every 6 h; we keep only type/length/beam/GT/year/MMSI) |
| Tracker | the same snapshot every 10 min, slimmed to name, IMO, flag, lat/lon, heading, speed, type, length, GT |
| On tap | `vessel/particulars/1.1.0/imonumber/{imo}` |
| Reference | `mdhvessel/reference/types/1.0.0/filetype/json`, `mdhvessel/reference/locations/1.0.0/filetype/json` |

`movements/1.1.0` only has per-vessel lookups (`/imonumber`, `/vesselname`, `/callsign`), no date query,
so it isn't used for the board. Dates are SGT, within ±72 h of now; hours are 1–2 digits. The date is
sent percent-encoded (`%20`, `%3A`); on a 404 the Worker retries once with literal colons.
MPA says these feeds update about hourly (the positions snapshot every 3 min).

## API

- `GET /api/board`:
  `{ updatedAt, checkedAt, stale, source, typesUnavailable, sources: { mpa, scc }, arr: Ship[], dep: Ship[] }`.
  `updatedAt` and `stale` follow MPA, the main source: `stale` is true when an MPA feed is failing or older
  than 15 min. The SCC ferry board's own state is in `sources.scc` (the page shows it as a ferry note), so
  a blocked SCC doesn't make the board stale; its last good ferry rows stay listed. Rows cover the past
  12 h and next 24 h.
- `GET /api/positions`: `{ updatedAt, checkedAt, stale, error, count, types: { code: name }, ships: Pos[] }`,
  same staleness rules as the board. `Pos`: `n` name, `imo`, `fl` flag, `la`/`lo` degrees, `h` heading
  (course when the heading is unknown; absent if neither), `s` speed (kn), `tc` type code, `l` length (m),
  `g` gross tonnage, `c` category. About 1,200 ships, ~150 KB of JSON (~35 KB gzipped). Memoised ~20 s per
  isolate; on a fresh deploy the first call fetches and stores it.
- `GET /api/vessel?imo=1234567` (or `?cs=CALLSIGN`): `{ vessel: { n, imo, cs, fl, typeCode, len, beam, gt, built, … } }`.

`Ship`: `id`, `src` (`mpa`|`scc`), `dir` (`arr`|`dep`), `name`, `imo`, `cs`, `fl` (flag),
`type`, `cat` (`ferry`|`cruise`|`cargo`), `from`, `to`, `st`/`et`/`at` (scheduled/estimated/actual, epoch ms),
`status`, plus `len`, `beam`, `gt`, `built`, `agent`, `pax`, `op`, `trip` when known.

## Deploy

```sh
cd worker
npm install
npx wrangler kv namespace create BOARD_KV     # paste the id into wrangler.toml, replacing the zeros
npx wrangler secret put MPA_API_KEY            # never commit it; it is only read from env.MPA_API_KEY
npx wrangler deploy                            # also registers both crons
# web/config.js: window.HARBOURLAH_API = "https://harbourlah.<subdomain>.workers.dev";
cd .. && npx wrangler pages deploy web --project-name harbourlah
```

Local dev: put `MPA_API_KEY=…` in `worker/.dev.vars` (git-ignored), `npm run dev`, then
`curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"`.

## Free-tier budget

- **KV writes:** 2 per 10-minute tick, board + positions (288/day), + ≤ 2 per 6-hourly reference tick
  (≤ 8/day) ≈ 300/day. A failing positions fetch keeps the last ships and only writes when the error starts.
  If reference data is missing from KV (fresh deploy, failed 6-hourly run), `/api/board` or the next board
  tick fetches it lazily: one fetch at a time per isolate, at most one per 30 min across isolates (a
  `ref-attempt` KV marker with a TTL), ≤ 3 writes per attempt. `/api/board` waits up to 8 s for it; if it
  fails, the board is served anyway with `typesUnavailable: true` and the page shows a short hint.
- **Subrequests per tick:** 6 MPA (incl. positions) + up to 12 SCC pages (2 directions × current and next 6 h slot × ≤ 3 pages).
- **KV reads:** `/api/board` and `/api/positions` are memoised per isolate for 20 s; reference data for 10 min.
- **CPU:** the positions snapshot (~600 KB of JSON) is the heaviest parse. On the 10-minute tick it runs
  last, after the board is saved, so if it ever exceeds the CPU limit the board is unaffected; the Tracker
  just shows older positions, flagged stale.
- **Map:** ships are drawn on one canvas (not 1,200 DOM markers); a full redraw of 1,200 ships took ~10 ms
  with 4x CPU throttling in Chromium at 390px, and redraws are capped at one per frame while panning.

## Honest limits

- Berth times for container ships are not public; MPA gives declared due times and actual arrival/departure
  at port limits, updated about hourly.
- Small boats without AIS are missing.
- Ferry rows from the Singapore Cruise Centre board have an operator and trip ID, not a vessel name, so the
  same crossing can also appear as an MPA row under the ship's name.
- The SCC site sits behind Incapsula bot protection. The Worker sends an honest User-Agent and does not try to
  get past challenges; if it's blocked, ferries come from MPA only and the page says so.
- Marina Bay Cruise Centre's schedule isn't scraped: its page has no schedule in the HTML and loads it from an
  authenticated API. Cruise ships still appear via MPA (category from vessel type, size and berth).

## Categories

Ferry / Cruise / Cargo/Other. A known MPA vessel type decides (passenger and ferry types are Cruise when
large or at a cruise berth, else Ferry; any other type is Cargo/Other). With no type yet (e.g. inbound and
not in the snapshot), the berth decides: codes `CC01`, `CC01E`, `CC01W`, `CC02` (HarbourFront Cruise
Centre) and `CM01`, `CM02` (Marina Bay Cruise Centre) are Cruise; `RFT1`–`8`, `DFT5`–`8`, `TMFT`, `CFT`
are Ferry; otherwise case-insensitive descriptions ("MARINA BAY CC BTH 1", "TANAH MERAH FERRY TERM",
"REGIONAL FERRY PLAT 4"). Departures use the berth the ship arrived at, when it's in the arrival feeds.

Data: Maritime and Port Authority of Singapore (MPA), via OCEANS-X
([terms](https://oceans-x.mpa.gov.sg/api-terms-of-service)). Ferry times: Singapore Cruise Centre. Unofficial app.
