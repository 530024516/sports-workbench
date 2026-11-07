/**
 * 存储键 → Supabase 数据表的映射（服务端唯一的权威定义）
 * 本地 server.js 与 Vercel api/*.js 共用同一份，前端只需关心键名。
 */
const STORE_SCHEMA = {
  // ⛔ pe_students / students 表已彻底退役：学生信息模块已删除，名册由体测记录派生。
  //    它既不在 STORE_SCHEMA，也不在 STORE_KEYS —— 启动时不再拉几百条废弃学生数据。
  //    历史表由 RETIRED_CLOUD_KEYS 记录，下次同步物理清干净。详见文件末尾。
  pe_fitness_records: { table: 'fitness_records', label: '体测数据' },
  pe_attendance: { table: 'attendance', label: '考勤记录' },
  pe_lesson_plans: { table: 'lesson_plans', label: '教案' },
  pe_resources: { table: 'resources', label: '教学资源' },
  pe_courses: { table: 'courses', label: '课程' },
  pe_todos_v1: { table: 'todos', label: '待办清单' },
  // 一周训练记录：JS 里是「日期 → 记录」对象，库中按天一行（id = 日期）
  pe_fitness_weekly_log_v1: { table: 'fitness_logs', label: '健身训练记录', objectMap: true },
  // 单例：整份数据作为一个对象存一行（id = 存储键名）
  pe_schedule_v1: { table: 'course_schedule', label: '周课表', singleton: true },
  // ⛔ pe_big_unit_design_v1 已从云端 schema 退役 —— 它现在只是浏览器 localStorage 里的本地草稿，
  //    唯一的云端入口是下面的 pe_offline_resources_v1。详见 RETIRED_CLOUD_KEYS。
  // 离线资源库：每个大单元一行，用「具名列」存（列表页要按 category/level 直接在库里筛），
  // 完整 10 模块数据放在 modules_json。DDL 见 supabase/migrations/004_offline_resources.sql
  pe_offline_resources_v1: { table: 'offline_resources', label: '离线资源库', rowShaped: true },
  pe_sports_meet_v1: { table: 'sports_meet', label: '运动会数据', singleton: true },
  // 运动会自定义比赛项目（报名页「项目管理」维护），导出模板时与内置项目库合并
  pe_sports_meet_events_v1: { table: 'app_settings', label: '运动会项目库', singleton: true },
  // 报名模板导出配置（年级限制开关，默认关闭 = 全量输出项目）
  pe_meet_template_config_v1: { table: 'app_settings', label: '报名模板配置', singleton: true },
  pe_week_mode: { table: 'app_settings', label: '单双周模式', singleton: true },
  pe_workbench_display_settings_v1: { table: 'app_settings', label: '工作台显示设置', singleton: true },
  sportsMeetTitle: { table: 'app_settings', label: '运动会标题', singleton: true },
};

const STORE_KEYS = Object.keys(STORE_SCHEMA);

/**
 * 🧹 已退役的云端键：不再读写，但必须记得它以前落在哪张表、哪一列，
 *    才能把历史脏数据【物理删除】（DELETE ... WHERE id = key）。
 *
 * ① pe_big_unit_design_v1：大单元设计现在只是本机浏览器 localStorage 里的草稿，
 *   云端只保留「离线资源库」pe_offline_resources_v1。老版本前端曾把它当单例
 *   写进 unit_designs，留下过一堆 10 模块全空的空壳行 —— 这些行在下次同步时
 *   会被 purgeRetiredKeys() 直接删掉，且此后任何 POST 都不会重新写入。
 * ② pe_students：学生信息模块已删除，名册改由体测记录派生。老版本按集合型
 *   把几百个学生写进 public.students；下次同步整表 DELETE 清光，POST 一律拒绝。
 */
const RETIRED_CLOUD_KEYS = {
  pe_big_unit_design_v1: {
    table: 'unit_designs',
    label: '大单元设计（已退役·仅本机草稿）',
    singleton: true,
  },
  /**
   * pe_students：旧的【学生信息】模块已整个删除，名册现在从体测记录派生。
   * 与上面的单例草稿不同，它以前是【集合型】—— 一个学生一行，几百行都落在
   * public.students 里。清理时不能只删 id='pe_students' 那一行，必须整表删光，
   * 所以标了 wholeTable: true；purgeRetiredKeys() 会按整表 DELETE 处理。
   * 可选的彻底告别方式：在 Supabase SQL Editor 执行
   * supabase/migrations/006_drop_students.sql（DROP TABLE ... CASCADE）。
   */
  pe_students: {
    table: 'students',
    label: '学生信息（旧模块已删除·仅留待清理）',
    wholeTable: true,
  },
};

/**
 * 「本次运动会」相关的全部存储键 —— 一键清空时连根拔起：
 * 运动员报名 / 预分组 / 赛程 / 成绩排名 都塞在 pe_sports_meet_v1 里，
 * 另外三个是项目库、模板配置、运动会标题。
 */
const MEET_DATA_KEYS = [
  'pe_sports_meet_v1',
  'pe_sports_meet_events_v1',
  'pe_meet_template_config_v1',
  'sportsMeetTitle',
];

module.exports = { STORE_SCHEMA, STORE_KEYS, MEET_DATA_KEYS, RETIRED_CLOUD_KEYS };
