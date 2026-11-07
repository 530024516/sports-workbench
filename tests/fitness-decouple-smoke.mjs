/**
 * 【体测数据 · 彻底解绑学生名单】回归测试
 * node tests/fitness-decouple-smoke.mjs 直接跑
 *
 * 背景：工作台已废弃【学生信息】模块。体测数据不再依赖任何学生名单表：
 *   · 记录自带姓名 / 性别 / 年级 / 班级；
 *   · 内部唯一 id = 「姓名 + 班级 + 年级」的哈希；
 *   · 学生名册由记录派生（DB.getFitnessStudents）；
 *   · 老数据自动迁移（幂等）。
 *
 * 覆盖：
 *   ① 哈希 id —— 稳定、不同人不同 id、与旧学号天然区分
 *   ② 名册派生 —— 没有任何名单表也能列出学生
 *   ③ 班级字典 —— 由记录派生（运动会报名用）
 *   ④ 老数据迁移 —— 学号 id → 哈希 id，并回填 gender（幂等）
 *   ⑤ 迁移幂等 —— 再跑一次不会乱改
 *   ⑥ 端到端 —— Excel 导入 → 成绩册 / 排名 / 看板 全靠记录字段算分
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

console.log('\n🧪 体测数据 · 彻底解绑学生名单 回归测试\n');

/* ================= 沙箱 ================= */

/**
 * @param {object} storeData 初始存储内容（pe_students 已退役：放进去也只会被当成"读不到的废数据"）
 * @param {string[]} files   要加载的脚本
 */
function createEnv(storeData = {}, files = ['js/data.js']) {
  const nodes = new Map();
  const makeNode = id => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, className: '',
    dataset: {}, style: {}, checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, focus() {},
    closest: () => null, appendChild() {}, remove() {},
  });
  const documentStub = {
    readyState: 'complete',
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeNode(id));
      return nodes.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeNode('tmp'),
    body: null,
  };

  const readyCallbacks = [];
  const context = vm.createContext({
    document: documentStub,
    console,
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    setTimeout, clearTimeout,
    Store: {
      read: (key, fallback = []) => (key in storeData ? storeData[key] : fallback),
      write: (key, value) => { storeData[key] = value; },
      onReady: cb => { readyCallbacks.push(cb); },
    },
    showToast: () => {},
    escapeFitnessHTML: value => String(value ?? ''),
  });
  context.globalThis = context;
  context.window = context;
  context.parent = context;
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.dispatchEvent = () => {};

  files.forEach(file => {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  });
  // const DB = {...} 不会挂到 globalThis 上，要单独取出来
  new vm.Script('globalThis.__DB = DB;', { filename: 'extract-db.js' }).runInContext(context);

  return {
    context,
    storeData,
    DB: context.__DB,
    /** 手动触发 Store.onReady 里注册的回调（模拟云端数据就绪） */
    flushReady: () => readyCallbacks.forEach(cb => { try { cb(); } catch { /* 忽略无关回调 */ } }),
  };
}

/* ================= ① 哈希 id ================= */

await test('① 内部 id =「姓名+班级+年级」的哈希：稳定、不同人不同、H 前缀', () => {
  const { DB } = createEnv();
  const a = DB.makeFitnessStudentId({ name: '张三', grade: '三年级', class: '1班' });
  const b = DB.makeFitnessStudentId({ name: '张三', grade: '三年级', class: '1班' });
  equal(a, b, '同一个人算出来的 id 必须一样（否则分组统计就散了）');
  assert(a.startsWith('H'), '内部 id 要用 H 前缀，与旧学号天然区分');
  assert(a.length > 10, '哈希 id 应该足够长，不会轻易撞车');

  const c = DB.makeFitnessStudentId({ name: '张三', grade: '三年级', class: '2班' });
  const d = DB.makeFitnessStudentId({ name: '李四', grade: '三年级', class: '1班' });
  const e = DB.makeFitnessStudentId({ name: '张三', grade: '二年级', class: '1班' });
  assert(a !== c && a !== d && a !== e, '同名不同班 / 不同年级 / 不同人，id 都必须不同');
});

/* ================= ② 名册派生 ================= */

await test('② 名册完全由体测记录派生（系统里没有名单表）', () => {
  const records = [
    { id: 'F1', studentId: 'Haaa', studentName: '张三', gender: '男', grade: '三年级', class: '1班', testType: 'run50', value: 8.1, testDate: '2026-05-01' },
    { id: 'F2', studentId: 'Haaa', studentName: '张三', gender: '男', grade: '三年级', class: '1班', testType: 'jumpRope', value: 120, testDate: '2026-05-01' },
    { id: 'F3', studentId: 'Hbbb', studentName: '李四', gender: '女', grade: '三年级', class: '2班', testType: 'run50', value: 9.2, testDate: '2026-05-01' },
  ];
  const { DB } = createEnv({ pe_fitness_records: records });

  const students = DB.getFitnessStudents();
  equal(students.length, 2, '张三的两条记录要合并成一个学生');
  const zhang = students.find(student => student.name === '张三');
  equal(zhang.id, 'Haaa', 'id 来自记录');
  equal(zhang.gender, '男', '性别来自记录');
  equal(zhang.grade, '三年级', '年级来自记录');
  equal(zhang.class, '1班', '班级来自记录');

  const byId = DB.getFitnessStudentById('Hbbb');
  equal(byId.name, '李四', '按 id 也能查到学生');
  equal(DB.getFitnessStudentById('不存在'), null, '查不到就返回 null');
});

