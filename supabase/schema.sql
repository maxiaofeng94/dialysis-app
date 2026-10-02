-- ============================================================
-- 透析记录 多人版 - Supabase 数据库结构
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴 → Run
-- 特性：本脚本可重复执行（幂等）——已建过的表只补列/补策略，不会报错、不会清数据
-- ============================================================

-- ---------- 1. 用户资料表 ----------
-- 先建：sessions.operator_id 要引用它（这样才能在查询里带出记录人姓名）

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  phone text,
  created_at timestamptz not null default now()
);

-- ---------- 2. 业务表 ----------

create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  birthday date,
  wheelchair_weight numeric not null default 0,
  rinse_back_volume int not null default 300,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dry_weights (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  value numeric not null,
  effective_date date not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  date date not null,
  pre_weight_measured numeric,
  post_weight_measured numeric,
  wheelchair_weight_used numeric not null,
  rinse_back_volume_used int not null,
  operator_id uuid references public.users(id) on delete set null,
  doctor_uf numeric,                                   -- 医生设定脱水量（ml，不参与自动计算）
  status text not null default 'ongoing',              -- ongoing / completed / aborted
  aborted_at timestamptz,                              -- 中止时间
  abort_tags text[] not null default '{}',             -- 中止原因快捷标签（可多选）
  abort_reason text,                                   -- 中止原因补充描述
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.blood_pressures (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  measured_at timestamptz not null,
  systolic int not null,
  diastolic int not null,
  note text
);

create table if not exists public.blood_glucoses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  measured_at timestamptz not null,
  value numeric not null,
  note text
);

create table if not exists public.blood_flows (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  measured_at timestamptz not null,
  value numeric not null,                              -- 血流量 ml/min
  note text
);

create table if not exists public.adverse_reactions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  type text not null,
  detail text,
  severity text,
  recorded_at timestamptz not null default now()
);

-- ---------- 3. 成员表 ----------

create table if not exists public.patient_members (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'caregiver',  -- owner / caregiver / doctor / viewer
  created_at timestamptz not null default now(),
  unique (patient_id, user_id)
);

-- ---------- 4. 增量补齐（对已跑过旧版 schema 的库同样有效） ----------

alter table public.sessions add column if not exists doctor_uf numeric;
alter table public.sessions add column if not exists aborted_at timestamptz;
alter table public.sessions add column if not exists abort_tags text[] not null default '{}';
alter table public.sessions add column if not exists abort_reason text;

-- operator_id 改为引用 public.users（原先指向 auth.users，PostgREST 无法关联出姓名）
alter table public.sessions drop constraint if exists sessions_operator_id_fkey;
alter table public.sessions
  add constraint sessions_operator_id_fkey
  foreign key (operator_id) references public.users(id) on delete set null;

-- ---------- 5. 索引 ----------

create index if not exists idx_dry_weights_patient on public.dry_weights(patient_id, effective_date);
create index if not exists idx_sessions_patient_date on public.sessions(patient_id, date);
create index if not exists idx_sessions_patient_created on public.sessions(patient_id, created_at);
create index if not exists idx_bp_session on public.blood_pressures(session_id);
create index if not exists idx_bg_session on public.blood_glucoses(session_id);
create index if not exists idx_bf_session on public.blood_flows(session_id);
create index if not exists idx_ar_session on public.adverse_reactions(session_id);
create index if not exists idx_members_patient on public.patient_members(patient_id);
create index if not exists idx_members_user on public.patient_members(user_id);

-- ---------- 6. 注册用户时自动写入 users 表 ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, name, phone)
  values (
    new.id,
    -- 没填姓名时退回手机号（注册用伪邮箱 {手机号}@phone.local）
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'name'), ''),
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    coalesce(new.raw_user_meta_data->>'phone', null)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- 7. 权限辅助函数 ----------

-- 判断当前登录用户是否是某病人的成员；allowed_roles 为空表示任意角色
create or replace function public.is_member(pid uuid, allowed_roles text[] default null)
returns boolean
language sql
security definer set search_path = public
as $$
  select exists (
    select 1 from public.patient_members
    where patient_id = pid
      and user_id = auth.uid()
      and (allowed_roles is null or role = any(allowed_roles))
  );
$$;

-- ---------- 8. RLS 行级权限 ----------
-- 先 drop 再 create：保证脚本可重复执行

