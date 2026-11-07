-- =============================================================
-- 006 · 彻底告别【学生信息】模块（可选，手动执行一次即可）
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴执行（幂等，可重复运行）
--
-- 背景：
--   * 前端已删除学生信息模块，名册改由体测记录派生（DB.getFitnessStudents()）。
--   * pe_students 已从 lib/store-schema.js 的 STORE_SCHEMA / STORE_KEYS 摘除，
--     启动时不会再拉几百条废弃学生数据；老版本 POST 上来也会被 writeData 拒绝。
--   * 应用侧的自动清理：下一次 GET /api/data 同步时 purgeRetiredKeys() 会
--     把 public.students 里的历史行【整表 DELETE】清光（wholeTable: true）。
--     ⚠️ 但 PostgREST / anon key 只能做 DML，无法执行 DROP TABLE —— 所以
--        「连表结构一起删」必须手动跑这一份 SQL，应用运行时做不到。
--
-- 执行后：服务端清理会识别「表已不存在」（status: 'dropped'），不再告警。
-- =============================================================

-- cascade：一并带走挂在这张表上的 RLS 策略、触发器、索引等依赖对象
drop table if exists public.students cascade;
