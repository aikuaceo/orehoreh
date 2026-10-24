// AIKUA BOX — 고객 리뷰 (GET 목록 / POST 등록)
// Supabase 연결 시 모든 방문자에게 공유됩니다. (연결 전에는 작성자 본인 브라우저에만 표시)
//
// [설정] Vercel 환경변수:
//   SUPABASE_URL          = https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  = service_role 키 (비공개)
// [테이블] SQL:
//   create table reviews (
//     id bigint generated always as identity primary key,
//     name text not null, rating int not null default 5,
//     text text not null, approved boolean not null default true,
//     created_at timestamptz not null default now()
//   );

const ALLOWED_HOSTS = ["aikuabox.com", "www.aikuabox.com"];
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { const h = new URL(o).hostname; if (h === "localhost" || h.endsWith(".vercel.app")) return true; return ALLOWED_HOSTS.includes(h); }
  catch { return false; }
}
const S = (v, m) => (typeof v === "string" ? v : "").slice(0, m).trim();
const COUPON = "REVIEW5";

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;

  if (req.method === "GET") {
    res.setHeader("Cache-Control", "public, max-age=30");
    if (!url || !key) return res.status(200).json({ reviews: [] });
    try {
      const r = await fetch(url + "/rest/v1/reviews?select=name,rating,text,created_at&approved=eq.true&order=created_at.desc&limit=60",
        { headers: { apikey: key, Authorization: "Bearer " + key } });
      const data = await r.json();
      return res.status(200).json({ reviews: Array.isArray(data) ? data : [] });
    } catch (e) { return res.status(200).json({ reviews: [] }); }
  }

  if (req.method === "POST") {
    res.setHeader("Cache-Control", "no-store");
    if (!sameOrigin(req)) return res.status(403).json({ message: "Forbidden" });
    try {
      const b = req.body || {};
      const name = S(b.name, 60), text = S(b.text, 1000);
      let rating = Number(b.rating);
      if (!name || !text) return res.status(400).json({ message: "이름과 후기를 입력해주세요." });
      if (!(rating >= 1 && rating <= 5)) rating = 5;
      if (text.length > 1000) return res.status(400).json({ message: "후기가 너무 깁니다." });
      if (!url || !key) return res.status(200).json({ ok: true, coupon: COUPON, stored: false });
      const r = await fetch(url + "/rest/v1/reviews", {
        method: "POST",
        headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ name, rating: Math.round(rating), text, approved: true }),
      });
      if (!r.ok) { console.error("[reviews] insert fail", await r.text()); return res.status(200).json({ ok: true, coupon: COUPON, stored: false }); }
      return res.status(200).json({ ok: true, coupon: COUPON, stored: true });
    } catch (e) { console.error("[reviews] error", e); return res.status(200).json({ ok: true, coupon: COUPON, stored: false }); }
  }

  return res.status(405).json({ message: "Method Not Allowed" });
}
