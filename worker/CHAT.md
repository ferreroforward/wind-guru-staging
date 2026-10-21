# Wind Guru AI chat Worker (worker/chat.js)

A separate Cloudflare Worker from the report relay. It answers questions from the chat panel on the page with Claude, using:

- `data/guru-knowledge.md`: the knowledge Guillermo approves (spot rules, Squamish checklist, forecast habits, how to read the page).
- `data/guru-live.json`: a small forecast snapshot written by every forecast run (`scripts/guru-live.mjs`).
- Environment Canada past 24 hour readings for Pam Rocks, Squamish Airport, Pemberton, Point Atkinson, English Bay buoy, Sand Heads, Ferry Terminal and Vancouver Airport, fetched by the Worker and kept 10 minutes in KV.

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
