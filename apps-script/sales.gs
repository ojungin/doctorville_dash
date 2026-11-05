/**
 * 닥터빌 매출 (대시보드 매출 > 닥터빌 > 매출) — 회원 대시보드 Apps Script 프로젝트의 sales.gs (전체 교체)
 *
 * 소스: 「● 닥터빌 TF 닥터빌사업부 매출 _26년 10월 마감 보고」
 *   - [대시보드] 탭 : 'raw (세부)' 탭(월·금액·거래처·내/외부·항목·플랫폼)을 고객사 × 항목 × 월 금액으로 정리
 *                    + 'raw' 탭의 '예측' 열(11·12월 등)을 예정 매출로 함께 보냄
 *   - [(매출) 4Q]·[(매출)]·[(손익)] 탭 : 시트 탭의 표시값·병합·서식을 보냄 → 대시보드가 같은 구성(목표대비·전년대비·월별·손익)의 화면으로 다시 그림
 *     (숨긴 열도 hc 표시와 함께 보냄 — 묶음 제목·4분기 실적 등 숨긴 열 값도 대시보드 표에 쓰기 위함)
 * 적요(세부 내역)·담당자는 보내지 않습니다.
 *
 * 설치 (Code.gs 는 바꿀 필요 없음 — 기존 doPost 의 action:'sales' 줄을 그대로 사용)
 *   1) 기존 sales.gs 내용을 모두 지우고 이 파일 내용으로 바꿔 붙여넣기 → 저장
 *   2) 함수 선택에서 menuCheckSales 실행 → 권한 승인 → 결과 확인
 *      (배포 계정에 위 매출 시트 보기 권한 필요 — 시트 소유자: doctorville123@gmail.com)
 *   3) 배포 → 배포 관리 → 편집 → 버전: 새 버전 → 배포
 * 매월 새 마감 파일로 바뀌면 SALES_SHEET_ID 만 바꾸면 됩니다 (같은 파일을 계속 갱신하면 그대로).
 */
var SALES_SHEET_ID = '1hGyy3vtQwhblQABLcEb2p6q88PwZKY1n7v62mA_Eylw';
var SALES_RAW_TAB = 'raw (세부)';
var SALES_FC_TAB = 'raw';                                  // '예측' 표시가 있는 월 열만 예정 매출로 사용
var SALES_VIEW_TABS = ['(매출) 4Q', '(매출)', '(손익)'];     // 대시보드 상단 탭으로 그대로 보여 줄 시트 탭
var SALES_CACHE_SEC = 600;

function salesData_(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var n = Number(cache.get('sales2:n') || 0);
    if (n) {
      var parts = []; for (var i = 0; i < n; i++) parts.push(cache.get('sales2:' + i));
      if (parts.every(function (p) { return p != null; })) { try { return JSON.parse(parts.join('')); } catch (e) {} }
    }
  }
  var ss = SpreadsheetApp.openById(SALES_SHEET_ID);
  var raw = salesRaw_(ss), fc = salesForecast_(ss), years = {};
  raw.rows.forEach(function (r) { salesAdd_(years, r, false); });
  fc.forEach(function (r) { salesAdd_(years, r, true); });
  var cats = {}, out = { v: 2, fetchedAt: new Date().toISOString(), source: ss.getName(), sheetUrl: ss.getUrl(),
    basis: '용역매출 · 월 마감 기준(raw 세부)', years: {}, cats: [], views: [] };
  Object.keys(years).sort().forEach(function (y) {
    var Y = years[y], rows = Object.keys(Y.map).map(function (k) { return Y.map[k]; });
    rows.forEach(function (r) { if (!r.fc) cats[r.cat] = (cats[r.cat] || 0) + r.m.reduce(function (a, b) { return a + b; }, 0); });
    out.years[y] = { rows: rows, done: Y.done, n: Y.n, fcMonths: Y.fcMonths.sort(function (a, b) { return a - b; }) };
  });
  out.cats = Object.keys(cats).sort(function (a, b) { return salesCatOrder_(a) - salesCatOrder_(b) || cats[b] - cats[a]; });
  out.note = '거래 ' + raw.n + '건' + (raw.skip ? ' · 금액 없는 행 ' + raw.skip + '건 제외' : '') + (fc.length ? ' · 예정 = raw 탭 예측 열' : '');
  SALES_VIEW_TABS.forEach(function (name) {
    var sh = salesTab_(ss, name);
    out.views.push(sh ? salesView_(sh) : { name: name, err: '시트에 이 탭이 없습니다' });
  });
  try {
    var j = JSON.stringify(out), size = 90000, keys = {}, k = 0;
    for (var p = 0; p < j.length; p += size) keys['sales2:' + (k++)] = j.slice(p, p + size);
    if (k <= 20) { keys['sales2:n'] = String(k); cache.putAll(keys, SALES_CACHE_SEC); }
  } catch (e) {}
  return out;
}

