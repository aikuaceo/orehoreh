/* 오레 관리자 화면: 이메일 링크로 로그인한 운영자가 현황을 보고, 가치참여를 검수하고, 환불합니다.
   서버 쪽 확인은 admin-order 함수가 합니다(로그인 세션 + admins 표). 이 파일은 화면만 그립니다. */
(function(){
'use strict';

var API = meta('oreh-api'), KEY = meta('oreh-anon-key');
var FN = API + '/functions/v1/admin-order';
var SESSION_KEY = 'oreh.admin.session';

var NAMES = {
  c1: '의인 치료비 지원 기금', c2: '순직 소방관·경찰관 유가족 장학 기금',
  c3: '세계 의인 기록 숏폼 100편', c4: '레오·레온 기억 키트', c5: '독립운동 한의사 의인 숏폼 50편'
};
var REWARD_NAMES = { rw0: '디지털 기억 카드', rw1: '기억 스티커 세트', rw2: '기억 키링', rw3: '기억 키트', rw4: '기록 동참 패키지' };
var PACKAGE_NAMES = { 'person-30': '개인 가치참여 30일', 'company-30': '기업 가치참여 30일' };
var KIND = { reward: '리워드', donation: '기부', sponsor: '가치참여' };
var TRACK = { reward: '리워드 펀딩', donation: '기부 응원' };
var CAMP_STATUS = { draft: '준비 중(비공개)', soon: '오픈 예정', live: '진행 중', ended: '종료', canceled: '취소' };
var ORDER_STATUS = {
  ready: ['결제 전', 'gray'], paid: ['결제 완료', 'ok'], failed: ['결제 실패', 'red'],
  canceled: ['환불됨', 'blue'], partial_canceled: ['일부 환불', 'blue'], expired: ['만료', 'gray']
};
var ERR = {
  unauthorized: '관리자 권한이 없는 계정입니다. 등록된 관리자 이메일로 로그인해 주세요.',
  not_paid: '아직 결제가 끝나지 않은 신청입니다.',
  campaign_still_running: '아직 진행 중인 프로젝트는 전체 환불할 수 없습니다.',
  order_not_found: '주문을 찾지 못했습니다.', sponsor_not_found: '신청을 찾지 못했습니다.',
  bad_display_name: '기업 이름을 넣어 주세요.', bad_amount: '계약 금액을 숫자로 넣어 주세요 (1,000원 이상).',
  bad_dates: '공개 시작일과 종료일을 확인해 주세요.', bad_email: '담당자 이메일을 확인해 주세요.',
  not_a_pending_license: '이미 입금 확인된 계약입니다.'
};
var LICENSE = '라이선스 계약';

var state = { data: null, tab: 'home', sp: 'pending', od: 'paid', open: null };

/* ---------- 작은 도구 ---------- */
function meta(n){ var m = document.querySelector('meta[name="' + n + '"]'); return m ? m.content : ''; }
function $(s){ return document.querySelector(s); }
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function won(n){ return (Number(n) || 0).toLocaleString('ko-KR') + '원'; }
function when(iso){
  if (!iso) return '';
  var d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);   // 한국 시간
  function p(x){ return String(x).padStart(2, '0'); }
  return d.getUTCFullYear() + '.' + p(d.getUTCMonth() + 1) + '.' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}
function day(s){ return s ? s.replace(/-/g, '.') : ''; }
function campName(id){ return NAMES[id] || id; }
function publicUrl(bucket, path){ return API + '/storage/v1/object/public/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/'); }
function addDaysIso(iso, n){ var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function isLicense(o){ return o && o.method === LICENSE; }
// PUT a file to a signed Storage upload URL, reporting progress
function upload(up, file, onProgress){
  return new Promise(function(res, rej){
    var x = new XMLHttpRequest(); x.open('PUT', up.signedUrl);
    x.setRequestHeader('apikey', KEY); x.setRequestHeader('Content-Type', file.type); x.setRequestHeader('x-upsert', 'true');
    x.upload.onprogress = function(e){ if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded * 100 / e.total)); };
    x.onload = function(){ x.status >= 200 && x.status < 300 ? res() : rej(Object.assign(new Error('업로드 실패 (' + x.status + ')'), { code: 'upload' })); };
    x.onerror = function(){ rej(Object.assign(new Error('업로드 중 연결이 끊겼습니다'), { code: 'upload' })); };
    x.send(file);
  });
}
function checkFile(file, kind){
  if (!file) return null;
  if (kind === 'video') return file.type !== 'video/mp4' ? '소개 영상은 MP4 파일이어야 합니다.' : file.size > 50 * 1024 * 1024 ? '소개 영상은 50MB 이하여야 합니다. 화질을 조금 낮춰 다시 저장해 주세요.' : null;
  return !/^image\/(png|jpeg|webp)$/.test(file.type) ? '로고는 PNG, JPG, WEBP 파일이어야 합니다.' : file.size > 1024 * 1024 ? '로고는 1MB 이하여야 합니다.' : null;
}
function tag(text, kind){ return el('span', 'tag' + (kind ? ' tag--' + kind : ''), text); }
function store(){ try { return window.localStorage; } catch (e) { return null; } }
function show(node, on){ node.hidden = !on; }

