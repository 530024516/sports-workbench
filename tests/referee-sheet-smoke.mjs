/**
 * 裁判员 + 成绩登记表回归测试（无浏览器依赖，node tests/referee-sheet-smoke.mjs 直接跑）
 *
 * 覆盖两块：
 *   ① js/referee-utils.js —— 裁判员字典：旧格式（按「年级|组别|项目」的单人）
 *      自动迁移成新格式（按项目名的多人组），显示文案正确。
 *   ② js/schedule.js —— 用 vm + 假 DOM 加载赛程页后直接调函数：
 *      筛选（年级/性别/项目）、批量成绩表分页结构、表头信息、性能。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 断言器 ---------------- */
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

console.log('\n🧪 裁判员安排 + 成绩登记表回归测试\n');

/* ================= 假 DOM / 假 Store ================= */

function makeMeetData(referees) {
  const athletes = [
    { id: 'a1', name: '张一', grade: 3, gender: 'male', className: '三1班', bibNumber: '101' },
    { id: 'a2', name: '李二', grade: 3, gender: 'male', className: '三1班', bibNumber: '102' },
    { id: 'a3', name: '王三', grade: 5, gender: 'female', className: '五2班', bibNumber: '201' },
    { id: 'a4', name: '赵四', grade: 5, gender: 'female', className: '五2班', bibNumber: '202' },
  ];
  const registrations = [
    { id: 'r1', athleteId: 'a1', eventName: '50米', genderGroup: 'male', eventType: 'track' },
    { id: 'r2', athleteId: 'a2', eventName: '50米', genderGroup: 'male', eventType: 'track' },
    { id: 'r3', athleteId: 'a3', eventName: '50米', genderGroup: 'female', eventType: 'track' },
    { id: 'r4', athleteId: 'a4', eventName: '跳远', genderGroup: 'female', eventType: 'field' },
  ];
  const entries = [
    {
      id: 'e1', eventKey: '3|male|50米', eventName: '50米', genderGroup: 'male', grade: 3, eventType: 'track',
      venueKey: 'track', venue: '跑道', dateKey: '2026-05-21', dayIndex: 0, sessionLabel: '上午',
      round: 'final', groupNumber: 1, participantIds: ['a1', 'a2'],
      startAt: '2026-05-21T08:30:00', durationMinutes: 12, checkinMinutes: 15,
    },
    {
      id: 'e2', eventKey: '5|female|50米', eventName: '50米', genderGroup: 'female', grade: 5, eventType: 'track',
      venueKey: 'track', venue: '跑道', dateKey: '2026-05-21', dayIndex: 0, sessionLabel: '上午',
      round: 'final', groupNumber: 1, participantIds: ['a3'],
      startAt: '2026-05-21T08:45:00', durationMinutes: 12, checkinMinutes: 15,
    },
    {
      id: 'e3', eventKey: '5|female|跳远', eventName: '跳远', genderGroup: 'female', grade: 5, eventType: 'field',
      venueKey: 'standingjump', venue: '立定跳远区/平地', dateKey: '2026-05-21', dayIndex: 0, sessionLabel: '上午',
      round: 'final', groupNumber: 1, participantIds: ['a4'],
      startAt: '2026-05-21T09:00:00', durationMinutes: 45, checkinMinutes: 15,
    },
  ];
  return {
    athletes, registrations, heats: [], laneCount: 4,
    referees,
    schedule: {
      version: 1,
      settings: {
        date: '2026-05-21', days: 1, trackDurationMinutes: 12, fieldDurationMinutes: 45,
        laneCount: 4, fieldOrderMode: 'class', morningStart: '08:30', morningEnd: '12:00',
        afternoonStart: '13:30', afternoonEnd: '17:00',
      },
      entries,
    },
  };
}

