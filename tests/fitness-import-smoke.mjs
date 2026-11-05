/**
 * 体测成绩批量导入（固定表头 + 绝对容错 + 零名单依赖）回归测试
 * node tests/fitness-import-smoke.mjs 直接跑
 *
 * 验的是这次重构的三条硬要求：
 *   ① 表头全量固定、不按年级过滤，且中文表头能精准映射到内部 testType；
 *   ② 绝对容错 —— 任何一格为空 / 不是数字 / 取值不合理，
 *      只跳过那一格（甚至那一行），绝不报错、绝不阻断整批导入。
 *   ③ 【零名单依赖】—— 系统里根本没有学生名单表，
 *      只要 Excel 里有姓名/班级/成绩就能直接导入成功，绝不再报"找不到学生"。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_SOURCE = fs.readFileSync(path.join(ROOT, 'js/fitness-import.js'), 'utf8');
const DATA_SOURCE = fs.readFileSync(path.join(ROOT, 'js/data.js'), 'utf8');

const results = [];
async function test(name, fn) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('用例超时')), 4000));
  try {
    await Promise.race([fn(), timeout]);
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
function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n     期望 ${b}\n     实际 ${a}`);
}

/* ------------------------------ 沙箱 ------------------------------ */

/**
 * 关键：storeData 里【只有体测记录，没有任何学生名单】——
 * 模拟"老师从来没建过学生名单"的真实场景。
 */
const ITEM_META = {
  height: { key: 'height', name: '身高', unit: '厘米', icon: '📏' },
  weight: { key: 'weight', name: '体重', unit: '公斤', icon: '⚖️' },
  BMI: { key: 'BMI', name: '身体质量指数', unit: '', icon: '⚖️' },
  run50: { key: 'run50', name: '50米跑', unit: '秒', icon: '🏃' },
  sitReach: { key: 'sitReach', name: '坐位体前屈', unit: '厘米', icon: '🤸' },
  jumpRope: { key: 'jumpRope', name: '1分钟跳绳', unit: '个', icon: '🪢' },
  vitalCapacity: { key: 'vitalCapacity', name: '肺活量', unit: '毫升', icon: '💨' },
  sitUps: { key: 'sitUps', name: '1分钟仰卧起坐', unit: '个', icon: '💪' },
  run50x8: { key: 'run50x8', name: '50米×8往返跑', unit: '秒', icon: '🏃' },
  standingJump: { key: 'standingJump', name: '立定跳远', unit: '厘米', icon: '🦘' },
};

