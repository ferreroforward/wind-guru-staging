// Wind Guru — meteorologist rule engine.
// Turns raw multi-model wind data into a per-hour regime classification,
// a plain-English reason, and a probability of the wind landing in a
// user-chosen knot range.
//
// Works in both Node (generate.mjs) and the browser (index.html), no
// dependencies — import as an ES module in both places.

import { inSector, degToLabel } from "./spots.js";

// Models requested from Open-Meteo: every model with real data for this
// area (checked Sep 2026 at the Garry Point water point), per Guillermo:
// "use all the models available for the area, the more the better".
//
// The first four keep their original keys and sources on purpose: several
// local calibrations (Squamish thermal scaling, fine vs coarse gap, Erwin's
// reference offset) were fitted against exactly these. Note gfs_seamless is
// really NOAA's HRRR 3km for its first ~60 hours here (Open-Meteo's GFS
// blend hands over to GFS after that), and gem_seamless is HRDPS 2.5km for
// its first ~54 hours, then GEM regional/global.
//
// `weight`: how much a model counts in the blend. Scored against Sand Heads
// on Sep 25 2026, every 3km or finer model was within ~3-6kt while the
// ~13km+ globals were off by ~10kt (they can't resolve the Strait's coast
// and terrain), matching riders' experience that the 3km models do best
// here, especially away from pure thermal spots. An equal weight average
// of all 15 was actually WORSE than the 3km models alone that day (mean
// error 5.6kt vs 4.7kt, 7am to 4pm at the Garry Point water point); 6/2/1
// keeps every model in while recovering most of that (4.9kt). So: 3km or
// finer counts 6x, ~10km regional 2x, coarse global 1x. All of them still
// feed the agreement check (modelAgreement). Where two "models" return the
// identical value in an hour (a seamless blend that has fallen back to the
// same global run), only one copy counts, at the lower weight (see
// dedupeRow).
//
// Not available from Open-Meteo for this area: HRW 3km (NOAA WRF window).
export const MODELS = [
  { key: "gfs", param: "gfs_seamless", label: "HRRR 3km (NOAA), then GFS", resolution: "fine", weight: 6 },
  { key: "ecmwf", param: "ecmwf_ifs025", label: "ECMWF 25km", resolution: "coarse", weight: 1 },
  { key: "icon", param: "icon_seamless", label: "ICON 13km (DWD)", resolution: "coarse", weight: 1 },
  { key: "gem", param: "gem_seamless", label: "HRDPS 2.5km (ECCC), then GEM", resolution: "fine", weight: 6 },
  { key: "nam", param: "ncep_nam_conus", label: "NAM 3km (NOAA)", resolution: "fine", weight: 6 },
  { key: "hrdps_west", param: "gem_hrdps_west", label: "HRDPS West 1km (ECCC)", resolution: "fine", weight: 6 },
  { key: "nbm", param: "ncep_nbm_conus", label: "NBM 2.5km blend (NOAA)", resolution: "fine", weight: 6 },
  { key: "gem_regional", param: "gem_regional", label: "GEM Regional 10km (ECCC)", resolution: "regional", weight: 2 },
  { key: "ecmwf_hres", param: "ecmwf_ifs", label: "ECMWF 9km", resolution: "regional", weight: 2 },
  { key: "ukmo", param: "ukmo_global_deterministic_10km", label: "UK Met Office 10km", resolution: "regional", weight: 2 },
  { key: "gfs_global", param: "gfs_global", label: "GFS 13km (NOAA)", resolution: "coarse", weight: 1 },
  { key: "gem_global", param: "gem_global", label: "GEM Global 15km (ECCC)", resolution: "coarse", weight: 1 },
  { key: "arpege", param: "meteofrance_arpege_world", label: "ARPEGE (Meteo France)", resolution: "coarse", weight: 1 },
  { key: "jma", param: "jma_gsm", label: "JMA GSM", resolution: "coarse", weight: 1 },
  { key: "cma", param: "cma_grapes_global", label: "CMA GRAPES", resolution: "coarse", weight: 1 },
  { key: "aifs", param: "ecmwf_aifs025_single", label: "ECMWF AIFS (AI)", resolution: "coarse", weight: 1 },
];
const MODEL_WEIGHT = Object.fromEntries(MODELS.map(m => [m.key, m.weight ?? 1]));

// Which models set the headline number (spots with a learned correction use
// that instead, see applyMos). From the Sep 2026 back tests: over six weeks
// NBM had the smallest error of all 16 models (3.0kt) and HRDPS West 1km
// was next; over a year, NBM or HRDPS West was best or within 0.3kt of best
// at every station, while the plain average of all 16 caught only 9% of the
// windy hours. So: the mean of NBM and HRDPS West where either has a value,
// else NAM 3km and HRDPS 2.5km (the first ~54h of gem_seamless), else the
// weighted mean of everything.
export const LEAD_MODELS = [["nbm", "hrdps_west"], ["nam", "gem"]];
export function leadModelMean(row, field) {
  const vals = row[field] || {};
  for (const set of LEAD_MODELS) {
    const v = set.map(k => vals[k]).filter(x => x != null);
    if (v.length) return v.reduce((a, b) => a + b, 0) / v.length;
  }
  return weightedMean(vals, row);
}

// Weight of a model in this row (after dedupe), default from MODELS.
export function modelWeight(row, key) {
  return (row && row.weights && row.weights[key] != null) ? row.weights[key] : (MODEL_WEIGHT[key] ?? 1);
}

// Weighted mean over whichever models have a value.
export function weightedMean(values, row) {
  let sum = 0, wsum = 0;
  for (const [k, v] of Object.entries(values || {})) {
    if (v == null) continue;
    const w = modelWeight(row, k);
    sum += v * w; wsum += w;
  }
  return wsum ? sum / wsum : null;
}

// The seamless blends fall back to a global run once their high resolution
// source ends (gfs_seamless -> GFS after HRRR's ~60h, gem_seamless -> GEM
// regional/global after HRDPS's ~54h), so later hours can carry the same
// run twice. For those known pairs only, identical values in an hour are
// counted once: the legacy key survives (calibrations read it) at the lower
// weight, since the value is the coarser model's. Limited to known pairs so
// two genuinely different models that happen to match are never merged.
const SEAMLESS_FALLBACKS = [["gfs", "gfs_global"], ["gem", "gem_regional"], ["gem", "gem_global"]];
function dedupeRow(row) {
  row.weights = {};
  for (const k of Object.keys(row.speeds)) row.weights[k] = MODEL_WEIGHT[k] ?? 1;
  for (const [keep, drop] of SEAMLESS_FALLBACKS) {
    if (!(keep in row.speeds) || !(drop in row.speeds)) continue;
    const same = Math.abs(row.speeds[keep] - row.speeds[drop]) < 0.05 &&
      (row.dirs[keep] == null || row.dirs[drop] == null || Math.abs(row.dirs[keep] - row.dirs[drop]) < 0.5) &&
      (row.gusts[keep] == null || row.gusts[drop] == null || Math.abs(row.gusts[keep] - row.gusts[drop]) < 0.05);
    if (!same) continue;
    row.weights[keep] = Math.min(row.weights[keep], row.weights[drop]);
    for (const field of ["speeds", "gusts", "dirs", "cloud", "pressure", "precip", "temp", "upperSpeeds", "upperDirs", "radiation"]) delete row[field][drop];
    delete row.weights[drop];
  }
}

// Agreement per Guillermo's rule of thumb: when the models land on the same
// speed, give or take 15%, it's normally a good forecast. Returns the share
// of model weight within +/-15% of the weighted median (with a 2kt floor so
// near calm hours aren't judged on tiny numbers), and whether that counts as
// "models agree" (at least 80% of the weight, from 4+ models).
export function modelAgreement(row, speeds = row.speeds) {
  const entries = Object.entries(speeds || {}).filter(([, v]) => v != null);
  if (entries.length < 2) return { share: 0.5, agree: false, median: entries[0]?.[1] ?? null, count: entries.length };
  const sorted = entries.map(([k, v]) => ({ v, w: modelWeight(row, k) })).sort((a, b) => a.v - b.v);
  const total = sorted.reduce((a, e) => a + e.w, 0);
  let acc = 0, median = sorted[sorted.length - 1].v;
  for (const e of sorted) { acc += e.w; if (acc >= total / 2) { median = e.v; break; } }
  const tol = Math.max(0.15 * median, 2);
  const inside = sorted.filter(e => Math.abs(e.v - median) <= tol).reduce((a, e) => a + e.w, 0);
  const share = inside / total;
  return { share, agree: share >= 0.8 && entries.length >= 4, median, count: entries.length };
}

