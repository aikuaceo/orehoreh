# Freeway 브라우저

유니콘 HTTPS처럼 **통신사 차단(SNI·DNS)을 우회하는 기능이 기본으로 들어간 브라우저**입니다. 안드로이드 앱과 PC(Windows) 프로그램 두 가지가 있습니다.

## 받기

이 저장소의 **Releases**에 자동으로 올라갑니다 (`browser/`가 바뀔 때마다 GitHub Actions가 새로 빌드합니다).

- 안드로이드: `Freeway-Android.apk` → 설치 (처음 한 번 "출처를 알 수 없는 앱 설치 허용" 필요)
- Windows: `Freeway-Setup-*.exe`(설치형) 또는 `Freeway-Portable-*.exe`(바로 실행)

## 기능

| 기능 | 안드로이드 | PC |
|---|---|---|
| VPN 우회 (기본 ON) | 상단 `VPN ON` 버튼 | 상단 `VPN 우회` 버튼 |
| 광고 도메인 차단 | ✔ | ✔ |
| 팝업·새 창 광고 차단 | ✔ | ✔ |
| 클릭/우클릭 시 열리는 광고, 영상 위 투명 광고 레이어 제거 | ✔ | ✔ |
| 사이트가 막아 둔 우클릭 해제 | — | ✔ |
| 동영상 다운로드 | 영상을 **길게 누르기** 또는 하단 `⬇` | 영상에 **우클릭** 또는 상단 `⬇ 동영상` |
| 스트리밍(HLS .m3u8) 영상 저장 (AES-128 포함) | ✔ | ✔ |

저장 위치: 휴대폰은 `Download` 폴더, PC는 `다운로드` 폴더.

## VPN 우회는 어떻게 동작하나

서버 없이 기기 안에서 돌아가는 로컬 프록시(`127.0.0.1`)가 브라우저의 모든 접속을 처리합니다.

1. **DNS 우회** — 통신사 DNS 대신 DNS-over-HTTPS(Cloudflare 1.1.1.1, Google 8.8.8.8)로 주소를 찾습니다.
2. **SNI 우회** — HTTPS 첫 패킷(ClientHello)에 평문으로 들어 있는 도메인을 통신사 장비(DPI)가 보고 차단합니다. 이 패킷을 도메인 한가운데서 TLS 레코드 두 개로 나누고 TCP 조각도 여러 개로 쪼개 보내, 장비는 도메인을 읽지 못하고 실제 서버는 정상적으로 받게 합니다.
3. **HTTP 우회** — 평문 HTTP는 `Host` 헤더를 여러 조각으로 나눠 보냅니다.

유니콘 HTTPS와 같은 원리이며, **IP 주소는 바뀌지 않습니다**(해외 IP가 필요한 지역 제한 우회용 VPN이 아님). 브라우저 안의 접속에만 적용되고 다른 앱에는 영향을 주지 않습니다.

## 한계

- DRM이 걸린 영상(넷플릭스, 왓챠 등)과 유튜브 스트림은 저장되지 않을 수 있습니다.
- `blob:` 영상은 영상을 한 번 재생해야 실제 주소가 감지됩니다.
- 통신사가 다른 방식(IP 차단 등)으로 막은 사이트는 열리지 않을 수 있습니다.
- 저작권이 있는 영상은 개인 소장 범위에서만 이용하세요.

## 폴더 구성

```
browser/
  desktop/   PC 버전 (Electron) — src/bypass-proxy.js 우회 엔진, src/page-guard.js 광고/팝업 차단 스크립트(안드로이드와 공용)
  android/   안드로이드 버전 (Java, WebView) — BypassProxy.java 우회 엔진, MediaDownloader.java 동영상 저장
```

직접 빌드: `cd browser/desktop && npm install && npm start` / `cd browser/android && gradle assembleRelease` (Android SDK 필요).
