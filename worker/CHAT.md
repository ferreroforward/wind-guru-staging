# Wind Guru AI chat Worker (worker/chat.js)

A separate Cloudflare Worker from the report relay. It answers questions from the chat panel on the page with Claude, using:

- `data/guru-knowledge.md`: the knowledge Guillermo approves (spot rules, Squamish checklist, forecast habits, how to read the page).
- `data/guru-live.json`: a small forecast snapshot written by every forecast run (`scripts/guru-live.mjs`).
- Environment Canada past 24 hour readings for Pam Rocks, Squamish Airport, Pemberton, Point Atkinson, English Bay buoy, Halibut Bank buoy, Sand Heads, Ferry Terminal and Vancouver Airport, plus the Jericho Sailing Centre beach station and the Squamish terminal sensor (Kiteloop), fetched by the Worker and kept 10 minutes in KV.

The browser never sees the API key or calls Anthropic directly.

## Setup in Cloudflare (dashboard, no command line)

1. Workers & Pages > Create > Create Worker. Name it `wind-guru-chat-staging` (production later: `wind-guru-chat`). Deploy the hello world, then Edit code, paste all of `worker/chat.js`, Deploy.
2. Storage & Databases > KV > Create a namespace called `wind-guru-chat-staging`.
3. In the Worker: Settings > Bindings > Add > KV namespace. Variable name `CHAT_KV`, pick the namespace. Save.
4. In the Worker: Settings > Variables and Secrets > Add > Type **Secret**, name `ANTHROPIC_API_KEY`, paste the key there (never in chat, never in the repo). Save and deploy.

Optional plain variables (same screen, type Text) to change the defaults in the code: `MODEL` (claude-sonnet-5-5), `MONTHLY_BUDGET_USD` (10), `DAILY_LIMIT` (10 per visitor), `DAILY_GLOBAL_LIMIT` (300), `SITE_URL`.

## Setup at Anthropic

1. platform.claude.com > Workspaces > create a workspace called `Wind Guru`.
2. In that workspace: Spend limits > set the monthly limit (suggested 15 USD, a little above the Worker's own 10 USD stop).
3. Create an API key inside that workspace, copy it straight into the Cloudflare secret above.

When the Anthropic limit is reached, every call fails until the 1st of next month and the chat says it is resting. The Worker also stops by itself at `MONTHLY_BUDGET_USD`, counted from the token use Anthropic reports.

## Guardrails

- 10 questions per visitor per Pacific day (visitor = a hash of the IP address, nothing stored in plain text, kept 2 days).
- 300 questions a day for everyone together.
- Questions up to 500 characters, the last 6 turns of the conversation only.
- Only answers wind, weather, tides, spots and the site; never says a spot is safe; never recommends Steveston or Squamish on an outflow.
- Requests are only accepted from ferreroforward.github.io.
- Questions and answers are kept in KV for 90 days with a random conversation id from the page (no IP address, no name), and so is any feedback (thumbs up or down, comment). The notice and the disclaimer say so.

## Feedback page

Add a second secret on the worker: `ADMIN_PASSWORD` (Settings > Variables and Secrets > Add > Secret). Then open `https://<worker>.guillermo-ferrero.workers.dev/admin`; the browser asks for a user name (anything) and that password. It lists the latest questions, newest first, with the answers, the ratings, comments and any conditions report the AI proposed. "Only with feedback" shows the ones with a rating or a comment.

## Conditions reports from the chat

When a rider says the forecast was wrong, the AI asks for spot, time and wind, then proposes a report (tool propose_conditions_report). The page shows it as a card; only if the rider taps Send does it go to the report Worker, exactly like "Report actual conditions".

## Latest station readings for the page (GET /obs)

`GET /obs` returns the newest reading from each station above (direction, knots, gust, time), from the same 10 minute KV cache the chat uses. No AI call, no cost. The page calls it when it opens, every 10 minutes while the tab is visible, and on Refresh live, so the station board is never more than about 10 minutes old instead of waiting for the next forecast run.

## Email alerts (Oct 2026)

Riders sign up on the page with an email, an invite code and up to 6 alerts. The sign up card only shows when the page is opened with `#alerts` at the end of the link. A confirm email turns them on. A cron trigger checks every 10 minutes and sends at most one email per alert per day, only in daylight (the forecast heads up goes around 7pm). Every email has a link to stop all alerts.

The alerts:
- A station reaches a wind speed: average wind, held for two readings in a row on stations that update more than once an hour (Jericho beach, Squamish terminal, Ferry Terminal, Point Atkinson, Squamish Airport). Hourly stations (Pam Rocks, Sand Heads, Vancouver Airport, the buoys) use one reading, which is already a 10 minute average. Optional direction: from the north (outflow) or from the south (inflow).
- Porteau outflow: Pam Rocks 22kt or more from the north.
- Squamish go signal, checked 10:30am to 1:30pm: Pam Rocks outflow fading (or already southerly), Pemberton minus Vancouver pressure under 3 hPa or down 2 hPa in 2 hours, Squamish Airport 2°C or more warmer than Pam Rocks.
- Evening heads up: tomorrow's odds at a spot are at or above the rider's pick for their wind range, read from `data/alerts-forecast.json` (written by every forecast run).

Readings for Pam Rocks, Squamish Airport, Pemberton, Point Atkinson, Sand Heads, Ferry Terminal and Vancouver Airport now also come from EC's SWOB files, which post within about a minute of the reading; the station board on the page uses them too.

Setup:
1. Resend (resend.com): create a free account, Domains > Add domain `alerts.ferreroforward.ca`. Resend lists a few DNS records.
2. Namecheap: Domain List > ferreroforward.ca > Advanced DNS > add each record exactly as Resend shows it (they are all on the alerts subdomain, so the Microsoft 365 email records are not touched). Back in Resend, Verify.
3. Resend: API Keys > Create, permission "Sending access", domain alerts.ferreroforward.ca. Copy it straight into Cloudflare, never into chat.
4. Cloudflare, on the chat Worker (staging first, then production): Settings > Variables and Secrets > add Secret `RESEND_API_KEY` (the key) and Secret `ALERT_INVITE` (any invite code you choose to give friends).
5. Cloudflare, same Worker: Settings > Trigger Events (or Triggers) > Add > Cron Triggers > `*/10 * * * *`.
6. Share the link with `#alerts` at the end, plus the invite code.

Optional text variables: `ALERT_FROM` (default `Wind Guru alerts <alerts@alerts.ferreroforward.ca>`) and `ALERT_SENDER_INFO` (the footer line). Before opening alerts to the public, the footer should include a mailing address (Canada's anti spam law).
