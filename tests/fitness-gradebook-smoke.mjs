/**
 * 体测 · 成绩册（紧凑版：单格成绩+得分 + 总分排序 + 弱项列 + 弱项分布图）回归测试
 * node tests/fitness-gradebook-smoke.mjs 直接跑
 *
 * 覆盖：
 *   ① 紧凑结构 —— 一格一个项目（上面成绩、下面得分），表头只有一行
 *   ② 单项算分 —— 成绩册里的得分与真实的 DB.getFitnessScore 完全一致
 *   ③ BMI 自动算 —— 由身高体重折算，分类与国标一致
 *   ④ 总分 —— 与国标加权总分（DB.getAnnualFitnessSummary）一致
 *   ⑤ 等级 —— ≥90 优秀 / ≥80 良好 / ≥60 及格 / 其余不及格
 *   ⑥ 弱项列 —— 不及格项写清是哪几项，全及格显示"—"
 *   ⑦ 导出 —— Excel / CSV 都带折算分、总成绩、等级、备注、弱项
 *   ⑧ 弱项分布 —— 未达标 / 拖后腿 / 正常 三段人数
 *   ⑨ 缺项处理 —— 缺必测项目 → 总分标"参考"，备注写明缺哪几项
 *   ⑩ 筛选联动 —— 年级 / 班级 / 搜索
 *   ⑪ 总分排序 —— 默认高分在前，可切升序
 *
 * 国标分与总分一律用【真实的 js/data.js】计算，不造假分数。
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

console.log('\n🧪 体测成绩册（紧凑版 + 弱项分布图）回归测试\n');

/* ================= 假数据 ================= */

const STUDENTS = [
  { id: 'S1', name: '张一', gender: '男', grade: '三年级', class: '1班' },
  { id: 'S2', name: '李二', gender: '男', grade: '三年级', class: '1班' },
  { id: 'S3', name: '王三', gender: '女', grade: '三年级', class: '2班' },
  { id: 'S4', name: '赵四', gender: '男', grade: '一年级', class: '1班' },
  { id: 'S5', name: '钱五', gender: '女', grade: '一年级', class: '2班' },
];

const ITEM_NAMES = {
  height: '身高', weight: '体重', run50: '50米跑', sitReach: '坐位体前屈',
  jumpRope: '1分钟跳绳', vitalCapacity: '肺活量', sitUps: '1分钟仰卧起坐',
  run50x8: '50米×8往返跑', standingJump: '立定跳远',
};
const ITEM_UNITS = {
  height: '厘米', weight: '公斤', run50: '秒', sitReach: '厘米', jumpRope: '个',
  vitalCapacity: '毫升', sitUps: '个', run50x8: '秒', standingJump: '厘米',
};

function record(studentId, testType, value, testDate = '2026-05-01') {
  const student = STUDENTS.find(item => item.id === studentId);
  return {
    id: `F-${studentId}-${testType}-${testDate}`,
    studentId, studentName: student.name, gender: student.gender,
    grade: student.grade, class: student.class,
    testType, testName: ITEM_NAMES[testType] || testType, unit: ITEM_UNITS[testType] || '',
    value, testDate,
    createdAt: `${testDate}T08:00:00.000Z`,
  };
}

/** S1：三年级完整数据，各项都不错 */
const S1_RECORDS = [
  record('S1', 'height', 140), record('S1', 'weight', 32),
  record('S1', 'vitalCapacity', 2400), record('S1', 'run50', 8.6),
  record('S1', 'sitReach', 14), record('S1', 'jumpRope', 140),
  record('S1', 'sitUps', 45), record('S1', 'run50x8', 110),
  record('S1', 'standingJump', 180),
];

/** S2：50 米跑严重不及格（弱项） */
const S2_RECORDS = [
  record('S2', 'height', 138), record('S2', 'weight', 34),
  record('S2', 'vitalCapacity', 1800), record('S2', 'run50', 12.0),
  record('S2', 'sitReach', 12), record('S2', 'jumpRope', 120),
  record('S2', 'sitUps', 40), record('S2', 'run50x8', 118),
  record('S2', 'standingJump', 165),
];

/** S3：缺肺活量（其它都有） */
const S3_RECORDS = [
  record('S3', 'height', 142), record('S3', 'weight', 40),
  record('S3', 'run50', 9.0), record('S3', 'sitReach', 14),
  record('S3', 'jumpRope', 130), record('S3', 'sitUps', 42),
  record('S3', 'standingJump', 170),
];

