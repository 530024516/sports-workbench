/**
 * 离线资源库回归测试（node tests/offline-resources-smoke.mjs）
 *
 * 覆盖三条战线：
 *   ① 服务端：offline_resources 表的列映射（id / category / level / content / modules_json / created_at）
 *   ② 数据层：离线可用（本地优先）、增删改查、manifest 去重、云端同步守护
 *   ③ 前端：卡片渲染、选择器、查看弹窗、手动添加、与大单元设计页的联动
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const supabase = require(path.join(ROOT, 'lib/supabase.js'));
const { STORE_SCHEMA } = require(path.join(ROOT, 'lib/store-schema.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ❌ ${name}\n     ${error.message}`);
    if (process.argv.includes('--debug')) console.log(String(error.stack).split('\n').slice(1, 6).join('\n'));
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

console.log('\n🧪 离线资源库回归测试\n');

/* ================= ① 服务端列映射 ================= */

await test('① 存储键 → offline_resources 表，且 RowShaped 标记与前端一致', async () => {
  const config = STORE_SCHEMA.pe_offline_resources_v1;
  assert(config, '缺少 pe_offline_resources_v1 配置');
  equal(config.table, 'offline_resources', '表名必须是 offline_resources');
  equal(config.rowShaped, true, '这张表用的是具名列，必须标记 rowShaped');
  // 前端 Store 同步清单里也要有这个键，否则根本不会同步
  const storeSource = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');
  assert(storeSource.includes("'pe_offline_resources_v1'"), 'js/store.js 的 STORE_KEYS 里必须加上这个键');
});

await test('② 列映射：六列全部正确落地，无 id 的行被丢弃', async () => {
  const now = '2026-10-30T00:00:00.000Z';
  const rows = supabase.buildRowShapedRows([
    {
      id: 'ur_1', category: '球类', level: '水平三（5–6 年级）', content: '行进间变向运球',
      modules_json: { lessons: [{ no: 1, content: '第一节' }] }, created_at: '2026-10-29T00:00:00.000Z',
    },
    { category: '没有 id 的记录' },                    // 必须被丢弃，否则整批 insert 会失败
    { id: 'ur_2', category: '田径类' },                // 缺字段走默认值
  ], now);

  equal(rows.length, 2, '没有 id 的行必须被过滤掉');
  equal(rows[0].id, 'ur_1', 'id 列');
  equal(rows[0].category, '球类', 'category 列');
  equal(rows[0].level, '水平三（5–6 年级）', 'level 列');
  equal(rows[0].content, '行进间变向运球', 'content 列');
  assert(Array.isArray(rows[0].modules_json.lessons), 'modules_json 列必须是完整对象（不能是字符串）');
  equal(rows[0].created_at, '2026-10-29T00:00:00.000Z', '已含 created_at 时必须原样保留');
  equal(rows[0].ord, 0, 'ord 按顺序递增，保证列表顺序稳定');
  equal(rows[1].ord, 1, 'ord 按顺序递增');
  equal(rows[1].modules_json.lessons, undefined, '缺 modules_json 时给 {}');
  equal(rows[1].updated_at, now, '缺 updated_at 时用本次写入时间');
});

await test('③ 库表行 → 前端资源对象：modules_json 原样带回来', async () => {
  const record = supabase.normalizeRow({
    id: 'ur_1', category: '体操类', level: '水平二（3–4 年级）', content: '前滚翻',
    modules_json: { unitTitle: '体操大单元', lessons: [{ no: 1, content: '前滚翻' }] },
    created_at: '2026-10-30T01:02:03.000Z', updated_at: null, ord: 0,
  });
  equal(record.id, 'ur_1', 'id 还原');
  equal(record.category, '体操类', 'category 还原');
  equal(record.content, '前滚翻', 'content 还原');
  equal(record.modules_json.unitTitle, '体操大单元', 'modules_json 必须是对象，不能被压成字符串');
  // 往返一致性：存进去再读回来，业务字段不变
  const roundTrip = supabase.normalizeRow(supabase.buildRowShapedRows([record])[0]);
  equal(roundTrip.content, record.content, '往返后 content 一致');
  equal(roundTrip.modules_json.unitTitle, record.modules_json.unitTitle, '往返后 modules_json 一致');
});

