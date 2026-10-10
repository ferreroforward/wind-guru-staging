#!/usr/bin/env node
// Wind Guru — learned Squamish thermal: refit data/squamish-thermal.json.
//
//   node scripts/thermal-train.mjs fit        refit from the Spit meter history
//   node scripts/thermal-train.mjs selftest   check the maths on made up data (no network)
//
// Truth: the Squamish Windsports Society Spit meter (the same endpoint the
// live check uses), one request per day, averaged to the hour. Its `dt` is
// local wall-clock time written as if it were UTC, so the UTC hour of `dt`
// IS the local hour. Only inflow counts: an hour whose mean direction is
// outside 130 to 280 degrees is scored as 0kt. The meter only runs for the
// season (about mid May to mid September), which is also the training range.
//
// Inputs: Open-Meteo's historical forecast API at the spot and the four
// reference points (PRESSURE_REFERENCE in spots.js), mean of GFS, ECMWF and
// HRDPS, turned into the same features the generator builds at forecast time
// (thermalInputs in rules.js). Ridge regression, scored by leaving one month
// out, with the same |miss| = a + b * speed error model the other learned
// forecasts use (see mos-train.mjs).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SPOTS, PRESSURE_REFERENCE } from "../assets/spots.js";
import { MODELS, reshapeOpenMeteo, thermalInputs, applyThermalModel, THERMAL_INPUT_MODELS } from "../assets/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "squamish-thermal.json");
const UA = { "User-Agent": "wind-guru-agent/1.0" };
const LAMBDA = 0.01;
const HOURS = [9, 20];
const INFLOW_SECTOR = [130, 280];
const SEASON = { startMonthDay: "04-15", endMonthDay: "10-02" };
const HOUR_FEATS = ["h1s", "h1c", "h2s", "h2c"];
const DRIVERS = ["rad", "cl", "dTls", "dTint", "dTlil", "dPL", "dPloc"];
const VARIANTS = [
  { id: "A", features: [...HOUR_FEATS, ...DRIVERS, "coarseS", "gem"] },
  { id: "B", features: [...HOUR_FEATS, ...DRIVERS] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.ok) { const t = await res.text(); return t.trim() ? JSON.parse(t) : null; }
      console.log(`  HTTP ${res.status} ${url.slice(0, 110)}`);
    } catch (err) { console.log(`  ${err.message} ${url.slice(0, 110)}`); }
    await sleep(1500 * i);
  }
  return null;
}

// ------------------------------------------------------------------ truth

export function spitHourly(json) {
  const out = {};
  if (!json || !Array.isArray(json.dt)) return out;
  const b = {};
  for (let i = 0; i < json.dt.length; i++) {
    const s = parseFloat(json.ws[i]);
    if (!isFinite(s)) continue;
    const key = new Date(parseFloat(json.dt[i]) * 1000).toISOString().slice(0, 13); // local wall clock, see header
    const d = json.wd ? parseFloat(json.wd[i]) : NaN;
    (b[key] ||= { s: [], x: [], y: [] }).s.push(s);
    if (isFinite(d)) { b[key].x.push(Math.sin(d * Math.PI / 180)); b[key].y.push(Math.cos(d * Math.PI / 180)); }
  }
  const avg = (a) => a.reduce((p, q) => p + q, 0) / a.length;
  for (const [key, v] of Object.entries(b)) {
    if (v.s.length < 6) continue; // under about 20 minutes of readings
    const dir = v.x.length ? (Math.atan2(avg(v.x), avg(v.y)) * 180 / Math.PI + 360) % 360 : null;
    const inflow = dir == null || (dir >= INFLOW_SECTOR[0] && dir <= INFLOW_SECTOR[1]);
    out[key] = inflow ? avg(v.s) : 0;
  }
  return out;
}

async function fetchTruth(years) {
  const truth = {};
  for (const y of years) {
    const end = new Date(`${y}-${SEASON.endMonthDay}T00:00:00Z`);
    let days = 0;
    for (let d = new Date(`${y}-${SEASON.startMonthDay}T00:00:00Z`); d <= end; d = new Date(d.getTime() + 86400000)) {
      const day = d.toISOString().slice(0, 10);
      const json = await getJson(`https://squamishwindsports.com/wind-data/getmet.php?wind_src=spit&reqdate=${day}&reqtime=0`, 2);
      const hourly = spitHourly(json);
      if (Object.keys(hourly).length) days++;
      Object.assign(truth, hourly);
      await sleep(150);
    }
    console.log(`  ${y}: ${days} days of Spit meter readings`);
  }
  return truth;
}

// ----------------------------------------------------------------- inputs

