-- =====================================================================
-- 닥터빌 · 팜빌 운영 대시보드 — Supabase 스키마
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 [Run]
-- (여러 번 실행해도 안전하도록 작성됨)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) 계정 프로필 (로그인은 Supabase Auth, 권한·이름·소속은 이 표)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null unique,
  name        text not null default '',
  org         text not null default '',
  role        text not null default 'dv' check (role in ('super', 'admin', 'dv', 'partner')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- 현재 로그인한 사용자의 권한 (RLS 정책에서 사용)
create or replace function public.my_role()
returns text
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() and active $$;

create or replace function public.is_internal()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(public.my_role() in ('super', 'admin', 'dv'), false) $$;

revoke all on function public.my_role() from public;
revoke all on function public.is_internal() from public;
grant execute on function public.my_role() to authenticated;
grant execute on function public.is_internal() to authenticated;

-- updated_at / updated_by 자동 기록
create or replace function public.touch_row()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_row();

alter table public.profiles enable row level security;
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.my_role() in ('super', 'admin'));
-- 등록·수정·삭제는 Edge Function(admin-users, 최고 관리자 확인 후 service role)으로만 처리 → 클라이언트 쓰기 정책 없음

-- ---------------------------------------------------------------------
-- 2) 데이터 저장소 (로그인·갱신 때 불러온 데이터를 저장, 이후 화면은 여기서 읽음)
--    key 예) api|get|dv · api|get|pv|{"week":"2026-W41"} · api|activity · api|sales
--           api|schedule|{"month":"2026-10"} · file|data/points.enc.json · file|data/seminar_pub.enc.json
--    scope: internal(내부 담당자만) / partner(협력사도 읽기 가능 — 세미나 요약)
-- ---------------------------------------------------------------------
create table if not exists public.datasets (
  key         text primary key,
  scope       text not null default 'internal' check (scope in ('internal', 'partner')),
  data        jsonb not null,
  source      text,
  fetched_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
drop trigger if exists datasets_touch on public.datasets;
create trigger datasets_touch before update on public.datasets for each row execute function public.touch_row();

alter table public.datasets enable row level security;
drop policy if exists datasets_select on public.datasets;
create policy datasets_select on public.datasets for select to authenticated
  using (public.is_internal() or (scope = 'partner' and public.my_role() = 'partner'));
drop policy if exists datasets_insert on public.datasets;
create policy datasets_insert on public.datasets for insert to authenticated with check (public.is_internal());
drop policy if exists datasets_update on public.datasets;
create policy datasets_update on public.datasets for update to authenticated using (public.is_internal()) with check (public.is_internal());
drop policy if exists datasets_delete on public.datasets;
create policy datasets_delete on public.datasets for delete to authenticated using (public.is_internal());

-- ---------------------------------------------------------------------
-- 3) 현황 > 컨퍼런스 행사 (기존 회원 시트 _conferences 탭 대체)
-- ---------------------------------------------------------------------
create table if not exists public.conferences (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  end_date    date,
  name        text not null check (char_length(name) between 1 and 200),
  host_type   text not null default '학회',
  host        text not null default '',
  start_time  text not null default '',
  end_time    text not null default '',
  place       text not null default '',
  scale       text not null default '',
  pm          text not null default '',
  note        text not null default '' check (char_length(note) <= 2000),
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now(),
  check (end_date is null or end_date >= date)
);
create index if not exists conferences_date_idx on public.conferences (date);

create or replace function public.touch_conf()
returns trigger
language plpgsql
as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists conferences_touch on public.conferences;
create trigger conferences_touch before update on public.conferences for each row execute function public.touch_conf();

alter table public.conferences enable row level security;
drop policy if exists conferences_all on public.conferences;
create policy conferences_all on public.conferences for all to authenticated
  using (public.is_internal()) with check (public.is_internal());

-- ---------------------------------------------------------------------
-- 4) 연동 비밀값 (구글시트 Apps Script·포인트 서버 비밀번호, 저장소 암호화 파일 키)
--    대시보드 [계정 관리 → 보안 키 설정]에서 최고 관리자가 시스템 비밀번호로 한 번 등록
--    sys_password, main_key: internal / part_key: partner(협력사 세미나 요약 파일용)
-- ---------------------------------------------------------------------
create table if not exists public.app_secrets (
  key         text primary key,
  value       text not null,
  scope       text not null default 'internal' check (scope in ('internal', 'partner')),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
drop trigger if exists app_secrets_touch on public.app_secrets;
create trigger app_secrets_touch before update on public.app_secrets for each row execute function public.touch_row();

alter table public.app_secrets enable row level security;
drop policy if exists app_secrets_select on public.app_secrets;
create policy app_secrets_select on public.app_secrets for select to authenticated
  using (public.is_internal() or (scope = 'partner' and public.my_role() = 'partner'));
drop policy if exists app_secrets_write on public.app_secrets;
create policy app_secrets_write on public.app_secrets for all to authenticated
  using (public.my_role() = 'super') with check (public.my_role() = 'super');

-- 익명(anon) 키로는 아무 표도 읽고 쓸 수 없음 (정책이 모두 authenticated 전용)
revoke all on public.profiles, public.datasets, public.conferences, public.app_secrets from anon;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.datasets, public.conferences, public.app_secrets to authenticated;

-- =====================================================================
-- 5) 최초 최고 관리자 등록 (한 번만)
--    ① Authentication → Users → [Add user] → Create new user
--       이메일 ojungin@mcircle.biz · 비밀번호 입력 · Auto Confirm User 체크
--    ② 아래 문장의 주석(--)을 지우고 실행
-- =====================================================================
-- insert into public.profiles (id, email, name, org, role)
-- select id, email, '오정인', '닥터빌 콘텐츠운영팀', 'super' from auth.users where email = 'ojungin@mcircle.biz'
-- on conflict (id) do update set role = 'super', active = true;
