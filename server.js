/**
 * Hela Sasa — HashBack (HashPay) M-PESA STK Push backend
 * ======================================================
 * Express server exposing three routes:
 *
 *   POST /api/stk/initiate          → ask HashBack to send an STK push
 *   GET  /api/stk/status/:reference → order status (polled by the frontend)
 *   POST /api/webhook/hashpay       → signed HashPay webhook (payment results)
 *
 * ⚠️  STATE WARNING — READ BEFORE GOING LIVE
 * Orders are stored in an IN-MEMORY Map (see `orders` below). That is fine for
 * local development, but it will NOT survive across Vercel's stateless
 * serverless instances — each invocation may boot a fresh instance with an
 * empty Map, so a webhook can land on an instance that never saw the original
 * initiate call. Swap `orders` for Vercel KV (Upstash Redis) or any database
 * before going live; nothing else in this file needs to change.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');

const HASHBACK_INITIATE_URL = 'https://api.hashback.co.ke/initiatestk';
const MSISDN_PATTERN = /^254[71]\d{8}$/; // 254 + 7XXXXXXXX / 1XXXXXXXX (12 digits)

/**
 * ⚠️ In-memory order store — swap for Vercel KV or a database before going
 * live (see the state warning at the top of this file).
 *
 * Shape: Map<reference, {
 *   reference: string,
 *   amount: number,
 *   msisdn: string,
 *   status: 'pending' | 'success' | 'failed' | 'amount_mismatch',
 *   checkout_id: string | null,
 *   receipt: string | null,
 *   createdAt: number
 * }>
 */
const orders = new Map();

const app = express();

app.get('/', (req, res) => {
  res.send('Hela Sasa backend is running ✅');
});

// ── STATIC PAGES ────────────────────────────────────────────────────────────
const path = require('path');
// Serves backend/public — includes the static M-PESA STK Push payment page.
app.use(express.static(path.join(__dirname, 'public')));
// Also serve the frontend folder (index-2.html, personal-details.html) so the
// whole flow can be tested from one local origin, e.g. /index-2.html.
app.use(express.static(path.join(__dirname, 'helasasa.com')));

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
  res.sendFile(path.join(__dirname, 'helasasa.com', 'personal-details.html'));
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
    orders.set(ref, {
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

    try {
      // Node 18+ global fetch.
      const upstream = await fetch(HASHBACK_INITIATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.HASHBACK_API_KEY,
          account_id: process.env.HASHBACK_ACCOUNT_ID,
          amount: numericAmount,
          msisdn: String(msisdn),
          reference: ref,
        }),
        signal: AbortSignal.timeout(15000),
      });

      let data = null;
      try {
        data = await upstream.json();
      } catch (_) {
        // Non-JSON upstream response.
      }

      checkoutId = data
        ? data.checkout_id || data.CheckoutRequestID || data.CheckoutRequestId || data.CheckoutID || null
        : null;

      upstreamOk = Boolean(checkoutId) ||
        Boolean(data && (data.ResponseCode === 0 || data.ResponseCode === '0' || data.success === true));

      if (!upstreamOk) {
        console.error(
          '[stk/initiate] HashBack responded but did not indicate success. HTTP status:',
          upstream.status,
          'Body:',
          JSON.stringify(data)
        );
      }
    } catch (err) {
      console.error('[stk/initiate] HashBack request failed:', err.message);
    }

    if (!upstreamOk) {
      const order = orders.get(ref);
      if (order) order.status = 'failed';
      return res.status(502).json({
        success: false,
        checkout_id: null,
        reference: ref,
        message: 'Payment initiation failed. Please try again.',
      });
    }

    orders.get(ref).checkout_id = checkoutId;

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
function getOrderStatus(req, res) {
  const order = orders.get(String(req.params.reference));

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
function handleHashpayWebhook(req, res) {
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
    processPaymentSuccess(event);
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
function processPaymentSuccess(event) {
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

  const order = orders.get(String(reference));
  if (!order) {
    console.warn('[webhook] payment.success for unknown reference "' + reference + '" — ignored.');
    return;
  }

  // Amount guard: the paid amount must match what the order expected.
  if (money(amount) !== money(order.amount)) {
    order.status = 'amount_mismatch';
    order.receipt = receipt;
    console.warn(
      '[webhook] amount mismatch for "' + reference + '": expected ' + order.amount + ', paid ' + amount
    );
    return;
  }

  order.status = 'success';
  order.receipt = receipt;
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
app.listen(PORT, function () {
  console.log('[sasa-backend] listening on http://localhost:' + PORT);
});
