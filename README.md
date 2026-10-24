# AIKUA BOX 홈페이지 — 배포 & 결제 연동 가이드

이 폴더는 **Vercel에 그대로 올리면 배포되는** 완성 프로젝트입니다.
```
index.html · diagnosis.html · success.html · fail.html   ← 화면
api/confirm.js        ← 토스 결제 최종 승인(서버)
api/tax-order.js      ← 세금계산서 사업자정보 저장(서버)
vercel.json · package.json · .env.example
```

## 가장 빠른 배포 (5분)
1. 이 폴더를 GitHub에 올리거나 `vercel` CLI로 바로 배포: 터미널에서 `npx vercel` → 안내 따라 로그인·배포.
2. Vercel 프로젝트 설정 → **Environment Variables** 에 `TOSS_SECRET_KEY` 추가 (테스트: `test_sk_...`).
3. 배포된 주소로 접속 → 결제 버튼 → 결제창→성공→승인까지 **테스트 모드로 즉시 동작**.
4. 로컬 테스트는 `.env.example`을 `.env`로 복사해 키 넣고 `npx vercel dev`.

## 실제 결제(라이브) 전환 3단계
토스페이먼츠로 **실제 결제를 받으려면** 아래 3단계만 하면 됩니다.

---

## 1. 토스페이먼츠 상점 등록 (하루~이틀)
1. https://www.tosspayments.com 에서 사업자(㈜아이콰그룹)로 가입·심사.
2. 승인되면 **클라이언트 키**(공개)와 **시크릿 키**(비공개) 발급.
   - 클라이언트 키: `live_ck_...` → 프론트(`index.html`)에 넣음.
   - 시크릿 키: `live_sk_...` → **서버에만** 넣음(절대 공개 금지).

## 2. index.html 상단 3줄 교체
```js
var CLIENT_KEY  = "live_ck_여기에_발급키";          // 테스트 키 → 라이브 키
var SUCCESS_URL = "https://내도메인.com/success.html";
var FAIL_URL    = "https://내도메인.com/fail.html";
```
> 지금은 토스 공개 **테스트 키**라 결제창은 뜨지만 실제 돈은 빠지지 않습니다. 테스트에 그대로 쓰세요.

## 3. 결제 '최종 승인'은 서버에서 (토스 필수 정책)
정적 파일만으로는 **결제창 호출까지**만 됩니다. 돈을 실제로 확정하려면
`successUrl`로 돌아온 `paymentKey`를 **서버가 시크릿 키로 승인(confirm)** 해야 합니다.
Vercel을 쓰신다면 아래 파일 하나면 됩니다.

**`/api/confirm.js`** (Vercel Serverless Function)
```js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { paymentKey, orderId, amount } = req.body;
  const secret = process.env.TOSS_SECRET_KEY; // 환경변수에 live_sk_... 저장
  const auth = Buffer.from(secret + ":").toString("base64");
  const r = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
    method: "POST",
    headers: { "Authorization": "Basic " + auth, "Content-Type": "application/json" },
    body: JSON.stringify({ paymentKey, orderId, amount })
  });
  const data = await r.json();
  if (!r.ok) return res.status(r.status).json(data); // 승인 실패
  // TODO: 여기서 Supabase에 주문 저장 / 슬랙·메일 알림
  return res.status(200).json(data); // 승인 성공
}
```
그다음 `success.html`에서 주석 처리된 `fetch("/api/confirm", ...)` 블록을 활성화하면 끝입니다.
환경변수 `TOSS_SECRET_KEY`는 Vercel 프로젝트 설정 → Environment Variables에 넣으세요.

---

## 배포 (가장 쉬운 방법)
- **Vercel**: 이 폴더를 그대로 올리면 정적 호스팅 + `/api/confirm` 서버 함수까지 한 번에.
  1. `vercel` CLI 또는 GitHub 연결 → 자동 배포.
  2. 도메인 연결(본인 도메인 or `*.vercel.app`).
- Netlify·Cloudflare Pages도 동일(서버 함수는 각 플랫폼의 Functions 사용).

## 세금계산서 발행 (사업자 고객)
홈페이지 가격 안내 아래 **"세금계산서 발행이 필요하면 여기"** 링크 → 사업자 정보 입력 →
**계좌이체(TRANSFER)** 로 결제하는 흐름이 이미 들어 있습니다. 상용 전환 시 2가지만 하세요.

1. **사업자 정보 저장**: 지금은 브라우저(localStorage)에 임시 저장됩니다.
   `index.html`의 `localStorage.setItem("tax_"+orderId, ...)` 부분을 서버로 바꾸세요.
   ```js
   await fetch("/api/tax-order", { method:"POST", headers:{"Content-Type":"application/json"},
     body: JSON.stringify({ orderId, biz, comp, ceo, email, amount: amt }) });
   ```
   서버는 이 정보를 주문번호(orderId)에 매칭해 DB(Supabase 등)에 저장합니다.

2. **입금 확인 후 세금계산서 발행**: `/api/confirm`에서 결제 승인이 끝나면,
   저장해둔 사업자 정보로 **전자세금계산서**를 발행합니다. 발행은 보통 외부 솔루션 API를 씁니다.
   - **팝빌(Popbill)** 또는 **바로빌** 세금계산서 API (국내에서 가장 흔함), 또는
   - 홈택스에서 수기 발행(건수 적을 때).
   - 발행 후 입력받은 이메일로 세금계산서를 자동 전송.

**중요 — 중복 발행 금지**: 카드로 결제한 건은 **신용카드 매출전표**가 적격증빙이라
세금계산서를 추가로 발행하면 **이중 공제(가산세 위험)** 가 됩니다.
그래서 세금계산서가 필요한 고객은 **계좌이체/현금** 경로로만 받도록 분리했습니다. 이 구분을 유지하세요.

## 더 손보면 좋은 것
- **무료 진단 연결**: `index.html`의 "무료 진단 시작" 버튼 `href`를 진단 페이지 주소로 교체.
- **상담 신청 저장**: 상담 모달의 `TODO` 부분을 구글폼/Supabase/슬랙 웹훅으로 연결.
- **사업자 정보 표기**: 전자상거래법상 푸터에 상호·대표자·사업자번호·통신판매업신고번호·주소·고객센터를 넣어야 합니다(결제 받는 사이트 필수).

문의: info@aikuagroup.com
