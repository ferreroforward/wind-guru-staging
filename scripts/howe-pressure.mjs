// Howe Sound pressure panel (Oct 2026). Squamish and Porteau winds are often
// pressure driven: on Oct 27 the Spit blew 23 gusting 27 with no thermal
// (Squamish Airport and Pam Rocks both 10°C) while Vancouver minus Pemberton
// climbed from about +1 to +3 hPa, running about 1 hPa ahead of the
// forecast. This builds what the page needs to show that live:
//
//   observed: the last 12 hourly sea level pressures (0.1 hPa) at Pemberton
//     (CWGP), Vancouver (CYVR), Squamish Airport (CWSK) and Pam Rocks (CWAS)
//     from EC's SWOB files on dd.weather.gc.ca, plus Pam Rocks wind and the
//     two temperatures. (The EC past 24 hour pages only give kPa to one
//     decimal, 1 hPa steps, too coarse for this.)
//   forecast: the models' Vancouver minus Pemberton gap per hour, the same
//     dPL the learned Squamish model uses (mean of GFS, ECMWF and HRDPS sea
//     level pressure at the two points).
//
// Sign: gap = Vancouver minus Pemberton. Positive pulls air up the Sound
// (southerly inflow); Pemberton 3+ hPa higher pushes air out (outflow).

const SWOB_BASE = "https://dd.weather.gc.ca/today/observations/swob-ml";
export const PRESSURE_STATIONS = {
  pem: { id: "CWGP", file: "CWGP-AUTO", name: "Pemberton" },
  yvr: { id: "CYVR", file: "CYVR-MAN", name: "Vancouver Airport" },
  wsk: { id: "CWSK", file: "CWSK-AUTO", name: "Squamish Airport" },
  was: { id: "CWAS", file: "CWAS-AUTO", name: "Pam Rocks" },
};
const FORECAST_MODELS = ["gfs", "ecmwf", "gem"]; // same as THERMAL_INPUT_MODELS in rules.js
const DIR16 = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

function el(xml, name) {
  const m = xml.match(new RegExp(`<element name="${name}" uom="[^"]*" value="([^"]*)"`));
  if (!m || m[1] === "MSNG" || m[1] === "") return null;
  const v = parseFloat(m[1]);
  return isFinite(v) ? v : null;
}
export function parsePressureSwob(xml) {
  const tm = xml.match(/<element name="date_tm" uom="[^"]*" value="([^"]+)"/);
  const at = tm ? Date.parse(tm[1]) : NaN;
  if (!isFinite(at)) return null;
  const kmh = el(xml, "avg_wnd_spd_10m_pst10mts") ?? el(xml, "avg_wnd_spd_10m_pst2mts");
  const deg = el(xml, "avg_wnd_dir_10m_pst10mts") ?? el(xml, "avg_wnd_dir_10m_pst2mts");
  const kt = kmh != null ? Math.round(kmh * 0.539957 * 10) / 10 : null;
  return {
    at,
    mslp: el(xml, "mslp"),
    temp: el(xml, "air_temp"),
    kt,
    dir: kt == null ? null : kt < 1 ? "calm" : deg != null ? DIR16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] : null,
  };
}

// "2026-10-27T17:00:00Z" -> Pacific hour key "2026-10-27T10:00", the same
// clock the forecast rows use.
const pacificFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
export function pacificHourKey(ms) {
  const p = Object.fromEntries(pacificFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}
function swobUrl(st, hourMs) {
  const d = new Date(hourMs).toISOString(); // 2026-10-27T17:00:00.000Z
  const ymd = d.slice(0, 10).replace(/-/g, "");
  const stamp = `${d.slice(0, 10)}-${d.slice(11, 13)}00`;
  return `${SWOB_BASE}/${ymd}/${st.id}/${stamp}-${st.file}-swob.xml`;
}

async function getText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" }, signal: AbortSignal.timeout(20000) });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

// The last `hours` top of hour readings (oldest first), one row per hour:
// { t: Pacific hour key, at, pem, yvr, wsk, was (hPa), gap, local, pam_kt,
//   pam_dir, wsk_c, was_c }. gap = yvr - pem; local = was - wsk.
export async function fetchObservedPressure(now = new Date(), hours = 12) {
  const top = new Date(now);
  top.setUTCMinutes(0, 0, 0);
  const slots = [];
  for (let i = hours - 1; i >= 0; i--) slots.push(top.getTime() - i * 3600000);
  const rows = await Promise.all(slots.map(async (ms) => {
    const r = { t: pacificHourKey(ms), at: ms };
    await Promise.all(Object.entries(PRESSURE_STATIONS).map(async ([k, st]) => {
      const xml = await getText(swobUrl(st, ms));
      const o = xml ? parsePressureSwob(xml) : null;
      r[k] = o?.mslp ?? null;
      if (k === "was" && o) { r.pam_kt = o.kt; r.pam_dir = o.dir; r.was_c = o.temp; }
      if (k === "wsk" && o) r.wsk_c = o.temp;
    }));
    r.gap = r.yvr != null && r.pem != null ? Math.round((r.yvr - r.pem) * 10) / 10 : null;
    r.local = r.was != null && r.wsk != null ? Math.round((r.was - r.wsk) * 10) / 10 : null;
    return r;
  }));
  return rows.filter((r) => r.gap != null || r.local != null || r.pam_kt != null);
}

const mean = (o) => {
  const v = FORECAST_MODELS.map((k) => o?.[k]).filter((x) => x != null && isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
// { "YYYY-MM-DDTHH:00": gap } from the forecast rows at Vancouver and Pemberton.
export function forecastGap(coastalRowsByTime, interiorRowsByTime) {
  const out = {};
  for (const [t, row] of Object.entries(coastalRowsByTime || {})) {
    const a = mean(row?.pressure), b = mean(interiorRowsByTime?.[t]?.pressure);
    if (a != null && b != null) out[t] = Math.round((a - b) * 10) / 10;
  }
  return out;
}

// EC prunes the previous UTC day's SWOB folder early (Oct 28 2026: at 8am
// Pacific the Oct 27 files were already gone), so an evening run can't
// reach back 12 hours. Hours the last run saved fill those gaps.
export function mergeObserved(fresh, previous, now = new Date(), hours = 12) {
  const from = now.getTime() - hours * 3600000;
  const byT = new Map();
  for (const r of previous || []) if (r && isFinite(r.at) && r.at > from) byT.set(r.t, r);
  for (const r of fresh || []) {
    const old = byT.get(r.t);
    // A fresh row wins, but keep any station the old row had and this one lacks.
    byT.set(r.t, old ? Object.fromEntries(Object.keys({ ...old, ...r }).map((k) => [k, r[k] ?? old[k]])) : r);
  }
  return [...byT.values()].sort((a, b) => a.at - b.at);
}

export async function buildHowePressure(gradientStations, now = new Date(), previousObserved = [], observedAlready = null) {
  const observed = observedAlready || mergeObserved(await fetchObservedPressure(now), previousObserved, now);
  // Keep a window around now (14 hours back, 36 ahead): enough for the chart
  // even when the page is opened a while after this run, and keeps the file small.
  const all = forecastGap(gradientStations?.rows?.coastal, gradientStations?.rows?.interior);
  const from = pacificHourKey(now.getTime() - 14 * 3600000), to = pacificHourKey(now.getTime() + 36 * 3600000);
  const forecast = Object.fromEntries(Object.entries(all).filter(([t]) => t >= from && t <= to));
  return { updated_at: now.toISOString(), source: "EC SWOB hourly sea level pressure (0.1 hPa)", observed, forecast };
}
