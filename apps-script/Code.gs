/**
 * 닥터빌 회원 대시보드 - 집계 웹앱 (구글시트에 붙여 쓰는 Apps Script)
 *
 * 역할
 *  - 대시보드의 [갱신] 버튼을 누르면 시트의 회원 원본을 시트 안에서 집계하고,
 *    집계 결과(개인 식별 정보 없음)만 대시보드로 돌려줍니다.
 *  - 주차별 집계 결과는 이 스프레드시트의 숨김 탭 '_dashboard_history'에 저장되어
 *    주간 변화(활성·동의율 추이 등)를 추적합니다. 원본 행은 스크립트 밖으로 나가지 않습니다.
 *  - 요청은 대시보드 비밀번호로 확인하며, 연속으로 틀리면 잠시 잠깁니다.
 *
 * 이 파일 하나에 집계 로직(DV_AGG)까지 들어 있습니다. aggregate.gs 파일은 더 이상 필요 없습니다
 * (남아 있어도 동작에 영향 없음 — 이 파일은 자체 집계 로직만 사용).
 *
 * 설정 (1회)
 *  1) 회원분석 시트 → 확장 프로그램 → Apps Script
 *  2) Code.gs 내용을 모두 지우고 이 파일 전체를 붙여넣고 저장
 *  3) 시트를 새로고침 → 상단 메뉴 [대시보드] → [비밀번호 설정] → 대시보드 비밀번호 입력 (권한 승인)
 *  4) Apps Script 화면에서 배포 → 새 배포 → 유형: 웹 앱 / 실행 사용자: 나 / 액세스 권한: 모든 사용자 → 배포
 *  5) 웹 앱 URL(…/exec)을 저장소 docs/data/config.json 의 appsScriptUrl 에 입력
 */
var SHEET_NAME = '시트1';                  // 회원 데이터가 있는 탭 이름
var HISTORY_SHEET = '_dashboard_history';  // 주차별 집계 저장 탭 (자동 생성, 숨김)
var MAX_FAILS = 10;                        // 10분 안에 이 횟수만큼 틀리면 잠금
var PW_ITER = 2000;
var HIST_FROM = '2025-W01';                // 과거 주차 재계산을 허용하는 첫 주차
var HIST_FROM_MONTH = '2025-01';           // 과거 월 재계산을 허용하는 첫 달
// 활동성 탭: '닥터빌 주간/월간 데이터 자동 시트' (GA 기반 집계, 개인 식별 정보 없음)
var ACTIVITY_SHEET_ID = '1h-2L8oN7NMJ0BNmc3tJlugis8BetsndeP8-SpG3GgqU';
var ACTIVITY_SHEETS = [   // [응답 키, 시트 이름, 중복 판단 열(0부터)]
  ['weekly', '주간지표', [0, 2]],
  ['monthly', '월간지표', [0, 1]],
  ['pageWeekly', '페이지별지표_주간', [0, 2]],
  ['pageMonthly', '페이지별지표_월간', [0, 1]]
];

// ---- 웹앱 진입점 ---------------------------------------------------------
function doPost(e) {
  var req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('fails') || 0);
  if (fails >= MAX_FAILS) return json_({ ok: false, error: 'locked' });
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PW_HASH') || !props.getProperty('PW_SALT')) return json_({ ok: false, error: 'password_not_set' });
  if (!checkPassword_(String(req.password || ''))) {
    cache.put('fails', String(fails + 1), 600);
    Utilities.sleep(800);
    return json_({ ok: false, error: 'unauthorized' });
  }
  try {
    if (req.action === 'refresh') {
      var snap = buildSnapshot_();
      saveSnapshot_(snap);
      return json_(bundle_(snap.week));
    }
    if (req.action === 'activity') return json_({ ok: true, activity: activityData_(!!req.fresh) }); // 활동성 탭
    if (req.month) return json_({ ok: true, snap: monthSnapshot_(String(req.month)), prev: null }); // 월간 기준 월 선택
    return json_(bundle_(req.week || null)); // action: 'get'
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() { return json_({ ok: false, error: 'use POST' }); }

// ---- 시트 메뉴 -----------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('대시보드')
    .addItem('비밀번호 설정', 'menuSetPassword')
    .addItem('비밀번호 확인 (테스트)', 'menuCheckPassword')
    .addItem('지금 집계하기 (테스트)', 'menuRefresh')
    .addItem('활동성 시트 연결 확인', 'menuCheckActivity')
    .addItem('연동 진단', 'menuDiagnose')
    .addToUi();
}