-- 病人表：成员可看；登录用户可新建；owner 可改/删
alter table public.patients enable row level security;
drop policy if exists patients_select on public.patients;
drop policy if exists patients_insert on public.patients;
drop policy if exists patients_update on public.patients;
drop policy if exists patients_delete on public.patients;
create policy patients_select on public.patients for select using (public.is_member(id));
create policy patients_insert on public.patients for insert with check (auth.uid() is not null);
create policy patients_update on public.patients for update using (public.is_member(id, array['owner']));
create policy patients_delete on public.patients for delete using (public.is_member(id, array['owner']));

-- 干体重：成员可看；owner 可增删改
alter table public.dry_weights enable row level security;
drop policy if exists dw_select on public.dry_weights;
drop policy if exists dw_insert on public.dry_weights;
drop policy if exists dw_update on public.dry_weights;
drop policy if exists dw_delete on public.dry_weights;
create policy dw_select on public.dry_weights for select using (public.is_member(patient_id));
create policy dw_insert on public.dry_weights for insert with check (public.is_member(patient_id, array['owner']));
create policy dw_update on public.dry_weights for update using (public.is_member(patient_id, array['owner']));
create policy dw_delete on public.dry_weights for delete using (public.is_member(patient_id, array['owner']));

-- 透析记录：所有成员可看；owner/caregiver 可增删改
alter table public.sessions enable row level security;
drop policy if exists sessions_select on public.sessions;
drop policy if exists sessions_insert on public.sessions;
drop policy if exists sessions_update on public.sessions;
drop policy if exists sessions_delete on public.sessions;
create policy sessions_select on public.sessions for select using (public.is_member(patient_id));
create policy sessions_insert on public.sessions for insert with check (public.is_member(patient_id, array['owner','caregiver']));
create policy sessions_update on public.sessions for update using (public.is_member(patient_id, array['owner','caregiver']));
create policy sessions_delete on public.sessions for delete using (public.is_member(patient_id, array['owner','caregiver']));

-- 血压：通过 session 关联病人
alter table public.blood_pressures enable row level security;
drop policy if exists bp_select on public.blood_pressures;
drop policy if exists bp_insert on public.blood_pressures;
drop policy if exists bp_update on public.blood_pressures;
drop policy if exists bp_delete on public.blood_pressures;
create policy bp_select on public.blood_pressures for select using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id))
);
create policy bp_insert on public.blood_pressures for insert with check (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);
create policy bp_update on public.blood_pressures for update using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);
create policy bp_delete on public.blood_pressures for delete using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);

-- 血糖
alter table public.blood_glucoses enable row level security;
drop policy if exists bg_select on public.blood_glucoses;
drop policy if exists bg_insert on public.blood_glucoses;
drop policy if exists bg_update on public.blood_glucoses;
drop policy if exists bg_delete on public.blood_glucoses;
create policy bg_select on public.blood_glucoses for select using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id))
);
create policy bg_insert on public.blood_glucoses for insert with check (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);
create policy bg_update on public.blood_glucoses for update using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);
create policy bg_delete on public.blood_glucoses for delete using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);

-- 血流量
alter table public.blood_flows enable row level security;
drop policy if exists bf_select on public.blood_flows;
drop policy if exists bf_insert on public.blood_flows;
drop policy if exists bf_update on public.blood_flows;
drop policy if exists bf_delete on public.blood_flows;
create policy bf_select on public.blood_flows for select using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id))
);
create policy bf_insert on public.blood_flows for insert with check (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);
create policy bf_update on public.blood_flows for update using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);
create policy bf_delete on public.blood_flows for delete using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);

-- 不良反应
alter table public.adverse_reactions enable row level security;
drop policy if exists ar_select on public.adverse_reactions;
drop policy if exists ar_insert on public.adverse_reactions;
drop policy if exists ar_update on public.adverse_reactions;
drop policy if exists ar_delete on public.adverse_reactions;
create policy ar_select on public.adverse_reactions for select using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id))
);
create policy ar_insert on public.adverse_reactions for insert with check (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);
create policy ar_update on public.adverse_reactions for update using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);
create policy ar_delete on public.adverse_reactions for delete using (
  exists (select 1 from public.sessions s where s.id = session_id and public.is_member(s.patient_id, array['owner','caregiver']))
);

