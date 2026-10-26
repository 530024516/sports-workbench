-- =============================================================
-- 体育教师工作台 · Supabase 表结构
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴执行（幂等，可重复运行）
--
-- 设计说明：
--   * 每张表对应工作台里的一类数据（学生、体测、教案、健身记录……）。
--   * 业务字段统一存放在 data(jsonb) 中：历史 localStorage 数据字段不固定，
--     这样迁移零损耗，也不会因为补字段而反复改表。
--   * id：单条记录的主键（集合型=记录 id；单例型=存储键名）。
--   * ord：集合型数据的显示顺序。
-- =============================================================

create table if not exists public.students (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.fitness_records (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.lesson_plans (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.resources (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.courses (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 周课表（整份课表作为一个对象存储）
create table if not exists public.course_schedule (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.todos (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 健身助手：一周训练记录（一条=一天，id 为日期 2026-10-26）
create table if not exists public.fitness_logs (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 大单元教学设计（单例）
create table if not exists public.unit_designs (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 运动会数据（报名 / 赛程 / 成绩，单例）
create table if not exists public.sports_meet (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 应用设置：单双周模式、工作台显示设置、运动会标题等（一行一个键）
create table if not exists public.app_settings (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  updated_at timestamptz not null default now()
);

-- =============================================================
-- 访问策略（RLS）
-- 前端使用 anon key 直连，因此必须开启策略才能读写。
-- ⚠️ 下面这条策略允许匿名读写，仅适合个人自用、未公开部署的场景。
--    若要多人使用或公网部署，请改为 Supabase Auth + 按 user_id 限定的策略。
-- =============================================================

alter table public.students enable row level security;
alter table public.fitness_records enable row level security;
alter table public.attendance enable row level security;
alter table public.lesson_plans enable row level security;
alter table public.resources enable row level security;
alter table public.courses enable row level security;
alter table public.course_schedule enable row level security;
alter table public.todos enable row level security;
alter table public.fitness_logs enable row level security;
alter table public.unit_designs enable row level security;
alter table public.sports_meet enable row level security;
alter table public.app_settings enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'students','fitness_records','attendance','lesson_plans','resources','courses',
    'course_schedule','todos','fitness_logs','unit_designs','sports_meet','app_settings'
  ]
  loop
    execute format('drop policy if exists "anon_full_access" on public.%I', t);
    execute format('create policy "anon_full_access" on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;
