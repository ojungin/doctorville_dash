-- 메뉴별 열람 지정 (최고 관리자가 지정) — 예: view = 'wact' 회원 활동 주간 업무
create table if not exists public.view_grants (
  user_id uuid not null references public.profiles(id) on delete cascade,
  view text not null,
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, view)
);
alter table public.view_grants enable row level security;
drop policy if exists view_grants_read on public.view_grants;
create policy view_grants_read on public.view_grants for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super' and p.active));
drop policy if exists view_grants_super on public.view_grants;
create policy view_grants_super on public.view_grants for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super' and p.active))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super' and p.active));