export function buildForecastUrl(lat, lon, days = 4) {
  const models = MODELS.map(m => m.param).join(",");
  // wind_speed_850hPa / wind_direction_850hPa: upper-level (~1500m) wind —
  // used to catch synoptic SW flow strong enough to suppress the surface
  // thermal, and to flag gusty conditions (see classifyHour).
  // shortwave_radiation: actual solar loading (W/m²) reaching the ground —
  // a continuous, more accurate stand-in for "is the sun really cooking
  // the interior" than a flat cloud-cover percentage cutoff.
  const hourly = [
    "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "cloud_cover",
    "pressure_msl", "precipitation", "temperature_2m",
    "wind_speed_850hPa", "wind_direction_850hPa", "shortwave_radiation",
  ].join(",");
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=${hourly}&models=${models}&wind_speed_unit=kn&timezone=America%2FLos_Angeles&forecast_days=${days}`;
}

// Reshape Open-Meteo's multi-model response (one array per variable per
// model, keyed like "wind_speed_10m_gem_seamless") into per-hour records:
// [{ time, speeds:{gfs,ecmwf,icon,gem}, gusts:{...}, dirs:{...}, cloud:{...}, pressure:{...}, precip:{...}, temp:{...}, upperSpeeds:{...}, upperDirs:{...}, radiation:{...} }, ...]
export function reshapeOpenMeteo(json) {
  const hourly = json.hourly || {};
  const time = hourly.time || [];
  const rows = time.map((t) => ({
    time: t, speeds: {}, gusts: {}, dirs: {}, cloud: {}, pressure: {}, precip: {}, temp: {},
    upperSpeeds: {}, upperDirs: {}, radiation: {},
  }));

  for (const m of MODELS) {
    const sKey = `wind_speed_10m_${m.param}`;
    const gKey = `wind_gusts_10m_${m.param}`;
    const dKey = `wind_direction_10m_${m.param}`;
    const cKey = `cloud_cover_${m.param}`;
    const pKey = `pressure_msl_${m.param}`;
    const rKey = `precipitation_${m.param}`;
    const tKey = `temperature_2m_${m.param}`;
    const usKey = `wind_speed_850hPa_${m.param}`;
    const udKey = `wind_direction_850hPa_${m.param}`;
    const swKey = `shortwave_radiation_${m.param}`;
    const s = hourly[sKey], g = hourly[gKey], d = hourly[dKey], c = hourly[cKey], p = hourly[pKey], r = hourly[rKey], t = hourly[tKey];
    const us = hourly[usKey], ud = hourly[udKey], sw = hourly[swKey];
    rows.forEach((row, i) => {
      if (s && s[i] != null) row.speeds[m.key] = s[i];
      if (g && g[i] != null) row.gusts[m.key] = g[i];
      if (d && d[i] != null) row.dirs[m.key] = d[i];
      if (c && c[i] != null) row.cloud[m.key] = c[i];
      if (p && p[i] != null) row.pressure[m.key] = p[i];
      if (r && r[i] != null) row.precip[m.key] = r[i];
      if (t && t[i] != null) row.temp[m.key] = t[i];
      if (us && us[i] != null) row.upperSpeeds[m.key] = us[i];
      if (ud && ud[i] != null) row.upperDirs[m.key] = ud[i];
      if (sw && sw[i] != null) row.radiation[m.key] = sw[i];
    });
  }
  rows.forEach(dedupeRow);
  return rows;
}

// Local calibration for Howe Sound thermal spots (Squamish Spit, Furry
// Creek), sourced from a 12-year local rider's field notes (Jack Rieder,
// West Coast Wind Sports, Aug 2026 — see README). His finding: the raw
// coarse-model (GFS-class, ~13km) SW wind speed badly under-reads the real
// Squamish thermal, by a fairly consistent ratio once it's actually
// inflowing:
//   5-7kt modeled SW  -> 15-20kt real
//   7-9kt modeled SW  -> 20-25kt real
//   9kt+ modeled SW   -> "strong day" (25kt+)
// All three bins average out to roughly a 2.85x multiplier, which is what
// we apply here. This does NOT apply to the fine-resolution GEM/HRDPS
// model, which already attempts to resolve the thermal directly.
//
// The source field notes only covered 5-9kt modeled wind — applying the
// multiplier with no ceiling to a stronger coarse-model reading produces
// unsafe-looking numbers (e.g. 22kt coarse -> 62.7kt "forecast"), well past
// anything the calibration was ever validated against. Above
// CALIBRATED_OUTPUT_CAP_KT we taper the excess with a soft asymptotic curve
// instead of cutting it off sharply — still lets a genuinely extreme day
// read as "strong," just doesn't keep scaling linearly forever.
const SQUAMISH_THERMAL_MULTIPLIER = 2.85;
const CALIBRATED_OUTPUT_CAP_KT = 32;
const CALIBRATED_TAPER_SOFTNESS = 8; // smaller = harder taper above the cap

function calibrateSquamishThermal(coarseMeanKt) {
  if (coarseMeanKt == null || coarseMeanKt <= 0) return null;
  const raw = coarseMeanKt * SQUAMISH_THERMAL_MULTIPLIER;
  if (raw <= CALIBRATED_OUTPUT_CAP_KT) return raw;
  const excess = raw - CALIBRATED_OUTPUT_CAP_KT;
  return CALIBRATED_OUTPUT_CAP_KT + excess / (1 + excess / CALIBRATED_TAPER_SOFTNESS);
}

// Gust-over-average ratio for a calibrated Squamish-family thermal hour,
// direction-dependent rather than one flat number. Source: an independent
// Squamish-Spit-focused forecast tool (spitwind.ca, checked Aug 2026),
// which tracks this from its own live sensor history — a typical on-axis
// day there gusts about 21% over its average speed, but a day that's
// drifted west of the main SW inflow axis runs meaningfully gustier, up to
// ~36% over. We don't have that sensor history ourselves, so this is a
// directionally-informed refinement of the previous flat 1.3x (30% over),
// not a locally-validated number — revisit once our own live-verification
// log has enough gust data to check it. Blends linearly from 1.21x right on
// the 200° inflow axis up to 1.36x by the time direction reaches due west
// (270°) or beyond; south-of-axis (150-200°) stays at the base 1.21x since
// spitwind's finding was specifically about west-drifting days.
function calibratedGustMultiplier(directionDeg) {
  if (directionDeg == null) return 1.21;
  const driftFromAxisToward270 = Math.max(0, Math.min(1, (directionDeg - 200) / 70));
  return 1.21 + driftFromAxisToward270 * 0.15;
}

// ---------------------------------------------------------------------------
// Environment Canada marine bulletin parsing.
//
// EC's marine forecasts are written by human forecasters and — critically —
// they name the mesoscale pattern explicitly ("southerly inflow 10 to 20",
// "northeasterly outflow 5 to 15"). That's exactly the signal coarse global
// models routinely miss, and it's why a rider checking EC will beat a rider
// checking raw model output on a gradient day.
//
// Worked example this was built against (Aug 26 2026): the Strait of Georgia
// bulletin issued the previous morning called "southeast 15 to 20 near
// midnight then diminishing to southeast 10 to 15 early Wednesday morning."
// Riders scored a 4m/5m session at Erwin Park (which favors E-SE) at 6am that
// Wednesday and reported it fading — matching EC almost exactly, while our
// model-only estimate for the same hour was ~6kt. We were already fetching
// this page and only ever rendering it as a link.
// ---------------------------------------------------------------------------

const DIR_WORD_DEG = {
  north: 0, northeast: 45, east: 90, southeast: 135,
  south: 180, southwest: 225, west: 270, northwest: 315,
  northerly: 0, northeasterly: 45, easterly: 90, southeasterly: 135,
  southerly: 180, southwesterly: 225, westerly: 270, northwesterly: 315,
};
// Longest-first so "northeasterly" matches before "north", "southeast" before
// "south" — otherwise a substring match would silently mis-assign direction.
const DIR_WORDS = Object.keys(DIR_WORD_DEG).sort((a, b) => b.length - a.length);

// ---------------------------------------------------------------------------
// Timing: EC chains a day's conditions as a sequence ("northwest 15 to 20
// knots ... increasing to northwest 20 to 30 this morning then diminishing to
// westerly 5 to 15 late this afternoon ... becoming light Saturday morning").
// Each clause says when a change STARTS; the condition then holds until the
// next clause takes over. So we place every clause on a real calendar
// timeline (date + hour), resolved against the bulletin's own issue time, and
// look hours up on that timeline.
//
// The earlier version matched timing phrases by hour of day only, ignoring
// which DAY they named. Two real failures came straight out of that, both
// the same week (see README "Sep 25 2026 case study"):
//   - Thu Sep 24: "northwest 15 to 25 Friday morning" was applied to
//     Thursday morning, putting a flat, bogus 17kt on Jericho while it was
//     calm.
//   - Fri Sep 25: "light Saturday morning" (the last clause) overwrote
//     "northwest 20 to 30 this morning" for Friday's 6 to 11am, so the anchor
//     never fired on the very morning it existed for. Sand Heads blew NW 21
//     to 24kt from 9am to 1pm.
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];

// Hour a named part of the day starts, with EC's early/late qualifiers.
const PART_START = {
  morning:   { early: 4,  plain: 6,  late: 9 },
  afternoon: { early: 12, plain: 12, late: 15 },
  evening:   { early: 17, plain: 17, late: 21 },
  night:     { early: 20, plain: 20, late: 23 },
};

const pad2 = (n) => String(n).padStart(2, "0");
export function addDaysToDateStr(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekdayOfDateStr(dateStr) { return new Date(dateStr + "T12:00:00Z").getUTCDay(); }
// Local wall clock as a sortable number of hours. Only ever compared with
// other values from this same function, so treating the local date as if it
// were UTC is fine (no DST arithmetic involved).
function hourKey(dateStr, hour) { return Date.parse(dateStr + "T00:00:00Z") / 3600000 + hour; }

// "04:38 AM PDT 25 September 2026" -> { dateStr: "2026-09-25", hour: 4 }
export function parseEcIssued(issued) {
  if (!issued) return null;
  const m = String(issued).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[A-Z]{3,4}\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const ampm = (m[3] || "").toUpperCase();
  if (ampm) hour = (hour % 12) + (ampm === "PM" ? 12 : 0);
  const mon = MONTH_NAMES.indexOf(m[5].toLowerCase());
  if (mon < 0) return null;
  return { dateStr: `${m[6]}-${pad2(mon + 1)}-${pad2(Number(m[4]))}`, hour };
}

// Pull the timing phrase out of one clause. Returns
// { timing, dayRef, startHour } where dayRef is "this" (issue day), a weekday
// index 0-6, "next" (the day after the previous clause, for "after
// midnight") or "same" (the previous clause's day), or null when the clause
// names no time at all.
function parseTiming(chunk) {
  const c = chunk.toLowerCase();
  let m;
  if ((m = c.match(/\bafter midnight\b/))) return { timing: m[0], dayRef: "next", startHour: 0 };
  if ((m = c.match(/\b(?:near midnight|overnight)\b/))) return { timing: m[0], dayRef: "same", startHour: 23 };
  if ((m = c.match(/\blate in the day\b/))) return { timing: m[0], dayRef: "this", startHour: 16 };
  if ((m = c.match(/\bnear noon(?:\s+(today|[a-z]+day))?\b/))) {
    const d = m[1] && m[1] !== "today" ? WEEKDAY_NAMES.indexOf(m[1]) : -1;
    return { timing: m[0], dayRef: d >= 0 ? d : "this", startHour: 11 };
  }
  if ((m = c.match(/\b(early |late )?tonight\b/))) {
    return { timing: m[0], dayRef: "this", startHour: m[1]?.trim() === "late" ? 23 : 20 };
  }
  if ((m = c.match(/\b(?:(early|late) )?(this|today|[a-z]+day) (morning|afternoon|evening|night)\b/))) {
    const qual = m[1] || "plain";
    const startHour = PART_START[m[3]][qual];
    const d = WEEKDAY_NAMES.indexOf(m[2]);
    return { timing: m[0], dayRef: d >= 0 ? d : "this", startHour };
  }
  if ((m = c.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    return { timing: m[0], dayRef: WEEKDAY_NAMES.indexOf(m[1]), startHour: 6 };
  }
  return null;
}

function resolveDay(dayRef, issueDate, prevDate, prevHour) {
  if (dayRef === "this") return issueDate;
  if (dayRef === "same") return prevDate;
  if (dayRef === "next") return prevHour >= 12 ? addDaysToDateStr(prevDate, 1) : prevDate;
  // Weekday: the first date on or after the issue date with that weekday.
  let d = issueDate;
  for (let i = 0; i < 7 && weekdayOfDateStr(d) !== dayRef; i++) d = addDaysToDateStr(d, 1);
  return d;
}

// How long the LAST clause is assumed to hold when nothing follows it.
const MARINE_TAIL_HOURS = 12;
// Clauses with no timing phrase after the first one ("... then easing to
// 10") can't be placed exactly; assume the change comes a few hours on.
const UNTIMED_STEP_HOURS = 3;

// Turn an EC marine wind paragraph into timed segments. `issued` is EC's
// "Issued" string (or an already parsed { dateStr, hour }); every timing
// phrase is resolved against it. Returns null if nothing parseable was
// found; callers must then treat the EC anchor as unavailable rather than
// guessing.
export function parseMarineWindText(text, issued = null) {
  if (!text) return null;
  let clean = String(text).replace(/\s+/g, " ").trim();
  // Drop EC's period label ("Today Tonight and Saturday.", "Tonight and
  // Friday.") so its "tonight" isn't mistaken for the first clause's timing.
  clean = clean.replace(/^(?:(?:today|tonight|tomorrow|this (?:morning|afternoon|evening)|[a-z]+day(?: night)?)(?:\s*,\s*|\s+and\s+|\s+)?)+\.\s*/i, "");

  const iss = typeof issued === "string" ? parseEcIssued(issued) : issued;

  // Split on the transition markers EC uses to chain conditions through a
  // day, including the "... and to northwest 20 to 30 late Friday morning"
  // form that chains a second change onto the same verb.
  const parts = clean.split(/\b(?:then|becoming|increasing to|diminishing to|rising to|easing to|veering to|backing to|and to)\b/i);

  const segments = [];
  let prevDate = iss?.dateStr ?? null, prevHour = iss?.hour ?? 0, prevKey = null;
  for (const rawPart of parts) {
    // "southeast 10 to 15 early this evening except southwest 15 to 20 over
    // southern sections": before "except" is the zone's main forecast, the
    // tail is a sub area caveat. Kept, but only used by spots that sit in
    // that sub area (see marineExceptionAreas in spots.js).
    const pieces = rawPart.split(/\bexcept\b/i);
    let parent = null;
    for (let pi = 0; pi < pieces.length; pi++) {
      const chunk = pieces[pi].trim();
      if (!chunk) continue;

      // "light" with no number is a real EC value meaning near calm.
      const isLight = /\blight\b/i.test(chunk) && !/\d/.test(chunk);
      let loKt = null, hiKt = null;
      const range = chunk.match(/\b(\d{1,2})\s+to\s+(\d{1,3})\b/);
      // A lone number ("southwesterly inflow 25 near noon") is a speed too;
      // the old "knots" requirement silently dropped clauses like that.
      const single = chunk.match(/\b(\d{1,2})\b(?!\s*(?:to\b|:))/);
      if (range) { loKt = Number(range[1]); hiKt = Number(range[2]); }
      else if (single) { loKt = hiKt = Number(single[1]); }
      else if (isLight) { loKt = 0; hiKt = 5; }
      if (loKt == null) continue;

      let directionLabel = null, directionDeg = null;
      for (const w of DIR_WORDS) {
        if (new RegExp(`\\b${w}\\b`, "i").test(chunk)) {
          directionLabel = w; directionDeg = DIR_WORD_DEG[w]; break;
        }
      }
      const regime = /\boutflow\b/i.test(chunk) ? "outflow"
        : /\binflow\b/i.test(chunk) ? "inflow" : null;

      if (pi > 0) {
        const areaM = chunk.match(/\b(?:near|over|in|for|along|off)\b.*$/i);
        const ex = { raw: chunk, loKt, hiKt, directionLabel, directionDeg, regime,
          area: (areaM ? areaM[0] : chunk).split(".")[0].toLowerCase().trim(), isException: true };
        if (parent) parent.exceptions.push(ex);
        segments.push(ex);
        continue;
      }

      const t = parseTiming(chunk);
      let dateStr = null, startHour = null;
      if (prevDate) {
        if (t) {
          dateStr = resolveDay(t.dayRef, iss?.dateStr ?? prevDate, prevDate, prevHour);
          startHour = t.startHour;
        } else if (prevKey == null) {
          dateStr = prevDate; startHour = prevHour; // opening clause: from issue time on
        } else {
          dateStr = addDaysToDateStr(prevDate, Math.floor((prevHour + UNTIMED_STEP_HOURS) / 24));
          startHour = (prevHour + UNTIMED_STEP_HOURS) % 24;
        }
      }
      let startKey = dateStr ? hourKey(dateStr, startHour) : null;
      // EC's clauses always run forward in time; if our reading of a phrase
      // would put a clause before the previous one, nudge it after instead.
      if (startKey != null && prevKey != null && startKey <= prevKey) {
        startKey = prevKey + 1;
        startHour = (prevHour + 1) % 24;
        if (startHour === 0) dateStr = addDaysToDateStr(prevDate, 1);
      }
      const seg = {
        raw: chunk, loKt, hiKt, directionLabel, directionDeg, regime,
        timing: t?.timing ?? null, dateStr, startHour, startKey,
        isException: false, exceptions: [],
      };
      segments.push(seg);
      parent = seg;
      if (startKey != null) { prevDate = dateStr; prevHour = startHour; prevKey = startKey; }
    }
  }

  const main = segments.filter(s => !s.isException);
  if (!main.length) return null;
  return {
    issued: iss ?? null,
    segments,
    maxKt: Math.max(...main.map(s => s.hiKt)),
    minKt: Math.min(...main.map(s => s.loKt)),
    hasOutflow: segments.some(s => s.regime === "outflow"),
    hasInflow: segments.some(s => s.regime === "inflow"),
  };
}

function angularDiff(a, b) {
  if (a == null || b == null) return 999;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
const midKt = (s) => (s.loKt + s.hiKt) / 2;

// The EC clause in force at a given local date + hour, or null outside the
// bulletin's timeline (before issue, or well past its last clause).
//
// Sub area exceptions ("except northwest 5 to 15 near Vancouver") only apply
// to spots listing a matching phrase in `marineExceptionAreas`. EC states
// the exception once, on the opening clause, and doesn't repeat it when the
// wind later builds; we read it as "that area keeps running lighter by the
// same proportion" until the direction changes. Verified against Sep 25
// 2026: zone NW 20 to 30 this morning, Jericho actually peaked at 17kt, which
// is what the proportional reading gives.
export function marineAnchorForHour(parsed, localHour, dateStr, spot = null) {
  if (!parsed || !parsed.segments || !dateStr) return null;
  const main = parsed.segments.filter(s => !s.isException && s.startKey != null);
  if (!main.length) return null;
  const t = hourKey(dateStr, localHour);
  let idx = -1;
  for (let i = 0; i < main.length; i++) if (main[i].startKey <= t) idx = i;
  if (idx < 0) return null;
  const seg = main[idx];
  if (idx === main.length - 1 && t >= seg.startKey + MARINE_TAIL_HOURS) return null;

  const areas = (spot?.marineExceptionAreas || []).map(a => a.toLowerCase());
  if (areas.length) {
    for (let j = idx; j >= 0; j--) {
      const s = main[j];
      if (j < idx && angularDiff(s.directionDeg, seg.directionDeg) > 30) break;
      const ex = (s.exceptions || []).find(e => areas.some(a => e.area.includes(a)));
      if (!ex) continue;
      if (j === idx) return { ...seg, loKt: ex.loKt, hiKt: ex.hiKt, directionLabel: ex.directionLabel ?? seg.directionLabel, directionDeg: ex.directionDeg ?? seg.directionDeg, exceptionApplied: ex.area };
      const ratio = midKt(s) > 0 ? midKt(ex) / midKt(s) : 1;
      return { ...seg, loKt: Math.round(seg.loKt * ratio), hiKt: Math.round(seg.hiKt * ratio), exceptionApplied: ex.area, exceptionScaled: true };
    }
  }
  return seg;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

// time -> value lookup from a reshaped row array, for whichever field
// ("speeds" or "pressure") the caller wants, averaged across models. Shared
// by the reference-station speed check (Erwin Park) and the pressure
// gradient check (Squamish family) so the fetch/reshape logic only lives in
// one place — generate.mjs and the browser's live-refresh path both call
// through the json-based wrappers below.
function rowsToSeriesMap(rows, field) {
  const map = {};
  for (const row of rows) {
    if (field === "speeds") { map[row.time] = weightedMean(row.speeds, row); continue; }
    const vals = Object.values(row[field]).filter(v => v != null);
    map[row.time] = vals.length ? mean(vals) : null;
  }
  return map;
}
export function referenceStationSpeeds(openMeteoJson) {
  return rowsToSeriesMap(reshapeOpenMeteo(openMeteoJson), "speeds");
}
export function referenceStationPressures(openMeteoJson) {
  return rowsToSeriesMap(reshapeOpenMeteo(openMeteoJson), "pressure");
}
export function rowsToPressureMap(rows) {
  return rowsToSeriesMap(rows, "pressure");
}
export function rowsToSpeedMap(rows) {
  return rowsToSeriesMap(rows, "speeds");
}
// Circular mean of a set of compass directions, optionally weighted (same
// length/order as `degs`). Unweighted, this can invent a direction none of
// the models actually predicted: two light 2kt-from-N readings and two
// strong 12-14kt-from-S readings average to due WNW, missing both the real
// thermal (S) and outflow (N) sectors it was averaging between. Weighting by
// each model's own wind speed lets the stronger, more consequential
// readings dominate the average, which is both more physically sensible
// (a 2kt breeze's direction is nearly noise) and a better match for what a
// rider on the water would actually feel.
function circularMeanDeg(degs, weights = null) {
  if (!degs.length) return null;
  let x = 0, y = 0;
  degs.forEach((d, i) => {
    const w = weights ? (weights[i] ?? 1) : 1;
    const r = d * Math.PI / 180;
    x += Math.cos(r) * w; y += Math.sin(r) * w;
  });
  if (x === 0 && y === 0) return null; // weights canceled out exactly — no meaningful mean
  let ang = Math.atan2(y, x) * 180 / Math.PI;
  return ang < 0 ? ang + 360 : ang;
}

// Component of a wind observation aligned with Howe Sound's SW up-sound
// inflow axis (~200°) — i.e. how much of this wind is actually blowing the
// "right way" to reach the Spit, not just how strong it is in any direction.
// Positive = aligned with inflow, negative = opposing it. Used for the live
// Pam Rocks nowcast (see classifyHour) — same idea as projecting one vector
// onto another.
export function pamRocksInflowComponent(speedKt, directionDeg, inflowAxisDeg = 200) {
  if (speedKt == null || directionDeg == null) return null;
  return speedKt * Math.cos((directionDeg - inflowAxisDeg) * Math.PI / 180);
}

// Clear-sky solar radiation estimate (W/m²) for a given latitude, day of
// year and local hour — used to judge "how sunny is it *for this time of
// day*" as a ratio, rather than against one flat number. A flat cutoff
// (e.g. "sunny if radiation >= 250 W/m²") quietly assumes it's always close
// to solar noon: a clear sky at 6pm in August only delivers ~180-240 W/m²
// simply because the sun is low, not because it's cloudy — a flat cutoff
// would wrongly call that "not sunny" and kill a prime evening thermal
// session. Standard solar-elevation approximation; a heuristic like the
// rest of this file, not a radiative-transfer model.
function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function dayOfYearFromParts(month, day, year) {
  let doy = day;
  for (let m = 0; m < month - 1; m++) doy += (m === 1 && isLeapYear(year)) ? 29 : DAYS_IN_MONTH[m];
  return doy;
}
function clearSkyRadiationWm2(latDeg, doy, localHour) {
  const declDeg = 23.45 * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  const declRad = declDeg * Math.PI / 180;
  const latRad = latDeg * Math.PI / 180;
  const hourAngleRad = (15 * (localHour - 12)) * Math.PI / 180;
  const sinElev = Math.sin(latRad) * Math.sin(declRad) + Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourAngleRad);
  if (sinElev <= 0) return 0; // sun below the horizon
  return Math.max(0, 990 * sinElev - 30);
}

// Classify one hour's regime for one spot, given the row of model values.
// `refSpeedKt`, if provided, is the best-estimate wind speed at this same
// hour from the spot's reference station (see spot.referenceStation) — used
// for spots where a nearby well-exposed gauge point is a better predictor
// than the spot's own local model output (e.g. Erwin Park vs Point
// Atkinson).
// `pressureGradients`, if provided, is { largeScale, local } in hPa for
// Howe Sound spots (see spot.pressureGradientAware) — positive favors
// inflow/thermal, negative favors outflow.
// `overrideRecord`, if provided, is this spot's entry from
// data/calibration-overrides.json — an object keyed by regime (plus a
// "general" fallback), each holding a rider-feedback-learned multiplier
// (see scripts/apply-feedback.mjs). Resolved against the regime this hour
// actually classifies as, once that's known below.
// `pamRocksNow`, if provided, is { speedKt, directionDeg } — the live Pam
// Rocks buoy reading (Howe Sound's mouth), only ever passed for whichever
// hour matches "right now" (see generate.mjs) since it's a live observation,
// not a forecast time series. Two independent uses, both same-day-only:
// an SW-inflow-projection thermal nowcast (spot.pamRocksAware) and a plain
// Pam Rocks rule for Porteau Cove (spot.pamRocksRule: inflow 14kt+,
// outflow 25kt+ at Pam Rocks).
// Returns { regime, reason, direction_deg, speed_kt, gust_kt, agreement }
// `marineAnchor`, if provided, is the EC marine-bulletin segment applicable to
// this hour (see parseMarineWindText / marineAnchorForHour above), for spots
// that declare a `marineZone`. Used to catch gradient events the raw models
// under-read — see the anchor block in the body.
// `liveRefNow`, if provided, is { speedKt, directionDeg } from the spot's own
// reference station's LIVE observation (not its forecast), only ever passed for
// the hour matching "right now" — same live-observation caveat as pamRocksNow.
// `mosNow`, if provided, is applyMos()'s result for this hour plus its
// `leadHours` (see the learned correction section at the end of this file).
export function classifyHour(spot, row, localHour, month, refSpeedKt = null, pressureGradients = null, overrideRecord = null, pamRocksNow = null, marineAnchor = null, liveRefNow = null, mosNow = null) {
  const speedVals = Object.values(row.speeds).filter(v => v != null);
  const cloudVals = Object.values(row.cloud).filter(v => v != null);
  const radiationVals = Object.values(row.radiation || {}).filter(v => v != null);

  // Headline speed from the lead models (see LEAD_MODELS); every model
  // still feeds the agreement check and the uncertainty below.
  const speed_kt = leadModelMean(row, "speeds");
  const gust_kt = leadModelMean(row, "gusts");
  // Weight each model's direction by that same model's speed (see
  // circularMeanDeg) — a near-calm model shouldn't get an equal vote on
  // "which way is the wind coming from" against a model showing real wind.
  // Pair by model key so a model missing one of the two fields doesn't
  // silently misalign against another model's value.
  const dirPairs = Object.entries(row.dirs)
    .filter(([, v]) => v != null)
    .map(([k, v]) => ({ deg: v, weight: (row.speeds[k] != null ? Math.max(row.speeds[k], 0.5) : 1) * modelWeight(row, k) }));
  const direction_deg = circularMeanDeg(dirPairs.map(p => p.deg), dirPairs.map(p => p.weight));
  const cloud_pct = mean(cloudVals);
  const radiation_wm2 = radiationVals.length ? mean(radiationVals) : null;
  const upperSpeedVals = Object.values(row.upperSpeeds || {}).filter(v => v != null);
  const upperDirPairs = Object.entries(row.upperDirs || {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => ({ deg: v, weight: (row.upperSpeeds || {})[k] != null ? Math.max(row.upperSpeeds[k], 0.5) : 1 }));
  const upper_speed_kt = upperSpeedVals.length ? mean(upperSpeedVals) : null;
  const upper_direction_deg = upperDirPairs.length ? circularMeanDeg(upperDirPairs.map(p => p.deg), upperDirPairs.map(p => p.weight)) : null;

  // Model agreement: how tight is the spread relative to the mean? Used as
  // a confidence multiplier — synoptic/gradient events tend to show up on
  // every model; pure thermal/mesoscale effects often show up on the
  // fine-resolution model only, which is itself informative.
  // Now Guillermo's rule: the share of (weighted) models within +/-15% of
  // the median speed. `modelsAgree` = 80%+ of the weight, 4+ models.
  const ag = modelAgreement(row);
  const agreement = ag.share;
  const modelsAgree = ag.agree;

  let regime = "calm", reason = "Light and variable — no clear driver.";
  // Shortwave radiation is a more direct read on "how hard is the sun
  // actually driving the thermal right now" than a flat cloud-cover cutoff —
  // it already folds in cloud, sun angle and time of day. But it needs to be
  // judged *relative to that hour's own clear-sky ceiling*, not a flat
  // number: a clear evening naturally reads lower than a clear noon simply
  // because the sun is lower, and a flat cutoff can't tell that apart from
  // real cloud cover (see clearSkyRadiationWm2 above). Ratio-based when we
  // have both a real radiation reading and a meaningful clear-sky ceiling;
  // fall back to the cruder cloud threshold when either is unavailable, and
  // treat "sun essentially down" (very low clear-sky ceiling) as not sunny.
  const SUNNY_RADIATION_RATIO = 0.45;
  const yearNum = Number(row.time.slice(0, 4));
  const dayNum = Number(row.time.slice(8, 10));
  const doy = dayOfYearFromParts(month, dayNum, yearNum);
  const clearSkyWm2 = clearSkyRadiationWm2(spot.lat, doy, localHour);
  const sunny = clearSkyWm2 <= 20
    ? false
    : (radiation_wm2 != null ? (radiation_wm2 / clearSkyWm2) >= SUNNY_RADIATION_RATIO : (cloud_pct != null ? cloud_pct < 55 : true));
  const inHourWindow = (w) => localHour >= w[0] && localHour <= w[1];

  const thermalCfg = spot.thermal;
  const outflowCfg = spot.outflow;

  // Gate on the BEST available signal, not the flat average across models.
  // A pure thermal is, by definition, a case where only the fine-res model
  // (or maybe one or two others) has actually picked it up while coarse
  // global models still show near-zero — averaging all four together dilutes
  // exactly the signal we're trying to detect and would keep this branch
  // from ever firing on a real thermal day. Use whichever model is reading
  // highest for the go/no-go gate; the display value and probability model
  // handle weighting separately.
  const maxSpeed = speedVals.length ? Math.max(...speedVals) : null;

  const looksThermal = thermalCfg && thermalCfg.enabled &&
    thermalCfg.months.includes(month) &&
    inHourWindow(thermalCfg.hourWindow) &&
    sunny &&
    direction_deg != null && inSector(direction_deg, thermalCfg.dirSector) &&
    maxSpeed != null && maxSpeed >= 4;

  const looksOutflow = outflowCfg && outflowCfg.enabled &&
    direction_deg != null && inSector(direction_deg, outflowCfg.dirSector) &&
    maxSpeed != null && maxSpeed >= 8;

  const looksSynoptic = speed_kt != null && speed_kt >= 10 && agreement >= 0.6 &&
    !(thermalCfg && thermalCfg.enabled && inHourWindow(thermalCfg.hourWindow) && looksThermal);

  if (looksOutflow) {
    regime = "outflow";
    const fine = row.speeds.gem, coarse = mean([row.speeds.gfs, row.speeds.ecmwf].filter(v => v != null));
    const gradeNote = (coarse != null && fine != null && fine - coarse > 6)
      ? " High-res GEM/HRDPS is running noticeably stronger than GFS/ECMWF — trust the local model here."
      : "";
    reason = `${spot.outflow.note.split(".")[0]}.${gradeNote}`;
  } else if (looksThermal) {
    regime = "thermal";
    const fine = row.speeds.gem, coarse = mean([row.speeds.gfs, row.speeds.ecmwf].filter(v => v != null));
    const meshNote = (fine != null && coarse != null)
      ? (fine - coarse > 5
          ? " Only the high-res local model is showing this clearly — classic sign of a pure thermal that coarse global models miss. Treat as moderate confidence until closer in."
          : " Multiple models agree, which is a good sign for a thermal-driven day.")
      : "";
    const radiationNote = radiation_wm2 != null
      ? (radiation_wm2 >= 500 ? ` Solar loading is strong (~${Math.round(radiation_wm2)} W/m²) — good thermal driver.` : ` Solar loading is moderate (~${Math.round(radiation_wm2)} W/m²) — thermal may be a bit softer than a full-sun day.`)
      : "";
    reason = `${thermalCfg.note.split(".")[0]}.${meshNote}${radiationNote}`;
  } else if (looksSynoptic) {
    regime = "synoptic";
    reason = `General Strait/regional gradient wind from the ${degToLabel(direction_deg)}, agreed on by ${speedVals.length} model${speedVals.length === 1 ? "" : "s"}.`;
  } else if (maxSpeed != null && maxSpeed < 5) {
    regime = "calm";
    reason = "Forecast light — every model under 5kt.";
  } else {
    regime = "mixed";
    reason = `Wind expected (${degToLabel(direction_deg)}) but doesn't clearly match this spot's known thermal or outflow pattern — treat with extra caution.`;
  }

  // Upper-level (850hPa, ~1500m) SW flow strong enough can override or
  // suppress the local sea-breeze circulation a thermal depends on — a
  // caution the surface-only signals above can't see on their own. Only
  // relevant once we've already called the hour a thermal.
  const UPPER_SUPPRESSION_KT = 20;
  let upperSuppression = null;
  if (regime === "thermal" && upper_speed_kt != null) {
    const alignedWithInflow = upper_direction_deg != null && inSector(upper_direction_deg, [150, 260]);
    upperSuppression = upper_speed_kt >= UPPER_SUPPRESSION_KT && alignedWithInflow;
    if (upperSuppression) {
      reason += ` Caution: strong SW flow aloft (~${Math.round(upper_speed_kt)}kt at 850hPa) can override or suppress this thermal rather than reinforce it.`;
    }
  }

  // Direction rideability flag. Outflow events at Howe Sound spots blow from
  // the opposite sector to the thermal wind, so use the spot's dedicated
  // outflow sector list when that's the regime in play, if one is defined.
  const sectorList = (regime === "outflow" && spot.outflow_favorable_deg)
    ? spot.outflow_favorable_deg
    : spot.favorable_deg;
  const favorable = sectorList ? sectorList.some(s => inSector(direction_deg, s)) : true;

  // How much more should the fine-resolution local model (GEM/HRDPS) count
  // relative to the coarse global models, when scoring this specific hour?
  // For thermal/outflow regimes — mesoscale, terrain-driven effects — the
  // local high-res model is the one most likely to have actually resolved
  // Howe Sound / the Fraser Valley correctly, so it earns more weight than
  // a straight vote-of-4 would give it.
  let fine_vs_coarse_gap = null;
  const coarseMean = mean([row.speeds.gfs, row.speeds.ecmwf].filter(v => v != null));
  if (row.speeds.gem != null && coarseMean != null) {
    fine_vs_coarse_gap = row.speeds.gem - coarseMean;
  }

  // Squamish-family thermal calibration (see calibrateSquamishThermal above).
  // Coarse models under-read this specific thermal badly enough that showing
  // their raw average as "the forecast" is actively misleading — a rider
  // checking this tool mid-thermal would see single digits while the water
  // is doing 20kt+. We override the headline speed/gust and the model votes
  // used for probability with the calibrated estimate, and keep the raw
  // per-model numbers available in `raw_models` for transparency.
  let displaySpeed = speed_kt, displayGust = gust_kt, displayModels = row.speeds, calibrated = false;

  // Outflow under-read correction. Same physics problem as the Squamish
  // thermal: a shallow, terrain-channelled drainage flow is below what a
  // ~13km global grid can resolve, so coarse models flatten it. The mechanism
  // is here and works, but is deliberately NOT enabled on any spot yet —
  // unlike the Squamish thermal (which has a 12-year rider's field notes
  // behind its 2.85x), we have no validated multiplier for any outflow spot,
  // and inventing one is exactly the kind of guess that produces a confidently
  // wrong forecast. Set `outflow: { calibrated: true, multiplier: N }` on a
  // spot once there's real data to justify N.
  //
  // In the meantime the empirical path is already open: the regime-aware
  // feedback loop (apply-feedback.mjs) buckets by regime, so now that Erwin
  // Park actually classifies its easterly mornings as "outflow" rather than
  // calm/mixed, live-verification data will accumulate in an Erwin/outflow
  // bucket and learn this multiplier from observations instead of a guess.
  if (regime === "outflow" && spot.outflow && spot.outflow.calibrated &&
      spot.outflow.multiplier != null && coarseMean != null) {
    const est = coarseMean * spot.outflow.multiplier;
    if (est > (displaySpeed ?? 0)) {
      calibrated = true;
      displaySpeed = row.speeds.gem != null ? Math.max(est, row.speeds.gem) : est;
      displayGust = displaySpeed * 1.3;
      displayModels = { calibrated: displaySpeed, gem_local: row.speeds.gem ?? displaySpeed };
      reason += ` Field-calibrated for outflow: raw coarse-model wind (~${Math.round(coarseMean)}kt) scaled ~${spot.outflow.multiplier}x, since coarse models under-resolve shallow drainage flow here.`;
    }
  }

  if (regime === "thermal" && spot.thermal && spot.thermal.calibrated && coarseMean != null) {
    const calibratedSpeed = calibrateSquamishThermal(coarseMean);
    if (calibratedSpeed != null) {
      calibrated = true;
      // Blend the calibrated coarse-model estimate with GEM/HRDPS's own
      // (already partially-resolved) number, leaning toward whichever reads
      // higher — both are known to undercall this specific thermal, not
      // overcall it.
      displaySpeed = row.speeds.gem != null ? Math.max(calibratedSpeed, row.speeds.gem) : calibratedSpeed;
      displayGust = displaySpeed * calibratedGustMultiplier(direction_deg);
      displayModels = { calibrated: displaySpeed, gem_local: row.speeds.gem ?? displaySpeed };
      reason += ` Field-calibrated: raw coarse-model wind (~${Math.round(coarseMean)}kt) is scaled up ~2.85x, matching how this thermal typically under-reads on GFS-class models (source: local rider calibration, see README).`;
    }
  }

  // Learned per spot correction (see applyMos at the end of this file).
  // Replaces the weighted model average as the headline number wherever a
  // spot has one; the rules below still add their notes, and live readings
  // still take over for the current hour. For Porteau the blend forecasts
  // Pam Rocks and Guillermo's Pam Rocks rule turns that into Porteau.
  let mosUsed = false, mosSigma = null, mosInfo = null;
  if (spot.mos && mosNow && mosNow.speed != null && (!calibrated || spot.mos.overridesCalibration)) {
    let est = mosNow.speed;
    let ruleInfo = null;
    if (spot.pamRocksRule) {
      ruleInfo = pamRocksRuleEstimate(spot.pamRocksRule, mosNow.speed, mosNow.directionDeg, true);
      est = ruleInfo.estimateKt;
    } else {
      est = Math.max(0, est + (spot.mos.offsetKt ?? 0));
    }
    // Keep the models' own gust factor, within sane bounds.
    const gustRatio = (speed_kt != null && speed_kt > 3 && gust_kt != null) ? Math.min(1.8, Math.max(1.15, gust_kt / speed_kt)) : 1.3;
    mosUsed = true;
    calibrated = false;
    displaySpeed = est;
    displayGust = est * gustRatio;
    displayModels = row.speeds;
    mosSigma = mosNow.sigma * mosLeadFactor(mosNow.leadHours);
    mosInfo = {
      station: mosNow.station,
      station_kt: Math.round(mosNow.speed * 10) / 10,
      variant: mosNow.variant,
      sigma_kt: Math.round(mosSigma * 10) / 10,
      recent_offset_kt: mosNow.offsetKt ? Math.round(mosNow.offsetKt * 10) / 10 : 0,
      ...(ruleInfo ? { flow: ruleInfo.flow, threshold_kt: ruleInfo.thresholdKt, works: ruleInfo.works } : {}),
    };
    if ((regime === "calm" || regime === "mixed") && est >= 10) {
      regime = "synoptic";
      reason = `Wind from the ${degToLabel(direction_deg)} expected.`;
    } else if (regime !== "calm" && est < 5 && maxSpeed != null) {
      regime = "calm";
      reason = "Light: this spot's learned forecast is under 5kt even though some models show more.";
    }
    if (ruleInfo) {
      reason += ruleInfo.flow
        ? ` Pam Rocks forecast ~${Math.round(mosNow.speed)}kt (${ruleInfo.flow}). Porteau works in an ${ruleInfo.flow} once Pam Rocks reads ${ruleInfo.flow === "inflow" ? "14kt+" : "25 to 30kt+"}${ruleInfo.works ? ", which this clears" : ", which this doesn't reach"}.`
        : ` Pam Rocks forecast ~${Math.round(mosNow.speed)}kt, but not from an inflow (south) or outflow (north) direction, so it doesn't reach Porteau well.`;
    } else {
      reason += ` Learned forecast for this spot (a year of ${mosNow.station} readings vs the models): ~${Math.round(est)}kt.`;
    }
  }

  // Pressure gradient check (MSLP), Howe Sound spots only. Squamish wind
  // isn't purely thermal — it's also a function of the actual pressure
  // gradient along the corridor (see kiteloop.vercel.app's "MSLP — two
  // pressure checks" panel, which inspired this): a large-scale coastal-vs-
  // interior spread (broad synoptic support) and a local spread between the
  // sound's mouth and the spot itself (is the channel locally pressurized
  // toward it). Positive = favors inflow (thermal/southerly), negative =
  // favors outflow (northerly). We use this to raise or discount confidence
  // and explain *why*, rather than to flip the regime itself — wind-speed
  // signals stay the primary classifier.
  let pressureSupport = null;
  if (spot.pressureGradientAware && pressureGradients &&
      pressureGradients.largeScale != null && pressureGradients.local != null) {
    const { largeScale, local } = pressureGradients;
    const inflowSupport = largeScale > 0.4 && local > 0.2;
    const outflowSupport = largeScale < -0.4 && local < -0.2;
    if (regime === "thermal") {
      pressureSupport = inflowSupport;
      reason += inflowSupport
        ? ` MSLP backs this up — both the large-scale coast-vs-interior spread (${largeScale.toFixed(1)}hPa) and the local channel spread (${local.toFixed(1)}hPa) favor inflow.`
        : ` Caution: MSLP doesn't clearly support inflow yet (large-scale ${largeScale.toFixed(1)}hPa, local ${local.toFixed(1)}hPa) — could be weaker or more marginal than the wind signal alone suggests.`;
    } else if (regime === "outflow") {
      pressureSupport = outflowSupport;
      reason += outflowSupport
        ? ` MSLP confirms it — both large-scale (${largeScale.toFixed(1)}hPa) and local (${local.toFixed(1)}hPa) spreads favor outflow.`
        : ` Caution: MSLP is weaker than the wind signal suggests (large-scale ${largeScale.toFixed(1)}hPa, local ${local.toFixed(1)}hPa) — this outflow could fade faster than expected.`;
    }
  }

  // Pam Rocks nowcast, Squamish-family spots only (spot.pamRocksAware).
  // `pamRocksNow` is only ever passed for the hour matching "right now" —
  // it's a live buoy reading at Howe Sound's mouth, not a forecast time
  // series, so it can only corroborate/caution the current hour, not the
  // rest of the forecast. Marine inflow reaching the mouth of the sound is
  // a real-time leading indicator for the thermal reaching the Spit.
  //
  // Sharpened with a specific, validated local signal from spitwind.ca (an
  // independent Squamish-Spit-focused forecast tool, checked Aug 2026):
  // across a season of recorded Spit sessions, Pam Rocks reading 8-12kt
  // specifically from the SSE precedes the Spit filling to rideable ~91% of
  // the time — a much sharper "heads up" than a generic inflow-strength
  // check. They also flag the inverse: a STRONG Pam Rocks reading from the
  // west is a "head-fake" that often doesn't reach the Spit at all — worse
  // than no signal at all, since a big number there looks encouraging but
  // isn't. We don't have a season of our own history to independently
  // derive these bands yet (see "Live verification" / the calibration
  // loop), so treat the specific thresholds below as borrowed, not
  // locally-validated — worth revisiting once our own log has enough depth.
  const PAM_TELL_MIN_KT = 8, PAM_TELL_MAX_KT = 12;
  const PAM_TELL_DIR_SECTOR = [135, 195]; // SE through SSW, centered on SSE
  const PAM_HEADFAKE_DIR_SECTOR = [260, 300]; // W through WNW
  const PAM_HEADFAKE_MIN_KT = 10;
  let pamRocksSupport = null, pamRocksTell = false, pamRocksHeadFake = false;
  if (spot.pamRocksAware && regime === "thermal" && pamRocksNow &&
      pamRocksNow.speedKt != null && pamRocksNow.directionDeg != null) {
    const { speedKt: pSpeed, directionDeg: pDir } = pamRocksNow;
    const isTellBand = pSpeed >= PAM_TELL_MIN_KT && pSpeed <= PAM_TELL_MAX_KT && inSector(pDir, PAM_TELL_DIR_SECTOR);
    const isHeadFake = pSpeed >= PAM_HEADFAKE_MIN_KT && inSector(pDir, PAM_HEADFAKE_DIR_SECTOR);
    const component = pamRocksInflowComponent(pSpeed, pDir);

    if (isHeadFake) {
      pamRocksSupport = false;
      pamRocksHeadFake = true;
      reason += ` Caution: Pam Rocks (sound's mouth) is reading ~${Math.round(pSpeed)}kt from ${degToLabel(pDir)} — strong but off-axis (westerly), which often doesn't translate into real inflow at the Spit. Don't read this as a good sign.`;
    } else if (isTellBand) {
      pamRocksSupport = true;
      pamRocksTell = true;
      reason += ` Pam Rocks (sound's mouth) is reading ~${Math.round(pSpeed)}kt from ${degToLabel(pDir)} — right in the band that's historically preceded this thermal filling in reliably.`;
    } else if (component != null) {
      pamRocksSupport = component >= 6;
      reason += pamRocksSupport
        ? ` Pam Rocks (sound's mouth) is reading ~${Math.round(pSpeed)}kt from ${degToLabel(pDir)} right now — already showing strong SW inflow, a good real-time sign for this thermal.`
        : ` Pam Rocks (sound's mouth) isn't yet showing strong SW inflow (~${Math.round(pSpeed)}kt from ${degToLabel(pDir)}) — this thermal may not have fully kicked in yet.`;
    }
  }

  // Reference-station trigger: some spots are better predicted by a nearby
  // exposed gauge point than by their own local model output. Two modes:
  //   - thresholdKt (original): a plain "did the reference station cross X"
  //     check, e.g. a spot that only turns on once a nearby entrance station
  //     is blowing hard enough to matter.
  //   - offsetKt (added for Erwin Park): the reference station and this spot
  //     move together, but consistently offset by a fixed amount — e.g.
  //     Erwin Park typically reads ~4.5kt lighter than Point Atkinson right
  //     next to it. Rather than a binary crossed/didn't-cross check, this
  //     estimates the spot's own speed as refSpeedKt + offsetKt, gated to
  //     dirSector (the offset only holds for the direction it was observed
  //     under — see spot.referenceStation in spots.js). Only overrides a
  //     calm/mixed regime once the estimate itself clears a meaningful floor
  //     (5kt) — a light Point Atkinson reading shouldn't get dressed up as a
  //     "synoptic" hour here just because the arithmetic ran.
  // Either mode only steps in when the ordinary classification came up empty
  // (calm/mixed); if the spot's own thermal/outflow/synoptic logic already
  // found something, we just add a corroborating note rather than override it.
  let referenceTriggered = false;
  if (spot.referenceStation && refSpeedKt != null) {
    const rs = spot.referenceStation;
    if (rs.offsetKt != null) {
      const dirOk = rs.dirSector ? inSector(direction_deg, rs.dirSector) : true;
      if (dirOk) {
        const estSpeed = Math.max(0, refSpeedKt + rs.offsetKt);
        const offsetLabel = `${Math.abs(rs.offsetKt)}kt ${rs.offsetKt < 0 ? "lighter" : "stronger"}`;
        if ((regime === "calm" || regime === "mixed") && estSpeed >= 5 && !mosUsed) {
          referenceTriggered = true;
          regime = "synoptic";
          displaySpeed = estSpeed;
          displayGust = displaySpeed * 1.3;
          reason = `${rs.name} is reading ~${Math.round(refSpeedKt)}kt from a favorable direction for this spot, which typically runs about ${offsetLabel} — estimated ~${Math.round(estSpeed)}kt here. ${rs.note}`;
        } else if (regime !== "calm" && regime !== "mixed") {
          referenceTriggered = true;
          reason += ` Also corroborated by ${rs.name} reading ~${Math.round(refSpeedKt)}kt from a favorable direction (this spot typically runs about ${offsetLabel}, ~${Math.round(estSpeed)}kt estimated). ${rs.note}`;
        }
      }
    } else if (rs.thresholdKt != null && refSpeedKt >= rs.thresholdKt) {
      referenceTriggered = true;
      if ((regime === "calm" || regime === "mixed") && !mosUsed) {
        regime = "synoptic";
        displaySpeed = Math.max(displaySpeed ?? 0, rs.thresholdKt);
        displayGust = displaySpeed * 1.3;
        reason = `${rs.name} is reading ~${Math.round(refSpeedKt)}kt, above this spot's ${rs.thresholdKt}kt trigger. ${rs.note}`;
      } else {
        reason += ` Also corroborated by ${rs.name} reading ~${Math.round(refSpeedKt)}kt, above its ${rs.thresholdKt}kt trigger for this spot.`;
      }
    }
  }

  // Pam Rocks live reading, Porteau Cove (spot.pamRocksRule), per Guillermo:
  // inflow needs 14kt+ at Pam Rocks, outflow 25 to 30kt+. Same rule the
  // forecast hours use (see pamRocksRuleEstimate), applied to the actual
  // reading. Only ever passed for the hour matching "right now".
  let pamRocksTriggered = false;
  if (spot.pamRocksRule && pamRocksNow && pamRocksNow.speedKt != null) {
    const r = pamRocksRuleEstimate(spot.pamRocksRule, pamRocksNow.speedKt, pamRocksNow.directionDeg);
    const where = `Pam Rocks is reading ~${Math.round(pamRocksNow.speedKt)}kt${pamRocksNow.directionDeg != null ? ` from ${degToLabel(pamRocksNow.directionDeg)}` : ""} right now`;
    if (r.works) {
      pamRocksTriggered = true;
      if (regime === "calm" || regime === "mixed") regime = "synoptic";
      if (r.estimateKt > (displaySpeed ?? 0)) {
        displaySpeed = r.estimateKt;
        displayGust = Math.max(displayGust ?? 0, displaySpeed * 1.3);
      }
      reason += ` ${where}: an ${r.flow} at or above the ${r.thresholdKt}kt it needs for Porteau to work.`;
    } else if (r.flow) {
      reason += ` ${where}: an ${r.flow}, but under the ${r.thresholdKt}kt it needs for Porteau to work.`;
    }
  }

  // Live reference-station trigger (Erwin Park / Point Atkinson). Distinct
  // from the forecast-based referenceStation offset above: this reads the
  // station's ACTUAL current wind, which is how riders genuinely make this
  // call — verbatim from the North Shore Wing Group chat: "Point Atkinson
  // 21kts now, will head to Erwin if it holds", "Head to Erwin once it hits 20
  // knots", "Erwin must be on. Point Atkinson is 23kts", "Will try Erwin
  // later. Once it stays above 19 knots." Four independent reports converging
  // on ~19-21kt, which is where the threshold in spots.js comes from.
  //
  // Only ever fires on the hour matching "right now" (generate.mjs only passes
  // liveRefNow for that hour), same as the Pam Rocks trigger. The forecast-
  // based offset above can be badly wrong on exactly the gradient mornings
  // this is meant to catch, because the reference station's own forecast is
  // under-read by the same coarse models — so a live reading is strictly
  // better information when it's available.
  // The pure model blend for this hour, before any live reading or EC
  // anchor replaced it. Live verification compares observations against
  // this (not against a number that was itself set from an observation).
  const modelBlendSpeed = displaySpeed;
  let liveRefTriggered = false;
  if (spot.liveReferenceTrigger && liveRefNow && liveRefNow.speedKt != null) {
    const t = spot.liveReferenceTrigger;
    const dirOk = t.dirSector == null || liveRefNow.directionDeg == null
      ? true
      : inSector(liveRefNow.directionDeg, t.dirSector);
    if (dirOk && liveRefNow.speedKt >= t.thresholdKt) {
      liveRefTriggered = true;
      const obsEst = Math.max(0, liveRefNow.speedKt + (t.offsetKt ?? 0));
      // hoursAhead > 0: the same reading carried a short way forward (see
      // `persistHours` on the trigger). Wind that's already blowing hard
      // rarely just switches off, but trust fades quickly, so later hours
      // blend back toward the model: 1 hour ahead keeps 2/3 of the gap, 2
      // hours ahead 1/3 (with persistHours = 2).
      const ahead = liveRefNow.hoursAhead ?? 0;
      const persist = t.persistHours ?? 0;
      const weight = ahead === 0 ? 1 : Math.max(0, 1 - ahead / (persist + 1));
      const base = displaySpeed ?? 0;
      const estSpeed = base + (obsEst - base) * weight;
      if (estSpeed > base) {
        displaySpeed = estSpeed;
        displayGust = Math.max(displayGust ?? 0, displaySpeed * 1.3);
      }
      if (regime === "calm" || regime === "mixed") regime = "synoptic";
      reason += ahead === 0
        ? ` ${t.name} is reading ~${Math.round(liveRefNow.speedKt)}kt right now, above this spot's ${t.thresholdKt}kt live trigger, so estimated ~${Math.round(estSpeed)}kt here. ${t.note}`
        : ` ${t.name} was reading ~${Math.round(liveRefNow.speedKt)}kt at the last update; carried ${ahead}h forward and blended with the models (~${Math.round(estSpeed)}kt).`;
    }
  }

  // Environment Canada marine bulletin anchor. EC's forecasters name the
  // pattern explicitly and routinely catch gradient/inflow/outflow events that
  // coarse global models flatten — so when EC's zone forecast calls for wind
  // from a direction this spot actually works on, and our model average is
  // below even EC's conservative low end, treat EC's low end as a floor rather
  // than publishing a number we have specific reason to doubt.
  //
  // Deliberately one-directional (only ever raises, never lowers): an EC zone
  // forecast describes open water across a whole marine area, so a sheltered
  // beach legitimately reading lighter than EC is normal and not evidence of a
  // model error. The reverse — a spot exposed to the forecast direction
  // reading far *below* EC — is the signature we're trying to catch.
  // `marineAnchorFactor` lets a spot that consistently runs lighter than open
  // water scale the floor down (default 1.0 = take EC's low end as-is).
  let marineAnchored = false, marineNote = null;
  if (marineAnchor && marineAnchor.loKt != null && spot.marineZone) {
    const anchorDirOk = marineAnchor.directionDeg != null &&
      (spot.favorable_deg || []).some(s => inSector(marineAnchor.directionDeg, s));
    // Anchor on the MIDPOINT of EC's range, not its low end. EC publishes a
    // sustained open-water range; the low end alone is so conservative that it
    // barely moves a badly under-read model hour (which defeats the point of
    // anchoring at all), while the midpoint is a fair reading of "what the
    // forecaster actually expects." Verified against the Aug 26 2026 Erwin
    // miss: EC "southeast 10 to 15", riders on 4m/5m — the low end alone would
    // have left the spot below the display threshold.
    const ecMidKt = (marineAnchor.loKt + marineAnchor.hiKt) / 2;
    const floorKt = ecMidKt * (spot.marineAnchorFactor ?? 1);
    if (anchorDirOk && floorKt >= 5 && !mosUsed && (displaySpeed == null || displaySpeed < floorKt)) {
      marineAnchored = true;
      displaySpeed = floorKt;
      displayGust = Math.max(displayGust ?? 0, floorKt * 1.3);
      if (regime === "calm" || regime === "mixed") regime = "synoptic";
      reason += ` Environment Canada's marine forecast for this area calls for ${marineAnchor.directionLabel} ${marineAnchor.loKt}${marineAnchor.hiKt !== marineAnchor.loKt ? `-${marineAnchor.hiKt}` : ""}kt${marineAnchor.timing ? ` ${marineAnchor.timing}` : ""}${marineAnchor.regime ? ` (${marineAnchor.regime})` : ""}${marineAnchor.exceptionApplied ? ` (using EC's lighter "${marineAnchor.exceptionApplied}" wording for this spot)` : ""}, from a direction this spot works on. Raised toward the middle of EC's range, since the raw models are reading well under that and EC's forecasters catch gradient events the models flatten.`;
    } else if (anchorDirOk) {
      marineNote = `EC marine forecast for this area: ${marineAnchor.directionLabel} ${marineAnchor.loKt}-${marineAnchor.hiKt}kt${marineAnchor.timing ? ` ${marineAnchor.timing}` : ""}.`;
      reason += ` ${marineNote}`;
    }
  }

  // Quick qualitative flags from a 12-year local rider's notes: rain kills
  // it, cloud alone doesn't, and an extreme heat forecast tends to suppress
  // the thermal (or make it very short-lived).
  const precip = mean(Object.values(row.precip).filter(v => v != null));
  const temp = mean(Object.values(row.temp).filter(v => v != null));
  if (precip != null && precip > 0.3) {
    reason += " Rain in the forecast — thermal wind is often suppressed on wet days, unlike plain cloud cover.";
  }
  if (temp != null && temp >= 29 && regime === "thermal") {
    reason += " Very hot forecast — heat waves often kill or badly shorten this thermal; if it does fill in, be ready to go early.";
  }

  // Rider-feedback calibration override (see scripts/apply-feedback.mjs):
  // a per-spot, per-REGIME multiplier learned from "Report actual
  // conditions" issues and live-station mismatches, applied on top of
  // everything above. A thermal-hour mismatch shouldn't nudge the outflow
  // calibration for the same spot and vice versa, so we resolve against
  // whichever regime this hour actually landed on, falling back to a
  // "general" bucket for older/un-regime-tagged data points. Scales the
  // model votes too, so probabilityInRange's weighted count reflects it
  // automatically.
  const overrideMultiplier = overrideRecord
    ? (overrideRecord[regime]?.multiplier ?? overrideRecord.general?.multiplier ?? null)
    : null;
  let feedbackAdjusted = false;
  // Hours whose number came from an actual observation (live trigger) or
  // from EC's marine forecast aren't model blend output, so the model bias
  // multiplier doesn't apply to them. Scaling them anyway double counted:
  // on Sep 25 2026 Garry Point's EC anchored morning was cut a further 23%
  // by a multiplier learned from ordinary model hours.
  const externallySet = liveRefTriggered || marineAnchored || mosUsed;
  if (overrideMultiplier != null && Math.abs(overrideMultiplier - 1) > 0.02 && !externallySet) {
    feedbackAdjusted = true;
    if (displaySpeed != null) displaySpeed *= overrideMultiplier;
    if (displayGust != null) displayGust *= overrideMultiplier;
    displayModels = Object.fromEntries(
      Object.entries(displayModels).map(([k, v]) => [k, v != null ? v * overrideMultiplier : v])
    );
    reason += ` Adjusted ×${overrideMultiplier.toFixed(2)} based on rider-reported actual conditions at this spot (see the "Report actual conditions" link).`;
  }

  // GUSTY flag: independent of regime — strong upper-level wind riding over
  // a decent surface wind is the classic recipe for a gusty, mechanically-
  // mixed day, worth flagging regardless of how confident we are in the
  // headline speed. Checked against the final (calibrated/adjusted) speed,
  // not the raw pre-calibration average.
  const UPPER_GUSTY_KT = 25;
  const gusty = upper_speed_kt != null && upper_speed_kt >= UPPER_GUSTY_KT && displaySpeed != null && displaySpeed >= 12;

  // Plain-English one-liner for the UI. `reason` above is the detailed,
  // meteorologist-facing trail (model spread, MSLP numbers, calibration
  // factors, etc.) — useful for anyone digging in, but the app's mobile-first
  // UI deliberately keeps technical jargon out of view. `summary` is a
  // short, jargon-free version of the same underlying signal (what kind of
  // wind, plus the two things a rider actually needs to know beyond speed:
  // is the direction rideable, and should they expect it to be gusty) so the
  // "why" behind a number is visible without reintroducing model names,
  // pressure readings or calibration multipliers into the UI.
  let summary;
  switch (regime) {
    case "thermal": summary = "Afternoon sea-breeze pattern — builds through the day, fades around sunset."; break;
    case "outflow": summary = "Wind draining down the valley — can be strong and gusty, any time of day."; break;
    case "synoptic": summary = "General regional wind, not tied to time of day."; break;
    case "calm": summary = "Light and variable — not much going on."; break;
    case "mixed": summary = "Some wind expected, but it doesn't clearly match this spot's usual pattern — less certain than usual."; break;
    default: summary = "Wind expected.";
  }
  if (favorable === false) summary += " Direction looks offshore or otherwise tricky here — use caution.";
  if (gusty) summary += " Expect it to be gustier than the average speed alone suggests.";

  return {
    time: row.time,
    speed_kt: displaySpeed != null ? Math.round(displaySpeed * 10) / 10 : null,
    gust_kt: displayGust != null ? Math.round(displayGust * 10) / 10 : null,
    direction_deg: direction_deg != null ? Math.round(direction_deg) : null,
    direction_label: degToLabel(direction_deg),
    cloud_pct: cloud_pct != null ? Math.round(cloud_pct) : null,
    radiation_wm2: radiation_wm2 != null ? Math.round(radiation_wm2) : null,
    upper_speed_kt: upper_speed_kt != null ? Math.round(upper_speed_kt * 10) / 10 : null,
    gusty,
    regime,
    reason,
    summary,
    favorable_direction: favorable,
    model_agreement: Math.round(agreement * 100) / 100,
    models_agree: modelsAgree,
    model_count: ag.count,
    model_weights: row.weights || null,
    fine_vs_coarse_gap: fine_vs_coarse_gap != null ? Math.round(fine_vs_coarse_gap * 10) / 10 : null,
    calibrated,
    reference_triggered: referenceTriggered,
    live_reference_triggered: liveRefTriggered,
    model_speed_kt: modelBlendSpeed != null ? Math.round(modelBlendSpeed * 10) / 10 : null,
    marine_anchored: marineAnchored,
    mos_used: mosUsed,
    mos: mosInfo,
    // Direction EC named for this hour, kept so pattern checks (epic day
    // signature) can still recognise the setup when the models' own
    // direction is muddled on a weak model hour.
    marine_direction_deg: marineAnchored && marineAnchor ? marineAnchor.directionDeg : null,
    pam_rocks_triggered: pamRocksTriggered,
    pressure_support: pressureSupport,
    upper_suppression: upperSuppression,
    pam_rocks_support: pamRocksSupport,
    pam_rocks_tell: pamRocksTell,
    pam_rocks_head_fake: pamRocksHeadFake,
    feedback_adjusted: feedbackAdjusted,
    models: displayModels,
    raw_models: row.speeds,
  };
}

