// 로컬 서버로 HLS 다운로더 검증 (마스터 → 최고화질 선택, AES-128 복호화)
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadHls } = require('../src/hls');

const key = crypto.randomBytes(16);
const segs = [Buffer.from('SEGMENT-ZERO-'.repeat(50)), Buffer.from('SEGMENT-ONE-'.repeat(70))];
const enc = segs.map((b, i) => {
  const iv = Buffer.alloc(16); iv.writeUInt32BE(i + 5, 12);
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(b), c.final()]);
});
const files = {
  '/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nhigh/index.m3u8\n',
  '/high/index.m3u8': '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="/k.bin"\n#EXTINF:4,\ns0.ts\n#EXTINF:4,\ns1.ts\n#EXT-X-ENDLIST\n',
  '/low/index.m3u8': '#EXTM3U\n#EXTINF:4,\nbad.ts\n',
  '/k.bin': key, '/high/s0.ts': enc[0], '/high/s1.ts': enc[1],
};
const srv = http.createServer((q, r) => { const f = files[q.url]; if (!f) { r.statusCode = 404; return r.end(); } r.end(f); });
srv.listen(0, async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hls-')), 'v.ts');
  const prog = [];
  await downloadHls(fetch, `http://127.0.0.1:${srv.address().port}/master.m3u8`, out, { onProgress: (p) => prog.push(p) });
  assert.deepStrictEqual(fs.readFileSync(out), Buffer.concat(segs));
  assert.strictEqual(prog.at(-1), 1);
  console.log('HLS OK');
  srv.close();
});
