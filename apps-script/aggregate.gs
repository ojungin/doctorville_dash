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
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MemberAggregate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
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
   *                              asOf: true → 과거 시점 재계산(now 이후 가입자 제외, 로그인 경과는 activityNow 기준) }
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
    var nowK = kstDate(now), Y = nowK.getUTCFullYear();
    var cutoffMD = (nowK.getUTCMonth() + 1) * 100 + nowK.getUTCDate(); // 동기간 비교 기준 (MMDD)
    var monCur = [0,0,0,0,0,0,0,0,0,0,0,0], monLast = [0,0,0,0,0,0,0,0,0,0,0,0], ytdLast = 0, lastMtd = 0;

    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !row.length || row.every(function (c) { return !String(c || '').trim(); })) continue;
      var j = parseKst(row[idx['가입일시']]);
      if (asOf && j != null && j >= curWeek) continue;   // 과거 재계산: 기준 주 이후 가입자는 제외
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

      if (j != null && j <= now) {
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
      historical: asOf || undefined,
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
        thisYear: Y, lastYear: Y - 1, asOf: ymd(now), currentMonth: nowK.getUTCMonth() + 1,
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

  return { aggregate: aggregate, historyEntry: historyEntry, DIMS: DIMS, MIN_CELL: MIN_CELL, isoWeek: isoWeek, isoWeekStart: isoWeekStart };
});