// Base uncertainty (kt) around the headline speed estimate, before any
// data-driven widening — thermal/mesoscale regimes are inherently less
// certain than a well-agreed synoptic push, even net of calibration, since
// coarse models routinely miss them entirely rather than just mis-sizing them.
const REGIME_BASE_SIGMA = { thermal: 3.5, outflow: 3, synoptic: 2, calm: 1.5, mixed: 3 };

// Logistic CDF centered on `center` with spread `s` — a smooth stand-in for
// a normal CDF that needs no special-function import. Used to turn a single
// point estimate + uncertainty into P(x <= value).
function logisticCdf(x, center, s) {
  return 1 / (1 + Math.exp(-(x - center) / s));
}

// Probability that the true wind is AT LEAST `lo` kt — open-ended, not a
// closed [lo, hi] band. An earlier closed-band version scored "way more
// wind than you asked for" the same as "no wind at all" (both fall outside
// the box), which is backwards for wind sports: clearing your selected
// floor by a wide margin is a bonus, not a miss. A rider who picked "12-20
// Sweet spot" and got a rock-solid 28kt afternoon was seeing that hour
// scored as a near-miss purely because 28 > 20, which is exactly what sent
// a real rider a misleadingly low number on what turned out to be a
// fantastic Squamish day. Every quick-pick button is a minimum now, not a
// range (see the `.presets` buttons in index.html).
//
// Modeled as a smooth uncertainty band (logistic distribution) around the
// hour's final speed estimate (`speed_kt` — already fully
// calibrated/adjusted), rather than a hard in/out vote across 2-4 model
// values. The old vote-based version could swing from 0% to 50% to 0%
// across three adjacent, steadily-building thermal hours whenever the point
// estimate crossed a boundary by a fraction of a knot, or when a
// particular hour's calibrated model set happened to have fewer live model
// values than its neighbors — a vote count isn't the right tool for "how
// confident are we the true value clears this floor" when the estimate
// itself already carries real uncertainty. Sigma (the band's width) comes
// from the regime's base uncertainty, widened by how much the raw models
// actually disagreed this hour (`raw_models`, which — unlike `models` —
// always holds all 4 raw values regardless of any calibration override), so
// a genuinely uncertain hour gets a wider, softer curve and a well-agreed
// hour gets a tighter, more decisive one.
export function probabilityInRange(hourResult, lo) {
  const center = hourResult.speed_kt;
  if (center == null) return { probability: 0, confidence: 0 };

  // Sigma needs a few different treatments. For a *calibrated* hour
  // (Squamish-family thermal), a big gap between the raw coarse models and
  // GEM/HRDPS is the expected signature of the phenomenon itself (see
  // calibrateSquamishThermal) — punishing that spread as "uncertainty" would
  // undercut exactly the events this calibration exists to call with
  // confidence, so it gets its own small fixed sigma rather than one derived
  // from raw model spread. (A now-removed version of this sigma was derived
  // from the *user's selected range width* instead — a workaround for the
  // closed-band problem described above. That workaround is gone along with
  // the closed band: once the band is open-ended, an estimate comfortably
  // above `lo` clears the green threshold on its own, with no need for
  // sigma to know anything about what the rider picked.) Every other regime
  // still widens with genuine raw-model disagreement, since there all
  // models are on equal footing — except a trigger-fired hour (reference
  // station / Pam Rocks threshold), which isn't really "multiple models
  // agreeing," just a floor value substituted in — that gets a wider base
  // sigma so it doesn't read as more certain than it actually is.
  let sigma;
  const liveSet = hourResult.live_reference_triggered || hourResult.pam_rocks_triggered;
  const useMos = hourResult.mos_used && hourResult.mos && hourResult.mos.sigma_kt != null && !liveSet;
  if (useMos) {
    // Learned blend: its own measured error (see applyMos), normal shaped,
    // which is what made its probabilities come out calibrated in the back test.
    sigma = hourResult.mos.sigma_kt;
  } else if (hourResult.calibrated) {
    sigma = 1.8;
  } else {
    // Weighted standard deviation across models (the old max-minus-min
    // range grew with every model added, so it no longer measured real
    // disagreement once we moved from 4 models to ~15).
    const entries = Object.entries(hourResult.raw_models || {}).filter(([, v]) => v != null);
    let spreadSd = 0;
    if (entries.length >= 2) {
      const w = (k) => hourResult.model_weights?.[k] ?? 1;
      const W = entries.reduce((a, [k]) => a + w(k), 0);
      const m = entries.reduce((a, [k, v]) => a + v * w(k), 0) / W;
      spreadSd = Math.sqrt(entries.reduce((a, [k, v]) => a + w(k) * (v - m) ** 2, 0) / W);
    }
    const triggered = hourResult.reference_triggered || hourResult.pam_rocks_triggered ||
      hourResult.live_reference_triggered || hourResult.marine_anchored;
    const baseSigma = triggered ? 4 : (REGIME_BASE_SIGMA[hourResult.regime] ?? 3);
    sigma = Math.max(baseSigma, spreadSd, 1.5);
    // Models agree within +/-15%: trust the number more (narrower band).
    if (hourResult.models_agree && !triggered) sigma = Math.max(1.5, Math.min(sigma, 0.1 * center + 1));
  }

  // P(true value >= lo) = 1 - F(lo) under the logistic band (normal for the
  // learned blend, matching how its error was measured).
  let probability = useMos ? 1 - normCdf((lo - center) / sigma) : 1 - logisticCdf(lo, center, sigma);
  // Never claim near-total certainty. The learned blend's top bucket verified
  // at about 91 to 95% in the back test, so it may go a little higher.
  probability = Math.min(probability, useMos ? 0.95 : 0.92);

  // Confidence: how much to trust the probability figure above. Pattern
  // match (regime detected + right season/hour/direction) is worth more
  // here than raw numeric spread, because spread is *expected* to be large
  // on a pure-thermal hour that only the fine model sees.
  let confidence;
  if (hourResult.regime === "thermal") {
    confidence = (hourResult.fine_vs_coarse_gap != null && hourResult.fine_vs_coarse_gap > 5) ? 0.55 : 0.8;
  } else if (hourResult.regime === "outflow") {
    confidence = (hourResult.fine_vs_coarse_gap != null && Math.abs(hourResult.fine_vs_coarse_gap) > 6) ? 0.65 : 0.85;
  } else if (hourResult.regime === "synoptic") {
    confidence = 0.55 + hourResult.model_agreement * 0.35;
  } else if (hourResult.regime === "calm") {
    confidence = 0.75; // models agreeing on "nothing happening" is itself reliable
  } else {
    confidence = 0.35 + hourResult.model_agreement * 0.2;
  }
  if (hourResult.reference_triggered || hourResult.pam_rocks_triggered) confidence = Math.max(confidence, 0.7);
  // Guillermo's rule of thumb: when the models all land on the same speed
  // (within about 15%), it's normally a good forecast for the location.
  if (hourResult.models_agree) confidence = Math.max(confidence, 0.85);
  // The learned blend's probabilities verified well over a full year.
  if (useMos) confidence = Math.max(confidence, 0.8);
  // A live reading at a nearby station is the strongest single signal we have
  // for "right now" — stronger than any model agreement, since it's an actual
  // observation rather than a forecast.
  if (hourResult.live_reference_triggered) confidence = Math.max(confidence, 0.8);
  // EC's forecasters explicitly identifying the pattern is worth more than
  // model consensus on a gradient day, but it's still a zone-wide forecast
  // rather than a spot-specific one — a solid floor, not near-certainty.
  if (hourResult.marine_anchored) confidence = Math.max(confidence, 0.72);
  if (hourResult.pressure_support === true) confidence = Math.min(1, confidence + 0.12);
  if (hourResult.pressure_support === false) confidence *= 0.8;
  if (hourResult.pam_rocks_support === true) confidence = Math.min(1, confidence + 0.1);
  if (hourResult.pam_rocks_support === false) confidence *= 0.9;
  // Extra adjustments layered on top of the generic support/caution above:
  // the "tell band" is a specifically validated signal (see classifyHour),
  // worth more than a generic supportive reading; a head-fake is worse than
  // a merely-not-yet-supportive one, since it's actively misleading rather
  // than just inconclusive.
  if (hourResult.pam_rocks_tell === true) confidence = Math.min(1, confidence + 0.08);
  if (hourResult.pam_rocks_head_fake === true) confidence *= 0.85;
  if (hourResult.upper_suppression === true) confidence *= 0.75;
  if (!hourResult.favorable_direction) confidence *= 0.7;

  return {
    probability: Math.round(Math.max(0, Math.min(1, probability)) * 100),
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100),
  };
}

