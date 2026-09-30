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
 * 설정 (1회)
 *  1) 회원분석 시트 → 확장 프로그램 → Apps Script
 *  2) 이 파일(Code.gs)과 aggregate.gs 내용을 각각 붙여넣고 저장
 *  3) 시트를 새로고침 → 상단 메뉴 [대시보드] → [비밀번호 설정] → 대시보드 비밀번호 입력 (권한 승인)
 *  4) Apps Script 화면에서 배포 → 새 배포 → 유형: 웹 앱 / 실행 사용자: 나 / 액세스 권한: 모든 사용자 → 배포
 *  5) 웹 앱 URL(…/exec)을 저장소 docs/data/config.json 의 appsScriptUrl 에 입력
 */
var SHEET_NAME = '시트1';                  // 회원 데이터가 있는 탭 이름
var HISTORY_SHEET = '_dashboard_history';  // 주차별 집계 저장 탭 (자동 생성, 숨김)
var MAX_FAILS = 10;                        // 10분 안에 이 횟수만큼 틀리면 잠금
var PW_ITER = 2000;

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
  SpreadsheetApp.getUi().alert(snap.week + ' 집계 완료: 총 ' + snap.kpi.total + '명, 주간 신규 ' + snap.kpi.newWeek + '명');
}

// ---- 집계·저장 -----------------------------------------------------------
function buildSnapshot_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('시트 탭을 찾을 수 없습니다: ' + SHEET_NAME);
  var rows = sheet.getDataRange().getDisplayValues(); // 화면 표시값 (예: 2026-09-29 12:28:49)
  return MemberAggregate.aggregate(rows);
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
  if (!all.length) return { ok: true, index: { snapshots: [] }, snap: null, prev: null };
  var i = week ? all.map(function (s) { return s.week; }).indexOf(week) : all.length - 1;
  if (i < 0) i = all.length - 1;
  return {
    ok: true,
    index: { snapshots: all.map(MemberAggregate.historyEntry) },
    snap: all[i],
    prev: i > 0 ? all[i - 1] : null
  };
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
