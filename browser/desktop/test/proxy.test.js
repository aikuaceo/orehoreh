// 로컬 TLS 서버로 우회 프록시의 ClientHello 분할을 검증한다.
const assert = require('assert');
const tls = require('tls');
const net = require('net');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startBypassProxy, fragmentClientHello } = require('../src/bypass-proxy');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=blocked.example -addext subjectAltName=DNS:blocked.example 2>/dev/null`);

(async () => {
  const reads = [];
  const server = tls.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (s) => {
    s.on('data', (d) => s.end('pong:' + d));
  });
  // TLS 서버 앞에 raw 소켓 관찰용 중계를 둬서 첫 패킷이 몇 번에 나눠 오는지 기록
  const tlsPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const spy = net.createServer((c) => {
    c.setNoDelay(true);
    const u = net.connect(tlsPort, '127.0.0.1');
    c.on('data', (d) => { reads.push(d); u.write(d); });
    u.pipe(c);
  });
  const spyPort = await new Promise((r) => spy.listen(0, '127.0.0.1', () => r(spy.address().port)));

  const proxy = await startBypassProxy({ log: console.log });
  const sock = net.connect(proxy.port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write(`CONNECT 127.0.0.1:${spyPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
  await new Promise((r) => sock.once('data', (d) => { assert.match(d.toString(), /200/); r(); }));
  const t = tls.connect({ socket: sock, servername: 'blocked.example', ca: fs.readFileSync(`${dir}/c.pem`) });
  const reply = await new Promise((res, rej) => { t.on('secureConnect', () => t.write('ping')); t.on('data', (d) => res(d.toString())); t.on('error', rej); });
  assert.strictEqual(reply, 'pong:ping');
  const first = reads[0];
  assert.ok(!first.toString('latin1').includes('blocked.example'), 'SNI must not appear whole in first segment');
  console.log('TLS handshake through fragmented ClientHello: OK; first reads:', reads.slice(0, 4).map((b) => b.length));

  // 레코드 분할 단위 검증: 어느 레코드에도 SNI 전체 문자열이 없어야 함
  const ch = reads.length ? Buffer.concat(reads) : null;
  assert.ok(!ch.subarray(0, 300).toString('latin1').includes('blocked.example'));
  t.destroy(); proxy.close(); server.close(); spy.close();
  console.log('ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