async function fetchRows(pt, start, end) {
  const params = MODELS.filter((m) => THERMAL_INPUT_MODELS.includes(m.key)).map((m) => m.param).join(",");
  const hourly = "wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,pressure_msl,precipitation,temperature_2m,shortwave_radiation";
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${pt.lat}&longitude=${pt.lon}` +
    `&start_date=${start}&end_date=${end}&hourly=${hourly}&models=${params}&wind_speed_unit=kn&timezone=America%2FLos_Angeles`;
  const json = await getJson(url);
  return json ? Object.fromEntries(reshapeOpenMeteo(json).map((r) => [r.time.slice(0, 13), r])) : null;
}

// ------------------------------------------------------------------ maths

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
    [M[i], M[p]] = [M[p], M[i]];
    for (let j = i + 1; j < n; j++) { const f = M[j][i] / M[i][i]; for (let k = i; k <= n; k++) M[j][k] -= f * M[i][k]; }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
  return x;
}
function featureVector(x, feats) {
  const h = { h1s: Math.sin(2 * Math.PI * x.hour / 24), h1c: Math.cos(2 * Math.PI * x.hour / 24), h2s: Math.sin(4 * Math.PI * x.hour / 24), h2c: Math.cos(4 * Math.PI * x.hour / 24) };
  return feats.map((f) => (f in h ? h[f] : x[f]));
}
// Ridge on standardised features, returned in raw units (intercept + coef).
export function ridge(samples, feats, lambda = LAMBDA) {
  const X = samples.map((s) => featureVector(s.x, feats)), p = feats.length, n = X.length;
  const mu = Array(p).fill(0), sd = Array(p).fill(0);
  for (const r of X) for (let j = 0; j < p; j++) mu[j] += r[j] / n;
  for (const r of X) for (let j = 0; j < p; j++) sd[j] += (r[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const my = samples.reduce((a, s) => a + s.y, 0) / n;
  const G = Array.from({ length: p }, () => Array(p).fill(0)), c = Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const z = X[i].map((v, j) => (v - mu[j]) / sd[j]), y = samples[i].y - my;
    for (let j = 0; j < p; j++) { c[j] += z[j] * y; for (let k = 0; k < p; k++) G[j][k] += z[j] * z[k]; }
  }
  for (let j = 0; j < p; j++) G[j][j] += lambda * n;
  const w = solve(G, c);
  return { features: feats, coef: w.map((v, j) => v / sd[j]), intercept: my - w.reduce((a, v, j) => a + v * mu[j] / sd[j], 0) };
}
const predict = (m, x) => Math.max(0, featureVector(x, m.features).reduce((a, v, i) => a + v * m.coef[i], m.intercept));
const percentile = (a, q) => { const s = [...a].sort((p, r) => p - r); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

export function train(samples) {
  const months = [...new Set(samples.map((s) => s.month))];
  const variants = [], backtest = {};
  for (const v of VARIANTS) {
    const usable = samples.filter((s) => v.features.every((f) => HOUR_FEATS.includes(f) || s.x[f] != null));
    const cv = [];
    for (const m of months) {
      const fit = ridge(usable.filter((s) => s.month !== m), v.features);
      for (const s of usable.filter((x) => x.month === m)) cv.push({ p: predict(fit, s.x), y: s.y, hour: s.x.hour });
    }
    // |miss| = a + b * predicted speed
    const n = cv.length, mp = cv.reduce((a, r) => a + r.p, 0) / n, me = cv.reduce((a, r) => a + Math.abs(r.p - r.y), 0) / n;
    let sxy = 0, sxx = 0;
    for (const r of cv) { sxy += (r.p - mp) * (Math.abs(r.p - r.y) - me); sxx += (r.p - mp) ** 2; }
    const b = sxx ? sxy / sxx : 0;
    const aft = cv.filter((r) => r.hour >= 11 && r.hour <= 18);
    backtest[v.id] = {
      hours: aft.length,
      mae_kt: +(aft.reduce((a, r) => a + Math.abs(r.p - r.y), 0) / aft.length).toFixed(2),
      bias_kt: +(aft.reduce((a, r) => a + (r.p - r.y), 0) / aft.length).toFixed(2),
    };
    const full = ridge(usable, v.features);
    variants.push({ id: v.id, features: v.features, intercept: +full.intercept.toFixed(4), coef: full.coef.map((c) => +c.toPrecision(5)), err: [+(me - b * mp).toFixed(3), +b.toFixed(4)] });
  }
  const clip = {};
  for (const f of [...DRIVERS, "coarseS", "gem"]) {
    const vals = samples.map((s) => s.x[f]).filter((v) => v != null);
    clip[f] = [+percentile(vals, 0.01).toFixed(2), +percentile(vals, 0.99).toFixed(2)];
  }
  return { variants, clip, backtest };
}

// ------------------------------------------------------------------- main

async function fit() {
  const spot = SPOTS.find((s) => s.id === "squamish-spit");
  const thisYear = new Date().getUTCFullYear();
  const years = [thisYear - 1, thisYear];
  console.log("Spit meter history...");
  const truth = await fetchTruth(years);
  const samples = [];
  for (const y of years) {
    const keys = Object.keys(truth).filter((k) => k.startsWith(String(y))).sort();
    if (!keys.length) continue;
    const start = keys[0].slice(0, 10), end = keys[keys.length - 1].slice(0, 10);
    console.log(`Model inputs ${start} to ${end}...`);
    const own = await fetchRows(spot, start, end);
    const refs = {};
    for (const [name, key] of [["mouth", "howeSoundMouth"], ["coastal", "coastal"], ["interior", "interior"], ["far", "far"]]) {
      refs[name] = await fetchRows(PRESSURE_REFERENCE[key], start, end);
    }
    if (!own || Object.values(refs).some((r) => !r)) { console.log("  model inputs missing, skipping this year"); continue; }
    for (const k of keys) {
      const hour = Number(k.slice(11, 13));
      if (hour < HOURS[0] || hour > HOURS[1] || !own[k]) continue;
      const x = thermalInputs(own[k], { mouth: refs.mouth[k], coastal: refs.coastal[k], interior: refs.interior[k], far: refs.far[k] }, hour);
      if (!x || DRIVERS.some((f) => x[f] == null)) continue;
      samples.push({ x, y: truth[k], month: k.slice(0, 7), day: k.slice(0, 10) });
    }
  }
  if (samples.length < 800) { console.log(`Only ${samples.length} usable hours, keeping the existing coefficients.`); return; }
  const { variants, clip, backtest } = train(samples);
  const days = [...new Set(samples.map((s) => s.day))].sort();
  const out = {
    station: "Squamish Spit wind meter",
    trained: new Date().toISOString().slice(0, 10),
    period: `${days[0]}..${days[days.length - 1]}`,
    hours: HOURS, n_hours: samples.length, n_days: days.length,
    input_models: THERMAL_INPUT_MODELS,
    backtest: { method: "leave one month out, hours 11 to 18", ...backtest },
    clip, variants,
  };
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${OUT_PATH}: ${samples.length} hours over ${days.length} days.`, JSON.stringify(backtest));
}

