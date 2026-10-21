// 닥터빌 · 팜빌 운영 대시보드 — LLM 질의응답 Edge Function (llm-ask)
// 내부 담당자(최고 관리자·관리자·닥터빌 담당자)만 호출 가능. 협력사 계정은 거부합니다.
// 대시보드 DB(public.datasets 저장본 + 컨퍼런스·세미나·광고 등록 표)를 Claude가 도구로 조회해 질문에 답합니다.
//
// 배포: Supabase 대시보드 → Edge Functions → Deploy a new function → Via Editor → 이름 llm-ask → 이 코드 붙여넣기 → Deploy
//   배포 후 함수 Settings 탭의 'Verify JWT with legacy secret'은 끔 (이 코드가 직접 로그인·권한을 확인)
// 비밀값(필수): Edge Functions → Secrets(또는 Project Settings → Edge Functions → Secrets)에 추가
//   ANTHROPIC_API_KEY = Claude Console에서 발급한 API 키 (코드·저장소·대시보드 화면에는 절대 넣지 않음)
// 선택: LLM_MODEL_HAIKU (기본 claude-haiku-5-5), LLM_MODEL_SONNET (기본 claude-sonnet-5-5)
// SUPABASE_URL · SUPABASE_ANON_KEY · SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동으로 넣어 줍니다.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ALLOW_ORIGINS = ['https://ojungin.github.io'];
const INTERNAL_ROLES = ['super', 'admin', 'dv'];
const MAX_ROUNDS = 8;            // 도구 호출 왕복 최대 횟수
const MAX_TOOL_CHARS = 24000;    // 도구 결과 1회 최대 글자 수
const MAX_Q = 2000;              // 질문 최대 글자 수

function serviceKey() {
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (k) return k;
  try { const o = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); return o.default || Object.values(o)[0] as string; } catch { return ''; }
}
function anonKey() {
  const k = Deno.env.get('SUPABASE_ANON_KEY');
  if (k) return k;
  try { const o = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}'); return o.default || Object.values(o)[0] as string; } catch { return ''; }
}
function cors(req: Request) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGINS.includes(o) ? o : ALLOW_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
function out(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
}

// ---- 데이터 목록 설명 (저장본 키 → 무엇인지) ---------------------------------
function describeKey(key: string) {
  const rules: [RegExp, string][] = [
    [/^api\|get\|dv\|.*month/, '닥터빌 회원 집계 — 선택한 기준 월 스냅샷'],
    [/^api\|get\|dv\|.*week/, '닥터빌 회원 집계 — 선택한 과거 주차 스냅샷'],
    [/^api\|get\|dv/, '닥터빌 회원 집계 최신 스냅샷 (snap.kpi 회원 수·신규·활성·수신동의, snap.dims 직종/진료과/지역/가입경로/연령 등 분포, snap.weekly·monthlySeries 추이, snap.monthly 올해/작년 월별 가입, index.snapshots 주차 이력)'],
    [/^api\|get\|pv\|.*month/, '팜빌 회원 집계 — 선택한 기준 월 스냅샷'],
    [/^api\|get\|pv\|.*week/, '팜빌 회원 집계 — 선택한 과거 주차 스냅샷'],
    [/^api\|get\|pv/, '팜빌(약사) 회원 집계 최신 스냅샷 (구조는 닥터빌 회원과 같음)'],
    [/^api\|activity$/, '닥터빌 활동성(GA) — activity.weekly/monthly 주간·월간 지표(DAU·WAU·MAU 등), pageWeekly/pageMonthly 페이지별 지표 (cols + rows 표 형식)'],
    [/^api\|activityPv/, '팜빌 활동성(GA) — 주간·월간·메뉴별·유입경로·일별 활성 사용자 (cols + rows)'],
    [/^api\|sales/, '닥터빌 매출 — sales.years[연도].rows[{c 고객사, io 내부/외부, cat 사업내용(광고·세미나·컨퍼런스·기타), gu 구분, m 1~12월 금액(원), n 횟수}]'],
    [/^api\|schedule/, '세미나 편성표 월별 일정 — schedule.rows (날짜·시간·상태·유형·회사·카테고리·행사명 등)'],
    [/^api\|ads/, '닥터빌 광고 운영 현황 — ads.agg[연도].exec(실행월)/settle(정산월).months[12](conf 확정·fc 예측 금액 만원, cIn/cEx 내부/외부, n 칸 수), grid 위치·슬롯별, forecast 예측 근거, crm 외부 고객사 / ads.weeks 주별 / ads.targets 월 목표(만원) / ads.cap 유상 광고칸'],
    [/^api\|calendar/, '구글 캘린더(닥터빌 마케팅팀) 월 일정 — calendar.events (휴가·연차·반차 제외)'],
    [/points/, '포인트 집계 (적립·사용·잔여·방법별·이상치, 월별/주별)'],
    [/seminar/, '세미나 월별 진행 건수 집계 (구분별 건수, 연간 편성)'],
    [/pv_activity/, '팜빌 활동성 저장본'],
    [/report/, '분석 리포트 생성 이력'],
  ];
  for (const [re, d] of rules) if (re.test(key)) return d;
  return '기타 저장본';
}
const TABLES: Record<string, { cols: string; desc: string; order: string }> = {
  conferences: { cols: 'date,end_date,name,host_type,host,start_time,end_time,place,scale,pm,note', order: 'date', desc: '컨퍼런스 현황 — 대시보드에 등록한 행사' },
  seminar_entries: { cols: 'kind,sheet_month,date,time,fields', order: 'date', desc: '세미나 현황 — 대시보드에서 직접 등록·수정·숨김한 세미나 (kind new/edit/hidden)' },
  ad_entries: { cols: 'year,month,settle_year,settle_month,pos,slot,gu,company,content,start_date,end_date,amount,status', order: 'year', desc: '광고 — 대시보드 ③에서 등록한 광고 (금액 원 단위, 시트 집계에는 없는 건). 담당자·메모는 제공하지 않음' },
};

