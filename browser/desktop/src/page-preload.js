// 웹페이지 preload: 페이지 스크립트보다 먼저 광고/팝업 차단 스크립트를 페이지에 주입
'use strict';
const { ipcRenderer, webFrame } = require('electron');
try {
  webFrame.executeJavaScript(ipcRenderer.sendSync('guard-source'));
} catch (_) {}