function menuSetPassword() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('대시보드 비밀번호 설정', '대시보드 로그인 비밀번호와 같은 값을 입력하세요.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var pw = String(r.getResponseText() || '').trim();
  if (!pw) { ui.alert('비밀번호가 비어 있어 저장하지 않았습니다.'); return; }
  try {
    var salt = Utilities.getUuid();
    var hash = hash_(pw, salt); // 먼저 계산이 성공해야 저장
    var props = PropertiesService.getScriptProperties();
    props.setProperties({ PW_SALT: salt, PW_HASH: hash });
    ui.alert('비밀번호가 저장되었습니다. (' + pw.length + '자)');
  } catch (err) {
    ui.alert('저장 실패: ' + (err && err.message || err));
  }
}

/** 저장된 비밀번호와 입력값이 같은지 시트에서 바로 확인 */
function menuCheckPassword() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PW_HASH') || !props.getProperty('PW_SALT')) { ui.alert('저장된 비밀번호가 없습니다. [비밀번호 설정]을 먼저 실행해 주세요.'); return; }
  var r = ui.prompt('비밀번호 확인', '대시보드 로그인에 쓰는 비밀번호를 입력하세요.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  ui.alert(checkPassword_(r.getResponseText()) ? '일치합니다. 대시보드 [갱신]을 사용할 수 있습니다.' : '일치하지 않습니다. [비밀번호 설정]을 다시 실행해 주세요.');
}

function menuRefresh() {
  var snap = buildSnapshot_();
  saveSnapshot_(snap);
  var monthly = snap.monthlySeries
    ? '\n월간 집계: 포함 (기준 월 ' + snap.monthRef.month + ', 월간 신규 ' + snap.kpi.newMonth + '명)\n\n※ 대시보드 [갱신]에도 반영하려면 배포 → 배포 관리 → 편집 → 버전: 새 버전 → 배포를 해야 합니다.'
    : '\n월간 집계: 없음 — aggregate.gs가 이전 버전입니다. 저장소의 apps-script/aggregate.gs 내용으로 바꿔 주세요.';
  SpreadsheetApp.getUi().alert(snap.week + ' 집계 완료: 총 ' + snap.kpi.total + '명, 주간 신규 ' + snap.kpi.newWeek + '명' + monthly);
}

// ---- 집계·저장 -----------------------------------------------------------
function buildSnapshot_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('시트 탭을 찾을 수 없습니다: ' + SHEET_NAME);
  var rows = sheet.getDataRange().getDisplayValues(); // 화면 표시값 (예: 2026-09-29 12:28:49)
  return DV_AGG.aggregate(rows);
}

function historySheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(HISTORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(HISTORY_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['week', 'savedAt', 'snapshot_json']]);
    sh.hideSheet();
  }
  return sh;
}

// 같은 주차는 덮어쓰기
function saveSnapshot_(snap) {
  var sh = historySheet_();
  var json = JSON.stringify(snap);
  var last = sh.getLastRow();
  var weeks = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  var idx = weeks.indexOf(snap.week);
  var row = idx > -1 ? idx + 2 : last + 1;
  sh.getRange(row, 1, 1, 3).setValues([[snap.week, snap.generatedAt, json]]);
}

function loadAll_() {
  var sh = historySheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 3).getValues()
    .map(function (r) { try { return JSON.parse(r[2]); } catch (e) { return null; } })
    .filter(function (s) { return s && s.week; })
    .sort(function (a, b) { return a.week < b.week ? -1 : 1; });
}

// 목록(요약) + 선택 주차 + 직전 주차
function bundle_(week) {
  var all = loadAll_();
  var i = week ? all.map(function (s) { return s.week; }).indexOf(week) : all.length - 1;
  // 저장되지 않은 과거 주차는 시트 원본으로 그 시점 기준 재계산 (저장하지 않음)
  if (week && i < 0) {
    return { ok: true, index: { snapshots: all.map(DV_AGG.historyEntry) }, snap: historicalSnapshot_(week), prev: null };
  }
  if (!all.length) return { ok: true, index: { snapshots: [] }, snap: null, prev: null };
  if (i < 0) i = all.length - 1;
  return {
    ok: true,
    index: { snapshots: all.map(DV_AGG.historyEntry) },
    snap: all[i],
    prev: i > 0 ? all[i - 1] : null
  };
}