/* ================= ②③ 前端数据层（假 DOM） ================= */

function createEnv({ cloud = 'off', withUnitDesign = false } = {}) {
  const store = new Map();          // localStorage
  const calls = [];                 // 假装发给 /api/data 的请求
  const nodes = new Map();
  const overlays = [];              // showModal 打开的弹窗
  const localStorageStub = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); },
    get length() { return store.size; },
    key: index => [...store.keys()][index] ?? null,
  };
  const makeNode = id => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, className: '',
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, click() {}, remove() {}, appendChild() {},
  });
  const documentStub = {
    readyState: 'complete',
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeNode(id));
      return nodes.get(id);
    },
    querySelector: () => null,
    querySelectorAll: selector => (String(selector).includes('modal-overlay') ? overlays : []),
    addEventListener() {},
    createElement: () => makeNode('tmp'),
    body: makeNode('body'),
  };
  const win = {
    confirm: () => true,
    location: { href: '', search: '' },
    addEventListener() {},
    dispatchEvent() {},
  };

  // Store 替身：读本地、写本地、假装异步推云端
  const Store = {
    mode: cloud === 'off' ? 'local' : 'supabase',
    cloudState: cloud,
    lastSyncAt: 0,
    _cloudPaused: false,
    cache: new Map(),
    read(key, fallback = null) {
      if (this.cache.has(key)) return this.cache.get(key);
      const raw = localStorageStub.getItem(key);
      if (raw === null) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    },
    write(key, value) {
      this.cache.set(key, value);
      localStorageStub.setItem(key, JSON.stringify(value));
      if (this.cloudState !== 'off' && key === 'pe_offline_resources_v1') {
        calls.push({ method: 'POST', key, value });
      }
      return value;
    },
    onReady(callback) { callback(this.mode); return () => {}; },
  };

  const context = vm.createContext({
    window: win, document: documentStub, localStorage: localStorageStub,
    Store, console, setTimeout, clearTimeout, Date, JSON, Math, URLSearchParams, Object, Array, String, Number, Boolean, Set, Map, Promise, Error,
    Layout: { init() {} },
    showToast: (message, type) => toasts.push({ message, type }),
    showModal: (title, bodyHTML, footerHTML) => {
      const overlay = {
        title, bodyHTML, footerHTML,
        // closeModals() 在真实 DOM 里调 element.remove()，这里给个等价实现
        remove() {
          const index = overlays.indexOf(overlay);
          if (index >= 0) overlays.splice(index, 1);
        },
      };
      overlays.push(overlay);
      return overlay;
    },
    closeModal: () => {},
  });
  const toasts = [];
  context.globalThis = context;
  context.toasts = toasts;
  context.localStorage = localStorageStub;

  // 按页面 <script> 顺序注入
  const files = ['js/unit-model.js', 'js/unit-catalog.js', 'js/offline-resources.js'];
  if (withUnitDesign) files.push('js/unit-design.js');
  files.forEach(file => {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  });
  // 大单元页的函数只有加载了 unit-design.js 的环境里才有，按需导出
  const pageExports = withUnitDesign ? `
    getUnitData: () => unitData, setUnitData: v => { unitData = v; },
    saveUnitToResources, unitResourceRecord, loadUnitFromResource, loadUnitFromUrl,` : '';
  new vm.Script(`globalThis.__api = {
    R: OfflineResources, createEmptyUnit, normalizeUnit,
    normalizeRecord: r => OfflineResources.normalizeRecord(r),${pageExports}
  };`, { filename: 'extract.js' }).runInContext(context);

  return {
    context, api: context.__api, nodes, overlays, toasts, calls, Store, storage: store,
    // 取 DOM 节点请走这个（会自动创建），不要用 nodes.get —— 那是原生的 Map#get，没有兜底
    node: id => documentStub.getElementById(id),
  };
}