// 항목 정리: 플랫폼 팜빌·베터빌은 플랫폼 이름, 학회 = 컨퍼런스빌 (시트 (매출) 탭과 같은 분류)
function salesCat_(plat, item) {
  plat = salesTxt_(plat); item = salesTxt_(item);
  if (/팜빌/.test(plat)) return '팜빌';
  if (/베터빌/.test(plat)) return '베터빌';
  if (/학회|컨퍼런스/.test(item) || /컨퍼런스/.test(plat)) return '컨퍼런스빌';
  if (/화상교육/.test(item)) return '화상교육';
  return item || '기타';
}
function salesCatOrder_(c) { var o = ['라이브세미나', '컨퍼런스빌', '광고', '팜빌', '설문', '학술지원', '포인트샵', '콘텐츠', '아카데미', '화상교육', '베터빌', '기타']; var i = o.indexOf(c); return i < 0 ? 50 : i; }
function salesPlat_(plat) { plat = salesTxt_(plat); return /팜빌/.test(plat) ? '팜빌' : /베터빌/.test(plat) ? '베터빌' : '닥터빌'; }

function salesAdd_(years, r, isFc) {
  var Y = years[r.y] || (years[r.y] = { map: {}, done: 0, n: 0, fcMonths: [] });
  var key = (isFc ? 'fc|' : '') + r.c + '|' + r.io + '|' + r.cat + '|' + r.gu;
  var o = Y.map[key] || (Y.map[key] = { c: r.c, io: r.io, cat: r.cat, gu: r.gu, m: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  if (isFc) { o.fc = true; if (Y.fcMonths.indexOf(r.mo) < 0) Y.fcMonths.push(r.mo); }
  else { Y.n++; if (r.mo > Y.done) Y.done = r.mo; }
  o.m[r.mo - 1] += r.amt;
}

function salesTxt_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function salesNum_(v) { if (typeof v === 'number') return v; var s = String(v == null ? '' : v).replace(/[^\d.\-]/g, ''); var n = Number(s); return s && !isNaN(n) ? n : null; }
function salesTab_(ss, name) {
  var sh = ss.getSheetByName(name), key = name.replace(/\s+/g, '');
  if (!sh) ss.getSheets().forEach(function (s) { if (!sh && s.getName().replace(/\s+/g, '') === key) sh = s; });
  return sh;
}

// raw (세부): 머리글 이름으로 열을 찾음 (no.·플랫폼·계정명·월·분기·적요·금액·거래처·내/외부·항목·기간) — 적요는 읽지 않음
function salesRaw_(ss) {
  var sh = salesTab_(ss, SALES_RAW_TAB);
  if (!sh) throw new Error('매출 시트에서 탭을 찾을 수 없습니다: ' + SALES_RAW_TAB);
  var v = sh.getDataRange().getValues(), hi = -1, col = {};
  for (var i = 0; i < Math.min(v.length, 10) && hi < 0; i++) {
    var hs = v[i].map(salesTxt_);
    if (hs.some(function (h) { return /^금액/.test(h); }) && hs.some(function (h) { return /^거래처/.test(h); })) hi = i;
  }
  if (hi < 0) throw new Error(SALES_RAW_TAB + ' 탭의 머리글(금액·거래처)을 찾지 못했습니다 — 구조가 바뀌었습니다');
  v[hi].forEach(function (h, j) {
    h = salesTxt_(h);
    if (/^플랫폼/.test(h)) col.plat = j; else if (/^월$/.test(h)) col.mon = j; else if (/^금액/.test(h)) col.amt = j;
    else if (/^거래처/.test(h)) col.c = j; else if (/^내.?\/?.?외/.test(h)) col.io = j; else if (/^항목/.test(h)) col.item = j;
    else if (/^기간/.test(h)) col.per = j;
  });
  ['mon', 'amt', 'c', 'io', 'item'].forEach(function (k) { if (col[k] == null) throw new Error(SALES_RAW_TAB + ' 탭에서 열을 찾지 못했습니다: ' + k + ' — 구조가 바뀌었습니다'); });
  var rows = [], skip = 0;
  for (var r = hi + 1; r < v.length; r++) {
    var row = v[r], amt = salesNum_(row[col.amt]), ym = salesYm_(row[col.mon], col.per != null ? row[col.per] : '');
    if (!ym) continue;
    if (amt == null || amt === 0) { skip++; continue; }
    var plat = col.plat != null ? row[col.plat] : '';
    rows.push({ y: ym.y, mo: ym.m, amt: amt, c: salesTxt_(row[col.c]) || '(거래처 미기재)', io: /외/.test(salesTxt_(row[col.io])) ? '외부' : '내부',
      cat: salesCat_(plat, row[col.item]), gu: salesPlat_(plat) });
  }
  return { rows: rows, n: rows.length, skip: skip };
}
function salesYm_(mon, per) {   // 202601 / '202601' / Date / '26년 1월'
  if (mon instanceof Date) return { y: String(mon.getFullYear()), m: mon.getMonth() + 1 };
  var s = String(mon == null ? '' : mon).replace(/\.0+$/, ''), m = /^(20\d\d)(\d\d)$/.exec(s.replace(/\D/g, ''));
  if (m && +m[2] >= 1 && +m[2] <= 12) return { y: m[1], m: +m[2] };
  m = /(\d{2,4})\s*년\s*(\d{1,2})\s*월/.exec(String(per || ''));
  if (m) return { y: m[1].length === 2 ? '20' + m[1] : m[1], m: +m[2] };
  return null;
}

// raw 탭: 월 머리글('26년 11월') 위쪽 행에 '예측' 표시가 있는 열만 → 예정 매출 (구분·플랫폼·항목 행)
function salesForecast_(ss) {
  var sh = salesTab_(ss, SALES_FC_TAB);
  if (!sh) return [];
  var v = sh.getDataRange().getValues(), hi = -1;
  for (var i = 0; i < Math.min(v.length, 12) && hi < 0; i++) {
    var hs = v[i].map(salesTxt_);
    if (hs[0] === '구분' && hs.some(function (h) { return /\d+\s*년\s*\d+\s*월/.test(h); })) hi = i;
  }
  if (hi < 0) return [];
  var cols = [];
  v[hi].forEach(function (h, j) {
    var ym = salesYm_('', salesTxt_(h)); if (!ym) return;
    var mark = false; for (var k = 0; k < hi; k++) if (/예측|예정/.test(salesTxt_(v[k][j]))) mark = true;
    if (mark) cols.push({ j: j, y: ym.y, m: ym.m });
  });
  if (!cols.length) return [];
  var out = [];
  for (var r = hi + 1; r < v.length; r++) {
    var io = salesTxt_(v[r][0]), plat = v[r][1], item = salesTxt_(v[r][2]);
    if (!/내부|외부/.test(io) || !item) continue;
    cols.forEach(function (c) {
      var amt = salesNum_(v[r][c.j]);
      if (amt) out.push({ y: c.y, mo: c.m, amt: amt, c: '(예정) ' + salesCat_(plat, item), io: /외/.test(io) ? '외부' : '내부', cat: salesCat_(plat, item), gu: salesPlat_(plat) });
    });
  }
  return out;
}

// 시트 탭 → 격자 (숨긴 행 제외, 숨긴 열은 hc 로 표시, 끝의 빈 행·열 제외)
function salesView_(sh) {
  var nr = sh.getLastRow(), nc = sh.getLastColumn();
  if (!nr || !nc) return { name: sh.getName(), err: '빈 탭입니다' };
  var rg = sh.getRange(1, 1, nr, nc);
  var dv = rg.getDisplayValues(), val = rg.getValues(), nf = rg.getNumberFormats(), bg = rg.getBackgrounds(), fc = rg.getFontColors(),
    fw = rg.getFontWeights(), fs = rg.getFontSizes(), fi = rg.getFontStyles(), ha = rg.getHorizontalAlignments(), va = rg.getVerticalAlignments(), wr = rg.getWraps();
  var rows = [], cols = [];
  var hid = {};
  for (var c = 1; c <= nc; c++) { cols.push(c); if (sh.isColumnHiddenByUser(c)) hid[c] = 1; }
  for (var r = 1; r <= nr; r++) if (!sh.isRowHiddenByUser(r) && !sh.isRowHiddenByFilter(r)) rows.push(r);
  var used = function (r0, c0) { return dv[r0 - 1][c0 - 1] !== '' || !!salesBg_(bg[r0 - 1][c0 - 1]); };
  while (cols.length && !rows.some(function (r0) { return used(r0, cols[cols.length - 1]); })) cols.pop();
  while (rows.length && !cols.some(function (c0) { return used(rows[rows.length - 1], c0); })) rows.pop();
  var styles = [], sIdx = {}, ri = {}, ci = {};
  rows.forEach(function (r0, i) { ri[r0] = i; }); cols.forEach(function (c0, i) { ci[c0] = i; });
  var cells = rows.map(function (r0) {
    return cols.map(function (c0) {
      var R = r0 - 1, C = c0 - 1, color = salesFmtColor_(nf[R][C], val[R][C]) || (fc[R][C] && !/^#0{6}$/i.test(fc[R][C]) ? fc[R][C] : '');
      var h = String(ha[R][C] || '').replace(/^general-?/, '') || (typeof val[R][C] === 'number' ? 'right' : 'left');
      var st = [salesBg_(bg[R][C]), color, fw[R][C] === 'bold' ? 1 : 0, fs[R][C] || 10, fi[R][C] === 'italic' ? 1 : 0, h, va[R][C] || 'bottom', wr[R][C] ? 1 : 0].join('|');
      if (sIdx[st] == null) { sIdx[st] = styles.length; styles.push(st); }
      return dv[R][C] === '' ? sIdx[st] : [dv[R][C], sIdx[st]];
    });
  });
  var merges = [];
  rg.getMergedRanges().forEach(function (m) {
    var r0 = m.getRow(), c0 = m.getColumn(), r1 = r0 + m.getNumRows() - 1, c1 = c0 + m.getNumColumns() - 1, a = null, b = null, rs = 0, cs = 0;
    rows.forEach(function (x) { if (x >= r0 && x <= r1) { if (a == null) a = ri[x]; rs++; } });
    cols.forEach(function (x) { if (x >= c0 && x <= c1) { if (b == null) b = ci[x]; cs++; } });
    if (a != null && b != null && (rs > 1 || cs > 1)) merges.push([a, b, rs, cs]);
  });
  return { name: sh.getName(), gid: sh.getSheetId(), w: cols.map(function (c0) { return sh.getColumnWidth(c0); }), h: [],   // 행 높이는 기본값 사용(호출 수를 줄여 속도 확보)
    cl: cols.map(salesColName_), rl: rows, hc: cols.map(function (c0) { return hid[c0] ? 1 : 0; }), st: styles, cells: cells, merges: merges };
}
function salesBg_(b) { return b && !/^#f{6}$/i.test(b) ? b : ''; }
function salesColName_(c) { var s = ''; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
// 숫자 서식의 [Blue]·[Red] 색 → 값 부호에 맞는 색 (getDisplayValues 에는 색이 없음)
function salesFmtColor_(f, v) {
  if (!f || f.indexOf('[') < 0 || typeof v !== 'number') return '';
  var sec = f.split(';'), s = v > 0 ? sec[0] : v < 0 ? (sec[1] || sec[0]) : (sec[2] || sec[0]);
  var m = /\[(Blue|Red|Green|Magenta|Cyan|Yellow|Black|White)\]/i.exec(s || '');
  if (!m) return '';
  return { blue: '#1155cc', red: '#d93025', green: '#188038', magenta: '#a142f4', cyan: '#12b5cb', yellow: '#b06000', black: '', white: '#ffffff' }[m[1].toLowerCase()] || '';
}

function menuCheckSales() {
  var msg;
  try {
    var d = salesData_(true), ys = Object.keys(d.years).sort(), last = ys[ys.length - 1], Y = d.years[last], t = 0, f = 0;
    Y.rows.forEach(function (r) { var s = r.m.reduce(function (a, b) { return a + b; }, 0); if (r.fc) f += s; else t += s; });
    msg = '✅ 매출 시트 연결 정상\n' + d.source + '\n' + ys.join('·') + '년 · ' + last + '년 1~' + Y.done + '월 실적 ' + (t / 1e8).toFixed(1) + '억' + (f ? ' · 예정 ' + (f / 1e8).toFixed(1) + '억' : '') +
      '\n항목: ' + d.cats.join(', ') + '\n탭: ' + d.views.map(function (v) { return v.name + (v.err ? '(' + v.err + ')' : ' ' + v.cells.length + '행'); }).join(' / ');
  } catch (e) {
    msg = '❌ 매출 시트를 읽지 못했습니다: ' + (e && e.message || e) + '\n배포 계정(' + Session.getEffectiveUser().getEmail() + ')에 매출 시트 보기 권한이 있는지 확인해 주세요.';
  }
  Logger.log(msg);
  // 편집기에서 실행할 때 alert 를 띄우면 시트 화면의 확인 버튼을 기다리다 '시간 초과'가 나므로, 기다리지 않는 토스트로 표시
  try { SpreadsheetApp.getActive().toast(msg.slice(0, 250), '매출 시트 연결 확인', 15); } catch (e2) {}
  return msg;
}
