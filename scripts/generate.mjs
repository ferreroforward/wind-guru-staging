#!/usr/bin/env node
// Wind Guru — forecast snapshot generator.
// Fetches multi-model wind data for every spot, runs the rule engine, and
// writes data/forecast.json. Run twice a day by .github/workflows/update-forecast.yml,
// or manually: `node scripts/generate.mjs`.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SPOTS, PRESSURE_REFERENCE, degToLabel, DEG_LABELS, WEBCAMS } from "../assets/spots.js";
import { MODELS, buildForecastUrl, reshapeOpenMeteo, classifyHour, localHourAndMonth, rowsToPressureMap, rowsToSpeedMap, currentPacificHourString, explainMismatch, parseMarineWindText, marineAnchorForHour, parseEcIssued, dropModels, tideForHour, flagEpicHours, buildMosUrl, reshapeMos, applyMos, swellForHours, thermalInputs, applyThermalModel } from "../assets/rules.js";

// Minutes between "now" and a Pacific-local "HH:MM" observation time, on the
// (safe) assumption the observation is from earlier today — used to catch a
// frozen sensor (EC / Squamish Windsports don't hand back an absolute
// timestamp, just a wall-clock time) rather than trust any HH:MM as fresh.
// Handles the midnight edge by treating a large negative gap (observation
// reads *later* than now by more than 12h) as "just before midnight, now is
// just after" rather than a bogus 23-hour-old reading.
function minutesSincePacificHm(hhmm, now = new Date()) {
  if (!hhmm) return null;
  const [hh, mm] = hhmm.split(":").map(Number);
  if (!isFinite(hh) || !isFinite(mm)) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const obsMinutes = hh * 60 + mm;
  let diff = nowMinutes - obsMinutes;
  if (diff < -720) diff += 1440; // observation just before midnight, "now" just after
  if (diff < 0) diff = 0; // clock skew / same-minute rounding
  return diff;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "forecast.json");
const OVERRIDES_PATH = path.join(__dirname, "..", "data", "calibration-overrides.json");
const LIVE_LOG_PATH = path.join(__dirname, "..", "data", "live-verification-log.json");
const MOS_PATH = path.join(__dirname, "..", "data", "mos-coefficients.json");
const MOS_RECENT_PATH = path.join(__dirname, "..", "data", "mos-recent.json");
const THERMAL_PATH = path.join(__dirname, "..", "data", "squamish-thermal.json");
const FORECAST_DAYS = 4; // "today" + 3 days ahead
const LIVE_ERROR_THRESHOLD = 0.20; // 20% — flag as a "mismatch" in the UI/console at this gap or bigger
const LIVE_LOG_MAX_PER_SPOT = 40; // cap so the log file doesn't grow forever
// Skip the % comparison below this forecast speed. Originally 2kt, which let
// near-calm hours dominate the log: the twice-daily runs land at ~5am/5pm, so
// almost every comparison was a calm-hour reading where % error is mostly
// noise (a 1kt miss on a 2kt forecast is "50% error"). Raised to 8kt so the
// calibration loop only ever learns from hours with real wind to measure.
const LIVE_MIN_FORECAST_KT = 8;
// Smallest forecast value used as the denominator of a live check ratio.
const LIVE_RATIO_FLOOR_KT = 5;
// Ignore a live observation older than this when comparing against "right
// now" — a frozen/stale sensor reading as unchanging for hours shouldn't be
// treated as live corroboration or logged as a calibration data point. Same
// cutoff igetwind observations already used; now applied uniformly to every
// source (EC, Squamish Windsports, igetwind) via getLiveObservation.
const MAX_LIVE_OBS_AGE_MIN = 180;

// Same station Porteau Cove uses as its own live-check (see spots.js) —
// reused here as a same-day nowcast input for any spot with pamRocksAware
// and/or pamRocksRule set. Defined once so getLiveObservation's cache key
// matches Porteau's own fetch and we never hit igetwind twice for it.
const PAM_ROCKS_STATION = { type: "igetwind", sid: "CWAS", lat: 49.48, lon: -123.30, name: "Pam Rocks (Howe Sound entrance)" };

// Rider-feedback overrides, if scripts/apply-feedback.mjs has produced any
// (it runs first in the Action — see .github/workflows/update-forecast.yml).
// Missing file just means no feedback yet; that's fine.
async function loadOverrides() {
  try {
    const raw = await readFile(OVERRIDES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.spots || {};
  } catch {
    return {};
  }
}

// Rider-feedback overrides file may or may not exist yet on a fresh clone —
// harmless if missing, same as loadOverrides above.
async function loadLiveLog() {
  try {
    const raw = await readFile(LIVE_LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

// Environment Canada's "Past 24 Hour Conditions" page — genuinely observed
// (not forecast) hourly station data: weather.gc.ca/past_conditions. EC's
// current table lists BOTH metric and imperial units side by side (Temp
// °C, Temp °F, Wind km/h, Wind mph, ...) — 13 columns, not the simpler
// single-unit layout this comment used to describe. That's a real, silent
// trap: a hardcoded "wind is column 3" assumption used to work (and still
// matches the OLD 8-column layout an older EC template had) but currently
// grabs the Temp(°F) column instead, on every station this function is
// used for — confirmed against both the Halibut Bank buoy and the
// "Vancouver Harbour" land station, which had silently never worked either.
// So: find the Wind(km/h) column by its header text instead of a fixed
// index, with the old index 3 as a fallback if a table ever lacks a
// parseable header (keeps this from breaking silently again if EC changes
// the column count/order a third time). We parse actual <tr>/<td> cells
// rather than scraping flattened text, since date-separator rows only have
// one populated cell and would otherwise be easy to misread as data.
function parseEcObservedWind(html, debugLabel = null) {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
  const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();

  const rows = [];
  let headerCells = null;
  let rm;
  while ((rm = rowRe.exec(html))) {
    const cells = [];
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[1]))) cells.push(stripTags(cm[1]));
    // The header row is the one whose cells include something like
    // "Wind(km/h)" — data rows never contain that literal text, so this
    // can't collide with a real observation.
    if (headerCells === null && cells.some((c) => /^wind\s*\(\s*km\/h\s*\)/i.test(c))) headerCells = cells;
    // Data rows start with an "HH:MM" cell; date-separator rows ("13 August
    // 2026") and the header row don't match this and are skipped.
    if (cells.length >= 4 && /^\d{2}:\d{2}$/.test(cells[0])) rows.push(cells);
  }
  if (!rows.length) {
    if (debugLabel) console.log(`[live:${debugLabel}] parseEcObservedWind: found no data rows (page fetched OK, ${html.length} bytes — table layout may not match what this parser expects).`);
    return null;
  }

  let windColIdx = 3; // fallback: the old assumption, only used if we can't find a header
  if (headerCells) {
    const idx = headerCells.findIndex((c) => /^wind\s*\(\s*km\/h\s*\)/i.test(c));
    if (idx !== -1) windColIdx = idx;
  }

  const latest = rows[0]; // rows are most-recent-first
  const time = latest[0];
  const windRaw = latest[windColIdx];
  let speedKmh, directionLabel, directionAbbr = null, gustKmh = null;
  if (/^calm$/i.test(windRaw)) {
    speedKmh = 0;
    directionLabel = "calm";
  } else {
    // Land stations report "DIR (Label) SPEED"; buoy stations skip the
    // parenthetical full-name label entirely and add a trailing "gusts N"
    // instead — e.g. a land station reads "NE (Northeast) 20" but a buoy
    // reads "W 14 gusts 17" (confirmed against the live Halibut Bank page's
    // actual DOM, not just its rendered text — the "(West)"-style label
    // some tools describe for buoy rows doesn't actually exist there).
    // Label group is optional so both shapes match; falls back to the
    // abbreviation as the label when there's no parenthetical, matching how
    // wtfbc.ca's board already shows bare abbreviations like "NNW".
    const m = windRaw.match(/^([A-Z]+)\s*(?:\(([^)]+)\))?\s*([\d.]+)(?:\s*gusts?\s*([\d.]+))?/);
    if (!m) {
      if (debugLabel) console.log(`[live:${debugLabel}] parseEcObservedWind: found a data row but couldn't parse its wind cell: ${JSON.stringify(windRaw)}`);
      return null;
    }
    directionAbbr = m[1];
    directionLabel = m[2] || m[1];
    speedKmh = parseFloat(m[3]);
    gustKmh = m[4] != null ? parseFloat(m[4]) : null;
  }
  const labelIdx = directionAbbr ? DEG_LABELS.indexOf(directionAbbr) : -1;
  return {
    time, // "HH:MM" Pacific, no date attached
    directionDeg: labelIdx >= 0 ? labelIdx * 22.5 : null,
    speedKt: Math.round(speedKmh * 0.539957 * 10) / 10,
    gustKt: gustKmh != null ? Math.round(gustKmh * 0.539957 * 10) / 10 : null,
    directionAbbr,
    directionLabel,
  };
}