/** 共用一份基线环境，只为拿到真实的数据模型（createEmptyUnit） */
const BASE = createEnv({ cloud: 'off' });
const { createEmptyUnit } = BASE.api;

/** 用真实模型造一份完整大单元 */
function makeUnit({ title = '水平三篮球大单元', source = 'ai' } = {}) {
  const unit = createEmptyUnit();
  unit.unitTitle = title;
  unit.objectives = { ability: '能力目标', health: '健康目标', character: '品德目标' };
  unit.textbookAnalysis = '教材分析';
  unit.studentAnalysis = '学情分析';
  unit.teachingContent = '教学内容';
  unit.keyDifficulties = { learning: 'L', content: 'C', organization: 'O', method: 'M' };
  unit.assessment = '考核与作业';
  unit.evaluation = { process: '过程性', summative: '终结性', integration: '一体化' };
  unit.reflection = '反思模板';
  unit.resources = '资源清单';
  unit.lessons = unit.lessons.map((lesson, index) => ({
    ...lesson, content: `第${index + 1}课内容`, method: `第${index + 1}课组织教法`,
    objectives: { ability: `能力${index + 1}`, health: `健康${index + 1}`, character: `品德${index + 1}` },
  }));
  unit.structure = {
    basic: [{ no: 1, title: '第1课次：认识篮球（球性练习）' }, { no: 2, title: '第2课次：规则与安全' }],
    technique: Array.from({ length: 8 }, (_, i) => ({ no: i + 3, title: `第${i + 3}课次：技术` })),
    tactics: Array.from({ length: 5 }, (_, i) => ({ no: i + 11, title: `第${i + 11}课次：战术` })),
    fitness: Array.from({ length: 3 }, (_, i) => ({ no: i + 16, title: `第${i + 16}课次：体能` })),
  };
  unit.meta = {
    ...unit.meta, unitTitle: title, source,
    categoryId: 'ball', category: '球类', itemId: 'basketball', item: '篮球',
    levelId: 'L3', level: '水平三（5–6 年级）',
    topic: '行进间变向运球、急停急起与运球投篮衔接',
    generatedAt: source === 'ai' ? new Date().toISOString() : '',
  };
  return unit;
}

await test('④ 断网也能存：云端 offline 时保存成功，本地立刻可读', async () => {
  const env = createEnv({ cloud: 'off' });
  const unit = makeUnit();
  const result = env.api.R.saveUnit(unit, { source: 'ai' });
  assert(result.ok, '离线状态必须照样存成功');
  equal(env.api.R.count(), 1, '资源库里应有 1 条');
  env.Store.cache.clear();                       // 模拟刷新：内存缓存全丢，只剩 localStorage
  const reloaded = env.api.R.get(result.record.id);
  assert(reloaded, '刷新后必须还能从 localStorage 读到');
  equal(reloaded.modules_json.unitTitle, '水平三篮球大单元', '刷新后单元名还在');
  equal(reloaded.modules_json.lessons.length, 18, '刷新后 18 课时还在');
  equal(env.calls.length, 0, '离线时不发云端请求，但不影响本地使用');
});

await test('⑤ 完整往返：存档 → 取回，11 个模块与 18 课时一字不少', async () => {
  const env = createEnv({ cloud: 'supabase' });
  const unit = makeUnit();
  const saved = env.api.R.saveUnit(unit, { source: 'ai' });
  const restored = env.api.R.unitFromRecord(env.api.R.get(saved.record.id));
  equal(restored.unitTitle, unit.unitTitle, '单元名');
  equal(restored.objectives.ability, unit.objectives.ability, '模块1 运动能力');
  equal(restored.textbookAnalysis, unit.textbookAnalysis, '模块2 教材分析');
  equal(restored.studentAnalysis, unit.studentAnalysis, '模块3 学情分析');
  equal(restored.teachingContent, unit.teachingContent, '模块4 教学内容');
  equal(restored.keyDifficulties.organization, unit.keyDifficulties.organization, '模块5 重难点·教学组织');
  equal(restored.structure.basic[0].title, '第1课次：认识篮球（球性练习）', '模块6 结构图');
  equal(restored.lessons.length, 18, '模块7 课时表 18 行');
  equal(restored.lessons[17].objectives.character, '品德18', '模块7 第18课三维目标');
  equal(restored.assessment, unit.assessment, '模块8 考核与作业');
  equal(restored.evaluation.integration, unit.evaluation.integration, '模块9 学习评价');
  equal(restored.reflection, unit.reflection, '模块10 教学反思');
  equal(restored.resources, unit.resources, '模块11 教学资源');
  equal(restored.meta.resourceId, saved.record.id, '取回时必须记住自己属于哪条资源（后续编辑才不会存成副本）');
  assert(env.calls.length > 0, '联网时要把列表推给云端');
});

