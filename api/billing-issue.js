// AIKUA BOX — 자동결제(빌링) 빌링키 발급 + 첫 회차 결제 (Vercel Serverless Function)
// 엔드포인트: POST /api/billing-issue  { authKey, customerKey, amount, orderName }
//
// [중요] 환경변수 TOSS_SECRET_KEY 는 '일반(API 개별 연동) 시크릿 키' = test_sk_... / live_sk_...
//        (결제위젯 시크릿 test_gsk_ 가 아닙니다. 빌링은 ck/sk 쌍을 씁니다.)
// 흐름: 카드 등록(requestBillingAuth) → successUrl(authKey,customerKey) → 이 API 가
//   ① 빌링키 발급(/v1/billing/authorizations/issue)
//   ② 첫 회차 결제(/v1/billing/{billingKey})
//   ③ (TODO) billingKey+customerKey 저장 → 매월 자동 청구

const ALLOWED_HOSTS = ["aikuabox.com", "www.aikuabox.com"];
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { const h = new URL(o).hostname; if (h === "localhost" || h.endsWith(".vercel.app")) return true; return ALLOWED_HOSTS.includes(h); }
  catch { return false; }
}
const S = (v, m) => (typeof v === "string" ? v : "").slice(0, m);

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ message: "Method Not Allowed" });
  if (!sameOrigin(req)) return res.status(403).json({ message: "Forbidden" });

  try {
    const b = req.body || {};
    const authKey = S(b.authKey, 300);
    const customerKey = S(b.customerKey, 60);
    const amount = Number(b.amount);
    const orderName = S(b.orderName, 100) || "AIKUA BOX 구독";

    if (!authKey || !customerKey || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      return res.status(400).json({ message: "요청 값이 올바르지 않습니다." });
    }
    // 빌링은 '일반 시크릿 키(test_sk_)' 사용. 위젯 confirm(gsk)과 충돌 방지 위해 전용 변수 우선.
    const secret = process.env.TOSS_BILLING_SECRET_KEY || process.env.TOSS_SECRET_KEY;
    if (!secret) {
      console.error("[billing-issue] TOSS_BILLING_SECRET_KEY missing");
      return res.status(500).json({ message: "결제 설정 오류. 관리자에게 문의해주세요." });
    }
    const auth = "Basic " + Buffer.from(secret + ":").toString("base64");

    // 1) 빌링키 발급
    const issueRes = await fetch("https://api.tosspayments.com/v1/billing/authorizations/issue", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ authKey, customerKey }),
    });
    const issued = await issueRes.json();
    if (!issueRes.ok) {
      return res.status(issueRes.status).json({ step: "issue", code: issued.code, message: issued.message || "빌링키 발급에 실패했습니다." });
    }
    const billingKey = issued.billingKey;

    // 2) 첫 회차 결제
    const orderId = "sub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const chargeRes = await fetch("https://api.tosspayments.com/v1/billing/" + encodeURIComponent(billingKey), {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ customerKey, amount: Math.round(amount), orderId, orderName }),
    });
    const charged = await chargeRes.json();
    if (!chargeRes.ok) {
      return res.status(chargeRes.status).json({ step: "charge", billingKeyIssued: true, code: charged.code, message: charged.message || "첫 회차 결제에 실패했습니다." });
    }

    // TODO: billingKey + customerKey 를 DB(Supabase 등)에 저장하고, 매월 /v1/billing/{billingKey} 로 자동 청구
    console.log("[billing-issue] ok", { customerKey, orderId });
    return res.status(200).json({ ok: true, billingKeyIssued: true, orderId: charged.orderId, approvedAt: charged.approvedAt, totalAmount: charged.totalAmount, method: charged.method });
  } catch (e) {
    console.error("[billing-issue] error", e);
    return res.status(500).json({ message: "빌링 처리 중 오류가 발생했습니다." });
  }
}