function createScheduleEnv(referees) {
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
  const toasts = [];
  const meetData = makeMeetData(referees);
  const context = vm.createContext({
    document: documentStub,
    console,
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    setTimeout, clearTimeout,
    Layout: { init() {} },
    Store: {
      read: () => JSON.parse(JSON.stringify(meetData)),
      write: () => {},
      onReady: () => () => {},          // 不自动回调，测试里手动初始化
    },
    showToast: (message, type) => toasts.push({ message, type }),
  });
  // 浏览器里 window === globalThis，这里保持一致，页面脚本才能挂到全局对象上
  context.globalThis = context;
  context.window = context;
  context.parent = context;
  context.location = { search: '' };
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.dispatchEvent = () => {};
  ['js/referee-utils.js', 'js/schedule.js'].forEach(file => {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  });
  new vm.Script(`globalThis.__api = {
    init: () => initializeSchedulePage(),
    entries: () => filteredScheduleEntries(),
    all: () => currentSchedule,
    lane: entries => renderScheduleLane(entries, {
      eventIds: new Set(),
      recoveryEventIds: new Set(),
      recoveryAthleteIds: new Set(),
      recoveryDetails: [],
    }, VENUE_RESOURCES[0]),
    page: () => pageContent.innerHTML,
    sheets: (list, mode) => buildScoreSheetsHTML(list, mode),
    sheet: (entry, mode) => buildScoreSheetHTML(entry, mode),
    refereeLabel,
    refereeFullLabel,
    refereeOf,
    setFilters: (grade, gender, event) => {
      scheduleGradeFilter = grade;
      scheduleGenderFilter = gender;
      scheduleEventFilter = event;
    },
    filterLabel: () => scheduleFilterLabel(),
  };`, { filename: 'extract.js' }).runInContext(context);
  return { context, api: context.__api, nodes, toasts, node: id => documentStub.getElementById(id) };
}

/* ================= ① 裁判员字典（纯函数） ================= */

require(path.join(ROOT, 'js/referee-utils.js'));
const { RefereeUtils } = globalThis;

await test('① 旧格式（年级|组别|项目）自动迁移成「一个项目、多位裁判」', async () => {
  const legacy = {
    '3|male|50米': { name: '张老师', phone: '13800000000' },
    '5|female|50米': { name: '李老师', phone: '13911112222' },
    '3|male|跳远': { name: '王老师', phone: '' },
  };
  const { dict, migrated } = RefereeUtils.normalize(legacy);
  assert(migrated, '应当识别出旧格式数据');
  equal(Object.keys(dict).length, 2, '迁移后应只剩 2 个项目');
  equal(dict['50米'].length, 2, '两个年级的 50 米应合并成同一组裁判');
  equal(RefereeUtils.namesOf(dict, '50米'), '张老师、李老师', '合并后的姓名串不对');
  equal(RefereeUtils.fullOf(dict, '50米'), '张老师（13800000000）、李老师（13911112222）', '带电话的显示不对');
  equal(RefereeUtils.labelOf(dict, '跳远'), '王老师', '跳远只有一位裁判');
  equal(RefereeUtils.labelOf(dict, '铅球'), '待指派', '没指派的项目应显示待指派');
});

await test('② 新格式（数组）保持原样，且大小写/空格不影响匹配', async () => {
  const fresh = { '50米': [{ name: '张老师', phone: '138' }, { name: '李老师', phone: '' }] };
  const { dict, migrated } = RefereeUtils.normalize(fresh);
  equal(migrated, false, '新格式不该被判定为需要迁移');
  equal(dict['50米'].length, 2, '两个人都要保留');
  equal(RefereeUtils.namesOf(dict, ' 50米 '), '张老师、李老师', '键应忽略大小写与空格');
  equal(Object.keys(RefereeUtils.normalize(null).dict).length, 0, '空数据要安全');
});

/* ================= ② 赛程页：筛选 + 成绩表 ================= */

await test('③ 新格式裁判员在赛程页正确显示（多人 / 待指派）', async () => {
  const env = createScheduleEnv({
    '50米': [{ name: '张老师', phone: '13800000000' }, { name: '李老师', phone: '13911112222' }],
    '跳远': [],
  });
  env.api.init();
  const [e1, e2, e3] = env.api.all();
  equal(env.api.refereeLabel(e1), '张老师、李老师', '50米的裁判名单不对');
  equal(env.api.refereeFullLabel(e1), '张老师（13800000000）、李老师（13911112222）', '带电话的裁判名单不对');
  equal(env.api.refereeLabel(e2), '张老师、李老师', '同一项目的其它年级应共用同一组裁判');
  equal(env.api.refereeLabel(e3), '待指派', '没填裁判的项目应显示待指派');
  equal(env.api.refereeOf(e1).length, 2, '裁判数组长度不对');
});

