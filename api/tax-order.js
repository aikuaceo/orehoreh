// AIKUA BOX — 세금계산서용 사업자 정보 저장 (Vercel Serverless Function)
// 엔드포인트: POST /api/tax-order  { orderId, biz, comp, ceo, email, amount }
//
// [보안] 동일 출처만 허용 / 입력 검증·길이 제한 / 오류 상세는 서버 로그에만.

const ALLOWED_HOSTS = ["aikuabox.com", "www.aikuabox.com"];
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    if (h === "localhost" || h.endsWith(".vercel.app")) return true;
    return ALLOWED_HOSTS.includes(h);
  } catch { return false; }
}
const S = (v, max) => (typeof v === "string" ? v : "").slice(0, max).trim();

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ message: "Method Not Allowed" });
  if (!sameOrigin(req)) return res.status(403).json({ message: "Forbidden" });

  try {
    const b = req.body || {};
    const orderId = S(b.orderId, 100);
    const biz = S(b.biz, 20);
    const comp = S(b.comp, 100);
    const ceo = S(b.ceo, 60);
    const email = S(b.email, 120);
    const amount = Number(b.amount);

    if (!orderId || !biz || !comp || !email) {
      return res.status(400).json({ message: "필수 값이 누락되었습니다." });
    }
    if (!/^\d{3}-?\d{2}-?\d{5}$/.test(biz)) return res.status(400).json({ message: "사업자등록번호 형식 오류" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "이메일 형식 오류" });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return res.status(400).json({ message: "금액 오류" });

    // TODO: Supabase 등 DB에 저장. 입금/승인 확인 후 전자세금계산서(팝빌·바로빌) 발행.
    console.log("[tax-order]", { orderId, biz, comp, ceo, emailDomain: email.split("@")[1], amount });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[tax-order] error", e);
    return res.status(500).json({ message: "저장 중 오류가 발생했습니다." });
  }
}
