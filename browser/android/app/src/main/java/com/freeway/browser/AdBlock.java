package com.freeway.browser;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** 광고·추적 도메인 차단 목록 (데스크톱 desktop/src/adblock.js 와 동일, 하위 도메인 포함 매칭). */
public final class AdBlock {
    private static final Set<String> HOSTS = new HashSet<>(Arrays.asList(
            "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
            "pagead2.googlesyndication.com", "imasdk.googleapis.com", "google-analytics.com", "googletagservices.com",
            "adnxs.com", "adsrvr.org", "amazon-adsystem.com", "criteo.com",
            "criteo.net", "taboola.com", "outbrain.com", "pubmatic.com",
            "rubiconproject.com", "openx.net", "casalemedia.com", "smartadserver.com",
            "moatads.com", "scorecardresearch.com", "quantserve.com", "adform.net",
            "yieldmo.com", "media.net", "zedo.com", "advertising.com",
            "adcolony.com", "applovin.com", "unityads.unity3d.com", "mopub.com",
            "inmobi.com", "popads.net", "popcash.net", "propellerads.com",
            "propellerclick.com", "adsterra.com", "adsterratech.com", "exoclick.com",
            "exosrv.com", "juicyads.com", "trafficjunky.net", "trafficjunky.com",
            "hilltopads.net", "clickadu.com", "onclickads.net", "onclkds.com",
            "popmyads.com", "adcash.com", "admaven.com", "ad-maven.com",
            "a-ads.com", "clicksor.com", "revcontent.com", "mgid.com",
            "bidvertiser.com", "adskeeper.com", "richpush.co", "pushame.com",
            "monetag.com", "galaksion.com", "trafficstars.com", "tsyndicate.com",
            "realsrv.com", "magsrv.com", "adtng.com", "dtscout.com",
            "acint.net", "onclickperformance.com", "highperformanceformat.com", "profitablecpmrate.com",
            "profitablegatecpm.com", "effectiveratecpm.com", "adpopcorn.com", "mobon.net",
            "dreamsearch.or.kr", "adinc.co.kr", "realclick.co.kr", "tenping.kr",
            "adfit.kakao.com", "display.ad.daum.net", "kakaoad.com", "ad.naver.com",
            "adcr.naver.com", "veta.naver.com", "tivan.naver.com", "nam.veta.naver.com",
            "siape.veta.naver.com", "cauly.co.kr", "adbinder.co.kr", "adlibr.com",
            "interworksmedia.co.kr", "adop.cc", "adtive.com", "targetpush.co.kr",
            "ad4989.co.kr", "linkprice.com", "dable.io", "widerplanet.com",
            "acrosspf.com", "adbrix.io", "mediacategory.com"
    ));

    private AdBlock() {
    }

    public static boolean isAdHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        while (true) {
            if (HOSTS.contains(h)) return true;
            int i = h.indexOf('.');
            if (i < 0) return false;
            h = h.substring(i + 1);
        }
    }
}