export function localHourAndMonth(isoTime) {
  // isoTime like "2026-08-12T14:00" already in America/Los_Angeles from the API.
  const d = new Date(isoTime);
  return { hour: d.getHours ? Number(isoTime.slice(11, 13)) : null, month: Number(isoTime.slice(5, 7)) };
}

// "2026-08-13T14:00" for the current instant, in America/Los_Angeles —
// matches the local-time format Open-Meteo's hourly.time array uses, so it
// can be looked up directly against a spot's `hours` array. Used by the
// live-observation verification check (see generate.mjs) to find "the
// forecast for right now."
export function currentPacificHourString(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
}

// Plain-English hypothesis for why a live observation and the forecast for
// that same hour disagree by 20%+ — leans on signals the rule engine already
// computed (regime, model agreement/spread, MSLP support) rather than
// inventing anything new, so it's an honest explanation, not a guess.
// `errorPct` is (live - forecast) / forecast, e.g. 0.35 = live ran 35% hot.
export function explainMismatch(hourResult, errorPct) {
  const direction = errorPct > 0 ? "under" : "over";
  const notes = [];
  if (hourResult.regime === "thermal") {
    notes.push(direction === "under"
      ? "Forecast called a thermal but under-shot its strength — even after the local calibration, coarse models can still lag on an unusually strong thermal day."
      : "Forecast called a thermal that came in weaker than shown — possible early suppression (heat, high cloud) or the gradient not fully developing.");
  } else if (hourResult.regime === "outflow") {
    notes.push(direction === "under"
      ? "Forecast called outflow but under-shot it — the real pressure gradient may be stronger than the reference stations captured."
      : "Forecast called outflow that came in weaker than shown — outflow events can relax faster than models show once the synoptic pattern eases.");
  } else if (hourResult.regime === "calm" || hourResult.regime === "mixed") {
    notes.push(direction === "under"
      ? "Forecast showed calm/mixed but live wind is running well above that — likely an unmodeled local effect or a synoptic push none of the current signals caught."
      : "Forecast showed calm/mixed and live wind came in lighter still — models were on the right track, just a bit high.");
  } else {
    notes.push(`Synoptic regime, but the magnitude missed — model agreement was ${Math.round((hourResult.model_agreement ?? 0) * 100)}%, so spread between models likely explains some of the gap.`);
  }
  if (hourResult.pressure_support === false) notes.push("MSLP had already flagged this hour as uncertain.");
  if (hourResult.fine_vs_coarse_gap != null && Math.abs(hourResult.fine_vs_coarse_gap) > 5) {
    notes.push("Models disagreed sharply with each other, a known low-confidence signature.");
  }
  if (hourResult.calibrated) notes.push("This hour already had the Squamish field calibration applied.");
  if (hourResult.feedback_adjusted) notes.push("This hour already had a rider-feedback adjustment applied.");
  return notes.join(" ");
}


