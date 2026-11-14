// Freeway 브라우저 (데스크톱) — 우회(VPN) 기본 적용 + 광고·팝업 차단 + 우클릭 영상 다운로드
'use strict';

const { app, BrowserWindow, session, ipcMain, Menu, clipboard, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { startBypassProxy } = require('./bypass-proxy');
const { isAdHost } = require('./adblock');
const { downloadHls } = require('./hls');

const GUARD = fs.readFileSync(path.join(__dirname, 'page-guard.js'), 'utf8');
const HOME = 'https://www.google.com/';

let win = null;
let proxyPort = 0;
let blockedCount = 0;
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { bypass: true, adblock: true };

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch (_) {}
}
function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings));
  } catch (_) {}
}

// 페이지별 감지된 동영상 주소  webContentsId -> [{url, kind, referer}]
const sniffed = new Map();
const MEDIA_EXT = /\.(mp4|m4v|webm|mov|mkv|m3u8|flv)(\?|#|$)/i;

function addSniffed(wcId, url, contentType, referer) {
  if (!wcId || !url || url.startsWith('blob:') || url.startsWith('data:')) return;
  const ct = (contentType || '').toLowerCase();
  const isHls = /mpegurl/.test(ct) || /\.m3u8(\?|#|$)/i.test(url);
  const isVideo = ct.startsWith('video/') || MEDIA_EXT.test(url);
  if (!isHls && !isVideo) return;
  if (/\.ts(\?|$)|\.m4s(\?|$)/i.test(url)) return; // HLS/DASH 조각은 제외
  const list = sniffed.get(wcId) || [];
  if (list.some((v) => v.url === url)) return;
  list.push({ url, kind: isHls ? 'HLS' : 'MP4', referer });
  sniffed.set(wcId, list.slice(-30));
  send('videos', { wcId, count: list.length });
}

function send(ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}

function sameSite(a, b) {
  try {
    const x = new URL(a).hostname.replace(/^www\./, '');
    const y = new URL(b).hostname.replace(/^www\./, '');
    return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
  } catch (_) {
    return false;
  }
}

async function applyProxy(ses) {
  if (settings.bypass) await ses.setProxy({ proxyRules: `http=127.0.0.1:${proxyPort};https=127.0.0.1:${proxyPort}`, proxyBypassRules: '<local>' });
  else await ses.setProxy({ mode: 'direct' });
  await ses.closeAllConnections();
}

function safeName(s) {
  return (s || 'video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

async function downloadVideo(wc, url, referer) {
  const ses = wc.session;
  const title = safeName(wc.getTitle());
  if (/\.m3u8(\?|#|$)/i.test(url) || (sniffed.get(wc.id) || []).some((v) => v.url === url && v.kind === 'HLS')) {
    const out = uniquePath(app.getPath('downloads'), title, '.ts');
    const id = Date.now();
    send('download', { id, name: path.basename(out), progress: 0 });
    try {
      const headers = { Referer: referer || wc.getURL(), 'User-Agent': wc.getUserAgent() };
      await downloadHls((u, o) => ses.fetch(u, o), url, out, {
        headers,
        onProgress: (p) => send('download', { id, name: path.basename(out), progress: p }),
      });
      send('download', { id, name: path.basename(out), progress: 1, done: true, path: out });
    } catch (e) {
      send('download', { id, name: path.basename(out), error: e.message });
      try {
        fs.unlinkSync(out);
      } catch (_) {}
    }
    return;
  }
  wc.downloadURL(url, { headers: { Referer: referer || wc.getURL() } });
}

function videoMenuItems(wc, extraUrl) {
  const items = [];
  const list = sniffed.get(wc.id) || [];
  if (extraUrl && !extraUrl.startsWith('blob:')) {
    items.push({ label: '이 동영상 다운로드', click: () => downloadVideo(wc, extraUrl) });
  }
  if (list.length) {
    items.push({
      label: `감지된 동영상 다운로드 (${list.length})`,
      submenu: list
        .slice()
        .reverse()
        .map((v) => ({
          label: `[${v.kind}] ${shorten(v.url)}`,
          click: () => downloadVideo(wc, v.url, v.referer),
        })),
    });
  } else if (!extraUrl || extraUrl.startsWith('blob:')) {
    items.push({ label: '감지된 동영상 없음 (영상을 재생한 뒤 다시 시도)', enabled: false });
  }
  return items;
}

function shorten(u) {
  try {
    const x = new URL(u);
    const file = x.pathname.split('/').pop() || x.pathname;
    return `${x.hostname} … ${file}`.slice(0, 70);
  } catch (_) {
    return u.slice(0, 70);
  }
}

function setupSession(ses) {
  ses.webRequest.onBeforeRequest((details, cb) => {
    if (settings.adblock) {
      try {
        const u = new URL(details.url);
        if (isAdHost(u.hostname)) {
          blockedCount++;
          send('blocked', blockedCount);
          return cb({ cancel: true });
        }
      } catch (_) {}
    }
    cb({});
  });

  ses.webRequest.onHeadersReceived((details, cb) => {
    const ct = (details.responseHeaders && (details.responseHeaders['content-type'] || details.responseHeaders['Content-Type'])) || [];
    addSniffed(details.webContentsId, details.url, ct[0], details.referrer);
    cb({});
  });

  ses.on('will-download', (_e, item) => {
    const name = item.getFilename() || 'download';
    const ext = path.extname(name);
    const out = uniquePath(app.getPath('downloads'), safeName(path.basename(name, ext)), ext || '.mp4');
    item.setSavePath(out);
    const id = Date.now() + Math.random();
    item.on('updated', () => {
      const total = item.getTotalBytes();
      send('download', { id, name: path.basename(out), progress: total ? item.getReceivedBytes() / total : -1 });
    });
    item.once('done', (_ev, state) => {
      if (state === 'completed') send('download', { id, name: path.basename(out), progress: 1, done: true, path: out });
      else send('download', { id, name: path.basename(out), error: state === 'cancelled' ? '취소됨' : '실패' });
    });
  });
}

function attachToPage(wc) {
  bindShortcuts(wc);
  // 팝업(새 창) 광고 차단 — 같은 사이트로 가는 창만 현재 탭에서 열기
  wc.setWindowOpenHandler(({ url }) => {
    if (sameSite(url, wc.getURL())) wc.loadURL(url);
    return { action: 'deny' };
  });

  wc.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) {
      sniffed.delete(wc.id);
      send('videos', { wcId: wc.id, count: 0 });
    }
  });

  // 광고 사이트로 이동하는 클릭 납치 차단
  wc.on('will-navigate', (e) => {
    try {
      if (settings.adblock && isAdHost(new URL(e.url).hostname)) e.preventDefault();
    } catch (_) {}
  });

  wc.on('context-menu', async (_e, p) => {
    const items = [];
    let videoUrl = null;
    if (p.mediaType === 'video' || p.mediaType === 'audio') videoUrl = p.srcURL || 'blob:';
    else {
      // 영상 위를 다른 요소가 덮고 있을 때도 그 위치의 영상을 찾는다
      try {
        const r = JSON.parse(await wc.executeJavaScript(`window.__fwVideosAt ? window.__fwVideosAt(${p.x / wc.getZoomFactor()}, ${p.y / wc.getZoomFactor()}) : '{}'`));
        if (r.hit) videoUrl = r.urls[0] || 'blob:';
      } catch (_) {}
    }
    if (videoUrl) items.push(...videoMenuItems(wc, videoUrl), { type: 'separator' });

    if (p.linkURL) {
      items.push(
        { label: '링크 열기', click: () => wc.loadURL(p.linkURL) },
        { label: '링크 주소 복사', click: () => clipboard.writeText(p.linkURL) },
        { label: '링크를 기본 브라우저로 열기', click: () => shell.openExternal(p.linkURL) },
        { type: 'separator' }
      );
    }
    if (p.hasImageContents && p.srcURL) {
      items.push(
        { label: '이미지 저장', click: () => wc.downloadURL(p.srcURL) },
        { label: '이미지 주소 복사', click: () => clipboard.writeText(p.srcURL) },
        { type: 'separator' }
      );
    }
    if (p.isEditable) items.push({ role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { type: 'separator' });
    else if (p.selectionText) items.push({ role: 'copy', label: '복사' }, { type: 'separator' });
    if (!videoUrl) items.push(...videoMenuItems(wc, null), { type: 'separator' });
    items.push(
      { label: '뒤로', enabled: wc.canGoBack(), click: () => wc.goBack() },
      { label: '새로고침', click: () => wc.reload() },
      { label: '검사', click: () => wc.inspectElement(p.x, p.y) }
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() === 'webview') attachToPage(wc);
});

ipcMain.on('guard-source', (e) => {
  e.returnValue = GUARD;
});
ipcMain.handle('state', () => ({ ...settings, proxyPort, blocked: blockedCount, home: HOME }));
ipcMain.handle('set', async (_e, key, value) => {
  if (!(key in settings)) return settings;
  settings[key] = !!value;
  saveSettings();
  if (key === 'bypass') await applyProxy(session.fromPartition('persist:freeway'));
  return settings;
});
ipcMain.handle('video-menu', (_e, wcId) => {
  const wc = require('electron').webContents.fromId(wcId);
  if (!wc) return;
  Menu.buildFromTemplate(videoMenuItems(wc, null)).popup({ window: win });
});
ipcMain.handle('open-path', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('open-downloads', () => shell.openPath(app.getPath('downloads')));

app.whenReady().then(async () => {
  loadSettings();
  const proxy = await startBypassProxy({ log: (m) => console.log(m) });
  proxyPort = proxy.port;

  const ses = session.fromPartition('persist:freeway');
  setupSession(ses);
  await applyProxy(ses);

  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Freeway',
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      webviewTag: true,
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  bindShortcuts(win.webContents);
});

function bindShortcuts(wc) {
  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key.toLowerCase();
    if (input.key === 'F12') send('shortcut', 'devtools');
    else if (input.key === 'F5' || (input.control && k === 'r')) send('shortcut', 'reload');
    else if (input.control && k === 'l') send('shortcut', 'focus');
    else if (input.alt && input.key === 'ArrowLeft') send('shortcut', 'back');
    else if (input.alt && input.key === 'ArrowRight') send('shortcut', 'forward');
  });
}

app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (e) => {
  console.error(e);
  if (win) dialog.showErrorBox('오류', String(e && e.message));
});
