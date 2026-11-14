// 우회 엔진 — 유니콘 HTTPS와 같은 방식의 DPI(SNI 검열) 우회 로컬 프록시.
//
// 동작 원리
//  1. 브라우저는 모든 요청을 127.0.0.1:<port> 로 보낸다 (HTTP 프록시).
//  2. 도메인은 통신사 DNS 대신 DNS-over-HTTPS(Cloudflare/Google)로 조회한다 → DNS 차단 우회.
//  3. HTTPS 연결의 첫 패킷(TLS ClientHello)에는 접속할 도메인(SNI)이 평문으로 들어 있어
//     통신사 장비(DPI)가 이를 보고 차단한다. 이 패킷을 SNI 한가운데에서
//     ① TLS 레코드 두 개로 나누고 ② TCP 세그먼트도 여러 개로 쪼개 보내면
//     DPI는 도메인을 읽지 못하고, 실제 서버는 정상적으로 다시 합쳐 읽는다.
//  4. 평문 HTTP 요청은 Host 헤더를 여러 TCP 세그먼트로 나눠 보낸다.
// 서버가 필요 없고, 내 IP는 바뀌지 않는다(접속 차단만 우회).

'use strict';

const net = require('net');
const https = require('https');
const dns = require('dns');

const DOH_SERVERS = [
  { host: '1.1.1.1', path: '/dns-query' },
  { host: '8.8.8.8', path: '/resolve' },
];

const dnsCache = new Map(); // host -> { ip, expires }

function dohQuery(server, host) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: server.host,
        servername: server.host === '1.1.1.1' ? 'cloudflare-dns.com' : 'dns.google',
        path: `${server.path}?name=${encodeURIComponent(host)}&type=A`,
        headers: { accept: 'application/dns-json' },
        timeout: 4000,
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const ans = (json.Answer || []).filter((a) => a.type === 1);
            if (!ans.length) return reject(new Error('no A record'));
            resolve({ ip: ans[0].data, ttl: Math.max(60, ans[0].TTL || 300) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('doh timeout')));
    req.on('error', reject);
  });
}

async function resolveHost(host) {
  if (net.isIP(host)) return host;
  if (host === 'localhost') return '127.0.0.1';
  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.ip;
  for (const s of DOH_SERVERS) {
    try {
      const { ip, ttl } = await dohQuery(s, host);
      dnsCache.set(host, { ip, expires: Date.now() + ttl * 1000 });
      return ip;
    } catch (_) {
      /* 다음 DoH 서버 시도 */
    }
  }
  // DoH가 모두 실패하면 시스템 DNS로
  const { address } = await dns.promises.lookup(host, { family: 4 });
  return address;
}

// ---------- TLS ClientHello 분할 ----------

// ClientHello 레코드 안에서 SNI 호스트 이름이 시작하는 위치(레코드 페이로드 기준)를 찾는다.
function findSniOffset(payload) {
  try {
    let p = 0;
    if (payload[p] !== 0x01) return -1; // handshake type: ClientHello
    p += 4; // type + length(3)
    p += 2 + 32; // version + random
    p += 1 + payload[p]; // session id
    p += 2 + payload.readUInt16BE(p); // cipher suites
    p += 1 + payload[p]; // compression
    const extEnd = p + 2 + payload.readUInt16BE(p);
    p += 2;
    while (p + 4 <= extEnd && p + 4 <= payload.length) {
      const type = payload.readUInt16BE(p);
      const len = payload.readUInt16BE(p + 2);
      if (type === 0x0000) {
        // server_name: list len(2) + name type(1) + name len(2) + name
        const nameLen = payload.readUInt16BE(p + 4 + 3);
        return { start: p + 4 + 5, len: nameLen };
      }
      p += 4 + len;
    }
  } catch (_) {
    /* 형식이 이상하면 분할하지 않음 */
  }
  return -1;
}

// 첫 패킷을 [TCP 세그먼트 목록]으로 바꾼다.
function fragmentClientHello(data) {
  if (data.length < 6 || data[0] !== 0x16) return null;
  const recLen = data.readUInt16BE(3);
  if (data.length < 5 + recLen) return null;
  const payload = data.subarray(5, 5 + recLen);
  const rest = data.subarray(5 + recLen);
  const sni = findSniOffset(payload);
  // SNI 한가운데서 자르기 (못 찾으면 앞쪽에서 자름)
  const cut = sni !== -1 ? sni.start + Math.max(1, Math.floor(sni.len / 2)) : Math.min(40, payload.length - 1);
  const header = (len) => Buffer.from([0x16, data[1], data[2], (len >> 8) & 0xff, len & 0xff]);
  const rec1 = Buffer.concat([header(cut), payload.subarray(0, cut)]);
  const rec2 = Buffer.concat([header(payload.length - cut), payload.subarray(cut)]);
  // TCP도 쪼갠다: 첫 1바이트 / 나머지 첫 레코드 / 두 번째 레코드(+남은 데이터)
  return [rec1.subarray(0, 1), rec1.subarray(1), Buffer.concat([rec2, rest])];
}

