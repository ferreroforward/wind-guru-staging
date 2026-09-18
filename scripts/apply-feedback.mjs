#!/usr/bin/env node
// Wind Guru — feedback-to-calibration pipeline.
// Pools two sources of "forecasted vs actual" data points per spot:
//   1. User-submitted "wind-report" GitHub issues.
//   2. data/live-verification-log.json — automatic mismatches (20%+ error)
//      between the forecast and the nearest EC station's live observation,
//      logged by generate.mjs each run (see "Live verification" in README).
// Computes a per-spot bias multiplier from the combined pool and writes
// data/calibration-overrides.json. generate.mjs reads that file and applies
// the multiplier on top of its normal calibration for any spot with enough
// data points. Run before generate.mjs (see .github/workflows/update-forecast.yml),
// or manually: `node scripts/apply-feedback.mjs`.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "calibration-overrides.json");
const LIVE_LOG_PATH = path.join(__dirname, "..", "data", "live-verification-log.json");

// Edit these if the repo ever moves.
const OWNER = "ferreroforward";
const REPO = "wind-guru-staging";

const MIN_SAMPLES = 2; // don't adjust a spot on a single report
const MAX_REPORTS_PER_SPOT = 20; // weight toward recent reports
const MULTIPLIER_CLAMP = [0.75, 1.5]; // never let one bad/joke report send this wild
// Automated live-station checks now run 2-3x/day/spot (see generate.mjs H4)
// and log EVERY comparison, not just mismatches — within the 20-sample
// recency window that would drown out human rider reports within about a
// week, even though a rider's own eyes-on-the-water report is a stronger
// signal than an automated station comparison (which can itself be skewed
// by the station's own exposure/siting). Weight rider reports higher so
// they don't get silently outvoted by volume.
const RIDER_REPORT_WEIGHT = 3;
const LIVE_STATION_WEIGHT = 1;
// Loose sanity bounds on rider-submitted numbers — this app's forecast
// range tops out well under these, so anything past them is almost
// certainly a typo (e.g. "actual: 300") rather than a real BC coastal
// wind reading.
const MAX_PLAUSIBLE_KT = 80;
const RATIO_SANITY_RANGE = [0.05, 20];

// "Forecast accuracy" badge shown on the page (index.html reads this from
// forecast.calibration_overrides.accuracy, passed through unchanged by
// generate.mjs). Deliberately rider-reports only, sitewide, not mixed with
// the automated live-station comparisons above — the badge is answering
// "how accurate are we according to riders who were actually there," not
// the broader (and much more numerous) automated-check pool. A flat +/-
// tolerance rather than a ratio: two equal-and-opposite misses would
// average out to looking "accurate" under a ratio-based measure even
// though every single report missed, which is exactly the kind of number
// that would have hidden the 12-20 vs 18-28 bug that prompted this feature.
const ACCURACY_TOLERANCE_KT = 3;
const MIN_SAMPLES_FOR_ACCURACY = 10;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractField(body, exactLabel) {
  // GitHub issue-form bodies render each field as "### Label\n\nvalue\n\n".
  // Fields left blank render as "_No response_". Match on the exact,
  // short label text used in wind-report.yml (see there) — escaped so any
  // regex-special characters in the label (parentheses, etc.) are literal.
  const re = new RegExp(`###\\s*${escapeRegex(exactLabel)}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`, "i");
  const m = body.match(re);
  if (!m) return null;
  const val = m[1].trim();
  return (!val || /^_no response_$/i.test(val)) ? null : val;
}