// ---- JSON 경로 조회 · 요약 --------------------------------------------------
// 경로 예: "snap.kpi" · "sales.years.2026.rows[0:30]" · "ads.agg.2026.exec.months[9]"
function pick(root: unknown, path: string) {
  let cur: any = root;
  const parts = String(path || '').match(/[^.[\]]+|\[\d*:?\d*\]/g) || [];
  for (const p of parts) {
    if (cur == null) return undefined;
    const sl = /^\[(\d*):(\d*)\]$/.exec(p), ix = /^\[(\d+)\]$/.exec(p);
    if (sl && Array.isArray(cur)) cur = cur.slice(sl[1] ? +sl[1] : 0, sl[2] ? +sl[2] : undefined);
    else if (ix && Array.isArray(cur)) cur = cur[+ix[1]];
    else if (/^\d+$/.test(p) && Array.isArray(cur)) cur = cur[+p];
    else cur = cur[p];
  }
  return cur;
}
function outline(v: any, depth = 0): any {
  if (Array.isArray(v)) return depth > 2 ? `[배열 ${v.length}개]` : { '배열 길이': v.length, '첫 항목': v.length ? outline(v[0], depth + 1) : null };
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (depth > 2) return `{객체: ${ks.slice(0, 12).join(', ')}${ks.length > 12 ? ' …' : ''}}`;
    const o: Record<string, unknown> = {};
    ks.slice(0, 40).forEach((k) => { o[k] = outline(v[k], depth + 1); });
    if (ks.length > 40) o['…'] = `외 ${ks.length - 40}개 키`;
    return o;
  }
  return typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v;
}
function clip(v: unknown) {
  let s = JSON.stringify(v);
  if (s === undefined) return '해당 경로에 값이 없습니다. describe_dataset으로 구조를 먼저 확인하세요.';
  if (s.length <= MAX_TOOL_CHARS) return s;
  if (Array.isArray(v)) {
    let n = v.length;
    while (n > 1 && JSON.stringify(v.slice(0, n)).length > MAX_TOOL_CHARS) n = Math.floor(n / 2);
    return JSON.stringify({ '전체 길이': v.length, '앞부분': v.slice(0, n), '안내': `너무 길어 앞 ${n}개만 보냅니다. 경로에 [시작:끝] 범위를 지정하세요.` });
  }
  return JSON.stringify({ '안내': '결과가 너무 깁니다. 더 구체적인 경로로 다시 조회하세요.', '구조': outline(v) }).slice(0, MAX_TOOL_CHARS);
}