await test('⑥ 重复保存更新同一条，不会越存越多', async () => {
  const env = createEnv({ cloud: 'supabase' });
  const unit = makeUnit();
  const first = env.api.R.saveUnit(unit, { source: 'ai' });
  env.Store.cloudState = 'off';                  // 第二次改成离线，同样要能更新
  unit.textbookAnalysis = '教材分析（已修改）';
  const second = env.api.R.saveUnit(unit, { id: first.record.id });
  equal(env.api.R.count(), 1, '仍然是 1 条');
  equal(second.created, false, '第二次是更新而不是新建');
  equal(env.api.R.get(first.record.id).modules_json.textbookAnalysis, '教材分析（已修改）', '修改要生效');
  assert(env.api.R.get(first.record.id).updated_at, '更新要有 updated_at');
  equal(env.api.R.get(first.record.id).created_at, first.record.created_at, 'created_at 保持不变');
});

await test('⑦ 删除：本地列表移除，并清掉本地小票', async () => {
  const env = createEnv({ cloud: 'supabase' });
  const id = env.api.R.saveUnit(makeUnit(), { source: 'ai' }).record.id;
  equal(env.api.R.count(), 1, '先有 1 条');
  env.api.R.remove(id);
  equal(env.api.R.count(), 0, '删除后为 0');
  equal(env.api.R.get(id), null, '删除后取不到');
  equal(Object.keys(env.api.R.readPendingMap()).includes(id), false, '本地小票也要一起清掉');
});

await test('⑧ 脏数据兜底：无 id 的记录丢弃，残缺模块自动补成 18 课时', async () => {
  const env = createEnv({ cloud: 'off' });
  const broken = env.api.normalizeRecord({
    id: '', category: '球类', level: '水平三', content: '运球', modules_json: {},
  });
  equal(broken, null, '没有 id 的记录不能进库');
  const repaired = env.api.normalizeRecord({
    id: 'ur_1', category: '球类', level: '水平三', content: '运球',
    modules_json: { unitTitle: '残的', lessons: [{ content: '只有一节' }], structure: '坏掉了' },
    created_at: '2026-10-30T00:00:00.000Z',
  });
  equal(repaired.modules_json.lessons.length, 18, '课时不足必须补齐到 18 行');
  equal(Array.isArray(repaired.modules_json.structure.basic), true, 'structure 坏了要还原成四个数组');
});

await test('⑨ 列表去重 + 按保存时间倒序', async () => {
  const env = createEnv({ cloud: 'off' });
  env.api.R.writeList([
    { id: 'a', category: '球类', created_at: '2026-10-01T00:00:00.000Z', modules_json: {} },
    { id: 'b', category: '田径类', created_at: '2026-10-09T00:00:00.000Z', modules_json: {} },
    { id: 'a', category: '重复项', created_at: '2026-10-02T00:00:00.000Z', modules_json: {} },
  ]);
  const list = env.api.R.list();
  equal(list.length, 2, '同 id 只保留一条');
  equal(list[0].id, 'b', '最新的排最前');
  equal(list[0].category, '田径类', '同 id 时保留更新时间更晚的那条');
});

