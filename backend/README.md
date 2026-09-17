# Hela Sasa — HashBack M-PESA STK Push Backend

Minimal Express (Node 18+) backend that sends M-PESA STK Push prompts via
HashBack (HashPay) and confirms payments through signed webhooks.

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/api/stk/initiate` | Body `{ amount, msisdn, reference }` → sends the STK push, returns `{ success, checkout_id, reference }` |
| `GET`  | `/api/stk/status/:reference` | Order status for polling: `pending`, `success`, `failed`, `amount_mismatch` |
| `POST` | `/api/webhook/hashpay` | HashPay webhook, verified with `X-Hashpay-Signature` (HMAC-SHA256 of the raw body) |

## Local setup

```bash
cd backend
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
# …fill in your real HashBack credentials in .env
npm run dev                 # → http://localhost:3999
```

Get the API key, account ID and webhook secret from your HashPay dashboard.
Never commit the `.env` file — only `.env.example` belongs in git.

## Frontend wiring

`helasasa.com/personal-details.html` calls `http://localhost:3999` by default.
In production, set `window.MPESA_API_BASE = 'https://<your-backend-url>'`
before that script runs (or change the `MPESA_API_BASE` fallback in the page)
to point at your deployed backend.

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