/** S4 / S5：一年级（不测仰卧起坐与 50 米×8） */
const S4_RECORDS = [
  record('S4', 'height', 125), record('S4', 'weight', 26),
  record('S4', 'vitalCapacity', 1500), record('S4', 'run50', 10.2),
  record('S4', 'sitReach', 8), record('S4', 'jumpRope', 90),
];
const S5_RECORDS = [
  record('S5', 'height', 122), record('S5', 'weight', 24),
  record('S5', 'vitalCapacity', 1400), record('S5', 'run50', 10.8),
  record('S5', 'sitReach', 9), record('S5', 'jumpRope', 80),
];

const RECORDS = [
  ...S1_RECORDS, ...S2_RECORDS, ...S3_RECORDS, ...S4_RECORDS, ...S5_RECORDS,
  // 同一人同一项目测了两次 → 成绩册只取最新一条
  record('S1', 'run50', 9.9, '2026-04-01'),
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

  // ⚠️ 刻意【不】放 pe_students：成绩册只能靠体测记录自带的信息算分
  const storeData = { pe_fitness_records: RECORDS };
  const toasts = [];
  const context = vm.createContext({
    document: documentStub,
    console,
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    setTimeout, clearTimeout,
    Blob: class { constructor() {} },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
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
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.dispatchEvent = () => {};

  ['js/data.js', 'js/fitness-gradebook.js'].forEach(file => {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  });

  new vm.Script(`globalThis.__api = {
    build: options => fitnessGradebookBuild(options || {}),
    state: () => ({ ...FITNESS_GRADEBOOK_STATE }),
    setState: patch => { Object.assign(FITNESS_GRADEBOOK_STATE, patch); },
    columns: () => FITNESS_GRADEBOOK_COLUMNS,
    visibleColumns: options => fitnessGradebookBuild(options || {}).columns,
    level: total => fitnessGradebookLevel(total),
    tableHTML: () => renderFitnessGradebookTable(),
    exportMatrix: () => fitnessGradebookExportMatrix(),
    weakDistribution: options => computeFitnessWeakDistribution(fitnessGradebookBuild(options || {})),
    weakOption: (rows, total) => fitnessWeakDistributionOption(rows, total),
    csvCell: value => fitnessGradebookCsvCell(value),
    filename: ext => fitnessGradebookExportFilename(ext),
    DB: () => DB,
  };`, { filename: 'extract.js' }).runInContext(context);
  return { context, api: context.__api, toasts };
}

/* ================= ① 紧凑结构 ================= */

await test('① 紧凑结构：一格一个项目（上面成绩、下面得分），表头只有一行', () => {
  const { api } = createEnv();
  const columns = api.columns();
  equal(columns.filter(column => column.scored).length, 8, '应有 8 个有国标分的项目');
  equal(columns.filter(column => !column.scored).length, 2, '身高/体重没有国标分');
  equal(columns.filter(column => column.extra).length, 3, '仰卧起坐 / 50米×8 / 立定跳远是"有数据才显示"的附加列');

  const html = api.tableHTML();
  equal(html.includes('colspan="2"'), false, '不再有横跨两列的项目组表头');
  equal(html.includes('rowspan="2"'), false, '表头只有一行，不再有纵向占两行的表头');
  assert(!html.includes('学号'), '表里不该再有学号');

  // 项目列 = 一行表头里的 th
  const itemThCount = (html.match(/class="fitness-gb-item"/g) || []).length;
  equal(itemThCount, api.visibleColumns().length, '每个显示出来的项目占一列');

  // 同一个格子里：上面原始成绩、下面折算分（有国标分的项目）
  const scoredCell = html.match(/<td class="fitness-gb-cell[^"]*">\s*<span class="fitness-gb-val">[\s\S]*?<\/span>\s*<span class="fitness-gb-pts[^"]*">[\s\S]*?<\/td>/);
  assert(scoredCell, '有分的项目格里应该同时有原始成绩和折算分');

  // 末尾四列
  ['总成绩', '等级', '备注', '弱项'].forEach(label => {
    assert(html.includes(`>${label}`) || html.includes(`${label} <`), `末尾要有「${label}」列`);
  });
});

/* ================= ② 单项算分 ================= */

await test('② 自动算分：每一格的得分与真实的 DB.getFitnessScore 完全一致', () => {
  const { api } = createEnv();
  const DB = api.DB();
  const data = api.build();
  assert(data.rows.length === 5, '应有 5 名学生');
  data.rows.forEach(row => {
    row.cells.forEach(cell => {
      if (!cell.scored || cell.empty) return;
      const expected = DB.getFitnessScore(cell.value, cell.key, row.student.gender, row.student.grade);
      equal(cell.score, expected?.score ?? null, `${row.student.name} 的 ${cell.key} 得分不对`);
    });
  });
});

/* ================= ③ BMI 自动算 ================= */

await test('③ BMI 由身高体重自动算，且分类与国标一致', () => {
  const { api } = createEnv();
  const DB = api.DB();
  const data = api.build();
  const s1 = data.rows.find(row => row.student.id === 'S1');
  const height = s1.cells.get('height').value;
  const weight = s1.cells.get('weight').value;
  const expectedBmi = Number((weight / ((height / 100) ** 2)).toFixed(1));
  equal(s1.cells.get('BMI').value, expectedBmi, 'BMI 应由身高体重算出');
  const expected = DB.getFitnessScore(expectedBmi, 'BMI', '男', '三年级');
  equal(s1.cells.get('BMI').score, expected.score, 'BMI 得分要跟国标一致');
  equal(s1.cells.get('BMI').level, expected.category, 'BMI 分类（偏瘦/正常/偏胖/肥胖）要跟国标一致');
});

/* ================= ④ 总分 ================= */

await test('④ 总分：与国标加权总分（DB.getAnnualFitnessSummary）完全一致', () => {
  const { api } = createEnv();
  const DB = api.DB();
  const data = api.build();
  const s1 = data.rows.find(row => row.student.id === 'S1');
  const summary = DB.getAnnualFitnessSummary(S1_RECORDS, '三年级', '男');
  equal(summary.complete, true, 'S1 的必测项目应齐全');
  equal(s1.total.complete, true, '成绩册里 S1 也应判定为齐全');
  equal(s1.total.total, summary.totalScore, '总分必须与国标加权总分一致');
  equal(s1.total.level, summary.level, '等级必须与国标等级一致');
});

/* ================= ⑤ 等级换算 ================= */

await test('⑤ 等级换算：≥90 优秀 / ≥80 良好 / ≥60 及格 / 其余不及格', () => {
  const { api } = createEnv();
  equal(api.level(95), '优秀', '95 分是优秀');
  equal(api.level(90), '优秀', '90 分是优秀');
  equal(api.level(89.9), '良好', '89.9 分是良好');
  equal(api.level(80), '良好', '80 分是良好');
  equal(api.level(79.9), '及格', '79.9 分是及格');
  equal(api.level(60), '及格', '60 分是及格');
  equal(api.level(59.9), '不及格', '59.9 分是不及格');
});

/* ================= ⑥ 弱项列 ================= */

await test('⑥ 弱项列：不及格项写清是哪几项，全及格显示"—"', () => {
  const { api } = createEnv();
  const data = api.build();
  const s1 = data.rows.find(row => row.student.id === 'S1');
  const s2 = data.rows.find(row => row.student.id === 'S2');

  equal(s1.hasWeak, false, 'S1 各项都达标，不该有弱项');
  equal(s2.hasWeak, true, 'S2 的 50 米跑不及格，应判定为有弱项');
  equal(s2.cells.get('run50').weak, true, '50 米跑这一格要标成弱项');
  equal(s2.cells.get('run50').score < 60, true, '50 米跑的国标分应低于 60');
  assert(s2.weakItems.map(cell => cell.name).includes('50米跑'), '弱项里要列出 50米跑');

  const html = api.tableHTML();
  assert(html.includes('fitness-gb-weak'), '弱项格子要加浅红底样式类');
  assert(html.includes('fitness-gb-alert'), '有弱项的总分格要加警示样式类');
  assert(html.includes('fitness-gb-weak-list'), '弱项列要有专门的样式类');
  assert(html.includes('50米跑'), '弱项列里要写明是哪一项弱');
});

/* ================= ⑦ 导出 ================= */

await test('⑦ 导出增强：Excel / CSV 都带折算分、总成绩、等级、备注、弱项', () => {
  const { api } = createEnv();
  const matrix = api.exportMatrix();
  assert(matrix, '应该有可导出的成绩册');
  equal(matrix.header1.length, 26, '成绩册应有 26 列（4 基本 + 18 项目 + 4 汇总）');
  equal(matrix.header2.length, 26, '第二行表头列数要一致');
  equal(matrix.body.length, 5, '每个学生一行');
  equal(matrix.body[0].length, 26, '每行也要 26 列');
  equal(matrix.merges.length, 18, '合并单元格数量要对（基本列 + 项目组 + 单列项目）');
  assert(!matrix.header1.includes('学号'), '导出里也不该有学号');

  const run50Index = matrix.header1.indexOf('50米跑(秒)');
  assert(run50Index >= 0, '表头要有 50米跑(秒)');
  equal(matrix.header2[run50Index], '成绩', '项目下面第一格是"成绩"');
  equal(matrix.header2[run50Index + 1], '50米跑得分', '旁边一格是"50米跑得分"');

  const totalIndex = matrix.header1.indexOf('总成绩');
  const levelIndex = matrix.header1.indexOf('等级');
  const noteIndex = matrix.header1.indexOf('备注');
  const weakIndex = matrix.header1.indexOf('弱项');
  const s2Row = matrix.body.find(row => row[1] === '李二');
  const s2 = api.build().rows.find(row => row.student.id === 'S2');
  equal(s2Row[totalIndex], s2.total.total, '导出的总成绩要和表里一致');
  equal(s2Row[levelIndex], s2.total.level, '导出的等级要和表里一致');
  assert(String(s2Row[weakIndex]).includes('50米跑'), '导出的弱项列要写明弱项');

  // CSV 转义：公式注入防护 + 引号转义
  equal(api.csvCell('=1+1'), '"\'=1+1"', '以 = 开头的要转义，防公式注入');
  equal(api.csvCell('a"b'), '"a""b"', '引号要转义成两个');
  assert(api.filename('xlsx').startsWith('体测成绩册'), '导出文件名要以体测成绩册开头');
});

/* ================= ⑧ 弱项分布图 ================= */

await test('⑧ 弱项分布：未达标 / 拖后腿 / 正常 三段人数算得对', () => {
  const { api } = createEnv();
  const rows = api.weakDistribution();
  const run50 = rows.find(row => row.key === 'run50');
  assert(run50, '要有 50米跑 这一行');
  // S2 的 50 米跑不及格（<60 分）→ 未达标
  equal(run50.fail, 1, '50米跑有 1 人未达标');
  assert(run50.normal + run50.fail + run50.lag === 5, '三段加起来 = 有成绩的人数（5）');

  // 拖后腿：60~79 分且比本人平均分低 8 分以上
  rows.forEach(row => {
    equal(row.fail + row.lag + row.normal, row.total, `${row.name} 三段人数要加起来等于有成绩人数`);
  });

  const option = api.weakOption(rows, 5);
  assert(option.series.length === 3, '三段：未达标 / 拖后腿 / 正常');
  equal(option.series[0].name, '未达标', '第一段是未达标');
  equal(option.series[0].itemStyle.color, '#F472B6', '未达标是粉红色');
  equal(option.series[1].name, '拖后腿', '第二段是拖后腿');
  equal(option.series[1].itemStyle.color, '#FBBF24', '拖后腿是橙黄色');
  equal(option.series[2].name, '正常', '第三段是正常');
  equal(option.series[2].itemStyle.color, '#E5E7EB', '正常是浅灰');
  equal(option.xAxis[0].max, 5, 'X 轴最大 = 当前范围总人数');
  assert(option.yAxis[0].data.includes('50米跑'), 'Y 轴是项目名称');
  assert(option.series[2].label.formatter({ dataIndex: 0 }).includes('未达标'), '右侧说明列要写"未达标 X 人 · 拖后腿 Y 人"');
});

/* ================= ⑪ 总分排序 ================= */

await test('⑪ 总分排序：默认高分在前，可切成低分在前', () => {
  const { api } = createEnv();
  const desc = api.build().rows;
  for (let i = 1; i < desc.length; i += 1) {
    const previous = desc[i - 1].total.total;
    const current = desc[i].total.total;
    if (previous === null || current === null) continue;
    assert(previous >= current, '默认应该是总分从高到低');
  }
  const asc = api.build({ sort: 'asc' }).rows;
  for (let i = 1; i < asc.length; i += 1) {
    const previous = asc[i - 1].total.total;
    const current = asc[i].total.total;
    if (previous === null || current === null) continue;
    assert(previous <= current, '切到升序后应该从低到高');
  }
  const html = api.tableHTML();
  assert(html.includes('fitness-gb-sort'), '总成绩表头要带排序箭头');
  assert(html.includes('toggleFitnessGradebookSort'), '总成绩表头可以点');
});

/* ================= ⑨ 缺项处理 ================= */

await test('⑨ 缺必测项目：总分按已有项目折算成"参考"分，并写明缺哪几项', () => {
  const { api } = createEnv();
  const data = api.build();
  const s3 = data.rows.find(row => row.student.id === 'S3');
  equal(s3.total.complete, false, 'S3 缺肺活量，不该判定为齐全');
  assert(s3.total.missing.includes('vitalCapacity'), '缺的项目要记下来');
  assert(s3.total.total > 0, '缺项时也要给一个参考分');
  const html = api.tableHTML();
  assert(html.includes('缺 肺活量'), '备注里要写明缺哪几项');
});

/* ================= ⑩ 筛选联动 ================= */

await test('⑩ 筛选联动：年级 / 班级 / 搜索都按当前范围走', () => {
  const { api } = createEnv();
  equal(api.build({ grade: '三年级' }).rows.length, 3, '三年级应有 3 人');
  equal(api.build({ grade: '一年级' }).rows.length, 2, '一年级应有 2 人');
  equal(api.build({ grade: '三年级', className: '1班' }).rows.length, 2, '三年级1班应有 2 人');
  equal(api.build({ search: '张' }).rows.length, 1, '按姓名搜索应只命中 1 人');
  equal(api.build({ search: '1班' }).rows.length, 3, '按班级搜索应命中 1 班的学生（S1/S2/S4）');
});

/* ================= ⑭ 备注列优化（不折行 + 省略号 + 悬浮看全文） ================= */

await test('⑭ 备注列：固定宽度不折行，有内容才带 title（悬浮看全文），空的是「—」', () => {
  const { api } = createEnv();
  const html = api.tableHTML();

  // 表头：备注 / 弱项 两列都要有专门的列样式类
  assert(/<th class="fitness-gb-basic fitness-gb-note-col">备注<\/th>/.test(html), '备注表头要带 fitness-gb-note-col');
  assert(/<th class="fitness-gb-basic fitness-gb-weak-col">弱项<\/th>/.test(html), '弱项表头要带 fitness-gb-weak-col');

  // S3 缺肺活量 → 备注有内容 → 必须带 title（完整文字）
  const noteCell = html.match(/<td class="fitness-gb-basic fitness-gb-note-col" title="([^"]*)">[\s\S]*?<\/td>/);
  assert(noteCell, '有备注的单元格必须带 title 属性');
  assert(noteCell[1].includes('肺活量'), 'title 里要是完整的备注文本');

  // S1 各项齐全 → 备注为空 → 显示「—」且没有 title
  const emptyNote = html.match(/<td class="fitness-gb-basic fitness-gb-note-col"><span class="fitness-gb-empty">—<\/span><\/td>/);
  assert(emptyNote, '空备注要显示「—」');

  // 单元格数量对得上（不能因为漏写 <td> 导致整行错位）
  const row = html.match(/<tbody>[\s\S]*?<\/tr>/)[0];
  const tdCount = (row.match(/<td/g) || []).length;
  equal(tdCount, 3 + api.visibleColumns().length + 4, '每行的单元格数 = 3 基本 + N 项目 + 4 汇总');
});

/* ================= ⑪ 取最新一条 ================= */

await test('⑪ 同一个项目测了多次，成绩册只取最新一条', () => {
  const { api } = createEnv();
  const s1 = api.build().rows.find(row => row.student.id === 'S1');
  equal(s1.cells.get('run50').value, 8.6, '应取 2026-05-01 那条（较新的）');
});

/* ================= ⑫ 空数据不报错 ================= */

await test('⑫ 空范围不报错：渲染给空状态，导出返回空', () => {
  const { api } = createEnv();
  api.setState({ grade: '六年级' });
  const html = api.tableHTML();
  assert(html.includes('📭'), '空范围要有空状态');
  const matrix = api.exportMatrix();
  equal(matrix, null, '没有数据时导出应返回 null 而不是抛错');
  api.setState({ grade: 'all' });
  assert(api.exportMatrix() && api.exportMatrix().body.length, '切回全部年级后导出仍应正常');
});

/* ================= ⑬ 一年级不测的项目 ================= */

await test('⑬ 一年级不测仰卧起坐 / 50米×8：没有得分但不影响总分', () => {
  const { api } = createEnv();
  const data = api.build();
  const s4 = data.rows.find(row => row.student.id === 'S4');
  equal(s4.cells.get('sitUps').empty, true, '没录仰卧起坐 → 这一格是空的');
  equal(s4.cells.get('sitUps').score, null, '空格子不能有得分');
  equal(s4.total.complete, true, '一年级的必测项齐全即可判定为完整');
  const weights = api.DB().getAnnualFitnessWeights('一年级');
  equal(weights.sitUps, undefined, '一年级权重里本来就没有仰卧起坐');
});

/* ================= 汇总 ================= */

const passed = results.filter(item => item.ok).length;
console.log(`\n✅ ${passed}/${results.length} 通过\n`);
if (passed !== results.length) process.exitCode = 1;
