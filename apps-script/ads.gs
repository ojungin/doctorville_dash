/**
 * 닥터빌 광고 (대시보드 매출 > 닥터빌 > 광고) — 회원 대시보드 Apps Script 프로젝트에 파일로 추가 (ads.gs)
 *
 * - 대시보드가 action:'ads' 로 요청하면 「2026 닥터빌 광고 운영 현황판」의 통합_Raw 탭을 읽어
 *   현황판(실행월·정산월)과 같은 기준으로 집계한 결과만 돌려줍니다. 대시보드는 이 집계 결과를 DB에 저장합니다.
 * - 컨텍 담당자 · 기안서 번호 · PM/이슈 메모 · 광고 내용은 읽지 않습니다.
 * - 집계 규칙(현황판 '(참고) Setting'): 예약·진행중·완료 = 확정 / 제안·협의중 = 예측 / 실패 = 제외 / 구분 '공지' = 매출 없음
 * - 금액은 만원 단위로 돌려줍니다 (Raw는 원).
 *
 * 설치
 *   1) 파일 추가(+) → 스크립트 → 이름 'ads' → 이 파일 내용 붙여넣기 → 저장
 *   2) Code.gs doPost 의 try { 아래(calendar 줄 근처)에 한 줄 추가:
 *        if (req.action === 'ads') return json_({ ok: true, ads: adsData_(!!req.fresh) }); // 매출 > 광고 (ads.gs)
 *   3) 함수 선택에서 menuCheckAds 실행 → 권한 승인 → 결과 확인 (배포 계정에 광고 현황판 보기 권한 필요)
 *   4) 배포 → 배포 관리 → 편집 → 버전: 새 버전 → 배포
 */
var ADS_SHEET_ID = '19CQLG-d1rb3f64Wr3LAfnurvgoltulVcHKkhYcpOtL8';
var ADS_RAW_TAB = '통합_Raw';
var ADS_SUMMARY_TAB = '광고요약(실행월)';   // 월 목표 (앞뒤 공백 무시)
var ADS_SETTING_TAB = '(참고) Setting';    // 위치·슬롯별 유상 광고칸
var ADS_MAX = { main: 12000, sub: 16200 };   // 월 최대 매출(만원) — 현황판 ② '최대 1.2억 / 1.62억'
var ADS_TARGET_DEFAULT = [4660, 4500, 6130, 8200, 18000, 18000, 20300, 22500, 25800, 25800, 27000, 24800];

function adsData_(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) { var hit = cache.get('ads'); if (hit) { try { return JSON.parse(hit); } catch (e) {} } }
  var ss = SpreadsheetApp.openById(ADS_SHEET_ID);
  var rows = adsRows_(ss), cap = adsCap_(ss), targets = adsTargets_(ss);
  var years = {}, agg = {};
  rows.forEach(function (r) { years[r.y] = 1; years[r.sy] = 1; });
  Object.keys(years).sort().forEach(function (y) {
    y = +y; agg[y] = { exec: adsAgg_(rows, y, 'exec'), settle: adsAgg_(rows, y, 'settle') };
  });
  var out = { v: 1, fetchedAt: new Date().toISOString(), source: ss.getName() + ' · ' + ADS_RAW_TAB, rows: rows.length,
    rule: '예약·진행중·완료 = 확정 · 제안·협의중 = 예측 · 실패 제외 · 공지 제외 · 금액 만원',
    cap: cap, targets: targets, agg: agg, weeks: adsWeeks_(rows), sig: rows.map(adsSig_) };
  try { var j = JSON.stringify(out); if (j.length < 95000) cache.put('ads', j, 600); } catch (e) {}
  return out;
}

function adsTxt_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function adsNum_(v) { var n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return isNaN(n) ? 0 : n; }
function adsMon_(v) { var m = /(\d{1,2})/.exec(String(v || '')); return m ? +m[1] : 0; }
function adsMd_(v) {   // '2026-01-01' / '2026. 1. 1' → '0101'
  var m = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(v || ''));
  return m ? ('0' + m[2]).slice(-2) + ('0' + m[3]).slice(-2) : '';
}
function adsTab_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) ss.getSheets().forEach(function (s) { if (!sh && s.getName().replace(/\s+/g, '') === name.replace(/\s+/g, '')) sh = s; });
  return sh;
}

