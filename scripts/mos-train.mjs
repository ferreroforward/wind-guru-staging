#!/usr/bin/env node
// Wind Guru — learned per spot correction (MOS): nightly scoring and
// monthly retraining. Run by .github/workflows/mos-nightly.yml.
//
//   node scripts/mos-train.mjs score   last 30 days: how the current blend did
//   node scripts/mos-train.mjs fit     last 365 days: refit every point
//   node scripts/mos-train.mjs auto    score every night, refit on the 1st
//                                      of the month (or when coefficients are
//                                      over 35 days old)
//
// Truth: Environment Canada hourly climate data (bulk CSV, km/h, times in
// LST = UTC-8). Forecasts: Open-Meteo's previous runs archive, day before
// runs ("previous_day1"), at the exact point each blend is trained for.
// The method matches the Sep 2026 year back test: ridge regression on the
// model speeds, the mean wind vector of two models and the hour of day,
// scored by leave one month out, with an error model |miss| = a + b*speed.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MOS_MODEL_PARAMS, applyMos, normCdf } from "../assets/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COEF_PATH = path.join(__dirname, "..", "data", "mos-coefficients.json");
const SCORE_PATH = path.join(__dirname, "..", "data", "mos-score.json");
const RECENT_PATH = path.join(__dirname, "..", "data", "mos-recent.json");
const UA = { "User-Agent": "wind-guru-agent/1.0" };
const KMH_TO_KT = 0.539957;
const LAMBDA = 0.01;
const THRESHOLD_KT = 12; // "is it on" for hit rates and the Brier score

// Variants, tried in order at forecast time (see applyMos): the full set
// while the 2.5 to 3km models run (about 48h), then coarser fallbacks.
const VARIANTS = [
  { id: "A", models: ["nbm", "hrdps", "hrrr", "ecmwf", "gem_regional"], uv: ["nbm", "hrdps"] },
  { id: "B", models: ["nbm", "ecmwf", "gem_regional"], uv: ["nbm", "ecmwf"] },
  { id: "C", models: ["nbm", "ecmwf", "gfs_global"], uv: ["nbm", "ecmwf"] },
  { id: "D", models: ["ecmwf", "gfs_global"], uv: ["ecmwf", "gfs_global"] },
];

// ---------------------------------------------------------------- fetching

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getText(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.ok) return await res.text();
      console.log(`  HTTP ${res.status} ${url.slice(0, 120)}`);
    } catch (err) {
      console.log(`  ${err.message} ${url.slice(0, 120)}`);
    }
    await sleep(1500 * i);
  }
  return null;
}

// EC bulk CSV for one station and month -> { "YYYY-MM-DDTHH" (UTC): [kt, deg|null] }
export function parseEcClimateCsv(csv) {
  const out = {};
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return out;
  const split = (l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, ""));
  const head = split(lines[0]);
  const iT = head.findIndex((h) => /^Date\/Time/i.test(h));
  const iS = head.findIndex((h) => /^Wind Spd/i.test(h));
  const iD = head.findIndex((h) => /^Wind Dir/i.test(h));
  if (iT < 0 || iS < 0) return out;
  for (const l of lines.slice(1)) {
    const c = split(l);
    const spd = parseFloat(c[iS]);
    if (!isFinite(spd)) continue;
    const t = new Date(c[iT].replace(" ", "T") + ":00-08:00"); // LST, no daylight time
    if (isNaN(t)) continue;
    const dir = parseFloat(c[iD]);
    out[t.toISOString().slice(0, 13)] = [spd * KMH_TO_KT, isFinite(dir) && dir > 0 ? dir * 10 : null];
  }
  return out;
}

async function fetchObservations(climateId, from, to) {
  const obs = {};
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (d <= to) {
    const url = `https://climate.weather.gc.ca/climate_data/bulk_data_e.html?format=csv&climate_id=${climateId}` +
      `&Year=${d.getUTCFullYear()}&Month=${d.getUTCMonth() + 1}&Day=1&time=LST&timeframe=1&submit=Download+Data`;
    const csv = await getText(url);
    if (csv) Object.assign(obs, parseEcClimateCsv(csv));
    d.setUTCMonth(d.getUTCMonth() + 1);
    await sleep(300);
  }
  return obs;
}

