// POST /functions/v1/admin-order
// Who may call it: an OREH operator signed in on orehoreh.com/admin/ (Authorization: Bearer <session>,
// email listed in public.admins), or a script with header x-admin-token: <ADMIN_TOKEN>.
// Operator actions:
//   { action: 'overview' }                          → orders, value participations, totals for the admin page
//   { action: 'approve-sponsor', sponsorId }        → publish Leon's introduction (and make the voice if TTS is set up)
//   { action: 'reject-sponsor', sponsorId, note }   → keep it off the site and refund it in full (ad policy)
//   { action: 'cancel', orderId, reason }           → full refund through Toss
//   { action: 'refund-campaign', campaignId, reason } → refund every paid reward/donation order (goal not reached)
import { clean, handle, HttpError, json, readJson } from '../_shared/http.ts';
import { addDays, db, todayKST } from '../_shared/db.ts';
import { cancelPayment } from '../_shared/toss.ts';
import { makeLeonVoice } from '../_shared/leon.ts';

function tokenOk(req: Request): boolean {
  const want = Deno.env.get('ADMIN_TOKEN') ?? '';
  const got = req.headers.get('x-admin-token') ?? '';
  if (want.length < 24 || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// Returns who is acting, for the action log.
async function operator(req: Request): Promise<string> {
  if (tokenOk(req)) return 'token';
  const h = req.headers.get('authorization') ?? '';
  const jwt = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (jwt.split('.').length === 3) {
    const { data, error } = await db.auth.getUser(jwt);
    const email = (data?.user?.email ?? '').toLowerCase();
    if (!error && email && data.user?.email_confirmed_at) {
      const { data: a } = await db.from('admins').select('email').eq('email', email).maybeSingle();
      if (a) return email;
    }
  }
  throw new HttpError(401, 'unauthorized');
}

async function log(admin: string, action: string, target: string | null, detail: unknown) {
  const { error } = await db.from('admin_actions').insert({ admin, action, target, detail: detail ?? null });
  if (error) console.error('admin log failed', error.message);
}

async function refund(o: { id: string; order_id: string; payment_key: string | null; status: string }, reason: string) {
  if (o.status !== 'paid' || !o.payment_key) return { orderId: o.order_id, skipped: o.status };
  const r = await cancelPayment(o.payment_key, reason, 'cancel-' + o.order_id);
  if (!r.ok) return { orderId: o.order_id, error: r.body.code ?? r.status };
  await db.from('orders').update({ status: 'canceled', canceled_at: new Date().toISOString(), toss: r.body }).eq('id', o.id);
  return { orderId: o.order_id, refunded: true };
}

Deno.serve(handle(async (req) => {
  const admin = await operator(req);
  const b = await readJson(req);
  const action = clean(b.action, 40);

  if (action === 'overview') {
    const [orders, sponsors, stats, camps] = await Promise.all([
      db.from('orders').select('order_id, campaign_id, kind, reward_id, package_id, amount_krw, status, method, buyer_name, buyer_email, buyer_country, lang, fail_code, created_at, paid_at, canceled_at')
        .order('created_at', { ascending: false }).limit(300),
      db.from('sponsors').select('id, campaign_id, sponsor_type, display_name, message, logo_path, lang, voice_path, review_status, review_note, show_from, show_until, created_at, orders!inner(order_id, status, amount_krw, buyer_name, buyer_email)')
        .order('created_at', { ascending: false }).limit(200),
      db.from('campaign_stats').select('*'),
      db.from('campaigns').select('id, status, track, goal_krw, starts_on, ends_on, donation_enabled').order('id'),
    ]);
    const err = orders.error || sponsors.error || stats.error || camps.error;
    if (err) throw new HttpError(500, 'overview_failed', err.message);
    return json(req, 200, { admin, today: todayKST(), orders: orders.data, sponsors: sponsors.data, stats: stats.data, campaigns: camps.data });
  }

  if (action === 'approve-sponsor' || action === 'reject-sponsor') {
    const { data: s } = await db.from('sponsors').select('*, orders!inner(status, package_id, sponsor_packages(days))')
      .eq('id', clean(b.sponsorId, 40)).maybeSingle();
    if (!s) throw new HttpError(404, 'sponsor_not_found');
    if (action === 'reject-sponsor') {
      const note = clean(b.note, 300) || null;
      await db.from('sponsors').update({ review_status: 'rejected', review_note: note }).eq('id', s.id);
      // ad policy: an introduction OREH does not publish is refunded in full
      const { data: o } = await db.from('orders').select('id, order_id, payment_key, status').eq('id', s.order_uuid).maybeSingle();
      const refunded = o ? await refund(o, '가치참여 게시 불가로 전액 환불') : null;
      await log(admin, action, s.id, { note, refunded });
      return json(req, 200, { ok: true, refunded });
    }
    if (s.orders.status !== 'paid') throw new HttpError(409, 'not_paid');
    const days = s.orders.sponsor_packages?.days ?? 30;
    const from = todayKST();
    await db.from('sponsors').update({ review_status: 'approved', show_from: from, show_until: addDays(from, days - 1) }).eq('id', s.id);
    const voice = s.voice_path ? s.voice_path : await makeLeonVoice(s);
    await log(admin, action, s.id, { showFrom: from, showUntil: addDays(from, days - 1), voice: !!voice });
    return json(req, 200, { ok: true, showUntil: addDays(from, days - 1), voice: voice ? 'ready' : 'browser-tts' });
  }

  if (action === 'cancel') {
    const { data: o } = await db.from('orders').select('id, order_id, payment_key, status').eq('order_id', clean(b.orderId, 64)).maybeSingle();
    if (!o) throw new HttpError(404, 'order_not_found');
    const reason = clean(b.reason, 200) || '고객 요청 환불';
    const r = await refund(o, reason);
    await log(admin, action, o.order_id, { reason, result: r });
    return json(req, 200, r);
  }

  if (action === 'refund-campaign') {
    // only once the campaign is over (or canceled), so a running campaign is never refunded by mistake
    const { data: c } = await db.from('campaigns').select('id, status, ends_on').eq('id', clean(b.campaignId, 40)).maybeSingle();
    if (!c) throw new HttpError(404, 'campaign_not_found');
    if (c.status !== 'canceled' && todayKST() <= c.ends_on) throw new HttpError(409, 'campaign_still_running');
    const { data: list } = await db.from('orders').select('id, order_id, payment_key, status')
      .eq('campaign_id', clean(b.campaignId, 40)).eq('status', 'paid').in('kind', ['reward', 'donation']);
    const out = [];
    const reason = clean(b.reason, 200) || '목표 금액 미달로 전액 환불';
    for (const o of list ?? []) out.push(await refund(o, reason));
    await log(admin, action, clean(b.campaignId, 40), { reason, count: out.length });
    return json(req, 200, { results: out });
  }

  throw new HttpError(400, 'bad_action');
}));
