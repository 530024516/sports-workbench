/**
 * 体测成绩排名回归测试（无浏览器依赖，node tests/fitness-ranking-smoke.mjs 直接跑）
 *
 * 覆盖：
 *   ① js/fitness-ranking.js —— 正逆序判定、排序方向、并列名次、进度条比例、
 *      年级适用性、项目下拉联动、空数据容错
 *   ② js/data.js —— 用真实的国标字典与等级评定（不造假数据）
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

console.log('\n🧪 体测成绩排名回归测试\n');

/* ================= 假数据 ================= */

const STUDENTS = [
  { id: 'S1', name: '张一', gender: '男', grade: '三年级', class: '1班' },
  { id: 'S2', name: '李二', gender: '男', grade: '三年级', class: '1班' },
  { id: 'S3', name: '王三', gender: '男', grade: '三年级', class: '1班' },
  { id: 'S4', name: '赵四', gender: '男', grade: '三年级', class: '2班' },
  { id: 'S5', name: '钱五', gender: '女', grade: '三年级', class: '1班' },
  { id: 'S6', name: '孙六', gender: '女', grade: '三年级', class: '2班' },
  { id: 'S7', name: '周七', gender: '男', grade: '一年级', class: '1班' },
];

function record(studentId, testType, value, testDate = '2026-05-01') {
  const student = STUDENTS.find(item => item.id === studentId);
  return {
    id: `F-${studentId}-${testType}-${testDate}`,
    studentId,
    studentName: student.name,
    gender: student.gender,
    grade: student.grade,
    class: student.class,
    testType,
    testName: testType,
    unit: testType === 'run50' ? '秒' : '个',
    value,
    testDate,
    createdAt: `${testDate}T08:00:00.000Z`,
  };
}

const RECORDS = [
  // 50 米跑（越小越好）：9.1 / 9.5 / 9.1（并列）/ 10.2 / 10.0 / 9.8
  record('S1', 'run50', 9.1),
  record('S2', 'run50', 9.5),
  record('S3', 'run50', 9.1),
  record('S4', 'run50', 10.2),
  record('S5', 'run50', 10.0),
  record('S6', 'run50', 9.8),
  // 跳绳（越大越好）：120 / 150 / 130 / 110
  record('S1', 'jumpRope', 120),
  record('S2', 'jumpRope', 150),
  record('S3', 'jumpRope', 130),
  record('S4', 'jumpRope', 110),
  // 坐位体前屈（越大越好）
  record('S1', 'sitReach', 8.5),
  record('S2', 'sitReach', 12.0),
  // 同一个学生测了两次 → 只取最新一条
  record('S1', 'run50', 9.9, '2026-04-01'),
];

/* ================= 沙箱 ================= */

function createEnv(records = RECORDS) {
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
  // ⚠️ 刻意【不】放 pe_students：排名只认体测记录自带的姓名/性别/年级/班级
  const storeData = { pe_fitness_records: records };
  const toasts = [];
  const context = vm.createContext({
    document: documentStub,
    console,
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    setTimeout, clearTimeout,
    Store: {
      read: key => (key in storeData ? storeData[key] : []),
      write: () => {},
      onReady: () => () => {},
    },
    showToast: (message, type) => toasts.push({ message, type }),
    escapeFitnessHTML: value => String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]),
  });
  context.globalThis = context;
  context.window = context;
  context.parent = context;
  context.location = { search: '' };
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.dispatchEvent = () => {};
  ['js/data.js', 'js/fitness-ranking.js'].forEach(file => {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  });
  new vm.Script(`globalThis.__api = {
    direction: (type, name, unit) => fitnessTestDirection(type, name, unit),
    rows: (students, testType) => rankingBuildRows(rankingLatestRecords(students, testType)),
    students: () => DB.getFitnessStudents(),
    records: () => DB.getFitnessRecords(),
    applies: (item, grade) => rankingItemAppliesToGrade(item, grade),
    available: () => rankingAvailableItems(),
    setState: patch => { Object.assign(RANKING_STATE, patch); },
    state: () => ({ ...RANKING_STATE }),
    exportRows: () => rankingExportRows(),
    emptyText: () => rankingEmptyText(),
  };`, { filename: 'extract.js' }).runInContext(context);
  return { context, api: context.__api, toasts };
}

