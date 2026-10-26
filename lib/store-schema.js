/**
 * 存储键 → Supabase 数据表的映射（服务端唯一的权威定义）
 * 本地 server.js 与 Vercel api/*.js 共用同一份，前端只需关心键名。
 */
const STORE_SCHEMA = {
  pe_students: { table: 'students', label: '学生信息' },
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
  pe_big_unit_design_v1: { table: 'unit_designs', label: '大单元设计', singleton: true },
  pe_sports_meet_v1: { table: 'sports_meet', label: '运动会数据', singleton: true },
  pe_week_mode: { table: 'app_settings', label: '单双周模式', singleton: true },
  pe_workbench_display_settings_v1: { table: 'app_settings', label: '工作台显示设置', singleton: true },
  sportsMeetTitle: { table: 'app_settings', label: '运动会标题', singleton: true },
};

const STORE_KEYS = Object.keys(STORE_SCHEMA);

module.exports = { STORE_SCHEMA, STORE_KEYS };