/* ================= ③ 班级字典 ================= */

await test('③ 班级字典由记录派生（运动会报名用得到）', () => {
  const records = [
    { id: 'F1', studentId: 'Haaa', studentName: '张三', gender: '男', grade: '三年级', class: '1班', testType: 'run50', value: 8.1, testDate: '2026-05-01' },
    { id: 'F2', studentId: 'Hbbb', studentName: '李四', gender: '女', grade: '三年级', class: '2班', testType: 'run50', value: 9.2, testDate: '2026-05-01' },
    { id: 'F3', studentId: 'Hccc', studentName: '王五', gender: '男', grade: '二年级', class: '1班', testType: 'run50', value: 9.5, testDate: '2026-05-01' },
  ];
  const { DB } = createEnv({ pe_fitness_records: records });
  const classes = DB.getFitnessClasses();
  equal(classes.length, 3, '三年级1班 / 三年级2班 / 二年级1班 → 三个「年级+班级」组合');
  assert(classes.some(item => item.grade === '二年级' && item.class === '1班'), '二年级1班要在字典里');
  assert(classes.some(item => item.grade === '三年级' && item.class === '2班'), '三年级2班要在字典里');
});

/* ================= ④ 老数据迁移 ================= */

await test('④ 老数据自动迁移：学号 id → 哈希 id；pe_students 退役后绝不再被读取', () => {
  const legacyStudents = [
    { id: 'S1', name: '张三', gender: '男', grade: '三年级', class: '1班' },
    { id: 'S2', name: '李四', gender: '女', grade: '三年级', class: '2班' },
  ];
  const legacyRecords = [
    { id: 'F1', studentId: 'S1', studentName: '张三', grade: '三年级', class: '1班', testType: 'run50', value: 8.1, testDate: '2026-05-01' },
    { id: 'F2', studentId: 'S2', studentName: '李四', grade: '三年级', class: '2班', testType: 'run50', value: 9.2, testDate: '2026-05-01' },
  ];
  // 刻意把废弃名单留在 storeData 里：代码必须完全无视它
  const { DB, storeData } = createEnv({ pe_students: legacyStudents, pe_fitness_records: legacyRecords });

  const result = DB.migrateFitnessRecords();
  equal(result.changed, true, '老记录应该被改写');

  const migrated = storeData.pe_fitness_records;
  migrated.forEach(record => {
    assert(record.studentId.startsWith('H'), 'studentId 要换成哈希 id');
    equal(record.gender, '', '学生名单已退役：性别绝不再从 pe_students 回填');
  });
  equal(DB.KEYS.STUDENTS, undefined, 'DB.KEYS 里不该再注册 pe_students');
  const zhang = migrated.find(record => record.studentName === '张三');
  equal(zhang.studentId, DB.makeFitnessStudentId({ name: '张三', grade: '三年级', class: '1班' }), '哈希 id 要和算出来的一致');

  // 迁移后名册照样由记录派生
  const students = DB.getFitnessStudents();
  equal(students.length, 2, '迁移后名册有 2 人');
});

await test('⑤ 迁移幂等：再跑一次不会乱改', () => {
  const legacyRecords = [
    { id: 'F1', studentId: 'S1', studentName: '张三', grade: '三年级', class: '1班', testType: 'run50', value: 8.1, testDate: '2026-05-01' },
  ];
  const { DB } = createEnv({ pe_fitness_records: legacyRecords });

  DB.migrateFitnessRecords();
  const first = JSON.stringify(DB.getFitnessRecords());
  const second = DB.migrateFitnessRecords();
  equal(second.changed, false, '第二次迁移不该再改任何东西');
  equal(JSON.stringify(DB.getFitnessRecords()), first, '数据必须一模一样');
});

await test('⑥ 没有旧名单也能迁移（gender 留空，不瞎猜）', () => {
  const legacyRecords = [
    { id: 'F1', studentId: 'S1', studentName: '张三', grade: '三年级', class: '1班', testType: 'run50', value: 8.1, testDate: '2026-05-01' },
  ];
  const { DB } = createEnv({ pe_fitness_records: legacyRecords });
  const result = DB.migrateFitnessRecords();
  equal(result.changed, true, 'studentId 还是会被换成哈希 id');
  const record = DB.getFitnessRecords()[0];
  assert(record.studentId.startsWith('H'), 'studentId 要换成哈希 id');
  equal(record.gender, '', '认不出性别就留空（绝不默认按男生算分）');
});

