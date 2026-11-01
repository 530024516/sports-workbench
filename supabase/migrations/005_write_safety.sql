-- =============================================================
-- 005 · 写入安全加固（主键冲突 / 序列 / 索引 / updated_at）
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴执行（幂等，可重复运行）
--
-- 背景（那次"上传体测数据 → 云端报 duplicate key → 本地云端全空"）：
--   ① 前端批量导入体测记录时用 `F${Date.now()}` 生成 id → 同一毫秒内几十条 id 完全相同；
--   ② 服务端原来是"先 DELETE 全表、再 INSERT" → INSERT 整批被主键约束拒绝，
--      而 DELETE 已经生效 → 表被清空，一条数据都没写进去（接口返回 502）；
--   ③ 前端拿到 502 一直重试 → 每一轮都先 DELETE → 云端永远是 0 条；
--   ④ 刷新时云端返回空数组 → SWR 把本地那份真实数据覆盖掉 → 双空。
--
-- 本脚本解决"库这一侧"的问题：
--   §1 诊断：主键列到底是什么类型、有没有序列（先看清楚再动手）
--   §2 诊断：现有数据里有没有重复行
--   §3 序列重置：只有"整型 + 挂序列"的主键才需要 setval；text 主键根本没有序列
--   §4 索引：给高频查询列补索引（列不存在就跳过）
--   §5 updated_at：写库时自动维护，避免"最后修改时间"永远停在旧值
--   §6 RLS：保证 anon / authenticated 能正常读写（策略缺失时报的是权限错，不是主键错）
-- =============================================================

-- -------------------------------------------------------------
-- §1 诊断：各业务表的主键列类型 + 默认值（默认值里有 nextval(...) 才说明挂着序列）
-- -------------------------------------------------------------
select
  c.relname                                   as table_name,
  format_type(a.atttypid, a.atttypmod)       as id_type,
  pg_get_expr(d.adbin, d.adrelid)            as id_default,
  (pg_get_serial_sequence(format('public.%I', c.relname), 'id') is not null) as has_sequence
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid
                   and a.attname = 'id'
                   and a.attnum > 0
                   and not a.attisdropped
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'fitness_records', 'students', 'attendance', 'lesson_plans', 'resources',
    'courses', 'todos', 'fitness_logs', 'course_schedule', 'unit_designs',
    'sports_meet', 'app_settings', 'offline_resources'
  )
order by c.relname;

-- §1.2 现存序列清单（last_value 明显小于表里 max(id) 就说明序列落后了）
select schemaname, sequencename, last_value, start_value, increment_by
from pg_sequences
where schemaname = 'public'
order by sequencename;

-- -------------------------------------------------------------
-- §2 诊断：重复行体检
--   id 是主键时这里必然是 0 行；如果这里查出了东西，说明表结构和代码里的
--   "id 为主键" 假设不一致，必须先修表再谈别的。
-- -------------------------------------------------------------
select 'fitness_records' as table_name, id, count(*) as cnt
from public.fitness_records group by id having count(*) > 1
union all
select 'students', id, count(*) from public.students group by id having count(*) > 1
union all
select 'lesson_plans', id, count(*) from public.lesson_plans group by id having count(*) > 1;

-- -------------------------------------------------------------
-- §3 序列重置（条件式：只处理"整型主键 + 挂序列"的表）
--
--   ⚠️ 本项目的 id 是【text】主键（前端生成的 F 前缀字符串），
--      text 主键【没有】自增序列，所以通常不存在"序列落后"的问题；
--      那次 duplicate key 是"一次 INSERT 里塞了两行同 id"，
--      真正的修法在代码侧（upsert(onConflict:'id') + 客户端 id 去重），
--      本节只是把"万一你把某张表改成整型主键"的序列修好。
--
--   3.1 单表手动重置（最常用的一条，复制改表名即可）：
--       select setval(
--         pg_get_serial_sequence('public.fitness_records', 'id'),
--         coalesce((select max(id) from public.fitness_records), 1),
--         true
--       );
--
--   3.2 全库条件式重置（下面这段直接跑，安全、幂等）：
-- -------------------------------------------------------------
do $$
declare
  r record;
  seq_name text;
  max_id bigint;
  target bigint;
