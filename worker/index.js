// Wind Guru — report relay Worker.
//
// Turns a same-origin POST from the report popup in index.html into a
// GitHub issue on ferreroforward/wind-guru, labeled "wind-report" so
// scripts/apply-feedback.mjs picks it up exactly like a manually-filed
// issue-form report. This exists because GitHub Pages is a static site
// with no server of its own — this Worker is the one small piece of
// always-on infrastructure that lets a visitor submit a report with two
// numbers and no GitHub account, instead of being redirected to GitHub's
// issue form. See README.md next to this file for how to deploy it.

const OWNER = "ferreroforward";
const REPO = "wind-guru-staging";

// Keep this in sync with the `spot` dropdown in
// .github/ISSUE_TEMPLATE/wind-report.yml and the spot ids in
// assets/spots.js — update all three if you add or rename a spot.
const VALID_SPOTS = [
  "squamish-spit", "porteau-cove", "jericho-spanish-banks", "garry-point",
  "boundary-bay", "white-rock-east", "crescent-beach", "tsawwassen-south",
  "erwin-park", "dundarave-pier", "ambleside",
];

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "https://ferreroforward.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function isNum(v, min, max) {
  return typeof v === "number" && isFinite(v) && v >= min && v <= max;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "POST only" }, 405, env);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400, env);
    }

    const { spot, date, time, forecast_speed, actual_speed, actual_gust } = data || {};

    // --- Validation. Every field here is untrusted, public-internet input
    // — this is the one place standing between an anonymous POST and a
    // real issue getting filed on the repo, so it's deliberately strict
    // rather than trying to be forgiving. ---
    if (!VALID_SPOTS.includes(spot)) {
      return jsonResponse({ error: "Unknown spot" }, 400, env);
    }
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResponse({ error: "Invalid date" }, 400, env);
    }
    if (time != null && time !== "" && !/^\d{2}:\d{2}$/.test(time)) {
      return jsonResponse({ error: "Invalid time" }, 400, env);
    }
    if (!isNum(actual_speed, 0, 80)) {
      return jsonResponse({ error: "actual_speed must be a number 0-80" }, 400, env);
    }
    if (actual_gust != null && !isNum(actual_gust, 0, 90)) {
      return jsonResponse({ error: "actual_gust must be a number 0-90" }, 400, env);
    }
    // Loose sanity window (30 days back, 1 day forward) so this can't be
    // used to backdate/postdate junk far outside anything the calibration
    // pipeline (scripts/apply-feedback.mjs) would treat as a real report.
    const reportDate = new Date(`${date}T00:00:00Z`);
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;
    const ONE_DAY_MS = 24 * 3600 * 1000;
    if (!isFinite(reportDate.getTime()) || reportDate.getTime() < now - THIRTY_DAYS_MS || reportDate.getTime() > now + ONE_DAY_MS) {
      return jsonResponse({ error: "Date out of range" }, 400, env);
    }

    const forecastText = forecast_speed !== "" && forecast_speed != null && isFinite(Number(forecast_speed))
      ? String(Number(forecast_speed))
      : "_No response_";

    // Body format mirrors exactly what GitHub renders from
    // .github/ISSUE_TEMPLATE/wind-report.yml ("### Label\n\nvalue\n\n") so
    // scripts/apply-feedback.mjs's extractField() parses issues from this
    // Worker and issues filed by hand through the GitHub form identically.
    const body = [
      "### Spot", "", spot, "",
      "### Date", "", date, "",
      "### Time (approx, local)", "", time || "_No response_", "",
      "### Forecasted speed (kt)", "", forecastText, "",
      "### Actual speed (kt)", "", String(actual_speed), "",
      "### Actual gust (kt)", "", actual_gust != null ? String(actual_gust) : "_No response_", "",
      "### Notes — any idea why it differed?", "", "Submitted via the in-page report popup.", "",
    ].join("\n");

    const title = `Wind report: ${spot} ${date}${time ? " " + time : ""}`;

    const ghRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/issues`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        // GitHub's API requires a User-Agent on every request.
        "User-Agent": "wind-guru-report-worker",
      },
      body: JSON.stringify({ title, body, labels: ["wind-report"] }),
    });

    if (!ghRes.ok) {
      const errText = await ghRes.text().catch(() => "");
      console.log("GitHub issue creation failed:", ghRes.status, errText);
      return jsonResponse({ error: "Could not file report" }, 502, env);
    }

    const issue = await ghRes.json();
    return jsonResponse({ ok: true, issue_number: issue.number }, 200, env);
  },
};