// 과거 주차 재계산: 해당 주 다음 월요일 정오(KST)를 기준 시각으로 집계
// 가입 관련 지표는 그 주 기준, 로그인·수신 동의·회원 상태는 현재 값 기준
function historicalSnapshot_(week) {
  var ms = DV_AGG.isoWeekStart(week);
  var from = DV_AGG.isoWeekStart(HIST_FROM);
  var latest = new Date().getTime() - 7 * 86400000;
  if (ms == null || ms < from || ms > latest) throw new Error('선택할 수 없는 주차입니다: ' + week);
  var cache = CacheService.getScriptCache(), key = 'hist:' + week;
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('시트 탭을 찾을 수 없습니다: ' + SHEET_NAME);
  var snap = DV_AGG.aggregate(sheet.getDataRange().getDisplayValues(),
    { now: ms + 7 * 86400000 + 3 * 3600000, asOf: true });
  try { var j = JSON.stringify(snap); if (j.length < 95000) cache.put(key, j, 1800); } catch (e) {}
  return snap;
}

// 기준 월 재계산: 그 달 말일까지 가입한 회원 기준, 다음 달 1일 새벽(KST)을 기준 시각으로 집계
function monthSnapshot_(month) {
  var ms = DV_AGG.monthStartOf(month);
  if (ms == null || ms < DV_AGG.monthStartOf(HIST_FROM_MONTH)) throw new Error('선택할 수 없는 기준 월입니다: ' + month);
  var d = new Date(ms + 9 * 3600000), next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 9 * 3600000;
  if (next > new Date().getTime()) throw new Error('아직 끝나지 않은 달입니다: ' + month);
  var cache = CacheService.getScriptCache(), key = 'histm:' + month;
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('시트 탭을 찾을 수 없습니다: ' + SHEET_NAME);
  var snap = DV_AGG.aggregate(sheet.getDataRange().getDisplayValues(),
    { now: next + 3 * 3600000, asOf: true, cutoff: next, kind: 'month' });
  try { var j = JSON.stringify(snap); if (j.length < 95000) cache.put(key, j, 1800); } catch (e) {}
  return snap;
}

// 활동성 지표: 4개 시트를 읽어 (날짜 → yyyy-MM-dd, 같은 기간·기기/페이지 중복은 마지막 행 우선, 기간순 정렬) 반환
// '(표시)' 열은 화면용 문자열이라 제외
function activityData_(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) { var hit = cache.get('activity'); if (hit) { try { return JSON.parse(hit); } catch (e) {} } }
  var ss = SpreadsheetApp.openById(ACTIVITY_SHEET_ID), out = { fetchedAt: new Date().toISOString() };
  ACTIVITY_SHEETS.forEach(function (d) {
    var sh = ss.getSheetByName(d[1]);
    if (!sh) throw new Error('활동성 시트에서 탭을 찾을 수 없습니다: ' + d[1]);
    var v = sh.getDataRange().getValues();
    var head = v[0].map(function (h) { return String(h).trim(); });
    var keep = []; head.forEach(function (h, i) { if (h && h.indexOf('(표시)') < 0) keep.push(i); });
    var map = {}, order = [];
    for (var r = 1; r < v.length; r++) {
      var row = v[r];
      if (!row[0]) continue;
      var vals = keep.map(function (i) {
        var x = row[i];
        if (x instanceof Date) return Utilities.formatDate(x, 'Asia/Seoul', 'yyyy-MM-dd');
        return typeof x === 'number' ? x : String(x).trim();
      });
      var key = d[2].map(function (i) { return vals[keep.indexOf(i)]; }).join('|');
      if (!(key in map)) order.push(key);
      map[key] = vals;
    }
    var rows = order.map(function (k) { return map[k]; });
    rows.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    out[d[0]] = { cols: keep.map(function (i) { return head[i]; }), rows: rows };
  });
  try { var j = JSON.stringify(out); if (j.length < 95000) cache.put('activity', j, 600); } catch (e) {}
  return out;
}

function menuCheckActivity() {
  var a = activityData_(true);
  var last = function (t) { return t.rows.length ? t.rows[t.rows.length - 1][0] : '없음'; };
  SpreadsheetApp.getUi().alert('활동성 시트 연결 정상\n주간지표: ' + a.weekly.rows.length + '행 (마지막 주 ' + last(a.weekly) + ')\n월간지표: ' + a.monthly.rows.length + '행 (마지막 달 ' + last(a.monthly) + ')\n페이지별(주간): ' + a.pageWeekly.rows.length + '행 · 페이지별(월간): ' + a.pageMonthly.rows.length + '행');
}