function createEnv(options = {}) {
  const storeData = { pe_fitness_records: [] };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout,
    showToast: () => {},
    escapeFitnessHTML: text => String(text ?? ''),
    isFitnessValueValid: (value, testType) => Number.isFinite(value) && (testType === 'sitReach' || value > 0),
    getFitnessScoringFields: (value, testType, student) => ({
      gradeLevel: `等级-${testType}`,
      gradeClass: 'badge-info',
      score: Number.isFinite(value) ? 100 : null,
      scoreBonus: 0,
      standardVersion: '2014年修订版',
      _student: student?.id,
    }),
    Store: {
      read: (key, fallback) => (key in storeData ? storeData[key] : fallback),
      write: () => {},
      onReady: () => () => {},
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  // 先跑真实的数据层（拿到真的 makeFitnessStudentId / getFitnessStudents）
  new vm.Script(DATA_SOURCE, { filename: 'js/data.js' }).runInContext(ctx);

  // 再把导入解析挂上去（DB.FITNESS_ITEMS 用测试里的元数据覆盖）
  new vm.Script(`${IMPORT_SOURCE}\n;globalThis.__api = {
    FITNESS_TEMPLATE_COLUMNS, FITNESS_TEMPLATE_ITEM_KEYS, normalizeFitnessHeader,
    matchFitnessHeader, parseFitnessNumber, normalizeFitnessGender, resolveFitnessRowStudent,
    detectFitnessHeaderRow, parseFitnessTemplateRows,
    DB,
  };`, { filename: 'js/fitness-import.js' }).runInContext(ctx);
  return sandbox.__api;
}

const API = createEnv();

/** 模板标准表头（含项目列） */
const HEADER = API.FITNESS_TEMPLATE_COLUMNS.map(column => column.header);

/** 某个学生的内部 id（姓名+班级+年级 的哈希） */
function idOf(name, className, grade) {
  return API.DB.makeFitnessStudentId({ name, grade, class: className });
}

/* ------------------------------ 用例 ------------------------------ */

console.log('\n🧪 体测批量导入（固定表头 + 绝对容错 + 零名单依赖）回归测试\n');

await test('① 模板表头全量固定，顺序与国标一致（不再有「学号」列）', () => {
  deepEqual(HEADER, [
    '姓名', '性别', '年级', '班级',
    '身高(cm)', '体重(kg)', '肺活量(ml)', '50米跑(秒)', '坐位体前屈(cm)',
    '1分钟跳绳(个)', '1分钟仰卧起坐(个)', '50米×8往返跑(秒)', '立定跳远(cm)',
  ], '模板第一行必须是这 13 列，且顺序固定');
  equal(HEADER.includes('学号'), false, '模板里不该再有「学号」列');
});

await test('② 表头不含 BMI（BMI 由身高体重推导），项目列 9 个', () => {
  equal(HEADER.includes('BMI'), false, '模板里不该有 BMI 列');
  deepEqual(API.FITNESS_TEMPLATE_ITEM_KEYS,
    ['height', 'weight', 'vitalCapacity', 'run50', 'sitReach', 'jumpRope', 'sitUps', 'run50x8', 'standingJump'],
    '项目列的内部 key 与顺序');
});

await test('③ 中文表头精准映射到内部 testType', () => {
  const expected = {
    '姓名': 'studentName', '性别': 'gender', '年级': 'grade', '班级': 'class',
    '身高(cm)': 'height', '体重(kg)': 'weight', '肺活量(ml)': 'vitalCapacity',
    '50米跑(秒)': 'run50', '坐位体前屈(cm)': 'sitReach', '1分钟跳绳(个)': 'jumpRope',
    '1分钟仰卧起坐(个)': 'sitUps', '50米×8往返跑(秒)': 'run50x8', '立定跳远(cm)': 'standingJump',
  };
  Object.entries(expected).forEach(([header, key]) => {
    equal(API.matchFitnessHeader(header), key, `表头「${header}」应映射到 ${key}`);
  });
  // 老文件里还带「学号」列也照样能导（只是忽略它）
  equal(API.matchFitnessHeader('学号'), 'studentId', '老文件里的「学号」列仍然认得（导入时忽略）');
});

await test('④ 表头容错：去掉单位 / 换单位写法 / 换乘号都能认', () => {
  equal(API.matchFitnessHeader('身高'), 'height', '裸表头也能认');
  equal(API.matchFitnessHeader('身高（CM）'), 'height', '全角括号 + 大写单位');
  equal(API.matchFitnessHeader('50米×8 往返跑'), 'run50x8', '带空格的乘号写法');
  equal(API.matchFitnessHeader('50米x8往返跑'), 'run50x8', '半角 x 写法');
  equal(API.matchFitnessHeader('一分钟跳绳'), 'jumpRope', '中文"一分钟"');
  equal(API.matchFitnessHeader('完全不认识的列'), null, '认不出的列忽略（不报错）');
});

await test('⑤ 数值容错：带单位 / 千分位 / 非数字 / 空', () => {
  equal(API.parseFitnessNumber('2100'), 2100, '纯数字');
  equal(API.parseFitnessNumber('2100ml'), 2100, '带单位');
  equal(API.parseFitnessNumber('8.1 秒'), 8.1, '带空格和单位');
  equal(API.parseFitnessNumber('1,600'), 1600, '千分位');
  equal(API.parseFitnessNumber(''), null, '空 → null（跳过）');
  equal(API.parseFitnessNumber(null), null, 'null → null');
  equal(API.parseFitnessNumber('abc'), null, '非数字 → null');
  equal(API.parseFitnessNumber('--'), null, '破折号 → null');
  equal(API.parseFitnessNumber('-3.5'), -3.5, '负数合法（坐位体前屈可以是负值）');
});

await test('⑥ 空格子只跳过那一个字段，其余项目照常录入', () => {
  const rows = [
    HEADER,
    ['张三', '男', '一年级', '一1班', 120.5, '', '', 9.1, '', '', '', '', ''],
  ];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05', semester: '2026秋' });
  const types = parsed.records.map(record => record.testType);
  deepEqual(types, ['height', 'run50'], '只录入有值的两项');
  equal(parsed.skipped.emptyCells, 7, '9 个项目列里 7 个空格被跳过，不报错');
  equal(parsed.warnings.length, 0, '空格子不该产生任何警告');
  const height = parsed.records[0];
  equal(height.value, 120.5, '数值正确');
  equal(height.studentName, '张三', '姓名取自 Excel');
  equal(height.gender, '男', '性别取自 Excel');
  equal(height.grade, '一年级', '年级取自 Excel');
  equal(height.class, '一1班', '班级取自 Excel');
  equal(height.studentId, idOf('张三', '一1班', '一年级'), '内部 id = 姓名+班级+年级 的哈希');
  equal(height.testDate, '2026-11-05', '测试日期正确');
  equal(height.semester, '2026秋', '学期正确');
  equal(height.testName, '身高', '项目名正确（后续自动算分用）');
});

await test('⑦ 非法值只跳过那一项，不阻断整批导入', () => {
  const rows = [
    HEADER,
    ['张三', '男', '一年级', '一1班', 'abc', 25.4, '', 8.9, '', '', '', '', ''],
    ['李四', '女', '一年级', '一2班', 118, '', '', 9.5, '', '', '', '', ''],
  ];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05' });
  const types = parsed.records.map(record => record.testType);
  deepEqual(types, ['weight', 'run50', 'height', 'run50'], '非法值那项跳过，其余照常');
  equal(parsed.skipped.invalidCells, 1, '记为 1 个非法值');
  assert(parsed.warnings.length >= 1, '非法值给一条提示（但不影响导入）');
});

await test('⑧ 一二年级不填 50米×8 / 仰卧起坐：照样能导入其它项目', () => {
  const rows = [
    HEADER,
    ['张三', '男', '一年级', '一1班', 121, 22.5, 1500, 9.3, 5.2, 60, '', '', 130],
    ['李四', '女', '一年级', '一2班', 118, 21, 1400, 9.8, 8.1, 70, '', '', 125],
  ];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05' });
  const byStudent = parsed.records.reduce((map, record) => {
    map[record.studentName] = map[record.studentName] || [];
    map[record.studentName].push(record.testType);
    return map;
  }, {});
  deepEqual(byStudent.张三, ['height', 'weight', 'vitalCapacity', 'run50', 'sitReach', 'jumpRope', 'standingJump'],
    '张三：没填的两项直接跳过，其它全录');
  deepEqual(byStudent.李四, ['height', 'weight', 'vitalCapacity', 'run50', 'sitReach', 'jumpRope', 'standingJump'],
    '李四：同样');
  equal(parsed.records.some(record => record.testType === 'run50x8' || record.testType === 'sitUps'), false,
    '没填的项目绝不会被凭空造出来');
});

await test('⑨ 整行项目全空 → 不产生任何记录，也不报错', () => {
  const rows = [
    HEADER,
    ['张三', '男', '一年级', '一1班', '', '', '', '', '', '', '', '', ''],
    ['李四', '女', '一年级', '一2班', 118, '', '', '', '', '', '', '', ''],
  ];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05' });
  equal(parsed.records.length, 1, '只有李四的身高入库');
  equal(parsed.records[0].testType, 'height', '且只有身高');
});

await test('⑩ 【零名单依赖】系统里没有任何学生名单 → 照样直接导入成功', () => {
  // createEnv 的 storeData 里只有 pe_fitness_records，根本没有 pe_students
  const rows = [
    HEADER,
    ['全新同学', '女', '六年级', '六3班', 155, 45, 2600, 8.2, 13.5, 150, 45, 110, 195],
  ];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05' });
  equal(parsed.records.length, 9, '9 个项目全部导入成功（不会报"找不到学生"）');
  equal(parsed.records[0].studentName, '全新同学', '姓名直接取自 Excel');
  equal(parsed.records[0].grade, '六年级', '年级直接取自 Excel');
  equal(parsed.records[0].class, '六3班', '班级直接取自 Excel');
  equal(parsed.records[0].studentId, idOf('全新同学', '六3班', '六年级'), '内部 id 由姓名+班级+年级 算出');
  assert(!parsed.warnings.some(warning => warning.includes('找不到') || warning.includes('名单')),
    '绝不能再出现"找不到学生"这类提示');
});

await test('⑪ 没有姓名的行才跳过，其余行照常导入（不再"整行拉黑"）', () => {
  const rows = [
    HEADER,
    ['', '男', '一年级', '一1班', 121, '', '', '', '', '', '', '', ''],
    ['李四', '女', '一年级', '一2班', 118, '', '', '', '', '', '', '', ''],
  ];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05' });
  equal(parsed.records.length, 1, '只有没写姓名的那一行被跳过');
  equal(parsed.records[0].studentName, '李四', '有效行照常导入');
});

await test('⑫ 缺性别 / 缺年级 → 照常导入，但给提示（不参与国标算分）', () => {
  const rows = [
    HEADER,
    ['王五', '', '五年级', '五1班', 140, '', '', '', '', '', '', '', ''],
    ['赵六', '女', '', '五2班', 140, '', '', '', '', '', '', '', ''],
  ];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05' });
  equal(parsed.records.length, 2, '两条记录都导进来了');
  equal(parsed.records[0].gender, '', '认不出性别就留空（不瞎猜）');
  equal(parsed.records[1].grade, '', '缺年级就留空');
  assert(parsed.warnings.some(warning => warning.includes('性别')), '缺性别要有提示');
  assert(parsed.warnings.some(warning => warning.includes('年级')), '缺年级要有提示');
});

await test('⑬ 表头行不在第一行也能找到（老师加了标题行）', () => {
  const rows = [
    ['五年级体测成绩汇总表', '', '', ''],
    HEADER,
    ['王五', '男', '五年级', '五1班', 140, 35, 2500, 7.8, 12, 150, 45, 92.5, 200],
  ];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05' });
  equal(parsed.headerRowIndex, 1, '识别出第 2 行才是表头');
  equal(parsed.records.length, 9, '9 个项目全部录入');
  equal(parsed.records[0].testType, 'height', '列映射没有错位');
});

await test('⑭ 导入记录带齐算分字段，可直接自动算分', () => {
  const rows = [HEADER, ['王五', '男', '五年级', '五1班', 140, 35, 2500, 7.8, 12, 150, 45, 92.5, 200]];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05', semester: '2026秋' });
  const record = parsed.records[0];
  ['gradeLevel', 'gradeClass', 'score', 'scoreBonus', 'standardVersion'].forEach(field => {
    assert(record[field] !== undefined, `缺少算分字段 ${field}`);
  });
  equal(record.semester, '2026秋', '学期带上了');
  equal(record.unit, '厘米', '单位带上了');
});

await test('⑮ 表头行检测：只有一行是表头', () => {
  equal(API.detectFitnessHeaderRow([HEADER, ['张三']]), 0, '标准表头在第一行');
  equal(API.detectFitnessHeaderRow([['标题'], ['x'], HEADER]), 2, '找到真正的那一行');
});

await test('⑯ 姓名/性别归一化：只认得出「男/女」才填，其它留空', () => {
  equal(API.normalizeFitnessGender('男'), '男', '男');
  equal(API.normalizeFitnessGender('M'), '男', 'M');
  equal(API.normalizeFitnessGender('女'), '女', '女');
  equal(API.normalizeFitnessGender('未知'), '', '认不出来就留空');
  equal(API.normalizeFitnessGender(''), '', '空就是空');
});

await test('⑰ 名册完全由体测记录派生（没有任何名单表）', () => {
  const rows = [
    HEADER,
    ['孙六', '男', '三年级', '三1班', 140, '', '', '', '', '', '', '', ''],
  ];
  const parsed = API.parseFitnessTemplateRows(rows, { testDate: '2026-11-05' });
  // 模拟导入入库：记录进 pe_fitness_records
  const records = parsed.records;
  const students = API.DB.getFitnessStudents();
  equal(students.length, 0, '还没入库前名册是空的');
  equal(records.length, 1, '解析出 1 条记录');
  equal(records[0].studentId, idOf('孙六', '三1班', '三年级'), 'id 是姓名+班级+年级 的哈希');
  assert(records[0].studentId.startsWith('H'), '内部 id 用 H 前缀（与旧学号天然区分）');
});

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exit(1);