await test('④ 旧格式数据在赛程页也能显示（不需要手动迁移）', async () => {
  const env = createScheduleEnv({ '3|male|50米': { name: '张老师', phone: '13800000000' } });
  env.api.init();
  const [e1] = env.api.all();
  equal(env.api.refereeLabel(e1), '张老师', '旧数据应折算后照常显示');
});

await test('⑤ 筛选（年级 / 性别 / 项目）结果正确', async () => {
  const env = createScheduleEnv({ '50米': [{ name: '张老师', phone: '138' }] });
  env.api.init();
  equal(env.api.entries().length, 3, '默认应返回全部 3 个场次');
  env.api.setFilters('3', 'all', 'all');
  equal(env.api.entries().length, 1, '三年级只有 1 个场次');
  env.api.setFilters('all', 'female', 'all');
  equal(env.api.entries().length, 2, '女子组有 2 个场次');
  env.api.setFilters('all', 'all', '50米');
  equal(env.api.entries().length, 2, '50米有 2 个场次');
  env.api.setFilters('all', 'all', '跳远');
  equal(env.api.entries().length, 1, '跳远有 1 个场次');
  env.api.setFilters('1', 'all', 'all');
  equal(env.api.entries().length, 0, '一年级没有场次');
  assert(env.api.filterLabel().includes('全部项目'), '筛选条件描述要能说清楚');
});

await test('⑥ 紧凑拼版（省纸版）：2 列网格 + 不强制分页 + 虚线裁剪框 + 防切断', async () => {
  const env = createScheduleEnv({
    '50米': [{ name: '张老师', phone: '13800000000' }, { name: '李老师', phone: '13911112222' }],
    '跳远': [{ name: '王老师', phone: '' }],
  });
  env.api.init();
  const entries = env.api.entries();
  const html = env.api.sheets(entries, 'compact');
  assert(html.includes('class="layout-compact"'), '紧凑版要挂在 layout-compact 下');
  assert(html.includes('<div class="sheet-grid">'), '紧凑版要有 2 列网格容器');
  assert(html.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), '网格必须是 2 列');
  // 紧凑版【不能】再有强制分页，否则还是一页一张
  assert(!/\.layout-compact[^{]*\{[^}]*page-break-after:\s*always/.test(html), '紧凑版不能强制分页');
  assert(html.includes('break-inside: avoid'), '小表必须防切断（break-inside: avoid）');
  assert(html.includes('page-break-inside: avoid'), '小表必须防切断（page-break-inside: avoid）');
  assert(html.includes('border: 1px dashed #ccc'), '小表四周要有浅灰虚线（方便裁剪）');
  equal((html.match(/<section class="sheet-page">/g) || []).length, 3, '3 个场次应生成 3 张小表');
  // 表头信息一项都不能少：项目名称 / 时间 / 场地 / 裁判
  assert(html.includes('三年级男子组50米成绩登记表'), '标题要带上年级/组别/项目');
  assert(html.includes('时间：'), '紧凑版表头要有时间');
  assert(html.includes('场地：'), '紧凑版表头要有场地');
  assert(html.includes('裁判：'), '紧凑版表头要有裁判');
  assert(html.includes('张老师（13800000000）、李老师（13911112222）'), '表头要带整组裁判名单');
  // 签字栏压成一行
  assert(html.includes('主裁：') && html.includes('检录：') && html.includes('记录：'), '紧凑版签字栏要压成一行');
  assert(html.includes('<td></td>'), '成绩/名次/备注三列要留空');
  equal((html.match(/成绩登记表<\/h1>/g) || []).length, 3, '每张小表都要有标题');
});

await test('⑦ 大字版（一表一页）：强制分页 + 大字号 + 三栏签字', async () => {
  const env = createScheduleEnv({ '50米': [{ name: '张老师', phone: '13800000000' }] });
  env.api.init();
  const html = env.api.sheets(env.api.entries(), 'single');
  assert(html.includes('class="layout-single"'), '大字版要挂在 layout-single 下');
  assert(!html.includes('<div class="sheet-grid">'), '大字版不要网格容器');
  assert(/\.layout-single \.sheet-page\s*\{[^}]*page-break-after:\s*always/.test(html), '大字版必须一表一页');
  assert(html.includes('.layout-single .sheet-page:last-child'), '最后一页不能强制分页');
  assert(html.includes('font-size: 21px'), '大字版标题字号要够大');
  assert(html.includes('比赛时间：') && html.includes('比赛场地：') && html.includes('主裁判：'), '大字版表头信息要齐全');
  assert(html.includes('检录员签字') && html.includes('裁判员签字') && html.includes('记录员签字'), '大字版保留三个签字栏');
});

