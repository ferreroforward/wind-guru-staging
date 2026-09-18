#!/usr/bin/env node
// Wind Guru — forecast snapshot generator.
// Fetches multi-model wind data for every spot, runs the rule engine, and
// writes data/forecast.json. Run twice a day by .github/workflows/update-forecast.yml,
// or manually: `node scripts/generate.mjs`.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SPOTS, PRESSURE_REFERENCE, degToLabel } from "../assets/spots.js";
import { buildForecastUrl, reshapeOpenMeteo, classifyHour, localHourAndMonth, rowsToPressureMap, rowsToSpeedMap, currentPacificHourString, explainMismatch, parseMarineWindText, marineAnchorForHour } from "../assets/rules.js";

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
const FORECAST_DAYS = 4; // "today" + 3 days ahead
const LIVE_ERROR_THRESHOLD = 0.20; // 20% — flag as a "mismatch" in the UI/console at this gap or bigger
const LIVE_LOG_MAX_PER_SPOT = 40; // cap so the log file doesn't grow forever
// Skip the % comparison below this forecast speed. Originally 2kt, which let
// near-calm hours dominate the log: the twice-daily runs land at ~5am/5pm, so
// almost every comparison was a calm-hour reading where % error is mostly
// noise (a 1kt miss on a 2kt forecast is "50% error"). Raised to 8kt so the
// calibration loop only ever learns from hours with real wind to measure.
const LIVE_MIN_FORECAST_KT = 8;
// Ignore a live observation older than this when comparing against "right
// now" — a frozen/stale sensor reading as unchanging for hours shouldn't be
// treated as live corroboration or logged as a calibration data point. Same
// cutoff igetwind observations already used; now applied uniformly to every
// source (EC, Squamish Windsports, igetwind) via getLiveObservation.
const MAX_LIVE_OBS_AGE_MIN = 180;

