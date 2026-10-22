// Compact snapshot of the forecast for Wind Guru AI (worker/chat.js).
//
// forecast.json is about 3.6 MB, far too big to parse inside a free
// Cloudflare Worker (10 ms of CPU) or to send to the model. This writes
// data/guru-live.json: one short text block with what a rider would read
// off the page (speed, gust, direction, odds of 12kt, regime, waves, tide)
// for today and the next two days, plus the EC marine forecast, today's
// take and the track record. The worker adds live station readings on top.

import { probabilityInRange, daylightWindow, isDaylightHour } from "../assets/rules.js";

const LEGEND = "Each hour: time, direction and speed (knots, g = gust), odds of 12kt or more, regime, waves, tide height in ft with r rising or f falling. OUTFLOW NOT RIDDEN = Squamish outflow, never recommend. OFF DIR = direction does not work at that spot.";

function pacificDate(d, addDays = 0) {
  const t = new Date(d.getTime() + addDays * 86400000);
  return t.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
}
function dayLabel(dateStr) {
  const [y, m, dd] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
function hourText(h) {
  const n = Number(h.time.slice(11, 13));
  return n === 0 ? "12am" : n < 12 ? `${n}am` : n === 12 ? "12pm" : `${n - 12}pm`;
}
function clock(hhmm) {
  const [H, M] = hhmm.split(":").map(Number);
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return `${h12}${M ? ":" + String(M).padStart(2, "0") : ""}${H < 12 ? "am" : "pm"}`;
}
const r0 = (x) => (x == null ? "?" : Math.round(x));

function hourLine(h) {
  const p = probabilityInRange(h, 12).probability;
  const parts = [`${hourText(h)} ${h.direction_label ?? ""} ${r0(h.speed_kt)}${h.gust_kt != null ? "g" + r0(h.gust_kt) : ""} ${p}%`];
  if (h.regime) parts.push(h.regime);
  if (h.mos_used) parts.push("learned");
  if (h.mos?.flow && h.mos?.station_kt != null) parts.push(`${h.mos.station} ${r0(h.mos.station_kt)} ${h.mos.flow}${h.mos.works ? " works" : ""}`);
  if (h.swell?.label && h.swell.label !== "flat") parts.push(`${h.swell.label} ${h.swell.hs_ft}ft`);
  if (h.tide?.level_ft != null) parts.push(`tide ${h.tide.level_ft}${h.tide.trend === "rising" ? "r" : h.tide.trend === "falling" ? "f" : ""}`);
  if (h.outflow_not_ridden) parts.push("OUTFLOW NOT RIDDEN");
  else if (h.favorable_direction === false) parts.push("OFF DIR");
  return parts.join(", ");
}

export function buildGuruLive(forecast, spotConfigs, now = new Date()) {
  const days = [pacificDate(now, 0), pacificDate(now, 1), pacificDate(now, 2)];
  // Today and tomorrow hourly through the riding day, the third day every 3 hours.
  // Riding hours only (first light to last light, rules.js isDaylightHour).
  const wanted = (h, spot) => {
    const d = h.time.slice(0, 10), n = Number(h.time.slice(11, 13));
    if (spot.lat != null && !isDaylightHour(h.time, spot.lat, spot.lon)) return false;
    if (d === days[0] || d === days[1]) return true;
    if (d === days[2]) return n >= 9 && n <= 18 && n % 3 === 0;
    return false;
  };
  const out = [];
  out.push(`Forecast run: ${forecast.generated_at_label} (the page refreshes this a few times a day).`);
  out.push(LEGEND);
  out.push("Riding light (first light to last light, Vancouver): " + days.map((d) => { const w = daylightWindow(d, 49.28, -123.12); return `${dayLabel(d)} ${w.firstLabel} to ${w.lastLabel}`; }).join("; ") + ". Hours outside that are dark and not listed; never suggest riding then.");

  const takes = forecast.daily_takes || {};
  for (const d of days.slice(0, 2)) {
    if (takes[d]?.text) out.push(`\nGuillermo's own take for ${dayLabel(d)} (his read, quote it as his, not yours): ${takes[d].text}`);
  }

  const mb = forecast.marine_bulletins || {};
  for (const b of Object.values(mb)) {
    if (b?.text) out.push(`\nEC marine forecast, ${b.label} (issued ${b.issued})${b.warning ? ", WARNING IN EFFECT" : ""}: ${b.text}`);
  }

  const pts = forecast.mos_score?.points || {};
  const track = [];
  for (const sc of spotConfigs) {
    const l = sc.mos?.point ? pts[sc.mos.point]?.learned : null;
    if (l?.n) track.push(`${sc.name} (scored at ${pts[sc.mos.point].station}): typical miss ${l.mae_kt}kt, caught ${Math.round(l.caught * 100)}% of windy hours, ${Math.round(l.false_alarms * 100)}% false alarms`);
  }
  if (track.length) out.push(`\nTrack record, last ${forecast.mos_score.window_days} days: ${track.join("; ")}. Other spots are not measured yet.`);

  for (const spot of forecast.spots || []) {
    const sc = spotConfigs.find((s) => s.id === spot.id) || {};
    out.push(`\n## ${spot.name}${sc.neverRecommend ? " (NEVER RECOMMEND)" : ""}`);
    const tides = (spot.tide_extremes || []).filter((t) => days.includes(t.date));
    if (tides.length) out.push(`Tides (${spot.tide_station}): ${tides.map((t) => `${t.date === days[0] ? "" : dayLabel(t.date).split(",")[0] + " "}${t.type} ${clock(t.time)} ${t.height_ft}ft`).join(", ")}`);
    for (const w of spot.epic_windows || []) out.push(`Possible epic window: ${w.start} to ${w.end}, up to ${w.peak_kt}kt`);
    let cur = null;
    for (const h of (spot.hours || []).filter((h) => wanted(h, spot))) {
      const d = h.time.slice(0, 10);
      if (d !== cur) { cur = d; out.push(`${dayLabel(d)}:`); }
      out.push(hourLine(h));
    }
  }
  return { generated_at: forecast.generated_at, days, text: out.join("\n") };
}