async function fetchReports() {
  const headers = { "User-Agent": "wind-guru-agent/1.0", "Accept": "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;

  // state=open (was state=all): closing a bogus/joke report used to be the
  // only way to flag it as not-usable, but the calibration pipeline read
  // every issue regardless of state — so closing one did nothing to remove
  // it from the pool. Now closing an issue is how you retire it from
  // calibration; combined with the sanity bounds below (which catch garbage
  // values automatically) that gives two independent ways to keep bad data
  // out.
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/issues?labels=wind-report&state=open&per_page=100`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`GitHub API fetch failed: ${res.status} ${res.statusText}`);
    return [];
  }
  const issues = await res.json();
  return issues.filter((i) => !i.pull_request); // issues endpoint also returns PRs
}

async function loadLiveVerifications() {
  try {
    const raw = await readFile(LIVE_LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function sourceWeight(source) { return source === "rider-report" ? RIDER_REPORT_WEIGHT : LIVE_STATION_WEIGHT; }

// Weighted geometric mean of a set of forecasted/actual ratios. Geometric
// (not arithmetic) mean, because ratios are multiplicative — two equal-and-
// opposite misses (e.g. one hour at 0.5x, one at 2x) should cancel out to a
// "no adjustment needed" 1.0x, but an arithmetic mean of the same two points
// gives 1.25x, a real upward bias baked in from nothing but symmetric noise.
// Weighted by source (see RIDER_REPORT_WEIGHT/LIVE_STATION_WEIGHT) so the
// now-much-more-numerous automated live-station points don't drown out
// human rider reports. Each ratio is clamped into a sane range before
// logging so one wild data point can't blow up the log-sum.
function weightedGeometricMean(points) {
  let weightedLogSum = 0, totalWeight = 0;
  for (const p of points) {
    const clamped = Math.min(RATIO_SANITY_RANGE[1], Math.max(RATIO_SANITY_RANGE[0], p.ratio));
    const w = sourceWeight(p.source);
    weightedLogSum += w * Math.log(clamped);
    totalWeight += w;
  }
  return totalWeight ? Math.exp(weightedLogSum / totalWeight) : 1;
}

// Turns a pool of { ratio, source } data points into one override bucket
// (sample_size/rider_reports/live_checks/avg_ratio/multiplier/note), or null
// if there aren't enough points yet. Shared by the "general" (all-data,
// backward-compatible) bucket and the per-regime buckets below.
function summarize(recent, label) {
  if (recent.length < MIN_SAMPLES) return null;
  const avgRatio = weightedGeometricMean(recent);
  const multiplier = Math.max(MULTIPLIER_CLAMP[0], Math.min(MULTIPLIER_CLAMP[1], avgRatio));
  const riderCount = recent.filter((r) => r.source === "rider-report").length;
  const liveCount = recent.filter((r) => r.source === "live-station").length;
  return {
    sample_size: recent.length,
    rider_reports: riderCount,
    live_checks: liveCount,
    avg_ratio: Math.round(avgRatio * 100) / 100,
    multiplier: Math.round(multiplier * 100) / 100,
    note: `Based on ${recent.length} ${label} data point${recent.length === 1 ? "" : "s"} (${riderCount} rider report${riderCount === 1 ? "" : "s"}, ${liveCount} live-station check${liveCount === 1 ? "" : "s"}): actual wind averaged ${Math.round(avgRatio * 100)}% of what was forecasted (rider reports weighted ${RIDER_REPORT_WEIGHT}x a station check).`,
  };
}

async function main() {
  console.log(`Fetching wind-report issues from ${OWNER}/${REPO}...`);
  const issues = await fetchReports();
  console.log(`Found ${issues.length} labeled issue(s).`);

  const liveEntries = await loadLiveVerifications();
  console.log(`Found ${liveEntries.length} logged live-verification mismatch(es).`);

  // Rider reports don't capture which wind regime was in effect (the issue
  // form just asks forecasted-vs-actual), so they only ever feed the
  // spot-wide "general" bucket. Live-station entries DO carry a regime (set
  // by generate.mjs from the forecast hour they were checked against), so
  // they feed both "general" (keeping today's pooled-average behavior as a
  // fallback) and their own regime-specific bucket — a thermal-hour mismatch
  // shouldn't nudge an outflow multiplier for the same spot, and vice versa.
  const bySpotGeneral = {};
  const bySpotRegime = {};
  // Flat, sitewide, rider-reports-only pool for the "forecast accuracy"
  // badge — kept separate from bySpotGeneral, which mixes in the much more
  // numerous automated live-station checks and is bucketed per spot (see
  // ACCURACY_TOLERANCE_KT above for why this needs its own pool).
  const accuracyPoints = [];
  for (const issue of issues) {
    const body = issue.body || "";
    const spot = extractField(body, "Spot");
    const forecasted = parseFloat(extractField(body, "Forecasted speed (kt)"));
    const actual = parseFloat(extractField(body, "Actual speed (kt)"));
    // Gust isn't fed into calibration yet (the app currently fabricates
    // display gust as speed*1.3 rather than reading a real value — see
    // OPUS_REVIEW.md #33) — captured here so a season of real rider-
    // reported gusts is on hand once that's worth tackling.
    const gustRaw = extractField(body, "Actual gust (kt)");
    const gust = gustRaw != null ? parseFloat(gustRaw) : null;
    if (!spot || !isFinite(forecasted) || !isFinite(actual) || forecasted <= 0) {
      console.log(`  Skipping issue #${issue.number} — couldn't parse spot/forecasted/actual.`);
      continue;
    }
    // Sanity bounds: catch typos (e.g. "actual: 300") before they reach the
    // calibration pool rather than relying solely on the multiplier clamp
    // downstream, which would still let one bad point drag the ratio pool.
    const ratio = actual / forecasted;
    if (forecasted > MAX_PLAUSIBLE_KT || actual < 0 || actual > MAX_PLAUSIBLE_KT ||
        ratio < RATIO_SANITY_RANGE[0] || ratio > RATIO_SANITY_RANGE[1]) {
      console.log(`  Skipping issue #${issue.number} — forecasted=${forecasted}kt actual=${actual}kt is outside plausible bounds.`);
      continue;
    }
    (bySpotGeneral[spot] ||= []).push({ date: issue.created_at, forecasted, actual, ratio, source: "rider-report", gust: isFinite(gust) ? gust : null });
    accuracyPoints.push({ forecasted, actual });
  }
  for (const e of liveEntries) {
    if (!e.spot || !isFinite(e.forecasted) || !isFinite(e.actual) || e.forecasted <= 0) continue;
    const point = { date: e.checked_at || e.time, forecasted: e.forecasted, actual: e.actual, ratio: e.ratio ?? (e.actual / e.forecasted), source: "live-station" };
    (bySpotGeneral[e.spot] ||= []).push(point);
    if (e.regime) {
      const key = `${e.spot}::${e.regime}`;
      (bySpotRegime[key] ||= []).push(point);
    }
  }

  const recentOf = (list) => list.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, MAX_REPORTS_PER_SPOT);

  const overrides = {};
  for (const [spot, reports] of Object.entries(bySpotGeneral)) {
    const recent = recentOf(reports);
    const general = summarize(recent, "total");
    if (!general) {
      console.log(`  ${spot}: only ${recent.length} data point(s), below minimum of ${MIN_SAMPLES} — no adjustment.`);
      continue;
    }
    overrides[spot] = { general };
    console.log(`  ${spot} [general]: ${general.sample_size} data points, avg ratio ${general.avg_ratio}, multiplier ${general.multiplier}`);
  }
  for (const [key, reports] of Object.entries(bySpotRegime)) {
    const [spot, regime] = key.split("::");
    const recent = recentOf(reports);
    const bucket = summarize(recent, regime);
    if (!bucket) continue; // not enough regime-specific data yet — the "general" bucket still applies as a fallback
    overrides[spot] ||= {};
    overrides[spot][regime] = bucket;
    console.log(`  ${spot} [${regime}]: ${bucket.sample_size} data points, avg ratio ${bucket.avg_ratio}, multiplier ${bucket.multiplier}`);
  }

  // "Forecast accuracy" badge — null (hidden on the page) until there are
  // at least MIN_SAMPLES_FOR_ACCURACY rider reports, so a shaky 2-report
  // stat never gets published. generate.mjs copies this whole file through
  // unchanged into forecast.calibration_overrides, so index.html reads it
  // as forecast.calibration_overrides.accuracy.
  let accuracy = null;
  if (accuracyPoints.length >= MIN_SAMPLES_FOR_ACCURACY) {
    const hits = accuracyPoints.filter((p) => Math.abs(p.actual - p.forecasted) <= ACCURACY_TOLERANCE_KT).length;
    accuracy = {
      tolerance_kt: ACCURACY_TOLERANCE_KT,
      sample_size: accuracyPoints.length,
      hit_rate: Math.round((hits / accuracyPoints.length) * 100) / 100,
    };
    console.log(`\nAccuracy: ${Math.round(accuracy.hit_rate * 100)}% of ${accuracy.sample_size} rider reports within ${ACCURACY_TOLERANCE_KT}kt of forecast.`);
  } else {
    console.log(`\nAccuracy badge: ${accuracyPoints.length}/${MIN_SAMPLES_FOR_ACCURACY} rider reports so far — not shown yet.`);
  }

  const out = {
    generated_at: new Date().toISOString(),
    min_samples: MIN_SAMPLES,
    spots: overrides,
    accuracy,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT_PATH} (${Object.keys(overrides).length} spot(s) adjusted)`);
}

main().catch((err) => {
  console.error(err);
  // Don't fail the whole workflow if feedback processing breaks — the
  // forecast should still generate with whatever overrides existed before.
  process.exit(0);
});
