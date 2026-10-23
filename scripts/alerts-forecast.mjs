// Small forecast file for the email alerts (worker/chat.js, Oct 2026):
// data/alerts-forecast.json. For each spot and each light hour of today and
// tomorrow: speed, gust, direction, whether the hour is rideable here
// (direction works, not a Squamish outflow) and the page's odds for each
// quick pick (8, 12, 18, 25 knots and up). The worker reads it once each
// evening for the "forecast heads up" alert, so it never has to parse the
// full forecast.json.
import { probabilityInRange, isDaylightHour } from "../assets/rules.js";

const PICKS = [8, 12, 18, 25];

function pacificDate(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export function buildAlertsForecast(forecast, spotConfigs, now = new Date()) {
  const today = pacificDate(now);
  const tomorrow = pacificDate(new Date(now.getTime() + 86400000));
  const days = [today, tomorrow];
  const spots = {};
  for (const s of forecast.spots || []) {
    const cfg = spotConfigs.find((c) => c.id === s.id) || {};
    const byDay = {};
    for (const h of s.hours || []) {
      const date = h.time.slice(0, 10);
      if (!days.includes(date)) continue;
      if (cfg.lat != null && !isDaylightHour(h.time, cfg.lat, cfg.lon)) continue;
      const ok = h.favorable_direction !== false && !h.outflow_not_ridden;
      const odds = {};
      for (const lo of PICKS) odds[lo] = ok ? Math.round(probabilityInRange(h, lo).probability) : 0;
      (byDay[date] ||= []).push({
        t: h.time.slice(11, 16),
        kt: h.speed_kt != null ? Math.round(h.speed_kt) : null,
        g: h.gust_kt != null ? Math.round(h.gust_kt) : null,
        dir: h.direction_label || null,
        ok,
        odds,
      });
    }
    spots[s.id] = { name: s.name, days: byDay };
  }
  return { generated_at: forecast.generated_at, generated_at_label: forecast.generated_at_label, days, spots };
}