begin
  for r in
    select c.relname as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
                       and a.attname = 'id'
                       and a.attnum > 0
                       and not a.attisdropped
    join pg_type ty on ty.oid = a.atttypid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and ty.typname in ('int2', 'int4', 'int8')
  loop
    seq_name := pg_get_serial_sequence(format('public.%I', r.tbl), 'id');
    if seq_name is null then
      raise notice '[005] 表 % 的 id 是非整型或没挂序列，跳过', r.tbl;
      continue;
    end if;
    execute format('select coalesce(max(id), 0) from public.%I', r.tbl) into max_id;
    target := greatest(max_id, 1);
    perform setval(seq_name, target, true);
    raise notice '[005] 序列 % 已重置到 %（表 %）', seq_name, target, r.tbl;
  end loop;
end $$;

-- -------------------------------------------------------------
-- §4 索引：只给"确实有这一列"的表补索引（列不存在就跳过，绝不报错）
-- -------------------------------------------------------------
do $$
declare
  t text;
  idx text;
begin
  foreach t in array array[
    'fitness_records', 'students', 'attendance', 'lesson_plans', 'resources',
    'courses', 'todos', 'fitness_logs', 'course_schedule', 'unit_designs',
    'sports_meet', 'app_settings', 'offline_resources'
  ]::text[] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'updated_at'
    ) then
      idx := t || '_updated_idx';
      execute format('create index if not exists %I on public.%I (updated_at desc)', idx, t);
    end if;
  end loop;
end $$;

-- 离线资源库：列表页按「教材大类 + 水平」筛选，复合索引让筛选走索引
create index if not exists offline_resources_category_level_idx
  on public.offline_resources (category, level, created_at desc);

-- -------------------------------------------------------------
-- §5 updated_at 自动维护（没有 updated_at 列的表自动跳过）
--   服务端 upsert 会带上 updated_at，触发器用服务器时间覆盖，保证"最后修改时间"可信。
-- -------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'fitness_records', 'students', 'attendance', 'lesson_plans', 'resources',
    'courses', 'todos', 'fitness_logs', 'course_schedule', 'unit_designs',
    'sports_meet', 'app_settings', 'offline_resources'
  ]::text[] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'updated_at'
    ) then
      continue;
    end if;
    execute format('drop trigger if exists trg_touch_updated_at on public.%I', t);
    execute format(
      'create trigger trg_touch_updated_at before update on public.%I '
      'for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- -------------------------------------------------------------
-- §6 RLS：确保 anon / authenticated 可读写
--   ⚠️ 策略缺失时接口报的是"权限不足"，很容易被误判成"写入失败"，
--      于是前端开始无脑重试 → 又一次把表 DELETE 空。这段保证策略始终在。
-- -------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'fitness_records', 'students', 'attendance', 'lesson_plans', 'resources',
    'courses', 'todos', 'fitness_logs', 'course_schedule', 'unit_designs',
    'sports_meet', 'app_settings', 'offline_resources'
  ]::text[] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "anon_full_access" on public.%I', t);
    execute format(
      'create policy "anon_full_access" on public.%I '
      'for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- =============================================================
-- 说明：跑完本脚本后，代码侧的修复才是主力：
--   · lib/supabase.js      —— upsert(onConflict:'id') 优先，写成功后才删旧行，空快照不删
--   · js/data.js           —— 体测记录 id 生成器（时间戳 + 序号 + 随机尾巴）保证唯一
--   · js/store.js          —— 连续失败 3 次熔断；云端 4xx/5xx 或空数组【绝不】覆盖本地
-- 本脚本负责把表结构、索引、策略、序列这几块"地基"修平。
-- =============================================================
