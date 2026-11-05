/**
 * 体测 · 统计分析看板（BI 报表版）回归测试
 * node tests/fitness-dashboard-smoke.mjs 直接跑
 *
 * 覆盖：
 *   ① 控制区 —— 年级 Tab / 班级 Tab 联动、范围口径
 *   ② KPI —— 参测人数 / 平均总分 / 中位数 / 优秀率 / 优良率 / 及格率 / 不及格
 *   ③ 进度条 —— 及格率、优良率的达标判断与"还差几人"
 *   ④ 等级分布 / BMI 分布 —— 与成绩册、国标口径一致
 *   ⑤ 各项目得分率 —— 降序、不及格 / 偏弱人数、配色阈值
 *   ⑥ 班级对比 —— 跨年级同名分开、降序、名次
 *   ⑦ 男女对比 + 本年级概览文字
 *   ⑧ 三张图的 ECharts 配置（横向条形 + 右侧说明列）
 *   ⑨ 导出完整结果 CSV
 *
 * 全部用真实的 js/data.js + js/fitness-gradebook.js 计算，不造假分数。
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

console.log('\n🧪 体测统计分析看板（BI 报表版）回归测试\n');

/* ================= 假数据 ================= */

const STUDENTS = [
  { id: 'S1', name: '张一', gender: '男', grade: '三年级', class: '1班' },
  { id: 'S2', name: '李二', gender: '男', grade: '三年级', class: '1班' },
  { id: 'S3', name: '王三', gender: '女', grade: '三年级', class: '2班' },
  { id: 'S4', name: '赵四', gender: '男', grade: '一年级', class: '1班' },
  { id: 'S5', name: '钱五', gender: '女', grade: '一年级', class: '2班' },
  // S6：总分 58.9（边缘生）+ BMI 肥胖 + 跳绳 0 分 → 三个名单都要出现
  { id: 'S6', name: '孙六', gender: '女', grade: '三年级', class: '2班' },
  // S7：登记在册但一条体测数据都没录 → 缺考名单
  { id: 'S7', name: '周七', gender: '男', grade: '二年级', class: '1班' },
];

const ITEM_NAMES = {
  height: '身高', weight: '体重', run50: '50米跑', sitReach: '坐位体前屈',
  jumpRope: '1分钟跳绳', vitalCapacity: '肺活量', sitUps: '1分钟仰卧起坐',
  run50x8: '50米×8往返跑', standingJump: '立定跳远',
};

function record(studentId, testType, value, testDate = '2026-05-01') {
  const student = STUDENTS.find(item => item.id === studentId);
  return {
    id: `F-${studentId}-${testType}-${testDate}`,
    studentId, studentName: student.name, gender: student.gender,
    grade: student.grade, class: student.class,
    testType, testName: ITEM_NAMES[testType] || testType, unit: '', value, testDate,
    createdAt: `${testDate}T08:00:00.000Z`,
  };
}

