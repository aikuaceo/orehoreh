// POST /functions/v1/admin-order   header x-admin-token: <ADMIN_TOKEN>
// Operator actions:
//   { action: 'approve-sponsor', sponsorId }       → publish Leon's introduction (and make the voice if TTS is set up)
//   { action: 'reject-sponsor', sponsorId, note }  → keep it off the site (refund separately with 'cancel')
//   { action: 'cancel', orderId, reason }          → full refund through Toss
//   { action: 'refund-campaign', campaignId, reason } → refund every paid reward/donation order (goal not reached)
import { clean, handle, HttpError, json, readJson } from '../_shared/http.ts';
import { addDays, db, todayKST } from '../_shared/db.ts';
import { cancelPayment } from '../_shared/toss.ts';
import { makeLeonVoice } from '../_shared/leon.ts';

function checkToken(req: Request) {
  const want = Deno.env.get('ADMIN_TOKEN');
  const got = req.headers.get('x-admin-token') ?? '';
  if (!want || want.length < 24 || got.length !== want.length) throw new HttpError(401, 'unauthorized');
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff !== 0) throw new HttpError(401, 'unauthorized');
}

async function refund(o: { id: string; order_id: string; payment_key: string | null; status: string }, reason: string) {
  if (o.status !== 'paid' || !o.payment_key) return { orderId: o.order_id, skipped: o.status };
  const r = await cancelPayment(o.payment_key, reason, 'cancel-' + o.order_id);
  if (!r.ok) return { orderId: o.order_id, error: r.body.code ?? r.status };
  await db.from('orders').update({ status: 'canceled', canceled_at: new Date().toISOString(), toss: r.body }).eq('id', o.id);
  return { orderId: o.order_id, refunded: true };
}

Deno.serve(handle(async (req) => {
  checkToken(req);
  const b = await readJson(req);
  const action = clean(b.action, 40);

  if (action === 'approve-sponsor' || action === 'reject-sponsor') {
    const { data: s } = await db.from('sponsors').select('*, orders!inner(status, package_id, sponsor_packages(days))')
      .eq('id', clean(b.sponsorId, 40)).maybeSingle();
    if (!s) throw new HttpError(404, 'sponsor_not_found');
    if (action === 'reject-sponsor') {
      await db.from('sponsors').update({ review_status: 'rejected', review_note: clean(b.note, 300) || null }).eq('id', s.id);
      return json(req, 200, { ok: true });
    }
    if (s.orders.status !== 'paid') throw new HttpError(409, 'not_paid');
    const days = s.orders.sponsor_packages?.days ?? 30;
    const from = todayKST();
    await db.from('sponsors').update({ review_status: 'approved', show_from: from, show_until: addDays(from, days - 1) }).eq('id', s.id);
    const voice = s.voice_path ? s.voice_path : await makeLeonVoice(s);
    return json(req, 200, { ok: true, showUntil: addDays(from, days - 1), voice: voice ? 'ready' : 'browser-tts' });
  }

  if (action === 'cancel') {
    const { data: o } = await db.from('orders').select('id, order_id, payment_key, status').eq('order_id', clean(b.orderId, 64)).maybeSingle();
    if (!o) throw new HttpError(404, 'order_not_found');
    return json(req, 200, await refund(o, clean(b.reason, 200) || '고객 요청 환불'));
  }

  if (action === 'refund-campaign') {
    const { data: list } = await db.from('orders').select('id, order_id, payment_key, status')
      .eq('campaign_id', clean(b.campaignId, 40)).eq('status', 'paid').in('kind', ['reward', 'donation']);
    const out = [];
    for (const o of list ?? []) out.push(await refund(o, clean(b.reason, 200) || '목표 금액 미달로 전액 환불'));
    return json(req, 200, { results: out });
  }

  throw new HttpError(400, 'bad_action');
}));
