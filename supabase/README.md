# 오레 펀딩 서버 (Supabase + 토스페이먼츠)

홈페이지(GitHub Pages)는 그대로 두고, 주문·결제 승인·환불·좋아요만 이 서버가 처리합니다.
`index.html`의 설정 칸 3개가 비어 있으면 사이트는 **미리보기 모드**로 돌고 실제 결제는 일어나지 않습니다.

## 1. 프로젝트 만들기

[supabase.com](https://supabase.com)에서 새 프로젝트를 **서울(Northeast Asia (Seoul))** 리전에 만듭니다. 개인정보가 해외로 나가지 않게 하려는 것입니다. 이때 정한 데이터베이스 비밀번호는 따로 보관합니다.

## 2. GitHub에 연결값 넣기 (자동 배포)

`.github/workflows/supabase.yml`이 `supabase/` 폴더가 바뀔 때마다 DB·함수·비밀값을 자동으로 배포합니다.
저장소 → Settings → Secrets and variables → Actions에서 한 번만 넣으면 됩니다.

| 종류 | 이름 | 값 |
| --- | --- | --- |
| Secret | `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens에서 만든 토큰 |
| Secret | `SUPABASE_DB_PASSWORD` | 프로젝트를 만들 때 정한 DB 비밀번호 |
| Variable | `SUPABASE_PROJECT_REF` | 프로젝트 주소 `https://<ref>.supabase.co`의 `<ref>` |
| Secret (선택) | `TOSS_SECRET_KEY` | 토스 시크릿 키. 없으면 토스 문서의 공개 테스트 키로 동작(실제 결제 없음) |
| Secret (선택) | `ADMIN_TOKEN` | 관리 기능용 24자 이상 무작위 문자열 |
| Secret (선택) | `GOOGLE_TTS_API_KEY` | 레온 목소리를 구글 TTS로 만들 때 |

넣은 뒤 Actions → **Deploy payment server** → Run workflow를 누르면 배포됩니다.
`SUPABASE_URL`과 서버용 키는 Supabase가 함수에 자동으로 넣어 줍니다.

## 3. 직접 배포할 때 (CLI)

```bash
supabase link --project-ref <ref>
supabase db push --include-seed
supabase secrets set TOSS_SECRET_KEY=test_gsk_... ALLOWED_ORIGINS=https://orehoreh.com
supabase functions deploy
```

토스와 계약한 뒤에는 토스 개발자센터 → 웹훅에 `https://<ref>.supabase.co/functions/v1/toss-webhook`을 등록합니다(이벤트: PAYMENT_STATUS_CHANGED).

## 4. 사이트에 연결

`index.html`과 `404.html`의 meta 3개를 채웁니다. 셋 다 공개해도 되는 값입니다.

```html
<meta name="oreh-api" content="https://<프로젝트-ref>.supabase.co">
<meta name="oreh-anon-key" content="<publishable key (sb_publishable_...) 또는 legacy anon key>">
<meta name="oreh-toss-client-key" content="test_gck_...">   <!-- 결제위젯 연동 키 -->
```

테스트 키로 결제·취소가 잘 되면, 계약 후 라이브 키(`live_gck_...`, `live_gsk_...`)로 바꿉니다.

## 5. 운영

관리 작업은 `admin-order`로 합니다. 헤더 `x-admin-token`에 ADMIN_TOKEN을 넣습니다.

| action | 하는 일 |
| --- | --- |
| `approve-sponsor` `{sponsorId}` | 가치참여 검수 통과 → 레온 소개 공개(30일), TTS 설정 시 음성 생성 |
| `reject-sponsor` `{sponsorId, note}` | 게시 안 함 (환불은 `cancel`로 따로) |
| `cancel` `{orderId, reason}` | 주문 하나 전액 환불 |
| `refund-campaign` `{campaignId, reason}` | 목표 미달 프로젝트의 리워드 결제 전부 환불 |

기부 응원 프로젝트는 비영리 모집자가 기부금품 모집 등록을 마친 뒤에만 엽니다.
`campaigns`에 `donation_collector`, `donation_reg_no`를 넣어야 `donation_enabled`를 켤 수 있습니다.
지금 코드는 모든 결제를 오레 가맹 계정으로 받습니다. 기부를 열기 전에 기부 결제를 모집자 명의 가맹 계정(또는 지급대행으로 모집자 전용계좌)으로 보내도록 결제 키를 나눠야 합니다.