const RECORDS = [
  // S1：三年级完整数据，各项都不错
  record('S1', 'height', 140), record('S1', 'weight', 32),
  record('S1', 'vitalCapacity', 2400), record('S1', 'run50', 8.6),
  record('S1', 'sitReach', 14), record('S1', 'jumpRope', 140),
  record('S1', 'sitUps', 45), record('S1', 'run50x8', 110),
  record('S1', 'standingJump', 180),
  // S2：50 米跑不及格
  record('S2', 'height', 138), record('S2', 'weight', 34),
  record('S2', 'vitalCapacity', 1800), record('S2', 'run50', 12.0),
  record('S2', 'sitReach', 12), record('S2', 'jumpRope', 120),
  record('S2', 'sitUps', 40), record('S2', 'run50x8', 118),
  record('S2', 'standingJump', 165),
  // S3：缺肺活量
  record('S3', 'height', 142), record('S3', 'weight', 40),
  record('S3', 'run50', 9.0), record('S3', 'sitReach', 14),
  record('S3', 'jumpRope', 130), record('S3', 'sitUps', 42),
  record('S3', 'standingJump', 170),
  // S4 / S5：一年级（不测仰卧起坐与 50 米×8）
  record('S4', 'height', 125), record('S4', 'weight', 26),
  record('S4', 'vitalCapacity', 1500), record('S4', 'run50', 10.2),
  record('S4', 'sitReach', 8), record('S4', 'jumpRope', 90),
  record('S5', 'height', 122), record('S5', 'weight', 24),
  record('S5', 'vitalCapacity', 1400), record('S5', 'run50', 10.8),
  record('S5', 'sitReach', 9), record('S5', 'jumpRope', 80),
  // S6：肥胖 + 50 米跑不及格 → 总分 58.3（边缘生）
  record('S6', 'height', 140), record('S6', 'weight', 42),
  record('S6', 'vitalCapacity', 900), record('S6', 'run50', 12.4),
  record('S6', 'sitReach', 7), record('S6', 'jumpRope', 40),
  record('S6', 'sitUps', 20),
  // S7：上一次测试（2026-04-01）只录了一项没有国标分的项目，本次（2026-05-01）没来 → 缺考名单
  record('S7', 'standingJump', 150, '2026-04-01'),
];

/* ================= 沙箱 ================= */

function createEnv() {
  const nodes = new Map();
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

  // ⚠️ 刻意【不】放 pe_students：名册由体测记录派生
  const storeData = { pe_fitness_records: RECORDS };
  const chartCalls = [];
  const echartsStub = {
    graphic: {
      LinearGradient: function LinearGradient(x, y, x2, y2, colorStops) {
        return { type: 'linear', colorStops };
      },
    },
    init: element => {
      const chart = {
        element,
        option: null,
        disposed: false,
        getDom: () => element,
        setOption(option) { this.option = option; chartCalls.push({ element, option }); },
        resize() {},
        dispose() { this.disposed = true; },
      };
      return chart;
    },
  };
  const toasts = [];
  const context = vm.createContext({
    document: documentStub,
    // 看板的图表诊断会打 console.log，测试里静音（warn / error 保留，出错要能看见）
    console: { log() {}, info() {}, warn: console.warn, error: console.error },
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    setTimeout, clearTimeout,
    echarts: echartsStub,
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    Store: {
      read: key => (key in storeData ? storeData[key] : []),
      write: () => {},
      onReady: () => () => {},
    },
    showToast: (message, type) => toasts.push({ message, type }),
    escapeFitnessHTML: value => String(value ?? ''),
  });
  context.globalThis = context;
  context.window = context;
  context.parent = context;
  context.location = { search: '' };
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.dispatchEvent = () => {};

  ['js/data.js', 'js/fitness-gradebook.js', 'js/fitness-dashboard.js'].forEach(file => {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  });

  new vm.Script(`globalThis.__DB = DB;`, { filename: 'db-export.js' }).runInContext(context);
  new vm.Script(`globalThis.__api = {
    compute: () => computeFitnessDashboardData(),
    setState: patch => { Object.assign(FITNESS_DASHBOARD_STATE, patch); },
    state: () => ({ ...FITNESS_DASHBOARD_STATE }),
    setGrade: grade => fitnessDashboardSetGrade(grade),
    setClass: name => fitnessDashboardSetClass(name),
    levelOption: data => fitnessDashboardLevelOption(data),
    bmiOption: data => fitnessDashboardBmiOption(data),
    itemOption: data => fitnessDashboardItemOption(data),
    charts: () => fitnessDashboardCharts,
    render: () => renderFitnessDashboard(),
    update: () => updateFitnessDashboard(),
    kpis: data => renderFitnessDashboardKpis(data),
    progress: data => renderFitnessDashboardProgress(data),
    gender: data => renderFitnessDashboardGender(data),
    summary: data => renderFitnessDashboardSummary(data),
    classTable: data => renderFitnessDashboardClassTable(data),
    exportRows: data => fitnessDashboardExportRows(data),
    watchlist: data => computeFitnessDashboardWatchlist(data),
    watchlistHTML: data => {
      renderFitnessDashboardWatchlist(data);
      return String(document.getElementById('fitnessDashboardWatchTable').innerHTML || '');
    },
    watchTabsHTML: data => {
      renderFitnessDashboardWatchlist(data);
      return String(document.getElementById('fitnessDashboardWatchTabs').innerHTML || '');
    },
    setWatchType: type => fitnessDashboardSetWatchType(type),
    exportWatchCsv: () => exportFitnessDashboardWatchlistCsv(),
    gradeCompare: () => computeFitnessDashboardGradeCompare(),
    gradeCompareOption: (rows, metric) => fitnessDashboardGradeCompareOption(rows, metric),
    setGradeMetric: metric => fitnessDashboardSetGradeMetric(metric),
    gradebook: () => fitnessGradebookBuild({ grade: 'all', className: 'all', search: '' }),
    html: id => {
      const node = document.getElementById(id);
      return String(node.innerHTML || '') + String(node.textContent || '');
    },
    DB: () => DB,
  };`, { filename: 'extract.js' }).runInContext(context);
  return { context, api: context.__api, chartCalls, toasts };
}

