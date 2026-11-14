package com.freeway.browser;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** 동영상(MP4 등 파일 / HLS m3u8 스트림)을 휴대폰의 Download 폴더에 저장. 우회 프록시를 거쳐 받는다. */
public class MediaDownloader {
    private static final String CHANNEL = "downloads";
    private static final AtomicInteger IDS = new AtomicInteger(100);

    private final Context ctx;
    private final ExecutorService pool = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final NotificationManager nm;
    private int proxyPort;
    private boolean useProxy;

    public MediaDownloader(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "다운로드", NotificationManager.IMPORTANCE_LOW));
        }
    }

    public void setProxy(boolean on, int port) {
        useProxy = on;
        proxyPort = port;
    }

    public static boolean isHls(String url) {
        return url.toLowerCase().matches(".*\\.m3u8([?#].*)?$");
    }

    public void download(String url, String title, String referer, String userAgent, String mime) {
        final int id = IDS.incrementAndGet();
        final String base = safeName(title);
        toast("다운로드 시작: " + base);
        pool.execute(() -> {
            Saved out = null;
            try {
                Map<String, String> h = new HashMap<>();
                if (referer != null) h.put("Referer", referer);
                if (userAgent != null) h.put("User-Agent", userAgent);
                if (isHls(url)) {
                    out = open(base, ".ts", "video/mp2t");
                    downloadHls(url, h, out.stream, id, base);
                } else {
                    String ext = guessExt(url, mime);
                    out = open(base, ext, mime != null && !mime.isEmpty() ? mime : "video/mp4");
                    downloadFile(url, h, out.stream, id, base);
                }
                out.stream.close();
                out.finish();
                notifyDone(id, base, out.uri, null);
                toast("저장 완료: Download/" + out.name);
            } catch (Exception e) {
                if (out != null) out.abort();
                notifyDone(id, base, null, e.getMessage());
                toast("다운로드 실패: " + e.getMessage());
            }
        });
    }

    // ---------------- HTTP ----------------

    private HttpURLConnection open(String url, Map<String, String> headers) throws IOException {
        URL u = new URL(url);
        Proxy p = useProxy && proxyPort > 0 ? new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", proxyPort)) : Proxy.NO_PROXY;
        HttpURLConnection c = (HttpURLConnection) u.openConnection(p);
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) c.setRequestProperty("Cookie", cookie);
        int code = c.getResponseCode();
        if (code >= 400) throw new IOException("HTTP " + code);
        return c;
    }

    private byte[] fetch(String url, Map<String, String> h) throws IOException {
        HttpURLConnection c = open(url, h);
        try {
            return BypassProxy.readAll(c.getInputStream());
        } finally {
            c.disconnect();
        }
    }

    private void downloadFile(String url, Map<String, String> h, OutputStream out, int id, String name) throws IOException {
        HttpURLConnection c = open(url, h);
        long total = c.getContentLengthLong();
        long done = 0, lastNotify = 0;
        byte[] buf = new byte[64 * 1024];
        try (InputStream in = c.getInputStream()) {
            int n;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
                done += n;
                long now = System.currentTimeMillis();
                if (now - lastNotify > 700) {
                    lastNotify = now;
                    notifyProgress(id, name, total > 0 ? (int) (done * 100 / total) : -1);
                }
            }
        } finally {
            c.disconnect();
        }
    }

    // ---------------- HLS ----------------

    private static final Pattern ATTR = Pattern.compile("([A-Z0-9-]+)=(\"[^\"]*\"|[^,]*)");

    private static Map<String, String> attrs(String line) {
        Map<String, String> m = new HashMap<>();
        Matcher x = ATTR.matcher(line);
        while (x.find()) m.put(x.group(1), x.group(2).replaceAll("^\"|\"$", ""));
        return m;
    }

    private static String abs(String base, String rel) throws IOException {
        return new URL(new URL(base), rel).toString();
    }

    private void downloadHls(String url, Map<String, String> h, OutputStream out, int id, String name) throws Exception {
        String text = new String(fetch(url, h), StandardCharsets.UTF_8);
        for (int depth = 0; text.contains("#EXT-X-STREAM-INF") && depth < 3; depth++) {
            String[] lines = text.split("\r?\n");
            long bestBw = -1;
            String best = null;
            for (int i = 0; i < lines.length; i++) {
                if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                    long bw = 0;
                    try {
                        bw = Long.parseLong(attrs(lines[i]).getOrDefault("BANDWIDTH", "0"));
                    } catch (NumberFormatException ignored) {
                    }
                    int j = i + 1;
                    while (j < lines.length && (lines[j].trim().isEmpty() || lines[j].startsWith("#"))) j++;
                    if (j < lines.length && bw > bestBw) {
                        bestBw = bw;
                        best = lines[j].trim();
                    }
                }
            }
            if (best == null) throw new IOException("재생 목록에서 영상을 찾지 못했습니다");
            url = abs(url, best);
            text = new String(fetch(url, h), StandardCharsets.UTF_8);
        }

        List<String[]> segs = new ArrayList<>(); // {uri, keyUri, iv, seq}
        String keyUri = null, iv = null;
        long seq = 0;
        for (String raw : text.split("\r?\n")) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
                seq = Long.parseLong(line.substring(line.indexOf(':') + 1).trim());
            } else if (line.startsWith("#EXT-X-KEY")) {
                Map<String, String> a = attrs(line);
                String method = a.getOrDefault("METHOD", "NONE");
                if ("NONE".equals(method)) {
                    keyUri = null;
                } else if ("AES-128".equals(method)) {
                    keyUri = abs(url, a.get("URI"));
                    iv = a.get("IV");
                } else {
                    throw new IOException("DRM 보호 영상은 저장할 수 없습니다");
                }
            } else if (line.startsWith("#EXT-X-MAP")) {
                segs.add(new String[]{abs(url, attrs(line).get("URI")), null, null, "-1"});
            } else if (!line.isEmpty() && !line.startsWith("#")) {
                segs.add(new String[]{abs(url, line), keyUri, iv, String.valueOf(seq++)});
            }
        }
        if (segs.isEmpty()) throw new IOException("영상 조각이 없습니다");

        Map<String, byte[]> keys = new HashMap<>();
        for (int i = 0; i < segs.size(); i++) {
            String[] s = segs.get(i);
            byte[] data = fetch(s[0], h);
            if (s[1] != null) {
                byte[] key = keys.get(s[1]);
                if (key == null) {
                    key = fetch(s[1], h);
                    keys.put(s[1], key);
                }
                byte[] ivb = new byte[16];
                if (s[2] != null) {
                    String hex = s[2].replaceFirst("^0[xX]", "");
                    while (hex.length() < 32) hex = "0" + hex;
                    for (int k = 0; k < 16; k++) ivb[k] = (byte) Integer.parseInt(hex.substring(k * 2, k * 2 + 2), 16);
                } else {
                    long sq = Long.parseLong(s[3]);
                    for (int k = 0; k < 8; k++) ivb[15 - k] = (byte) (sq >>> (8 * k));
                }
                Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
                cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(ivb));
                data = cipher.doFinal(data);
            }
            out.write(data);
            notifyProgress(id, name, (i + 1) * 100 / segs.size());
        }
    }

    // ---------------- 저장 ----------------

    private static class Saved {
        OutputStream stream;
        Uri uri;
        String name;
        ContentResolver cr;
        File file;

        void finish() {
            if (cr != null && Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(uri, v, null, null);
            }
        }

        void abort() {
            try {
                stream.close();
            } catch (IOException ignored) {
            }
            if (cr != null) cr.delete(uri, null, null);
            if (file != null) //noinspection ResultOfMethodCallIgnored
                file.delete();
        }
    }

    private Saved open(String base, String ext, String mime) throws IOException {
        Saved s = new Saved();
        s.name = base + ext;
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, s.name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            s.cr = ctx.getContentResolver();
            s.uri = s.cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (s.uri == null) throw new IOException("저장 공간에 파일을 만들 수 없습니다");
            s.stream = s.cr.openOutputStream(s.uri);
        } else {
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File f = new File(dir, s.name);
            for (int i = 1; f.exists(); i++) f = new File(dir, base + " (" + i + ")" + ext);
            s.name = f.getName();
            s.file = f;
            s.stream = new FileOutputStream(f);
            s.uri = Uri.fromFile(f);
        }
        return s;
    }

    private static String guessExt(String url, String mime) {
        String path = url.split("[?#]")[0].toLowerCase();
        for (String e : new String[]{".mp4", ".webm", ".mkv", ".mov", ".m4v", ".flv", ".mp3", ".m4a", ".jpg", ".jpeg", ".png", ".gif", ".webp"}) {
            if (path.endsWith(e)) return e;
        }
        if (mime != null) {
            if (mime.contains("webm")) return ".webm";
            if (mime.startsWith("image/")) return "." + mime.substring(6).replace("jpeg", "jpg");
            if (mime.startsWith("audio/")) return ".m4a";
        }
        return ".mp4";
    }

    static String safeName(String s) {
        if (s == null || s.trim().isEmpty()) s = "video";
        s = s.replaceAll("[\\\\/:*?\"<>|]+", " ").replaceAll("\\s+", " ").trim();
        if (s.length() > 60) s = s.substring(0, 60);
        return s + " " + new java.text.SimpleDateFormat("MMdd-HHmmss", java.util.Locale.ROOT).format(new java.util.Date());
    }

    // ---------------- 알림 ----------------

    private android.app.Notification.Builder builder() {
        return Build.VERSION.SDK_INT >= 26 ? new android.app.Notification.Builder(ctx, CHANNEL) : new android.app.Notification.Builder(ctx);
    }

    private void notifyProgress(int id, String name, int pct) {
        try {
            nm.notify(id, builder()
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setContentTitle(name)
                    .setContentText(pct >= 0 ? "다운로드 중 " + pct + "%" : "다운로드 중…")
                    .setProgress(100, Math.max(pct, 0), pct < 0)
                    .setOngoing(true)
                    .build());
        } catch (SecurityException ignored) {
        }
    }

    private void notifyDone(int id, String name, Uri uri, String error) {
        try {
            android.app.Notification.Builder b = builder()
                    .setSmallIcon(error == null ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_notify_error)
                    .setContentTitle(name)
                    .setContentText(error == null ? "저장 완료 (Download 폴더)" : "실패: " + error)
                    .setAutoCancel(true);
            if (error == null) {
                Intent open = new Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS);
                b.setContentIntent(PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_IMMUTABLE));
            }
            nm.notify(id, b.build());
        } catch (SecurityException ignored) {
        }
    }

    private void toast(String msg) {
        main.post(() -> Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show());
    }
}