async function fetchEcObservation(station) {
  const url = `https://weather.gc.ca/past_conditions/index_e.html?station=${station.code}`;
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`[live:${station.name}] fetch failed: ${res.status}`); return null; }
  const html = await res.text();
  return parseEcObservedWind(html, station.name);
}

// Environment Canada marine buoys — genuine open-water wind, distinct from
// the coastal/land stations wtfbc.ca's board already covers (see
// SWOB_BOARD_URL below) and from the marine bulletin *text* (MARINE_ZONES
// above). A buoy's numeric NDBC-style id (e.g. Halibut Bank's "46146") is
// also its EC "station" code on the same past_conditions page used for land
// stations above, so this reuses fetchEcObservation/getLiveObservation as-is
// — no new fetcher or parser needed. Halibut Bank sits mid-Strait of
// Georgia, the one clearly-relevant open-water buoy for this app's coverage
// area (Howe Sound + the Strait of Georgia south-of-Nanaimo zone); add more
// here if useful later (e.g. Sentry Shoal, technically the zone north of
// Nanaimo).
const BUOY_STATIONS = [
  { name: "Halibut Bank Buoy", code: "46146" },
];

// Squamish Windsports Society's own wind meter at the Spit
// (squamishwindsports.com/conditions/wind) — the JSON endpoint behind that
// page's live chart, found by inspecting its network requests. Reports in
// knots already. Per local rider feedback, this is a far better read on the
// Squamish corridor than Environment Canada's Squamish Airport station,
// which sits in a wind shadow — see spot.liveStation comments in spots.js.
async function fetchSquamishWindsportsObservation(station) {
  const dateStr = currentPacificHourString().slice(0, 10);
  const url = `https://squamishwindsports.com/wind-data/getmet.php?wind_src=${station.windSrc}&reqdate=${dateStr}&reqtime=0`;
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`[live:${station.name}] fetch failed: ${res.status}`); return null; }
  const json = await res.json();
  if (!Array.isArray(json.ws) || !json.ws.length) return null;
  const i = json.ws.length - 1; // readings are chronological; last = most recent
  const speedKt = parseFloat(json.ws[i]);
  if (!isFinite(speedKt)) return null;
  const gustKt = json.wg ? parseFloat(json.wg[i]) : NaN;
  const dirDeg = json.wd ? parseFloat(json.wd[i]) : NaN;
  const dtMs = json.dt ? parseFloat(json.dt[i]) * 1000 : null;
  return {
    // The meter's `dt` is not a true epoch: it is local wall-clock time
    // written as if it were UTC ("UTC plus local shift" in the site's own
    // chart script, which plots it with no conversion). Formatting it in
    // Pacific time read every reading 7 or 8 hours early, so the staleness
    // check threw them all away and Squamish never got a live check.
    time: dtMs ? new Date(dtMs).toLocaleTimeString("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null,
    speedKt,
    gustKt: isFinite(gustKt) ? gustKt : null,
    directionAbbr: null,
    directionLabel: isFinite(dirDeg) ? degToLabel(dirDeg) : null,
  };
}

// igetwind.com's station-finder API (found by inspecting network requests on
// igetwind.com — public, no auth/key needed): given a center point and a
// radius in km, returns every nearby station it aggregates (METAR airports,
// marine buoys, and citizen APRSWXNET/MesoWest stations) with recent
// observations. We use it to pin a *specific known-good* station by its
// `sid` — not to auto-pick "nearest" every run, since a lot of what it
// returns is unstaffed/uncalibrated citizen hardware not worth trusting
// unattended. `station.lat`/`station.lon` here are the STATION's own
// coordinates (not the spot's), so the query reliably finds it regardless
// of which spot references it, and the result is cached once per station.
async function fetchIgetwindObservation(station) {
  const url = `https://igetwind.com/api/lw/stations/${station.lat}/${station.lon}/${station.radiusKm ?? 10}/0`;
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`[live:${station.name}] fetch failed: ${res.status}`); return null; }
  const json = await res.json();
  const match = (json.stations || []).find((s) => s.sid === station.sid);
  if (!match || !Array.isArray(match.observations)) return null;

  const windObs = match.observations
    .filter((o) => o.type === "W" && o.val != null)
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  if (!windObs) return null;
  // "at" is "YYYY-MM-DD HH:MM:SS" UTC, unmarked — this is the one live
  // source that hands back an absolute timestamp, so compute age precisely
  // rather than via the HH:MM-guessing helper the other two sources use.
  const atMs = new Date(windObs.at.replace(" ", "T") + "Z").getTime();
  const ageMin = isFinite(atMs) ? (Date.now() - atMs) / 60000 : null;
  if (ageMin == null || ageMin > MAX_LIVE_OBS_AGE_MIN) return null;

  const speedMs = parseFloat(windObs.val);
  if (!isFinite(speedMs)) return null;
  const gustObs = match.observations.find((o) => o.type === "WG");
  const dirObs = match.observations.find((o) => o.type === "WD");
  const gustMs = gustObs ? parseFloat(gustObs.val) : NaN;
  const dirDeg = dirObs ? parseFloat(dirObs.val) : NaN;

  return {
    // Previously passed through `windObs.at` (raw UTC) directly as the
    // display time, which read as Pacific local and was off by 7-8 hours
    // whenever it was actually shown — convert properly here instead.
    time: new Date(atMs).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    ageMin: Math.round(ageMin),
    speedKt: Math.round(speedMs * 1.943844 * 10) / 10,
    gustKt: isFinite(gustMs) ? Math.round(gustMs * 1.943844 * 10) / 10 : null,
    directionAbbr: null,
    directionDeg: isFinite(dirDeg) ? dirDeg : null,
    directionLabel: isFinite(dirDeg) ? degToLabel(dirDeg) : null,
  };
}

// City of White Rock's East Beach weather station: the JSON behind
// maps.whiterockcity.ca/weather (embedded on whiterockcity.ca's waterfront
// cameras page). Speeds already in knots; `ts` is epoch ms.
async function fetchWhiteRockCityObservation(station) {
  const res = await fetch("https://maps.whiterockcity.ca/weather/weatherResults.txt", { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`[live:${station.name}] fetch failed: ${res.status}`); return null; }
  return parseWhiteRockCity(await res.json());
}
function parseWhiteRockCity(json) {
  const first = (k) => (Array.isArray(json?.[k]) && json[k].length ? json[k][0] : null);
  const ws = first("windSpeed"), wg = first("maxWindSpeed"), wd = first("windDir");
  const speedKt = ws ? parseFloat(ws.value) : NaN;
  if (!isFinite(speedKt) || !ws.ts) return null;
  const gustKt = wg ? parseFloat(wg.value) : NaN;
  const dirDeg = wd ? parseFloat(wd.value) : NaN;
  return {
    time: new Date(ws.ts).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    ageMin: Math.round((Date.now() - ws.ts) / 60000),
    speedKt: Math.round(speedKt * 10) / 10,
    gustKt: isFinite(gustKt) ? Math.round(gustKt * 10) / 10 : null,
    directionAbbr: null,
    directionDeg: isFinite(dirDeg) ? dirDeg : null,
    directionLabel: isFinite(dirDeg) ? degToLabel(dirDeg) : null,
  };
}