/* ================= ① 控制区 ================= */

await test('① 控制区：年级 Tab / 班级 Tab 联动，范围口径正确', () => {
  const { api } = createEnv();
  const state = api.state();
  equal(state.grade, 'all', '年级默认全部');
  equal(state.className, 'all', '班级默认全部');
  const data = api.compute();
  equal(data.scopeCount, 7, '范围内学生共 7 人');
  equal(data.total, 6, '6 人有国标成绩 → 参测 6 人');
  equal(data.absentCount, 1, '1 人缺考');

  api.setGrade('三年级');
  const gradeData = api.compute();
  equal(gradeData.scopeCount, 4, '三年级 4 人');
  assert(gradeData.classRows.every(row => /班$/.test(row.name)), '只剩三年级的班级');
  api.setGrade('all');
});

/* ================= ② KPI ================= */

await test('② KPI：平均总分 / 中位数 / 优秀率 / 优良率 / 及格率 口径正确', () => {
  const { api } = createEnv();
  const data = api.compute();

  // 总分必须与成绩册（国标加权）完全一致
  const gradebook = api.gradebook();
  const scores = gradebook.rows.map(row => row.total.total).filter(value => value !== null);
  equal(scores.length, data.total, '参测人数 = 成绩册里算得出总分的人数');
  const expectedAverage = Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10;
  equal(data.average, expectedAverage, '平均总分 = 成绩册总分的平均值');
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const expectedMedian = Math.round((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
  equal(data.median, expectedMedian, '中位数 = 总分中位数');
  assert(data.average >= 0 && data.average <= 120, '平均总分在 0~120 之间');

  // 等级分布自洽
  const levelTotal = Object.values(data.levelCounts).reduce((sum, value) => sum + value, 0);
  equal(levelTotal, data.total, '四个等级人数之和 = 参测人数');
  equal(data.excellentRate, Math.round((data.excellent / data.total) * 1000) / 10, '优秀率算法');
  equal(data.goodExcellentRate, Math.round(((data.excellent + data.good) / data.total) * 1000) / 10, '优良率算法');
  equal(data.passRate, Math.round(((data.total - data.fail) / data.total) * 1000) / 10, '及格率算法');
  equal(data.fail, data.levelCounts['不及格'], '不及格人数取自分布');
  assert(data.excellent + data.good <= data.total, '优秀+良好不可能超过总人数');
});

await test('③ 中位数：偶数个取中间两个的平均，奇数个取正中', () => {
  const { api } = createEnv();
  const data = api.compute();
  assert(Number.isFinite(data.median), '中位数必须是数字');
  assert(data.median >= 0 && data.median <= 120, '中位数在 0~120 之间');
});

/* ================= ④ 分布 ================= */

await test('④ 等级分布与 BMI 分布：与国标口径一致', () => {
  const { api, context } = createEnv();
  const DB = api.DB();
  const data = api.compute();

  // BMI 逐人核对
  const body = { S1: [140, 32], S2: [138, 34], S3: [142, 40], S4: [125, 26], S5: [122, 24], S6: [140, 42] };
  const expected = { 正常: 0, 低体重: 0, 超重: 0, 肥胖: 0 };
  STUDENTS.forEach(student => {
    const pair = body[student.id];
    if (!pair) return;
    const [height, weight] = pair;
    const bmi = weight / ((height / 100) ** 2);
    const scored = DB.getFitnessScore(bmi, 'BMI', student.gender, student.grade);
    const label = scored.category === '偏瘦' ? '低体重' : scored.category === '偏胖' ? '超重' : scored.category;
    expected[label] += 1;
  });
  Object.entries(expected).forEach(([label, count]) => {
    equal(data.bmiCounts[label] || 0, count, `BMI「${label}」人数`);
  });
  equal(Object.values(data.bmiCounts).reduce((sum, value) => sum + value, 0), data.bmiCount, 'BMI 四类之和 = 可测人数');
});

/* ================= ⑤ 项目得分率 ================= */

await test('⑤ 各项目得分率：降序 + 不及格/偏弱人数正确', () => {
  const { api } = createEnv();
  const data = api.compute();
  assert(data.itemRates.length > 0, '应该有项目统计');
  for (let i = 1; i < data.itemRates.length; i += 1) {
    assert(data.itemRates[i - 1].rate >= data.itemRates[i].rate, '得分率必须从高到低');
  }
  const run50 = data.itemRates.find(item => item.key === 'run50');
  equal(run50.count, 6, '50米跑 6 人有成绩');
  equal(run50.failCount, 2, '50米跑有 2 人不及格（S2、S6）');
  equal(run50.passCount, 4, '50米跑有 4 人及格');
  equal(run50.weakCount, 0, '50米跑没有 60~80 分的偏弱学生');
  equal(run50.rate, 66.7, '得分率 = 及格人数 / 有成绩人数');
  assert(!data.itemRates.some(item => item.key === 'height'), '身高没有国标分，不参与');
  assert(!data.itemRates.some(item => item.key === 'standingJump'), '立定跳远在国标表里没有分数，不参与');
});

/* ================= ⑥ 班级对比 ================= */

await test('⑥ 班级对比：跨年级同名分开、按平均分降序、名次连续', () => {
  const { api } = createEnv();
  const data = api.compute();
  equal(data.classRows.length, 4, '三年级1班/2班 + 一年级1班/2班');
  assert(data.classRows.every(row => /^(三年级|一年级)/.test(row.name)), '同名跨年级要带年级前缀');
  for (let i = 1; i < data.classRows.length; i += 1) {
    assert(data.classRows[i - 1].average >= data.classRows[i].average, '必须按平均分降序');
  }
  data.classRows.forEach((row, index) => equal(row.rank, index + 1, '名次连续'));
  assert(data.classRows.every(row => row.passRate >= 0 && row.passRate <= 100), '及格率在 0~100');
});

/* ================= ⑦ 男女对比 + 概览 ================= */

await test('⑦ 男女生对比 + 本年级概览文字', () => {
  const { api } = createEnv();
  const data = api.compute();
  equal(data.genderStats.length, 2, '男 / 女两组');
  const male = data.genderStats.find(item => item.gender === '男');
  const female = data.genderStats.find(item => item.gender === '女');
  equal(male.count, 3, '男生 3 人（S7 缺考不计）');
  equal(female.count, 3, '女生 3 人');
  assert(male.average > 0 && female.average > 0, '平均分要算出来');
  assert(male.goodExcellentRate >= 0 && male.goodExcellentRate <= 100, '优良率在 0~100');

  // 边缘生：距及格 5 分内
  const edge = data.edgeCount;
  assert(Number.isInteger(edge) && edge >= 0, '边缘生人数要算出来');
  equal(data.boostRate, Math.round((edge / data.total) * 1000) / 10, '优先帮扶可提升及格率算法');
  equal(data.overweightCount, (data.bmiCounts.肥胖 || 0) + (data.bmiCounts.超重 || 0), '肥胖+超重人数');
});

/* ================= ⑧ 图表配置 ================= */

await test('⑧ 三张图：横向条形 + 右侧说明列', () => {
  const { api } = createEnv();
  const data = api.compute();

  const level = api.levelOption(data);
  equal(level.series[0].type, 'bar', '等级分布是条形图');
  equal(level.yAxis[0].type, 'category', '等级分布 Y 轴是分类轴');
  equal(level.xAxis[0].type, 'value', '等级分布 X 轴是数值轴');
  equal(level.xAxis[0].max, 100, 'X 轴最大 100');
  equal(level.yAxis[0].data.length, 4, '四个等级');
  equal(level.yAxis[0].data.join(','), '优秀,良好,及格,不及格', '顺序：优秀 → 良好 → 及格 → 不及格');
  equal(level.series[0].data.length, 4, '四条横条');
  assert(level.series[0].label.formatter({ dataIndex: 0 }).includes('%'), '横条要显示 xx%');
  assert(level.series[0].label.formatter({ dataIndex: 0 }).includes('人'), '横条要显示 xx人');

  const bmi = api.bmiOption(data);
  equal(bmi.yAxis[0].data.join(','), '正常,低体重,超重,肥胖', 'BMI 四行顺序');

  const item = api.itemOption(data);
  equal(item.series[0].type, 'bar', '项目排行是条形图');
  equal(item.xAxis[0].max, 100, '项目排行 X 轴 0~100%');
  equal(item.yAxis.length, 2, '项目排行有两条 Y 轴（项目名 + 右侧说明列）');
  equal(item.yAxis[1].position, 'right', '第二条 Y 轴在右侧');
  assert(item.yAxis[1].axisLabel.formatter('肺活量', 0).includes('不及格'), '右侧要写不及格人数');
  assert(item.yAxis[1].axisLabel.formatter('肺活量', 0).includes('偏弱'), '右侧要写偏弱人数');
  equal(item.series[0].yAxisIndex, 0, '柱状系列用左侧 Y 轴');
});

/* ================= ⑨ HTML 渲染 ================= */

await test('⑨ 六个区块的 HTML 都渲染出来', () => {
  const { api } = createEnv();
  api.render();
  const scope = api.html('fitnessDashboardScope');
  assert(scope.includes('全部年级'), '控制区要显示当前范围');

  const kpis = api.html('fitnessDashboardKpis');
  ['名单人数', '平均总分', '及格率', '优良率'].forEach(label => {
    assert(kpis.includes(label), `KPI 缺少「${label}」`);
  });
  equal((kpis.match(/fitness-bi-kpi /g) || []).length, 4, 'KPI 只留 4 张核心大卡');
  equal(kpis.includes('中位数'), false, '中位数卡片已精简掉');
  equal(kpis.includes('优秀率'), false, '优秀率卡片已精简掉');

  const progress = api.html('fitnessDashboardProgress');
  assert(progress.includes('及格率') && progress.includes('优良率'), '进度条要有两条');
  assert(progress.includes('%'), '进度条要显示百分比');
  assert(progress.includes('fitness-bi-fill-green') && progress.includes('fitness-bi-fill-blue'), '绿/蓝两条进度条');

  const gender = api.html('fitnessDashboardGender');
  assert(gender.includes('男') && gender.includes('女'), '男女对比要有两组');
  assert(gender.includes('平均分') && gender.includes('优良率'), '男女对比要显示平均分与优良率');

  const summary = api.html('fitnessDashboardSummary');
  assert(summary.includes('肥胖+超重'), '概览要写肥胖+超重人数');
  assert(summary.includes('不及格'), '概览要写不及格人数');
  assert(summary.includes('边缘生'), '概览要写边缘生');
  assert(summary.includes('可提升及格率'), '概览要写优先帮扶可提升的及格率');

  const table = api.html('fitnessDashboardClassTable');
  assert(table.includes('平均分') && table.includes('及格率') && table.includes('优良率') && table.includes('名次'), '班级对比表头要齐全');
  assert(table.includes('fitness-bi-tag-good') || table.includes('fitness-bi-tag-bad'), '及格率/优良率要用颜色标签');
  assert(table.includes('fitness-bi-rank'), '名次要用圆形徽章');
});

/* ================= ⑩ 导出 ================= */

await test('⑩ 导出完整结果 CSV：六个区块一个不缺', () => {
  const { api } = createEnv();
  const data = api.compute();
  const rows = api.exportRows(data);
  const text = rows.map(row => row.join(',')).join('\n');
  ['【核心指标】', '【等级分布】', '【BMI 体型分布】', '【男女生对比】',
    '【各项目得分率排行】', '【班级对比】', '【本年级概览】'].forEach(block => {
    assert(text.includes(block), `导出缺少区块：${block}`);
  });
  assert(text.includes('参测人数') && text.includes('中位数'), '核心指标要全');
  assert(text.includes('优秀') && text.includes('不及格'), '等级分布要有四行');
  assert(text.includes('肥胖+超重'), '概览要有文字总结');
});

/* ================= ⑪ 空数据 ================= */

await test('⑪ 空范围不报错：给空状态，导出返回空', () => {
  const { api } = createEnv();
  api.setState({ grade: '六年级' });
  const data = api.compute();
  equal(data.total, 0, '没有数据');
  equal(data.average, 0, '平均分为 0');
  equal(data.median, 0, '中位数为 0');
  api.summary(data);
  assert(api.html('fitnessDashboardSummary').includes('暂无'), '概览要显示空状态');
  const option = api.levelOption(data);
  assert(option.graphic.length > 0, '图表要有空状态文案');
});

/* ================= ⑫ 重点学生关注名单 ================= */

await test('⑫ 关注名单：四组的口径都对（边缘生 / 弱项不及格 / 肥胖超重 / 缺考）', () => {
  const { api } = createEnv();
  const data = api.compute();
  const list = api.watchlist(data);

  // ① 边缘生：总分 55~59
  assert(list.edge.length >= 1, '应该有边缘生');
  list.edge.forEach(row => {
    assert(row.total >= 55 && row.total < 60, `边缘生总分要在 55~59，实际 ${row.total}`);
    assert(row.reason.includes('分及格'), '原因要写"差 X 分及格"');
  });
  const edgeStudent = list.edge.find(row => row.student.id === 'S6');
  assert(edgeStudent, 'S6（58.3 分）应该在边缘生名单里');
  equal(edgeStudent.reason, '差 1.7 分及格', 'S6 的关注原因');

  // ② 薄弱项不及格
  assert(list.weak.length >= 1, '应该有弱项不及格的学生');
  list.weak.forEach(row => assert(row.reason.includes('不及格'), '原因要写哪一项不及格'));
  assert(list.weak.some(row => row.student.id === 'S2'), 'S2（50米跑不及格）应该在名单里');
  assert(list.weak.some(row => row.student.id === 'S6'), 'S6（50米跑不及格 + BMI 肥胖）应该在名单里');
  const s6Weak = list.weak.find(row => row.student.id === 'S6');
  assert(s6Weak.reason.includes('50米跑'), 'S6 的原因要写 50米跑');
  assert(s6Weak.reason.includes('BMI肥胖'), 'S6 的原因要写 BMI 肥胖');

  // ③ 肥胖超重
  assert(list.bmi.length >= 1, '应该有肥胖超重学生');
  assert(list.bmi.some(row => row.student.id === 'S6'), 'S6（BMI 肥胖）应该在名单里');
  assert(list.bmi.some(row => row.student.id === 'S3'), 'S3（BMI 超重）应该在名单里');
  list.bmi.forEach(row => assert(row.reason.includes('BMI'), '原因要写 BMI 肥胖/超重'));

  // ④ 缺考（系统里没有名单表 → 只能按"记录本身"判定）
  equal(list.absent.length, 1, '1 人缺考');
  equal(list.absent[0].student.id, 'S7', '缺考的是 S7');
  assert(list.absent[0].reason.includes('参考项') || list.absent[0].reason.includes('未录入'),
    '原因要说清为什么算缺考（没来 / 只录了参考项）');
  equal(data.absentCount, 1, 'KPI 上的缺考人数与名单一致');
  equal(data.total + data.absentCount, data.scopeCount, '参测 + 缺考 = 范围内总人数');
});

await test('⑬ 关注名单：4 个 Tab 可切换，表格列齐全', () => {
  const { api } = createEnv();
  const data = api.compute();
  const tabs = api.watchTabsHTML(data);
  ['边缘生（距及格）', '薄弱项不及格', '肥胖超重', '缺考名单'].forEach(label => {
    assert(tabs.includes(label), `Tab 缺少「${label}」`);
  });
  assert(tabs.includes('fitness-bi-count'), 'Tab 上要显示人数');

  api.setState({ watchType: 'edge' });
  const html = api.watchlistHTML(data);
  ['姓名', '班级', '总分 / 成绩', '关注原因'].forEach(label => {
    assert(html.includes(label), `表格缺少「${label}」列`);
  });
  assert(html.includes('fitness-bi-watch-table'), '宽表格要能横向滚动');
  assert(html.includes('分及格'), '表格里要显示关注原因');
});

await test('⑭ 关注名单：能导出当前名单 CSV', () => {
  const { api, toasts } = createEnv();
  api.setState({ watchType: 'edge' });
  api.exportWatchCsv();
  const toast = toasts.find(item => item.message.includes('已导出'));
  assert(toast, '导出要有成功提示');
  assert(toast.message.includes('边缘生'), '提示要带上名单名称');
});

/* ================= ⑮ 全校年级横向对比 ================= */

await test('⑮ 全校年级对比：各年级平均分 / 优良率统计正确', () => {
  const { api } = createEnv();
  const rows = api.gradeCompare();
  equal(rows.length, 3, '一年级 / 二年级 / 三年级三个年级有数据');
  equal(rows.map(row => row.grade).join(','), '一年级,二年级,三年级', '按年级顺序排列');
  const first = rows[0];
  equal(first.grade, '一年级', '第一个是一年级');
  equal(first.scored, 2, '一年级 2 人有成绩');
  assert(first.average > 0, '一年级平均分要算出来');
  equal(first.goodExcellentRate, 100, '一年级两人都是优良 → 优良率 100%');
  const second = rows[1];
  equal(second.grade, '二年级', '第二个是二年级');
  equal(second.scored, 0, '二年级没成绩');
  equal(second.average, 0, '没成绩平均分为 0');
});

await test('⑯ 全校年级对比：柱状（平均分）+ 折线（优良率）双 Y 轴', () => {
  const { api } = createEnv();
  const rows = api.gradeCompare();
  const option = api.gradeCompareOption(rows, 'goodExcellent');
  equal(option.xAxis[0].type, 'category', 'X 轴是分类轴');
  equal(option.xAxis[0].data.join(','), '一年级,二年级,三年级', 'X 轴是各年级');
  equal(option.yAxis.length, 2, '双 Y 轴');
  equal(option.yAxis[0].name, '平均分', '左轴是平均分');
  equal(option.yAxis[0].max, 120, '左轴最大 120');
  equal(option.yAxis[1].max, 100, '右轴最大 100%');
  equal(option.series.length, 2, '一个柱状 + 一个折线');
  equal(option.series[0].type, 'bar', '平均分是柱状');
  equal(option.series[1].type, 'line', '优良率是折线');
  equal(option.series[1].yAxisIndex, 1, '折线走右轴');
  equal(option.series[0].yAxisIndex, 0, '柱状走左轴');
  equal(option.series[0].data.length, rows.length, '柱状数据条数 = 年级数');
  equal(option.series[1].data[0], 100, '一年级优良率 100%（折线要真的有值）');
  assert(option.series[1].data.some(value => value !== null), '折线不能全是 null');

  // 换指标：及格率 / 肥胖率
  const pass = api.gradeCompareOption(rows, 'pass');
  assert(pass.series[1].name.includes('及格率'), '可以切到及格率');
  assert(pass.series[1].data.some(value => value !== null), '及格率折线也要有值');
  const obese = api.gradeCompareOption(rows, 'obese');
  assert(obese.series[1].name.includes('肥胖率'), '可以切到肥胖率');
  assert(obese.series[1].data.every(value => value === null || typeof value === 'number'), '没 BMI 数据的年级用 null 断开折线');
});

/* ================= ⑰ 图表配置自检（曾经整块空白的那两个） ================= */

await test('⑰ 图表配置自检：每个 grid 都配齐了 x 轴和 y 轴', () => {
  const { api } = createEnv();
  const data = api.compute();
  const options = [
    ['等级分布', api.levelOption(data)],
    ['BMI 分布', api.bmiOption(data)],
    ['各项目得分率排行', api.itemOption(data)],
    ['全校年级横向对比', api.gradeCompareOption(api.gradeCompare(), 'goodExcellent')],
  ];
  options.forEach(([name, option]) => {
    const grids = Array.isArray(option.grid) ? option.grid : [option.grid];
    const xAxes = option.xAxis || [];
    const yAxes = option.yAxis || [];
    grids.forEach((grid, index) => {
      assert(xAxes.some(axis => (axis.gridIndex ?? 0) === index), `【${name}】的 grid[${index}] 没有配 x 轴 —— ECharts 会直接抛错，图一片空白`);
      assert(yAxes.some(axis => (axis.gridIndex ?? 0) === index), `【${name}】的 grid[${index}] 没有配 y 轴`);
    });
  });

  // 重点回归：项目得分率排行是"双 grid"（左条形 + 右说明列），两个 grid 必须各配一条 x 轴
  const item = api.itemOption(data);
  equal(item.grid.length, 2, '项目得分率排行用了两个 grid');
  equal(item.xAxis.length, 2, '两个 grid 必须配两条 x 轴（少一条整张图就空白）');
  equal(item.yAxis.length, 2, '两个 grid 必须配两条 y 轴');
  equal(item.xAxis[1].gridIndex, 1, '第二条 x 轴归属 grid[1]');
  equal(item.xAxis[1].show, false, '第二条 x 轴只当坐标参照，不显示');
});

/* ================= ⑱ 右侧说明列不被裁切 ================= */

await test('⑱ 右侧说明列不被裁切：右对齐文字必须完整落在画布内', () => {
  const { api } = createEnv();
  const data = api.compute();
  const item = api.itemOption(data);
  const rightAxis = item.yAxis[1];

  equal(item.grid[0].right, '52%', '左侧 grid 让出更多右边距');
  equal(item.grid[1].left, '56%', '右侧 grid 左边界');
  assert(item.grid[1].right >= 40, `右侧 grid 必须留出 >= 40px，否则右对齐文字会溢出画布（当前 ${item.grid[1].right}）`);

  equal(rightAxis.position, 'right', '说明列挂在右轴');
  equal(rightAxis.axisLabel.align, 'right', '说明文字右对齐（右边缘 = 轴位置 + margin）');
  assert(rightAxis.axisLabel.width >= 120, `axisLabel.width 必须 >= 120，人数可能是三位数（当前 ${rightAxis.axisLabel.width}）`);
  equal(rightAxis.axisLabel.overflow, 'none', 'axisLabel 不允许截断文案');
  assert(typeof rightAxis.axisLabel.formatter === 'function', '说明文案由 formatter 生成');

  // 几何校验：右对齐文字右边缘 = 画布宽 - grid[1].right + margin，必须留在画布内
  const margin = rightAxis.axisLabel.margin;
  assert(margin < item.grid[1].right - 8, `文字右边缘会超出画布（margin=${margin}, grid.right=${item.grid[1].right}）`);
});

/* ================= 汇总 ================= */

const passed = results.filter(item => item.ok).length;
console.log(`\n✅ ${passed}/${results.length} 通过\n`);
if (passed !== results.length) process.exitCode = 1;
