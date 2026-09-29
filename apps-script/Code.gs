/**
 * 닥터빌 회원 대시보드 - 집계 웹앱 (구글시트에 붙여 쓰는 Apps Script)
 *
 * 역할: 시트의 회원 원본을 시트 안에서 집계하고, 집계 결과(개인 식별 정보 없음)만 반환합니다.
 *       원본 행은 이 스크립트 밖으로 나가지 않으며, Google Cloud 프로젝트/서비스 계정이 필요 없습니다.
 *
 * 설정 (1회)
 *  1) 회원분석 시트 → 확장 프로그램 → Apps Script
 *  2) 이 파일(Code.gs)과 aggregate.gs 내용을 각각 붙여넣고 저장
 *  3) 상단 함수 선택에서 setupToken 실행 → 권한 승인 → 실행 로그의 토큰을 복사
 *  4) 배포 → 새 배포 → 유형: 웹 앱 / 실행 사용자: 나 / 액세스 권한: 모든 사용자 → 배포 → 웹 앱 URL 복사
 *  5) GitHub Secrets: APPS_SCRIPT_URL = 웹 앱 URL, APPS_SCRIPT_TOKEN = 토큰
 *
 * 토큰이 없거나 틀린 요청에는 아무 데이터도 반환하지 않습니다.
 */
var SHEET_NAME = '시트1'; // 회원 데이터가 있는 탭 이름

function doPost(e) {
  var req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  var saved = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!saved || !req.token || !safeEqual_(String(req.token), saved)) return json_({ ok: false, error: 'unauthorized' });
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) return json_({ ok: false, error: 'sheet not found: ' + SHEET_NAME });
    var rows = sheet.getDataRange().getDisplayValues(); // 화면 표시값 (예: 2026-09-29 12:28:49)
    var snapshot = MemberAggregate.aggregate(rows);
    return json_({ ok: true, snapshot: snapshot });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// GET 요청에는 데이터를 반환하지 않음
function doGet() { return json_({ ok: false, error: 'use POST' }); }

/** 최초 1회 실행: 접근 토큰 생성 (다시 실행하면 토큰이 바뀌므로 GitHub Secret도 함께 변경) */
function setupToken() {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', token);
  Logger.log('APPS_SCRIPT_TOKEN = ' + token);
}

/** 배포 전 점검용: 집계가 정상인지 로그로 확인 (개인정보는 출력하지 않음) */
function testAggregate() {
  var rows = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME).getDataRange().getDisplayValues();
  var s = MemberAggregate.aggregate(rows);
  Logger.log(s.week + ' 총 ' + s.kpi.total + '명, 주간 신규 ' + s.kpi.newWeek + '명');
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0; for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