function selftest() {
  // Made up hours from a known formula; the fit must find it again, and the
  // forecast side (applyThermalModel) must give the same number as training.
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const samples = [];
  for (let i = 0; i < 3000; i++) {
    const hour = 9 + Math.floor(rnd() * 12);
    const x = { hour, rad: 100 + rnd() * 800, cl: rnd() * 100, dTls: -1 + rnd() * 4, dTint: -3 + rnd() * 12, dTlil: -1 + rnd() * 15, dPL: -2 + rnd() * 6, dPloc: -0.8 + rnd() * 2, coarseS: -4 + rnd() * 12, gem: 0.5 + rnd() * 11 };
    const y = Math.max(0, 2 + 0.012 * x.rad + 1.2 * x.dTls + 0.5 * x.dTint + 1.1 * x.dPL + 2 * x.dPloc + 0.6 * x.coarseS - 3 * Math.sin(2 * Math.PI * hour / 24) + (rnd() - 0.5) * 2);
    samples.push({ x, y, month: `2026-0${5 + (i % 5)}` });
  }
  const { variants, clip, backtest } = train(samples);
  const A = variants[0], get = (f) => A.coef[A.features.indexOf(f)];
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const checks = [
    ["rad coefficient", near(get("rad"), 0.012, 0.002)], ["dTls coefficient", near(get("dTls"), 1.2, 0.2)],
    ["dPL coefficient", near(get("dPL"), 1.1, 0.15)], ["dPloc coefficient", near(get("dPloc"), 2, 0.3)],
    ["back test error small", backtest.A.mae_kt < 1.2],
    ["forecast side matches training", near(applyThermalModel({ hours: HOURS, clip, variants }, samples[5].x).speed, predict({ features: A.features, coef: A.coef, intercept: A.intercept }, samples[5].x), 0.05)],
    ["Spit hours use dt as local time", spitHourly({ dt: Array(8).fill(0).map((_, i) => String(1786802400 + i * 180)), ws: Array(8).fill("15"), wd: Array(8).fill("190") })["2026-08-15T14"] === 15],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === "selftest") selftest();
else if (cmd === "fit") await fit();
else console.log("usage: node scripts/thermal-train.mjs fit | selftest");
