package com.freeway.browser;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;

public class MainActivity extends Activity {
    private static final String HOME = "https://www.google.com/";

    private WebView web;
    private EditText urlBar;
    private ProgressBar progress;
    private TextView shield, videoBtn;
    private FrameLayout fullscreen;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;

    private SharedPreferences prefs;
    private BypassProxy proxy;
    private MediaDownloader downloader;
    private String guardJs = "";
    private boolean docStartScript;
    private int blocked;
    private final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());
    private final java.util.concurrent.Executor uiExecutor = ui::post;

    /** 이 페이지에서 감지된 동영상 주소 */
    private final List<String> detected = new CopyOnWriteArrayList<>();
    /** 마지막 터치 지점의 영상 정보 (페이지 스크립트가 알려줌) */
    private volatile String touchInfo;
    private volatile long touchAt;
    private volatile String touchFrameUrl;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_main);
        prefs = getSharedPreferences("freeway", MODE_PRIVATE);
        downloader = new MediaDownloader(this);

        web = findViewById(R.id.web);
        urlBar = findViewById(R.id.url);
        progress = findViewById(R.id.progress);
        shield = findViewById(R.id.shield);
        videoBtn = findViewById(R.id.videos);
        fullscreen = findViewById(R.id.fullscreen);

        try (InputStream in = getAssets().open("page-guard.js")) {
            guardJs = new String(BypassProxy.readAll(in), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
        }

        setupWebView();
        setupBar();

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 2);
        }

        // 우회 엔진 시작 → WebView에 프록시 적용 → 첫 페이지 로드
        proxy = new BypassProxy();
        new Thread(() -> {
            try {
                proxy.start();
            } catch (IOException e) {
                runOnUiThread(() -> toast("우회 엔진 시작 실패: " + e.getMessage()));
            }
            runOnUiThread(() -> applyBypass(() -> {
                Intent i = getIntent();
                String start = i != null && i.getData() != null ? i.getDataString() : (saved == null ? HOME : null);
                if (saved != null) web.restoreState(saved);
                if (start != null) web.loadUrl(start);
            }));
        }).start();
    }

    // ---------------- 우회(VPN) ----------------

    private boolean bypassOn() {
        return prefs.getBoolean("bypass", true);
    }

    private boolean adblockOn() {
        return prefs.getBoolean("adblock", true);
    }

    private void applyBypass(Runnable then) {
        boolean on = bypassOn() && proxy.port() > 0;
        downloader.setProxy(on, proxy.port());
        paintShield();
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            if (on) toast("이 기기의 WebView가 오래되어 우회를 적용할 수 없습니다. Play 스토어에서 'Android System WebView'를 업데이트하세요.");
            if (then != null) then.run();
            return;
        }
        Runnable done = () -> {
            if (then != null) then.run();
        };
        if (on) {
            ProxyConfig cfg = new ProxyConfig.Builder()
                    .addProxyRule("127.0.0.1:" + proxy.port())
                    .addDirect(ProxyConfig.MATCH_ALL_SCHEMES) // 프록시가 죽으면 직접 연결
                    .build();
            ProxyController.getInstance().setProxyOverride(cfg, uiExecutor, done);
        } else {
            ProxyController.getInstance().clearProxyOverride(uiExecutor, done);
        }
    }

    private void paintShield() {
        boolean on = bypassOn();
        shield.setText(on ? "VPN ON" : "VPN OFF");
        shield.setBackgroundResource(on ? R.drawable.pill_on : R.drawable.pill_off);
    }

    // ---------------- WebView ----------------

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setSupportMultipleWindows(true); // 팝업은 onCreateWindow 에서 직접 거른다
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "FreewayBridge");

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && !guardJs.isEmpty()) {
            WebViewCompat.addDocumentStartJavaScript(web, guardJs, Collections.singleton("*"));
            docStartScript = true;
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (adblockOn() && AdBlock.isAdHost(u.getHost())) {
                    blocked++;
                    return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                }
                sniff(u.toString());
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
                if (adblockOn() && AdBlock.isAdHost(u.getHost())) return true; // 광고 사이트로 이동 차단
                if (scheme.equals("http") || scheme.equals("https")) return false;
                if (scheme.equals("tel") || scheme.equals("mailto") || scheme.equals("sms")) {
                    openExternal(u);
                    return true;
                }
                // intent:// market:// 등 앱 실행/설치 유도 링크 — 광고가 많아 사용자가 직접 누른 경우에만 확인 후 열기
                if (req.hasGesture()) confirmExternal(u);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                detected.clear();
                paintVideos();
                setUrl(url);
                if (!docStartScript) view.evaluateJavascript(guardJs, null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                setUrl(url);
                if (!docStartScript) view.evaluateJavascript(guardJs, null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                progress.setProgress(p);
                progress.setVisibility(p >= 100 ? View.INVISIBLE : View.VISIBLE);
            }

            // 팝업 차단: 사용자가 직접 누른 같은 사이트 링크만 현재 화면에서 연다
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                if (!isUserGesture) return false;
                WebView probe = new WebView(MainActivity.this);
                probe.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                        String target = r.getUrl().toString();
                        if (sameSite(target, web.getUrl()) && !AdBlock.isAdHost(r.getUrl().getHost())) web.loadUrl(target);
                        v.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport t = (WebView.WebViewTransport) resultMsg.obj;
                t.setWebView(probe);
                resultMsg.sendToTarget();
                return true;
            }

            // 동영상 전체화면
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customCallback = callback;
                fullscreen.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                fullscreen.setVisibility(View.VISIBLE);
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });

        // 일반 파일 다운로드도 우회 경로로 저장
        web.setDownloadListener((url, ua, contentDisposition, mime, length) -> {
            String name = URLUtil.guessFileName(url, contentDisposition, mime);
            int dot = name.lastIndexOf('.');
            downloader.download(url, dot > 0 ? name.substring(0, dot) : name, web.getUrl(), ua, mime);
        });

        // 길게 누르기 메뉴 (모바일의 '우클릭')
        web.setOnLongClickListener(v -> onLongPress());
    }

    private void exitFullscreen() {
        if (customView == null) return;
        fullscreen.removeView(customView);
        fullscreen.setVisibility(View.GONE);
        customView = null;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        if (customCallback != null) customCallback.onCustomViewHidden();
        customCallback = null;
    }

    private static final String MEDIA_RE = ".*\\.(mp4|m4v|webm|mov|mkv|m3u8|flv)([?#].*)?$";

    private void sniff(String url) {
        String l = url.toLowerCase(Locale.ROOT);
        if (!l.startsWith("http") || !l.matches(MEDIA_RE)) return;
        if (detected.contains(url)) return;
        detected.add(url);
        while (detected.size() > 30) detected.remove(0);
        runOnUiThread(this::paintVideos);
    }

    private void paintVideos() {
        int n = detected.size();
        videoBtn.setText(n > 0 ? "⬇ " + n : "⬇");
        videoBtn.setBackgroundResource(n > 0 ? R.drawable.pill_on : 0);
    }

    /** 페이지 스크립트 → 앱 */
    private class Bridge {
        @JavascriptInterface
        public void touch(String json, String frameUrl) {
            touchInfo = json;
            touchFrameUrl = frameUrl;
            touchAt = System.currentTimeMillis();
        }
    }

    private boolean onLongPress() {
        WebView.HitTestResult hit = web.getHitTestResult();
        int type = hit.getType();
        String extra = hit.getExtra();
        if (type == WebView.HitTestResult.EDIT_TEXT_TYPE) return false;

        // 손가락 아래 영상
        List<String> videoUrls = new ArrayList<>();
        boolean onVideo = false;
        String info = touchInfo;
        if (info != null && System.currentTimeMillis() - touchAt < 3000) {
            try {
                JSONObject o = new JSONObject(info);
                onVideo = o.optBoolean("hit");
                JSONArray a = o.optJSONArray("urls");
                if (onVideo && a != null && a.length() > 0) videoUrls.add(a.getString(0));
            } catch (Exception ignored) {
            }
        }

        List<String> labels = new ArrayList<>();
        List<Runnable> actions = new ArrayList<>();

        if (onVideo) {
            String src = videoUrls.isEmpty() ? null : videoUrls.get(0);
            if (src != null && src.startsWith("http")) {
                labels.add("▶ 이 동영상 다운로드");
                actions.add(() -> downloadVideo(src));
            }
            for (String d : reversed(detected)) {
                if (d.equals(src)) continue;
                labels.add("⬇ " + describe(d));
                actions.add(() -> downloadVideo(d));
            }
            if (labels.isEmpty()) {
                toast("동영상 주소를 아직 찾지 못했습니다. 영상을 재생한 뒤 다시 길게 눌러 주세요.");
                return true;
            }
        }

        if (type == WebView.HitTestResult.SRC_ANCHOR_TYPE && extra != null) {
            final String l = extra;
            labels.add("링크 열기");
            actions.add(() -> web.loadUrl(l));
            labels.add("링크 주소 복사");
            actions.add(() -> copy(l));
            labels.add("다른 앱으로 공유");
            actions.add(() -> share(l));
        }
        if ((type == WebView.HitTestResult.IMAGE_TYPE || type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) && extra != null && extra.startsWith("http")) {
            labels.add("이미지 저장");
            actions.add(() -> downloader.download(extra, "image", web.getUrl(), web.getSettings().getUserAgentString(), "image/jpeg"));
            labels.add("이미지 주소 복사");
            actions.add(() -> copy(extra));
        }

        if (labels.isEmpty()) return false; // 일반 글자 길게 누르기 → 기본 동작(텍스트 선택)

        new AlertDialog.Builder(this)
                .setTitle(onVideo ? "동영상" : (extra != null ? shorten(extra) : null))
                .setItems(labels.toArray(new String[0]), (d, i) -> actions.get(i).run())
                .show();
        return true;
    }

    private void showDetected() {
        if (detected.isEmpty()) {
            toast("감지된 동영상이 없습니다. 영상을 재생하면 여기에 나타납니다.");
            return;
        }
        List<String> list = reversed(detected);
        String[] labels = new String[list.size()];
        for (int i = 0; i < list.size(); i++) labels[i] = describe(list.get(i));
        new AlertDialog.Builder(this)
                .setTitle("감지된 동영상 — 눌러서 다운로드")
                .setItems(labels, (d, i) -> downloadVideo(list.get(i)))
                .show();
    }

    private void downloadVideo(String url) {
        String ref = touchFrameUrl != null ? touchFrameUrl : web.getUrl();
        downloader.download(url, web.getTitle(), ref, web.getSettings().getUserAgentString(), null);
    }

    private static List<String> reversed(List<String> l) {
        List<String> r = new ArrayList<>(l);
        Collections.reverse(r);
        return r;
    }

    private static String describe(String url) {
        Uri u = Uri.parse(url);
        String file = u.getLastPathSegment() == null ? "" : u.getLastPathSegment();
        String kind = MediaDownloader.isHls(url) ? "[HLS] " : "[파일] ";
        return kind + u.getHost() + " … " + (file.length() > 30 ? file.substring(file.length() - 30) : file);
    }

    private static String shorten(String s) {
        return s.length() > 60 ? s.substring(0, 60) + "…" : s;
    }

    // ---------------- 상단/하단 바 ----------------

    private void setupBar() {
        urlBar.setOnEditorActionListener((v, actionId, e) -> {
            boolean enter = e != null && e.getKeyCode() == KeyEvent.KEYCODE_ENTER && e.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                go(urlBar.getText().toString());
                hideKeyboard();
                return true;
            }
            return false;
        });
        findViewById(R.id.back).setOnClickListener(v -> {
            if (web.canGoBack()) web.goBack();
        });
        findViewById(R.id.forward).setOnClickListener(v -> {
            if (web.canGoForward()) web.goForward();
        });
        findViewById(R.id.reload).setOnClickListener(v -> web.reload());
        findViewById(R.id.home).setOnClickListener(v -> web.loadUrl(HOME));
        videoBtn.setOnClickListener(v -> showDetected());
        shield.setOnClickListener(v -> {
            prefs.edit().putBoolean("bypass", !bypassOn()).apply();
            applyBypass(() -> web.reload());
            toast(bypassOn() ? "VPN 우회 켜짐 — 차단된 사이트에 접속할 수 있습니다" : "VPN 우회 꺼짐");
        });
        findViewById(R.id.menu).setOnClickListener(this::showMenu);
    }

    private void showMenu(View anchor) {
        PopupMenu pm = new PopupMenu(this, anchor);
        pm.getMenu().add(0, 1, 0, "VPN 우회").setCheckable(true).setChecked(bypassOn());
        pm.getMenu().add(0, 2, 1, "광고·팝업 차단 (" + blocked + "개 차단)").setCheckable(true).setChecked(adblockOn());
        pm.getMenu().add(0, 3, 2, "감지된 동영상 다운로드");
        pm.getMenu().add(0, 4, 3, "다운로드 폴더 열기");
        pm.getMenu().add(0, 5, 4, "현재 주소 복사");
        pm.getMenu().add(0, 6, 5, "사용 방법");
        pm.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1:
                    shield.performClick();
                    break;
                case 2:
                    prefs.edit().putBoolean("adblock", !adblockOn()).apply();
                    web.reload();
                    toast(adblockOn() ? "광고 차단 켜짐" : "광고 차단 꺼짐");
                    break;
                case 3:
                    showDetected();
                    break;
                case 4:
                    startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
                    break;
                case 5:
                    copy(web.getUrl());
                    break;
                case 6:
                    new AlertDialog.Builder(this).setTitle("Freeway 사용 방법").setMessage(
                            "• VPN 우회: 통신사가 막은 사이트(SNI·DNS 차단)를 별도 서버 없이 열어 줍니다. 기본으로 켜져 있습니다.\n\n" +
                            "• 광고 차단: 광고 도메인, 팝업 창, 영상 위 투명 광고 레이어를 막습니다.\n\n" +
                            "• 동영상 다운로드: 영상을 재생한 뒤 영상을 길게 누르거나, 아래 ⬇ 버튼을 누르세요. 휴대폰의 Download 폴더에 저장됩니다.\n\n" +
                            "※ DRM이 걸린 영상(넷플릭스 등)과 유튜브는 저장되지 않을 수 있습니다. 저작권이 있는 영상은 개인 소장 용도로만 사용하세요.")
                            .setPositiveButton("확인", null).show();
                    break;
            }
            return true;
        });
        pm.show();
    }

    private void go(String text) {
        String t = text.trim();
        if (t.isEmpty()) return;
        String url;
        if (t.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*")) url = t;
        else if (t.matches("^[^\\s]+\\.[^\\s]{2,}(/.*)?$")) url = "https://" + t;
        else {
            try {
                url = "https://www.google.com/search?q=" + URLEncoder.encode(t, "UTF-8");
            } catch (Exception e) {
                url = HOME;
            }
        }
        web.loadUrl(url);
        web.requestFocus();
    }

    private void setUrl(String url) {
        if (!urlBar.hasFocus() && url != null) urlBar.setText(url);
    }

    private static boolean sameSite(String a, String b) {
        if (a == null || b == null) return false;
        String x = Uri.parse(a).getHost(), y = Uri.parse(b).getHost();
        if (x == null || y == null) return false;
        x = x.replaceFirst("^www\\.", "");
        y = y.replaceFirst("^www\\.", "");
        return x.equals(y) || x.endsWith("." + y) || y.endsWith("." + x);
    }

    private void openExternal(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception e) {
            toast("열 수 있는 앱이 없습니다");
        }
    }

    private void confirmExternal(Uri u) {
        new AlertDialog.Builder(this)
                .setMessage("외부 앱을 열려고 합니다. 여시겠습니까?\n" + shorten(u.toString()))
                .setPositiveButton("열기", (d, w) -> {
                    try {
                        Intent i = "intent".equalsIgnoreCase(u.getScheme()) ? Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, u);
                        i.addCategory(Intent.CATEGORY_BROWSABLE);
                        i.setComponent(null);
                        i.setSelector(null);
                        startActivity(i);
                    } catch (Exception e) {
                        toast("열 수 있는 앱이 없습니다");
                    }
                })
                .setNegativeButton("취소", null)
                .show();
    }

    private void copy(String s) {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("url", s));
        toast("복사했습니다");
    }

    private void share(String s) {
        Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, s);
        startActivity(Intent.createChooser(i, "공유"));
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        imm.hideSoftInputFromWindow(urlBar.getWindowToken(), 0);
        urlBar.clearFocus();
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    // ---------------- 생명주기 ----------------

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) web.loadUrl(intent.getDataString());
    }

    @Override
    public void onBackPressed() {
        if (customView != null) exitFullscreen();
        else if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        android.webkit.CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        if (proxy != null) proxy.stop();
        web.destroy();
        super.onDestroy();
    }
}