/* ---------- 로그인 세션 (Supabase Auth, 이메일 링크) ---------- */
function loadSession(){ try { var s = store(); return s ? JSON.parse(s.getItem(SESSION_KEY) || 'null') : null; } catch (e) { return null; } }
function saveSession(s){ try { var st = store(); if (!st) return; if (s) st.setItem(SESSION_KEY, JSON.stringify(s)); else st.removeItem(SESSION_KEY); } catch (e) { /* 저장 못 해도 이번 화면에서는 동작 */ } }
var session = loadSession();

function authFetch(path, body, token){
  var h = { 'apikey': KEY, 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return fetch(API + '/auth/v1' + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) { var e = new Error(j.msg || j.error_description || j.message || ('HTTP ' + r.status)); e.status = r.status; e.code = j.error_code || j.code || ''; throw e; } return j; }); });
}

function fromHash(){
  if (!location.hash || location.hash.length < 2) return null;
  var q = new URLSearchParams(location.hash.slice(1));
  if (q.get('error') || q.get('error_code')) {
    history.replaceState(null, '', location.pathname);
    return { error: q.get('error_code') || q.get('error') };
  }
  var at = q.get('access_token');
  if (!at) return null;
  var s = { access_token: at, refresh_token: q.get('refresh_token'),
    expires_at: Number(q.get('expires_at')) || Math.floor(Date.now() / 1000) + (Number(q.get('expires_in')) || 3600) };
  history.replaceState(null, '', location.pathname);
  return s;
}

function emailOf(token){
  try { var p = JSON.parse(decodeURIComponent(escape(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); return p.email || ''; } catch (e) { return ''; }
}

function token(){
  if (!session) return Promise.reject(Object.assign(new Error('no session'), { code: 'unauthorized' }));
  if (session.expires_at - 60 > Date.now() / 1000) return Promise.resolve(session.access_token);
  return authFetch('/token?grant_type=refresh_token', { refresh_token: session.refresh_token }).then(function(j){
    session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600) };
    saveSession(session);
    return session.access_token;
  }, function(e){ session = null; saveSession(null); e.code = 'unauthorized'; throw e; });
}

function call(action, payload){
  return token().then(function(t){
    return fetch(FN, { method: 'POST', headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})) });
  }).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (!r.ok) { var e = new Error(j.message || j.error || ('HTTP ' + r.status)); e.code = j.error || ''; e.status = r.status; throw e; }
      return j;
    });
  });
}

function errText(e){
  if (!e) return '';
  if (ERR[e.code]) return ERR[e.code];
  if (e.status === 402) return '토스 결제 쪽에서 처리하지 못했습니다: ' + (e.message || e.code);
  if (e instanceof TypeError) return '서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.';
  return '처리하지 못했습니다: ' + (e.message || e.code || '알 수 없는 오류');
}

/* ---------- 화면 전환 ---------- */
function showLogin(msg, kind){
  show($('#loading'), false); show($('#app'), false); show($('#who'), false); show($('#login'), true);
  var m = $('#loginMsg');
  if (msg) { m.textContent = msg; m.className = 'note' + (kind ? ' note--' + kind : ''); show(m, true); } else show(m, false);
}

