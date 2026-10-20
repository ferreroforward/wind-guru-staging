// Two local stations added Oct 20 2026 at Guillermo's request.
//
// 1. Jericho Sailing Centre's own Davis Vantage Pro2 on the beach
//    (jsca.bc.ca/services/weather). Its WeatherLink export
//    jsca.bc.ca/main/downld02.txt holds about the last 34 hours, one row
//    per 30 minutes: average wind and the highest gust in that half hour
//    (knots, steps of 0.87 because the sensor counts whole mph), direction,
//    temperature (°C) and pressure (hPa). The time on a row is the END of
//    its half hour, Pacific time. The English Bay buoy is open water well
//    off the beach: on Oct 20 at 7am to 8am it read W 12 to 14 while the
//    beach was under 1kt.
//
// 2. The "Shipping Terminal Sensor" at the head of Howe Sound, as published
//    by Kiteloop (kiteloop.vercel.app, a Squamish forecasting tool) at
//    /api/spit-wind-nowcast: 5 minute lull, average and gust in km/h with a
//    direction, about the last 24 hours. The Spit meter is off from mid
//    September to April, so this is the live Squamish reading until then.
//
// Both files only keep a day or so, so every forecast run also appends the
// readings to our own history (data/jsca-history.json,
// data/squamish-terminal-history.json) for scoring and learning later.
// Nothing here is used to change a forecast number yet.

import { readFile, writeFile } from "node:fs/promises";
import { DEG_LABELS } from "../assets/spots.js";

export const JSCA_URL = "https://jsca.bc.ca/main/downld02.txt";
export const JSCA_PAGE = "https://jsca.bc.ca/services/weather/";
export const KITELOOP_URL = "https://kiteloop.vercel.app/api/spit-wind-nowcast";
export const KITELOOP_PAGE = "https://kiteloop.vercel.app/";
const KMH_TO_KT = 0.539957;
const HISTORY_DAYS = 180;
const HALF_HOUR_MS = 30 * 60 * 1000;
const UA = { "User-Agent": "wind-guru-agent/1.0 (ferreroforward.github.io/wind-guru)" };

const r1 = (x) => Math.round(x * 10) / 10;

// Pacific wall clock -> UTC epoch ms, DST aware.
function pacificParts(ms) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
export function pacificToUtcMs(y, mo, d, h, mi) {
  let guess = Date.UTC(y, mo - 1, d, h + 8, mi);
  for (let i = 0; i < 3; i++) {
    const p = pacificParts(guess);
    const diff = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Date.UTC(y, mo - 1, d, h, mi);
    if (!diff) break;
    guess -= diff;
  }
  return guess;
}
export function pacificHm(ms) {
  const p = pacificParts(ms);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}
const labelToDeg = (l) => { const i = DEG_LABELS.indexOf(l); return i >= 0 ? i * 22.5 : null; };
const degToLabel = (deg) => (deg == null ? null : DEG_LABELS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);

// ---- Jericho Sailing Centre ----
export function parseJsca(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 16 || !/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(c[0])) continue;
    const tm = c[1].match(/^(\d{1,2}):(\d{2})([ap])$/);
    if (!tm) continue;
    const [mo, d, yy] = c[0].split("/").map(Number);
    let h = Number(tm[1]) % 12;
    if (tm[3] === "p") h += 12;
    const avg = parseFloat(c[7]), gust = parseFloat(c[10]);
    const dir = DEG_LABELS.includes(c[8]) ? c[8] : null; // "---" when calm
    const temp = parseFloat(c[2]), bar = parseFloat(c[15]);
    if (!isFinite(avg)) continue;
    rows.push({
      atMs: pacificToUtcMs(2000 + yy, mo, d, h, Number(tm[2])),
      avgKt: r1(avg),
      gustKt: isFinite(gust) ? r1(gust) : null,
      dir,
      dirDeg: labelToDeg(dir),
      tempC: isFinite(temp) ? temp : null,
      hpa: isFinite(bar) ? bar : null,
    });
  }
  return rows.sort((a, b) => a.atMs - b.atMs);
}

export async function fetchJscaRows(fetchFn = fetch) {
  const res = await fetchFn(JSCA_URL, { headers: UA });
  if (!res.ok) throw new Error(`JSCA ${res.status}`);
  return parseJsca(await res.text());
}

// ---- Squamish shipping terminal sensor (via Kiteloop) ----
export function parseKiteloop(json) {
  const s = Array.isArray(json?.series) ? json.series : [];
  return s.map((x) => ({
    atMs: Number(x.t) || Date.parse(x.time),
    lullKt: isFinite(x.lullKph) ? r1(x.lullKph * KMH_TO_KT) : null,
    avgKt: isFinite(x.avgKph) ? r1(x.avgKph * KMH_TO_KT) : null,
    gustKt: isFinite(x.gustKph) ? r1(x.gustKph * KMH_TO_KT) : null,
    dirDeg: isFinite(x.windDirDeg) ? x.windDirDeg : null,
  })).filter((x) => isFinite(x.atMs) && x.avgKt != null).sort((a, b) => a.atMs - b.atMs);
}

