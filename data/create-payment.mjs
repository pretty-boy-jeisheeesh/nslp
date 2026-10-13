// POST /api/create-payment
// Called by the website when a customer clicks PAY NOW.
//  1. Re-reads prices/stock from data/products.json on the server (never trusts the browser's prices)
//  2. Creates a HitPay payment request
//  3. Records the order details (incl. address) in a Netlify Form called "pending-order"
//  4. Returns the HitPay checkout URL for the browser to redirect to
//
// Netlify environment variables needed:
//   HITPAY_API_KEY   (secret)  – from HitPay dashboard → Settings → API Keys
//   HITPAY_ENV       "sandbox" (default) or "production"
//   HITPAY_PAYMENT_METHODS  (optional) comma list, e.g. "gcash,qrph_netbank,card_cybersource".
//                           Leave unset to show every method enabled on your HitPay account.
//   SITE_URL         (optional) override, e.g. https://nslpco.com

import crypto from 'node:crypto';

const API_BASE = {
  production: 'https://api.hit-pay.com/v1',
  sandbox: 'https://api.sandbox.hit-pay.com/v1',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function isSoldOut(p) {
  if (p.sold_out) return true;
  if (p.stock !== undefined && p.stock !== null && p.stock !== '' && Number(p.stock) <= 0) return true;
  return false;
}
function stockLeft(p) {
  if (p.stock === undefined || p.stock === null || p.stock === '') return Infinity;
  return Number(p.stock);
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const apiKey = process.env.HITPAY_API_KEY;
  if (!apiKey) return json({ error: 'Online payment is not set up yet. Please contact the shop.' }, 500);
  const env = process.env.HITPAY_ENV === 'production' ? 'production' : 'sandbox';

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request.' }, 400); }

  // ── Validate customer details ──
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().slice(0, 160);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const address = String(body.address || '').trim().slice(0, 400);
  if (!name || !email || !address) return json({ error: 'Please fill in your name, email, and delivery address.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Please enter a valid email address.' }, 400);
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
    return json({ error: 'Your cart is empty.' }, 400);
  }

  const origin = process.env.SITE_URL || new URL(req.url).origin;

  // ── Load the real product list (prices + stock) from the deployed site ──
  let products;
  try {
    const r = await fetch(`${origin}/data/products.json?v=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error('products.json ' + r.status);
    products = (await r.json()).products || [];
  } catch (e) {
    console.error('Could not load products.json', e);
    return json({ error: 'Could not verify prices right now. Please try again.' }, 502);
  }

  // ── Build the order from server-side prices ──
  const perProductQty = {};
  const lines = [];
  for (const it of body.items) {
    const product = products.find(p => Number(p.id) === Number(it.id));
    const qty = Math.floor(Number(it.qty));
    if (!product || !(qty >= 1 && qty <= 20)) return json({ error: 'Something in your cart is no longer available. Please refresh and try again.' }, 400);
    if (isSoldOut(product)) return json({ error: `${product.name} is sold out. Please remove it from your cart.` }, 409);

    let variantLabel = null;
    if (it.variantLabel) {
      const v = (product.variants || []).find(v => v.label === it.variantLabel);
      if (!v) return json({ error: `That option for ${product.name} is no longer available.` }, 400);
      variantLabel = v.label;
    }
    perProductQty[product.id] = (perProductQty[product.id] || 0) + qty;
    if (perProductQty[product.id] > stockLeft(product)) {
      return json({ error: `Only ${stockLeft(product)} left in stock for ${product.name}.` }, 409);
    }
    lines.push({ name: product.name, variantLabel, qty, price: Number(product.price) });
  }
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  if (!(total > 0)) return json({ error: 'Invalid order total.' }, 400);

  const summary = lines
    .map(l => `${l.name}${l.variantLabel ? ' (' + l.variantLabel + ')' : ''} x${l.qty}`)
    .join('; ');

  const reference = 'NSLP-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();

  // ── Create the HitPay payment request ──
  const params = new URLSearchParams();
  params.set('amount', total.toFixed(2));
  params.set('currency', 'PHP');
  params.set('name', name);
  params.set('email', email);
  if (phone) params.set('phone', phone);
  params.set('purpose', `NSLP.CO order ${reference}: ${summary}`.slice(0, 250));
  params.set('reference_number', reference);
  params.set('redirect_url', `${origin}/`);
  params.set('allow_repeated_payments', 'false');
  const methods = (process.env.HITPAY_PAYMENT_METHODS || '').split(',').map(s => s.trim()).filter(Boolean);
  methods.forEach(m => params.append('payment_methods[]', m));

  let hp;
  try {
    const r = await fetch(`${API_BASE[env]}/payment-requests`, {
      method: 'POST',
      headers: {
        'X-BUSINESS-API-KEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: params.toString(),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('HitPay error', r.status, text);
      return json({ error: 'Could not start the payment. Please try again in a moment.' }, 502);
    }
    hp = JSON.parse(text);
    if (!hp.url) throw new Error('No checkout url in HitPay response');
  } catch (e) {
    console.error('HitPay request failed', e);
    return json({ error: 'Could not start the payment. Please try again in a moment.' }, 502);
  }

  // ── Record the order details (address etc.) in Netlify Forms ──
  // If this fails we do NOT hand over the payment link, so nobody pays without us knowing where to ship.
  const form = new URLSearchParams({
    'form-name': 'pending-order',
    reference_number: reference,
    hitpay_payment_request_id: hp.id || '',
    name, email, phone, address,
    order_items: summary,
    order_total: '₱' + total.toLocaleString('en-PH'),
    status: 'awaiting payment',
    hitpay_env: env,
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
    console.error('Could not record pending order', e);
    return json({ error: 'Could not save your order. Please try again.' }, 502);
  }

  return json({ url: hp.url, reference });
};

export const config = { path: '/api/create-payment' };
