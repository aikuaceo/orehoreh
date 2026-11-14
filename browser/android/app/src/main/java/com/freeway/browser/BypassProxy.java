package com.freeway.browser;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 우회 엔진 — 유니콘 HTTPS와 같은 방식의 DPI(SNI 검열) 우회 로컬 프록시.
 *
 * 1. WebView의 모든 요청을 127.0.0.1:port 로 받는다.
 * 2. 도메인은 DNS-over-HTTPS(Cloudflare/Google)로 조회 → 통신사 DNS 차단 우회.
 * 3. HTTPS 첫 패킷(TLS ClientHello)을 SNI(도메인) 한가운데서 TLS 레코드 2개로 나누고,
 *    TCP 세그먼트도 여러 개로 쪼개 보낸다 → 통신사 DPI는 도메인을 못 읽고 서버는 정상 처리.
 * 4. 평문 HTTP는 Host 헤더를 여러 세그먼트로 쪼갠다.
 * 서버가 필요 없고 내 IP는 바뀌지 않는다(차단만 우회).
 */
public class BypassProxy {
    private static final String[][] DOH = {
            {"https://1.1.1.1/dns-query", "cloudflare"},
            {"https://8.8.8.8/resolve", "google"},
    };

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, String[]> dnsCache = new ConcurrentHashMap<>(); // host -> {ip, expiresMillis}
    private ServerSocket server;
    private volatile boolean closed;
    public volatile boolean fragment = true;

    public int start() throws IOException {
        server = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
        pool.execute(() -> {
            while (!closed) {
                try {
                    Socket c = server.accept();
                    pool.execute(() -> handle(c));
                } catch (IOException e) {
                    if (closed) return;
                }
            }
        });
        return server.getLocalPort();
    }

    public int port() {
        return server == null ? 0 : server.getLocalPort();
    }

    public void stop() {
        closed = true;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
    }

    // ---------------- DNS ----------------

    public String resolve(String host) throws IOException {
        if (host.matches("^[0-9.]+$") || host.contains(":")) return host;
        if ("localhost".equals(host)) return "127.0.0.1";
        String[] c = dnsCache.get(host);
        if (c != null && Long.parseLong(c[1]) > System.currentTimeMillis()) return c[0];
        for (String[] s : DOH) {
            try {
                URL u = new URL(s[0] + "?name=" + URLEncoder.encode(host, "UTF-8") + "&type=A");
                HttpURLConnection conn = (HttpURLConnection) u.openConnection(java.net.Proxy.NO_PROXY);
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(4000);
                conn.setRequestProperty("accept", "application/dns-json");
                String body = new String(readAll(conn.getInputStream()), StandardCharsets.UTF_8);
                conn.disconnect();
                JSONArray ans = new JSONObject(body).optJSONArray("Answer");
                if (ans == null) continue;
                for (int i = 0; i < ans.length(); i++) {
                    JSONObject a = ans.getJSONObject(i);
                    if (a.optInt("type") == 1) {
                        int ttl = Math.max(60, a.optInt("TTL", 300));
                        String ip = a.getString("data");
                        dnsCache.put(host, new String[]{ip, String.valueOf(System.currentTimeMillis() + ttl * 1000L)});
                        return ip;
                    }
                }
            } catch (Exception ignored) {
                // 다음 DoH 서버 시도
            }
        }
        return InetAddress.getByName(host).getHostAddress(); // DoH 실패 시 시스템 DNS
    }

    // ---------------- 연결 처리 ----------------

    private void handle(Socket client) {
        Socket upstream = null;
        try {
            client.setTcpNoDelay(true);
            InputStream cin = client.getInputStream();
            OutputStream cout = client.getOutputStream();

            ByteArrayOutputStream headBuf = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int end = -1;
            while (end < 0) {
                int n = cin.read(buf);
                if (n < 0) {
                    client.close();
                    return;
                }
                headBuf.write(buf, 0, n);
                end = indexOf(headBuf.toByteArray(), "\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                if (headBuf.size() > 65536) {
                    client.close();
                    return;
                }
            }
            byte[] all = headBuf.toByteArray();
            String head = new String(all, 0, end, StandardCharsets.ISO_8859_1);
            byte[] body = slice(all, end + 4, all.length);
            String[] lines = head.split("\r\n");
            String[] req = lines[0].split(" ");
            String method = req[0], target = req[1], version = req.length > 2 ? req[2] : "HTTP/1.1";

            byte[] first;
            if ("CONNECT".equalsIgnoreCase(method)) {
                int idx = target.lastIndexOf(':');
                String host = target.substring(0, idx).replace("[", "").replace("]", "");
                int port = Integer.parseInt(target.substring(idx + 1));
                upstream = connect(host, port);
                cout.write("HTTP/1.1 200 Connection Established\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                cout.flush();
                first = readFirstRecord(client, cin, body);
            } else {
                URL url = new URL(target);
                int port = url.getPort() > 0 ? url.getPort() : 80;
                StringBuilder sb = new StringBuilder();
                String path = url.getFile().isEmpty() ? "/" : url.getFile();
                sb.append(method).append(' ').append(path).append(' ').append(version).append("\r\n");
                boolean hasHost = false;
                for (int i = 1; i < lines.length; i++) {
                    String l = lines[i].toLowerCase(Locale.ROOT);
                    if (l.startsWith("proxy-connection:") || l.startsWith("connection:") || l.startsWith("keep-alive:")) continue;
                    if (l.startsWith("host:")) hasHost = true;
                    sb.append(lines[i]).append("\r\n");
                }
                if (!hasHost) sb.append("Host: ").append(url.getAuthority()).append("\r\n");
                sb.append("Connection: close\r\n\r\n");
                first = concat(sb.toString().getBytes(StandardCharsets.ISO_8859_1), body);
                upstream = connect(url.getHost(), port);
            }

            OutputStream uout = upstream.getOutputStream();
            List<byte[]> segs = fragment ? fragmentFirst(first) : null;
            if (segs == null) {
                segs = new ArrayList<>();
                segs.add(first);
            }
            for (byte[] s : segs) {
                if (s.length == 0) continue;
                uout.write(s);
                uout.flush();
                sleep(3); // 세그먼트가 합쳐지지 않도록
            }

            final Socket up = upstream;
            pool.execute(() -> pump(up, client));
            pump(client, upstream);
        } catch (Exception e) {
            try {
                if (upstream == null && !client.isClosed()) {
                    client.getOutputStream().write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                }
            } catch (IOException ignored) {
            }
            closeQuietly(client);
            closeQuietly(upstream);
        }
    }

    private Socket connect(String host, int port) throws IOException {
        Socket s = new Socket();
        s.setTcpNoDelay(true);
        s.connect(new InetSocketAddress(resolve(host), port), 15000);
        return s;
    }

    /** CONNECT 직후 클라이언트가 보내는 TLS ClientHello 레코드 전체를 모은다. */
    private byte[] readFirstRecord(Socket client, InputStream in, byte[] already) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(already);
        byte[] buf = new byte[8192];
        client.setSoTimeout(1500);
        try {
            while (true) {
                byte[] cur = b.toByteArray();
                if (cur.length >= 5 && (cur[0] & 0xff) == 0x16) {
                    int len = ((cur[3] & 0xff) << 8) | (cur[4] & 0xff);
                    if (cur.length >= 5 + len) break;
                } else if (cur.length > 0) break;
                if (cur.length > 16384) break;
                int n = in.read(buf);
                if (n < 0) break;
                b.write(buf, 0, n);
            }
        } catch (SocketTimeoutException ignored) {
        } finally {
            client.setSoTimeout(0);
        }
        return b.toByteArray();
    }