await test('⑧ 两种排版的表头都带全项目名/时间/裁判（不能因为拼版丢信息）', async () => {
  const env = createScheduleEnv({ '50米': [{ name: '张老师', phone: '138' }] });
  env.api.init();
  const entries = env.api.entries();
  ['compact', 'single'].forEach(mode => {
    const html = env.api.sheets(entries, mode);
    assert(html.includes('三年级男子组50米成绩登记表'), `${mode} 版丢了项目名称`);
    assert(/2026-05-21|2026年5月21日/.test(html), `${mode} 版丢了比赛日期`);
    assert(html.includes('08:30'), `${mode} 版丢了比赛时间`);
    assert(html.includes('跑道'), `${mode} 版丢了场地`);
    assert(html.includes('张老师'), `${mode} 版丢了裁判姓名`);
  });
});

await test('⑨ 批量生成 300 张成绩表够快（不卡死浏览器）', async () => {
  const env = createScheduleEnv({ '50米': [{ name: '张老师', phone: '138' }] });
  env.api.init();
  const base = env.api.all()[0];
  const many = Array.from({ length: 300 }, (_, index) => ({
    ...base,
    id: `x${index}`,
    startAt: new Date(new Date(base.startAt).getTime() + index * 60000).toISOString().slice(0, 19),
  }));
  const started = Date.now();
  const html = env.api.sheets(many);
  const cost = Date.now() - started;
  const pages = html.match(/<section class="sheet-page">/g) || [];
  equal(pages.length, 300, '应生成 300 页');
  assert(cost < 1500, `生成 300 页耗时 ${cost}ms，太慢（应 < 1500ms）`);
  console.log(`     （生成 300 页耗时 ${cost}ms，HTML ${Math.round(html.length / 1024)}KB）`);
});

await test('⑩ 明细卡片已移除【单张打印成绩表】按钮，其它功能原样保留', async () => {
  const env = createScheduleEnv({ '50米': [{ name: '张老师', phone: '138' }] });
  env.api.init();
  const laneHTML = env.api.lane(env.api.all());
  assert(!laneHTML.includes('打印成绩表'), '明细卡片里不应再有单张打印按钮');
  assert(!laneHTML.includes('schedule-event-actions'), '不该再有按钮容器');
  assert(!laneHTML.includes('printScoreSheet('), '不该再调用单张打印函数');
  // 必须保留的功能
  assert(laneHTML.includes('schedule-event-referee'), '裁判信息要保留');
  assert(laneHTML.includes('张老师'), '裁判姓名要显示');
  assert(laneHTML.includes('schedule-roster-details'), '展开看名单要保留');
  assert(laneHTML.includes('运动员 / 出场顺序'), '名单摘要要保留');
  assert(laneHTML.includes('schedule-inline-edit'), '改时间/场地要保留');
  assert(laneHTML.includes('schedule-datetime') && laneHTML.includes('schedule-venue'), '时间与场地输入框要保留');
  assert(laneHTML.includes('schedule-event-head'), '卡片头部（标题 + 裁判同行）要保留');
});

await test('⑪ 顶部批量打印（按条件 / 一键全量）不受影响', async () => {
  const env = createScheduleEnv({ '50米': [{ name: '张老师', phone: '138' }] });
  env.api.init();
  const pageHTML = env.api.page();
  assert(pageHTML.includes('printFilteredScoreSheets'), '按条件打印按钮要保留');
  assert(pageHTML.includes('printAllScoreSheets'), '一键全量打印按钮要保留');
  assert(pageHTML.includes('按条件打印成绩表'), '按条件打印按钮文案要保留');
  assert(pageHTML.includes('一键打印全部成绩表'), '一键全量打印按钮文案要保留');
  assert(pageHTML.includes('sheetLayoutMode'), '排版切换下拉要保留');
  assert(pageHTML.includes('scheduleEventFilter'), '项目筛选器要保留');
});

/* ================= 汇总 ================= */
const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  failed.forEach(item => console.log(`  ❌ ${item.name}：${item.error.message}`));
  process.exitCode = 1;
}
