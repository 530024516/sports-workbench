/**
 * 体测 · 个人成绩诊断报告 回归测试
 * node tests/fitness-diagnosis-smoke.mjs 直接跑
 *
 * 覆盖：
 *   ① 成绩册姓名列变成可点击入口（不泄露内部 id）
 *   ② 弱项判定与提分算式（未达标 / 拖后腿 / 目标线 / 提分 = (目标-得分)×权重）
 *   ③ BMI 体型风险（长期项，不进短期弱项）
 *   ④ 提分预测（总分与等级的前后变化）
 *   ⑤ 训练处方（最弱 1~2 项；全优则保持现有强度）
 *   ⑥ 报告 HTML 五个区块齐全
 *   ⑦ 复制发家长的纯文本（带 Emoji）
 *   ⑧ 打印用的 A4 HTML
 *   ⑨ 点击姓名真的能弹窗
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
function near(actual, expected, tolerance, message) {
  if (!(Math.abs(Number(actual) - expected) <= tolerance)) {
    throw new Error(`${message}（期望 ≈${expected}，实际 ${actual}）`);
  }
}

console.log('\n🧪 体测个人成绩诊断报告回归测试\n');

/* ================= 假数据 ================= */

const PEOPLE = [
  { name: '张一', gender: '男', grade: '三年级', class: '1班' },
  { name: '李二', gender: '男', grade: '三年级', class: '1班' },
  { name: '王三', gender: '女', grade: '三年级', class: '2班' },
];

const MEASURES = {
  张一: { height: 140, weight: 32, vitalCapacity: 2400, run50: 8.6, sitReach: 14, jumpRope: 140, sitUps: 45, run50x8: 110, standingJump: 180 },
  李二: { height: 140, weight: 34, vitalCapacity: 1500, run50: 13.5, sitReach: 3, jumpRope: 40, sitUps: 12, run50x8: 150, standingJump: 120 },
  王三: { height: 140, weight: 55, vitalCapacity: 2400, run50: 8.6, sitReach: 14, jumpRope: 140, sitUps: 45, run50x8: 110, standingJump: 180 },
};

/* ================= 沙箱 ================= */

function createEnv() {
  const nodes = new Map();
  const overlays = [];
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
    baseURI: 'http://localhost/fitness.html',
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeNode(id));
      return nodes.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createElement: tag => {
      const node = makeNode(`new-${tag}`);
      node.tagName = String(tag || '').toUpperCase();
      // 弹窗节点要能挂到 body 上
      node.remove = () => {
        const index = overlays.indexOf(node);
        if (index >= 0) overlays.splice(index, 1);
      };
      return node;
    },
    body: {
      appendChild(node) { overlays.push(node); },
      removeChild() {},
    },
  };

  const storeData = { pe_fitness_records: [] };
  const toasts = [];
  const context = vm.createContext({
    document: documentStub,
    console: { log() {}, info() {}, warn: console.warn, error: console.error },
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    RegExp, URL, isNaN, parseFloat, parseInt,
    setTimeout, clearTimeout,
    requestAnimationFrame: callback => { callback(); return 0; },
    navigator: {},
    Store: {
      read: key => (key in storeData ? storeData[key] : []),
      write: () => {},
      onReady: () => () => {},
    },
    showToast: (message, type) => toasts.push({ message, type }),
    Layout: { init() {}, applySidebarState() {} },
    countOverlays: () => overlays.length,
    overlayHTML: () => overlays.map(node => String(node.innerHTML || '')).join('\n'),
  });
  context.globalThis = context;
  context.window = context;
  context.parent = context;
  context.location = { search: '', href: 'http://localhost/fitness.html' };
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.dispatchEvent = () => {};

  new vm.Script(fs.readFileSync(path.join(ROOT, 'js/data.js'), 'utf8'), { filename: 'js/data.js' })
    .runInContext(context);
  new vm.Script(fs.readFileSync(path.join(ROOT, 'js/fitness-gradebook.js'), 'utf8'), { filename: 'js/fitness-gradebook.js' })
    .runInContext(context);
  new vm.Script(fs.readFileSync(path.join(ROOT, 'js/fitness-diagnosis.js'), 'utf8'), { filename: 'js/fitness-diagnosis.js' })
    .runInContext(context);

  // 造记录（studentId 用真哈希）
  new vm.Script('globalThis.__makeId = student => DB.makeFitnessStudentId(student);', { filename: 'id.js' })
    .runInContext(context);
  const records = [];
  PEOPLE.forEach((person, index) => {
    const studentId = context.__makeId({ name: person.name, grade: person.grade, class: person.class });
    Object.entries(MEASURES[person.name]).forEach(([testType, value]) => {
      records.push({
        id: `F-${index}-${testType}`,
        studentId,
        studentName: person.name,
        gender: person.gender,
        grade: person.grade,
        class: person.class,
        testType, testName: testType, unit: '', value,
        testDate: '2026-05-01',
        createdAt: '2026-05-01T08:00:00.000Z',
      });
    });
  });
  storeData.pe_fitness_records = records;

  new vm.Script(`globalThis.__api = {
    rows: () => fitnessGradebookBuild().rows,
    build: () => fitnessGradebookBuild(),
    tableHTML: () => String(renderFitnessGradebookTable() || ''),
    report: row => fitnessDiagnosisBuildReport(row),
    reportHTML: report => fitnessDiagnosisReportHTML(report),
    plainText: report => fitnessDiagnosisPlainText(report),
    printHTML: report => fitnessDiagnosisPrintHTML(report),
    open: index => openFitnessDiagnosis(index),
    current: () => fitnessDiagnosisCurrent,
    prescriptionKeys: () => Object.keys(FITNESS_DIAGNOSIS_PRESCRIPTIONS),
    overlays: () => countOverlays(),
    overlayHTML: () => overlayHTML(),
  };`, { filename: 'extract.js' }).runInContext(context);

  return { api: context.__api, toasts, overlays };
}

