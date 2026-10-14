// 닥터빌 · 팜빌 운영 대시보드 — 계정 관리 Edge Function (admin-users)
// 최고 관리자(profiles.role = 'super')만 호출 가능. 계정 등록·수정·비밀번호 재설정·삭제.
// 배포: Supabase 대시보드 → Edge Functions → Deploy a new function → Via Editor → 이름 admin-users → 이 코드 붙여넣기 → Deploy
// 배포 후 Settings 탭의 'Verify JWT with legacy secret'은 끔 (이 코드가 직접 로그인·최고 관리자 여부를 확인)
// SUPABASE_URL · SUPABASE_ANON_KEY · SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동으로 넣어 줍니다 (따로 설정하지 않음).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ALLOW_ORIGINS = ['https://ojungin.github.io'];
const ROLES = ['super', 'admin', 'dv', 'partner'];
// 관리자 키: 기존 SUPABASE_SERVICE_ROLE_KEY, 없으면 새 형식 SUPABASE_SECRET_KEYS({"default":"sb_secret_…"})
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
const s = (v: unknown, n = 200) => String(v ?? '').trim().slice(0, n);
function pwRule(pw: string) {
  if (pw.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return '비밀번호에 영문과 숫자를 함께 넣어 주세요.';
  return '';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return out(req, { ok: false, error: 'method' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, serviceKey(), { auth: { persistSession: false } });
    // 호출한 사람 확인 (로그인 토큰 → 사용자 → 프로필 권한)
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
    if (whoErr || !who?.user) return out(req, { ok: false, error: '로그인이 필요합니다.' }, 401);
    const { data: me } = await admin.from('profiles').select('id, role, active').eq('id', who.user.id).maybeSingle();
    if (!me || !me.active || me.role !== 'super') return out(req, { ok: false, error: '최고 관리자만 계정을 관리할 수 있습니다.' }, 403);

    const b = await req.json().catch(() => ({}));
    const action = s(b.action, 20);
    const superCount = async () => (await admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'super').eq('active', true)).count || 0;

    if (action === 'create') {
      const email = s(b.email, 200).toLowerCase(), password = String(b.password || ''), role = s(b.role, 10);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return out(req, { ok: false, error: '아이디는 이메일 형식으로 입력해 주세요.' }, 400);
      if (!ROLES.includes(role)) return out(req, { ok: false, error: '권한을 선택해 주세요.' }, 400);
      if (!s(b.name)) return out(req, { ok: false, error: '이름을 입력해 주세요.' }, 400);
      const pe = pwRule(password); if (pe) return out(req, { ok: false, error: pe }, 400);
      const { data: cu, error: ce } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (ce || !cu?.user) return out(req, { ok: false, error: /already|registered|exists/i.test(ce?.message || '') ? '이미 등록된 아이디입니다.' : '계정을 만들지 못했습니다: ' + (ce?.message || '') }, 400);
      const { error: pe2 } = await admin.from('profiles').insert({ id: cu.user.id, email, name: s(b.name, 60), org: s(b.org, 100), role, created_by: me.id, updated_by: me.id });
      if (pe2) { await admin.auth.admin.deleteUser(cu.user.id); return out(req, { ok: false, error: '프로필 저장 실패: ' + pe2.message }, 500); }
      return out(req, { ok: true, id: cu.user.id });
    }

    const id = s(b.id, 60);
    if (!id) return out(req, { ok: false, error: '대상 계정이 없습니다.' }, 400);
    const { data: target } = await admin.from('profiles').select('id, role').eq('id', id).maybeSingle();
    if (!target) return out(req, { ok: false, error: '계정을 찾지 못했습니다.' }, 404);

    if (action === 'update') {
      const role = s(b.role, 10);
      if (!ROLES.includes(role)) return out(req, { ok: false, error: '권한을 선택해 주세요.' }, 400);
      if (!s(b.name)) return out(req, { ok: false, error: '이름을 입력해 주세요.' }, 400);
      if (target.role === 'super' && role !== 'super' && (await superCount()) <= 1) return out(req, { ok: false, error: '최고 관리자는 최소 1명이 있어야 합니다.' }, 400);
      const { error } = await admin.from('profiles').update({ name: s(b.name, 60), org: s(b.org, 100), role, updated_by: me.id }).eq('id', id);
      if (error) return out(req, { ok: false, error: error.message }, 500);
      return out(req, { ok: true });
    }
    if (action === 'reset') {
      const password = String(b.password || ''); const pe = pwRule(password); if (pe) return out(req, { ok: false, error: pe }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) return out(req, { ok: false, error: error.message }, 500);
      await admin.from('profiles').update({ updated_by: me.id }).eq('id', id);
      return out(req, { ok: true });
    }
    if (action === 'delete') {
      if (id === me.id) return out(req, { ok: false, error: '내 계정은 삭제할 수 없습니다.' }, 400);
      if (target.role === 'super' && (await superCount()) <= 1) return out(req, { ok: false, error: '최고 관리자는 최소 1명이 있어야 합니다.' }, 400);
      const { error } = await admin.auth.admin.deleteUser(id);   // profiles 는 on delete cascade 로 함께 삭제
      if (error) return out(req, { ok: false, error: error.message }, 500);
      return out(req, { ok: true });
    }
    return out(req, { ok: false, error: '알 수 없는 요청입니다.' }, 400);
  } catch (e) {
    return out(req, { ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
