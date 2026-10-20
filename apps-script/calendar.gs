/**
 * 닥터빌 대시보드 — 현황 > 컨퍼런스 : 구글 캘린더 일정 연동 (calendar.gs)
 *
 * 하는 일
 *   - 'CAL_NAME' 캘린더(닥터빌 마케팅팀)의 한 달 일정을 읽어 대시보드에 돌려줍니다.
 *   - 제목에 휴가·연차·반차가 들어간 일정은 제외합니다. (CAL_EXCLUDE)
 *   - 참석자 이메일·첨부 등은 보내지 않습니다. 제목·일시·장소·설명(앞 300자)만 보냅니다.
 *
 * 설치 (시트의 확장 프로그램 → Apps Script)
 *   1) 파일 추가(+) → 스크립트 → 이름 'calendar' → 이 파일 내용 전체 붙여넣기 → 저장
 *   2) Code.gs 의 doPost 안, 비밀번호 확인이 끝난 뒤의 try { 바로 아래에 한 줄 추가:
 *        if (req.action === 'calendar') return json_({ ok: true, calendar: calendarData_(req) });
 *   3) 함수 선택에서 menuCheckCalendar 실행 → 권한 승인(캘린더 읽기) → 연결 결과 확인
 *   4) 배포 → 배포 관리 → 편집(연필) → 버전: 새 버전 → 배포  (URL은 바뀌지 않습니다)
 *
 * 캘린더는 이 Apps Script를 배포한 구글 계정에서 보이는(소유·구독 중인) 캘린더여야 합니다.
 * 이름으로 찾지 못하면 캘린더 설정 → '캘린더 통합'의 캘린더 ID를 CAL_ID 에 넣어 주세요.
 */
var CAL_NAME = '닥터빌 마케팅팀';          // 가져올 캘린더 이름
var CAL_ID = '';                            // (선택) 캘린더 ID — 넣으면 이름보다 우선
var CAL_EXCLUDE = /휴가|연차|반차/;          // 제목에 이 단어가 있으면 제외
var CAL_TZ = 'Asia/Seoul';
var CAL_CACHE_SEC = 600;                    // 같은 달 재요청 캐시 10분 ([갱신]은 캐시 무시)

function calendarFind_() {
  if (CAL_ID) {
    var byId = CalendarApp.getCalendarById(CAL_ID);
    if (!byId) throw new Error('캘린더 ID(' + CAL_ID + ')를 찾을 수 없습니다. 배포 계정에 캘린더가 공유되어 있는지 확인해 주세요.');
    return byId;
  }
  var list = CalendarApp.getCalendarsByName(CAL_NAME);
  if (!list.length) {
    var want = CAL_NAME.replace(/\s+/g, '');
    list = CalendarApp.getAllCalendars().filter(function (c) { return c.getName().replace(/\s+/g, '') === want; });
  }
  if (!list.length) throw new Error('「' + CAL_NAME + '」 캘린더를 찾을 수 없습니다. 이 Apps Script를 배포한 구글 계정에서 해당 캘린더를 구독(추가)했는지 확인해 주세요.');
  return list[0];
}

function calFmt_(d, p) { return Utilities.formatDate(d, CAL_TZ, p); }

// req: { month: 'YYYY-MM', fresh: bool }
function calendarData_(req) {
  var month = String(req.month || calFmt_(new Date(), 'yyyy-MM'));
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month 형식이 올바르지 않습니다: ' + month);
  var cache = CacheService.getScriptCache(), ck = 'cal|' + month;
  if (!req.fresh) {
    var hit = cache.get(ck);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }
  var cal = calendarFind_();
  var y = +month.slice(0, 4), m = +month.slice(5, 7);
  var from = new Date(Utilities.formatString('%d-%02d-01T00:00:00+09:00', y, m));
  var to = new Date(Utilities.formatString('%d-%02d-01T00:00:00+09:00', m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1));
  var events = [], excluded = 0;
  cal.getEvents(from, to).forEach(function (ev) {
    var title = String(ev.getTitle() || '').trim();
    if (CAL_EXCLUDE.test(title)) { excluded++; return; }
    var allDay = ev.isAllDayEvent(), s, e, o;
    if (allDay) {
      s = ev.getAllDayStartDate();
      e = new Date(ev.getAllDayEndDate().getTime() - 86400000);   // 종일 일정의 종료일은 다음 날 0시 → 하루 빼기
      o = { date: calFmt_(s, 'yyyy-MM-dd'), endDate: calFmt_(e, 'yyyy-MM-dd'), start: '', end: '' };
    } else {
      s = ev.getStartTime(); e = ev.getEndTime();
      var eDay = calFmt_(new Date(e.getTime() - (calFmt_(e, 'HH:mm') === '00:00' && e > s ? 60000 : 0)), 'yyyy-MM-dd');
      o = { date: calFmt_(s, 'yyyy-MM-dd'), endDate: eDay, start: calFmt_(s, 'HH:mm'), end: calFmt_(e, 'HH:mm') };
    }
    if (o.endDate === o.date) o.endDate = '';
    o.id = ev.getId() + '@' + o.date + (o.start ? 'T' + o.start : '');   // 반복 일정은 날짜까지 붙여 구분
    o.title = title || '(제목 없음)';
    o.allDay = allDay;
    o.location = String(ev.getLocation() || '').trim();
    o.desc = String(ev.getDescription() || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    events.push(o);
  });
  events.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start || '') < (b.start || '') ? -1 : (a.start || '') > (b.start || '') ? 1 : 0; });
  var out = { fetchedAt: new Date().toISOString(), source: cal.getName(), month: month, events: events, excluded: excluded, rule: '제목에 휴가·연차·반차 포함 시 제외' };
  try { cache.put(ck, JSON.stringify(out), CAL_CACHE_SEC); } catch (e) {}   // 100KB 넘으면 캐시 생략
  return out;
}

// 편집기에서 실행: 캘린더 연결·권한 확인 (이번 달 건수 표시)
function menuCheckCalendar() {
  var msg;
  try {
    var r = calendarData_({ month: calFmt_(new Date(), 'yyyy-MM'), fresh: true });
    msg = '✅ 「' + r.source + '」 캘린더 연결 정상\n이번 달(' + r.month + ') 일정 ' + r.events.length + '건 · 휴가·연차·반차 제외 ' + r.excluded + '건';
  } catch (err) {
    var names = [];
    try { names = CalendarApp.getAllCalendars().map(function (c) { return c.getName(); }); } catch (e2) {}
    msg = '❌ ' + (err && err.message || err) + (names.length ? '\n\n이 계정에서 보이는 캘린더: ' + names.join(', ') : '');
  }
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}   // 편집기에서 실행하면 실행 로그에서 확인
  return msg;
}