-- 成员表：成员可看成员列表；owner 可增删改
alter table public.patient_members enable row level security;
drop policy if exists pm_select on public.patient_members;
drop policy if exists pm_insert on public.patient_members;
drop policy if exists pm_update on public.patient_members;
drop policy if exists pm_delete on public.patient_members;
create policy pm_select on public.patient_members for select using (public.is_member(patient_id));
create policy pm_insert on public.patient_members for insert with check (public.is_member(patient_id, array['owner']));
create policy pm_update on public.patient_members for update using (public.is_member(patient_id, array['owner']));
create policy pm_delete on public.patient_members for delete using (public.is_member(patient_id, array['owner']));

-- 用户资料表：本人可读写；同一病人的成员可互相查看（成员列表、记录人姓名用）
-- 注意：子查询里的 users.id 必须写成表名限定，否则 patient_members 也有 id 列，会被解析成 pm.user_id = pm.id（恒假）
alter table public.users enable row level security;
drop policy if exists users_select on public.users;
drop policy if exists users_update on public.users;
create policy users_select on public.users for select using (
  users.id = auth.uid()
  or exists (
    select 1 from public.patient_members pm
    where pm.user_id = users.id
      and public.is_member(pm.patient_id)
  )
);
create policy users_update on public.users for update using (users.id = auth.uid());

-- ============================================================
-- 后台管理系统 增量（同样可重复执行）
-- 设计说明见 docs/后台管理系统设计说明.md
-- ============================================================

-- ---------- 9. 管理员名单 ----------
-- 单独建表，而不是给 users 加 is_admin 列：
-- users_update 策略允许用户更新自己那一行，若管理员标记放在 users 表里，任何人都能自我提权。
create table if not exists public.admins (
  user_id    uuid primary key references public.users(id) on delete cascade,
  note       text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 判断当前登录用户是否管理员（security definer：绕过 admins 表自身的 RLS）
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

alter table public.admins enable row level security;
drop policy if exists admins_select on public.admins;
create policy admins_select on public.admins for select using (user_id = auth.uid());
-- 故意不建 insert / update / delete 策略：
-- 普通请求（含管理员本人的 anon key 请求）一律写不进去，
-- 只有 SQL Editor（postgres）与后台 Edge Function（service_role）能授予/撤销管理员。

-- ---------- 10. 后台操作审计日志 ----------
create table if not exists public.admin_audit_logs (
  id          bigint generated always as identity primary key,
  admin_id    uuid references public.users(id) on delete set null,
  action      text not null,                         -- 如 user.setBanned / patient.update
  target_type text,                                  -- user / patient / member / admin
  target_id   text,
  detail      jsonb not null default '{}'::jsonb,    -- 变更摘要（不含密码等敏感值）
  created_at  timestamptz not null default now()
);
create index if not exists idx_admin_logs_created on public.admin_audit_logs(created_at desc);
create index if not exists idx_admin_logs_admin   on public.admin_audit_logs(admin_id);

alter table public.admin_audit_logs enable row level security;
drop policy if exists audit_select on public.admin_audit_logs;
create policy audit_select on public.admin_audit_logs for select using (public.is_admin());
-- 写入同样只走 service_role（后台 Edge Function），不建 insert 策略。

-- ---------- 11. 后台统计函数（仅 service_role 可执行） ----------
-- 按病人聚合记录条数与首末记录日期：后台只拿聚合数字，不读病历明细。
create or replace function public.admin_patient_stats()
returns table (patient_id uuid, session_count bigint, first_date date, last_date date)
language sql
stable
security definer set search_path = public
as $$
  select s.patient_id, count(*)::bigint, min(s.date), max(s.date)
  from public.sessions s
  group by s.patient_id;
$$;

revoke all on function public.admin_patient_stats() from public;
revoke all on function public.admin_patient_stats() from anon, authenticated;
grant execute on function public.admin_patient_stats() to service_role;

-- ---------- 12. 加固：用户只能改自己的姓名 ----------
-- 原先用户可更新自己 users 行的任意列（含 phone，且 phone 无唯一约束），
-- 收紧为列级权限；后台改姓名走 Edge Function（service_role），不受影响。
revoke update on public.users from anon, authenticated;
grant update (name) on public.users to authenticated;

-- ---------- 13. 首个管理员（手动执行一次；把手机号换成你自己的） ----------
-- insert into public.admins(user_id, note)
-- select id, '初始管理员' from public.users where phone = '13800000000'
-- on conflict (user_id) do nothing;