// Same station Porteau Cove uses as its own live-check (see spots.js) —
// reused here as a same-day nowcast input for any spot with pamRocksAware
// and/or pamRocksTrigger set. Defined once so getLiveObservation's cache key
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
// (not forecast) hourly station data: weather.gc.ca/past_conditions. Table
// columns are Date/Time, Conditions, Temperature, Wind, Humidex, Relative
// humidity, Dew point, Pressure, Visibility. We parse actual <tr>/<td> cells
// rather than scraping flattened text, since date-separator rows only have
// one populated cell and would otherwise be easy to misread as data.
function parseEcObservedWind(html) {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
  const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();

  const rows = [];
  let rm;
  while ((rm = rowRe.exec(html))) {
    const cells = [];
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[1]))) cells.push(stripTags(cm[1]));
    // Data rows start with an "HH:MM" cell; date-separator rows ("13 August
    // 2026") and the header row don't match this and are skipped.
    if (cells.length >= 4 && /^\d{2}:\d{2}$/.test(cells[0])) rows.push(cells);
  }
  if (!rows.length) return null;

  const latest = rows[0]; // rows are most-recent-first
  const time = latest[0];
  const windRaw = latest[3];
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
    if (!m) return null;
    directionAbbr = m[1];
    directionLabel = m[2] || m[1];
    speedKmh = parseFloat(m[3]);
    gustKmh = m[4] != null ? parseFloat(m[4]) : null;
  }
  return {
    time, // "HH:MM" Pacific, no date attached
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
  return parseEcObservedWind(html);
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
    time: dtMs ? new Date(dtMs).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null,
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

const liveObsCache = {};
async function getLiveObservation(station) {
  const cacheKey = `${station.type || "ec"}:${station.code || station.windSrc || station.sid}`;
  if (liveObsCache[cacheKey]) return liveObsCache[cacheKey];
  try {
    let parsed = station.type === "squamishwindsports" ? await fetchSquamishWindsportsObservation(station)
      : station.type === "igetwind" ? await fetchIgetwindObservation(station)
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
  const url = buildForecastUrl(spot.lat, spot.lon, FORECAST_DAYS);
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) {
    console.error(`[${spot.id}] fetch failed: ${res.status} ${res.statusText}`);
    return null;
  }
  const json = await res.json();
  return reshapeOpenMeteo(json);
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
    const parsed = winds ? parseMarineWindText(winds.text) : null;
    if (parsed) {
      console.log(`  [marine:${zone.id}] parsed ${parsed.segments.length} segment(s), ${parsed.minKt}-${parsed.maxKt}kt${parsed.hasOutflow ? ", OUTFLOW named" : ""}${parsed.hasInflow ? ", INFLOW named" : ""}`);
    } else {
      console.log(`  [marine:${zone.id}] no parseable wind text — anchoring disabled for this zone this run.`);
    }
    const warning = /strong wind warning|gale warning|storm warning|small craft warning/i.test(html);
    return { id: zone.id, label: zone.label, url, text, issued: winds?.issued ?? null, warning, parsed };
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
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
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
  const [interiorRows, coastalRows, mouthRows] = await Promise.all([
    getStationRows(PRESSURE_REFERENCE.interior),
    getStationRows(PRESSURE_REFERENCE.coastal),
    getStationRows(PRESSURE_REFERENCE.howeSoundMouth),
  ]);
  gradientStations = {
    interior: interiorRows ? rowsToPressureMap(interiorRows) : {},
    coastal: coastalRows ? rowsToPressureMap(coastalRows) : {},
    mouth: mouthRows ? rowsToPressureMap(mouthRows) : {},
  };
  return gradientStations;
}

async function main() {
  const startedAt = new Date();
  const spotsOut = [];
  const liveVerifications = []; // new mismatches (>=20% error) found this run, appended to the persisted log below

  const overrides = await loadOverrides();
  if (Object.keys(overrides).length) {
    console.log(`Loaded calibration overrides for: ${Object.keys(overrides).join(", ")}`);
  }

  const nowHourStr = currentPacificHourString(startedAt);

  // Fetched once, shared by every spot that uses it (pamRocksAware and/or
  // pamRocksTrigger — see rules.js) — a live nowcast only ever applies to
  // whichever hour is "right now," so there's no point fetching it per spot.
  let pamRocksObs = null;
  if (SPOTS.some((s) => s.pamRocksAware || s.pamRocksTrigger)) {
    try {
      pamRocksObs = await getLiveObservation(PAM_ROCKS_STATION);
    } catch (err) {
      console.log(`[live:Pam Rocks] fetch failed: ${err.message}`);
    }
  }

  console.log("Fetching Environment Canada marine bulletins...");
  const bulletins = {};
  for (const zone of MARINE_ZONES) {
    const b = await fetchMarineBulletin(zone);
    if (b) bulletins[b.id] = b;
  }

  console.log("Fetching wtfbc.ca surface observation board...");
  const swobBoardStations = await fetchSwobBoard();
  console.log(`  parsed ${swobBoardStations.length} station(s)`);

  for (const spot of SPOTS) {
    process.stdout.write(`Fetching ${spot.name}... `);
    let rows;
    try {
      rows = await fetchSpot(spot);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      continue;
    }
    if (!rows) { console.log("skipped"); continue; }
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
    if (spot.pressureGradientAware) {
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

    const zoneBulletin = spot.marineZone ? bulletins[spot.marineZone] : null;
    const marineParsed = zoneBulletin?.parsed ?? null;

    const hours = rows.map((row) => {
      const { hour, month } = localHourAndMonth(row.time);
      const refSpeedKt = refMap ? refMap[row.time] : null;
      const marineAnchor = marineParsed ? marineAnchorForHour(marineParsed, hour) : null;

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
      const pamRocksNow = ((spot.pamRocksAware || spot.pamRocksTrigger) && pamRocksObs && row.time === nowHourStr)
        ? { speedKt: pamRocksObs.speedKt, directionDeg: pamRocksObs.directionDeg }
        : null;

      // Live station readings only ever describe "right now", never a future
      // hour — same rule as pamRocksNow above.
      const liveRefNow = (liveRefObs && row.time === nowHourStr)
        ? { speedKt: liveRefObs.speedKt, directionDeg: liveRefObs.directionDeg }
        : null;

      return classifyHour(spot, row, hour, month, refSpeedKt, pressureGradients, overrideRecord, pamRocksNow, marineAnchor, liveRefNow);
    });

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
        if (obs && forecastHour && forecastHour.speed_kt != null && forecastHour.speed_kt >= LIVE_MIN_FORECAST_KT) {
          const errorPct = (obs.speedKt - forecastHour.speed_kt) / forecastHour.speed_kt;
          const mismatch = Math.abs(errorPct) >= LIVE_ERROR_THRESHOLD;
          liveCheck = {
            checked_hour: nowHourStr,
            station: spot.liveStation.name,
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
            forecasted: forecastHour.speed_kt,
            actual: obs.speedKt,
            ratio: obs.speedKt / forecastHour.speed_kt,
            source: "live-station",
            station: spot.liveStation.name,
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
    });

    // Be polite to the free API.
    await new Promise((r) => setTimeout(r, 300));
  }

  // "Live surface conditions" board: our own already-fetched live stations
  // (one entry per unique station, even though several spots can share one —
  // e.g. Jericho - Spanish Banks, Dundarave Pier Beach, and Ambleside all
  // use "Vancouver Harbour") plus every
  // additional station wtfbc.ca's board offers that we don't already have.
  // Riders like seeing the wider regional picture, not just the handful of
  // spots we actively forecast for. The one genuine overlap between the two
  // sources is Pam Rocks (our own Porteau Cove liveStation *is* wtfbc.ca's
  // "Howe Sound - Pam Rocks" entry) — skip wtfbc's copy there so the same
  // physical station doesn't show two slightly different numbers side by
  // side, which would look like a bug rather than just two snapshots taken
  // moments apart.
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
      if (!obs) continue;
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
  const extraStations = swobBoardStations
    .filter((s) => !/pam rocks/i.test(s.name))
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
  const successRate = spotsOut.length / SPOTS.length;
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

  const forecast = {
    generated_at: startedAt.toISOString(),
    generated_at_label: startedAt.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }),
    models_used: ["GFS (NOAA)", "ECMWF IFS", "ICON (DWD)", "GEM / HRDPS (ECCC)"],
    marine_bulletins: bulletins,
    calibration_overrides: overrides,
    live_verification_count: cappedEntries.length,
    surface_observations: surfaceObservations,
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
