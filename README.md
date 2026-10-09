# Wind Guru

A wind sport forecast tool for the Strait of Georgia, Howe Sound and Metro
Vancouver. Pick a knot range, pick a day (today + 3 ahead), and it ranks
every spot by probability of hitting that range — reasoning through whether
the wind is thermal (sea breeze / valley heating), outflow (gap wind /
cold-air drainage) or synoptic (frontal/gradient), not just showing raw
numbers.

## How it works

- **Data**: [Open-Meteo](https://open-meteo.com) multi-model API — GFS
  (NOAA), ECMWF, ICON (DWD) and GEM/HRDPS (Environment Canada, ~2.5km over
  BC). Free, no API key, CORS-enabled.
- **Rule engine** (`assets/rules.js`): classifies each hour at each spot as
  thermal / outflow / synoptic / calm / mixed, using local hour, month, cloud
  cover, and direction against each spot's known pattern (see
  `assets/spots.js`). Thermal and outflow hours weight the fine-resolution
  GEM/HRDPS model more heavily, since it's the only one of the four that
  resolves Howe Sound and Fraser Valley terrain effects.
- **Squamish thermal calibration**: raw coarse-model (GFS-class) wind badly
  under-reads the Squamish/Porteau Cove thermal once it's actually inflowing.
  We scale it ~2.85x based on field notes from a 12-year local rider, Jack
  Rieder of [West Coast Wind Sports](https://www.westcoastwindsports.com/blogs/local-knowledge/forecasting-squamish-wind-with-jack-rieder):
  5-7kt modeled SW ≈ 15-20kt real, 7-9kt ≈ 20-25kt real, 9kt+ ≈ a strong day.
  Those field notes only covered 5-9kt modeled wind, so above a 32kt
  calibrated output the multiplier tapers off smoothly (an asymptotic curve,
  not a hard cutoff) instead of continuing to scale linearly — a 22kt coarse
  reading now lands around 38kt instead of an unvalidated 63kt. See
  `calibrateSquamishThermal()` in `assets/rules.js`.
- **Environment Canada marine bulletin**: per the same source, EC's Howe
  Sound text forecast is the single best starting resource for today's
  Squamish wind. `generate.mjs` fetches two zones — Howe Sound and the
  Strait of Georgia south of Nanaimo — server-side only (no CORS for a
  browser fetch); the page links both as "Official marine forecasts" near
  the bottom, alongside a link to the [live Squamish wind
  meter](https://squamishwindsports.com/conditions/wind/). The bulletin text
  itself is fetched and stored but deliberately not shown inline — the app is
  mobile-first and deliberately keeps technical/official-forecast language
  out of the UI; the link is there for anyone who wants the official word.
- **Pressure gradient (MSLP)**: Squamish wind isn't purely thermal — it's
  also a function of the real sea-level pressure gradient along the
  corridor. Inspired by [kiteloop.vercel.app](https://kiteloop.vercel.app/)'s
  "MSLP — two pressure checks" panel, `generate.mjs` fetches forecast MSLP at
  three reference points (`PRESSURE_REFERENCE` in `assets/spots.js`:
  Pemberton for the interior, Vancouver for the coast, Point Atkinson for the
  Howe Sound mouth) and computes a large-scale (coast − interior) and a local
  (mouth − spot) gradient for any spot with `pressureGradientAware: true`.
  When both line up with the wind-speed signal it boosts confidence and says
  so; when they don't, it adds a caution note. This reads Open-Meteo
  *forecast* MSLP rather than kiteloop's live SWOB station observations, so
  treat it as an approximation of the same idea, not a reproduction of that
  site's exact numbers. See `classifyHour()` in `assets/rules.js`.
- **Solar loading**: `shortwave_radiation` from Open-Meteo replaces a flat
  cloud-cover-percent cutoff as the "is the sun actually driving the
  thermal" gate. Judged as a *ratio* against that hour's own clear-sky
  ceiling (`clearSkyRadiationWm2()` in `assets/rules.js`, a standard
  solar-elevation approximation) rather than one flat W/m² number — a flat
  cutoff quietly assumed it was always close to solar noon, so a genuinely
  clear evening session (naturally lower radiation simply because the sun is
  low, not because it's cloudy) used to get wrongly flagged as "not sunny."
  Falls back to the cloud-cover cutoff when a model doesn't provide
  radiation, and to "not sunny" once the sun is essentially down.
- **Wind direction averaging**: each model's direction is weighted by that
  same model's own wind speed (`circularMeanDeg()` in `assets/rules.js`)
  rather than averaged evenly — an unweighted average could invent a
  direction none of the models actually predicted (e.g. two near-calm
  readings from the north and two strong readings from the south averaging
  to due west, missing both real sectors).
- **Probability, as an open-ended floor**: every quick-pick button ("12+
  Sweet spot", etc.) asks "will it hit *at least* this many knots," not "will
  it land in this closed range." An earlier closed-band version scored 29kt
  the same as 0kt once it was outside the picked range — a real rider
  picked "12-20 Sweet spot," got a rock-solid 28kt Squamish afternoon, and
  nearly skipped it because the app showed 12-13%. See
  `probabilityInRange()` in `assets/rules.js`.
- **Best Bets ranked toward more wind**: among hours that clear the picked
  floor with good odds (≥65%), the ranking favors expected wind speed
  (weighted by confidence) over raw probability — a likely 28kt hour
  outranks a slightly-more-certain 14kt one. See `scoreHour()` in
  `index.html`. A separate "Windiest good bet" card above the ranked list
  ignores the picked floor entirely and always surfaces the single windiest
  favorable-direction hour across every spot for the selected day.
- **Plain-language summary + offshore warning**: every hour also gets a
  short, jargon-free `summary` string (shown in the hour-cell tooltip) —
  what kind of wind, plus a caution if the direction looks offshore/
  unfavorable or if it's likely to be gusty — separate from the detailed
  `reason` field (model spread, MSLP numbers, calibration factors), which
  stays internal to respect the app's no-jargon mobile UI. An
  offshore/unfavorable-direction hour also gets a visible ⚠️ badge and is
  excluded from the headline "best option" pick unless a spot has no
  favorable-direction hour at all that day.
- **Upper-level (850hPa) wind**: fetched alongside the surface data. Strong
  SW flow aloft during a thermal hour can override/suppress the local sea
  breeze rather than reinforce it — flagged as a confidence-lowering caution.
  Independent of regime, strong upper wind riding over a decent surface wind
  is flagged as **GUSTY** in the UI (hour cells and best-bets list).
- **Pam Rocks live nowcast**: two independent uses of the live Pam Rocks buoy
  reading, both restricted to whichever hour matches "right now" since it's
  a live observation, not a forecast time series:
  1. For Squamish Spit and Porteau Cove (`pamRocksAware: true`), it's
     projected onto Howe Sound's ~200° SW inflow axis and used to support or
     caution the current hour's thermal confidence. Sharpened with a
     specific, validated signal borrowed from an independent Squamish-Spit-
     focused forecast tool ([spitwind.ca](https://spitwind.ca/), checked
     Aug 2026): Pam Rocks reading 8-12kt specifically from the SSE ("the
     tell band") has historically preceded the Spit filling to rideable
     ~91% of the time, a sharper heads-up than the generic projection alone
     — and the inverse, a *strong* Pam Rocks reading from the west, is
     flagged as a "head-fake" (looks encouraging, often doesn't reach the
     Spit) rather than treated as generic support. We don't have a season
     of our own sensor history to independently derive these bands yet, so
     treat the specific thresholds as borrowed, not locally-validated —
     worth revisiting once our own live-verification log has enough depth.
  2. For Porteau Cove specifically (`pamRocksTrigger`), a plain threshold +
     direction check — per local rider knowledge, Pam Rocks reading 12kt+
     from the South/SE meaningfully raises the odds Porteau is working (up
     toward 20kt) even on an hour the model's own signals came up empty.
     Mirrors the reference-station trigger pattern used for Erwin Park, just
     sourced from a live buoy + direction instead of a forecast station.
- **Rider feedback loop**: see "Rider feedback & self-calibration" below —
  actual on-the-water reports nudge each spot's calibration over time,
  separately per wind regime (a thermal-hour mismatch no longer nudges that
  spot's outflow calibration, and vice versa).
- **Live verification**: see "Live verification" below — each run checks
  the forecast against a real observation from the nearest Environment
  Canada station and self-corrects when they disagree.
- **Two ways the page gets data**:
  1. `data/forecast.json` — a snapshot committed twice a day by the GitHub
     Action below. Loads instantly, includes the EC bulletin, MSLP gradient,
     and feedback-learned calibration.
  2. **Refresh live** button — fetches straight from Open-Meteo in the
     visitor's browser and recomputes on the spot (including the Squamish
     speed calibration), but not the EC bulletin, MSLP gradient, Pam Rocks
     nowcast, or feedback calibration, since those either need a server-side
     fetch (no CORS) or read a file the browser doesn't otherwise load. Shown
     with an honest yellow "Live (partial) — just fetched" badge rather than
     the green "fresh" one the regular snapshot gets, since this path is more
     *recent* but less *complete*. Also the automatic fallback if
     `data/forecast.json` doesn't exist yet.

## Local setup

```bash
# one-time
node --version   # need >=18

# generate a forecast snapshot
node scripts/generate.mjs

# preview the site
npm run serve   # http://localhost:8080
```

(`index.html` uses ES module imports, so it must be served over http —
opening the file directly with `file://` will not load the modules.)

## Deploying: GitHub Pages + your GoDaddy domain

This keeps `yourdomain.com`, costs nothing, and needs zero credentials
shared with anyone — GitHub's own Action commits the twice-daily snapshot.

1. **Create a repo.** On GitHub, create a new repository (e.g. `wind-guru`)
   and push everything in this folder to it:
   ```bash
   cd wind-guru
   git init
   git add .
   git commit -m "Wind Guru v1"
   git branch -M main
   git remote add origin https://github.com/<you>/wind-guru.git
   git push -u origin main
   ```
2. **Turn on Pages.** Repo → Settings → Pages → Source: "Deploy from a
   branch" → Branch: `main`, folder `/ (root)` → Save. GitHub gives you a
   `https://<you>.github.io/wind-guru/` URL — confirm the site loads there
   first.
3. **Run the forecast job once.** Repo → Actions → "Update wind forecast" →
   Run workflow. This populates `data/forecast.json` for the first time (it
   will otherwise wait for the next scheduled run, up to 12 hours away).
4. **Point your GoDaddy domain at Pages.** In GoDaddy → My Products → DNS
   for your domain, add:
   - If using the bare domain (`yourdomain.com`): four **A** records for
     `@` pointing to GitHub's Pages IPs:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - If using a subdomain (`wind.yourdomain.com`): one **CNAME** record for
     `wind` pointing to `<you>.github.io`
   - Either way, remove/replace any conflicting existing A/CNAME record on
     that same host name.
5. **Tell GitHub the custom domain.** Repo → Settings → Pages → Custom
   domain → enter `yourdomain.com` (or `wind.yourdomain.com`) → Save. Check
   "Enforce HTTPS" once the certificate provisions (can take up to ~24h).

DNS changes typically propagate within minutes to a few hours. From then on
the Action refreshes the forecast automatically at ~5am, ~1pm and ~5pm
Pacific with no further action from you.

### Adjusting the schedule

`.github/workflows/update-forecast.yml` runs on a fixed UTC cron, so it
drifts an hour in winter (PST vs PDT). If you want it exact year-round,
either accept the ~1hr drift or switch to `13:00`/`20:00`/`01:00 UTC` for the
winter months. The midday run was added specifically so the live-
verification loop (see below) has at least one comparison a day from
somewhere near peak thermal hours, not just the two calmest hours of the
day.

If a run fails to fetch most spots (Open-Meteo rate-limiting, an outage,
etc.), `generate.mjs` aborts without publishing anything rather than
overwriting `data/forecast.json` with a partial snapshot — the last good
snapshot stays live, and the failed Action run itself is a signal (GitHub
emails the repo owner by default on a failed scheduled workflow).

## App version

The footer shows which commit is actually live and when — e.g. "v3f9a21
deployed 2h ago" — separate from the forecast-freshness badge in the header
(that one tracks the *data*, this one tracks the *code*). Every push to
`main` that touches anything other than `data/` triggers
`.github/workflows/stamp-version.yml`, which writes the short commit SHA,
commit message, and a UTC timestamp to `data/version.json`. It's excluded
from re-triggering itself (and from the twice-daily forecast commits) via
`paths-ignore: data/**`. If the footer note is blank, that workflow either
hasn't run yet on this repo or is disabled — check the Actions tab.

## Editing the spot list

Open `assets/spots.js`. Each spot has coordinates, sports, a rideable
direction sector, and (if relevant) a `thermal` and/or `outflow` config with
the season/hour window/direction that pattern needs, plus a one-line
explanation shown to users. Add a spot by copying an existing entry; no
other file needs to change.

A spot can also define a `referenceStation` instead of (or alongside) its
own thermal/outflow config, for cases where a nearby exposed gauge point
predicts it better than local models do. Two modes, both in
`classifyHour()` (`assets/rules.js`):

- **`thresholdKt`** — a plain "did the reference station cross X" check: once
  it does, a calm/mixed hour gets upgraded (or, if the spot's own signals
  already found something, just gets a corroborating note).
- **`offsetKt` + `dirSector`** (used by Erwin Park) — for spots that move
  *with* the reference station at a fairly fixed offset rather than a simple
  on/off threshold. Erwin Park sits right next to Point Atkinson but, per
  local rider knowledge, typically reads about 4.5kt lighter than it on an
  East–Southeast wind — so this spot's estimate is `refSpeedKt + offsetKt`,
  gated to `dirSector` (the offset only holds for the direction it was
  observed under), and only overrides a calm/mixed regime once the estimate
  itself clears a 5kt floor.

`generate.mjs` and the live-refresh path both fetch the reference station
once and pass its speed into `classifyHour`.

Set `pressureGradientAware: true` on a Howe Sound spot to factor in the MSLP
gradient check described above.

Several spots also carry a `tide_note`, `current_note`, `direction_note`, or
`access_note` — documentation-only local knowledge (tide minimums, wind-vs-
current wave mechanics, graded favorability beyond the binary
`favorable_deg` check, launch-logistics caveats) that isn't wired into
`classifyHour()`, since this app doesn't track tide state or current at all.
They exist so the config is a complete record of what's known about a spot,
not just what the rule engine currently acts on — a rider is expected to
read and apply these manually. Good candidates for a future "does this spot
need tide data" pass.

## Environment Canada marine anchor

Added after a real miss on 26 August 2026: riders scored a 4m/5m session at
Erwin Park at 6am and the app had shown ~6kt for that hour, well below the
display threshold, so the spot never appeared. The forecast that *did* call it
was Environment Canada's — the Strait of Georgia bulletin issued the previous
morning read **"southeast 15 to 20 near midnight then diminishing to southeast
10 to 15 early Wednesday morning"**, which matches both the direction Erwin
works on (E–SE) and the riders' "it won't last too long". We had been fetching
that exact page since early on and only ever rendering it as a link.

EC marine forecasts are written by human forecasters and name the mesoscale
pattern explicitly — "southerly **inflow** 10 to 20", "northeasterly
**outflow** 5 to 15". That is precisely the signal a ~13km global model
flattens, which is why a rider checking EC beats a rider checking raw model
output on a gradient day.

How it works:

1. `extractMarineSection()` in `generate.mjs` pulls the page's dedicated
   **Winds** section (cleaner than the combined "Marine Forecast" section,
   which mixes in sky/fog prose that would confuse the number regexes). It's
   text-anchored rather than tag-anchored, same philosophy as the wtfbc.ca
   parser — verified against live fetches of both zone pages.
2. `parseMarineWindText()` in `assets/rules.js` splits the paragraph on EC's
   transition markers (`then`, `becoming`, `increasing to`, `diminishing to`)
   into segments, each carrying direction, knot range, `inflow`/`outflow`
   regime, and a timing phrase mapped to an hour window. `except ... over
   southern sections` sub-area caveats are split out and never used as the
   zone's main value.
3. `marineAnchorForHour()` picks the segment covering a given hour.
4. `classifyHour()` applies it **only when EC's direction falls inside that
   spot's own `favorable_deg`**, and **only ever upward**. An EC zone forecast
   describes open water across a whole marine area, so a sheltered beach
   reading lighter than EC is normal and not evidence of an error; a spot
   *exposed* to the forecast direction reading far below EC is the signature
   worth catching. The anchor value is the **midpoint** of EC's range (its low
   end alone is too conservative to move a badly under-read hour), scaled by an
   optional per-spot `marineAnchorFactor` for spots that genuinely run lighter
   than open water.

Each spot declares which zone it belongs to via `marineZone`
(`howe_sound` or `strait_of_georgia_south`).

**Changed Sep 28 2026: EC is now a note, not the number.** Anchored hours ran
about 4kt high with 75% of their 12kt calls failing over six weeks, and on
Sep 28 the floor put 16kt on White Rock East all afternoon while every model
said 4 to 9kt. Now, when EC is 4kt+ stronger than the models for a
direction the spot works on, the hour carries `marine_ec` (range, floor,
gap), the card says "Environment Canada calls ... stronger than the models
here", and the probability band widens toward EC (sigma at least gap / 1.5,
which gives roughly the 25% hit rate the old floor actually had), but the
number stays the models'. `marine_anchored` is always false now.

## Live reference-station trigger

Also added after the Erwin miss. The `referenceStation` mechanism described
above reads Point Atkinson's *forecast*, which on a gradient morning is
under-read by exactly the same coarse models that under-read the spot itself.
Riders don't do that — they read the live meter:

> "Point Atkinson 21kts now, will head to Erwin if it holds" · "Head to Erwin
> once it hits 20 knots" · "Erwin must be on. Point Atkinson is 23kts" · "Will
> try Erwin later. Once it stays above 19 knots"

Four independent reports converging on ~19–21kt, which is where Erwin Park's
`liveReferenceTrigger.thresholdKt` comes from. We were already fetching Point
Atkinson's live reading (it's Erwin's `liveStation`) but only using it for the
verification badge and the calibration log — it had no path to lift the
forecast. Now it does, for the current hour only, same caveat as the Pam Rocks
trigger. Tagged `live_reference_triggered`, confidence floor 80% — the highest
of any signal, because it's an actual observation rather than a forecast.

## Rider feedback & self-calibration

Tapping "Report actual conditions" on any spot card, or on an hour cell's
tooltip, opens an in-page popup — two number inputs (actual sustained
speed, and optional gust), everything else pre-filled from context. Submit
posts to a small Cloudflare Worker (`worker/index.js`, see
`worker/README.md` for deploy steps) that files it as a GitHub issue
server-side, labeled `wind-report`, in the same format
[`.github/ISSUE_TEMPLATE/wind-report.yml`](.github/ISSUE_TEMPLATE/wind-report.yml)
produces — so a report from the popup and one filed by hand through the
GitHub form are indistinguishable to everything downstream. This exists
because GitHub Pages has no server of its own to receive a submission
directly; the Worker is the one small always-on piece that lets a visitor
report without a GitHub account or leaving the page. If the Worker is
unreachable, the popup falls back to the original GitHub-issue-form link
rather than failing silently.

Every run, `.github/workflows/update-forecast.yml` first runs
`scripts/apply-feedback.mjs`, which:

1. Pulls **open** `wind-report`-labeled issues via the GitHub API (closing an
   issue now retires it from calibration — previously `state=all` meant
   closing a bogus report did nothing), rejecting any report whose
   forecasted/actual values fall outside a loose sanity range (catches
   typos like "actual: 300kt" automatically), and pools in
   `data/live-verification-log.json`'s entries too (see "Live verification"
   below — every qualifying comparison is logged there now, not just
   mismatches). Reported gust (if given) is captured but not yet fed into
   calibration — display gust is still fabricated as speed×1.3 everywhere
   (see `assets/rules.js`); a season of real rider-reported gusts is now on
   hand for whenever that's worth revisiting.
2. Groups them by spot and computes `actual ÷ forecasted` for each report —
   both into a spot-wide **general** bucket (rider reports and live-station
   entries alike), and, for live-station entries specifically (they carry a
   `regime` tag from the forecast hour they were checked against), into a
   **regime-specific** bucket (`thermal` / `outflow` / `synoptic` / ...) for
   that spot. Rider reports don't record which regime was in effect, so they
   only ever feed the general bucket.
3. Averages the most recent 20 data points per bucket with a **weighted
   geometric mean** (needs at least 2 points before it adjusts anything, so
   one troll report or typo can't skew it) — geometric rather than
   arithmetic so two equal-and-opposite misses cancel out to "no adjustment
   needed" instead of biasing upward, and weighted so a rider's own
   eyes-on-the-water report (3x) isn't drowned out by the now much more
   frequent automated station checks (1x each, since the live-verification
   loop logs every comparison, not just mismatches) within the 20-point
   recency window. Clamps the result to 0.75x–1.5x, and writes
   `data/calibration-overrides.json` as `{ spot: { general: {...}, thermal:
   {...}, ... } }`.
4. Separately computes a sitewide **forecast accuracy** figure — the % of
   rider reports (rider reports only, not the automated station checks
   above) whose actual speed landed within 3kt of what was forecasted —
   and writes it to the same file as `accuracy: { tolerance_kt, sample_size,
   hit_rate }`. Stays `null` (and the page shows nothing) until there are
   at least 10 rider reports, so an early 1-2 report figure never gets
   published. `generate.mjs` passes this through unchanged into
   `forecast.calibration_overrides.accuracy`, which the page reads to show
   the 🎯 badge in the header ("82% accurate within 3kt (47 reports)").

`generate.mjs` reads that file and, once it knows which regime an hour
classified as, resolves that regime's bucket for the spot — falling back to
`general` if there's no regime-specific data yet — and applies its
multiplier on top of everything else (Squamish calibration, MSLP, reference
stations, Pam Rocks nowcast), scaling both the displayed speed and the model
votes used for probability. A thermal-hour mismatch no longer nudges that
spot's outflow calibration, and vice versa. The reasoning text says
explicitly when a report-based adjustment is active.

This is a running bias correction, not a trained model — it has no memory of
what was forecasted for any specific past hour (the snapshot gets
overwritten twice daily), so it can't compute true forecast-error stats. It
can only say "actual wind at this spot has been averaging X% of what we
showed, across recent reports" and nudge accordingly. A more rigorous
version would archive each day's forecast.json (e.g. to a `history/` folder
or a proper database) so `apply-feedback.mjs` could match each report
against what was actually predicted for that exact hour, rather than
against whatever number the reporter copied down.

To recalibrate manually: `GITHUB_TOKEN=<a token with repo:read> node scripts/apply-feedback.mjs`
(a token isn't required for a public repo, just raises the API rate limit).

## Live verification

Every spot has a `liveStation` (see `assets/spots.js`) — a source of
genuinely *observed* wind, not a forecast. Three source types:

- **`type: "squamishwindsports"`** (Squamish Spit): the JSON
  feed behind [Squamish Windsports Society's live wind
  chart](https://squamishwindsports.com/conditions/wind/)
  (`squamishwindsports.com/wind-data/getmet.php?wind_src=spit&...`), found
  by inspecting that page's network requests — no API key, reports in knots
  already, includes gust. This is a real instrument at the Spit itself, and
  per local rider feedback is far more representative of the corridor than
  Environment Canada's Squamish Airport station, which sits in a wind
  shadow and is no longer used for anything.
- **`type: "igetwind"`** (Porteau Cove, Boundary Bay, White Rock East,
  Crescent Beach, Tsawwassen South, Erwin Park, Garry Point):
  [igetwind.com](https://igetwind.com/)'s station-finder API
  (`igetwind.com/api/lw/stations/{lat}/{lon}/{radiusKm}/0`), also found
  by inspecting network requests — public, no key needed, aggregates METAR
  airports, marine buoys, and citizen weather stations. We pin a *specific*
  known-good `sid` per spot rather than auto-picking "nearest" every run
  (a lot of what it returns is unstaffed citizen hardware not worth
  trusting unattended):
  - Porteau Cove → **Pam Rocks** (`CWAS`), a Coast Guard station right at
    the Howe Sound entrance — a better read on Porteau's more open exposure
    than the Spit meter would be, even though it's ~10km away.
  - White Rock East → **White Rock, BC** (`CWWK`), the official METAR
    station — effectively co-located with this spot.
  - Boundary Bay, Crescent Beach, and Tsawwassen South also reuse the same
    White Rock station as the nearest available official reading, since
    there's nothing closer confirmed yet — a rougher approximation for these
    three the further they sit from White Rock itself (Tsawwassen South is
    the roughest, ~19km away). See "Known limitations" below.
  - Erwin Park → **Point Atkinson** (`CWSB`), a couple km away — swapped in
    once Erwin Park's location was corrected to be right next to Point
    Atkinson (it previously, incorrectly, shared the White Rock station
    ~45km/~23km away from where it was thought/actually located). Doubles as
    the `referenceStation` used for Erwin Park's offset-based estimate — see
    "Editing the spot list" above.
  - Garry Point → **Sand Heads** (`CWVF`), the Coast Guard lightstation right
    at the mouth of the Fraser's South Arm, a few hundred meters offshore —
    swapped in from the YVR airport EC station per North Shore Wing Group
    local knowledge (riders there already use Sand Heads as their own
    go/no-go read for this spot). `sid` inferred from the "CW-" station-ID
    naming pattern shared by the other igetwind stations above, not
    independently confirmed against a live igetwind response — if it doesn't
    match, this live check just silently stays unavailable, same defensive
    fallback every igetwind station uses.
  - Speeds arrive in m/s and get converted to knots (`×1.943844`). The
    observation time was previously passed through as raw UTC and displayed
    as if it were Pacific local — off by 7-8 hours whenever it was actually
    shown; now converted properly.
- **`type: "ec"` (default)** (Jericho - Spanish Banks, Dundarave Pier Beach,
  Ambleside): the nearest Environment Canada station with a
  [Past 24 Hour Conditions](https://weather.gc.ca/past_conditions/index_e.html)
  page — all three currently share the same Vancouver Harbour station
  (`whc`).

Each run, `generate.mjs`:

1. Fetches that station's most recent observation (speed + direction, and
   gust for the squamishwindsports/igetwind sources). Applied uniformly
   across all three source types: observations older than 3 hours are
   discarded as stale rather than treated as "live" (previously only the
   igetwind source checked this — a frozen EC or Squamish Windsports sensor
   could otherwise read as live indefinitely).
2. Compares it against what the model forecasted for that same current hour
   — but only once the forecast itself is at least **8kt** (was 2kt).
   Below that, every comparison was effectively a near-calm-hour reading
   from one of the day's two (now three) snapshot times, which is mostly
   noise (a 1kt miss on a 2kt forecast reads as "50% error") and was
   quietly teaching the calibration loop the wrong lesson.
3. Shows the result as a small badge on that spot's card (green if they're
   within 20% of each other, red if not, with the reasoning on hover), with
   staleness-aware wording — "right now" only when the observation is
   recent, "as of HH:MM" once it's more than 90 minutes old.
4. Logs **every** qualifying comparison (not just 20%+ mismatches) to
   `data/live-verification-log.json`, capped at the 40 most recent entries
   per spot — mismatches also get a reasoned explanation via
   `explainMismatch()` in `assets/rules.js`. Previously only mismatches were
   logged, which meant the calibration multiplier could never converge back
   toward 1.0 even once a spot's forecast was accurate again: every data
   point that ever made it into the log was, by definition, a bad one.

Squamish is also referenced on
[iKitesurf/Weatherflow](https://wx.ikitesurf.com/spot/1436) (linked in the
header), which several riders trust — but that data sits behind a paid
subscription. Automating it would mean storing your personal login/API
token as a GitHub secret and using your paid access on a public,
unattended schedule, which isn't something to do without a deliberate,
separate decision on your part (and I won't handle account credentials
directly either way — see the app's safety guardrails). It's linked as a
manual reference only; if you'd like to pursue an authenticated feed later,
iKitesurf/Weatherflow's developer docs are the place to check for an
official API and its terms.

`apply-feedback.mjs` reads that log on its *next* run (it runs before
`generate.mjs`, so the correction lands within one cycle — up to ~12 hours)
and pools it with rider reports for the same spot when computing the
calibration multiplier, exactly like a "Report actual conditions" issue
would. The `note` field in `data/calibration-overrides.json` shows how many
of each type went into a given spot's multiplier.

Same anti-overfitting rule as rider feedback: a spot needs at least
`MIN_SAMPLES` (2) combined data points before anything adjusts, and the
multiplier is clamped to 0.75x–1.5x, so a single bad reading (a gust,
a stale station, a parsing hiccup) can't swing the whole spot.

Limitations: station locations are the *nearest available* observation
point, not co-located with the spot itself (see each spot's `liveStation`
comment in `spots.js`) — treat the comparison as an approximation, most
trustworthy for the Squamish Spit, Porteau Cove, White Rock East, Garry
Point, and Erwin Park (all on-site or near-on-site instruments) and
roughest for Tsawwassen South (~19km from the White Rock METAR it, Boundary
Bay, and Crescent Beach all currently share — see "Live verification"
above). igetwind's citizen-station data also isn't independently audited —
we only pin official government stations from it (Pam Rocks, White Rock
METAR, Point Atkinson, Sand Heads), not the amateur ones it also returns. It
only checks the current hour once per run (twice daily), not a continuous
stream, so it can catch a systematic bias but won't catch a mismatch that
starts and ends between runs.

## Live surface conditions board

Below the hour-by-hour spot cards, the page shows a grid of real-time
station readings from around the region — not a forecast, just "what's the
wind doing right now" at as many nearby stations as we can reasonably show.
Two sources feed it, merged in `generate.mjs`:

1. **Our own live stations** — every spot's `liveStation` (see "Live
   verification" above), one card per unique station even where several
   spots share one (e.g. Jericho - Spanish Banks, Dundarave Pier Beach, and
   Ambleside all read "Vancouver Harbour").
2. **[wtfbc.ca/swob.php](https://wtfbc.ca/swob.php)** — "Weather Talk For
   BC," a BC windsports community forum, runs a page that aggregates live
   surface observations from ~11 stations across the region (mostly
   Environment Canada SWOB stations, plus a couple of independent sources
   like the White Rock city beach sensor and the Jericho Sailing Centre
   Association's own instrument) into one clean, already-in-knots page —
   confirmed by cross-checking its Pam Rocks reading against the raw EC
   SWOB-ML XML feed for that station. One fetch here gets a much wider
   regional picture — Tsawwassen, Sandheads, Vancouver International,
   Point Atkinson, Squamish Airport, Whistler, Merritt, Nanaimo — than our
   own per-spot stations alone cover.

`parseSwobBoard()` in `generate.mjs` doesn't depend on wtfbc.ca's exact HTML
structure — it normalizes the page to plain text and scans for the
repeating 3-line pattern each station renders as (name[, temp], a
distinctive date/time line, then direction + speed[+gust]), so it stays
robust even if the surrounding markup changes. If it ever parses fewer than
3 stations, it logs a warning and returns nothing rather than publishing a
broken/partial board.

The one overlap between the two sources — Pam Rocks, which is also our own
Porteau Cove `liveStation` — is deduplicated in favor of our own reading
(it already has staleness handling), so the same physical station never
shows two slightly different numbers side by side.

This board is server-side-only, like the marine bulletin and MSLP data
(wtfbc.ca doesn't offer CORS for a browser fetch) — it's absent from the
"Refresh live" client-side fallback path, and only updates on the regular
twice(-now-thrice)-daily Action run.

## Sep 25 2026 case study: the epic Steveston morning we missed

On Friday Sep 25 2026 Guillermo had his best ever session at Steveston
(Garry Point) around 9:40am, then an excellent one at Jericho at 1:24pm. Our
forecast that morning showed Garry Point at 2 to 5kt for 7 to 10am. What
actually happened:

| Local time | Sand Heads (EC) | Steveston tide | Our 7:52am forecast, Garry Point |
|---|---|---|---|
| 7am | NW 18 | 2.8m falling | 1.9kt |
| 8am | NW 14 gusting 22 | 2.4m falling | 2.6kt |
| 9am | NNW 21 gusting 26 | 2.0m falling | 3.6kt |
| 10am | NNW 21 gusting 27 | 1.5m falling | 5.4kt |
| 11am | NW 24 gusting 31 | 1.2m falling | 6.6kt |
| 12pm | NW 24 gusting 30 | 1.1m (low 11:44) | 8.5kt |
| 1pm | NW 22 | 1.4m rising | 9.6kt |

A post frontal NW surge ran down the Strait (EC strong wind warning,
"northwest 20 to 30 this morning"; Point Atkinson pressure climbing from
1004 to 1010 hPa through the day) while the ebb, plus the river, ran straight
against it. Five separate problems stacked up:

1. **The forecast point was on land.** Every model's grid cell at the beach
   is a land cell, and land roughness cuts the wind hard. The same day before
   model runs gave ECMWF 3 to 4kt at the beach cell for 9 to 10am and 19 to
   21kt over the water 5km offshore; GEM and GFS showed the same pattern.
   Fix: `modelPoint` in spots.js (forecast for the water riders are on),
   and `excludeModels: ["icon"]` for Garry Point, since ICON's cell there is
   land even at Sand Heads.
2. **The EC anchor ignored which day a phrase named.** The bulletin's last
   clause, "becoming light Saturday morning", overwrote "northwest 20 to 30
   this morning" for Friday's hours, so the anchor built for exactly this day
   never fired. The same bug fired a bogus 17kt at Jericho the day before
   (Thursday), from a "Friday morning" clause. Fix: the parser now puts every
   clause on a real date and hour resolved from the bulletin's issue time,
   and each condition holds until the next clause starts
   (`parseMarineWindText`, `marineAnchorForHour`).
3. **Sand Heads was already blowing 20kt at 7am** when the 7:52am forecast
   ran, and nothing used it. Fix: a Sand Heads `liveReferenceTrigger` for
   Garry Point, carried two hours forward and fading back to the models.
4. **The calibration had learned to distrust wind.** Live checks were only
   logged when we forecast 8kt or more, so a miss like this one (forecast 2,
   actual 20) was never recorded, and nearly every spot drifted down to the
   0.75 floor. That multiplier also scaled EC anchored hours (cutting Garry
   Point's anchored morning a further 23%). Fixes: log a check when either
   side shows real wind; compare against the model blend; ignore live checks
   before 2026-09-27 (`LIVE_STATION_EPOCH`); reset Garry Point's history for
   its new forecast point (`calibrationSince`); never apply the multiplier to
   anchored or observed hours.
5. **NNW counted as a bad direction** at Garry Point. Fix: favorable sector
   widened to 345°.

Replaying Sep 25 through the new logic (same inputs the runs would have had)
gives Garry Point ~22kt NW for 7am to 2pm on the morning run and ~22kt for
9 to 11am on the evening before run, with a "Possible epic day" window flagged
both times (7 to 11am and 9 to 11am). Jericho with EC's "near Vancouver"
wording reads ~12kt against an observed 11 to 17.

### Possible epic day

A spot can carry an `epicSignature` (spots.js): direction sector, minimum
wind, tide state, time window and minimum run length, all of which must hold,
with the wind backed by EC, a live reading, or at least two models. The first
one is Garry Point's: NW to NNW 17kt+, falling tide, 7am to 5pm, 2+ hours.
Tide comes from DFO's public tide API (`tideStation`, see "Tide stations")
and is shown in each hour's popup. Only the scheduled server run computes tides and
epic windows; the "Refresh live" button doesn't.

## Models, weighting and agreement (Sep 2026)

We request every model Open-Meteo has with real data for this area (16
sources, see `MODELS` in rules.js): HRRR 3km (inside the GFS blend for its
first ~60h), HRDPS 2.5km (inside the GEM blend for ~54h), NAM 3km, HRDPS West
1km, NBM 2.5km, GEM Regional 10km, ECMWF 9km, UK Met Office 10km, and the
global runs (ECMWF 25km, GFS 13km, ICON 13km, GEM Global, ARPEGE, JMA, CMA,
ECMWF AIFS). HRW 3km isn't available from Open-Meteo.

Scored against Sand Heads on Sep 25 2026, the 3km and finer models were
within ~3 to 6kt and the coarse globals off by ~10kt; an equal average of all
of them was worse than the 3km models alone. So the blend is weighted 6x for
3km and finer, 2x for ~10km regional, 1x for coarse global: every model still
counts, the high resolution ones lead.

**Update after the year back test (Sep 27 2026):** the headline number now
comes from the mean of NBM 2.5km and HRDPS West 1km (NAM 3km and HRDPS 2.5km
when neither has a value, then the weighted mean above), `LEAD_MODELS` in
rules.js. Over six weeks NBM had the smallest error of all 16 models and
HRDPS West was next; over a year one of the two was best or within 0.3kt of
best at every station. All 16 still feed the agreement rule and the
uncertainty band. Spots with a learned correction (next section) use that
instead.

## Learned corrections (MOS), Sep 2026

A year of day before model runs (Open-Meteo previous runs archive, Sep 2025
to Sep 2026) was scored against Environment Canada's hourly climate data at
Sand Heads, Point Atkinson, the Tsawwassen Ferry Terminal and Pam Rocks.
Findings: no single model is best everywhere (NBM at Sand Heads and Pam
Rocks, HRDPS West at Point Atkinson, HRDPS at the Ferry Terminal), every
model reads Pam Rocks 4 to 5kt light, and a small linear blend fitted per
station beats every single model by a wide margin. Scored leave one month
out (each month predicted by a fit that never saw it), 12kt+ hours:

| Station (spot) | Typical miss | Windy hours caught | False alarms | Brier (climatology) |
|---|---|---|---|---|
| Sand Heads (Steveston) | 2.8kt | 64 to 71% | 20 to 22% | 0.11 (0.21) |
| Point Atkinson (Erwin, minus 4.5kt) | 2.7 to 3.2kt | 49 to 53% | 21 to 25% | 0.08 (0.15) |
| Ferry Terminal (Tsawwassen) | 2.7kt | 49 to 63% | 23 to 28% | 0.08 (0.13) |
| Pam Rocks (Porteau, via the rule) | 3.4 to 3.6kt | 47 to 56% | 26 to 29% | 0.10 (0.16) |

The probabilities are calibrated: at Sand Heads, hours given 0 to 20%,
20 to 40%, 40 to 60%, 60 to 80% and 80 to 100% verified 7%, 29%, 47%, 73%
and 91% of the time. Replaying Sep 25 2026 from the evening before, the
blend alone (no EC anchor, no live reading) gave 13kt at 7am rising to 19 to
24kt from 9am to 2pm (Sand Heads: 18, 14, 21, 21, 24, 24, 22) and flagged
the 9 to 10am epic window.

How it works: inputs are NBM, HRDPS 2.5km, HRRR, ECMWF 25km and GEM
Regional at the exact training point, plus the NBM and HRDPS mean wind
vector and the hour of day. Past ~48h, when HRRR and HRDPS end, it drops to
NBM + ECMWF + GEM Regional, then NBM + ECMWF + GFS, then ECMWF + GFS, each
with its own fit. The error model (typical miss grows with speed) sets the
probability band, widened a little with lead time. Output is capped at 2.2x
the strongest input plus 3kt so an unusual hour can't extrapolate wildly.
Coefficients: `data/mos-coefficients.json`. For these spots the EC marine
anchor becomes a note (it ran +4.3kt high with 75% false alarms over six
weeks) and the rider feedback multiplier is not applied (the blend is
already bias corrected against a year of data).

**Porteau:** the blend forecasts Pam Rocks and Guillermo's rule turns it into
Porteau: an inflow (Pam Rocks from 130 to 230 degrees) needs 14kt+, an
outflow (320 to 50 degrees) needs 25 to 30kt+. The estimate is shifted so
the rule's threshold lands on 12kt (14 inflow = 12, 25 outflow = 12, 30
outflow = 17), so the 12kt+ odds are exactly the odds Pam Rocks clears the
rule. The same rule is applied to the live Pam Rocks reading for the
current hour. Forecast directions use slightly wider sectors (125 to 245,
295 to 65) because that's how the models' own direction sees those flows.

**Nightly scoring and monthly refit:** `.github/workflows/mos-nightly.yml`
runs `scripts/mos-train.mjs auto` at 3:40am: it scores the last 30 days
(written to `data/mos-score.json` and shown under "How this works") and on
the 1st of each month refits on the last 365 days, keeping the old fit if
the new one is clearly worse. `node scripts/mos-train.mjs fit` refits by
hand.

Not yet covered: Squamish (the Spit meter has history by date on
squamishwindsports.com, a good next fit), Jericho (the English Bay buoy
isn't in EC's climate archive), and the South Delta beaches.

**Recent correction (added Sep 27 2026):** each night `mos-train.mjs score`
also writes `data/mos-recent.json`: the blend's average miss over the last 7
days (hours where the forecast or the reading was 6kt+, shrunk when there are
few hours, capped at ±2kt), applied as an offset, and a spread factor (1 to
1.5x) if the last 30 days missed by more than the error model expects. It's
ignored if more than a week old. Replaying the year with each day corrected
only from the days before it: probability score better at every station (1 to
3% over the year, 7 to 8% at Sand Heads and Point Atkinson over the last
month), typical miss unchanged. The spread factor rarely triggered and was
neutral. At Sand Heads this September the middle odds ran generous (said
about 50%, happened about 25%) even after the offset, which neither fix
changes; worth watching in the nightly score.

## Live stations (Sep 2026)

Per Guillermo: Tsawwassen South reads EC's Ferry Terminal station (`vtf`);
White Rock East Beach and Crescent Beach read the City of White Rock's East
Beach sensor (the JSON behind maps.whiterockcity.ca/weather, in knots);
Jericho reads the English Bay buoy (EC 46304) first and the Jericho Sailing
Centre sensor (from wtfbc.ca's board) when the buoy has nothing fresh;
Boundary Bay has no live station and relies on rider reports. The White
Rock METAR (CWWK, max 6kt in six weeks) and wtfbc's Tsawwassen Ferry Auto
copy (mostly zeros) are retired. Calibration history for the spots whose
station or forecast changed starts over on Sep 28 2026 (`calibrationSince`).

## Swell index (Sep 2026)

Guillermo's rule: wind blowing 4 hours or more with the tide against it
builds swell; at Squamish it's mostly fetch and time (25 to 30kt for 3 hours
gives the biggest swell). `swellForHours()` in rules.js, per hour:

1. How long the wind has blown from about this direction (10kt+, within 45
   degrees) and the open water upwind (`swell.fetchKm` per spot, by wind
   direction; rough map estimates).
2. Wave height and period from the standard fetch and duration growth curves
   (Shore Protection Manual). NW 21kt for 3 hours gives ~0.8m at 3.7s, which
   is what the MFWAM wave model showed at Sand Heads on Sep 25 2026.
3. The tide: rising is the flood, falling the ebb (DFO), and `currents` says
   which way the water flows on each at that spot. Against the wind (120
   degrees or more apart) steepens the waves up to ~1.4x on a strong tide;
   with it flattens them up to ~15%. Steveston's ebb gets a 1.3x boost for
   the Fraser.

Current directions from Guillermo (the direction the water flows toward):
Squamish and Porteau flood north, ebb south; Jericho, Steveston, Erwin Park,
Dundarave, Ambleside and Cates Park flood east, ebb west; Boundary Bay, White Rock East,
Crescent Beach and Tsawwassen South flood north, ebb south.

Labels: flat (under 0.25m), chop, waves (0.5m+), good swell (0.9m+). Hours
with waves or better get a 🌊 on the hour, the popup gives the height in feet
and metres with the period and why, and each card names the day's best wave
window. Replaying Sep 25 at Steveston: good swell 9 to 10am (3.2 to 4.4ft,
NW against the ebb, 4h of wind at 10am), easing once the tide turned.
"Report actual conditions" now has an optional Waves field (flat, chop,
waves, good swell) so the fetch and current numbers can be tuned; the
Cloudflare Worker needs redeploying (`wrangler deploy` in worker/) for it to
reach the issue.

## Marine forecast and tides on the page

The EC marine forecast for Howe Sound and the Strait of Georgia (south of
Nanaimo) is shown in full: any warning, the winds as EC wrote them with the
issue time, and the extended outlook. Each spot card shows that day's high
and low tides (time and height in feet) from its tide station (DFO
`wlp-hilo`).

**Agreement rule (Guillermo's):** when the models land on the same speed,
within about 15%, it's normally a good forecast. `modelAgreement()` measures
the share of model weight within ±15% of the weighted median; 80%+ from 4 or
more models marks the hour `models_agree`, which raises confidence and
narrows the probability band. The hour shows a ✓ and says so in its popup.

## Tide stations

Always the nearest DFO station to the spot, except Steveston, which uses
Tsawwassen (Guillermo: better for Steveston and south; the Steveston gauge
sits in the river mouth and reads ~0.6m lower and ~20min later than the
coast). Squamish and Porteau: Darrell Bay. Jericho: Point Atkinson. Erwin
Park: Sandy Cove. Ambleside and Dundarave: Ambleside. White Rock, Crescent
Beach: their own stations. Boundary Bay, Tsawwassen: Tsawwassen. Cates
Park: Deep Cove (Second Narrows has no predictions). The North
Shore stations read within ~0.05m of Point Atkinson.

## Cates Park Boat Launch

Added Oct 2026 at Ivan Dianov's request, for wing foil and windsurf. The
launch is the Cates Park boat ramp on the north shore of Burrard Inlet.
Directions per Guillermo: best on W and SW, E and SE can work, anything with
north in it is offshore (favorable arc E through W). Floods east, ebbs west.
Fetch is short (about 6km down the inlet on a west wind), so expect chop
rather than swell. No live station yet: VA7IS in North Vancouver read near
zero on a 10 to 13kt westerly. No water forecast point is needed (the ramp
and mid channel share a model cell), and no EC marine note, since the Strait
of Georgia forecast doesn't describe the wind this far up the inlet. Tide
limits for the launch are still to confirm with Ivan.

## Known limitations / good next steps

- Tide state and current isn't factored in, even though it matters a lot at
  several spots — see each spot's `tide_note`/`current_note` in
  `spots.js` for the specifics (White Rock East and Crescent Beach both need
  a tide under ~12ft to kite-launch; Boundary Bay needs 10ft+ for foil
  sports; Tsawwassen South needs 8ft+; Garry Point, Dundarave Pier Beach, and
  Ambleside all get their best waves when the wind opposes an ebbing
  current). All currently have to be applied manually against a tide table
  rather than by the model.
- The EC marine bulletin is now parsed and used as a forecast anchor (see
  "Environment Canada marine anchor" above), not just linked. Remaining gap:
  the anchor is applied per-hour from EC's timing phrases ("near noon", "early
  Wednesday morning"), which is a best-effort mapping of prose to hour windows
  — an unusual phrasing EC hasn't used before will simply not match any window
  and fall back to the opening clause, rather than being mis-timed.
- The base Squamish 2.85x multiplier (now capped/tapered above 32kt, see
  above) is still a single rider's field-tuned average, not a regression
  against station data — the regime-aware feedback override (see "Rider
  feedback & self-calibration") corrects it over time as
  live-verification/rider data accumulates, but needs more samples per
  regime before it meaningfully moves the number. Treat the base multiplier
  as a big improvement over raw model output, not gospel.
- The Pam Rocks nowcast and 850hPa suppression/GUSTY thresholds (6kt inflow
  component, 20kt suppression, 25kt gusty), the solar sunny-ratio cutoff
  (45% of clear-sky), and the probability-band sigma constants are all
  reasonable starting guesses, same caveat as the MSLP thresholds below —
  not fitted to anything yet, worth tightening once enough rider feedback
  accumulates to see which days/hours it called right vs wrong.
- The MSLP gradient thresholds (0.4hPa / 0.2hPa) are a reasonable starting
  guess, not fitted to anything — worth tightening once enough rider
  feedback accumulates to see which days it called right vs wrong.
- See "Rider feedback & self-calibration" above for the feedback loop's
  current limitation (no historical forecast archive to compare against).
  Live verification (see above) partially addresses this for the *current*
  hour only — it still can't check how a forecast made 3 days out held up.
- Live-station comparisons use the nearest EC/igetwind station, not a
  station at the spot itself — see "Live verification" above for which
  spots share a station and how far it might be. White Rock East, Boundary
  Bay, Crescent Beach, and Tsawwassen South all currently share the same
  White Rock METAR station (co-located for White Rock East, up to ~19km away
  for Tsawwassen South) — one bad or unusual reading there skews all four
  spots' live checks at once. Splitting or weighting that shared station is
  a good next step. Jericho - Spanish Banks, Dundarave Pier Beach, and
  Ambleside likewise all share the Vancouver Harbour EC station. (Erwin Park
  and Garry Point don't share a station with anything else — they use Point
  Atkinson and Sand Heads respectively, per their corrected/refined
  locations.)
- A trigger-fired hour (reference-station or Pam Rocks threshold) shows a
  fixed floor value, not a real per-hour model estimate — `probabilityInRange`
  now uses a wider base sigma for these hours so they don't read as more
  certain than they are, but the displayed speed itself is still just the
  trigger's threshold/floor number, not a genuine forecast magnitude.
- Gust is estimated rather than taken from the models directly for
  calibrated-thermal and trigger-fired hours (where there's no trustworthy
  per-hour model gust value to lean on); every other regime uses the
  models' own gust forecast. For calibrated Squamish-family thermal hours
  specifically, this is now a direction-aware multiplier (~1.21x on-axis, up
  to ~1.36x drifting west — see `calibratedGustMultiplier()` in
  `assets/rules.js`, borrowed from spitwind.ca's stated gust-spread stats,
  same "not locally-validated yet" caveat as the Pam Rocks tell above);
  trigger-fired hours (reference-station, Pam Rocks threshold) still use a
  flat 1.3x, since those are a different mechanism (a floor value
  substituted in, not a genuine per-hour estimate) with no comparable
  direction-specific data behind them.
- `forecast.json` includes all 24 hours/day even though the UI only ever
  displays 06:00-20:00 — trimming the unused hours (and any other
  browser-unused fields) before writing would meaningfully shrink both the
  payload and the git history growth rate. Not done this session to keep
  the change surface focused on forecast-accuracy fixes.
- No automated CI check that the committed `data/forecast.json` snapshot's
  spot list matches `assets/spots.js` (would have caught the removed
  `furry-creek` spot lingering in an old snapshot) or that speeds/hour
  counts are in a sane range.
- The Leaflet CDN `<script>`/`<link>` tags don't have Subresource Integrity
  hashes — this session didn't have a way to fetch the exact CDN bytes to
  compute a trustworthy hash (and a wrong hash silently breaks the map for
  every visitor, worse than no hash at all), so this needs a manual step:
  generate the hashes at [srihash.org](https://www.srihash.org/) for
  `https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css` and
  `.../leaflet.min.js`, then add `integrity="..." crossorigin="anonymous"`
  to both tags in `index.html`.
- Rider-report parsing in `apply-feedback.mjs` is coupled to the exact field
  label text in `wind-report.yml` (`extractField(body, "Forecasted speed
  (kt)")` etc.) — renaming a form label without updating the parser would
  silently stop new reports from being read.
- `confidence` is computed per-hour but not shown anywhere in the UI — a
  70% that's backed by four agreeing models currently looks identical to a
  70% that's internally flagged as low-confidence (no pressure support,
  upper-level suppression, etc).
- Outflow classification doesn't yet factor in season or pressure strength —
  a light summer morning northerly gets the same "can be strong and gusty"
  language as a genuine winter outflow event.
- No "now" marker or dimming of past hours in the hour-by-hour strip.
- The live surface conditions board depends on scraping a third-party
  community forum page (wtfbc.ca) we don't control. The rendered content
  and units were confirmed live (cross-checked wtfbc.ca's Pam Rocks reading
  against the raw EC SWOB-ML XML for that station — they matched, confirming
  the page reports pre-converted knots), and the parser is written
  defensively (text-pattern based, not raw-HTML-structure based, with a
  minimum-station-count sanity check) — but the sandbox this ran in
  couldn't fetch the page's raw HTML source directly (only a rendered/
  accessibility-tree view), so the parser's exact tag-level assumptions
  weren't tested against the real markup. Worth a spot-check of the "Live
  surface conditions" section after deploying.
