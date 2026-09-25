/**
 * Hela Sasa — HashBack (HashPay) M-PESA STK Push backend
 * ======================================================
 * Express server exposing three routes:
 *
 *   POST /api/stk/initiate          → ask HashBack to send an STK push
 *   GET  /api/stk/status/:reference → order status (polled by the frontend)
 *   POST /api/webhook/hashpay       → signed HashPay webhook (payment results)
 *
 * ⚠️  STATE — READ BEFORE DEPLOYING
 * Orders live in Vercel KV (Upstash) when KV_REST_API_URL / KV_REST_API_TOKEN
 * are set, and in an in-memory Map otherwise. The Map does NOT survive Vercel's
 * stateless instances, so on a serverless deployment the webhook can land on an
 * instance that never saw the original initiate call and every status poll then
 * returns "unknown" — the applicant waits on "pending" forever even though the
 * money arrived. Attach a KV store in the Vercel dashboard (Storage → Create
 * Database → KV) and those two variables are injected automatically; nothing
 * else in this file needs to change.
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

// Same reasoning as the root server.js: dotenv must be pointed at an absolute
// path, otherwise it silently finds nothing depending on where `node` was run
// from. `.env` next to this file wins, then the repository-root copy.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const HASHBACK_INITIATE_URL = 'https://api.hashback.co.ke/initiatestk';
const MSISDN_PATTERN = /^254[71]\d{8}$/; // 254 + 7XXXXXXXX / 1XXXXXXXX (12 digits)

/**
 * Order store — Vercel KV (Upstash REST) backed, with an in-memory fallback.
 * Mirrors the root server.js implementation; see that file for the full
 * rationale.
 *
 * Shape: {
 *   reference: string,
 *   amount: number,
 *   msisdn: string,
 *   status: 'pending' | 'success' | 'failed' | 'amount_mismatch',
 *   checkout_id: string | null,
 *   receipt: string | null,
 *   createdAt: number
 * }
 */
const orders = new Map();
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const orderKey = (ref) => 'order:' + ref;

/** Issue one command against the Upstash-compatible REST API. */
async function kv(command, ...args) {
  const res = await fetch(`${KV_URL}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${command} -> HTTP ${res.status}`);
  return res.json();
}

/** Read an order, or null. Falls back to the in-memory Map if KV is off/erroring. */
async function readOrder(ref) {
  if (KV_URL && KV_TOKEN) {
    try {
      const data = await kv('GET', orderKey(ref));
      return data && data.result ? JSON.parse(data.result) : null;
    } catch (err) {
      console.error('[orders] KV read failed for "' + ref + '", falling back to memory:', err.message);
    }
  }
  return orders.get(String(ref)) || null;
}

/** Insert or replace an order. */
async function writeOrder(ref, order) {
  orders.set(String(ref), order);
  if (KV_URL && KV_TOKEN) {
    try {
      await kv('SET', orderKey(ref), JSON.stringify(order));
    } catch (err) {
      console.error('[orders] KV write failed for "' + ref + '":', err.message);
    }
  }
  return order;
}

/** Merge `changes` into an existing order. Returns null when the order is unknown. */
async function patchOrder(ref, changes) {
  const current = await readOrder(ref);
  if (!current) return null;
  return writeOrder(ref, Object.assign({}, current, changes));
}

const app = express();

// ── STATIC PAGES ────────────────────────────────────────────────────────────
// Serves backend/public — includes the static M-PESA STK Push payment page.
app.use(express.static(path.join(__dirname, 'public')));
// Also serve the frontend folder (index-2.html, personal-details.html) so the
// whole flow can be tested from one local origin, e.g. /index-2.html.
app.use(express.static(path.join(__dirname, '..', 'helasasa.com')));

// The legacy URL keeps working: it now serves the static HTML page instead of PHP.
app.get('/stk/express-stk.php', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'express-stk.html'));
});

app.get('/display.php', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/loan-request.php', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'loan-request.html'));
});

app.get('/final-step.php', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'final-step.html'));
});

app.get('/personal-details.php', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'helasasa.com', 'personal-details.html'));
});

