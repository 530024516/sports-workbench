/**
 * 【内部 id 防泄露】回归测试
 * node tests/fitness-id-leak-smoke.mjs 直接跑
 *
 * 体测模块里 student.id 不是"学号"，而是 makeFitnessStudentId() 算出来的
 * 「姓名+班级+年级」哈希（形如 H0mr09js02y1b0y，H + 14 位 base36）——
 * 它只是系统内部的主键。一旦漏到界面或导出文件里，家长 / 领导看到的就是一串乱码。
 *
 * 本测试用【真实的哈希 id】造数据（调用真正的 DB.makeFitnessStudentId），
 * 把体测模块所有"用户能看到的出口"逐个渲染一遍，逐个断言输出里不出现哈希 id。
 *
 * 覆盖的出口：
 *   ① 成绩册表格 HTML          ② 成绩册导出（Excel / CSV 实际写出的单元格）
 *   ③ 成绩排名表格 HTML        ④ 成绩排名导出（CSV / Excel 实际写出的表）
 *   ⑤ 统计分析看板 HTML        ⑥ 看板「完整结果」CSV
 *   ⑦ 看板「关注名单」CSV       ⑧ 快速录入名单 HTML
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

console.log('\n🧪 体测内部 id 防泄露回归测试\n');

/* ================= 假数据 ================= */

// 张一：各项都好      李二：多项不及格（进"薄弱项"名单）
// 王三：BMI 肥胖      赵四：只录了参考项（进"缺考"名单）
const PEOPLE = [
  {
    name: '张一', gender: '男', grade: '三年级', class: '1班',
    measures: {
      height: 140, weight: 32, vitalCapacity: 2400, run50: 8.6,
      sitReach: 14, jumpRope: 140, sitUps: 45, run50x8: 110, standingJump: 180,
    },
  },
  {
    name: '李二', gender: '男', grade: '三年级', class: '1班',
    measures: {
      height: 140, weight: 34, vitalCapacity: 1500, run50: 13.5,
      sitReach: 3, jumpRope: 40, sitUps: 12, run50x8: 150, standingJump: 120,
    },
  },
  {
    name: '王三', gender: '女', grade: '三年级', class: '2班',
    measures: {
      height: 140, weight: 55, vitalCapacity: 2400, run50: 8.6,
      sitReach: 14, jumpRope: 140, sitUps: 45, run50x8: 110, standingJump: 180,
    },
  },
  {
    name: '赵四', gender: '男', grade: '一年级', class: '1班',
    measures: { standingJump: 150 },
  },
];

/* ================= 沙箱 ================= */

