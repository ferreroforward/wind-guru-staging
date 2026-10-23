// Waves for the "Foil assist" pick (Oct 2026). Foil assist riders need
// waves, not wind, so every forecast run pulls the SalishSeaCast wave model
// (WaveWatch III for the Strait of Georgia, run daily by UBC EOAS with DFO,
// forced by HRDPS 2.5km winds; about 500m cells, every 30 minutes, about two
// days ahead) at a water cell off each covered beach.
// https://salishsea.eos.ubc.ca/erddap/griddap/ubcSSf2DWaveFields30mV17-02.html
//
// The model doesn't cover Howe Sound or Burrard Inlet. Porteau gets an
// estimate from our own swell index (wind, fetch and tide, rules.js
// swellForHours), carried on as leftover swell after the wind drops, since
// Guillermo's best Porteau foil assist sessions are leftover outflow swell.
// Squamish and Cates get nothing.

const DATASET = "https://salishsea.eos.ubc.ca/erddap/griddap/ubcSSf2DWaveFields30mV17-02.json";

// The nearest model water cell to each beach, found Oct 23 2026 (cells right
// at some beaches are masked as land, so a few sit 1 to 2km out; the beach
// itself can be a little smaller than the number here).
export const WAVE_POINTS = {
  "jericho-spanish-banks": [{ lat: 49.2735, lon: -123.2070 }],
  "dundarave-pier": [{ lat: 49.3185, lon: -123.1930 }],
  "ambleside": [{ lat: 49.3095, lon: -123.1580 }],
  "erwin-park": [{ lat: 49.3365, lon: -123.2770 }],
  // Both sides of the causeway: south side for southerly swell, north side
  // for northerly swell (Guillermo: both work outside the breakwater).
  "tsawwassen-south": [{ lat: 49.0035, lon: -123.1300, side: "south side" }, { lat: 49.0125, lon: -123.1300, side: "north side" }],
  "boundary-bay": [{ lat: 49.0305, lon: -123.0320 }],
  "white-rock-east": [{ lat: 49.0035, lon: -122.8010 }],
  "crescent-beach": [{ lat: 49.0530, lon: -122.8990 }],
};
export const ESTIMATE_SPOTS = ["porteau-cove"];

const M_TO_FT = 3.28084;

// "2026-10-23T18:00:00Z" -> Pacific "2026-10-23T11:00" (the forecast hours' clock).
const pacificFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
export function pacificHourKey(iso) {
  const p = Object.fromEntries(pacificFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

// ERDDAP JSON table -> { "YYYY-MM-DDTHH:00": { m, period_s, dir_deg } } on the hour.
export function parseWaveTable(json) {
  const t = json?.table;
  if (!t || !Array.isArray(t.rows)) return {};
  const col = (n) => t.columnNames.indexOf(n);
  const iT = col("time"), iH = col("hs"), iP = col("t02"), iD = col("dir");
  const out = {};
  for (const r of t.rows) {
    const time = r[iT];
    if (typeof time !== "string" || !time.includes(":00:00")) continue; // keep the top of each hour
    const hs = r[iH];
    if (hs == null || !isFinite(hs)) continue;
    out[pacificHourKey(time)] = { m: hs, period_s: isFinite(r[iP]) ? r[iP] : null, dir_deg: isFinite(r[iD]) ? r[iD] : null };
  }
  return out;
}

async function fetchPoint(pt, startIso) {
  const lon = pt.lon + 360;
  const dims = `[(${startIso}):1:(last)][(${pt.lat})][(${lon})]`;
  const url = `${DATASET}?hs${dims},t02${dims},dir${dims}`;
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseWaveTable(await res.json());
}

// { spotId: { hourKey: { ft, period_s, dir_deg, side? } } } for every covered
// spot; a spot whose fetch fails is simply missing (the page shows no waves).
export async function fetchWaves(now = new Date()) {
  const start = new Date(now.getTime() - 3600000);
  start.setUTCMinutes(0, 0, 0);
  const startIso = start.toISOString().replace(".000Z", "Z");
  const out = {};
  for (const [spotId, pts] of Object.entries(WAVE_POINTS)) {
    try {
      const series = await Promise.all(pts.map((pt) => fetchPoint(pt, startIso)));
      const byHour = {};
      series.forEach((s, i) => {
        for (const [k, v] of Object.entries(s)) {
          const ft = Math.round(v.m * M_TO_FT * 10) / 10;
          if (!byHour[k] || ft > byHour[k].ft) {
            byHour[k] = { ft, period_s: v.period_s != null ? Math.round(v.period_s * 10) / 10 : null, dir_deg: v.dir_deg != null ? Math.round(v.dir_deg) : null, ...(pts[i].side ? { side: pts[i].side } : {}) };
          }
        }
      });
      out[spotId] = byHour;
    } catch (err) {
      console.log(`[waves:${spotId}] fetch failed: ${err.message}`);
    }
  }
  return out;
}

// Puts h.waves on each forecast hour. Model spots: straight from the model.
// Estimate spots: our swell index, decaying by a quarter each hour after the
// wind drops instead of going straight to flat.
export function attachWaves(spotId, hours, waves) {
  if (WAVE_POINTS[spotId]) {
    const w = waves?.[spotId];
    if (!w) return;
    for (const h of hours) if (w[h.time]) h.waves = { ...w[h.time], source: "model" };
    return;
  }
  if (!ESTIMATE_SPOTS.includes(spotId)) return;
  let prev = null;
  for (const h of hours) {
    const sw = h.swell;
    const now = sw && sw.hs_ft > 0 ? { ft: sw.hs_ft, period_s: sw.period_s ?? null } : null;
    const carried = prev && prev.ft * 0.75 >= 0.5 ? { ft: Math.round(prev.ft * 0.75 * 10) / 10, period_s: prev.period_s } : null;
    const pick = now && (!carried || now.ft >= carried.ft) ? now : carried;
    if (pick) h.waves = { ...pick, dir_deg: null, source: "estimate" };
    prev = pick;
  }
}