// ── CORS ────────────────────────────────────────────────────────────────────
// The static frontend (helasasa.com) lives on a different origin/port than
// this API during development, so allow simple cross-origin fetches.
app.use(function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hashpay-Signature');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── ROUTES ──────────────────────────────────────────────────────────────────

// 1) HashPay webhook. It must read the body as RAW bytes so the HMAC
//    signature can be verified byte-for-byte, so it gets express.raw() for
//    this route only and is registered BEFORE the global express.json()
//    parser below.
app.post('/api/webhook/hashpay', express.raw({ type: 'application/json' }), handleHashpayWebhook);

// JSON body parsing for the remaining API routes.
app.use(express.json());

// 2) Frontend asks us to fire an STK push.
app.post('/api/stk/initiate', initiateStkPush);

// 3) Frontend polls the order status.
app.get('/api/stk/status/:reference', getOrderStatus);

// ── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * POST /api/stk/initiate
 * Body: { amount, msisdn, reference }
 * Stores the order as "pending", forwards the STK push request to HashBack,
 * and returns { success, checkout_id, reference } to the frontend.
 */
async function initiateStkPush(req, res) {
  try {
    const { amount, msisdn, reference } = req.body || {};

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'A positive numeric "amount" is required.',
      });
    }

    if (!msisdn || !MSISDN_PATTERN.test(String(msisdn))) {
      return res.status(400).json({
        success: false,
        message: '"msisdn" must be a valid Kenyan mobile number in 2547XXXXXXXX or 2541XXXXXXXX format.',
      });
    }

    const ref = String(reference || makeReference());

    // Store as "pending" BEFORE calling HashBack so the frontend can start
    // polling immediately.
    await writeOrder(ref, {
      reference: ref,
      amount: numericAmount,
      msisdn: String(msisdn),
      status: 'pending',
      checkout_id: null,
      receipt: null,
      createdAt: Date.now(),
    });

    let checkoutId = null;
    let upstreamOk = false;
    let upstreamMessage = null;
    let upstreamStatus = null;

    const apiKey = process.env.HASHBACK_API_KEY;
    const accountId = process.env.HASHBACK_ACCOUNT_ID;

    // Fail fast instead of firing a doomed request. Without credentials HashBack
    // answers 403 ("Account expired") for a reason that has nothing to do with
    // the real account, and the applicant just sees a generic failure.
    if (!apiKey || !accountId) {
      await patchOrder(ref, { status: 'failed' });
      console.error(
        '[stk/initiate] Refusing to call HashBack: HASHBACK_API_KEY / HASHBACK_ACCOUNT_ID are unset. ' +
        'Set them in .env next to server.js, or as Vercel environment variables.'
      );
      return res.status(503).json({
        success: false,
        checkout_id: null,
        reference: ref,
        message:
          'Payment service is not configured: HASHBACK_API_KEY and HASHBACK_ACCOUNT_ID are missing.',
      });
    }

    try {
      // Node 18+ global fetch.
      const upstream = await fetch(HASHBACK_INITIATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          account_id: accountId,
          amount: numericAmount,
          msisdn: String(msisdn),
          reference: ref,
        }),
        signal: AbortSignal.timeout(15000),
      });

      upstreamStatus = upstream.status;

      // Read as text first. A 403/5xx from HashBack (or a proxy/WAF sitting in
      // front of it) may return HTML or an empty body, and upstream.json()
      // would throw and throw away the only useful diagnostic we have.
      const rawBody = await upstream.text();

      let data = null;
      try {
        data = rawBody ? JSON.parse(rawBody) : null;
      } catch (_) {
        // Non-JSON upstream response — rawBody is still logged below.
      }

      checkoutId = data
        ? data.checkout_id || data.checkoutid || data.CheckoutRequestID || data.CheckoutRequestId || data.CheckoutID || null
        : null;

      upstreamOk = Boolean(checkoutId) ||
        Boolean(data && (data.ResponseCode === 0 || data.ResponseCode === '0' || data.success === true));

      if (!upstreamOk) {
        upstreamMessage = extractUpstreamMessage(data) || (rawBody || '').trim().slice(0, 500) || null;
        console.error(
          '[stk/initiate] HashBack rejected the STK push.',
          '\n  endpoint:  ', HASHBACK_INITIATE_URL,
          '\n  http:      ', upstreamStatus,
          '\n  reference: ', ref,
          '\n  message:   ', upstreamMessage || '(none returned)',
          '\n  raw body:  ', rawBody || '(empty)',
          '\n  creds used -> api_key:', fingerprint(apiKey), '| account_id:', accountId || '(unset)'
        );
      }
    } catch (err) {
      upstreamMessage =
        err.name === 'TimeoutError' || err.name === 'AbortError'
          ? 'HashBack did not respond within 15s.'
          : 'Could not reach HashBack: ' + err.message;
      console.error(
        '[stk/initiate] HashBack request failed:', err.message,
        err.cause ? ('| cause: ' + err.cause) : '',
        '\n  endpoint: ', HASHBACK_INITIATE_URL,
        '\n  reference:', ref,
        '\n  creds used -> api_key:', fingerprint(apiKey), '| account_id:', accountId || '(unset)'
      );
    }

    if (!upstreamOk) {
      await patchOrder(ref, { status: 'failed' });
      return res.status(502).json({
        success: false,
        checkout_id: null,
        reference: ref,
        // Surface the real provider reason (e.g. the 403 "Account expired"
        // body) instead of a generic string, so the failure is diagnosable
        // from the browser and the server log without extra digging.
        message: upstreamMessage
          ? 'Payment initiation failed: ' + upstreamMessage
          : 'Payment initiation failed. Please try again.',
        provider: 'hashback',
        provider_status: upstreamStatus,
        provider_message: upstreamMessage,
      });
    }

    await patchOrder(ref, { checkout_id: checkoutId });

    return res.json({
      success: true,
      checkout_id: checkoutId,
      reference: ref,
    });
  } catch (err) {
    console.error('[stk/initiate] Unexpected error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}


/**
 * GET /api/stk/status/:reference
 * Returns the current status of an order: pending | success | failed |
 * amount_mismatch. The frontend polls this every few seconds.
 */
async function getOrderStatus(req, res) {
  const order = await readOrder(String(req.params.reference));

  if (!order) {
    return res.status(404).json({
      success: false,
      reference: String(req.params.reference),
      status: 'unknown',
      message: 'Order not found.',
    });
  }

  return res.json({
    success: true,
    reference: order.reference,
    status: order.status,
    amount: order.amount,
    receipt: order.receipt,
  });
}

/**
 * POST /api/webhook/hashpay
 * Verifies the X-Hashpay-Signature header (HMAC-SHA256 of the raw body with
 * HASHBACK_WEBHOOK_SECRET, prefixed "sha256="). On a valid "payment.success"
 * event with ResponseCode 0, marks the matching order "success" (or
 * "amount_mismatch" when the paid amount differs). Always responds 200
 * quickly so HashPay does not retry; only a bad signature gets a 401.
 */
async function handleHashpayWebhook(req, res) {
  const headerValue = req.get('X-Hashpay-Signature') || '';
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  if (!verifySignature(rawBody, headerValue)) {
    return res.status(401).json({ success: false, message: 'Invalid or missing signature.' });
  }

  let event = null;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (_) {
    // Malformed JSON — acknowledge and move on.
    return res.status(200).json({ received: true });
  }

  try {
    await processPaymentSuccess(event);
  } catch (err) {
    console.error('[webhook] processing error:', err);
  }

  // Always ACK quickly.
  return res.status(200).json({ received: true });
}

// ── WEBHOOK HELPERS ─────────────────────────────────────────────────────────

/**
 * Compare the provided "sha256=<hex>" signature against an HMAC-SHA256 of the
 * raw body, using a constant-time comparison.
 */
function verifySignature(rawBody, headerValue) {
  const secret = process.env.HASHBACK_WEBHOOK_SECRET;
  if (!secret || !headerValue) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const provided = String(headerValue).trim().toLowerCase();
  const prefix = 'sha256=';
  const hex = provided.startsWith(prefix) ? provided.slice(prefix.length) : provided;

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(hex, 'hex');

  if (expectedBuf.length === 0 || providedBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Handle a payment.success payload: find the order by TransactionReference,
 * guard the amount, and store the result.
 */
async function processPaymentSuccess(event) {
  const eventType = String(deepFind(event, ['event', 'type', 'eventType', 'event_type']) || '').toLowerCase();
  const hasPaymentFields = deepFind(event, ['TransactionReference', 'Reference']) !== undefined;

  // Process genuine payment.success notifications; fall back to leniency only
  // when HashPay omits the event type but the payload is clearly a payment.
  const isPaymentSuccess = eventType === 'payment.success' || (!eventType && hasPaymentFields);
  if (!isPaymentSuccess) return; // Ignore other events (still ACK with 200).

  const responseCode = deepFind(event, ['ResponseCode']);
  if (Number(responseCode) !== 0) return; // Non-zero ResponseCode → not successful.

  const reference = deepFind(event, ['TransactionReference', 'Reference']);
  const amount = deepFind(event, ['TransactionAmount', 'Amount']);
  const receipt = deepFind(event, ['TransactionReceipt', 'Receipt', 'MpesaReceiptNumber']) || null;

  const order = await readOrder(String(reference));
  if (!order) {
    console.warn('[webhook] payment.success for unknown reference "' + reference + '" — ignored.');
    return;
  }

  // Amount guard: the paid amount must match what the order expected.
  if (money(amount) !== money(order.amount)) {
    await writeOrder(reference, Object.assign({}, order, { status: 'amount_mismatch', receipt }));
    console.warn(
      '[webhook] amount mismatch for "' + reference + '": expected ' + order.amount + ', paid ' + amount
    );
    return;
  }

  await writeOrder(reference, Object.assign({}, order, { status: 'success', receipt }));
  console.log('[webhook] order "' + reference + '" marked success, receipt: ' + receipt);
}

/** Normalize a monetary value to 2 decimals for safe comparison. */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
}

/** Depth-first search for the first key in `keys` that has a value. */
function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = deepFind(value, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Pull a human-readable reason out of a HashBack/HashPay response body.
 * They are not consistent about which field carries the message, so check the
 * common ones before falling back to the raw string.
 */
function extractUpstreamMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [
    data.message,
    data.error_description,
    data.error_message,
    data.error,
    data.ResponseDescription,
    data.ResponseMessage,
    data.fault_string,
    data.detail,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Safe-to-log identifier for a secret: enough to tell two keys apart in the
 * logs (e.g. "h260…VMc") without ever printing the credential itself.
 */
function fingerprint(value) {
  if (!value) return '(unset)';
  const s = String(value);
  if (s.length <= 6) return '*'.repeat(s.length);
  return s.slice(0, 4) + '…' + s.slice(-2) + ' (len ' + s.length + ')';
}

/** Generate a fallback order reference when the frontend omits one. */
function makeReference() {
  return (
    'HS-' +
    Date.now().toString(36).toUpperCase() +
    '-' +
    crypto.randomBytes(3).toString('hex').toUpperCase()
  );
}

// ── BOOT ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

// ── CREDENTIAL SELF-CHECK ────────────────────────────────────────────────────
// HashBack keys/tills are scoped per key, so a stale key produces a confusing
// 403 ("Account expired") even when the account itself is fine. Print a
// masked fingerprint of the credentials this process actually loaded, so a
// key mismatch against another site is visible in the boot log immediately.
console.log(
  '[sasa-backend] HashBack config ->',
  'endpoint:', HASHBACK_INITIATE_URL,
  '| api_key:', fingerprint(process.env.HASHBACK_API_KEY),
  '| account_id:', process.env.HASHBACK_ACCOUNT_ID || '(UNSET)',
  '| webhook secret:', process.env.HASHBACK_WEBHOOK_SECRET ? 'set' : '(UNSET)',
  '| order store:', KV_URL && KV_TOKEN ? 'vercel-kv' : 'in-memory (NOT serverless-safe)'
);
if (!process.env.HASHBACK_API_KEY || !process.env.HASHBACK_ACCOUNT_ID) {
  console.warn(
    '[sasa-backend] WARNING: HASHBACK_API_KEY / HASHBACK_ACCOUNT_ID are not set, so ' +
    'every STK push will be refused with a 503. Searched for .env in "' +
    path.join(__dirname, '..', '.env') + '" and "' + path.join(__dirname, '.env') +
    '". Set them in the host environment, in one of those files, or as Vercel ' +
    'environment variables.'
  );
}
if (!(KV_URL && KV_TOKEN)) {
  console.warn(
    '[sasa-backend] WARNING: no KV_REST_API_URL / KV_REST_API_TOKEN, so orders are ' +
    'held in memory. On Vercel the status poll and the HashPay webhook will not see ' +
    'the order created by /api/stk/initiate and the page will hang on "pending". ' +
    'Attach a KV store in the Vercel dashboard before going live.'
  );
}

app.listen(PORT, function () {
  console.log('[sasa-backend] listening on http://localhost:' + PORT);
});