// ---------------------------------------------------------------------------
// Tides
// ---------------------------------------------------------------------------

// Hourly water level lookup ({ "2026-09-25T09:00": 1.98, ... }, local time,
// metres above chart datum) -> per hour { level_m, level_ft, trend,
// rate_m_per_h }. Trend comes from the level an hour either side; under
// ~0.08 m/h of change counts as slack.
export function tideForHour(levels, time) {
  if (!levels) return null;
  const level = levels[time];
  if (level == null) return null;
  const d = new Date(time + ":00Z");
  const shift = (h) => { const x = new Date(d.getTime() + h * 3600000); return x.toISOString().slice(0, 13) + ":00"; };
  const prev = levels[shift(-1)], next = levels[shift(1)];
  let rate = null;
  if (prev != null && next != null) rate = (next - prev) / 2;
  else if (next != null) rate = next - level;
  else if (prev != null) rate = level - prev;
  const trend = rate == null ? null : rate > 0.08 ? "rising" : rate < -0.08 ? "falling" : "slack";
  return {
    level_m: Math.round(level * 100) / 100,
    level_ft: Math.round(level * 3.28084 * 10) / 10,
    trend,
    rate_m_per_h: rate != null ? Math.round(rate * 100) / 100 : null,
  };
}

// ---------------------------------------------------------------------------
// "Possible epic day" signatures
//
// A spot can carry an `epicSignature` in spots.js describing a specific,
// rider verified setup that produced an exceptional session (direction,
// strength, tide state, time of day). Hours matching it are flagged
// `epic: true`, and a run of at least `minHours` of them on one day becomes
// an epic window the UI calls out. The first one is Steveston on Fri Sep 25
// 2026 (see spots.js and README "Sep 25 2026 case study").
//
// Deliberately strict: every condition has to hold, and the wind has to be
// backed by something beyond one model (EC's marine forecast, a live
// reading, or at least two models independently at strength). A missing
// tide feed doesn't block the flag, but the window says so.
// ---------------------------------------------------------------------------
export function flagEpicHours(spot, hours) {
  const sig = spot.epicSignature;
  if (!sig || !Array.isArray(hours)) return [];
  const inWin = (hr) => hr >= sig.hourWindow[0] && hr <= sig.hourWindow[1];
  const cand = hours.map((h) => {
    const hr = Number(h.time.slice(11, 13));
    const dirOk = (h.direction_deg != null && inSector(h.direction_deg, sig.dirSector)) ||
      (h.marine_direction_deg != null && inSector(h.marine_direction_deg, sig.dirSector));
    const windOk = h.speed_kt != null && h.speed_kt >= sig.minKt;
    const modelsAtStrength = Object.values(h.raw_models || {}).filter(v => v != null && v >= sig.minKt).length;
    const supported = h.marine_anchored || h.live_reference_triggered || h.mos_used || modelsAtStrength >= 2;
    const tideKnown = !!(h.tide && h.tide.trend);
    const tideOk = !sig.tide || !tideKnown || h.tide.trend === sig.tide;
    return inWin(hr) && dirOk && windOk && supported && tideOk ? { tideKnown } : null;
  });

  const windows = [];
  let i = 0;
  while (i < hours.length) {
    if (!cand[i]) { i++; continue; }
    const date = hours[i].time.slice(0, 10);
    let j = i;
    while (j + 1 < hours.length && cand[j + 1] && hours[j + 1].time.slice(0, 10) === date) j++;
    const len = j - i + 1;
    if (len >= (sig.minHours ?? 2)) {
      let peak = 0, tideKnown = true;
      for (let k = i; k <= j; k++) {
        hours[k].epic = true;
        peak = Math.max(peak, hours[k].speed_kt ?? 0);
        if (!cand[k].tideKnown) tideKnown = false;
      }
      windows.push({
        date,
        start: hours[i].time.slice(11, 16),
        end: hours[j].time.slice(11, 16),
        hours: len,
        peak_kt: Math.round(peak),
        tide_known: tideKnown,
        tide_start_m: hours[i].tide?.level_m ?? null,
        tide_end_m: hours[j].tide?.level_m ?? null,
        label: sig.label || "Possible epic day",
        why: sig.summary || null,
      });
    }
    i = j + 1;
  }
  return windows;
}

