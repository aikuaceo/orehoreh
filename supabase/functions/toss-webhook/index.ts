// POST /functions/v1/toss-webhook   (register this URL in the Toss developer center, event PAYMENT_STATUS_CHANGED)
// The webhook body is not trusted: the payment is looked up again with the secret key before anything changes.
import { db } from '../_shared/db.ts';
import { getPayment, mapStatus } from '../_shared/toss.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return new Response('bad json', { status: 400 }); }
  const data = (body.data ?? {}) as Record<string, unknown>;
  const paymentKey = typeof data.paymentKey === 'string' ? data.paymentKey : '';
  if (body.eventType !== 'PAYMENT_STATUS_CHANGED' || !paymentKey) return new Response('ignored', { status: 200 });

  const r = await getPayment(paymentKey);
  if (!r.ok) return new Response('lookup failed', { status: 502 }); // Toss retries
  const next = mapStatus(r.body.status);
  const orderId = String(r.body.orderId ?? '');
  if (!next || !orderId) return new Response('ok', { status: 200 });

  const { data: o } = await db.from('orders').select('id, amount_krw, status').eq('order_id', orderId).maybeSingle();
  if (!o) return new Response('unknown order', { status: 200 });
  if (next === 'paid' && r.body.totalAmount !== o.amount_krw) {
    console.error('webhook amount mismatch', orderId);
    return new Response('mismatch', { status: 200 });
  }
  const patch: Record<string, unknown> = { status: next, payment_key: paymentKey, toss: r.body };
  if (next === 'paid' && o.status !== 'paid') patch.paid_at = r.body.approvedAt ?? new Date().toISOString();
  if (next === 'canceled' || next === 'partial_canceled') patch.canceled_at = new Date().toISOString();
  await db.from('orders').update(patch).eq('id', o.id);
  return new Response('ok', { status: 200 });
});