// Open-Meteo previous runs (day before) -> { "YYYY-MM-DDTHH" (UTC): { speeds, dirs } }
async function fetchForecasts(lat, lon, from, to) {
  const out = {};
  const params = Object.entries(MOS_MODEL_PARAMS);
  const day = 86400000;
  for (let t = from.getTime(); t <= to.getTime(); t += 90 * day) {
    const a = new Date(t).toISOString().slice(0, 10);
    const b = new Date(Math.min(t + 89 * day, to.getTime())).toISOString().slice(0, 10);
    const url = `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=wind_speed_10m_previous_day1,wind_direction_10m_previous_day1&models=${params.map(([, p]) => p).join(",")}` +
      `&wind_speed_unit=kn&timezone=GMT&start_date=${a}&end_date=${b}`;
    const txt = await getText(url);
    if (!txt) continue;
    const h = JSON.parse(txt).hourly || {};
    (h.time || []).forEach((time, i) => {
      const rec = out[time.slice(0, 13)] ||= { speeds: {}, dirs: {} };
      for (const [key, p] of params) {
        const s = h[`wind_speed_10m_previous_day1_${p}`]?.[i];
        const d = h[`wind_direction_10m_previous_day1_${p}`]?.[i];
        if (s != null) rec.speeds[key] = s;
        if (d != null) rec.dirs[key] = d;
      }
    });
    await sleep(500);
  }
  return out;
}

// ---------------------------------------------------------------- fitting

export function features(v, rec, utcHour) {
  const x = [1];
  for (const m of v.models) { const s = rec.speeds[m]; if (s == null) return null; x.push(s); }
  let u = 0, w = 0;
  for (const m of v.uv) {
    const s = rec.speeds[m], d = rec.dirs[m];
    if (s == null || d == null) return null;
    u += -s * Math.sin(d * Math.PI / 180); w += -s * Math.cos(d * Math.PI / 180);
  }
  x.push(u / v.uv.length, w / v.uv.length, Math.sin(2 * Math.PI * utcHour / 24), Math.cos(2 * Math.PI * utcHour / 24));
  return x;
}

// Ridge regression by the normal equations (small p, Gaussian elimination).
export function solve(X, y, lam) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const x = X[i];
    for (let a = 0; a < p; a++) { b[a] += x[a] * y[i]; for (let c = 0; c < p; c++) A[a][c] += x[a] * x[c]; }
  }
  for (let a = 0; a < p; a++) A[a][a] += lam * X.length;
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < p; r++) {
      if (r === c || A[c][c] === 0) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < p; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => (A[i][i] ? v / A[i][i] : 0));
}

const dot = (x, c) => x.reduce((a, v, i) => a + v * c[i], 0);

function fitOne(rows) {
  const X = rows.map((r) => r.x), y = rows.map((r) => r.o);
  const coef = solve(X, y, LAMBDA);
  const pred = X.map((x) => Math.max(0, dot(x, coef)));
  const err = solve(pred.map((p) => [1, p]), pred.map((p, i) => Math.abs(y[i] - p)), 0);
  return { coef, err };
}

// Leave one month out: every hour is predicted by a fit that never saw its month.
function crossValidate(rows) {
  const months = [...new Set(rows.map((r) => r.k.slice(0, 7)))];
  const out = [];
  for (const mo of months) {
    const tr = rows.filter((r) => r.k.slice(0, 7) !== mo), te = rows.filter((r) => r.k.slice(0, 7) === mo);
    if (tr.length < 500 || !te.length) continue;
    const { coef, err } = fitOne(tr);
    for (const r of te) {
      const p = Math.max(0, dot(r.x, coef));
      out.push({ k: r.k, p, o: r.o, sigma: Math.max(1, (err[0] + err[1] * p) * 1.2533) });
    }
  }
  return out;
}