await test('⑩ 卡片：显示 教材 / 水平 / 内容 / 保存时间，并有查看·编辑·删除', async () => {
  const env = createEnv({ cloud: 'supabase' });
  const record = env.api.R.saveUnit(makeUnit(), { source: 'ai' }).record;
  const card = env.api.R.cardHTML(record, 'manage');
  ['球类', '篮球', '水平三（5–6 年级）', '行进间变向运球'].forEach(text => {
    assert(card.includes(text), `卡片缺少信息：${text}`);
  });
  assert(/\d{4}\/\d{1,2}\/\d{1,2}/.test(card) || card.includes('保存'), '卡片要有保存时间');
  ["OfflineResources.view('", "OfflineResources.edit('", "OfflineResources.confirmDelete('"].forEach(action => {
    assert(card.includes(action), `卡片缺少按钮：${action}`);
  });
  assert(card.includes('AI 生成'), '要标出来源');
  // 选择器模式只有「载入」
  const pickerCard = env.api.R.cardHTML(record, 'pick');
  assert(pickerCard.includes('载入到设计页'), '选择器卡片要有载入按钮');
  assert(!pickerCard.includes('confirmDelete'), '选择器里不该出现删除按钮');
});

await test('⑪ 管理页渲染 + 按大类筛选 + 关键词搜索', async () => {
  const env = createEnv({ cloud: 'supabase' });
  env.api.R.saveUnit(makeUnit({ title: '篮球A', source: 'ai' }), { source: 'ai' });
  const athletics = makeUnit({ title: '田径B', source: 'manual' });
  athletics.meta = { ...athletics.meta, categoryId: 'athletics', category: '田径类', item: '短跑', topic: '站立式起跑' };
  env.api.R.saveUnit(athletics, { source: 'manual' });
  env.api.R.renderPage();
  const page = env.nodes.get('page-content').innerHTML;
  assert(page.includes('离线资源库'), '要渲染标题');
  assert(page.includes('手动添加'), '要有手动添加按钮');
  const grid = env.nodes.get('resGrid').innerHTML;
  assert(grid.includes('篮球A') && grid.includes('田径B'), '两张卡片都要出现在网格里');

  env.api.R.setFilter('', '田径类');
  const filtered = env.nodes.get('resGrid').innerHTML;
  assert(filtered.includes('田径B') && !filtered.includes('篮球A'), '按大类筛选要生效');

  env.api.R.setFilter('篮球', '');
  const searched = env.nodes.get('resGrid').innerHTML;
  assert(searched.includes('篮球A') && !searched.includes('田径B'), '按关键词搜索要生效');
});

await test('⑫ 查看弹窗：11 个模块齐全 + 18 行课时表 + 结构图四分支', async () => {
  const env = createEnv({ cloud: 'supabase' });
  const record = env.api.R.saveUnit(makeUnit(), { source: 'ai' }).record;
  env.api.R.view(record.id);
  const overlay = env.overlays[env.overlays.length - 1];
  assert(overlay, '要打开查看弹窗');
  for (let index = 1; index <= 11; index += 1) {
    assert(overlay.bodyHTML.includes(`模块 ${index}`), `查看弹窗缺少模块 ${index}`);
  }
  const rows = overlay.bodyHTML.match(/第 \d+ 课/g) || [];
  equal(rows.length, 18, '查看弹窗的课时表必须是 18 行');
  ['基础知识', '基本技术', '技战术运用', '专项体能'].forEach(branch => {
    assert(overlay.bodyHTML.includes(branch), `结构图缺少分支：${branch}`);
  });
  assert(overlay.footerHTML.includes('导出 Word'), '弹窗要能导出');
});

