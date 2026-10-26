// POST /functions/v1/confirm-payment  { paymentKey, orderId, amount }
// Called by the success page after Toss redirects back. Approves the payment only when the
// amount matches the stored order, then records the result. Safe to call twice.
import { clean, handle, HttpError, int, json, readJson } from '../_shared/http.ts';
import { db, requireClientKey } from '../_shared/db.ts';
import { confirmPayment } from '../_shared/toss.ts';

Deno.serve(handle(async (req) => {
  requireClientKey(req);
  const b = await readJson(req);
  const paymentKey = clean(b.paymentKey, 200), orderId = clean(b.orderId, 64), amount = int(b.amount);
  if (!paymentKey || !orderId || amount === null) throw new HttpError(400, 'bad_request');

  const { data: o } = await db.from('orders').select('*').eq('order_id', orderId).maybeSingle();
  if (!o) throw new HttpError(404, 'order_not_found');
  const reply = (status: string) => json(req, 200, {
    status, orderId: o.order_id, amount: o.amount_krw, kind: o.kind, campaignId: o.campaign_id,
  });
  if (o.status === 'paid') return reply('paid'); // already approved (page reloaded)
  if (o.status !== 'ready') throw new HttpError(409, 'order_closed');
  if (amount !== o.amount_krw) {
    await db.from('orders').update({ status: 'failed', fail_code: 'AMOUNT_MISMATCH' }).eq('id', o.id);
    throw new HttpError(400, 'amount_mismatch');
  }

  const r = await confirmPayment(paymentKey, orderId, o.amount_krw);
  if (!r.ok) {
    const code = String(r.body.code ?? 'CONFIRM_FAILED'), message = String(r.body.message ?? '');
    // ALREADY_PROCESSED_PAYMENT = an earlier confirm went through; the webhook or a reload settles it
    if (code !== 'ALREADY_PROCESSED_PAYMENT') {
      await db.from('orders').update({ status: 'failed', fail_code: code, fail_message: message, payment_key: paymentKey }).eq('id', o.id);
    }
    throw new HttpError(402, code, message);
  }
  if (r.body.totalAmount !== o.amount_krw || r.body.orderId !== o.order_id) {
    console.error('toss confirm mismatch', o.order_id, r.body.totalAmount);
    throw new HttpError(502, 'confirm_mismatch');
  }

  await db.from('orders').update({
    status: 'paid', payment_key: paymentKey, method: r.body.method ?? null,
    paid_at: (r.body.approvedAt as string) ?? new Date().toISOString(), toss: r.body,
  }).eq('id', o.id).eq('status', 'ready');
  return reply('paid');
}));
