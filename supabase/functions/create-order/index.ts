// POST /functions/v1/create-order
// Creates an order in 'ready' state and returns what the Toss payment widget needs.
// The amount is computed here from the catalogue; the browser only says what it wants to buy.
import { clean, handle, HttpError, int, json, readJson } from '../_shared/http.ts';
import { db, todayKST, requireClientKey } from '../_shared/db.ts';

const AGREEMENT_VERSION = '2026-10-26';
const EMAIL = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;
const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const NAMES: Record<string, Record<string, string>> = {
  reward: { ko: '오레 리워드 후원', en: 'OREH reward pledge', zh: 'OREH 回饋贊助' },
  donation: { ko: '오레 기부', en: 'OREH donation', zh: 'OREH 捐款' },
  sponsor: { ko: '오레 가치참여(광고)', en: 'OREH value participation (sponsored)', zh: 'OREH 價值參與（廣告）' },
};

function orderId(): string {
  const day = todayKST().replace(/-/g, '');
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const tail = Array.from(rnd, (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  return `OREH${day}-${tail}`;
}

Deno.serve(handle(async (req) => {
  requireClientKey(req);
  const b = await readJson(req);
  const lang = ['ko', 'en', 'zh'].includes(b.lang as string) ? (b.lang as string) : 'ko';
  const kind = b.kind as string;
  if (!['reward', 'donation', 'sponsor'].includes(kind)) throw new HttpError(400, 'bad_kind');

  const { data: c } = await db.from('campaigns').select('*').eq('id', clean(b.campaignId, 40)).maybeSingle();
  if (!c || c.status !== 'live') throw new HttpError(409, 'campaign_not_open');
  const today = todayKST();
  if (today < c.starts_on || today > c.ends_on) throw new HttpError(409, 'campaign_not_open');

  // buyer + agreements
  const buyer = (b.buyer ?? {}) as Record<string, unknown>;
  const name = clean(buyer.name, 60), email = clean(buyer.email, 254).toLowerCase(), country = clean(buyer.country, 2).toUpperCase();
  if (!name) throw new HttpError(400, 'bad_name');
  if (!EMAIL.test(email)) throw new HttpError(400, 'bad_email');
  if (!/^[A-Z]{2}$/.test(country)) throw new HttpError(400, 'bad_country');
  const ag = (b.agreements ?? {}) as Record<string, unknown>;
  const need = ['terms', 'privacy', kind === 'reward' ? 'refund' : null, kind === 'sponsor' ? 'ad' : null, kind === 'donation' ? 'donation' : null]
    .filter(Boolean) as string[];
  for (const k of need) if (ag[k] !== true) throw new HttpError(400, 'agreement_missing', k);

  const extra = int(b.extraKrw ?? 0);
  if (extra === null || extra < 0 || extra > 10_000_000) throw new HttpError(400, 'bad_extra');

  const row: Record<string, unknown> = {
    order_id: orderId(), campaign_id: c.id, kind, buyer_name: name, buyer_email: email, buyer_country: country, lang,
    agreements: { version: AGREEMENT_VERSION, accepted_at: new Date().toISOString(), items: need },
  };
  let sponsor: Record<string, unknown> | null = null;

  if (kind === 'reward') {
    if (c.track !== 'reward') throw new HttpError(409, 'not_a_reward_project');
    // anything paid above the reward price would be a gift, which only a registered collector may take
    if (extra !== 0) throw new HttpError(400, 'extra_not_allowed');
    const { data: r } = await db.from('rewards').select('*').eq('id', clean(b.rewardId, 60)).eq('campaign_id', c.id).eq('active', true).maybeSingle();
    if (!r) throw new HttpError(400, 'bad_reward');
    if (r.stock !== null) {
      const { count } = await db.from('orders').select('id', { count: 'exact', head: true }).eq('reward_id', r.id).eq('status', 'paid');
      if ((count ?? 0) >= r.stock) throw new HttpError(409, 'sold_out');
    }
    Object.assign(row, { reward_id: r.id, base_krw: r.amount_krw, extra_krw: extra, amount_krw: r.amount_krw + extra });
  } else if (kind === 'donation') {
    if (c.track !== 'donation' || !c.donation_enabled) throw new HttpError(409, 'donation_closed');
    if (extra < 1000) throw new HttpError(400, 'bad_amount');
    Object.assign(row, { base_krw: 0, extra_krw: extra, amount_krw: extra });
  } else {
    if (!c.sponsor_enabled) throw new HttpError(409, 'sponsor_closed');
    const { data: p } = await db.from('sponsor_packages').select('*').eq('id', clean(b.packageId, 40)).eq('active', true).maybeSingle();
    if (!p) throw new HttpError(400, 'bad_package');
    const s = (b.sponsor ?? {}) as Record<string, unknown>;
    const display = clean(s.displayName, 40);
    if (!display) throw new HttpError(400, 'bad_display_name');
    Object.assign(row, { package_id: p.id, base_krw: p.amount_krw, extra_krw: 0, amount_krw: p.amount_krw });
    // Leon says the same line for every sponsor ("가치참여에 함께 했습니다."), so no custom message is stored
    sponsor = { campaign_id: c.id, sponsor_type: p.sponsor_type, display_name: display, message: null, lang };
    const logoType = clean(s.logoType, 20);
    if (logoType) {
      if (!LOGO_TYPES[logoType]) throw new HttpError(400, 'bad_logo_type');
      sponsor.logo_path = `${c.id}/${crypto.randomUUID()}.${LOGO_TYPES[logoType]}`;
    }
  }

  const { data: order, error } = await db.from('orders').insert(row).select('id, order_id, amount_krw').single();
  if (error) throw new HttpError(500, 'order_failed', error.message);

  let logoUpload: unknown = null;
  if (sponsor) {
    const { error: e2 } = await db.from('sponsors').insert({ ...sponsor, order_uuid: order.id });
    if (e2) throw new HttpError(500, 'sponsor_failed', e2.message);
    if (sponsor.logo_path) {
      const { data: up, error: e3 } = await db.storage.from('sponsor-logos').createSignedUploadUrl(sponsor.logo_path as string);
      if (e3) throw new HttpError(500, 'logo_url_failed', e3.message);
      logoUpload = { signedUrl: up.signedUrl, path: up.path };
    }
  }

  return json(req, 200, {
    orderId: order.order_id,
    amount: order.amount_krw,
    orderName: `${NAMES[kind][lang]} · ${c.id}`,
    customerEmail: email,
    customerName: name,
    logoUpload,
  });
}));