export function scoreSet(pred) {
  const n = pred.length;
  if (!n) return { n: 0 };
  let ae = 0, bias = 0, br = 0;
  const ev = pred.filter((r) => r.o >= THRESHOLD_KT).length;
  const clim = ev / n;
  let bc = 0;
  const bins = Array.from({ length: 5 }, () => ({ n: 0, said: 0, happened: 0 }));
  for (const r of pred) {
    ae += Math.abs(r.p - r.o); bias += r.p - r.o;
    const P = 1 - normCdf((THRESHOLD_KT - r.p) / r.sigma), O = r.o >= THRESHOLD_KT ? 1 : 0;
    br += (P - O) ** 2; bc += (clim - O) ** 2;
    const b = bins[Math.min(4, Math.floor(P * 5))];
    b.n++; b.said += P; b.happened += O;
  }
  const hit = pred.filter((r) => r.o >= THRESHOLD_KT && r.p >= THRESHOLD_KT).length;
  const fc = pred.filter((r) => r.p >= THRESHOLD_KT).length;
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    n,
    mae_kt: r2(ae / n),
    bias_kt: r2(bias / n),
    windy_hours: ev,
    caught: ev ? r2(hit / ev) : null,
    false_alarms: fc ? r2((fc - hit) / fc) : null,
    brier: Math.round((br / n) * 1000) / 1000,
    brier_climatology: Math.round((bc / n) * 1000) / 1000,
    reliability: bins.map((b, i) => ({ range: `${i * 20}-${i * 20 + 20}%`, n: b.n, said: b.n ? r2(b.said / b.n) : null, happened: b.n ? r2(b.happened / b.n) : null })),
  };
}

function joinRows(v, fc, obs) {
  const rows = [];
  for (const k of Object.keys(obs)) {
    const rec = fc[k];
    if (!rec) continue;
    const x = features(v, rec, Number(k.slice(11, 13)));
    if (x) rows.push({ k, x, o: obs[k][0] });
  }
  return rows;
}

// Recent correction, recomputed every night from the scoring window (added
// Sep 27 2026 after Sand Heads ran ~3kt high on a light NW day):
// 1. Bias: the blend's average miss over the last 7 days, on hours where
//    either the forecast or the reading was 6kt+ (calm nights don't count),
//    shrunk toward zero when there are few hours (n / (n + 100)) and capped
//    at ±2kt. Needs 60+ such hours. In a year of replays (each day corrected
//    only from the days before it) this improved the probability score at
//    every station, by 1 to 3% over the year and 7 to 8% at Sand Heads and
//    Point Atkinson over the last month; a 14 day window gained less.
// 2. Spread: if, after that, the last 30 days missed by more than the error
//    model expects (mean |miss| / sigma above the normal 0.80), widen the
//    band by that ratio, up to 1.5x (never narrower). Over the year this
//    rarely triggered and was neutral; it is a guard for unusual spells.
export function recentAdjustment(pred) {
  if (!pred.length) return { bias_kt: null, offset_kt: 0, sigma_scale: 1, hours_bias: 0, hours_spread: 0 };
  const end = Date.parse(pred[pred.length - 1].k + ":00Z") + 3600000;
  const since = (days) => end - days * 86400000;
  const t = (r) => Date.parse(r.k + ":00Z");
  const rel = pred.filter((r) => t(r) >= since(7) && Math.max(r.p, r.o) >= 6);
  let bias = null, offset = 0;
  if (rel.length >= 60) {
    bias = rel.reduce((a, r) => a + r.p - r.o, 0) / rel.length;
    offset = Math.max(-2, Math.min(2, -bias * rel.length / (rel.length + 100)));
  }
  const z = pred.filter((r) => t(r) >= since(30))
    .map((r) => ({ p: Math.max(0, r.p + offset), o: r.o, s: r.sigma }))
    .filter((r) => Math.max(r.p, r.o) >= 6)
    .map((r) => Math.abs(r.o - r.p) / r.s);
  const scale = z.length >= 100 ? Math.max(1, Math.min(1.5, z.reduce((a, b) => a + b, 0) / z.length / 0.7979)) : 1;
  const r2 = (v) => Math.round(v * 100) / 100;
  return { bias_kt: bias == null ? null : r2(bias), offset_kt: r2(offset), sigma_scale: r2(scale), hours_bias: rel.length, hours_spread: z.length };
}

// ---------------------------------------------------------------- modes

async function loadCoefficients() {
  return JSON.parse(await readFile(COEF_PATH, "utf8"));
}

