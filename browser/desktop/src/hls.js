// HLS(.m3u8) 스트리밍 영상을 하나의 .ts 파일로 저장 (AES-128 암호화 지원, DRM 제외)
'use strict';

const fs = require('fs');
const crypto = require('crypto');

function parseAttrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

async function fetchText(fetchFn, url, headers) {
  const r = await fetchFn(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

async function fetchBuf(fetchFn, url, headers) {
  const r = await fetchFn(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

/** 마스터 플레이리스트면 가장 높은 화질을 고르고, 미디어 플레이리스트를 반환 */
async function resolveMediaPlaylist(fetchFn, url, headers) {
  for (let depth = 0; depth < 3; depth++) {
    const text = await fetchText(fetchFn, url, headers);
    if (!text.includes('#EXT-X-STREAM-INF')) return { url, text };
    const lines = text.split(/\r?\n/);
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bw = parseInt(parseAttrs(lines[i]).BANDWIDTH || '0', 10);
        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
        if (j < lines.length && (!best || bw > best.bw)) best = { bw, uri: lines[j].trim() };
      }
    }
    if (!best) throw new Error('재생 목록에서 영상을 찾지 못했습니다');
    url = new URL(best.uri, url).href;
  }
  throw new Error('재생 목록이 너무 깊습니다');
}

async function downloadHls(fetchFn, url, outPath, { headers = {}, onProgress = () => {} } = {}) {
  const media = await resolveMediaPlaylist(fetchFn, url, headers);
  const lines = media.text.split(/\r?\n/);
  const segs = [];
  let key = null;
  let seq = 0;
  let mediaSeq = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) mediaSeq = seq = parseInt(line.split(':')[1], 10) || 0;
    else if (line.startsWith('#EXT-X-KEY')) {
      const a = parseAttrs(line);
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { uri: new URL(a.URI, media.url).href, iv: a.IV || null };
      else throw new Error('DRM(암호화 방식 ' + a.METHOD + ')이 걸린 영상은 저장할 수 없습니다');
    } else if (line.startsWith('#EXT-X-MAP')) {
      const a = parseAttrs(line);
      segs.push({ uri: new URL(a.URI, media.url).href, key: null, seq: -1 });
    } else if (line && !line.startsWith('#')) {
      segs.push({ uri: new URL(line, media.url).href, key, seq: seq++ });
    }
  }
  if (!segs.length) throw new Error('영상 조각이 없습니다');
  void mediaSeq;

  const keyCache = new Map();
  const out = fs.createWriteStream(outPath);
  try {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      let data = await fetchBuf(fetchFn, s.uri, headers);
      if (s.key) {
        if (!keyCache.has(s.key.uri)) keyCache.set(s.key.uri, await fetchBuf(fetchFn, s.key.uri, headers));
        let iv;
        if (s.key.iv) iv = Buffer.from(s.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
        else {
          iv = Buffer.alloc(16);
          iv.writeUInt32BE(s.seq >>> 0, 12);
        }
        const d = crypto.createDecipheriv('aes-128-cbc', keyCache.get(s.key.uri), iv);
        data = Buffer.concat([d.update(data), d.final()]);
      }
      if (!out.write(data)) await new Promise((r) => out.once('drain', r));
      onProgress((i + 1) / segs.length);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

module.exports = { downloadHls };
