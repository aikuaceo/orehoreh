/* 오레 관리자 화면: 이메일 링크로 로그인한 운영자가 현황을 보고, 가치참여를 검수하고, 환불합니다.
   서버 쪽 확인은 admin-order 함수가 합니다(로그인 세션 + admins 표). 이 파일은 화면만 그립니다. */
(function(){
'use strict';

var API = meta('oreh-api'), KEY = meta('oreh-anon-key');
var FN = API + '/functions/v1/admin-order';
var SESSION_KEY = 'oreh.admin.session';

var NAMES = {
  c1: '의인 치료비 지원 기금', c2: '순직 소방관·경찰관 유가족 장학 기금',
  c3: '세계 의인 기록 숏폼 100편', c4: '레오·레온 기억 키트'
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
  order_not_found: '주문을 찾지 못했습니다.', sponsor_not_found: '신청을 찾지 못했습니다.'
};

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
  var pending = d.sponsors.filter(function(s){ return s.review_status === 'pending' && s.orders && s.orders.status === 'paid'; }).length;
  var pc = $('#pendingCount'); pc.textContent = pending; show(pc, pending > 0);
  document.querySelectorAll('.tab').forEach(function(b){ b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === state.tab)); });
  ['home', 'sponsors', 'orders'].forEach(function(t){ show($('#tab-' + t), state.tab === t); });
  if (state.tab === 'home') renderHome(pending);
  if (state.tab === 'sponsors') renderSponsors();
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
  var rows = d.sponsors.filter(function(s){ return s.review_status === state.sp; });
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
    var st = ORDER_STATUS[o.status] || [o.status, 'gray']; t.appendChild(tag(st[0], st[1])); a.appendChild(t);
    a.appendChild(el('p', 'sub', campName(o.campaign_id)));
    card.appendChild(a);
    var b = el('div', 'who2');
    b.appendChild(el('p', null, o.buyer_name + ' · ' + o.buyer_country));
    b.appendChild(el('p', 'sub', o.buyer_email));
    b.appendChild(el('p', 'sub mono', o.order_id + ' · ' + when(o.paid_at || o.created_at) + (o.method ? ' · ' + o.method : '')));
    card.appendChild(b);
    card.appendChild(el('div', 'amt', won(o.amount_krw)));
    if (o.status === 'paid') {
      card.appendChild(confirmBox('cancel:' + o.order_id, '환불', o.buyer_name + ' 님의 ' + won(o.amount_krw) + ' 결제를 전액 환불할까요?',
        function(note){ return call('cancel', { orderId: o.order_id, reason: note || '고객 요청 환불' }).then(function(r){ return r.refunded ? '환불했습니다.' : '환불하지 못했습니다(' + (r.error || r.skipped || '') + ').'; }); }, '환불 사유 (예: 고객 요청)'));
    }
    list.appendChild(card);
  });
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
$('#refresh').addEventListener('click', function(){ var b = this; b.disabled = true; load().then(function(){ b.disabled = false; }); });

$('#loginForm').addEventListener('submit', function(ev){
  ev.preventDefault();
  var email = $('#loginEmail').value.trim().toLowerCase(), btn = $('#loginBtn');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showLogin('이메일 주소를 확인해 주세요.', 'err'); return; }
  btn.disabled = true;
  authFetch('/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { email: email, create_user: true })
    .then(function(){ showLogin(email + ' 로 로그인 링크를 보냈습니다. 메일함(스팸함도)에서 링크를 눌러 주세요. 링크는 1시간 동안 쓸 수 있습니다.', 'ok'); },
      function(e){ showLogin(e.status === 429 ? '링크를 너무 자주 요청했습니다. 1분쯤 뒤에 다시 시도해 주세요.' : '링크를 보내지 못했습니다: ' + e.message, 'err'); })
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