async function score(coef, days = 30) {
  const to = new Date(Date.now() - 86400000);
  const from = new Date(to.getTime() - days * 86400000);
  const out = { updated_at: new Date().toISOString(), window_days: days, threshold_kt: THRESHOLD_KT, trained: coef.trained, points: {} };
  const recent = { updated_at: out.updated_at, note: "Applied on top of mos-coefficients.json by applyMos (rules.js); see recentAdjustment in scripts/mos-train.mjs.", points: {} };
  for (const [id, pt] of Object.entries(coef.points)) {
    console.log(`Scoring ${id} against ${pt.station}...`);
    const obs = await fetchObservations(pt.climate_id, from, to);
    const fc = await fetchForecasts(pt.lat, pt.lon, from, to);
    const pred = [];
    for (const k of Object.keys(obs).sort()) {
      if (k < from.toISOString().slice(0, 13) || !fc[k]) continue;
      const r = applyMos(pt, { ...fc[k], utcHour: Number(k.slice(11, 13)) });
      if (r) pred.push({ k, p: r.speed, o: obs[k][0], sigma: r.sigma });
    }
    // The plain average of the same models, for comparison.
    const raw = pred.map((r) => {
      const s = Object.values(fc[r.k].speeds);
      return { ...r, p: s.reduce((a, b) => a + b, 0) / s.length };
    });
    recent.points[id] = recentAdjustment(pred);
    out.points[id] = { station: pt.station, learned: scoreSet(pred), plain_average: { mae_kt: scoreSet(raw).mae_kt, caught: scoreSet(raw).caught }, recent: recent.points[id] };
    console.log(`  recent correction: ${JSON.stringify(recent.points[id])}`);
    console.log(`  ${pred.length}h, MAE ${out.points[id].learned.mae_kt}kt (plain average ${out.points[id].plain_average.mae_kt}kt), caught ${out.points[id].learned.caught}`);
  }
  await writeFile(SCORE_PATH, JSON.stringify(out, null, 2) + "\n");
  await writeFile(RECENT_PATH, JSON.stringify(recent, null, 2) + "\n");
  console.log(`Wrote ${SCORE_PATH} and ${RECENT_PATH}`);
}

async function fit(coef) {
  const to = new Date(Date.now() - 86400000);
  const from = new Date(to.getTime() - 365 * 86400000);
  const next = { ...coef, trained: new Date().toISOString().slice(0, 10), points: {} };
  for (const [id, pt] of Object.entries(coef.points)) {
    console.log(`Fitting ${id} against ${pt.station}...`);
    const obs = await fetchObservations(pt.climate_id, from, to);
    const fc = await fetchForecasts(pt.lat, pt.lon, from, to);
    const variants = [];
    let keep = true;
    for (const v of VARIANTS) {
      const rows = joinRows(v, fc, obs);
      if (rows.length < 2000) { console.log(`  ${v.id}: only ${rows.length} hours, keeping the old fit`); keep = false; break; }
      const { coef: c, err } = fitOne(rows);
      const cv = scoreSet(crossValidate(rows));
      // Compare with the current coefficients on the same hours.
      const old = pt.variants.find((o) => o.id === v.id);
      const oldPred = old ? rows.map((r) => ({ k: r.k, o: r.o, p: Math.max(0, dot(r.x, old.coef)), sigma: 1 })) : [];
      const oldMae = old ? scoreSet(oldPred).mae_kt : null;
      console.log(`  ${v.id}: ${rows.length}h, cross validated MAE ${cv.mae_kt}kt (current fit on the same hours ${oldMae}kt in sample), caught ${cv.caught}, false ${cv.false_alarms}`);
      // Refuse a refit that is clearly worse out of sample than the current
      // fit is in sample plus a margin (something wrong with the data).
      if (oldMae != null && cv.mae_kt > oldMae * 1.15) { console.log("  worse than the current fit, keeping it"); keep = false; break; }
      variants.push({ id: v.id, n: rows.length, models: v.models, uv: v.uv, coef: c.map((x) => Math.round(x * 1e4) / 1e4), err: err.map((x) => Math.round(x * 1e4) / 1e4), cv_mae_kt: cv.mae_kt });
    }
    next.points[id] = keep ? { ...pt, variants } : pt;
  }
  await writeFile(COEF_PATH, JSON.stringify(next, null, 1) + "\n");
  console.log(`Wrote ${COEF_PATH}`);
}

async function main() {
  const mode = process.argv[2] || "auto";
  const coef = await loadCoefficients();
  if (mode === "fit" || (mode === "auto" && (new Date().getUTCDate() === 1 || Date.now() - Date.parse(coef.trained) > 35 * 86400000))) {
    await fit(coef);
  }
  if (mode === "score" || mode === "auto" || mode === "fit") await score(await loadCoefficients());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
