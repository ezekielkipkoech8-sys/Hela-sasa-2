# Hela Sasa — HashBack M-PESA STK Push Backend

Minimal Express (Node 18+) backend that sends M-PESA STK Push prompts via
HashBack (HashPay) and confirms payments through signed webhooks.

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/api/stk/initiate` | Body `{ amount, msisdn, reference }` → sends the STK push, returns `{ success, checkout_id, reference }` |
| `GET`  | `/api/stk/status/:reference` | Order status for polling: `pending`, `success`, `failed`, `amount_mismatch` |
| `POST` | `/api/webhook/hashpay` | HashPay webhook, verified with `X-Hashpay-Signature` (HMAC-SHA256 of the raw body) |

## Layout

| Path | Purpose |
| ---- | ------- |
| `server.js` | **The deployed entrypoint** — `vercel.json` builds this file. |
| `helasasa.com/` | The scraped frontend (landing page, `personal-details.html`). |
| `public/` | The static STK push pages (`express-stk.html`, …). |
| `backend/` | An older duplicate of `server.js` kept for reference — not deployed (see `.vercelignore`). |

`server.js` serves `helasasa.com/` and `public/` itself, so the whole flow runs
from a single origin with no CORS or second host to configure.

## Local setup

```bash
npm install
copy .env.example .env        # Windows PowerShell
# …fill in your real HashBack credentials in .env
npm start                     # → http://localhost:3000
```

Get the API key, account ID and webhook secret from your HashPay dashboard.
Never commit the `.env` file — only `.env.example` belongs in git.

`server.js` loads `.env` **by absolute path** (repository root first, then
`backend/`), so the credentials are found no matter which directory you launch
`node` from. This matters: a bare `dotenv.config()` reads only `process.cwd()`,
which silently loaded nothing and sent every STK push with `api_key: undefined` —
HashBack rejected it and no M-PESA prompt ever reached the phone, while the
server still answered `200` so nothing looked broken.

If the credentials are missing, the server warns at boot and
`/api/stk/initiate` returns `503` instead of calling HashBack with blanks.

## Frontend wiring

`public/express-stk.html` calls the API with `API_BASE = ''` — same origin, so
no configuration is needed when the pages are served by this same `server.js`.
To point it at a separately hosted backend, set `API_BASE` to that origin.

## Deploying & pointing the webhook at this service

1. Deploy the `backend/` folder (a `vercel.json` for `@vercel/node` is
   included). On Vercel, set `HASHBACK_API_KEY`, `HASHBACK_ACCOUNT_ID`,
   `HASHBACK_WEBHOOK_SECRET` as project environment variables — `PORT` is
   provided automatically.
2. In the **HashPay dashboard**, set the webhook URL to:

   ```
   https://<your-deployment>/api/webhook/hashpay
   ```

   Make sure the webhook secret shown in the dashboard matches
   `HASHBACK_WEBHOOK_SECRET` in your environment — webhook requests are
   rejected with `401` otherwise.
3. For local webhook testing, use a tunnel (e.g. `ngrok http 3000`) and point
   the dashboard at `https://<tunnel>/api/webhook/hashpay`.

## ⚠️ Before going live

Orders live in an **in-memory Map** in `server.js`, which does **not** survive
across Vercel's stateless serverless instances. Swap it for Vercel KV (Upstash
Redis) or a database so `initiate` and the webhook share state reliably.