// 통합_Raw → 필요한 열만 (머리글 이름으로 찾음)
function adsRows_(ss) {
  var sh = adsTab_(ss, ADS_RAW_TAB);
  if (!sh) throw new Error('광고 현황판에서 탭을 찾을 수 없습니다: ' + ADS_RAW_TAB);
  var v = sh.getDataRange().getDisplayValues(), hi = -1;
  for (var i = 0; i < Math.min(v.length, 10); i++) {
    var hs = v[i].map(adsTxt_);
    if (hs.indexOf('실행월') >= 0 && hs.indexOf('상태') >= 0) { hi = i; break; }
  }
  if (hi < 0) throw new Error(ADS_RAW_TAB + ' 탭에서 머리글(실행월·상태) 행을 찾지 못했습니다.');
  var h = v[hi].map(adsTxt_), c = function (n) { return h.indexOf(n); };
  var C = { y: c('연도'), m: c('실행월'), pos: c('위치'), slot: c('슬롯'), gu: c('구분'), co: c('회사'), s: c('시작일'), e: c('마감일'),
    sm: c('정산월'), amt: c('금액(원)'), st: c('상태'), sy: c('정산연도(자동)') };
  ['m', 'pos', 'slot', 'gu', 'co', 'amt', 'st'].forEach(function (k) { if (C[k] < 0) throw new Error(ADS_RAW_TAB + ' 탭 구조가 바뀌었습니다 (열 없음: ' + k + ').'); });
  if (C.y < 0) C.y = 0;
  var out = [];
  for (var r = hi + 1; r < v.length; r++) {
    var x = v[r], co = adsTxt_(x[C.co]), gu = adsTxt_(x[C.gu]);
    if (!co && !adsTxt_(x[C.st])) continue;
    var y = adsNum_(x[C.y]) || new Date().getFullYear(), m = adsMon_(x[C.m]);
    if (!m) continue;
    out.push({ y: y, m: m, pos: adsTxt_(x[C.pos]) + '/' + adsTxt_(x[C.slot]), gu: gu, co: co || '(미기재)',
      s: C.s >= 0 ? adsMd_(x[C.s]) : '', e: C.e >= 0 ? adsMd_(x[C.e]) : '', sm: adsMon_(x[C.sm]) || m,
      sy: (C.sy >= 0 && adsNum_(x[C.sy])) || y, amt: Math.round(adsNum_(x[C.amt]) / 10000), st: adsTxt_(x[C.st]) });
  }
  return out;
}
function adsSig_(r) { return [r.y, r.m, r.pos, r.gu, r.co, r.s, r.e, r.sm, r.amt, r.st].join('|'); }
function adsKind_(r) { return /예약|진행중|완료/.test(r.st) ? 'conf' : /제안|협의중/.test(r.st) ? 'fc' : 'x'; }

// 유상 광고칸 (Setting 탭: 위치 · 슬롯 · 표시 행수 · 유상 광고칸)
function adsCap_(ss) {
  var cap = { main: { n: 29, max: ADS_MAX.main }, sub: { n: 34, max: ADS_MAX.sub } }, sh = adsTab_(ss, ADS_SETTING_TAB);
  if (!sh) return adsCapAll_(cap);
  var v = sh.getDataRange().getDisplayValues(), hi = -1;
  for (var i = 0; i < Math.min(v.length, 10); i++) if (v[i].map(adsTxt_).indexOf('유상 광고칸') >= 0) { hi = i; break; }
  if (hi < 0) return adsCapAll_(cap);
  var h = v[hi].map(adsTxt_), ip = h.indexOf('위치'), ic = h.indexOf('유상 광고칸'), n = { main: 0, sub: 0 };
  for (var r = hi + 1; r < v.length; r++) {
    var p = adsTxt_(v[r][ip]), k = p === '메인' ? 'main' : p === '서브' ? 'sub' : '';
    if (k) n[k] += adsNum_(v[r][ic]);
  }
  if (n.main) cap.main.n = n.main; if (n.sub) cap.sub.n = n.sub;
  return adsCapAll_(cap);
}
function adsCapAll_(cap) { cap.all = { n: cap.main.n + cap.sub.n, max: cap.main.max + cap.sub.max }; return cap; }

// 월 목표(만원): 광고요약(실행월)의 '목표' 행 — 원 단위 행이 있으면 우선, 없으면 '억' 표기 행
function adsTargets_(ss) {
  var t = ADS_TARGET_DEFAULT.slice(), sh = adsTab_(ss, ADS_SUMMARY_TAB);
  if (!sh) return t;
  var v = sh.getDataRange().getDisplayValues(), head = -1, eok = null, won = null;
  for (var i = 0; i < v.length; i++) {
    var row = v[i].map(adsTxt_), j = row.indexOf('1월');
    if (head < 0 && j >= 0 && row[j + 11] === '12월') { head = j; continue; }
    if (head >= 0 && row.indexOf('목표') >= 0) {
      var vals = row.slice(head, head + 12);
      if (vals.some(function (x) { return /억/.test(x); })) { if (!eok) eok = vals; }
      else if (!won) won = vals;
    }
  }
  for (var k = 0; k < 12; k++) {
    var w = won && adsNum_(won[k]), e = eok && adsNum_(eok[k]);
    if (w) t[k] = Math.round(w / 10000); else if (e) t[k] = Math.round(e * 10000);
  }
  return t;
}