// 연동 상태를 한 번에 점검 (문제 발생 시 이 결과를 확인)
function menuDiagnose() {
  var lines = [], ok = function (b, msg) { lines.push((b ? '✅ ' : '❌ ') + msg); };
  var props = PropertiesService.getScriptProperties();
  ok(!!(props.getProperty('PW_HASH') && props.getProperty('PW_SALT')), '연동 비밀번호 저장됨');
  var fails = Number(CacheService.getScriptCache().get('fails') || 0);
  ok(fails < MAX_FAILS, '비밀번호 잠금 상태 아님 (최근 10분 오류 ' + fails + '회)');
  ok(typeof DV_AGG === 'object' && typeof DV_AGG.aggregate === 'function' && typeof DV_AGG.monthStartOf === 'function', '집계 로직(DV_AGG) 로드됨');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  ok(!!sheet, '회원 데이터 탭 "' + SHEET_NAME + '" ' + (sheet ? '(' + (sheet.getLastRow() - 1) + '행)' : '없음'));
  try { var s = buildSnapshot_(); ok(!!s.monthlySeries, '회원 집계 실행 (' + s.week + ', 총 ' + s.kpi.total + '명, 월간 포함)'); } catch (e) { ok(false, '회원 집계 실패: ' + (e && e.message || e)); }
  try { var all = loadAll_(); lines.push((all.length ? '✅ ' : '⚠️ ') + '저장된 주차 집계 ' + all.length + '개' + (all.length ? ' (최신 ' + all[all.length - 1].week + ')' : ' — 대시보드에서 [갱신]을 한 번 눌러 주세요')); } catch (e) { ok(false, '주차 집계 읽기 실패: ' + e.message); }
  try { var b = bundle_(null); ok(b.ok, "대시보드 기본 응답('get') 정상"); } catch (e) { ok(false, "대시보드 기본 응답('get') 실패: " + e.message); }
  try { var m = monthSnapshot_(HIST_FROM_MONTH); ok(m.monthRef.month === HIST_FROM_MONTH, '과거 월 재계산 정상 (' + HIST_FROM_MONTH + ')'); } catch (e) { ok(false, '과거 월 재계산 실패: ' + e.message); }
  try { var a = activityData_(true); ok(true, '활동성 시트 읽기 정상 (주간 ' + a.weekly.rows.length + '행, 월간 ' + a.monthly.rows.length + '행)'); } catch (e) { ok(false, '활동성 시트 읽기 실패: ' + (e && e.message || e) + ' — 회원 분석에는 영향 없음'); }
  lines.push('', '※ 코드를 바꾼 뒤에는 배포 → 배포 관리 → 편집 → 버전: 새 버전 → 배포를 해야 대시보드에 반영됩니다.');
  SpreadsheetApp.getUi().alert('대시보드 연동 진단\n\n' + lines.join('\n'));
}

// ---- 유틸 ----------------------------------------------------------------
function checkPassword_(pw) {
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty('PW_SALT'), saved = props.getProperty('PW_HASH');
  pw = String(pw || '').trim();
  if (!salt || !saved || !pw) return false;
  return safeEqual_(hash_(pw, salt), saved);
}

