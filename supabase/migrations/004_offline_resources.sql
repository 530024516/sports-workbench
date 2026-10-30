-- =============================================================
-- 004 · 离线资源库（大单元设计成果归档）
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴执行（幂等，可重复运行）
--
-- 与别的表不同：这张表用「具名列」而不是 data(jsonb) 通用包装，
-- 因为资源库要在数据库里直接按 教材大类 / 水平 筛选，且列是约定好的：
--   id            资源 id（前端生成 ur_ 前缀）
--   category      教材大类（球类 / 田径类 / …）
--   level         水平（水平一（1–2 年级）…）
--   content       教学内容（即所选的具体条目标题）
--   modules_json  完整大单元数据：11 个模块 + 18 课时计划表 + 选题 meta
--   created_at    首次保存时间
--   updated_at    最后编辑时间
--   ord           排序位（写入时按列表顺序回写，便于列表保持稳定）
-- =============================================================

create table if not exists public.offline_resources (
  id text primary key,
  category text not null default '',
  level text not null default '',
  content text not null default '',
  modules_json jsonb not null default '{}'::jsonb,
  ord integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 列表按「最新保存」倒序展示
create index if not exists offline_resources_created_idx
  on public.offline_resources (created_at desc);

-- 访问策略：与其余业务表一致（个人自用场景的匿名全权读写）
alter table public.offline_resources enable row level security;

do $$
begin
  execute 'drop policy if exists "anon_full_access" on public.offline_resources';
  execute 'create policy "anon_full_access" on public.offline_resources for all to anon, authenticated using (true) with check (true)';
end $$;

-- 说明：本表不需要写 Supabase migration 之外的任何服务端改动，
--       lib/store-schema.js 里的 pe_offline_resources_v1 → { table: 'offline_resources', rowShaped: true }
--       已经把选型告诉服务端；表没建之前，读取只会让这个键为空，不影响其它模块。
