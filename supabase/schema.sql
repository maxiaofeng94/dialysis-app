-- ============================================================
-- 透析记录 多人版 - Supabase 数据库结构
-- 执行位置：Supabase Dashboard → SQL Editor → 粘贴 → Run
-- ============================================================

-- ---------- 1. 业务表 ----------

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
  operator_id uuid references auth.users(id),
  status text not null default 'ongoing',
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

create table if not exists public.adverse_reactions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  type text not null,
  detail text,
  severity text,
  recorded_at timestamptz not null default now()
);

-- ---------- 2. 用户与成员 ----------

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  phone text,
  created_at timestamptz not null default now()
);

create table if not exists public.patient_members (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'caregiver',  -- owner / caregiver / doctor / viewer
  created_at timestamptz not null default now(),
  unique (patient_id, user_id)
);

-- ---------- 3. 短信验证码（仅服务端 Edge Function 访问）----------

create table if not exists public.otp_codes (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code text not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- 4. 索引 ----------

create index if not exists idx_dry_weights_patient on public.dry_weights(patient_id, effective_date);
create index if not exists idx_sessions_patient_date on public.sessions(patient_id, date);
create index if not exists idx_sessions_patient_created on public.sessions(patient_id, created_at);
create index if not exists idx_bp_session on public.blood_pressures(session_id);
create index if not exists idx_bg_session on public.blood_glucoses(session_id);
create index if not exists idx_ar_session on public.adverse_reactions(session_id);
create index if not exists idx_members_patient on public.patient_members(patient_id);
create index if not exists idx_members_user on public.patient_members(user_id);
create index if not exists idx_otp_phone on public.otp_codes(phone, created_at);

-- ---------- 5. 注册用户时自动写入 users 表 ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(coalesce(new.email,''),'@',1)),
    coalesce(new.raw_user_meta_data->>'phone', null)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- 6. 权限辅助函数 ----------

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

-- ---------- 7. RLS 行级权限 ----------

-- 病人表：成员可看；登录用户可新建；owner 可改/删
alter table public.patients enable row level security;
create policy patients_select on public.patients for select using (public.is_member(id));
create policy patients_insert on public.patients for insert with check (auth.uid() is not null);
create policy patients_update on public.patients for update using (public.is_member(id, array['owner']));
create policy patients_delete on public.patients for delete using (public.is_member(id, array['owner']));

-- 干体重：成员可看；owner 可增删改
alter table public.dry_weights enable row level security;
create policy dw_select on public.dry_weights for select using (public.is_member(patient_id));
create policy dw_insert on public.dry_weights for insert with check (public.is_member(patient_id, array['owner']));
create policy dw_update on public.dry_weights for update using (public.is_member(patient_id, array['owner']));
create policy dw_delete on public.dry_weights for delete using (public.is_member(patient_id, array['owner']));

-- 透析记录：所有成员可看；owner/caregiver 可增删改
alter table public.sessions enable row level security;
create policy sessions_select on public.sessions for select using (public.is_member(patient_id));
create policy sessions_insert on public.sessions for insert with check (public.is_member(patient_id, array['owner','caregiver']));
create policy sessions_update on public.sessions for update using (public.is_member(patient_id, array['owner','caregiver']));
create policy sessions_delete on public.sessions for delete using (public.is_member(patient_id, array['owner','caregiver']));

-- 血压：通过 session 关联病人
alter table public.blood_pressures enable row level security;
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

-- 不良反应
alter table public.adverse_reactions enable row level security;
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
create policy pm_select on public.patient_members for select using (public.is_member(patient_id));
create policy pm_insert on public.patient_members for insert with check (public.is_member(patient_id, array['owner']));
create policy pm_update on public.patient_members for update using (public.is_member(patient_id, array['owner']));
create policy pm_delete on public.patient_members for delete using (public.is_member(patient_id, array['owner']));

-- 用户资料表：本人可读写；同一病人的成员可互相查看（成员列表显示姓名/手机号用）
alter table public.users enable row level security;
create policy users_select on public.users for select using (
  id = auth.uid()
  or exists (
    select 1 from public.patient_members pm
    where pm.user_id = id
      and public.is_member(pm.patient_id)
  )
);
create policy users_update on public.users for update using (id = auth.uid());

-- 验证码表：不建任何策略（客户端完全不可直接访问，仅 Edge Function 用服务端密钥操作）
alter table public.otp_codes enable row level security;