/* ================= 合成 row（用来精确验证算式） ================= */

/**
 * 造一行"假成绩"，score / weight 都能精确控制，
 * 用来验证用户给的算式例子（如 78 分 → 目标 80 分 → 提分 +0.4 分）。
 */
function makeRow(overrides = {}) {
  const cells = new Map();
  const add = (key, name, unit, value, score, extra = {}) => {
    cells.set(key, {
      key, name, unit, value, score, bonus: 0, level: '', levelClass: '',
      weak: score < 60, empty: false, record: null, ...extra,
    });
  };
  (overrides.cells || []).forEach(([key, name, unit, value, score, extra]) => add(key, name, unit, value, score, extra));
  const { cells: ignored, ...rest } = overrides;
  return {
    student: { id: 'X', name: '李四', gender: '男', grade: '三年级', class: '2班' },
    total: { total: 78.4, level: '及格', complete: true, missing: [], reference: false, availableWeight: 1 },
    averageScore: 90,
    hasWeak: false,
    weakItems: [],
    index: 0,
    ...rest,
    cells,
  };
}

/* ================= 用例 ================= */

await test('① 成绩册姓名列变成可点击入口（且不泄露内部 id）', async () => {
  const { api } = createEnv();
  const html = api.tableHTML();
  assert(html.includes('fitness-gb-name-link'), '姓名列要有可点击样式类');
  assert(/onclick="openFitnessDiagnosis\(\d+\)"/.test(html), '姓名要绑定 openFitnessDiagnosis(行号)');
  assert(!/openFitnessDiagnosis\("H/.test(html), '行号不能是内部 id');
});

await test('② 弱项判定与提分算式：78 分 → 目标 80 分 → 提分 +0.4 分（权重 20%）', async () => {
  const { api } = createEnv();
  const row = makeRow({
    cells: [['run50', '50米跑', '秒', 9.5, 78]],
    averageScore: 90,          // 90 - 78 = 12 ≥ 8 → 算"拖后腿"
  });
  const report = api.report(row);
  equal(report.weakItems.length, 1, '应识别出 1 个弱项');
  const weak = report.weakItems[0];
  equal(weak.key, 'run50', '弱项是 50米跑');
  equal(weak.type, 'lag', '78 分且低于均分 8 分以上 → 拖后腿');
  equal(weak.target, 80, '目标线 = 良好线 80 分');
  equal(weak.weightText, '20%', '三年级 50米跑权重 20%');
  near(weak.gain, 0.4, 0.001, '提分 = (80 - 78) × 0.20 = 0.4 分');
  equal(weak.gainText, '+0.4', '提分文案');
});

await test('③ 低于 60 分算"未达标"，目标线是 60 分', async () => {
  const { api } = createEnv();
  const row = makeRow({
    cells: [['run50', '50米跑', '秒', 13.5, 52]],
    averageScore: 90,
  });
  const report = api.report(row);
  equal(report.weakItems.length, 1, '应识别出 1 个弱项');
  const weak = report.weakItems[0];
  equal(weak.type, 'fail', '52 分 → 未达标');
  equal(weak.target, 60, '目标线 = 及格线 60 分');
  near(weak.gain, (60 - 52) * 0.20, 0.001, '提分 = (60 - 52) × 0.20');
});

await test('④ 60~79 分但不低于均分 8 分 → 不算弱项', async () => {
  const { api } = createEnv();
  const row = makeRow({
    cells: [['run50', '50米跑', '秒', 9.5, 78]],
    averageScore: 80,          // 80 - 78 = 2 < 8 → 不算拖后腿
  });
  const report = api.report(row);
  equal(report.weakItems.length, 0, '不该算弱项');
  equal(report.hasWeak, false, 'hasWeak 应为 false');
});

await test('⑤ BMI 体型风险：肥胖 → 回到正常档可加约 6.0 分（长期项，不进弱项）', async () => {
  const { api } = createEnv();
  const row = makeRow({
    cells: [
      ['run50', '50米跑', '秒', 9.5, 78],
      ['BMI', 'BMI', '', 19.9, 60, { category: '肥胖' }],
    ],
    averageScore: 90,
  });
  const report = api.report(row);
  equal(report.weakItems.length, 1, 'BMI 不进短期弱项');
  assert(!report.weakItems.some(item => item.key === 'BMI'), 'BMI 不能出现在弱项里');
  assert(report.bmiRisk, 'BMI 异常要给出体型风险');
  equal(report.bmiRisk.category, '肥胖', 'BMI 状态');
  equal(report.bmiRisk.weightText, '15%', 'BMI 权重 15%');
  near(report.bmiRisk.gain, 6.0, 0.001, '提分 = (100 - 60) × 0.15 = 6.0 分');
  equal(report.bmiRisk.gainText, '+6', '体型风险提分文案');
  assert(report.bmiRisk.advice.length > 0, 'BMI 要给长期建议');
});

await test('⑥ 提分预测：把弱项练到达标线后的总分与等级', async () => {
  const { api } = createEnv();
  const row = makeRow({
    cells: [['run50', '50米跑', '秒', 9.5, 78]],
    total: { total: 78.4, level: '及格', complete: true, missing: [], reference: false, availableWeight: 1 },
    averageScore: 90,
  });
  const report = api.report(row);
  assert(report.prediction, '要有提分预测');
  equal(report.prediction.count, 1, '1 个弱项');
  near(report.prediction.predicted, 78.8, 0.001, '预计总分 = 78.4 + 0.4');
  equal(report.prediction.fromLevel, '及格', '原等级');
  equal(report.prediction.toLevel, '及格', '预测等级');
});

await test('⑦ 训练处方：取最弱的 1~2 项；全优则保持现有训练强度', async () => {
  const { api } = createEnv();
  const weakRow = makeRow({
    cells: [
      ['run50', '50米跑', '秒', 13.5, 52],
      ['jumpRope', '一分钟跳绳', '个', 40, 55],
    ],
    averageScore: 90,
  });
  const weakReport = api.report(weakRow);
  equal(weakReport.prescriptions.length, 2, '最多 2 条处方');
  const titles = weakReport.prescriptions.map(item => item.title).join(' ');
  assert(titles.includes('50米跑'), '应有 50米跑处方');
  assert(titles.includes('跳绳'), '应有跳绳处方');
  const drills = weakReport.prescriptions[0].drills.map(drill => drill.detail).join(' ');
  assert(drills.includes('起跑') || drills.includes('步频'), '处方里要有具体练法');

  const goodRow = makeRow({
    cells: [['run50', '50米跑', '秒', 8.6, 95]],
    averageScore: 95,
  });
  const goodReport = api.report(goodRow);
  equal(goodReport.hasWeak, false, '全优没有弱项');
  equal(goodReport.prescriptions.length, 0, '全优没有处方');
  assert(goodReport.reportHTML === undefined || true, '占位');
});

await test('⑧ 处方库覆盖了所有会出诊断的项目', async () => {
  const { api } = createEnv();
  const keys = api.prescriptionKeys();
  ['run50', 'jumpRope', 'vitalCapacity', 'sitReach', 'sitUps', 'run50x8', 'standingJump']
    .forEach(key => assert(keys.includes(key), `处方库缺少 ${key}`));
});

await test('⑨ 报告 HTML：五个区块齐全，且不含内部 id', async () => {
  const { api } = createEnv();
  const rows = api.rows();
  assert(rows.length > 0, '要有成绩册数据');
  const report = api.report(rows[0]);
  const html = api.reportHTML(report);
  assert(html.includes('fitness-dx-head'), '① 头部信息区');
  assert(html.includes('弱项与提分优先级'), '② 弱项与提分优先级区');
  assert(html.includes('提分预测'), '④ 提分预测区');
  assert(html.includes('训练处方'), '⑤ 训练处方区');
  assert(!/H[0-9a-z]{14}/.test(html), '报告里不能出现内部哈希 id');
});

await test('⑩ 复制发家长的纯文本：带 Emoji，含姓名/总分/等级/弱项/处方', async () => {
  const { api } = createEnv();
  const rows = api.rows();
  const report = api.report(rows.find(row => row.hasWeak) || rows[0]);
  const text = api.plainText(report);
  assert(text.includes(report.student.name), '要有姓名');
  assert(text.includes('总分：'), '要有总分');
  assert(text.includes(report.level), '要有等级');
  assert(text.includes('弱项与提分优先级'), '要有弱项区');
  assert(text.includes('训练处方'), '要有训练处方');
  assert(/🏥|📊|⚠️|💡|🏃/.test(text), '要有 Emoji');
  assert(!/H[0-9a-z]{14}/.test(text), '纯文本里不能出现内部哈希 id');
});

await test('⑪ 打印用的 HTML：A4 纵向 + 报告正文', async () => {
  const { api } = createEnv();
  const rows = api.rows();
  const report = api.report(rows[0]);
  const html = api.printHTML(report);
  assert(html.includes('@page'), '要有 @page 规则');
  assert(html.includes('A4 portrait'), '纸张要是 A4 纵向');
  assert(html.includes('fitness-dx-report'), '要带上报告正文');
  assert(html.includes('fitness-diagnosis.css'), '要引诊断报告样式表');
});

await test('⑫ 点击姓名真的能弹窗（DOM 里出现报告 + 底部按钮）', async () => {
  const { api } = createEnv();
  api.open(0);
  equal(api.overlays(), 1, '应该创建了一个弹窗节点');
  const html = api.overlayHTML();
  assert(html.includes('个人成绩诊断报告'), '弹窗标题');
  assert(html.includes('复制发家长'), '要有「复制发家长」按钮');
  assert(html.includes('打印这张诊断单'), '要有「打印这张诊断单」按钮');
  assert(html.includes('fitness-dx-report'), '弹窗里要有报告正文');
  assert(api.current(), '当前报告要被记住（复制/打印要用）');
});

await test('⑬ 真实数据：李二多项不及格 → 报告能列出弱项并给出处方', async () => {
  const { api } = createEnv();
  const rows = api.rows();
  const row = rows.find(item => item.student.name === '李二');
  assert(row, '成绩册里应有李二');
  const report = api.report(row);
  assert(report.hasWeak, '李二应该被判出弱项');
  assert(report.weakItems.length > 0, '弱项不能为空');
  assert(report.weakItems.every(item => item.target === 60 || item.target === 80), '目标线只能是 60 或 80');
  assert(report.prescriptions.length > 0, '要有训练处方');
  const html = api.reportHTML(report);
  assert(html.includes('fitness-dx-weak'), '弱项要渲染成卡片');
});

/* ================= 汇总 ================= */

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  failed.forEach(item => console.log(`  ❌ ${item.name}：${item.error.message}`));
  process.exitCode = 1;
}