// 연도 · 기준(exec 실행월 / settle 정산월)별 월 집계 + 슬롯 현황 + 예측 근거 + 외부 고객사
function adsAgg_(rows, year, basis) {
  var mo = [];
  for (var i = 0; i < 12; i++) mo.push({ conf: 0, cIn: 0, cEx: 0, fc: 0, fIn: 0, fEx: 0, n: 0, nMain: 0, nSub: 0, aMain: 0, aSub: 0 });
  var grid = {}, fc = {}, crm = {};
  rows.forEach(function (r) {
    var y = basis === 'settle' ? r.sy : r.y, m = basis === 'settle' ? r.sm : r.m, k = adsKind_(r);
    if (y !== year || !m || m > 12 || k === 'x' || r.gu === '공지') return;
    var o = mo[m - 1], inn = r.gu === '내부', main = r.pos.indexOf('메인') === 0;
    if (k === 'conf') {
      o.conf += r.amt; if (inn) o.cIn += r.amt; else o.cEx += r.amt; o.n++;
      if (main) { o.nMain++; o.aMain += r.amt; } else { o.nSub++; o.aSub += r.amt; }
    } else {
      o.fc += r.amt; if (inn) o.fIn += r.amt; else o.fEx += r.amt;
      var f = fc[r.co] || (fc[r.co] = { gu: r.gu, m: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }); f.m[m - 1] += r.amt;
    }
    var p = r.pos.replace(/[/]$/, '/(미지정)'), g = grid[p];
    if (!g) { g = grid[p] = []; for (var q = 0; q < 12; q++) g.push([]); }
    g[m - 1].push({ co: r.co, a: r.amt, io: r.gu, k: k, st: r.st });
    if (r.gu === '외부') {
      var c = crm[r.co] || (crm[r.co] = { conf: 0, fc: 0, st: '', last: 0 });
      if (k === 'conf') c.conf += r.amt; else c.fc += r.amt;
      if (m >= c.last) { c.last = m; c.st = r.st; }
    }
  });
  return { months: mo, grid: grid, forecast: fc, crm: crm };
}

// 주간: 확정 건을 시작일~마감일로 일할 배분 (날짜가 없거나 실행월과 겹치지 않으면 실행월 1일~말일)
function adsIsoWeek_(d) {
  var t = new Date(d); t.setUTCDate(t.getUTCDate() + 3 - (t.getUTCDay() + 6) % 7);
  var y = t.getUTCFullYear(), j = new Date(Date.UTC(y, 0, 4));
  return y + '-W' + ('0' + (1 + Math.round(((t - j) / 864e5 - 3 + (j.getUTCDay() + 6) % 7) / 7))).slice(-2);
}
function adsWeeks_(rows) {
  var W = {}, D = 864e5, dt = function (y, md) { return md ? new Date(Date.UTC(y, +md.slice(0, 2) - 1, +md.slice(2))) : null; };
  var get = function (k) { return W[k] || (W[k] = { aIn: 0, aEx: 0, live: {}, start: 0, startAmt: 0 }); };
  rows.forEach(function (r, ri) {
    if (adsKind_(r) !== 'conf' || r.gu === '공지') return;
    var m0 = new Date(Date.UTC(r.y, r.m - 1, 1)), m1 = new Date(Date.UTC(r.y, r.m, 0)), s = dt(r.y, r.s), e = dt(r.y, r.e);
    if (s && e && e < s) e = dt(r.y + 1, r.e);
    if (!s || !e || e < m0 || s > m1) { s = m0; e = m1; }
    var days = Math.round((e - s) / D) + 1;
    for (var t = +s; t <= +e; t += D) {
      var w = get(adsIsoWeek_(t));
      if (r.gu === '내부') w.aIn += r.amt / days; else w.aEx += r.amt / days;
      w.live[ri] = 1;
    }
    var w0 = get(adsIsoWeek_(s)); w0.start++; w0.startAmt += r.amt;
  });
  return Object.keys(W).sort().map(function (k) {
    var w = W[k]; return { week: k, aIn: Math.round(w.aIn), aEx: Math.round(w.aEx), live: Object.keys(w.live).length, start: w.start, startAmt: w.startAmt };
  });
}

// 편집기 실행 또는 시트 메뉴 [대시보드 → 광고 현황판 연결 확인]
function menuCheckAds() {
  var msg;
  try {
    var d = adsData_(true), y = new Date().getFullYear(), A = d.agg[y] && d.agg[y].exec, t = 0, f = 0;
    if (A) A.months.forEach(function (o) { t += o.conf; f += o.fc; });
    msg = '✅ 광고 현황판 연결 정상\n' + d.source + '\nRaw ' + d.rows + '행 · ' + y + '년 확정 ' + (Math.round(t / 100) / 100).toFixed(2) + '억 · 예측 ' + (Math.round(f / 100) / 100).toFixed(2) + '억 (실행월 기준)\n유상 광고칸: 메인 ' + d.cap.main.n + ' · 서브 ' + d.cap.sub.n;
  } catch (e) {
    msg = '❌ 광고 현황판을 읽지 못했습니다: ' + (e && e.message || e) + '\n배포 계정(' + Session.getEffectiveUser().getEmail() + ')에 광고 현황판 보기 권한이 있는지 확인해 주세요.';
  }
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e2) {}
  return msg;
}