/* ================= ① 正逆序识别 ================= */

await test('① 内置项目的正逆序判定完全正确', async () => {
  const { api } = createEnv();
  equal(api.direction('run50'), 'reverse', '50 米跑应越小越好');
  equal(api.direction('run50x8'), 'reverse', '50×8 往返跑应越小越好');
  equal(api.direction('jumpRope'), 'forward', '跳绳应越大越好');
  equal(api.direction('sitReach'), 'forward', '坐位体前屈应越大越好');
  equal(api.direction('vitalCapacity'), 'forward', '肺活量应越大越好');
  equal(api.direction('sitUps'), 'forward', '仰卧起坐应越大越好');
  equal(api.direction('standingJump'), 'forward', '立定跳远应越大越好');
});

await test('② 未知项目按名称 / 单位兜底判定', async () => {
  const { api } = createEnv();
  equal(api.direction('custom100m', '100米跑', '秒'), 'reverse', '名称含"米跑" → 逆向');
  equal(api.direction('customSprint', '冲刺', ''), 'reverse', '名称含"冲刺" → 逆向');
  equal(api.direction('customRelay', '4×100米接力跑', '秒'), 'reverse', '名称含"跑"结尾 → 逆向');
  equal(api.direction('customRope', '一分钟跳绳', '个'), 'forward', '名称含"跳绳" → 正向');
  equal(api.direction('customCount', '一分钟仰卧起坐', '个'), 'forward', '名称含"仰卧起坐" → 正向');
  equal(api.direction('customUnknown', '神秘项目', '秒'), 'reverse', '单位是秒 → 竞速 → 逆向');
  equal(api.direction('customUnknown2', '神秘项目', '个'), 'forward', '单位是个 → 正向');
  equal(api.direction('customUnknown3', '神秘项目', ''), 'forward', '其它 → 默认正向');
});

/* ================= ② 排序与名次 ================= */

await test('③ 50 米跑（逆向）：成绩小的排前面', async () => {
  const { api } = createEnv();
  const rows = api.rows(api.students(), 'run50');
  // 张一与王三都是 9.1 秒，并列第一（次序按姓名拼音，与名次无关）
  equal(rows[0].value, 9.1, '首行成绩应为 9.1');
  equal(rows[1].value, 9.1, '次行也应是 9.1（并列）');
  const topTwo = rows.slice(0, 2).map(row => row.student.id).sort().join(',');
  equal(topTwo, 'S1,S3', '并列第一的应是 9.1 秒的张一与王三');
  assert(rows[0].value <= rows[rows.length - 1].value, '逆向指标必须升序排列');
});

await test('④ 跳绳（正向）：成绩大的排前面', async () => {
  const { api } = createEnv();
  const rows = api.rows(api.students(), 'jumpRope');
  equal(rows[0].student.id, 'S2', '第一名应是 150 个的李二');
  assert(rows[0].value >= rows[rows.length - 1].value, '正向指标必须降序排列');
});

await test('⑤ 并列同名次、下一名跳号', async () => {
  const { api } = createEnv();
  const rows = api.rows(api.students(), 'run50');
  const rankOf = id => rows.find(row => row.student.id === id).rank;
  equal(rankOf('S1'), 1, '9.1 应是第 1 名');
  equal(rankOf('S3'), 1, '并列 9.1 也应是第 1 名');
  equal(rankOf('S2'), 3, '第三个人应是第 3 名（1,1,3）');
});

