'use strict';
const $ = (id) => document.getElementById(id);
const fw = window.freeway;

const view = document.createElement('webview');
view.setAttribute('partition', 'persist:freeway');
view.setAttribute('preload', fw.pagePreload);
view.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
view.setAttribute('allowpopups', '');
document.body.insertBefore(view, $('downloads'));

let state = {};
let ready = false;

function toUrl(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^[a-z]+:\/\//i.test(t) || t.startsWith('about:')) return t;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(t) || /^localhost(:\d+)?/.test(t)) return 'https://' + t;
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}

function go(text) {
  const u = toUrl(text);
  if (u) view.loadURL(u);
}

function paintToggles() {
  $('bypass').classList.toggle('on', !!state.bypass);
  $('adblock').classList.toggle('on', !!state.adblock);
}

function navState() {
  if (!ready) return;
  $('back').disabled = !view.canGoBack();
  $('fwd').disabled = !view.canGoForward();
}

$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    go($('url').value);
    view.focus();
  }
});
$('url').addEventListener('focus', () => $('url').select());
$('back').onclick = () => view.goBack();
$('fwd').onclick = () => view.goForward();
$('reload').onclick = () => view.reload();
$('home').onclick = () => view.loadURL(state.home);
$('dlfolder').onclick = () => fw.openDownloads();
$('vid').onclick = () => fw.videoMenu(view.getWebContentsId());
$('bypass').onclick = async () => {
  state = { ...state, ...(await fw.set('bypass', !state.bypass)) };
  paintToggles();
  view.reload();
};
$('adblock').onclick = async () => {
  state = { ...state, ...(await fw.set('adblock', !state.adblock)) };
  paintToggles();
  view.reload();
};

view.addEventListener('dom-ready', () => {
  ready = true;
  navState();
});
view.addEventListener('did-navigate', (e) => {
  $('url').value = e.url;
  navState();
});
view.addEventListener('did-navigate-in-page', (e) => {
  if (e.isMainFrame) $('url').value = e.url;
  navState();
});
view.addEventListener('page-title-updated', (e) => (document.title = e.title + ' — Freeway'));
view.addEventListener('did-start-loading', () => {
  $('progress').style.opacity = 1;
  $('progress').style.width = '60%';
});
view.addEventListener('did-stop-loading', () => {
  $('progress').style.width = '100%';
  setTimeout(() => {
    $('progress').style.opacity = 0;
    $('progress').style.width = 0;
  }, 300);
  navState();
});
view.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3 || !e.isMainFrame) return; // -3: 사용자가 취소
  $('url').value = e.validatedURL;
});

fw.on('videos', ({ wcId, count }) => {
  if (ready && wcId !== view.getWebContentsId()) return;
  $('vcount').hidden = !count;
  $('vcount').textContent = count;
});
fw.on('blocked', (n) => ($('blocked').textContent = n));
fw.on('shortcut', (k) => {
  if (k === 'reload') view.reload();
  else if (k === 'back' && view.canGoBack()) view.goBack();
  else if (k === 'forward' && view.canGoForward()) view.goForward();
  else if (k === 'focus') $('url').focus();
  else if (k === 'devtools') view.openDevTools();
});

const cards = new Map();
fw.on('download', (d) => {
  let c = cards.get(d.id);
  if (!c) {
    c = document.createElement('div');
    c.className = 'dl';
    c.innerHTML = '<div class="name"></div><div class="track"><div class="fill"></div></div><div class="sub"></div>';
    $('downloads').appendChild(c);
    cards.set(d.id, c);
  }
  c.querySelector('.name').textContent = d.name;
  if (d.error) {
    c.classList.add('err');
    c.querySelector('.sub').textContent = '실패: ' + d.error;
    setTimeout(() => c.remove(), 10000);
  } else if (d.done) {
    c.classList.add('done');
    c.querySelector('.fill').style.width = '100%';
    c.querySelector('.sub').textContent = '완료 — 클릭하면 폴더에서 보기';
    c.onclick = () => {
      fw.openPath(d.path);
      c.remove();
    };
    setTimeout(() => c.remove(), 15000);
  } else {
    const pct = d.progress >= 0 ? Math.round(d.progress * 100) : null;
    c.querySelector('.fill').style.width = (pct ?? 30) + '%';
    c.querySelector('.sub').textContent = pct == null ? '다운로드 중…' : `다운로드 중… ${pct}%`;
  }
});

(async () => {
  state = await fw.state();
  paintToggles();
  view.setAttribute('src', state.home);
  $('url').value = state.home;
})();