/* ================= ⑦ 端到端 ================= */

await test('⑦ 缺考名单：同班最近一次测试没来的学生要被标出来（不依赖名单表）', () => {
  const records = [
    // 王五：跟李四同班，李四 05-01 来测了，王五只在上一次（04-01）来过 → 本次缺考
    { id: 'F1', studentId: 'Hccc', studentName: '王五', gender: '男', grade: '三年级', class: '1班', testType: 'run50', value: 9.5, testDate: '2026-04-01' },
    { id: 'F2', studentId: 'Hddd', studentName: '李四', gender: '女', grade: '三年级', class: '1班', testType: 'run50', value: 9.2, testDate: '2026-05-01' },
    // 赵六：另一个班，单独测过 → 不算缺考
    { id: 'F3', studentId: 'Heee', studentName: '赵六', gender: '男', grade: '三年级', class: '2班', testType: 'run50', value: 9.9, testDate: '2026-04-01' },
  ];
  const { context } = createEnv({ pe_fitness_records: records }, [
    'js/data.js', 'js/fitness-gradebook.js', 'js/fitness-dashboard.js',
  ]);

  const data = context.computeFitnessDashboardData();
  const absent = context.computeFitnessDashboardAbsent(data);
  equal(absent.length, 1, '只有王五算缺考');
  equal(absent[0].student.name, '王五', '缺考的是没赶上本班最近一次测试的王五');
  assert(absent[0].reason.includes('2026-05-01'), '原因要写清是本班最近一次测试（05-01）没来');
  equal(data.absentCount, 1, 'KPI 上的缺考人数一致');
});

await test('⑧ 端到端：Excel 导入 → 成绩册 / 排名 / 看板，全靠记录自带字段', () => {
  const storeData = { pe_fitness_records: [] };
  const { context, DB } = createEnv(storeData, [
    'js/data.js', 'js/fitness-gradebook.js', 'js/fitness-ranking.js', 'js/fitness-import.js',
  ]);

  // 模拟老师上传的 Excel（没有学号列！也没有任何名单表）
  const rows = [
    ['姓名', '性别', '年级', '班级', '身高(cm)', '体重(kg)', '肺活量(ml)', '50米跑(秒)',
      '坐位体前屈(cm)', '1分钟跳绳(个)', '1分钟仰卧起坐(个)', '50米×8往返跑(秒)', '立定跳远(cm)'],
    ['张三', '男', '三年级', '1班', 140, 32, 2400, 8.6, 14, 140, 45, 110, 180],
    ['李四', '女', '三年级', '1班', 142, 40, 1800, 12.0, 12, 120, 40, 118, 165],
  ];

  const parsed = context.parseFitnessTemplateRows(rows, { testDate: '2026-05-01' });
  equal(parsed.records.length, 18, '两个学生 × 9 个项目 = 18 条记录');
  equal(parsed.skipped.unknownStudents, 0, '绝不出现"找不到学生"');
  assert(!parsed.warnings.some(warning => warning.includes('找不到')), '不能有"找不到学生"的提示');

  // 入库
  storeData.pe_fitness_records = parsed.records;

  // 记录自带姓名 / 性别 / 年级 / 班级
  const record = parsed.records[0];
  equal(record.studentName, '张三', '记录自带姓名');
  equal(record.gender, '男', '记录自带性别');
  equal(record.grade, '三年级', '记录自带年级');
  equal(record.class, '1班', '记录自带班级');
  equal(record.studentId, DB.makeFitnessStudentId({ name: '张三', grade: '三年级', class: '1班' }), 'id 是姓名+班级+年级的哈希');

  // 名册派生出来 2 人
  const students = DB.getFitnessStudents();
  equal(students.length, 2, '名册由记录派生：2 人');
  equal(students[0].gender, '男', '名册带性别');

  // 成绩册能算分（不依赖任何名单表）
  const gradebook = context.fitnessGradebookBuild({ grade: 'all', className: 'all', search: '' });
  equal(gradebook.rows.length, 2, '成绩册 2 行');
  gradebook.rows.forEach(row => {
    assert(row.total.total !== null, `${row.student.name} 必须算得出总分`);
    assert(row.total.total >= 0 && row.total.total <= 120, '总分要落在 0~120');
    assert(row.student.gender === '男' || row.student.gender === '女', '名册里的性别要来自记录');
  });

  // 排名按记录字段分组（年级 / 班级 / 性别）
  const rowsRanked = context.rankingBuildRows(context.rankingLatestRecords(DB.getFitnessStudents(), 'run50'));
  equal(rowsRanked.length, 2, '排名 2 人');
  equal(rowsRanked[0].student.name, '张三', '50 米跑越低越好，张三 8.6 秒应排第一');
  assert(rowsRanked[0].score !== null, '排名要算得出国标分（说明性别/年级都取自记录）');
});

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exit(1);