await test('⑥ 进度条比例：逆向用 第一名/本人，第一名 100%', async () => {
  const { api } = createEnv();
  const rows = api.rows(api.students(), 'run50');
  const first = rows[0];
  equal(Math.round(first.ratio * 100), 100, '第一名应为 100%');
  const target = rows.find(row => row.student.id === 'S4');   // 10.2 秒
  const expected = Math.round((first.value / target.value) * 100);
  equal(Math.round(target.ratio * 100), expected, '逆向指标进度条应按 第一名/本人 计算');
  assert(target.ratio < 1, '第二名不能是 100%');
});

await test('⑦ 进度条比例：正向用 本人/第一名', async () => {
  const { api } = createEnv();
  const rows = api.rows(api.students(), 'jumpRope');
  equal(Math.round(rows[0].ratio * 100), 100, '第一名应为 100%');
  const target = rows.find(row => row.student.id === 'S1');   // 120 个
  equal(Math.round(target.ratio * 100), Math.round((120 / 150) * 100), '正向指标进度条应按 本人/第一名 计算');
});

await test('⑧ 同一学生多次测试只取最新一条', async () => {
  const { api } = createEnv();
  const rows = api.rows(api.students(), 'run50');
  const zhang = rows.find(row => row.student.id === 'S1');
  equal(zhang.value, 9.1, '应取 2026-05-01 的 9.1，而不是 4 月的 9.9');
});

/* ================= ③ 筛选联动 ================= */

await test('⑨ 年级适用性：一年级不考仰卧起坐 / 50×8 往返跑', async () => {
  const { api } = createEnv();
  const sitUps = { key: 'sitUps', name: '1分钟仰卧起坐', unit: '个' };
  const run50x8 = { key: 'run50x8', name: '50米×8往返跑', unit: '秒' };
  const run50 = { key: 'run50', name: '50米跑', unit: '秒' };
  equal(api.applies(sitUps, '一年级'), false, '一年级不适用仰卧起坐');
  equal(api.applies(run50x8, '三年级'), false, '三年级不适用 50×8 往返跑');
  equal(api.applies(run50x8, '五年级'), true, '五年级适用 50×8 往返跑');
  equal(api.applies(run50, '一年级'), true, '一年级考 50 米跑');
});

await test('⑩ 选性别后，项目下拉只剩该性别有成绩的项目', async () => {
  const { api } = createEnv();
  api.setState({ grade: 'all', gender: '女', className: 'all' });
  const items = api.available().map(item => item.key);
  assert(items.includes('run50'), '女生有 50 米成绩，应保留');
  assert(!items.includes('jumpRope'), '女生没有跳绳成绩，应被过滤掉');
  assert(!items.includes('sitReach'), '女生没有坐位体前屈成绩，应被过滤掉');
  api.setState({ gender: 'all' });
  const all = api.available().map(item => item.key);
  assert(all.includes('jumpRope'), '不限性别时应保留跳绳');
});

/* ================= ④ 空数据容错 ================= */

await test('⑪ 没有任何成绩记录时不报错（空状态）', async () => {
  const { api } = createEnv([]);
  const rows = api.rows(api.students(), 'run50');
  equal(rows.length, 0, '应返回空数组而不是抛错');
  const exported = api.exportRows();
  equal(exported.body.length, 0, '导出也应返回空表');
  equal(exported.header.length, 12, '导出表头应有 12 列');
  assert(api.emptyText().includes('暂无'), '空状态文案要说清"暂无成绩记录"');
});

await test('⑫ 班级筛选只影响范围，不影响成绩方向判定', async () => {
  const { api } = createEnv();
  const all = api.rows(api.students(), 'run50');
  const classOne = api.rows(api.students().filter(student => student.class === '1班'), 'run50');
  assert(classOne.length < all.length, '按班级过滤后人数应变少');
  assert(classOne.every(row => row.student.class === '1班'), '只应有 1 班的学生');
  equal(classOne[0].direction, 'reverse', '方向判定不能被班级筛选影响');
});

/* ================= 汇总 ================= */
const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  failed.forEach(item => console.log(`  ❌ ${item.name}：${item.error.message}`));
  process.exitCode = 1;
}
