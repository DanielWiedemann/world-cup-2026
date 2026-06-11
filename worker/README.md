# World Cup 2026 — Push Notification Worker

A Cloudflare Worker that polls ESPN once a minute, diffs the match state
against KV, and fans out Web Push notifications to every subscriber for:

- **Kickoff** — match transitions `pre → in`
- **Goal** — score change while `state === in`
- **Final whistle** — match transitions `in → post`

Subscriptions live in the same KV namespace.

```
worker/
├── wrangler.toml          # Cloudflare config (KV id, cron, vars)
├── src/index.js           # the Worker
├── generate-vapid.mjs     # one-shot keypair generator
└── .dev.vars.example      # template for local secrets
```

## First-time deploy

Run these from this `worker/` folder. You only do this once per Cloudflare
account.

```bash
# 1. Log in to Cloudflare (opens a browser).
npx wrangler login

# 2. Create the KV namespace and copy the returned id into wrangler.toml
#    (replace REPLACE_WITH_KV_ID with the printed id).
npx wrangler kv namespace create STATE

# 3. Store the VAPID private key as a Worker secret (paste when prompted).
npx wrangler secret put VAPID_PRIVATE_KEY

# 4. Update VAPID_SUBJECT in wrangler.toml to a real mailto: you own
#    (push services contact you here on errors).

# 5. Deploy.
npx wrangler deploy
```

After step 5, wrangler prints the Worker's URL — something like
`https://world-cup-2026-push.<your-acct>.workers.dev`.

Copy that URL and paste it into the PWA:

- Open `../app.js`
- Set `const PUSH_API = "https://world-cup-2026-push.<your-acct>.workers.dev"`
- Commit + push — GitHub Pages redeploys automatically and the bell button
  appears in the header.

## Day-to-day

```bash
npx wrangler tail               # live tail logs of cron + http
npx wrangler deploy             # ship code changes
npx wrangler kv key list --namespace-id <id>   # peek at stored state
```

## Local dev

```bash
cp .dev.vars.example .dev.vars  # then paste your VAPID_PRIVATE_KEY into it
npx wrangler dev                # http://localhost:8787
```

Hit `POST /subscribe`, `POST /unsubscribe`, `GET /health` with curl while
testing.

## Generating new VAPID keys

```bash
node generate-vapid.mjs
```

If you rotate keys, update **both** sides:

- `VAPID_PUBLIC_KEY` in `wrangler.toml` (and in `../app.js`)
- The private key via `npx wrangler secret put VAPID_PRIVATE_KEY`

Existing subscriptions break on rotation — users must re-subscribe.

## Cost

Free tier easily covers personal use:

- Workers: 100k requests/day free; cron counts as 1 request/min = ~1.5k/day.
- KV: 100k reads, 1k writes/day free.
- Push services (Google FCM, Mozilla autopush, Apple APNs): free.