// 솔트 + 반복 SHA-256 (문자열 기반: 실행 환경에 따른 바이트 배열 차이 방지)
function hash_(pw, salt) {
  var h = String(pw);
  for (var i = 0; i < PW_ITER; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + h, Utilities.Charset.UTF_8));
  }
  return h;
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0; for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// =====================================================================
// 집계 로직 (저장소 scripts/aggregate.js와 동일한 내용을 이 파일에 포함)
// 다른 파일(aggregate.gs 등)이 남아 있어도 서로 덮어쓰지 않도록 DV_AGG 이름으로만 사용
// =====================================================================
var DV_AGG = (function () {
  var holder = {};
/*
 * 닥터빌 회원 대시보드 - 집계 로직 (Node / 브라우저 공용, 외부 의존성 없음)
 *
 * 입력: 구글시트 원본 행 배열 (첫 행 = 헤더)
 * 출력: 공개용 집계 스냅샷 객체 (개인 식별 정보 미포함)
 *
 * 공개 게시 원칙
 *  - 회원 USN, 이메일, 면허번호, 병원명, 세부 진료과, 시군구는 집계에 사용하지 않음
 *  - MIN_CELL 미만인 항목은 "기타(소수)"로 병합해 소수 인원 노출 방지
 */
(function (root, factory) {
  root.MemberAggregate = factory();
})(holder, function () {
  'use strict';

  var MIN_CELL = 3;
  var SMALL = '기타(소수)';
  var UNKNOWN = '미입력';
  var KST = 9 * 3600 * 1000;
  var DAY = 86400000;

  // 공개 대시보드에서 다루는 항목 (시트 필드명 → 대시보드 키)
  var DIMS = [
    { key: 'job', label: '직종', field: '직종' },
    { key: 'dept', label: '주 진료과', field: '주 진료과명' },
    { key: 'region', label: '근무처 시도', field: '근무처 시도' },
    { key: 'route', label: '가입경로', field: '가입경로' },
    { key: 'gender', label: '성별', field: '성별' },
    { key: 'age', label: '연령대', field: '나이', ordered: true },
    { key: 'status', label: '회원 상태', field: '회원 상태' },
    { key: 'integrated', label: '통합회원 전환', field: '통합회원 전환' },
    { key: 'sms', label: 'SMS 수신', field: 'SMS 수신' },
    { key: 'email', label: '이메일 수신', field: '이메일 수신' },
    { key: 'recency', label: '최종 로그인 경과', field: '최종 로그인', ordered: true }
  ];

  var AGE_ORDER = ['20대', '30대', '40대', '50대', '60대', '70대 이상', '확인필요'];
  var RECENCY_ORDER = ['7일 이내', '8~30일', '31~90일', '91~180일', '181일~1년', '1년 초과', UNKNOWN];

  // ---- 시간 유틸 (모두 KST 기준) ----------------------------------------
  function parseKst(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec((s || '').trim());
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - KST;
  }
  function kstDate(ms) { return new Date(ms + KST); } // UTC getter = KST 벽시계
  function ymd(ms) { return kstDate(ms).toISOString().slice(0, 10); }
  // 해당 시각이 속한 주의 월요일 00:00 (KST) epoch ms
  function weekStart(ms) {
    var d = kstDate(ms);
    var dow = (d.getUTCDay() + 6) % 7; // 월=0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - KST;
  }
  function isoWeek(ms) {
    var d = kstDate(weekStart(ms) + 3 * DAY); // 해당 주 목요일
    var y = d.getUTCFullYear();
    var jan1 = Date.UTC(y, 0, 1);
    var w = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - jan1) / (7 * DAY)) + 1;
    return y + '-W' + (w < 10 ? '0' + w : w);
  }
  // 'YYYY-Www' → 그 주 월요일 00:00 (KST) epoch ms (형식이 틀리면 null)
  function isoWeekStart(week) {
    var m = /^(\d{4})-W(\d{2})$/.exec(String(week || ''));
    if (!m) return null;
    var jan4 = Date.UTC(+m[1], 0, 4), dow = (new Date(jan4).getUTCDay() + 6) % 7;
    var ms = jan4 - dow * DAY + (+m[2] - 1) * 7 * DAY - KST;
    return isoWeek(ms) === week ? ms : null;
  }

  // ---- 값 정규화 --------------------------------------------------------
  function norm(key, raw, ctx) {
    var v = (raw == null ? '' : String(raw)).trim();
    switch (key) {
      case 'age': {
        var n = parseInt(v, 10);
        if (isNaN(n) || n < 20 || n > 99) return '확인필요';
        if (n >= 70) return '70대 이상';
        return Math.floor(n / 10) * 10 + '대';
      }
      case 'region':
        if (!v || v === '알 수 없음') return UNKNOWN;
        if (v === '세종시') return '세종';
        return v;
      case 'status':
        if (/^\d+$/.test(v)) return '기타(코드값)';
        return v || UNKNOWN;
      case 'sms':
      case 'email':
        return v || '미설정';
      case 'recency': {
        var t = parseKst(v);
        if (t == null) return UNKNOWN;
        var d = (ctx.now - t) / DAY;
        if (d <= 7) return '7일 이내';
        if (d <= 30) return '8~30일';
        if (d <= 90) return '31~90일';
        if (d <= 180) return '91~180일';
        if (d <= 365) return '181일~1년';
        return '1년 초과';
      }
      default:
        return v || UNKNOWN;
    }
  }

  function orderFor(key) {
    if (key === 'age') return AGE_ORDER;
    if (key === 'recency') return RECENCY_ORDER;
    return null;
  }

  // 카운트 맵 → [[라벨, 값]] 정렬 + 소수 병합
  function toList(map, key, keepKeys) {
    var small = 0, out = [];
    Object.keys(map).forEach(function (k) {
      var n = map[k];
      if (n < MIN_CELL && !(keepKeys && keepKeys[k])) small += n;
      else out.push([k, n]);
    });
    var ord = orderFor(key);
    if (ord) out.sort(function (a, b) { return ord.indexOf(a[0]) - ord.indexOf(b[0]); });
    else out.sort(function (a, b) {
      var ua = a[0] === UNKNOWN || a[0] === '미설정', ub = b[0] === UNKNOWN || b[0] === '미설정';
      if (ua !== ub) return ua ? 1 : -1;
      return b[1] - a[1];
    });
    if (small > 0) out.push([SMALL, small]);
    return out;
  }
  function suppress(map) { // 주간 구성용: 소수 병합한 객체 반환
    var o = {}, small = 0;
    Object.keys(map).forEach(function (k) { if (map[k] < MIN_CELL) small += map[k]; else o[k] = map[k]; });
    if (small) o[SMALL] = small;
    return o;
  }
  function inc(m, k, n) { m[k] = (m[k] || 0) + (n || 1); }
  function pct(a, b) { return b ? Math.round((a / b) * 10000) / 100 : 0; }

  /**
   * @param {string[][]} rows  첫 행이 헤더인 원본 행
   * @param {object} [opt]     { now: epoch ms, weeks: 추이 주 수(기본 52),
   *                              asOf: true → 과거 시점 재계산(cutoff 이후 가입자 제외, 로그인 경과는 activityNow 기준)
   *                              cutoff: 제외 기준 시각(기본: 기준 주 다음 월요일), kind: 'week' | 'month' }
   */
  function aggregate(rows, opt) {
    opt = opt || {};
    var now = opt.now || Date.now();
    var WEEKS = opt.weeks || 52;
    var header = rows[0].map(function (h) { return String(h).trim(); });
    var idx = {};
    header.forEach(function (h, i) { idx[h] = i; });
    var need = DIMS.map(function (d) { return d.field; }).concat(['가입일시']);
    var missing = need.filter(function (f) { return !(f in idx); });
    if (missing.length) throw new Error('시트에 필요한 필드가 없습니다: ' + missing.join(', '));

    var asOf = !!opt.asOf;
    var ctx = { now: asOf ? (opt.activityNow || Date.now()) : now };
    var curWeek = weekStart(now);           // 진행 중인 주
    var refStart = curWeek - 7 * DAY;       // 직전 완료 주(보고 대상 주)
    var prevStart = refStart - 7 * DAY;
    var recent4Start = refStart - 21 * DAY; // 최근 4주 (보고 주 포함)
    // 월 단위 기준: 직전 완료 월(보고 월), 최근 3개월(보고 월 포함), 추이 24개월
    var MONTHS = opt.months || 24;
    var nk = kstDate(now), curY = nk.getUTCFullYear(), curM = nk.getUTCMonth();
    var monthStart = function (y, m) { return Date.UTC(y, m, 1) - KST; };
    var mKey = function (ms) { var d = kstDate(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
    var curMonthIdx = curY * 12 + curM, refMonthIdx = curMonthIdx - 1;
    var firstMonthIdx = refMonthIdx - (MONTHS - 1);
    var monthly = {}, joinedBeforeFirstMonth = 0, newRefM = 0, newPrevM = 0, recent3 = 0;
    var firstWeek = refStart - (WEEKS - 1) * 7 * DAY;

    var dims = {};
    DIMS.forEach(function (d) { dims[d.key] = { all: {}, week: {}, recent4: {}, month: {}, recent3: {} }; });
    var weekly = {};   // weekStartMs -> { n, route:{}, job:{} }
    var total = 0, joinedBeforeFirst = 0, newRef = 0, newPrev = 0, recent4 = 0, afterRef = 0;
    var active7 = 0, active30 = 0, integrated = 0, smsYes = 0, emailYes = 0;
    var deptAge = {};
    // 연간 월별 비교 (올해 vs 작년, KST)
    // 월 기준 재계산이면 작년 대비 표는 그 달 말일 기준
    var yoyNow = (opt.asOf && opt.kind === 'month' && opt.cutoff) ? opt.cutoff - 1 : now;
    var nowK = kstDate(yoyNow), Y = nowK.getUTCFullYear();
    var cutoffMD = (nowK.getUTCMonth() + 1) * 100 + nowK.getUTCDate(); // 동기간 비교 기준 (MMDD)
    var monCur = [0,0,0,0,0,0,0,0,0,0,0,0], monLast = [0,0,0,0,0,0,0,0,0,0,0,0], ytdLast = 0, lastMtd = 0;

    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !row.length || row.every(function (c) { return !String(c || '').trim(); })) continue;
      var j = parseKst(row[idx['가입일시']]);
      if (asOf && j != null && j >= (opt.cutoff || curWeek)) continue;   // 과거 재계산: 기준 시점 이후 가입자는 제외
      total++;
      var vals = {};
      DIMS.forEach(function (d) { vals[d.key] = norm(d.key, row[idx[d.field]], ctx); });

      var mi = j != null ? mKey(j) : null;
      var inRefM = mi === refMonthIdx, inR3 = mi != null && mi >= refMonthIdx - 2 && mi <= refMonthIdx;
      if (inRefM) newRefM++;
      if (mi === refMonthIdx - 1) newPrevM++;
      if (inR3) recent3++;
      if (mi != null && mi <= refMonthIdx) {
        if (mi < firstMonthIdx) joinedBeforeFirstMonth++;
        else { var mo = monthly[mi] || (monthly[mi] = { n: 0, route: {}, job: {} }); mo.n++; inc(mo.route, vals.route); inc(mo.job, vals.job); }
      } else if (mi == null) joinedBeforeFirstMonth++;
      var inRef = j != null && j >= refStart && j < refStart + 7 * DAY;
      var inR4 = j != null && j >= recent4Start && j < refStart + 7 * DAY;
      if (inRef) newRef++;
      if (j != null && j >= prevStart && j < refStart) newPrev++;
      if (inR4) recent4++;
      if (j != null && j >= curWeek) afterRef++;

      DIMS.forEach(function (d) {
        inc(dims[d.key].all, vals[d.key]);
        if (inRef) inc(dims[d.key].week, vals[d.key]);
        if (inRefM) inc(dims[d.key].month, vals[d.key]);
        if (inR3) inc(dims[d.key].recent3, vals[d.key]);
        if (inR4) inc(dims[d.key].recent4, vals[d.key]);
      });

      if (vals.recency === '7일 이내') active7++;
      if (vals.recency === '7일 이내' || vals.recency === '8~30일') active30++;
      if (vals.integrated === '전환') integrated++;
      if (vals.sms === '수신') smsYes++;
      if (vals.email === '수신') emailYes++;

      if (!deptAge[vals.dept]) deptAge[vals.dept] = {};
      inc(deptAge[vals.dept], vals.age);

      if (j != null && j <= yoyNow) {
        var jd = kstDate(j), jy = jd.getUTCFullYear(), jm = jd.getUTCMonth();
        if (jy === Y) monCur[jm]++;
        else if (jy === Y - 1) {
          monLast[jm]++;
          if ((jm + 1) * 100 + jd.getUTCDate() <= cutoffMD) {
            ytdLast++;
            if (jm === nowK.getUTCMonth()) lastMtd++; // 작년 같은 달 1일~오늘 날짜
          }
        }
      }

      if (j != null) {
        var ws = weekStart(j);
        if (ws < firstWeek) joinedBeforeFirst++;
        else if (ws <= refStart) {
          var w = weekly[ws] || (weekly[ws] = { n: 0, route: {}, job: {} });
          w.n++; inc(w.route, vals.route); inc(w.job, vals.job);
        }
      } else joinedBeforeFirst++;
    }

    // 월간 시계열 (직전 완료 월까지)
    var mseries = [], mcum = joinedBeforeFirstMonth;
    for (var q = firstMonthIdx; q <= refMonthIdx; q++) {
      var yy = Math.floor(q / 12), mm = q % 12, mo2 = monthly[q] || { n: 0, route: {}, job: {} };
      mcum += mo2.n;
      var ms0 = monthStart(yy, mm), ms1 = monthStart(yy, mm + 1) - DAY;
      mseries.push({ month: yy + '-' + (mm < 9 ? '0' : '') + (mm + 1), start: ymd(ms0), end: ymd(ms1), new: mo2.n, cumulative: mcum, route: suppress(mo2.route), job: suppress(mo2.job) });
    }
    var refY = Math.floor(refMonthIdx / 12), refMm = refMonthIdx % 12;

    // 주간 시계열
    var series = [], cum = joinedBeforeFirst;
    for (var k = 0; k < WEEKS; k++) {
      var s = firstWeek + k * 7 * DAY;
      var w2 = weekly[s] || { n: 0, route: {}, job: {} };
      cum += w2.n;
      series.push({
        week: isoWeek(s), start: ymd(s), end: ymd(s + 6 * DAY),
        new: w2.n, cumulative: cum, route: suppress(w2.route), job: suppress(w2.job)
      });
    }

    var outDims = {};
    DIMS.forEach(function (d) {
      var all = toList(dims[d.key].all, d.key);
      var keep = {}; all.forEach(function (p) { keep[p[0]] = 1; });
      var wk = dims[d.key].week, r4 = dims[d.key].recent4;
      outDims[d.key] = {
        label: d.label,
        ordered: !!d.ordered,
        rows: all.map(function (p) {
          var name = p[0];
          var w = name === SMALL ? sumSmall(wk, keep) : (wk[name] || 0);
          var n4 = name === SMALL ? sumSmall(r4, keep) : (r4[name] || 0);
          var mo3 = dims[d.key].month, r3 = dims[d.key].recent3;
          var wm = name === SMALL ? sumSmall(mo3, keep) : (mo3[name] || 0);
          var n3 = name === SMALL ? sumSmall(r3, keep) : (r3[name] || 0);
          return { name: name, count: p[1], share: pct(p[1], total), newWeek: w < MIN_CELL && w > 0 ? '<' + MIN_CELL : w, newShare4w: pct(n4, recent4),
            newMonth: wm < MIN_CELL && wm > 0 ? '<' + MIN_CELL : wm, newShare3m: pct(n3, recent3) };
        })
      };
    });

    // 진료과 × 연령대 (상위 12개 진료과, 행 기준 %)
    var topDepts = outDims.dept.rows.filter(function (x) { return x.name !== SMALL && x.name !== UNKNOWN; }).slice(0, 12).map(function (x) { return x.name; });
    var heat = topDepts.map(function (dep) {
      var m = deptAge[dep] || {}, t = 0;
      AGE_ORDER.forEach(function (a) { t += m[a] || 0; });
      return { dept: dep, total: t, cells: AGE_ORDER.map(function (a) { var n = m[a] || 0; return n < MIN_CELL ? null : pct(n, t); }) };
    });

    return {
      schema: 1,
      historical: asOf ? (opt.kind || 'week') : undefined,
      generatedAt: new Date(now).toISOString(),
      generatedAtKst: ymd(now) + ' ' + kstDate(now).toISOString().slice(11, 16),
      week: isoWeek(refStart),
      weekStart: ymd(refStart),
      weekEnd: ymd(refStart + 6 * DAY),
      minCell: MIN_CELL,
      kpi: {
        total: total,
        newWeek: newRef,
        newPrevWeek: newPrev,
        newSinceWeekEnd: afterRef,
        new4w: recent4,
        newMonth: newRefM,
        newPrevMonth: newPrevM,
        new3m: recent3,
        active7: active7,
        active30: active30,
        active7Rate: pct(active7, total),
        active30Rate: pct(active30, total),
        integratedRate: pct(integrated, total),
        smsOptInRate: pct(smsYes, total),
        emailOptInRate: pct(emailYes, total)
      },
      dims: outDims,
      weekly: series,
      monthRef: { month: mseries[mseries.length - 1].month, start: ymd(monthStart(refY, refMm)), end: ymd(monthStart(refY, refMm + 1) - DAY) },
      monthlySeries: mseries,
      deptAge: { ages: AGE_ORDER, rows: heat },
      monthly: {
        thisYear: Y, lastYear: Y - 1, asOf: ymd(yoyNow), currentMonth: nowK.getUTCMonth() + 1,
        cur: monCur.map(function (n, i) { return i <= nowK.getUTCMonth() ? n : null; }),
        last: monLast,
        ytdCur: monCur.reduce(function (a, b) { return a + b; }, 0),
        ytdLast: ytdLast,
        lastMtd: lastMtd,
        totalLast: monLast.reduce(function (a, b) { return a + b; }, 0)
      }
    };
  }
  function sumSmall(m, keep) {
    var s = 0; Object.keys(m).forEach(function (k) { if (!keep[k]) s += m[k]; }); return s;
  }

  // 스냅샷 → 이력 요약 한 줄
  function historyEntry(snap) {
    var k = snap.kpi;
    return {
      week: snap.week, weekStart: snap.weekStart, weekEnd: snap.weekEnd, generatedAt: snap.generatedAt,
      total: k.total, newWeek: k.newWeek, active7: k.active7, active30: k.active30,
      active7Rate: k.active7Rate, active30Rate: k.active30Rate, integratedRate: k.integratedRate,
      smsOptInRate: k.smsOptInRate, emailOptInRate: k.emailOptInRate
    };
  }

  // 'YYYY-MM' → 그 달 1일 00:00 (KST) epoch ms (형식이 틀리면 null)
  function monthStartOf(month) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    if (!m || +m[2] < 1 || +m[2] > 12) return null;
    return Date.UTC(+m[1], +m[2] - 1, 1) - KST;
  }

  return { aggregate: aggregate, historyEntry: historyEntry, DIMS: DIMS, MIN_CELL: MIN_CELL, isoWeek: isoWeek, isoWeekStart: isoWeekStart, monthStartOf: monthStartOf };
});
  return holder.MemberAggregate;
})();
