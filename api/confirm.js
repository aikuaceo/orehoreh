// AIKUA BOX — 토스페이먼츠 결제 승인 (Vercel Serverless Function)
// 환경변수 TOSS_SECRET_KEY 에 라이브 시크릿 키(live_sk_...)를 넣으세요. (테스트: test_sk_...)
// 엔드포인트: POST /api/confirm  { paymentKey, orderId, amount }
//
// [보안] 동일 출처만 허용 / 메서드·본문 검증 / 오류 상세는 서버 로그에만 남기고 클라이언트엔 일반 메시지만 반환.

// 허용 출처 (배포 도메인). 필요 시 추가하세요.
const ALLOWED_HOSTS = [
  "aikuabox.com",
  "www.aikuabox.com",
];
function sameOrigin(req) {
  // 로컬/프리뷰 및 Origin 미포함 요청은 허용, 그 외 Origin은 호스트 화이트리스트로 제한
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    if (h === "localhost" || h.endsWith(".vercel.app")) return true;
    return ALLOWED_HOSTS.includes(h);
  } catch { return false; }
}
function str(v, max) { return (typeof v === "string" ? v : "").slice(0, max); }

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ message: "Method Not Allowed" });
  if (!sameOrigin(req)) return res.status(403).json({ message: "Forbidden" });

  try {
    const body = req.body || {};
    const paymentKey = str(body.paymentKey, 200);
    const orderId = str(body.orderId, 100);
    const amount = Number(body.amount);

    if (!paymentKey || !orderId || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      return res.status(400).json({ message: "요청 값이 올바르지 않습니다." });
    }
    // paymentKey/orderId 형식 가드 (영숫자·_-만)
    if (!/^[A-Za-z0-9_-]+$/.test(orderId) || !/^[A-Za-z0-9_-]+$/.test(paymentKey)) {
      return res.status(400).json({ message: "요청 값 형식이 올바르지 않습니다." });
    }

    const secret = process.env.TOSS_SECRET_KEY;
    if (!secret) {
      console.error("[confirm] TOSS_SECRET_KEY missing");
      return res.status(500).json({ message: "결제 설정 오류. 관리자에게 문의해주세요." });
    }
    const auth = Buffer.from(secret + ":").toString("base64");
    const r = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
      method: "POST",
      headers: { Authorization: "Basic " + auth, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentKey, orderId, amount: Math.round(amount) }),
    });
    const data = await r.json();
    if (!r.ok) {
      // 승인 실패 (금액 위변조·중복 승인 등) — 토스가 주는 메시지/코드만 전달
      return res.status(r.status).json({ code: data.code, message: data.message || "결제 승인에 실패했습니다." });
    }
    // TODO: 승인 성공 → Supabase 등에 주문 저장 / 슬랙·메일 알림
    return res.status(200).json({ ok: true, orderId: data.orderId, totalAmount: data.totalAmount, method: data.method, approvedAt: data.approvedAt });
  } catch (e) {
    console.error("[confirm] error", e);              // 상세는 서버 로그에만
    return res.status(500).json({ message: "승인 처리 중 오류가 발생했습니다." });
  }
}