const TOOLS = [
  { name: 'list_datasets', description: '대시보드 DB에 저장된 데이터 목록(키, 설명, 저장 시각)과 등록 표 목록을 돌려줍니다. 먼저 호출하세요.', input_schema: { type: 'object', properties: {} } },
  { name: 'describe_dataset', description: '저장본 하나의 JSON 구조(키·배열 길이·첫 항목 예시)를 돌려줍니다. 경로를 정하기 전에 사용하세요.', input_schema: { type: 'object', properties: { key: { type: 'string', description: 'list_datasets의 key (예: api|get|dv, table|ad_entries)' }, path: { type: 'string', description: '선택: 이 경로 아래 구조만 (예: snap.dims)' } }, required: ['key'] } },
  { name: 'get_data', description: '저장본에서 경로의 값을 돌려줍니다. 경로 예: snap.kpi, sales.years.2026.rows[0:40], ads.agg.2026.exec.months. 긴 배열은 [시작:끝]으로 나눠 조회하세요.', input_schema: { type: 'object', properties: { key: { type: 'string' }, path: { type: 'string', description: '점(.)과 [i] / [시작:끝] 경로. 비우면 전체' } }, required: ['key'] } },
];

function system(today: string) {
  return [
    '당신은 엠서클 닥터빌·팜빌 운영 대시보드의 데이터 분석가입니다. 사용자는 닥터빌 내부 담당자입니다.',
    `오늘 날짜(한국): ${today}.`,
    '규칙:',
    '1. 답은 반드시 도구(list_datasets → describe_dataset → get_data)로 조회한 DB 데이터에만 근거합니다. 추측하거나 지어내지 않습니다.',
    '2. 질문의 요구사항(지표·기간·비교 대상·단위)을 먼저 정리하고, 필요한 데이터만 골라 조회합니다.',
    '3. 데이터에 없거나 부족하면 무엇이 없는지 밝히고, 어떤 메뉴/갱신이 필요한지 안내합니다.',
    '4. 숫자는 단위를 붙여 정확히 쓰고(원·만원·억, 명, %), 계산했다면 계산식을 짧게 적습니다. 데이터의 기준 시각(저장 시각)을 함께 밝힙니다.',
    '5. 개인을 식별할 수 있는 정보는 다루지 않습니다.',
    '6. 한국어로, 다음 형식으로 답합니다: **요약**(1~3문장) → 근거(필요하면 마크다운 표) → 해석·제안(있을 때만, 짧게) → "사용 데이터: 키 · 저장 시각".',
  ].join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return out(req, { ok: false, error: 'method' }, 405);
  const t0 = Date.now();
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return out(req, { ok: false, error: 'LLM API 키가 설정되지 않았습니다. Supabase Edge Function Secrets에 ANTHROPIC_API_KEY를 추가해 주세요.' }, 500);
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, serviceKey(), { auth: { persistSession: false } });
    const authz = req.headers.get('Authorization') || '';
    const jwt = authz.replace(/^Bearer\s+/i, '');
    const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
    if (whoErr || !who?.user) return out(req, { ok: false, error: '로그인이 필요합니다.' }, 401);
    const { data: me } = await admin.from('profiles').select('id, role, active').eq('id', who.user.id).maybeSingle();
    if (!me || !me.active || !INTERNAL_ROLES.includes(me.role)) return out(req, { ok: false, error: 'LLM 메뉴는 내부 담당자만 사용할 수 있습니다.' }, 403);
    // 데이터 조회는 호출한 사람 권한(RLS)으로
    const db = createClient(url, anonKey(), { auth: { persistSession: false }, global: { headers: { Authorization: authz } } });

    const b = await req.json().catch(() => ({}));
    const q = String(b.question || '').trim().slice(0, MAX_Q);
    if (!q) return out(req, { ok: false, error: '질문을 입력해 주세요.' }, 400);
    const modelKey = b.model === 'sonnet' ? 'sonnet' : 'haiku';
    const model = modelKey === 'sonnet' ? (Deno.env.get('LLM_MODEL_SONNET') || 'claude-sonnet-5-5') : (Deno.env.get('LLM_MODEL_HAIKU') || 'claude-haiku-5-5');
    const history = (Array.isArray(b.history) ? b.history : []).slice(-6)
      .filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
      .map((h: any) => ({ role: h.role, content: h.text.slice(0, 6000) }));

    const cache = new Map<string, unknown>();
    const used = new Map<string, string>();
    async function load(key: string) {
      if (cache.has(key)) return cache.get(key);
      let v: unknown;
      if (key.startsWith('table|')) {
        const t = key.slice(6), meta = TABLES[t];
        if (!meta) throw new Error('알 수 없는 표: ' + t);
        const { data, error } = await db.from(t).select(meta.cols).order(meta.order).limit(2000);
        if (error) throw new Error(error.message);
        v = data; used.set(key, '조회 시점');
      } else {
        const { data, error } = await db.from('datasets').select('data, fetched_at').eq('key', key).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error('저장본이 없습니다: ' + key);
        v = data.data; used.set(key, data.fetched_at);
      }
      cache.set(key, v);
      return v;
    }
    async function runTool(name: string, input: any) {
      try {
        if (name === 'list_datasets') {
          const { data, error } = await db.from('datasets').select('key, scope, source, fetched_at').order('key');
          if (error) throw new Error(error.message);
          return JSON.stringify({
            datasets: (data || []).filter((r: any) => !/^file\|data\/(accounts|meta|config)/.test(r.key)).map((r: any) => ({ key: r.key, 설명: describeKey(r.key), 저장시각: r.fetched_at, 원본: r.source })),
            tables: Object.entries(TABLES).map(([k, v]) => ({ key: 'table|' + k, 설명: v.desc })),
          });
        }
        const key = String(input?.key || '');
        if (/^file\|data\/(accounts|meta|config)/.test(key)) return '이 데이터는 조회할 수 없습니다.';
        const v = await load(key);
        if (name === 'describe_dataset') return clip(outline(input?.path ? pick(v, input.path) : v));
        if (name === 'get_data') return clip(input?.path ? pick(v, input.path) : v);
        return '알 수 없는 도구입니다.';
      } catch (e) { return '오류: ' + ((e as Error).message || e); }
    }

    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const messages: any[] = [...history, { role: 'user', content: q }];
    const steps: { tool: string; key?: string; path?: string }[] = [];
    const usage = { input: 0, output: 0 };
    let answer = '';
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 4096, system: system(today), messages, ...(last ? {} : { tools: TOOLS }) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = j?.error?.message || res.statusText;
        const hint = res.status === 401 ? ' (API 키를 확인해 주세요 — Claude Console에서 발급한 sk-ant-api… 형식의 키가 필요합니다)' : res.status === 404 ? ' (모델 ID를 확인해 주세요: ' + model + ')' : res.status === 429 ? ' (요청이 많습니다. 잠시 후 다시 시도해 주세요)' : '';
        return out(req, { ok: false, error: 'Claude API 오류 ' + res.status + ': ' + msg + hint }, 502);
      }
      usage.input += j.usage?.input_tokens || 0; usage.output += j.usage?.output_tokens || 0;
      const content = j.content || [];
      messages.push({ role: 'assistant', content });
      const calls = content.filter((c: any) => c.type === 'tool_use');
      if (!calls.length || j.stop_reason !== 'tool_use') { answer = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim(); break; }
      const results = [];
      for (const c of calls) {
        steps.push({ tool: c.name, key: c.input?.key, path: c.input?.path });
        results.push({ type: 'tool_result', tool_use_id: c.id, content: await runTool(c.name, c.input) });
      }
      messages.push({ role: 'user', content: results });
    }
    if (!answer) answer = '답변을 만들지 못했습니다. 질문을 조금 더 구체적으로 해 주세요.';
    return out(req, { ok: true, answer, model, modelKey, usage, steps, used: [...used.entries()].map(([k, at]) => ({ key: k, at })), ms: Date.now() - t0 });
  } catch (e) {
    return out(req, { ok: false, error: '처리 중 오류: ' + ((e as Error).message || e) }, 500);
  }
});
