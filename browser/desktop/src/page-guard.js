// 모든 웹페이지에 문서 시작 시점(페이지 스크립트보다 먼저)에 주입되는 보호 스크립트.
//  - window.open 팝업 광고 차단
//  - 클릭/우클릭/길게누르기 시 열리는 광고 링크 차단
//  - 사이트가 막아둔 우클릭(contextmenu) 해제
//  - 동영상 위를 덮는 투명 광고 레이어 제거
// 데스크톱(Electron)과 안드로이드(WebView)가 같은 코드를 쓴다.
(function () {
  if (window.__freewayGuard) return;
  window.__freewayGuard = true;

  var here = location.hostname.replace(/^www\./, '');

  // 같은 사이트 안의 창 열기만 허용, 다른 사이트(광고)로 가는 팝업은 차단
  var origOpen = window.open;
  var guardedOpen = function (url) {
    if (url && sameSite(String(url))) return origOpen.apply(window, arguments);
    return null;
  };
  try {
    Object.defineProperty(window, 'open', { value: guardedOpen, writable: false, configurable: false });
  } catch (e) {
    window.open = guardedOpen;
  }
  function sameSite(href) {
    try {
      var h = new URL(href, location.href).hostname.replace(/^www\./, '');
      return h === here || h.endsWith('.' + here) || here.endsWith('.' + h);
    } catch (e) {
      return true;
    }
  }

  // 사이트의 우클릭 차단 무력화 + 우클릭 시 광고 실행 차단
  ['contextmenu'].forEach(function (type) {
    window.addEventListener(
      type,
      function (e) {
        e.stopImmediatePropagation();
      },
      true
    );
  });
  // 우클릭/휠클릭으로 마우스 이벤트가 광고를 여는 것 차단
  ['mousedown', 'mouseup', 'auxclick', 'pointerdown', 'pointerup'].forEach(function (type) {
    window.addEventListener(
      type,
      function (e) {
        if (e.button === 2) e.stopImmediatePropagation();
      },
      true
    );
  });

  // 새 창(target=_blank)으로 다른 사이트를 여는 링크 클릭 차단 (광고 오버레이의 전형적인 수법)
  window.addEventListener(
    'click',
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (/^\s*javascript:/i.test(href)) return;
      if ((a.target === '_blank' || a.target === '_new') && !sameSite(a.href)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  // 동영상 위를 덮고 있는 투명/광고 레이어 제거
  function sweep() {
    var videos = document.querySelectorAll('video');
    if (!videos.length) return;
    videos.forEach(function (v) {
      var r = v.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) return;
      var points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + r.width / 4, r.top + r.height / 4],
      ];
      points.forEach(function (p) {
        var el = document.elementFromPoint(p[0], p[1]);
        var guard = 0;
        while (el && el !== v && !el.contains(v) && guard++ < 5) {
          var cs = getComputedStyle(el);
          var link = el.tagName === 'A' ? el : el.querySelector && el.querySelector('a[href]');
          var transparent = parseFloat(cs.opacity) < 0.15 || (cs.backgroundColor === 'rgba(0, 0, 0, 0)' && !el.children.length && !el.textContent.trim());
          var foreignLink = link && !sameSite(link.href);
          var isIframeAd = el.tagName === 'IFRAME' && !sameSite(el.src);
          if ((cs.position === 'absolute' || cs.position === 'fixed') && (transparent || foreignLink || isIframeAd)) {
            el.remove();
            el = document.elementFromPoint(p[0], p[1]);
          } else break;
        }
      });
    });
  }
  setInterval(sweep, 1500);
  document.addEventListener('DOMContentLoaded', sweep);

  // 길게 누르기(모바일) 위치 기록 → 해당 위치의 영상 찾기
  window.addEventListener(
    'touchstart',
    function (e) {
      if (!e.touches || !e.touches[0]) return;
      var x = e.touches[0].clientX,
        y = e.touches[0].clientY;
      window.__fwTouch = [x, y];
      // 안드로이드 앱: 손가락 아래에 영상이 있는지 앱에 미리 알려 둔다 (길게 누르면 다운로드 메뉴)
      if (window.FreewayBridge) {
        try {
          window.FreewayBridge.touch(window.__fwVideosAt(x, y), location.href);
        } catch (err) {}
      }
    },
    true
  );

  function srcOf(v) {
    var s = v.currentSrc || v.src || '';
    if (!s || s.indexOf('blob:') === 0) {
      var so = v.querySelector('source[src]');
      if (so) s = so.src;
    }
    return s;
  }

  // 지정 좌표(없으면 화면에서 가장 큰 영상)의 동영상 주소 목록 반환
  window.__fwVideosAt = function (x, y) {
    var out = [];
    var all = Array.prototype.slice.call(document.querySelectorAll('video'));
    var hit = null;
    if (x != null) {
      var els = document.elementsFromPoint(x, y);
      for (var i = 0; i < els.length; i++) {
        if (els[i].tagName === 'VIDEO') {
          hit = els[i];
          break;
        }
        var inner = els[i].querySelector && els[i].querySelector('video');
        if (inner) {
          hit = inner;
          break;
        }
      }
    }
    if (hit) all.unshift(hit);
    all.forEach(function (v) {
      var s = srcOf(v);
      if (s && out.indexOf(s) === -1) out.push(s);
      else if (!s && out.indexOf('blob:') === -1) out.push('blob:');
    });
    return JSON.stringify({ hit: !!hit, urls: out, title: document.title });
  };
})();