// 평문 HTTP: "Host:" 헤더 중간에서 자른다.
function fragmentHttp(data) {
  const s = data.toString('latin1');
  const i = s.search(/\r\nhost:/i);
  if (i === -1) return [data.subarray(0, 1), data.subarray(1)];
  const cut = i + 4; // "\r\nHo" | "st: ..."
  return [data.subarray(0, cut), data.subarray(cut)];
}

function writeSegments(sock, segs, done) {
  let i = 0;
  const next = () => {
    if (sock.destroyed) return;
    if (i >= segs.length) return done();
    const seg = segs[i++];
    if (!seg.length) return next();
    sock.write(seg, () => setTimeout(next, 3)); // 세그먼트가 합쳐지지 않게 약간 간격
  };
  next();
}

// 연결 직후 클라이언트가 보내는 첫 데이터를 모아서(ClientHello 전체) 분할 전송
function tunnel(client, upstream, firstChunk, enabled) {
  let buf = firstChunk || Buffer.alloc(0);
  let finished = false;

  const start = () => {
    if (finished) return;
    finished = true;
    client.removeListener('data', onData);
    clearTimeout(timer);
    let segs = null;
    if (enabled() && buf.length) {
      segs = buf[0] === 0x16 ? fragmentClientHello(buf) : /^[A-Z]+ /.test(buf.toString('latin1', 0, 8)) ? fragmentHttp(buf) : null;
    }
    if (!segs) segs = buf.length ? [buf] : [];
    writeSegments(upstream, segs, () => {
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  };

  const complete = () => {
    if (buf.length >= 5 && buf[0] === 0x16) return buf.length >= 5 + buf.readUInt16BE(3);
    return buf.length > 0;
  };

  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (complete() || buf.length > 16384) {
      client.pause();
      start();
    }
  };

  const timer = setTimeout(start, 1500);
  if (complete()) start();
  else {
    client.on('data', onData);
    client.resume();
  }
}

function connectUpstream(host, port) {
  return resolveHost(host).then(
    (ip) =>
      new Promise((resolve, reject) => {
        const s = net.connect({ host: ip, port, noDelay: true });
        s.setTimeout(15000, () => s.destroy(new Error('connect timeout')));
        s.once('connect', () => {
          s.setTimeout(0);
          s.setNoDelay(true);
          resolve(s);
        });
        s.once('error', reject);
      })
  );
}

/**
 * 우회 프록시 시작.
 * @param {{port?:number, isEnabled?:()=>boolean, log?:(msg:string)=>void}} opts
 * @returns {Promise<{port:number, close:()=>void}>}
 */
function startBypassProxy(opts = {}) {
  const enabled = opts.isEnabled || (() => true);
  const log = opts.log || (() => {});

  const server = net.createServer((client) => {
    client.setNoDelay(true);
    let head = Buffer.alloc(0);
    const onHead = async (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 65536) client.destroy();
        return;
      }
      client.removeListener('data', onHead);
      client.pause();
      const headerText = head.subarray(0, end).toString('latin1');
      const body = head.subarray(end + 4);
      const [requestLine, ...headerLines] = headerText.split('\r\n');
      const [method, target, version] = requestLine.split(' ');

      try {
        if (method === 'CONNECT') {
          const idx = target.lastIndexOf(':');
          const host = target.slice(0, idx).replace(/^\[|\]$/g, '');
          const port = parseInt(target.slice(idx + 1), 10) || 443;
          const upstream = await connectUpstream(host, port);
          wireErrors(client, upstream);
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          tunnel(client, upstream, body, enabled);
        } else {
          // 평문 HTTP (절대 URL 요청) → 원서버용 요청으로 변환
          const url = new URL(target);
          const port = parseInt(url.port, 10) || 80;
          const headers = headerLines.filter((l) => !/^(proxy-connection|connection|keep-alive):/i.test(l));
          if (!headers.some((l) => /^host:/i.test(l))) headers.unshift(`Host: ${url.host}`);
          headers.push('Connection: close');
          const req = Buffer.concat([
            Buffer.from(`${method} ${url.pathname}${url.search} ${version}\r\n${headers.join('\r\n')}\r\n\r\n`, 'latin1'),
            body,
          ]);
          const upstream = await connectUpstream(url.hostname, port);
          wireErrors(client, upstream);
          tunnel(client, upstream, req, enabled);
        }
      } catch (e) {
        log(`proxy error ${target}: ${e.message}`);
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
    };
    client.on('data', onHead);
    client.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

function wireErrors(a, b) {
  const kill = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', kill);
  b.on('error', kill);
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
}

module.exports = { startBypassProxy, resolveHost, fragmentClientHello, findSniOffset };
