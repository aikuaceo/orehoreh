// AIKUA BOX — 브랜드 심화 질의지 접수 (Vercel Serverless Function)
// 엔드포인트: POST /api/questionnaire  { ...폼 필드, orderId, email, lang, submittedAt }
//
// [보안] 동일 출처만 허용 / 본문 크기·필드 길이 제한 / 오류 상세는 서버 로그에만.
// [TODO] 상용: 아래 저장/알림부를 Supabase insert + 메일(예: Resend) 로 연결하세요.

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

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ message: "Method Not Allowed" });
  if (!sameOrigin(req)) return res.status(403).json({ message: "Forbidden" });

  try {
    const body = req.body || {};
    // 본문 크기 방어 (대략적) — 과도한 페이로드 차단
    if (JSON.stringify(body).length > 20000) {
      return res.status(413).json({ message: "요청이 너무 큽니다." });
    }
    // 각 필드 문자열·길이 정리 (최대 2,000자), 키 개수 제한
    const clean = {};
    const keys = Object.keys(body).slice(0, 80);
    for (const k of keys) {
      const safeKey = String(k).slice(0, 40);
      const v = body[k];
      clean[safeKey] = (typeof v === "string") ? v.slice(0, 2000) : (v == null ? "" : String(v).slice(0, 200));
    }

    // TODO: Supabase insert
    // const { createClient } = await import("@supabase/supabase-js");
    // const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    // await db.from("questionnaires").insert({ order_id: clean.orderId, payload: clean });
    //
    // TODO: 메일 알림 (예: Resend) — 환경변수 RESEND_API_KEY
    // await fetch("https://api.resend.com/emails", { method:"POST",
    //   headers:{ Authorization:"Bearer "+process.env.RESEND_API_KEY, "Content-Type":"application/json" },
    //   body: JSON.stringify({ from:"noreply@aikuagroup.com", to:"info@aikuagroup.com",
    //     subject:"[심화질의지] "+(clean.writer||clean.orderId||"신규"), text: JSON.stringify(clean, null, 2) }) });

    console.log("[questionnaire] received", { orderId: clean.orderId || "-", writer: clean.writer || "-", lang: clean.lang || "-" });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[questionnaire] error", e);
    return res.status(500).json({ message: "접수 중 오류가 발생했습니다." });
  }
}
