// 닥터빌 운영 대시보드 — 회원 활동 주간 업무 Edge Function (weekly-activity)
// 열람: 최고 관리자(super) + 최고 관리자가 [계정 관리]에서 지정한 사람(public.view_grants, view = 'wact')
// 데이터: 주간 업무 보고 DB(별도 Supabase 프로젝트)의 제출 완료(status = 'submitted') 보고 중 서비스 닥터빌·공통 항목
//   → 대시보드 DB(datasets)에는 저장하지 않음 (지정된 사람만 보도록)
//
// 배포: Supabase 대시보드(Dashboard_DV) → Edge Functions → Deploy a new function → Via Editor → 이름 weekly-activity → 이 코드 붙여넣기 → Deploy
//   배포 후 함수 Settings의 'Verify JWT with legacy secret'은 끔 (이 코드가 직접 로그인·권한을 확인)
// 비밀값(필수, Edge Functions → Secrets): 코드·저장소에는 절대 넣지 않음
//   WEEKLY_SB_URL = 주간 업무 보고 프로젝트 URL (https://<ref>.supabase.co)
//   WEEKLY_SB_KEY = 주간 업무 보고 프로젝트의 service_role(secret) 키 — 서버에서 읽기 전용으로만 사용
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ALLOW_ORIGINS = ['https://ojungin.github.io'];
const SERVICES = ['닥터빌', '공통'];
const WEEKS = 12;            // 최근 몇 주까지
const MAX_RESULT = 1500;     // 결과(실적) 최대 글자 수

function serviceKey() {
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (k) return k;
  try { const o = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); return o.default || Object.values(o)[0] as string; } catch { return ''; }
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
function ymd(d: Date) { return d.toISOString().slice(0, 10); }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return out(req, { ok: false, error: 'method' }, 405);
  try {
    // 1) 호출한 사람 확인 (대시보드 프로젝트)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), { auth: { persistSession: false } });
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
    if (whoErr || !who?.user) return out(req, { ok: false, error: '로그인이 필요합니다.' }, 401);
    const { data: me } = await admin.from('profiles').select('id, role, active').eq('id', who.user.id).maybeSingle();
    if (!me || !me.active) return out(req, { ok: false, error: '사용할 수 없는 계정입니다.' }, 403);
    if (me.role === 'partner') return out(req, { ok: false, error: '내부 담당자만 볼 수 있습니다.' }, 403);
    if (me.role !== 'super') {
      const { data: g } = await admin.from('view_grants').select('view').eq('user_id', me.id).eq('view', 'wact').maybeSingle();
      if (!g) return out(req, { ok: false, error: '회원 활동 주간 업무는 최고 관리자가 지정한 사람만 볼 수 있습니다.' }, 403);
    }
    // 2) 주간 업무 보고 프로젝트 읽기
    const wUrl = Deno.env.get('WEEKLY_SB_URL'), wKey = Deno.env.get('WEEKLY_SB_KEY');
    if (!wUrl || !wKey) return out(req, { ok: false, error: '주간 업무 보고 DB 연결 정보가 없습니다. Edge Function Secrets에 WEEKLY_SB_URL · WEEKLY_SB_KEY를 추가해 주세요.' }, 500);
    const wk = createClient(wUrl, wKey, { auth: { persistSession: false } });
    const since = ymd(new Date(Date.now() - (WEEKS * 7 + 7) * 86400000));
    const [rep, mem] = await Promise.all([
      wk.from('reports').select('user_id, week_start, items').eq('status', 'submitted').gte('week_start', since).order('week_start', { ascending: false }).limit(500),
      wk.from('members').select('id, name'),
    ]);
    if (rep.error) throw new Error('reports: ' + rep.error.message);
    if (mem.error) throw new Error('members: ' + mem.error.message);
    const names = new Map((mem.data || []).map((m: any) => [m.id, m.name]));
    const items: any[] = [];
    for (const r of rep.data || []) {
      for (const it of (Array.isArray(r.items) ? r.items : [])) {
        if (!it || !SERVICES.includes(String(it.service || '').trim())) continue;
        const title = String(it.title || '').trim(); if (!title) continue;
        items.push({
          week: r.week_start, owner: names.get(r.user_id) || '', service: it.service, project: it.project || '',
          title, state: it.state || '', progress: Math.max(0, Math.min(100, Number(it.progress) || 0)),
          result: String(it.result || '').trim().slice(0, MAX_RESULT), target: it.target_date || '',
        });
      }
    }
    const weeks = Array.from(new Set(items.map((x) => x.week))).sort().reverse().slice(0, WEEKS);
    return out(req, { ok: true, fetchedAt: new Date().toISOString(), weeks, items: items.filter((x) => weeks.includes(x.week)) });
  } catch (e) {
    return out(req, { ok: false, error: '주간 업무 보고를 불러오지 못했습니다: ' + ((e as Error).message || e) }, 500);
  }
});