await test('⑬ 手动添加：不经过 AI，直接生成可编辑的空白大单元', async () => {
  const env = createEnv({ cloud: 'off' });
  // 假装把选题表单填好（这里直接构造 select 节点的返回值）
  env.node('resCreateCategory').value = 'ball';
  env.node('resCreateItem').value = 'basketball';
  env.node('resCreateLevel').value = 'L3';
  env.api.R.onCreateTopicRefresh();                       // 教学内容列表 = f(细项, 水平)
  env.node('resCreateTopic').value = '半场 3v3 / 4v4 比赛与简单战术约定';
  env.node('resCreateTitle').value = '手写的篮球大单元';

  const record = env.api.R.createBlank({ goto: false });
  assert(record, '应创建成功');
  const unit = env.api.R.unitFromRecord(env.api.R.get(record.id));
  equal(unit.lessons.length, 18, '空白单元也要有 18 行课时框架');
  equal(unit.meta.source, 'manual', '来源要标成手填');
  equal(unit.meta.level, '水平三（5–6 年级）', '水平要带过来');
  equal(unit.meta.topic, '半场 3v3 / 4v4 比赛与简单战术约定', '教学内容要带过来');
  equal(unit.unitTitle, '手写的篮球大单元', '单元名要用表单里填的');
  equal(env.api.R.count(), 1, '已经进资源库了');
  // 跳转型：createBlank({goto:true}) 应该指向大单元页并带上 resource 参数
  const jumpEnv = createEnv({ cloud: 'off' });
  jumpEnv.node('resCreateTitle').value = '待编辑';
  jumpEnv.api.R.createBlank({ goto: true });
  assert(String(jumpEnv.context.window.location.href).startsWith('unit-design.html?resource='),
    '手填后应跳转到大单元编辑页并带上资源 id');
});

await test('⑭ 云端同步守护：B 机覆盖云端后，本机离线存的资源不能被洗掉', async () => {
  const env = createEnv({ cloud: 'off' });
  const mine = env.api.R.saveUnit(makeUnit({ title: '我离线写的' }), { source: 'manual' });
  // 换成联网，且云端同步回来的列表里【没有】我这条（模拟另一台设备整表覆盖）
  env.Store.cloudState = 'supabase';
  env.Store.cache.clear();
  env.Store.cache.set('pe_offline_resources_v1', []);
  env.storage.set('pe_offline_resources_v1', '[]');
  equal(env.api.R.count(), 0, '同步后列表确实被洗空了');
  const report = env.api.R.reconcile();
  equal(report.restored, 1, '本机离线存的资源必须被补回来');
  equal(env.api.R.get(mine.record.id).modules_json.unitTitle, '我离线写的', '内容要完整补回');
});

await test('⑮ 大单元页联动：保存 → 结果区出现保存按钮并绑定资源', async () => {
  const env = createEnv({ cloud: 'supabase', withUnitDesign: true });
  env.api.setUnitData(makeUnit());
  env.api.saveUnitToResources();
  const unit = env.api.getUnitData();
  assert(unit.meta.resourceId, '绑定了资源 id');
  const head = env.nodes.get('ud2Modules').innerHTML;
  assert(head.includes('更新到离线资源库'), '再次渲染时按钮应变成「更新」');
  assert(head.includes('已绑定离线资源'), '要显示已绑定标记');
  assert(head.includes('资源库管理'), '要有去管理页的入口');
});

await test('⑯ 大单元页联动：从资源库载入（pick）不调用 AI，直接填充结果区', async () => {
  const env = createEnv({ cloud: 'supabase', withUnitDesign: true });
  // 先存一份资源
  const record = env.api.R.saveUnit(makeUnit({ title: '库里那一份' }), { source: 'ai' });
  // 页面当前是一份"别的"内容
  const other = makeUnit({ title: '页面上当前的' });
  env.api.setUnitData(other);
  // 选择器带回记录
  let delivered = null;
  env.api.R.openPicker(rec => { delivered = rec; });
  const overlay = env.overlays[env.overlays.length - 1];
  assert(overlay.bodyHTML.includes('载入到设计页'), '选择器要列出卡片');
  env.api.R.pick(record.record.id);
  assert(delivered, 'pick 要把资源交给回调');
  env.api.loadUnitFromResource(delivered);
  equal(env.api.getUnitData().unitTitle, '库里那一份', '结果区应被资源内容填充');
  equal(env.api.getUnitData().meta.resourceId, record.record.id, '载入后自动绑定，继续编辑会写回这条资源');
  // ⛔ 关键：整个流程不能发任何 AI 请求（环境里连 fetch 都没定义，发了会抛错）
  assert(typeof env.context.fetch === 'undefined', '加载路径确实没有碰 AI 接口');
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