// Remove specific models from reshaped rows (spot.excludeModels). Used where
// a model's grid is too coarse to see the water a spot sits on: ICON's cell
// at Steveston is the same land cell whether you ask for the beach or for
// Sand Heads 8km offshore (identical numbers at both on Sep 25 2026), so it
// can only ever drag the blend toward land sheltered wind there.
export function dropModels(rows, keys) {
  if (!keys || !keys.length) return rows;
  for (const row of rows) {
    for (const field of ["speeds", "gusts", "dirs", "cloud", "pressure", "precip", "temp", "upperSpeeds", "upperDirs", "radiation"]) {
      if (!row[field]) continue;
      for (const k of keys) delete row[field][k];
    }
    if (row.weights) for (const k of keys) delete row.weights[k];
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Learned per spot correction (MOS, "model output statistics")
//
// Year back test (Sep 2025 to Sep 2026, day before model runs vs EC hourly
// observations) showed no single model is best everywhere, and that the
// hand built rule layer was losing skill the raw models had. A small linear
// blend fitted per station fixes most of it: at Sand Heads it catches 64% of
// the 12kt+ hours with 20% false alarms (the plain 16 model average caught
// 9%), and the probabilities it gives are calibrated (when it says 70% it
// happens about 70% of the time).
//
// Coefficients live in data/mos-coefficients.json (written by
// scripts/mos-train.mjs). Inputs come from a separate Open-Meteo request at
// the exact point the blend was trained on, with the pure models (HRRR and
// HRDPS on their own, not the seamless blends), so a later change to the
// display model set can't silently break the fit.
// ---------------------------------------------------------------------------
export const MOS_MODEL_PARAMS = {
  nbm: "ncep_nbm_conus",
  hrdps: "gem_hrdps_continental",
  hrrr: "ncep_hrrr_conus",
  ecmwf: "ecmwf_ifs025",
  gem_regional: "gem_regional",
  gfs_global: "gfs_global",
};

export function buildMosUrl(lat, lon, days = 4) {
  const models = Object.values(MOS_MODEL_PARAMS).join(",");
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m&models=${models}&wind_speed_unit=kn&timezone=GMT&forecast_days=${days + 1}`;
}

// Open-Meteo (timezone=GMT) -> { "<local YYYY-MM-DDTHH:00>": { utcHour, speeds: {nbm,...}, dirs: {...} } }
export function reshapeMos(json) {
  const hourly = json?.hourly || {};
  const out = {};
  (hourly.time || []).forEach((t, i) => {
    const d = new Date(t + ":00Z");
    const rec = { utcHour: d.getUTCHours(), speeds: {}, dirs: {} };
    for (const [key, param] of Object.entries(MOS_MODEL_PARAMS)) {
      const s = hourly[`wind_speed_10m_${param}`]?.[i];
      const dd = hourly[`wind_direction_10m_${param}`]?.[i];
      if (s != null) rec.speeds[key] = s;
      if (dd != null) rec.dirs[key] = dd;
    }
    out[currentPacificHourString(d)] = rec;
  });
  return out;
}

const SQRT_HALF_PI = 1.2533; // mean absolute error -> standard deviation, for a normal error
function normCdf(z) {
  // Abramowitz and Stegun 7.1.26, good to ~1e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
export { normCdf };

// Uncertainty grows with lead time. The fit was scored on day before runs
// (about 24 to 48h out), so that range keeps the fitted width; nearer hours
// get a little tighter and day 3 to 4 wider. The growth rate is an
// assumption until the nightly scoring has a few weeks of day 2 to 4 misses.
export function mosLeadFactor(leadHours) {
  if (leadHours == null || !isFinite(leadHours)) return 1;
  return Math.min(1.3, Math.max(0.9, 0.9 + leadHours / 240));
}

// Apply one point's coefficients to one hour. Returns null when no variant
// has all its models (e.g. a model feed is down).
export function applyMos(point, input) {
  if (!point || !input) return null;
  for (const v of point.variants || []) {
    const x = [1];
    let ok = true;
    for (const m of v.models) {
      const s = input.speeds[m];
      if (s == null) { ok = false; break; }
      x.push(s);
    }
    if (!ok) continue;
    let u = 0, w = 0;
    for (const m of v.uv) {
      const s = input.speeds[m], d = input.dirs[m];
      if (s == null || d == null) { ok = false; break; }
      u += -s * Math.sin(d * Math.PI / 180);
      w += -s * Math.cos(d * Math.PI / 180);
    }
    if (!ok) continue;
    u /= v.uv.length; w /= v.uv.length;
    const h = input.utcHour;
    x.push(u, w, Math.sin(2 * Math.PI * h / 24), Math.cos(2 * Math.PI * h / 24));
    if (x.length !== v.coef.length) continue;
    // Guard against extrapolating outside anything seen in training (the
    // models never all read the same strong wind there, so an unusual hour
    // could otherwise produce a silly number): at most 2.2x the strongest
    // input plus 3kt (the 99th percentile in the back test was 1.2x to 1.9x),
    // and never above 45kt.
    const maxIn = Math.max(...v.models.map(m => input.speeds[m]));
    const rawSpeed = Math.max(0, x.reduce((a, xi, i) => a + xi * v.coef[i], 0));
    // Nightly recent correction (data/mos-recent.json, see recentAdjustment
    // in scripts/mos-train.mjs): last week's average miss, and a wider band
    // when the last month missed by more than the error model expects.
    const rec = point.recent || {};
    const offset = rec.offset_kt ?? 0;
    const speed = Math.min(45, maxIn * 2.2 + 3, Math.max(0, rawSpeed + offset));
    const sigma = Math.max(1, (v.err[0] + v.err[1] * speed) * SQRT_HALF_PI) * (rec.sigma_scale ?? 1);
    // Direction the wind blows FROM, from the mean vector (u, w point where it goes).
    const directionDeg = (u === 0 && w === 0) ? null : (Math.atan2(-u, -w) * 180 / Math.PI + 360) % 360;
    return { speed, sigma, variant: v.id, directionDeg, station: point.station, offsetKt: offset };
  }
  return null;
}

// Porteau Cove, per Guillermo: "in an inflow you need at least 14 knots
// reading [at Pam Rocks] for Porteau to work, on an outflow you need a
// minimum of 25 to 30 knots". The Pam Rocks forecast is turned into a
// Porteau estimate by shifting it so the rule's threshold lands on 12kt, the
// app's usual "it's working" floor: 14kt inflow -> 12, 25kt outflow -> 12,
// 30kt outflow -> 17. So P(Porteau >= 12) is exactly P(Pam Rocks clears the
// rule). Directions outside both sectors don't reach Porteau well.
export function pamRocksRuleEstimate(rule, pamKt, pamDirDeg, fromModels = false) {
  if (pamKt == null) return null;
  const flows = [
    { flow: "inflow", ...rule.inflow },
    { flow: "outflow", ...rule.outflow },
  ];
  const hit = pamDirDeg != null ? flows.find(f => inSector(pamDirDeg, (fromModels && f.modelDirSector) || f.dirSector)) : null;
  const target = rule.worksAtKt ?? 12;
  if (!hit) return { flow: null, thresholdKt: null, works: false, estimateKt: Math.max(0, pamKt * 0.5) };
  return {
    flow: hit.flow,
    thresholdKt: hit.thresholdKt,
    works: pamKt >= hit.thresholdKt,
    estimateKt: Math.max(0, pamKt - (hit.thresholdKt - target)),
  };
}

// ---------------------------------------------------------------------------
// Swell index
//
// Guillermo: "when the wind blows for more than 4 hours and the tide is
// against it, the likelihood of swell increases", and at Squamish "it's
// really more about fetch: the more it blows, say 25 to 30 knots for 3
// hours, the bigger the swell". So per hour:
//   1. How long the wind has blown from about this direction (10kt+, within
//      45 degrees), and how far it has had to blow over water (the spot's
//      `swell.fetchKm` for that wind direction).
//   2. Wave height and period from the standard fetch and duration growth
//      curves (US Army Corps Shore Protection Manual): whichever of the two
//      limits first. NW 21kt for 3 hours gives ~0.8m at 3.7s, which is what
//      the MFWAM wave model showed at Sand Heads on Sep 25 2026.
//   3. Which way the tide is running (DFO trend: rising = flood, falling =
//      ebb) and which way that water flows at the spot (`currents`, from
//      Guillermo, Sep 2026). Current running against the wind (120 degrees
//      or more apart) shortens and steepens these short wind waves, up to
//      ~1.4x at a strong tide; running with it flattens them a little.
// The fetch numbers are rough map estimates, and the current factor a first
// guess to be tuned from rider wave reports ("Report actual conditions").
// ---------------------------------------------------------------------------
const G = 9.81, KT_TO_MS = 0.514444;
export function waveGrowth(speedKt, durationH, fetchKm) {
  const U = speedKt * KT_TO_MS;
  if (!(U > 2) || !(durationH > 0) || !(fetchKm > 0)) return { hs_m: 0, period_s: 0, limited_by: null };
  const k = G / (U * U);
  const xFetch = fetchKm * 1000 * k;
  const xDur = Math.pow((G * durationH * 3600) / (68.8 * U), 1.5); // fetch the waves could have grown over in that time
  const x = Math.min(xFetch, xDur);
  const hs = Math.min((0.0016 * Math.sqrt(x)) / k, 0.2433 / k);
  const tp = Math.min((0.2857 * Math.cbrt(x) * U) / G, (8.134 * U) / G);
  return { hs_m: hs, period_s: tp, limited_by: xDur < xFetch ? "duration" : "fetch" };
}

function fetchForDirection(spot, dirFromDeg) {
  const sw = spot.swell || {};
  for (const [sector, km] of sw.fetchKm || []) if (inSector(dirFromDeg, sector)) return km;
  return sw.defaultFetchKm ?? 5;
}

const SWELL_MIN_KT = 10;
export function swellForHours(spot, hours) {
  if (!spot.currents || !Array.isArray(hours)) return;
  for (let i = 0; i < hours.length; i++) {
    const h = hours[i];
    const spd = h.speed_kt, dir = h.direction_deg;
    if (spd == null || dir == null || spd < 8) {
      h.swell = { label: "flat", hs_m: 0, hs_ft: 0, period_s: null, duration_h: 0 };
      continue;
    }
    // Hours in a row the wind has blown from about this direction.
    let dur = 1;
    for (let j = i - 1; j >= 0; j--) {
      const p = hours[j];
      if (p.speed_kt == null || p.speed_kt < SWELL_MIN_KT || p.direction_deg == null || angularDiff(p.direction_deg, dir) > 45) break;
      dur++;
    }
    const fetchKm = fetchForDirection(spot, dir);
    const g = waveGrowth(spd, dur, fetchKm);

    // Tide current vs the wind (wind blows toward dir + 180).
    let current = null, vsWind = null, factor = 1;
    const t = h.tide;
    if (t && t.trend && t.trend !== "slack") {
      current = t.trend === "rising" ? "flood" : "ebb";
      const flowTo = spot.currents[current];
      if (flowTo != null) {
        const boost = current === "ebb" ? (spot.currents.ebbBoost ?? 1) : 1;
        const s = Math.min(1, (Math.abs(t.rate_m_per_h ?? 0) / 0.4) * boost);
        const diff = angularDiff((dir + 180) % 360, flowTo);
        if (diff >= 120) { vsWind = "against"; factor = 1 + 0.4 * s; }
        else if (diff <= 60) { vsWind = "with"; factor = 1 - 0.15 * s; }
        else vsWind = "across";
      }
    }
    const hs = g.hs_m * factor;
    const label = hs < 0.25 ? "flat" : hs < 0.5 ? "chop" : hs < 0.9 ? "waves" : "good swell";
    h.swell = {
      label,
      hs_m: Math.round(hs * 100) / 100,
      hs_ft: Math.round(hs * 3.28084 * 10) / 10,
      period_s: g.period_s ? Math.round(g.period_s * 10) / 10 : null,
      duration_h: dur,
      fetch_km: fetchKm,
      limited_by: g.limited_by,
      current,
      vs_wind: vsWind,
      current_factor: Math.round(factor * 100) / 100,
      // Guillermo's rule of thumb: 4h+ of wind with the tide against it.
      building: vsWind === "against" && dur >= 4 && spd >= 12,
    };
  }
}