function showApp(){
  show($('#loading'), false); show($('#login'), false); show($('#app'), true); show($('#who'), true);
  $('#whoEmail').textContent = (state.data && state.data.admin) || emailOf(session.access_token);
}

function setErr(msg){ var n = $('#appErr'); n.textContent = msg || ''; show(n, !!msg); }

function load(){
  setErr('');
  return call('overview').then(function(d){ state.data = d; showApp(); render(); }, function(e){
    if (e.code === 'unauthorized') { var hadSession = !!session; session = null; saveSession(null); showLogin(hadSession ? ERR.unauthorized : null, hadSession ? 'err' : null); return; }
    if (state.data) { setErr(errText(e)); return; }
    showLogin(errText(e), 'err');
  });
}

/* ---------- 그리기 ---------- */
function render(){
  var d = state.data; if (!d) return;
  var pending = d.sponsors.filter(function(s){ return s.source !== 'license' && s.review_status === 'pending' && s.orders && s.orders.status === 'paid'; }).length;
  var pc = $('#pendingCount'); pc.textContent = pending; show(pc, pending > 0);
  document.querySelectorAll('.tab').forEach(function(b){ b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === state.tab)); });
  ['home', 'sponsors', 'license', 'orders'].forEach(function(t){ show($('#tab-' + t), state.tab === t); });
  if (state.tab === 'home') renderHome(pending);
  if (state.tab === 'sponsors') renderSponsors();
  if (state.tab === 'license') renderLicense();
  if (state.tab === 'orders') renderOrders();
}

function renderHome(pending){
  var d = state.data, paid = d.orders.filter(function(o){ return o.status === 'paid'; });
  var today = d.today, todayPaid = paid.filter(function(o){ return when(o.paid_at || o.created_at).slice(0, 10) === day(today); });
  var sum = function(list){ return list.reduce(function(a, o){ return a + (o.amount_krw || 0); }, 0); };
  var k = $('#kpis'); k.textContent = '';
  [['오늘 결제', won(sum(todayPaid)), todayPaid.length + '건'],
   ['전체 결제', won(sum(paid)), paid.length + '건 (최근 300건 기준)'],
   ['가치참여 매출', won(sum(paid.filter(function(o){ return o.kind === 'sponsor'; }))), '광고 매출'],
   ['검수 대기', pending + '건', pending ? '가치참여 검수 탭에서 처리' : '없음']].forEach(function(x){
    var c = el('div', 'kpi'); c.appendChild(el('span', null, x[0])); c.appendChild(el('b', null, x[1])); c.appendChild(el('span', null, x[2])); k.appendChild(c);
  });

  var box = $('#camps'); box.textContent = '';
  var stats = {}; d.stats.forEach(function(s){ stats[s.campaign_id] = s; });
  d.campaigns.forEach(function(c){
    var s = stats[c.id] || { raised_krw: 0, backers: 0, sponsors: 0, likes: 0 };
    var pct = c.goal_krw ? Math.floor(s.raised_krw * 100 / c.goal_krw) : 0;
    var card = el('article', 'card camp');
    var head = el('div', 'item__head'); head.appendChild(el('h3', null, campName(c.id)));
    head.appendChild(tag(TRACK[c.track] || c.track, c.track === 'donation' ? 'blue' : null));
    head.appendChild(tag(CAMP_STATUS[c.status] || c.status, c.status === 'live' ? 'ok' : 'gray'));
    card.appendChild(head);
    var bar = el('div', 'bar'); var fill = el('i'); fill.style.width = Math.min(100, pct) + '%'; bar.appendChild(fill); card.appendChild(bar);
    var f = el('div', 'facts');
    [['모인 금액', won(s.raised_krw) + ' (' + pct + '%)'], ['목표', won(c.goal_krw)], ['참여', s.backers + '명'], ['가치참여', s.sponsors + '건'], ['좋아요', s.likes]].forEach(function(x){
      var sp = el('span', null, x[0] + ' '); sp.appendChild(el('b', null, String(x[1]))); f.appendChild(sp);
    });
    card.appendChild(f);
    card.appendChild(el('p', 'muted', '기간 ' + day(c.starts_on) + ' ~ ' + day(c.ends_on) + (c.track === 'donation' ? (c.donation_enabled ? ' · 기부 열림' : ' · 기부는 모집 등록 전이라 닫혀 있음') : '')));
    // 목표 미달로 끝난 리워드 프로젝트: 전체 환불
    var over = d.today > c.ends_on || c.status === 'canceled';
    if (over && s.backers > 0 && s.raised_krw < c.goal_krw) {
      card.appendChild(confirmBox('refund-campaign:' + c.id, '목표 미달 · 전체 환불',
        '이 프로젝트의 결제 ' + s.backers + '건(' + won(s.raised_krw) + ')을 모두 환불할까요? 되돌릴 수 없습니다.',
        function(){ return call('refund-campaign', { campaignId: c.id, reason: '목표 금액 미달로 전액 환불' }).then(function(r){
          var ok = (r.results || []).filter(function(x){ return x.refunded; }).length; return ok + '건 환불했습니다.'; }); }));
    }
    box.appendChild(card);
  });
}