function createEnv() {
  const nodes = new Map();
  const blobs = [];
  const makeNode = id => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, className: '',
    dataset: {}, style: {}, checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, focus() {},
    closest: () => null, appendChild() {}, remove() {}, click() {},
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

  const storeData = { pe_fitness_records: [] };
  const echartsStub = {
    graphic: {
      LinearGradient: function LinearGradient(x, y, x2, y2, colorStops) {
        return { type: 'linear', colorStops };
      },
    },
    init: element => ({
      element,
      getDom: () => element,
      setOption() {}, resize() {}, dispose() {},
      getWidth: () => 800, getHeight: () => 300,
    }),
  };

  // 把沙箱里所有节点的文本都扒出来（看板会往很多个节点里写内容）
  const dumpNodes = () => [...nodes.values()]
    .map(node => `${node.id}：${String(node.innerHTML || '')}${String(node.textContent || '')}`)
    .join('\n');
  const blobTexts = () => blobs.map(blob => blob.parts.join(''));
  const clearBlobs = () => { blobs.length = 0; };

  const context = vm.createContext({
    document: documentStub,
    console: { log() {}, info() {}, warn: console.warn, error: console.error },
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    RegExp, isNaN, parseFloat, parseInt,
    setTimeout, clearTimeout,
    echarts: echartsStub,
    Blob: class { constructor(parts) { this.parts = parts; blobs.push(this); } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    Store: {
      read: key => (key in storeData ? storeData[key] : []),
      write: () => {},
      onReady: () => () => {},
    },
    showToast: () => {},
    // js/fitness.js 加载时会调 Layout.init()，这里只需要它别炸
    Layout: { init() {}, applySidebarState() {} },
    dumpNodes,
    blobTexts,
    clearBlobs,
  });
  context.globalThis = context;
  context.window = context;
  context.parent = context;
  context.location = { search: '' };
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.dispatchEvent = () => {};

  // ① 先加载数据层，拿到真正的 makeFitnessStudentId —— 用它算【真哈希 id】造数据
  new vm.Script(fs.readFileSync(path.join(ROOT, 'js/data.js'), 'utf8'), { filename: 'js/data.js' })
    .runInContext(context);
  new vm.Script('globalThis.__makeId = student => DB.makeFitnessStudentId(student);', { filename: 'id.js' })
    .runInContext(context);

  const ids = [];
  const records = [];
  PEOPLE.forEach((person, index) => {
    const studentId = context.__makeId({ name: person.name, grade: person.grade, class: person.class });
    ids.push(studentId);
    Object.entries(person.measures).forEach(([testType, value]) => {
      records.push({
        id: `F-${index}-${testType}`,
        studentId,
        studentName: person.name,
        gender: person.gender,
        grade: person.grade,
        class: person.class,
        testType,
        testName: testType,
        unit: '',
        value,
        testDate: '2026-05-01',
        createdAt: '2026-05-01T08:00:00.000Z',
      });
    });
  });
  storeData.pe_fitness_records = records;

  // ② 再加载体测各模块（fitness.js 提供 escapeFitnessHTML）
  ['js/fitness.js', 'js/fitness-gradebook.js', 'js/fitness-dashboard.js', 'js/fitness-ranking.js'].forEach(file => {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  });

  new vm.Script(`globalThis.__api = {
    ids: () => ${JSON.stringify(ids)},
    students: () => DB.getFitnessStudents(),
    // ① 成绩册表格 HTML（renderFitnessGradebookTable 直接返回 HTML 字符串）
    gradebookTable: () => String(renderFitnessGradebookTable() || ''),
    // ② 成绩册导出：Excel / CSV 实际写出的就是 header1 + header2 + body
    gradebookExport: () => {
      const matrix = fitnessGradebookExportMatrix();
      return JSON.stringify([matrix.header1, matrix.header2, ...matrix.body]);
    },
    // ③ 成绩排名表格 HTML
    rankingTable: () => {
      const students = rankingScopeStudents();
      const rows = rankingBuildRows(rankingLatestRecords(students, 'run50'));
      return rows.map(row => rankingRowHTML(row)).join('\\n');
    },
    // ④ 成绩排名导出（CSV / Excel 共用的表）
    rankingExport: () => rankingExportRows(),
    // ⑤ 统计分析看板 HTML
    dashboardHTML: () => { renderFitnessDashboard(); return dumpNodes(); },
    // ⑥ 看板「完整结果」CSV
    dashboardCsv: () => JSON.stringify(fitnessDashboardExportRows(computeFitnessDashboardData())),
    // ⑦ 看板「关注名单」CSV（type = edge / weak / bmi / absent）
    watchCsv: type => {
      clearBlobs();
      FITNESS_DASHBOARD_STATE.watchType = type;
      exportFitnessDashboardWatchlistCsv();
      return blobTexts().join('\\n');
    },
    watchCounts: () => {
      const data = computeFitnessDashboardData();
      const list = computeFitnessDashboardWatchlist(data);
      return Object.fromEntries(Object.keys(list).map(key => [key, (list[key] || []).length]));
    },
    // ⑧ 快速录入名单 HTML
    quickRoster: () => {
      document.getElementById('quickEntryGrade').value = '三年级';
      document.getElementById('quickEntryClass').value = '1班';
      renderQuickEntryRoster();
      return String(document.getElementById('quickEntryRoster').innerHTML || '');
    },
  };`, { filename: 'extract.js' }).runInContext(context);

  return { api: context.__api, ids };
}

/* ================= 断言工具 ================= */

/**
 * 扫描输出里有没有内部哈希 id。
 * data-* 属性先剥掉：那是给脚本用的机器键（例如快速录入的 data-student-id），
 * 界面上看不到，不算"泄露给用户"。
 */
function assertNoHash(output, ids, label) {
  const text = String(output).replace(/\sdata-[a-z-]+="[^"]*"/gi, '');
  ids.forEach(id => {
    assert(!text.includes(id), `【${label}】里出现了内部 id「${id}」——那是内部哈希主键，不是学号，不能露给人看`);
  });
  const shaped = text.match(/H[0-9a-z]{14}(?![0-9a-z])/g);
  assert(!shaped, `【${label}】里出现了疑似内部哈希 id：${shaped ? shaped.join('、') : ''}`);
}

/* ================= 用例 ================= */

await test('① 造数据用的确实是真哈希 id（否则后面的断言是空跑）', async () => {
  const { api, ids } = createEnv();
  equal(ids.length, PEOPLE.length, '每个学生都要有一个 id');
  ids.forEach(id => {
    assert(/^H[0-9a-z]{14}$/.test(id), `id 应形如 H + 14 位 base36（实际 ${id}）`);
  });
  const students = api.students();
  equal(students.length, PEOPLE.length, '名册人数');
  ids.forEach(id => assert(students.some(student => student.id === id), '名册里能按 id 找到学生'));
});

await test('② 成绩册表格：姓名行不出现内部 id', async () => {
  const { api, ids } = createEnv();
  const html = api.gradebookTable();
  assert(html.length > 0, '成绩册表格应该渲染出内容');
  assert(html.includes('张一'), '成绩册里应该看得到学生姓名');
  assertNoHash(html, ids, '成绩册表格');
});

await test('③ 成绩册导出（Excel / CSV）：不出现内部 id', async () => {
  const { api, ids } = createEnv();
  const matrix = api.gradebookExport();
  assert(matrix.length > 0, '导出矩阵应该渲染出内容');
  assertNoHash(matrix, ids, '成绩册导出');
});

await test('④ 成绩排名表格：姓名下方显示班级，且不出现内部 id', async () => {
  const { api, ids } = createEnv();
  const html = api.rankingTable();
  assert(html.length > 0, '排名表格应该渲染出内容');
  assertNoHash(html, ids, '成绩排名表格');
  assert(html.includes('三年级1班'), '姓名下方的副标题应显示「年级班级」');
});

await test('⑤ 成绩排名导出：「学号」列留空，不出现内部 id', async () => {
  const { api, ids } = createEnv();
  const { header, body } = api.rankingExport();
  const index = header.indexOf('学号');
  assert(index >= 0, '导出表头应保留学号列');
  assert(body.length > 0, '导出应有数据行');
  body.forEach(row => {
    equal(row[index], '-', '学号列应留空占位');
  });
  assertNoHash(JSON.stringify({ header, body }), ids, '成绩排名导出');
});

await test('⑥ 统计分析看板 HTML：不出现内部 id', async () => {
  const { api, ids } = createEnv();
  const html = api.dashboardHTML();
  assert(html.length > 0, '看板应该渲染出内容');
  assertNoHash(html, ids, '统计分析看板');
});

await test('⑦ 看板「完整结果」CSV：不出现内部 id', async () => {
  const { api, ids } = createEnv();
  const csv = api.dashboardCsv();
  assert(csv.length > 0, '看板 CSV 应该有内容');
  assertNoHash(csv, ids, '看板完整结果 CSV');
});

await test('⑧ 看板「关注名单」CSV：不出现内部 id（四个名单都查一遍）', async () => {
  const { api, ids } = createEnv();
  const counts = api.watchCounts();
  const nonEmpty = Object.entries(counts).filter(([, count]) => count > 0).map(([key]) => key);
  assert(nonEmpty.length > 0, '四个关注名单应该至少有一个非空（造的数据不对）');
  nonEmpty.forEach(type => {
    const csv = api.watchCsv(type);
    assert(csv.length > 0, `【${type}】名单 CSV 应该有内容`);
    assertNoHash(csv, ids, `看板关注名单 CSV（${type}）`);
  });
});

await test('⑨ 快速录入名单 HTML：不出现内部 id', async () => {
  const { api, ids } = createEnv();
  const html = api.quickRoster();
  assert(html.length > 0, '快速录入名单应该渲染出内容');
  assertNoHash(html, ids, '快速录入名单');
});

/* ================= 汇总 ================= */

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  failed.forEach(item => console.log(`  ❌ ${item.name}：${item.error.message}`));
  process.exitCode = 1;
}
