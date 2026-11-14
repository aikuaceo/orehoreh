// 브라우저 화면(주소창 등)과 메인 프로세스 사이의 안전한 연결
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('freeway', {
  pagePreload: pathToFileURL(path.join(__dirname, 'page-preload.js')).href,
  state: () => ipcRenderer.invoke('state'),
  set: (k, v) => ipcRenderer.invoke('set', k, v),
  videoMenu: (wcId) => ipcRenderer.invoke('video-menu', wcId),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  on: (ch, fn) => {
    if (['videos', 'download', 'blocked', 'shortcut'].includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d));
  },
});