function renderSponsors(){
  var d = state.data, list = $('#spList'); list.textContent = '';
  document.querySelectorAll('#spFilters .chip').forEach(function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-f') === state.sp)); });
  var rows = d.sponsors.filter(function(s){ return s.source !== 'license' && s.review_status === state.sp; });
  var unpaid = 0;
  if (state.sp === 'pending') {   // 결제를 끝내지 않은 신청은 검수할 것이 없으므로 숨깁니다
    unpaid = rows.filter(function(s){ return s.orders.status !== 'paid'; }).length;
    rows = rows.filter(function(s){ return s.orders.status === 'paid'; });
  }
  if (unpaid) list.appendChild(el('p', 'muted', '결제를 끝내지 않은 신청 ' + unpaid + '건은 숨겼습니다.'));
  if (!rows.length) { list.appendChild(el('p', 'empty', state.sp === 'pending' ? '검수할 가치참여가 없습니다.' : '해당하는 신청이 없습니다.')); return; }
  rows.forEach(function(s){
    var o = s.orders || {}, card = el('article', 'card item');
    var head = el('div', 'item__head');
    head.appendChild(tag(s.sponsor_type === 'company' ? '기업' : '개인', s.sponsor_type === 'company' ? 'blue' : null));
    head.appendChild(el('h3', null, s.display_name));
    var st = ORDER_STATUS[o.status] || [o.status, 'gray']; head.appendChild(tag(st[0], st[1]));
    if (s.review_status === 'approved') {
      var live = d.today >= (s.show_from || '') && d.today <= (s.show_until || '');
      head.appendChild(tag(live ? '공개 중 ~' + day(s.show_until) : '공개 끝 ' + day(s.show_until), live ? 'ok' : 'gray'));
    }
    card.appendChild(head);
    var body = el('div', 'item__body');
    var logo = el('div', 'logo');
    if (s.logo_path) { var img = el('img'); img.alt = s.display_name + ' 로고'; img.src = API + '/storage/v1/object/public/sponsor-logos/' + s.logo_path.split('/').map(encodeURIComponent).join('/'); logo.appendChild(img); }
    else logo.textContent = s.display_name.slice(0, 1);
    body.appendChild(logo);
    var info = el('div'); info.style.display = 'grid'; info.style.gap = '6px';
    info.appendChild(el('p', 'quote', s.message ? '“' + s.message + '”' : '(한마디 없음)'));
    var m = el('div', 'meta');
    [['프로젝트', campName(s.campaign_id)], ['금액', won(o.amount_krw)], ['신청자', (o.buyer_name || '') + ' · ' + (o.buyer_email || '')],
     ['신청 시각', when(s.created_at)], ['언어', { ko: '한국어', en: '영어', zh: '번체 중국어' }[s.lang] || s.lang], ['주문번호', o.order_id]].forEach(function(x){
      var sp = el('span', null, x[0] + ' '); sp.appendChild(el('b', null, x[1] || '')); m.appendChild(sp);
    });
    info.appendChild(m);
    if (s.review_note) info.appendChild(el('p', 'muted', '반려 사유: ' + s.review_note));
    body.appendChild(info); card.appendChild(body);

    if (s.review_status === 'pending' && o.status === 'paid') {
      var acts = el('div', 'actions');
      var ok = el('button', 'btn btn--ok btn--s', '승인하고 공개'); ok.type = 'button';
      ok.addEventListener('click', function(){ run(ok, function(){ return call('approve-sponsor', { sponsorId: s.id }).then(function(r){ return '승인했습니다. ' + day(r.showUntil) + '까지 레온이 소개합니다.'; }); }); });
      acts.appendChild(ok);
      card.appendChild(acts);
      card.appendChild(confirmBox('reject:' + s.id, '반려하고 환불', '반려하면 결제 ' + won(o.amount_krw) + '이 전액 환불됩니다.',
        function(note){ return call('reject-sponsor', { sponsorId: s.id, note: note }).then(function(r){ return r.refunded && r.refunded.refunded ? '반려하고 환불했습니다.' : '반려했습니다.'; }); }, '반려 사유 (신청자에게 안내할 내용)'));
    } else if (s.review_status === 'pending') {
      card.appendChild(el('p', 'muted', '결제가 끝나면 검수할 수 있습니다.'));
    }
    list.appendChild(card);
  });
}

function orderItem(o){
  if (isLicense(o)) return '라이선스 계약' + (o.agreements && o.agreements.contract_no ? ' ' + o.agreements.contract_no : '');
  if (o.kind === 'reward' && o.reward_id) { var k = o.reward_id.split('-').pop(); return REWARD_NAMES[k] || o.reward_id; }
  if (o.kind === 'sponsor') return PACKAGE_NAMES[o.package_id] || o.package_id || '가치참여';
  return KIND[o.kind] || o.kind;
}

function renderOrders(){
  var d = state.data, list = $('#odList'); list.textContent = '';
  document.querySelectorAll('#odFilters .chip').forEach(function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-f') === state.od)); });
  var rows = d.orders.filter(function(o){
    if (state.od === 'paid') return o.status === 'paid';
    if (state.od === 'canceled') return o.status === 'canceled' || o.status === 'partial_canceled';
    return true;
  });
  if (!rows.length) { list.appendChild(el('p', 'empty', '해당하는 주문이 없습니다.')); return; }
  rows.forEach(function(o){
    var card = el('article', 'card order');
    var a = el('div');
    var t = el('div', 'item__head'); t.appendChild(tag(KIND[o.kind] || o.kind, o.kind === 'sponsor' ? 'blue' : null)); t.appendChild(el('b', null, orderItem(o)));
    var st = ORDER_STATUS[o.status] || [o.status, 'gray'];
    if (isLicense(o)) { t.appendChild(tag('라이선스', 'blue')); if (o.status === 'ready') st = ['입금 대기', 'gray']; }
    t.appendChild(tag(st[0], st[1])); a.appendChild(t);
    a.appendChild(el('p', 'sub', campName(o.campaign_id)));
    card.appendChild(a);
    var b = el('div', 'who2');
    b.appendChild(el('p', null, o.buyer_name + ' · ' + o.buyer_country));
    b.appendChild(el('p', 'sub', o.buyer_email));
    b.appendChild(el('p', 'sub mono', o.order_id + ' · ' + when(o.paid_at || o.created_at) + (o.method ? ' · ' + o.method : '')));
    card.appendChild(b);
    card.appendChild(el('div', 'amt', won(o.amount_krw)));
    if (isLicense(o)) { licenseActions(card, o); list.appendChild(card); return; }
    if (o.status === 'paid') {
      card.appendChild(confirmBox('cancel:' + o.order_id, '환불', o.buyer_name + ' 님의 ' + won(o.amount_krw) + ' 결제를 전액 환불할까요?',
        function(note){ return call('cancel', { orderId: o.order_id, reason: note || '고객 요청 환불' }).then(function(r){ return r.refunded ? '환불했습니다.' : '환불하지 못했습니다(' + (r.error || r.skipped || '') + ').'; }); }, '환불 사유 (예: 고객 요청)'));
    }
    list.appendChild(card);
  });
}

function licenseActions(card, o){
  if (o.status === 'ready') {
    card.appendChild(confirmBox('paid:' + o.order_id, '입금 확인', won(o.amount_krw) + ' 입금을 확인했나요? 확인하면 바로 공개되고 모인 금액에 반영됩니다.',
      function(){ return call('mark-paid', { orderId: o.order_id }).then(function(){ return '입금 확인했습니다. 지금부터 공개됩니다.'; }); }));
  } else if (o.status === 'paid') {
    card.appendChild(confirmBox('cancel:' + o.order_id, '계약 해지', '계약을 해지하면 소개 영상이 내려가고 모인 금액에서 빠집니다. 받은 금액은 계좌로 직접 돌려주셔야 합니다.',
      function(note){ return call('cancel', { orderId: o.order_id, reason: note || '라이선스 계약 해지' }).then(function(){ return '계약을 해지했습니다. 받은 금액은 계좌로 직접 돌려주세요.'; }); }, '해지 사유'));
  }
}

function renderLicense(){
  var d = state.data, list = $('#licList'); list.textContent = '';
  var rows = d.sponsors.filter(function(s){ return s.source === 'license'; });
  if (!rows.length) { list.appendChild(el('p', 'empty', '등록된 라이선스 파트너가 없습니다.')); return; }
  rows.forEach(function(s){
    var o = s.orders || {}, card = el('article', 'card item');
    var head = el('div', 'item__head'); head.appendChild(tag('라이선스', 'blue')); head.appendChild(el('h3', null, s.display_name));
    if (o.status === 'ready') head.appendChild(tag('입금 대기', 'gray'));
    else if (o.status === 'paid') {
      var live = d.today >= (s.show_from || '') && d.today <= (s.show_until || '');
      head.appendChild(tag(live ? '공개 중' : d.today < (s.show_from || '') ? '공개 예정' : '공개 끝', live ? 'ok' : 'gray'));
    } else head.appendChild(tag((ORDER_STATUS[o.status] || [o.status])[0], 'red'));
    card.appendChild(head);
    var m = el('div', 'meta');
    [['프로젝트', campName(s.campaign_id)], ['계약 금액', won(o.amount_krw)], ['계약번호', (o.agreements && o.agreements.contract_no) || '-'],
     ['공개 기간', day(s.show_from) + ' ~ ' + day(s.show_until)], ['담당자', (o.buyer_name || '') + ' · ' + (o.buyer_email || '')], ['주문번호', o.order_id]].forEach(function(x){
      var sp = el('span', null, x[0] + ' '); sp.appendChild(el('b', null, x[1] || '')); m.appendChild(sp);
    });
    card.appendChild(m);
    var media = el('div', 'item__body');
    var logo = el('div', 'logo');
    if (s.logo_path) { var img = el('img'); img.alt = s.display_name + ' 로고'; img.src = publicUrl('sponsor-logos', s.logo_path); logo.appendChild(img); } else logo.textContent = s.display_name.slice(0, 1);
    media.appendChild(logo);
    var right = el('div'); right.style.display = 'grid'; right.style.gap = '8px';
    if (s.video_path) { var v = el('video', 'film'); v.controls = true; v.preload = 'metadata'; v.src = publicUrl('sponsor-videos', s.video_path); right.appendChild(v); }
    else right.appendChild(el('p', 'muted', '소개 영상이 아직 없습니다. 영상을 올리기 전까지는 레온 기본 소개("가치참여에 함께 했습니다")가 나옵니다.'));
    var acts = el('div', 'actions');
    acts.appendChild(filePicker(s.video_path ? '소개 영상 바꾸기' : '소개 영상 올리기', 'video/mp4', 'video', s));
    acts.appendChild(filePicker(s.logo_path ? '로고 바꾸기' : '로고 올리기', 'image/png,image/jpeg,image/webp', 'logo', s));
    right.appendChild(acts);
    media.appendChild(right); card.appendChild(media);
    licenseActions(card, o);
    list.appendChild(card);
  });
}

function filePicker(label, accept, kind, s){
  var wrap = el('label', 'btn btn--line btn--s'); wrap.textContent = label;
  var inp = el('input'); inp.type = 'file'; inp.accept = accept; inp.hidden = true; wrap.appendChild(inp);
  inp.addEventListener('change', function(){
    var f = inp.files && inp.files[0]; var bad = checkFile(f, kind);
    if (!f) return; if (bad) { setErr(bad); return; }
    wrap.textContent = '올리는 중…';
    call('upload-url', { sponsorId: s.id, kind: kind, type: f.type })
      .then(function(r){ return upload(r.upload, f, function(pc){ wrap.textContent = '올리는 중… ' + pc + '%'; }); })
      .then(function(){ return load().then(function(){ flash(kind === 'video' ? '소개 영상을 올렸습니다.' : '로고를 올렸습니다.'); }); }, function(e){ setErr(errText(e)); wrap.textContent = label; });
  });
  return wrap;
}

function openLicenseForm(){
  var d = state.data, sel = $('#licCamp'); sel.textContent = '';
  d.campaigns.filter(function(c){ return c.status !== 'draft'; }).forEach(function(c){ var op = el('option', null, campName(c.id)); op.value = c.id; sel.appendChild(op); });
  if (d.campaigns.some(function(c){ return c.id === 'c5'; })) sel.value = 'c5';
  $('#licFrom').value = d.today; $('#licUntil').value = addDaysIso(d.today, 364);
  show($('#licErr'), false); show($('#licForm'), true); $('#licName').focus();
}

function saveLicense(ev){
  ev.preventDefault();
  var err = $('#licErr'); show(err, false);
  function fail(msg){ err.textContent = msg; show(err, true); }
  var name = $('#licName').value.trim(), amount = Number(String($('#licAmount').value).replace(/[^0-9]/g, '')), email = $('#licEmail').value.trim();
  var logo = $('#licLogo').files[0] || null, video = $('#licVideo').files[0] || null;
  if (!name) return fail(ERR.bad_display_name);
  if (!amount || amount < 1000) return fail(ERR.bad_amount);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(ERR.bad_email);
  var bad = checkFile(logo, 'logo') || checkFile(video, 'video'); if (bad) return fail(bad);
  var btn = $('#licSave'); btn.disabled = true; btn.textContent = '등록하는 중…';
  call('add-license', {
    campaignId: $('#licCamp').value, displayName: name, amountKrw: amount, contractNo: $('#licNo').value.trim(),
    contactName: $('#licContact').value.trim(), contactEmail: email, showFrom: $('#licFrom').value, showUntil: $('#licUntil').value,
    paid: $('#licPaid').checked, logoType: logo ? logo.type : '', video: !!video
  }).then(function(r){
    var steps = Promise.resolve();
    if (logo && r.logoUpload) steps = steps.then(function(){ btn.textContent = '로고 올리는 중…'; return upload(r.logoUpload, logo); });
    if (video && r.videoUpload) steps = steps.then(function(){ return upload(r.videoUpload, video, function(pc){ btn.textContent = '영상 올리는 중… ' + pc + '%'; }); });
    return steps;
  }).then(function(){
    $('#licForm').reset(); show($('#licForm'), false); btn.disabled = false; btn.textContent = '등록하기';
    return load().then(function(){ flash(name + ' 라이선스 계약을 등록했습니다.'); });
  }, function(e){ btn.disabled = false; btn.textContent = '등록하기'; fail(errText(e)); load(); });
}

/* 되돌릴 수 없는 일은 한 번 더 묻습니다. 브라우저 확인창 대신 화면 안에서 묻습니다. */
function confirmBox(id, label, question, action, notePlaceholder){
  var wrap = el('div'); wrap.style.gridColumn = '1/-1';
  if (state.open !== id) {
    var acts = el('div', 'actions');
    var b = el('button', 'btn btn--line btn--s', label); b.type = 'button';
    b.addEventListener('click', function(){ state.open = id; render(); });
    acts.appendChild(b); wrap.appendChild(acts); return wrap;
  }
  var box = el('div', 'confirm');
  box.appendChild(el('p', null, question));
  var note = null;
  if (notePlaceholder) { var f = el('label', 'field'); note = el('input'); note.type = 'text'; note.maxLength = 200; note.placeholder = notePlaceholder; f.appendChild(note); box.appendChild(f); }
  var acts2 = el('div', 'actions');
  var yes = el('button', 'btn btn--danger btn--s', label + ' 확정'); yes.type = 'button';
  var no = el('button', 'btn btn--line btn--s', '취소'); no.type = 'button';
  yes.addEventListener('click', function(){ run(yes, function(){ return action(note ? note.value.trim() : ''); }); });
  no.addEventListener('click', function(){ state.open = null; render(); });
  acts2.appendChild(yes); acts2.appendChild(no); box.appendChild(acts2);
  wrap.appendChild(box);
  setTimeout(function(){ (note || yes).focus(); }, 0);
  return wrap;
}

function run(btn, fn){
  btn.disabled = true; var label = btn.textContent; btn.textContent = '처리 중…'; setErr('');
  fn().then(function(msg){ state.open = null; return load().then(function(){ flash(msg); }); }, function(e){ btn.disabled = false; btn.textContent = label; setErr(errText(e)); });
}

function flash(msg){
  if (!msg) return;
  var n = $('#appErr'); n.textContent = msg; n.className = 'note note--ok'; show(n, true);
  setTimeout(function(){ if (n.textContent === msg) { show(n, false); n.className = 'note note--err'; } }, 6000);
}

/* ---------- 이벤트 ---------- */
document.querySelectorAll('.tab').forEach(function(b){ b.addEventListener('click', function(){ state.tab = b.getAttribute('data-tab'); state.open = null; render(); }); });
document.querySelectorAll('#spFilters .chip').forEach(function(b){ b.addEventListener('click', function(){ state.sp = b.getAttribute('data-f'); state.open = null; render(); }); });
document.querySelectorAll('#odFilters .chip').forEach(function(b){ b.addEventListener('click', function(){ state.od = b.getAttribute('data-f'); state.open = null; render(); }); });
$('#licNew').addEventListener('click', openLicenseForm);
$('#licCancel').addEventListener('click', function(){ $('#licForm').reset(); show($('#licForm'), false); });
$('#licForm').addEventListener('submit', saveLicense);
$('#refresh').addEventListener('click', function(){ var b = this; b.disabled = true; load().then(function(){ b.disabled = false; }); });

$('#loginForm').addEventListener('submit', function(ev){
  ev.preventDefault();
  var email = $('#loginEmail').value.trim().toLowerCase(), btn = $('#loginBtn');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showLogin('이메일 주소를 확인해 주세요.', 'err'); return; }
  btn.disabled = true;
  authFetch('/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { email: email, create_user: true })
    .then(function(){ showLogin(email + ' 로 로그인 메일을 보냈습니다. 메일은 영어로 옵니다(보낸 곳 Supabase, 제목 "Your Magic Link" 또는 처음에는 "Confirm Your Signup"). 메일 안의 링크를 누르면 이 화면으로 돌아와 로그인됩니다. 스팸함도 확인해 주세요.', 'ok'); },
      function(e){ showLogin(e.status === 429 ? '로그인 메일을 너무 자주 요청했습니다. 지금은 한 시간에 두 번까지 보낼 수 있으니 잠시 뒤에 다시 시도해 주세요.' : '로그인 메일을 보내지 못했습니다. 관리자로 등록된 이메일인지 확인해 주세요. (' + e.message + ')', 'err'); })
    .then(function(){ btn.disabled = false; });
});

$('#logout').addEventListener('click', function(){
  var t = session && session.access_token; session = null; saveSession(null); state.data = null;
  if (t) authFetch('/logout', {}, t).catch(function(){});
  showLogin('로그아웃했습니다.');
});

/* ---------- 시작 ---------- */
function start(){
  var h = fromHash();
  if (h && h.error) { showLogin(h.error === 'otp_expired' ? '로그인 링크가 만료되었거나 이미 사용되었습니다. 다시 받아 주세요.' : '로그인하지 못했습니다. 링크를 다시 받아 주세요.', 'err'); return; }
  if (h) { session = h; saveSession(session); }
  if (session) load(); else showLogin();
}
window.addEventListener('hashchange', function(){ if (/access_token=|error=/.test(location.hash)) start(); });
start();
})();