export async function fetchKiteloopRows(fetchFn = fetch) {
  const res = await fetchFn(KITELOOP_URL, { headers: UA });
  if (!res.ok) throw new Error(`Kiteloop ${res.status}`);
  return parseKiteloop(await res.json());
}

// 5 minute samples -> half hour rows ending on :00 and :30, like the JSCA
// file: mean of the averages, highest gust, lowest lull, speed weighted mean
// direction.
export function halfHourly(samples) {
  const buckets = new Map();
  for (const s of samples) {
    const end = Math.ceil(s.atMs / HALF_HOUR_MS) * HALF_HOUR_MS;
    (buckets.get(end) || buckets.set(end, []).get(end)).push(s);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([end, list]) => {
    let u = 0, v = 0;
    for (const s of list) if (s.dirDeg != null) { const rad = (s.dirDeg * Math.PI) / 180; u += Math.sin(rad) * (s.avgKt || 0.1); v += Math.cos(rad) * (s.avgKt || 0.1); }
    const dirDeg = u || v ? Math.round(((Math.atan2(u, v) * 180) / Math.PI + 360) % 360) : null;
    return {
      atMs: end,
      avgKt: r1(list.reduce((a, s) => a + s.avgKt, 0) / list.length),
      gustKt: Math.max(...list.map((s) => s.gustKt ?? s.avgKt)),
      lullKt: Math.min(...list.map((s) => s.lullKt ?? s.avgKt)),
      dirDeg,
      samples: list.length,
    };
  });
}

// Live check object in the shape generate.mjs getOneLiveObservation expects.
// Kiteloop: the last 15 minutes (3 samples), so one gusty 5 minutes doesn't
// decide it. JSCA: the latest half hour row.
export function latestObservation(rows, { windowMs = 0 } = {}) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const win = windowMs ? rows.filter((r) => r.atMs > last.atMs - windowMs) : [last];
  const avg = r1(win.reduce((a, r) => a + r.avgKt, 0) / win.length);
  const gust = Math.max(...win.map((r) => r.gustKt ?? r.avgKt));
  const dirDeg = last.dirDeg;
  return {
    time: pacificHm(last.atMs),
    ageMin: (Date.now() - last.atMs) / 60000,
    speedKt: avg,
    gustKt: gust,
    directionDeg: dirDeg,
    directionAbbr: degToLabel(dirDeg),
    directionLabel: avg === 0 && dirDeg == null ? "calm" : degToLabel(dirDeg),
  };
}

// ---- history files ----
export async function appendHistory(filePath, meta, rows, toRow) {
  let hist = null;
  try { hist = JSON.parse(await readFile(filePath, "utf8")); } catch { /* first run */ }
  const byTime = new Map((hist?.rows || []).map((r) => [r[0], r]));
  for (const r of rows) byTime.set(new Date(r.atMs).toISOString(), toRow(r));
  const cutoff = Date.now() - HISTORY_DAYS * 86400000;
  const kept = [...byTime.values()].filter((r) => Date.parse(r[0]) >= cutoff).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out = { ...meta, updated_at: new Date().toISOString(), rows: kept };
  await writeFile(filePath, JSON.stringify(out));
  return { added: kept.length - (hist?.rows?.length || 0), total: kept.length };
}

export const JSCA_HISTORY_META = {
  source: "Jericho Sailing Centre Davis Vantage Pro2, " + JSCA_URL,
  interval_min: 30,
  note: "Time is the end of each half hour (UTC). Wind in knots: average and highest gust in the half hour.",
  columns: ["end_utc", "avg_kt", "gust_kt", "dir_deg", "temp_c", "hpa"],
};
export const jscaRow = (r) => [new Date(r.atMs).toISOString(), r.avgKt, r.gustKt, r.dirDeg, r.tempC, r.hpa];

export const TERMINAL_HISTORY_META = {
  source: "Squamish shipping terminal sensor via Kiteloop, " + KITELOOP_URL,
  interval_min: 30,
  note: "Built from 5 minute samples. Time is the end of each half hour (UTC). Knots: mean of the 5 minute averages, highest gust, lowest lull.",
  columns: ["end_utc", "avg_kt", "gust_kt", "lull_kt", "dir_deg", "samples"],
};
export const terminalRow = (r) => [new Date(r.atMs).toISOString(), r.avgKt, r.gustKt, r.lullKt, r.dirDeg, r.samples];