// A station read off wtfbc.ca's board (fetched once per run, see main()),
// e.g. the Jericho Sailing Centre sensor. The board gives "H:MM am/pm".
let swobBoardForLive = [];
function swobObservation(station) {
  const s = swobBoardForLive.find((x) => x.name.toLowerCase() === station.boardName.toLowerCase());
  if (!s) return null;
  const m = (s.observed_local_time || "").match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  const hh = m ? (Number(m[1]) % 12) + (/pm/i.test(m[3]) ? 12 : 0) : null;
  const labelIdx = s.direction_label ? DEG_LABELS.indexOf(s.direction_label) : -1;
  return {
    time: hh != null ? `${String(hh).padStart(2, "0")}:${m[2]}` : null,
    speedKt: s.speed_kt,
    gustKt: s.gust_kt ?? null,
    directionAbbr: s.direction_label,
    directionDeg: labelIdx >= 0 ? labelIdx * 22.5 : null,
    directionLabel: s.direction_label,
  };
}

// Weather and tide APIs sometimes refuse or time out a request from
// GitHub's shared runners (rate limits, brief outages), and one refused
// request used to be enough to drop a spot; too many dropped spots and the
// whole run aborts (Sep 27 and 28 2026, the site stayed on the previous
// snapshot). So: up to 4 tries, waiting 3, 8 and 20 seconds (or what the
// server's Retry-After asks, up to a minute), on 429, 5xx and network
// errors. Other errors (400, 404) fail straight away.
// Two kinds of failure, retried differently (Oct 3 2026):
//  - an HTTP 429/5xx: the server is busy, so wait (3s, 8s, 20s) and give up
//    after `tries` attempts, as before.
//  - a thrown network error ("fetch failed"): in the Action these came one
//    per pooled connection the server had already closed. Every run showed
//    the same requests failing first try, and once the gradient stations
//    went from 3 to 4 parallel fetches Jericho needed a 5th attempt it did
//    not have, so it dropped out of two snapshots in a row. Each failure
//    discards one dead connection, so these are retried quickly and more
//    often (NETWORK_TRIES) and the cause is logged.
const NETWORK_TRIES = 8;
async function fetchRetry(url, options = {}, tries = 4) {
  const waits = [3000, 8000, 20000];
  const networkWaits = [300, 600, 1000, 2000, 4000, 8000, 20000];
  let lastErr = null;
  let httpFails = 0, networkFails = 0;
  for (;;) {
    try {
      const res = await fetch(url, options);
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      httpFails++;
      if (httpFails >= tries) return res;
      const ra = Number(res.headers.get("retry-after"));
      const wait = isFinite(ra) && ra > 0 ? Math.min(60000, ra * 1000) : waits[Math.min(httpFails - 1, waits.length - 1)];
      console.log(`  [retry] ${String(url).slice(0, 70)}... ${lastErr.message}, waiting ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    } catch (err) {
      lastErr = err;
      networkFails++;
      if (networkFails >= Math.max(tries, NETWORK_TRIES)) throw err;
      const wait = networkWaits[Math.min(networkFails - 1, networkWaits.length - 1)];
      const cause = err?.cause?.code || err?.cause?.message || "";
      console.log(`  [retry] ${String(url).slice(0, 70)}... ${err.message}${cause ? ` (${cause})` : ""}, waiting ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const liveObsCache = {};
// A station can name a `fallback` (spots.js), used when the first has
// nothing fresh (Jericho: English Bay buoy, then the Sailing Centre sensor).
// The result says which one it came from in `sourceName`.
async function getLiveObservation(station) {
  const obs = await getOneLiveObservation(station);
  if (obs) return { ...obs, sourceName: obs.sourceName ?? station.name };
  if (station.fallback) {
    const fb = await getOneLiveObservation(station.fallback);
    if (fb) {
      console.log(`[live:${station.name}] nothing fresh, using ${station.fallback.name}`);
      return { ...fb, sourceName: station.fallback.name, fromFallback: true };
    }
  }
  return null;
}
async function getOneLiveObservation(station) {
  const cacheKey = `${station.type || "ec"}:${station.code || station.windSrc || station.sid || station.boardName || station.name}`;
  if (liveObsCache[cacheKey]) return liveObsCache[cacheKey];
  try {
    let parsed = station.type === "squamishwindsports" ? await fetchSquamishWindsportsObservation(station)
      : station.type === "igetwind" ? await fetchIgetwindObservation(station)
      : station.type === "whiterockcity" ? await fetchWhiteRockCityObservation(station)
      : station.type === "swob" ? swobObservation(station)
      : await fetchEcObservation(station);
    // Staleness check, applied uniformly across all three source types. The
    // igetwind fetcher already attaches a precise `ageMin` (it has a real
    // timestamp); EC and Squamish Windsports only ever hand back an "HH:MM"
    // wall-clock time with no date, so estimate age the same way the UI
    // will eventually need to reason about it — a frozen sensor stuck
    // reporting the same reading run after run would otherwise look "live"
    // forever.
    if (parsed && parsed.ageMin == null) parsed.ageMin = minutesSincePacificHm(parsed.time);
    if (parsed && parsed.ageMin != null && parsed.ageMin > MAX_LIVE_OBS_AGE_MIN) {
      console.log(`[live:${station.name}] observation is ${Math.round(parsed.ageMin)}min old — treating as stale, not live.`);
      parsed = null;
    }
    liveObsCache[cacheKey] = parsed;
    return parsed;
  } catch (err) {
    console.log(`[live:${station.name}] fetch error: ${err.message}`);
    return null;
  }
}

async function fetchSpot(spot) {
  // modelPoint (spots.js): where to ask the models, when the beach itself
  // sits in a land grid cell. Falls back to the spot's own coordinates.
  const pt = spot.modelPoint || spot;
  const url = buildForecastUrl(pt.lat, pt.lon, FORECAST_DAYS);
  const res = await fetchRetry(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) {
    console.error(`[${spot.id}] fetch failed: ${res.status} ${res.statusText}`);
    return null;
  }
  const json = await res.json();
  return dropModels(reshapeOpenMeteo(json), spot.excludeModels);
}

// DFO (Canadian Hydrographic Service) hourly tide predictions for a spot's
// tideStation, keyed by local "YYYY-MM-DDTHH:00" like the forecast hours.
// Public API, no key: https://api-iwls.dfo-mpo.gc.ca (IWLS). Predictions
// (wlp) rather than observations, since we need the hours ahead. Cached per
// station; any failure just means no tide info this run.
const tideCache = {};
async function fetchTideLevels(station, startedAt) {
  if (!station) return null;
  const key = station.code;
  if (key in tideCache) return tideCache[key];
  tideCache[key] = null;
  try {
    const base = "https://api-iwls.dfo-mpo.gc.ca/api/v1";
    let id = station.id;
    if (!id) {
      const r = await fetch(`${base}/stations?code=${station.code}`, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
      if (!r.ok) throw new Error(`station lookup HTTP ${r.status}`);
      id = (await r.json())?.[0]?.id;
      if (!id) throw new Error("station not found");
    }
    const from = new Date(startedAt.getTime() - 24 * 3600000);
    const to = new Date(startedAt.getTime() + (FORECAST_DAYS + 1) * 24 * 3600000);
    const iso = (d) => d.toISOString().slice(0, 19) + "Z";
    const url = `${base}/stations/${id}/data?time-series-code=wlp&from=${iso(from)}&to=${iso(to)}&resolution=SIXTY_MINUTES`;
    const res = await fetchRetry(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    const levels = {};
    for (const e of arr || []) {
      if (e.value == null || !e.eventDate) continue;
      levels[currentPacificHourString(new Date(e.eventDate))] = e.value;
    }
    console.log(`  [tide:${station.name}] ${Object.keys(levels).length} hourly predictions`);
    tideCache[key] = Object.keys(levels).length ? levels : null;
  } catch (err) {
    console.log(`  [tide:${station.name}] fetch failed: ${err.message}`);
  }
  return tideCache[key];
}

// DFO high and low tide times (wlp-hilo) for a tideStation, local time,
// heights in metres and feet. Cached per station.
const tideHiloCache = {};
async function fetchTideHilo(station, startedAt) {
  if (!station?.id) return null;
  if (station.code in tideHiloCache) return tideHiloCache[station.code];
  tideHiloCache[station.code] = null;
  try {
    const from = new Date(startedAt.getTime() - 12 * 3600000);
    const to = new Date(startedAt.getTime() + (FORECAST_DAYS + 1) * 24 * 3600000);
    const iso = (d) => d.toISOString().slice(0, 19) + "Z";
    const url = `https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/${station.id}/data?time-series-code=wlp-hilo&from=${iso(from)}&to=${iso(to)}`;
    const res = await fetchRetry(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tideHiloCache[station.code] = labelHilo(await res.json());
    console.log(`  [tide-hilo:${station.name}] ${tideHiloCache[station.code].length} highs/lows`);
  } catch (err) {
    console.log(`  [tide-hilo:${station.name}] fetch failed: ${err.message}`);
  }
  return tideHiloCache[station.code];
}
// The API lists extremes in order without saying which is which: a value
// above both neighbours (or the one it alternates with) is a high.
function labelHilo(arr) {
  const pts = (arr || []).filter((e) => e.value != null && e.eventDate)
    .map((e) => ({ t: new Date(e.eventDate), v: e.value }))
    .sort((a, b) => a.t - b.t);
  return pts.map((p, i) => {
    const nb = [pts[i - 1], pts[i + 1]].filter(Boolean);
    const high = nb.length ? nb.every((n) => p.v > n.v) : p.v > 2.5;
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(p.t).reduce((o, x) => (o[x.type] = x.value, o), {});
    return {
      date: `${local.year}-${local.month}-${local.day}`,
      time: `${local.hour}:${local.minute}`,
      type: high ? "high" : "low",
      height_m: Math.round(p.v * 100) / 100,
      height_ft: Math.round(p.v * 3.28084 * 10) / 10,
    };
  });
}

// Learned correction inputs (see applyMos in rules.js): the pure models at
// the exact point each spot's blend was trained on. One request per point.
let mosCoefficients = null;
// Learned Squamish thermal (see applyThermalModel in rules.js). Optional:
// without the file the old 2.85x scaling is used.
let thermalModel = null;
try {
  thermalModel = JSON.parse(await readFile(THERMAL_PATH, "utf8"));
  console.log(`Loaded learned thermal for ${thermalModel.station} (trained ${thermalModel.trained})`);
} catch {
  console.log("No data/squamish-thermal.json, learned thermal off this run.");
}
async function loadMosCoefficients() {
  try {
    mosCoefficients = JSON.parse(await readFile(MOS_PATH, "utf8"));
    // Nightly recent correction; ignored once it's over a week old (the
    // nightly job has stopped), so a stale offset can't linger.
    try {
      const recent = JSON.parse(await readFile(MOS_RECENT_PATH, "utf8"));
      if (Date.now() - Date.parse(recent.updated_at) < 7 * 86400000) {
        for (const [id, r] of Object.entries(recent.points || {})) if (mosCoefficients.points?.[id]) mosCoefficients.points[id].recent = r;
        console.log(`Recent corrections: ${Object.entries(recent.points || {}).map(([id, r]) => `${id} ${r.offset_kt >= 0 ? "+" : ""}${r.offset_kt}kt x${r.sigma_scale}`).join(", ")}`);
      } else console.log("data/mos-recent.json is over a week old, not applied.");
    } catch { /* optional */ }
    console.log(`Loaded learned corrections for: ${Object.keys(mosCoefficients.points || {}).join(", ")} (trained ${mosCoefficients.trained})`);
  } catch {
    mosCoefficients = null;
    console.log("No data/mos-coefficients.json, learned corrections off this run.");
  }
}
const mosInputCache = {};
async function fetchMosInputs(pointId) {
  const point = mosCoefficients?.points?.[pointId];
  if (!point) return null;
  if (pointId in mosInputCache) return mosInputCache[pointId];
  mosInputCache[pointId] = null;
  try {
    const res = await fetchRetry(buildMosUrl(point.lat, point.lon, FORECAST_DAYS), { headers: { "User-Agent": "wind-guru-agent/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mosInputCache[pointId] = reshapeMos(await res.json());
  } catch (err) {
    console.log(`  [mos:${pointId}] fetch failed: ${err.message} (falling back to the model blend)`);
  }
  return mosInputCache[pointId];
}

// Environment Canada's marine text bulletin — per a 12-year local rider
// (see README), this is the single best starting resource for Squamish
// wind, more trustworthy for today's magnitude than any raw model output.
// We can't fetch it client-side (no CORS), so it only shows up in the
// twice-daily snapshot, not the live-refresh fallback.
// Zone ids here are what a spot's `marineZone` field in spots.js points at —
// keep them in sync.
const MARINE_ZONES = [
  { id: "howe_sound", label: "Howe Sound", siteID: "06400" },
  { id: "strait_of_georgia_south", label: "Strait of Georgia (south of Nanaimo)", siteID: "14305" },
];

// Pull the "Winds" section out of an EC marine forecast page. EC's page has
// distinct "Marine Forecast" (wind + weather + visibility combined), "Winds",
// "Weather & Visibility" and "Extended Forecast" sections; the Winds one is
// the cleanest input for parseMarineWindText since it has no sky/fog prose
// mixed in to confuse the speed/direction regexes.
//
// Deliberately text-based rather than tag-based (same approach as
// parseSwobBoard): we don't control EC's markup and have no contract with it,
// but the section headings and the "Issued <time>" line are stable, distinctive
// text anchors. Verified against live fetches of both zone pages, Aug 2026.
function extractMarineSection(html, heading, stopHeadings) {
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ");

  const startRe = new RegExp(`\\n\\s*${heading}\\s*\\n`, "i");
  const startM = text.match(startRe);
  if (!startM) return null;
  let body = text.slice(startM.index + startM[0].length);

  let cut = body.length;
  for (const stop of stopHeadings) {
    const m = body.match(new RegExp(`\\n\\s*${stop}\\s*\\n`, "i"));
    if (m && m.index < cut) cut = m.index;
  }
  body = body.slice(0, cut);

  // Drop the "Issued 04:00 AM PDT 26 August 2026" line and the
  // "Today Tonight and Thursday." period label — neither carries wind data,
  // and the date digits would otherwise be misread as knot values.
  const issuedM = body.match(/Issued\s+[\d:]+\s*(?:AM|PM)?\s*[A-Z]{3,4}\s+\d{1,2}\s+\w+\s+\d{4}/i);
  const issued = issuedM ? issuedM[0].replace(/^Issued\s+/i, "") : null;
  body = body.replace(/Issued\s+[\d:]+\s*(?:AM|PM)?\s*[A-Z]{3,4}\s+\d{1,2}\s+\w+\s+\d{4}/gi, " ");

  const cleaned = body.replace(/\s+/g, " ").trim();
  return cleaned ? { text: cleaned, issued } : null;
}

async function fetchMarineBulletin(zone) {
  const url = `https://weather.gc.ca/marine/forecast_e.html?mapID=02&siteID=${zone.siteID}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    // Prefer the dedicated "Winds" section — no sky/fog prose to confuse the
    // speed and direction regexes. Fall back to the combined "Marine Forecast"
    // section if EC ever drops or renames the Winds one.
    const winds = extractMarineSection(html, "Winds", ["Weather & Visibility", "Extended Forecast", "Stay connected"])
      || extractMarineSection(html, "Marine Forecast", ["Winds", "Weather & Visibility", "Extended Forecast", "Stay connected"]);
    const text = winds ? winds.text.slice(0, 900) : "";
    // Shown in full on the page (Guillermo, Sep 2026: so riders don't need
    // to click through): the wind forecast, the extended outlook and any
    // warning headline, each as EC wrote it.
    const extended = extractMarineSection(html, "Extended Forecast", ["Stay connected", "Weather & Visibility"]);
    const flat = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const warnM = flat.match(/\b(STRONG WIND|GALE|STORM|HURRICANE FORCE WIND|SQUALL|FREEZING SPRAY) WARNING (IN EFFECT|ENDED)\b/i);
    // Timing phrases ("Friday morning", "this afternoon") only mean
    // something relative to the bulletin's issue time, so hand it over.
    // Fallback if EC ever drops the Issued line: assume it was just issued.
    const nowStr = currentPacificHourString(new Date());
    const issuedInfo = parseEcIssued(winds?.issued) || { dateStr: nowStr.slice(0, 10), hour: Number(nowStr.slice(11, 13)) };
    const parsed = winds ? parseMarineWindText(winds.text, issuedInfo) : null;
    if (parsed) {
      console.log(`  [marine:${zone.id}] parsed ${parsed.segments.length} segment(s), ${parsed.minKt}-${parsed.maxKt}kt${parsed.hasOutflow ? ", OUTFLOW named" : ""}${parsed.hasInflow ? ", INFLOW named" : ""}`);
    } else {
      console.log(`  [marine:${zone.id}] no parseable wind text — anchoring disabled for this zone this run.`);
    }
    const warning = warnM ? !/ended/i.test(warnM[2]) : /strong wind warning|gale warning|storm warning|small craft warning/i.test(html);
    return {
      id: zone.id, label: zone.label, url, text, issued: winds?.issued ?? null, warning, parsed,
      full_text: winds ? winds.text : null,
      warning_headline: warnM ? warnM[0].toUpperCase() : null,
      extended_text: extended ? extended.text : null,
      extended_issued: extended ? extended.issued : null,
    };
  } catch (err) {
    console.error(`[${zone.id}] marine bulletin fetch failed: ${err.message}`);
    return null;
  }
}

// "Weather Talk For BC" (wtfbc.ca) — a BC windsports community forum — runs
// a single page that aggregates live surface observations from ~11 stations
// across the region (Environment Canada SWOB stations, plus a couple of
// independent sources like the White Rock city beach sensor and the Jericho
// Sailing Centre Association's own instrument) into one clean, already-in-
// knots summary. Cross-checked against the raw EC SWOB-ML XML feed for Pam
// Rocks (dd.weather.gc.ca/.../CWAS-AUTO-swob.xml) to confirm the units:
// wtfbc.ca's page reports pre-converted knots, not km/h, and rounds to the
// nearest whole knot. One request here gets us a much wider, regional
// picture than our own per-spot live stations alone — riders like seeing
// what's happening at nearby stations even outside our specific spot list.
const SWOB_BOARD_URL = "https://wtfbc.ca/swob.php";

// wtfbc.ca's markup isn't something we control or have a stable contract
// with, so rather than depend on exact tag structure we normalize to plain
// text (turning line-break-ish tags into newlines, stripping everything
// else) and then scan for the repeating 3-line pattern each station's
// entry renders as:
//   "{Station Name}[ ... {Temp}°C]"
//   "{Weekday} {Month} {Day} {H}:{MM} am/pm"
//   "{DIR} {SPEED}[ g {GUST}]"  (or "Calm")
// The date/time line is a strong, distinctive anchor unlikely to appear by
// coincidence anywhere else on the page, so this stays robust even if
// wtfbc.ca changes its surrounding HTML/CSS.
function parseSwobBoard(html) {
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&deg;/gi, "°")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Best-effort station-name -> source-URL lookup from the raw markup, so
  // each card can credit/link its underlying source where we can find one.
  // Purely cosmetic — if this regex ever stops matching wtfbc.ca's actual
  // link markup, stations just show without a source link, nothing breaks.
  const hrefMap = {};
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let lm;
  while ((lm = linkRe.exec(html))) {
    const name = lm[2].replace(/&amp;/gi, "&").trim();
    if (name) hrefMap[name] = lm[1];
  }

  const dateTimeRe = /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{1,2}:\d{2} (am|pm)$/i;
  const windRe = /^([NSEW]{1,3})\s+(\d+)(?:\s*g\s*(\d+))?$/i;

  const stations = [];
  for (let i = 0; i < text.length - 2; i++) {
    if (!dateTimeRe.test(text[i + 1])) continue;
    const windMatch = text[i + 2].match(windRe);
    const isCalm = /^calm$/i.test(text[i + 2]);
    if (!windMatch && !isCalm) continue;

    const nameLine = text[i];
    const tempMatch = nameLine.match(/^(.+?)\s*\.\.\.\s*(-?\d+)\s*°C$/);
    const name = (tempMatch ? tempMatch[1] : nameLine).trim();
    if (!name || name.length > 60) continue; // sanity guard against a mis-anchored match

    stations.push({
      name,
      source_url: hrefMap[name] || null,
      observed_local_time: text[i + 1].replace(/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} /, ""), // just the "H:MM am/pm" part
      temp_c: tempMatch ? Number(tempMatch[2]) : null,
      direction_label: isCalm ? "calm" : windMatch[1].toUpperCase(),
      speed_kt: isCalm ? 0 : Number(windMatch[2]),
      gust_kt: isCalm ? null : (windMatch[3] != null ? Number(windMatch[3]) : null),
    });
    i += 2; // skip past this entry's 3 lines
  }
  return stations;
}

async function fetchSwobBoard() {
  try {
    const res = await fetch(SWOB_BOARD_URL, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
    if (!res.ok) { console.log(`[swob-board] fetch failed: ${res.status}`); return []; }
    const html = await res.text();
    const stations = parseSwobBoard(html);
    if (stations.length < 3) {
      console.log(`[swob-board] only parsed ${stations.length} station(s) — page structure may have changed, skipping.`);
      return [];
    }
    return stations;
  } catch (err) {
    console.log(`[swob-board] fetch error: ${err.message}`);
    return [];
  }
}

// Reference-station data (e.g. Point Atkinson for Erwin Park, and the
// pressure-gradient trio for Howe Sound spots) — fetched once per unique
// coordinate and reused across any spot/feature pointing at it.
const stationRowsCache = {};
async function getStationRows(station) {
  const key = `${station.lat},${station.lon}`;
  if (stationRowsCache[key]) return stationRowsCache[key];
  process.stdout.write(`Fetching reference station ${station.name}... `);
  const url = buildForecastUrl(station.lat, station.lon, FORECAST_DAYS);
  const res = await fetchRetry(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`fetch failed: ${res.status}`); return null; }
  const json = await res.json();
  const rows = reshapeOpenMeteo(json);
  console.log("done");
  stationRowsCache[key] = rows;
  return rows;
}
async function getReferenceSpeeds(station) {
  const rows = await getStationRows(station);
  return rows ? rowsToSpeedMap(rows) : null;
}

// Pressure-gradient maps (large-scale coast-vs-interior, and Howe Sound
// mouth for the local check), fetched once and shared by every Howe Sound
// spot with pressureGradientAware: true. See rules.js for the interpretation.
let gradientStations = null;
async function getGradientStations() {
  if (gradientStations) return gradientStations;
  const [interiorRows, coastalRows, mouthRows, farRows] = await Promise.all([
    getStationRows(PRESSURE_REFERENCE.interior),
    getStationRows(PRESSURE_REFERENCE.coastal),
    getStationRows(PRESSURE_REFERENCE.howeSoundMouth),
    PRESSURE_REFERENCE.far ? getStationRows(PRESSURE_REFERENCE.far) : null,
  ]);
  const byTime = (rows) => (rows ? Object.fromEntries(rows.map((r) => [r.time, r])) : {});
  gradientStations = {
    interior: interiorRows ? rowsToPressureMap(interiorRows) : {},
    coastal: coastalRows ? rowsToPressureMap(coastalRows) : {},
    mouth: mouthRows ? rowsToPressureMap(mouthRows) : {},
    // Whole rows by hour, for the learned thermal (it needs temperatures too).
    rows: { interior: byTime(interiorRows), coastal: byTime(coastalRows), mouth: byTime(mouthRows), far: byTime(farRows) },
  };
  return gradientStations;
}


// "Guillermo's take" -- a short daily commentary posted as a GitHub issue
// (see .github/ISSUE_TEMPLATE/daily-take.yml), one issue per forecast date,
// displayed on the site under a card of its own. The repo is public, so
// anyone could technically open an issue shaped like this one -- the
// AUTHOR_USERNAME check below is what keeps a spoofed "take" from ever
// reaching the site: only an issue opened by that exact GitHub account is
// trusted, everything else is silently skipped. Kept separate from
// apply-feedback.mjs's OWNER/REPO (same values today, but that file's job
// is calibration, not display) and reuses the "closing removes it" idea
// from wind-report handling for symmetry (state=open only, so retracting a
// take is just closing its issue).
const DAILY_TAKE_OWNER = "ferreroforward";
const DAILY_TAKE_REPO = "wind-guru"; // kept in sync with apply-feedback.mjs's REPO
const AUTHOR_USERNAME = "ferreroforward"; // Guillermo's own GitHub login -- NOT swapped between staging/production, it's the same account either way

function extractIssueField(body, exactLabel) {
  // Same "### Label\n\nvalue\n\n" issue-form parsing apply-feedback.mjs
  // uses for wind-report issues -- duplicated rather than shared/imported,
  // matching this project's existing pattern of self-contained scripts.
  const escaped = exactLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`###\\s*${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`, "i");
  const m = body.match(re);
  if (!m) return null;
  const val = m[1].trim();
  return (!val || /^_no response_$/i.test(val)) ? null : val;
}

async function fetchDailyTakes() {
  const headers = { "User-Agent": "wind-guru-agent/1.0", "Accept": "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  // Filtered by creator, not by the daily-take label -- an issue-form
  // submission is supposed to auto-apply that label, but it doesn't always
  // land (the first real take posted through this form came through with
  // no label at all, title hand-edited too), and there's no reason a
  // labeling hiccup should silently swallow a real post. AUTHOR_USERNAME is
  // what actually keeps this safe on a public repo, so filtering on it
  // server-side (rather than fetching everything and checking client-side)
  // is no less secure and also cuts the response down to just his issues.
  // The shape check below (both Date and Take present) is what tells a
  // daily-take issue apart from anything else he might file, like a
  // wind-report.
  const url = `https://api.github.com/repos/${DAILY_TAKE_OWNER}/${DAILY_TAKE_REPO}/issues?creator=${AUTHOR_USERNAME}&state=open&per_page=30`;
  let issues;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.log(`[daily-take] GitHub API fetch failed: ${res.status} ${res.statusText}`);
      return {};
    }
    issues = (await res.json()).filter((i) => !i.pull_request);
  } catch (err) {
    console.log(`[daily-take] fetch failed: ${err.message}`);
    return {};
  }

  // Newest-edited first, so if there's ever more than one open issue for
  // the same date (shouldn't normally happen -- the issue template tells
  // Guillermo to edit rather than re-post) the most recently updated one
  // wins rather than whichever the API happened to list first.
  issues.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  const takes = {};
  for (const issue of issues) {
    // Belt-and-suspenders -- the ?creator= filter above should already
    // guarantee this, but an issue opened by anyone else is never trusted
    // regardless of what the API returns.
    if (issue.user?.login !== AUTHOR_USERNAME) {
      console.log(`[daily-take] skipping issue #${issue.number} -- opened by ${issue.user?.login ?? "unknown"}, not ${AUTHOR_USERNAME}.`);
      continue;
    }
    const body = issue.body || "";
    const date = extractIssueField(body, "Date");
    const text = extractIssueField(body, "Take");
    // Not every issue he opens is a daily take (wind-report issues are his
    // too) -- only one shaped like this template (both fields present)
    // counts, silently skipped otherwise rather than logged as an error.
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !text) continue;
    if (takes[date]) continue; // already have the newest-updated take for this date
    takes[date] = { date, text, posted_at: issue.created_at, updated_at: issue.updated_at, issue_number: issue.number };
  }
  const count = Object.keys(takes).length;
  if (count) console.log(`[daily-take] found ${count} take(s): ${Object.keys(takes).join(", ")}`);
  return takes;
}

// Webcams that stream to YouTube through CamStreamer (White Rock, Oct
// 2026): follow each CamStreamer embed's redirect to the stream's current
// YouTube id, since it changes whenever the stream restarts. The page builds
// the picture from YouTube's live thumbnail for that id.
async function resolveWebcams() {
  const out = {};
  for (const cam of WEBCAMS) {
    if (!cam.camstreamer) continue;
    try {
      const res = await fetch(`https://camstreamer.com/embed/${cam.camstreamer}`, { redirect: "manual" });
      const loc = res.headers.get("location") || "";
      const m = loc.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/);
      if (m) out[cam.id] = { youtube: m[1] };
      else console.log(`[webcam] ${cam.name}: no YouTube id in redirect (status ${res.status})`);
    } catch (err) {
      console.log(`[webcam] ${cam.name} failed: ${err.message}`);
    }
  }
  return out;
}

async function main() {
  const startedAt = new Date();
  const spotsOut = [];
  const liveVerifications = []; // new mismatches (>=20% error) found this run, appended to the persisted log below

  const overrides = await loadOverrides();
  await loadMosCoefficients();
  if (Object.keys(overrides).length) {
    console.log(`Loaded calibration overrides for: ${Object.keys(overrides).join(", ")}`);
  }

  const nowHourStr = currentPacificHourString(startedAt);

  // Fetched once, shared by every spot that uses it (pamRocksAware and/or
  // pamRocksTrigger — see rules.js) — a live nowcast only ever applies to
  // whichever hour is "right now," so there's no point fetching it per spot.
  let pamRocksObs = null;
  if (SPOTS.some((s) => s.pamRocksAware || s.pamRocksRule)) {
    try {
      pamRocksObs = await getLiveObservation(PAM_ROCKS_STATION);
    } catch (err) {
      console.log(`[live:Pam Rocks] fetch failed: ${err.message}`);
    }
  }

  console.log("Fetching daily take...");
  const dailyTakes = await fetchDailyTakes();

  console.log("Fetching Environment Canada marine bulletins...");
  const bulletins = {};
  for (const zone of MARINE_ZONES) {
    const b = await fetchMarineBulletin(zone);
    if (b) bulletins[b.id] = b;
  }

  console.log("Fetching wtfbc.ca surface observation board...");
  const swobBoardStations = await fetchSwobBoard();
  swobBoardForLive = swobBoardStations;
  console.log(`  parsed ${swobBoardStations.length} station(s)`);

  // A spot whose fetch fails goes to the back of the queue for one more
  // try after the others, instead of being dropped from the snapshot.
  const spotQueue = [...SPOTS];
  const retriedSpots = new Set();
  const requeue = (spot) => {
    if (retriedSpots.has(spot.id)) return;
    retriedSpots.add(spot.id);
    spotQueue.push(spot);
    console.log(`  will try ${spot.name} once more at the end`);
  };
  while (spotQueue.length) {
    const spot = spotQueue.shift();
    process.stdout.write(`Fetching ${spot.name}... `);
    let rows;
    try {
      rows = await fetchSpot(spot);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      requeue(spot);
      continue;
    }
    if (!rows) { console.log("skipped"); requeue(spot); continue; }
    console.log(`${rows.length} hours`);

    let refMap = null;
    if (spot.referenceStation) {
      try {
        refMap = await getReferenceSpeeds(spot.referenceStation);
      } catch (err) {
        console.log(`[${spot.id}] reference station fetch failed: ${err.message}`);
      }
    }

    let gm = null;
    if (spot.pressureGradientAware || spot.thermal?.learned) {
      try {
        gm = await getGradientStations();
      } catch (err) {
        console.log(`[${spot.id}] pressure gradient fetch failed: ${err.message}`);
      }
    }

    // Live reading from this spot's own reference station, for the
    // liveReferenceTrigger path (Erwin Park / Point Atkinson). Reuses the
    // liveStation fetch cache where the two point at the same station, which
    // they do for Erwin — so this costs no extra request.
    let liveRefObs = null;
    if (spot.liveReferenceTrigger && spot.liveStation) {
      try {
        liveRefObs = await getLiveObservation(spot.liveStation);
      } catch (err) {
        console.log(`[${spot.id}] live reference fetch failed: ${err.message}`);
      }
    }

    const mosInputs = spot.mos ? await fetchMosInputs(spot.mos.point) : null;
    const mosPoint = spot.mos ? mosCoefficients?.points?.[spot.mos.point] : null;

    const zoneBulletin = spot.marineZone ? bulletins[spot.marineZone] : null;
    const marineParsed = zoneBulletin?.parsed ?? null;

    // Index of "right now" in this spot's rows, so a live reading can be
    // carried a few hours forward (liveReferenceTrigger.persistHours).
    const nowIdx = rows.findIndex((r) => r.time === nowHourStr);
    const persistHours = spot.liveReferenceTrigger?.persistHours ?? 0;

    const hours = rows.map((row, rowIdx) => {
      const { hour, month } = localHourAndMonth(row.time);
      const refSpeedKt = refMap ? refMap[row.time] : null;
      const marineAnchor = marineParsed ? marineAnchorForHour(marineParsed, hour, row.time.slice(0, 10), spot) : null;

      let pressureGradients = null;
      if (gm) {
        const coastalP = gm.coastal[row.time], interiorP = gm.interior[row.time], mouthP = gm.mouth[row.time];
        const ownVals = Object.values(row.pressure).filter(v => v != null);
        const ownP = ownVals.length ? ownVals.reduce((a, b) => a + b, 0) / ownVals.length : null;
        pressureGradients = {
          largeScale: (coastalP != null && interiorP != null) ? coastalP - interiorP : null,
          local: (mouthP != null && ownP != null) ? mouthP - ownP : null,
        };
      }

      const overrideRecord = overrides[spot.id] || null;

      // Only ever attached to the row matching "right now" — it's a live
      // buoy reading, not a forecast time series (see rules.js).
      const pamRocksNow = ((spot.pamRocksAware || spot.pamRocksRule) && pamRocksObs && row.time === nowHourStr)
        ? { speedKt: pamRocksObs.speedKt, directionDeg: pamRocksObs.directionDeg }
        : null;

      // Live station readings describe "right now". A spot's trigger may
      // opt in to carrying the reading a couple of hours forward (fading
      // back toward the models, see rules.js); never further than that.
      const ahead = nowIdx >= 0 ? rowIdx - nowIdx : -1;
      const liveRefNow = (liveRefObs && ahead >= 0 && ahead <= persistHours)
        ? { speedKt: liveRefObs.speedKt, directionDeg: liveRefObs.directionDeg, hoursAhead: ahead }
        : null;

      // Learned correction for this hour, with how far ahead it is (its
      // uncertainty grows with lead time, see mosLeadFactor).
      let mosNow = null;
      if (mosPoint && mosInputs && mosInputs[row.time]) {
        mosNow = applyMos(mosPoint, mosInputs[row.time]);
        if (mosNow) mosNow.leadHours = nowIdx >= 0 ? Math.max(0, rowIdx - nowIdx) : null;
      }

      // Learned thermal estimate for this hour (Squamish), from the drivers.
      let thermalNow = null;
      if (spot.thermal?.learned && thermalModel && gm?.rows) {
        const refs = { mouth: gm.rows.mouth[row.time], coastal: gm.rows.coastal[row.time], interior: gm.rows.interior[row.time], far: gm.rows.far[row.time] };
        thermalNow = applyThermalModel(thermalModel, thermalInputs(row, refs, hour));
      }

      return classifyHour(spot, row, hour, month, refSpeedKt, pressureGradients, overrideRecord, pamRocksNow, marineAnchor, liveRefNow, mosNow, thermalNow);
    });

    // Tide state per hour (for spots with a tideStation), then the spot's
    // "possible epic day" signature, which can depend on it.
    const tideLevels = spot.tideStation ? await fetchTideLevels(spot.tideStation, startedAt) : null;
    const tideExtremes = spot.tideStation ? await fetchTideHilo(spot.tideStation, startedAt) : null;
    if (tideLevels) for (const h of hours) h.tide = tideForHour(tideLevels, h.time);
    // Swell index per hour (needs the tide trend above).
    swellForHours(spot, hours);
    const epicWindows = flagEpicHours(spot, hours);
    if (epicWindows.length) console.log(`  [epic:${spot.id}] ${epicWindows.map(w => `${w.date} ${w.start}-${w.end} peak ${w.peak_kt}kt`).join("; ")}`);

    // Live verification: compare the forecast for THIS hour against what
    // the nearest station is actually observing right now, and log EVERY
    // qualifying comparison (not just 20%+ mismatches) to
    // data/live-verification-log.json — apply-feedback.mjs pools that log
    // with rider reports on the next run to compute each spot's calibration
    // multiplier (see README). Previously only mismatches were logged, which
    // meant the multiplier could never converge back toward 1.0 even once a
    // spot's forecast was accurate — every data point that ever got recorded
    // was, by definition, a bad one.
    let liveCheck = null;
    if (spot.liveStation) {
      try {
        const obs = await getLiveObservation(spot.liveStation);
        const forecastHour = hours.find((h) => h.time === nowHourStr);
        // Log when EITHER side shows real wind. Logging only when we had
        // forecast 8kt+ meant a big miss the other way (forecast 2kt, Sand
        // Heads blowing 20, as on Sep 25 2026) was never recorded, so the
        // calibration could only ever learn "we forecast too high" and every
        // spot drifted down toward the 0.75 floor. The forecast side of the
        // ratio is floored so a near zero forecast can't blow the ratio up.
        const qualifies = obs && forecastHour && forecastHour.speed_kt != null &&
          (forecastHour.speed_kt >= LIVE_MIN_FORECAST_KT || obs.speedKt >= LIVE_MIN_FORECAST_KT);
        if (qualifies) {
          // Compare against the model blend, not a value a live reading or
          // EC's bulletin already set (that would just measure itself).
          const modelKt = forecastHour.model_speed_kt ?? forecastHour.speed_kt;
          const fcFloor = Math.max(modelKt, LIVE_RATIO_FLOOR_KT);
          // What the page showed vs what happened (for the UI pill and the
          // mismatch flag); the calibration log below uses the model blend.
          const shownFloor = Math.max(forecastHour.speed_kt, LIVE_RATIO_FLOOR_KT);
          const errorPct = (obs.speedKt - shownFloor) / shownFloor;
          const mismatch = Math.abs(errorPct) >= LIVE_ERROR_THRESHOLD;
          liveCheck = {
            checked_hour: nowHourStr,
            station: obs.sourceName || spot.liveStation.name,
            observed_local_time: obs.time,
            observed_age_min: obs.ageMin != null ? Math.round(obs.ageMin) : null,
            forecasted_kt: forecastHour.speed_kt,
            live_kt: obs.speedKt,
            live_gust_kt: obs.gustKt ?? null,
            live_direction: obs.directionLabel,
            error_pct: Math.round(errorPct * 100),
            mismatch,
            regime: forecastHour.regime,
          };
          if (mismatch) {
            liveCheck.reasoning = explainMismatch(forecastHour, errorPct);
            console.log(`  [live:${spot.id}] MISMATCH — forecast ${forecastHour.speed_kt}kt vs live ${obs.speedKt}kt (${liveCheck.error_pct > 0 ? "+" : ""}${liveCheck.error_pct}%)`);
          } else {
            console.log(`  [live:${spot.id}] match — forecast ${forecastHour.speed_kt}kt vs live ${obs.speedKt}kt (${liveCheck.error_pct > 0 ? "+" : ""}${liveCheck.error_pct}%)`);
          }
          liveVerifications.push({
            spot: spot.id,
            time: nowHourStr,
            forecasted: modelKt,
            actual: obs.speedKt,
            ratio: obs.speedKt / fcFloor,
            source: "live-station",
            station: obs.sourceName || spot.liveStation.name,
            regime: forecastHour.regime,
            mismatch,
            reasoning: mismatch ? liveCheck.reasoning : null,
            checked_at: startedAt.toISOString(),
          });
        }
      } catch (err) {
        console.log(`[${spot.id}] live verification failed: ${err.message}`);
      }
    }

    spotsOut.push({
      id: spot.id,
      name: spot.name,
      region: spot.region,
      lat: spot.lat,
      lon: spot.lon,
      sports: spot.sports,
      level: spot.level,
      hours,
      live_check: liveCheck,
      tide_station: spot.tideStation?.name ?? null,
      tide_extremes: tideExtremes || [],
      epic_windows: epicWindows,
    });

    // Be polite to the free API (spaced out more since Sep 28 2026).
    await new Promise((r) => setTimeout(r, 1000));
  }

  // "Live surface conditions" board: our own already-fetched live stations
  // (one entry per unique station, even though several spots can share one —
  // e.g. Jericho - Spanish Banks, Dundarave Pier Beach, and Ambleside all
  // use "Vancouver Harbour") plus every
  // additional station wtfbc.ca's board offers that we don't already have.
  // Riders like seeing the wider regional picture, not just the handful of
  // spots we actively forecast for. A few of wtfbc.ca's stations are the
  // exact same physical station as one we already fetch ourselves, just
  // under a slightly different name (see DUPLICATE_OF_OWN_STATION below) —
  // skip wtfbc's copy of those so the same station doesn't show two
  // slightly different readings side by side, which reads as a bug rather
  // than "two snapshots taken moments apart." Our own EC/igetwind fetch is
  // the source of truth here (more directly sourced, and already proven
  // out by the wind-column-index fix above), so it's always wtfbc's copy
  // that gets dropped, never ours.
  console.log("Building live surface conditions board...");
  const ownStations = [];
  const seenStationKeys = new Set();
  for (const spot of SPOTS) {
    if (!spot.liveStation) continue;
    const key = `${spot.liveStation.type || "ec"}:${spot.liveStation.code || spot.liveStation.windSrc || spot.liveStation.sid}`;
    if (seenStationKeys.has(key)) continue;
    seenStationKeys.add(key);
    try {
      const obs = await getLiveObservation(spot.liveStation); // cache hit in practice — already fetched above
      if (!obs || obs.fromFallback) continue; // a fallback is already on wtfbc's board under its own name
      ownStations.push({
        name: spot.liveStation.name,
        source_url: null,
        observed_local_time: obs.time,
        observed_age_min: obs.ageMin != null ? Math.round(obs.ageMin) : null,
        temp_c: null,
        direction_label: obs.directionLabel,
        speed_kt: obs.speedKt,
        gust_kt: obs.gustKt ?? null,
        source: "wind-guru",
      });
    } catch (err) {
      console.log(`[surface-board] ${spot.liveStation.name} failed: ${err.message}`);
    }
  }
  for (const buoy of BUOY_STATIONS) {
    try {
      const obs = await getLiveObservation(buoy); // no `type` — same EC path as fetchEcObservation above
      if (!obs) continue;
      ownStations.push({
        name: buoy.name,
        source_url: `https://weather.gc.ca/past_conditions/index_e.html?station=${buoy.code}`,
        observed_local_time: obs.time,
        observed_age_min: obs.ageMin != null ? Math.round(obs.ageMin) : null,
        temp_c: null,
        direction_label: obs.directionLabel,
        speed_kt: obs.speedKt,
        gust_kt: obs.gustKt ?? null,
        source: "wind-guru",
      });
    } catch (err) {
      console.log(`[surface-board] ${buoy.name} failed: ${err.message}`);
    }
  }
  // Name patterns for wtfbc.ca board entries that duplicate a station we
  // already have from our own fetch above — add to this list rather than
  // the loops above if another overlap turns up (it's a much smaller,
  // easier-to-scan diff than threading a dedupe key through both sources).
  const DUPLICATE_OF_OWN_STATION = [
    /pam rocks/i,       // ours: "Pam Rocks (Howe Sound entrance)" — wtfbc: "Howe Sound - Pam Rocks"
    /sand\s*heads/i,   // ours: "Sand Heads" — wtfbc: "Sandheads Cs"
    /point atkinson/i,  // ours: "Point Atkinson" — wtfbc: "Point Atkinson"
    /white rock/i,      // ours: "White Rock East Beach" (the city sensor, direct) — wtfbc: same sensor
    /tsawwassen/i,      // ours: "Tsawwassen Ferry Terminal" (EC vtf) — wtfbc's "Tsawwassen Ferry Auto" copy read 0 most of the time
  ];
  // wtfbc.ca's board also carries stations well outside our forecast area
  // (interior BC, Vancouver Island beyond the "south of Nanaimo" marine
  // zone) — those aren't useful to Howe Sound/Strait of Georgia riders and
  // just clutter the board, so drop them by name too.
  const OUTSIDE_OUR_AREA = [
    /merritt/i,   // interior BC, ~250km from Howe Sound
    /nanaimo/i,   // the town itself, not just the "south of Nanaimo" marine zone name
  ];
  const extraStations = swobBoardStations
    .filter((s) => !DUPLICATE_OF_OWN_STATION.some((re) => re.test(s.name)))
    .filter((s) => !OUTSIDE_OUR_AREA.some((re) => re.test(s.name)))
    .map((s) => ({ ...s, source: "wtfbc" }));
  const surfaceObservations = {
    updated_at: startedAt.toISOString(),
    board_source_url: SWOB_BOARD_URL,
    stations: [...ownStations, ...extraStations],
  };

  // If Open-Meteo rate-limits or errors out mid-run, individual spot
  // fetches fail and get skipped above (spotsOut just ends up shorter than
  // SPOTS) — previously that silently proceeded to overwrite
  // data/forecast.json with a partial snapshot anyway. Abort instead of
  // publishing anything if too many spots came back empty; a stale-but-
  // complete forecast already on GitHub Pages is a better failure mode than
  // a confusing partial one, and the Action step failing is itself a signal
  // (GitHub emails the repo owner on a failed scheduled workflow run).
  const MIN_SUCCESS_RATE = 0.7;
  const freshCount = spotsOut.length;
  const successRate = freshCount / SPOTS.length;
  if (successRate < MIN_SUCCESS_RATE) {
    console.error(`\nOnly ${spotsOut.length}/${SPOTS.length} spots fetched successfully (${Math.round(successRate * 100)}%) — aborting without writing data/forecast.json to avoid publishing a partial snapshot.`);
    process.exit(1);
  }

  // Merge this run's new comparisons into the persisted live-verification
  // log, capped per spot so it doesn't grow forever. apply-feedback.mjs
  // reads this file on the NEXT run (it runs before generate.mjs in the
  // Action) and pools it with rider reports — see README "Live verification".
  if (liveVerifications.length) {
    const mismatchCount = liveVerifications.filter((e) => e.mismatch).length;
    console.log(`\n${liveVerifications.length} live comparison(s) this run (${mismatchCount} mismatch(es)).`);
  }
  const existingLog = await loadLiveLog();
  const bySpotLog = {};
  for (const e of [...existingLog, ...liveVerifications]) (bySpotLog[e.spot] ||= []).push(e);
  const cappedEntries = [];
  for (const list of Object.values(bySpotLog)) {
    const dedup = new Map();
    for (const e of list) dedup.set(e.time, e); // same hour re-checked twice in a day: keep the latest
    const sorted = [...dedup.values()].sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at));
    cappedEntries.push(...sorted.slice(0, LIVE_LOG_MAX_PER_SPOT));
  }
  await mkdir(path.dirname(LIVE_LOG_PATH), { recursive: true });
  await writeFile(LIVE_LOG_PATH, JSON.stringify({ updated_at: startedAt.toISOString(), entries: cappedEntries }, null, 2));

  // Spots that still failed after the second try: rather than vanish from
  // the page with no explanation (Jericho, Oct 3 2026), carry the spot's
  // hours over from the previous snapshot, stamped with `stale_from` (when
  // those hours were actually generated) so the page can say so. Only while
  // the old hours are under MAX_CARRY_HOURS old; past that the spot is listed
  // in `missing_spots` instead, which the page also shows.
  const MAX_CARRY_HOURS = 24;
  const missingSpots = [];
  const gotIds = new Set(spotsOut.map((s) => s.id));
  if (gotIds.size < SPOTS.length) {
    const previous = await readFile(OUT_PATH, "utf8").then(JSON.parse).catch(() => null);
    for (const spot of SPOTS) {
      if (gotIds.has(spot.id)) continue;
      const old = previous?.spots?.find((s) => s.id === spot.id);
      const staleFrom = old ? (old.stale_from || previous.generated_at) : null;
      const ageH = staleFrom ? (startedAt.getTime() - new Date(staleFrom).getTime()) / 3600000 : Infinity;
      if (old && ageH >= 0 && ageH <= MAX_CARRY_HOURS) {
        spotsOut.push({ ...old, stale_from: staleFrom, live_check: null });
        console.log(`[${spot.id}] no forecast this run: carried over the ${staleFrom} hours (${ageH.toFixed(1)}h old).`);
      } else {
        missingSpots.push({ id: spot.id, name: spot.name });
        console.log(`[${spot.id}] no forecast this run and nothing recent to carry over: listed as missing.`);
      }
    }
  }
  // Back to the order of spots.js (retried and carried spots were appended).
  const spotOrder = new Map(SPOTS.map((s, i) => [s.id, i]));
  spotsOut.sort((a, b) => spotOrder.get(a.id) - spotOrder.get(b.id));

  const forecast = {
    generated_at: startedAt.toISOString(),
    generated_at_label: startedAt.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }),
    models_used: MODELS.map(m => m.label),
    marine_bulletins: bulletins,
    calibration_overrides: overrides,
    daily_takes: dailyTakes,
    live_verification_count: cappedEntries.length,
    mos_score: await readFile(path.join(__dirname, "..", "data", "mos-score.json"), "utf8").then(JSON.parse).catch(() => null),
    surface_observations: surfaceObservations,
    webcams: await resolveWebcams(),
    missing_spots: missingSpots,
    spots: spotsOut,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(forecast, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
