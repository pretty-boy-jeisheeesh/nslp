// POST /api/hitpay-webhook
// HitPay calls this when a payment is completed. We verify the signature, then record the
// payment in a Netlify Form called "paid-order" (set up an email notification on that form).
//
// Netlify environment variable needed:
//   HITPAY_SALT  (secret) – the salt shown for the webhook endpoint you register in HitPay
//                (Developers → Webhook Endpoints). Sandbox and production have different salts.

import crypto from 'node:crypto';

const text = (body, status = 200) => new Response(body, { status });

export default async (req) => {
  if (req.method !== 'POST') return text('Method not allowed', 405);

  const salt = process.env.HITPAY_SALT;
  if (!salt) { console.error('HITPAY_SALT is not set'); return text('Not configured', 500); }

  // Signature is computed over the RAW body, so read it as text before parsing.
  const raw = await req.text();
  const sent = (req.headers.get('hitpay-signature') || '').trim().toLowerCase();
  const expected = crypto.createHmac('sha256', salt).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sent);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn('HitPay webhook: bad signature');
    return text('Invalid signature', 401);
  }

  let d;
  try { d = JSON.parse(raw); } catch { return text('Bad JSON', 400); }

  // Only act on completed payment requests; acknowledge everything else so HitPay stops retrying.
  if (d.status !== 'completed') return text('Ignored');

  const pay = (d.payments && d.payments[0]) || {};
  const origin = process.env.SITE_URL || new URL(req.url).origin;
  const form = new URLSearchParams({
    'form-name': 'paid-order',
    reference_number: d.reference_number || '',
    payment_request_id: d.id || '',
    amount: d.amount || pay.amount || '',
    currency: d.currency || pay.currency || '',
    payment_type: pay.payment_type || '',
    buyer_name: d.name || '',
    buyer_email: d.email || pay.buyer_email || '',
    buyer_phone: d.phone || '',
    purpose: d.purpose || '',
    paid_at: pay.updated_at || d.updated_at || '',
  });

  try {
    const r = await fetch(`${origin}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    if (r.status >= 400) throw new Error('Netlify form post returned ' + r.status);
  } catch (e) {
    console.error('Could not record paid order', e);
    return text('Could not record', 500); // non-200 → HitPay will retry
  }
  return text('OK');
};

export const config = { path: '/api/hitpay-webhook' };