    // ---------------- 분할 ----------------

    static List<byte[]> fragmentFirst(byte[] d) {
        if (d.length == 0) return null;
        if ((d[0] & 0xff) == 0x16) return fragmentClientHello(d);
        String start = new String(d, 0, Math.min(d.length, 8), StandardCharsets.ISO_8859_1);
        if (start.matches("^[A-Z]+ .*")) return fragmentHttp(d);
        return null;
    }

    static List<byte[]> fragmentClientHello(byte[] d) {
        if (d.length < 6) return null;
        int recLen = ((d[3] & 0xff) << 8) | (d[4] & 0xff);
        if (d.length < 5 + recLen) return null;
        byte[] payload = slice(d, 5, 5 + recLen);
        byte[] rest = slice(d, 5 + recLen, d.length);
        int[] sni = findSni(payload);
        int cut = sni != null ? sni[0] + Math.max(1, sni[1] / 2) : Math.min(40, payload.length - 1);
        byte[] rec1 = concat(header(d, cut), slice(payload, 0, cut));
        byte[] rec2 = concat(header(d, payload.length - cut), slice(payload, cut, payload.length));
        List<byte[]> out = new ArrayList<>();
        out.add(slice(rec1, 0, 1));
        out.add(slice(rec1, 1, rec1.length));
        out.add(concat(rec2, rest));
        return out;
    }

    private static byte[] header(byte[] d, int len) {
        return new byte[]{0x16, d[1], d[2], (byte) ((len >> 8) & 0xff), (byte) (len & 0xff)};
    }

    /** ClientHello 안의 SNI 호스트 이름 {시작위치, 길이}. */
    static int[] findSni(byte[] p) {
        try {
            int i = 0;
            if (p[i] != 0x01) return null;
            i += 4 + 2 + 32;
            i += 1 + (p[i] & 0xff);
            i += 2 + u16(p, i);
            i += 1 + (p[i] & 0xff);
            int extEnd = i + 2 + u16(p, i);
            i += 2;
            while (i + 4 <= extEnd && i + 4 <= p.length) {
                int type = u16(p, i), len = u16(p, i + 2);
                if (type == 0) return new int[]{i + 4 + 5, u16(p, i + 4 + 3)};
                i += 4 + len;
            }
        } catch (ArrayIndexOutOfBoundsException ignored) {
        }
        return null;
    }

    static List<byte[]> fragmentHttp(byte[] d) {
        String s = new String(d, StandardCharsets.ISO_8859_1).toLowerCase(Locale.ROOT);
        int i = s.indexOf("\r\nhost:");
        int cut = i >= 0 ? i + 4 : 1;
        List<byte[]> out = new ArrayList<>();
        out.add(slice(d, 0, cut));
        out.add(slice(d, cut, d.length));
        return out;
    }

    // ---------------- 유틸 ----------------

    private static void pump(Socket from, Socket to) {
        byte[] buf = new byte[16384];
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int n;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (IOException ignored) {
        } finally {
            closeQuietly(from);
            closeQuietly(to);
        }
    }

    private static int u16(byte[] b, int i) {
        return ((b[i] & 0xff) << 8) | (b[i + 1] & 0xff);
    }

    static byte[] slice(byte[] b, int from, int to) {
        byte[] r = new byte[Math.max(0, to - from)];
        System.arraycopy(b, from, r, 0, r.length);
        return r;
    }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] r = new byte[a.length + b.length];
        System.arraycopy(a, 0, r, 0, a.length);
        System.arraycopy(b, 0, r, a.length, b.length);
        return r;
    }

    private static int indexOf(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) >= 0) b.write(buf, 0, n);
        in.close();
        return b.toByteArray();
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    static void closeQuietly(Socket s) {
        try {
            if (s != null) s.close();
        } catch (IOException ignored) {
        }
    }
}
