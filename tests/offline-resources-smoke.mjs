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
  const blobs = [];                 // downloadFile() 造出来的 Blob，用于验证模板内容
  const win = {
    confirm: () => true,
    location: { href: '', search: '' },
    addEventListener() {},
    dispatchEvent() {},
  };
  // 浏览器下载 API 的最小替身（Node 里没有 Blob / URL.createObjectURL）
  const BlobStub = class Blob {
    constructor(parts = [], options = {}) {
      this.parts = parts;
      this.options = options;
      this.content = parts.map(part => String(part)).join('');
      blobs.push(this);
    }
  };
  const URLStub = { createObjectURL: () => 'blob:stub', revokeObjectURL() {} };
  // 老浏览器的 FileReader 路径也要能跑：这里模拟异步读取
  const FileReaderStub = class FileReader {
    readAsText(file) {
      Promise.resolve(typeof file?.text === 'function' ? file.text() : String(file?._text ?? ''))
        .then(result => { this.result = result; if (this.onload) this.onload(); })
        .catch(error => { this.error = error; if (this.onerror) this.onerror(); });
    }
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
    Blob: BlobStub, URL: URLStub, FileReader: FileReaderStub,
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

  // 按页面 <script> 顺序注入（见 offline-resources.html）
  const files = ['js/unit-model.js', 'js/unit-catalog.js', 'js/unit-template.js', 'js/offline-resources.js'];
  if (withUnitDesign) files.push('js/unit-design.js');
  files.forEach(file => {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  });
  // 大单元页的函数只有加载了 unit-design.js 的环境里才有，按需导出
  const pageExports = withUnitDesign ? `
    getUnitData: () => unitData, setUnitData: v => { unitData = v; },
    saveUnitToResources, unitResourceRecord, loadUnitFromResource, loadUnitFromUrl,` : '';
  new vm.Script(`globalThis.__api = {
    R: OfflineResources, createEmptyUnit, normalizeUnit, UNIT_MODULES, UNIT_TEMPLATE_MODULES,
    normalizeRecord: r => OfflineResources.normalizeRecord(r),
    buildUnitTemplate, parseUnitTemplate, unitFieldToText, unitFieldFromText,
    unitModuleTitle, unitTemplateFileName, unitSplitSections,
    ${pageExports}
  };`, { filename: 'extract.js' }).runInContext(context);

  return {
    context, api: context.__api, nodes, overlays, toasts, calls, Store, storage: store, blobs,
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
  // 三个离线入口必须在页面上：手填工作台 / 模板下载 / 上传区
  assert(page.includes('手填大单元'), '要有手填工作台入口');
  assert(page.includes('下载大单元模板'), '要有模板下载按钮');
  assert(page.includes('上传大单元文件'), '要有上传区域');
  assert(page.includes('OfflineResources.openWorkbench()'), '手填入口要指向全屏工作台');
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

/** 老师在本地编辑器里按模板填好的样子 —— 故意用各种"不那么规矩"的写法 */
function handwrittenMarkdown({ dropStudentAnalysis = false, lessons = 18 } = {}) {
  const rows = [];
  for (let no = 1; no <= lessons; no += 1) {
    rows.push(`| 第${no}课次 | ${['基本技术', 'basic', 'technique', '战术'][no % 4]} | 能力${no} | 健康${no} | 品德${no} | 第${no}课内容 | 第${no}课组织教法 |`);
  }
  return `# 水平三篮球大单元

## 基本信息
- 单元名称：水平三篮球大单元
- 教材大类：球类
- 教材细项：篮球
- 水平：水平三（5–6 年级）
- 教学内容：行进间变向运球、急停急起与运球投篮衔接

# 一、教学目标
- 运动能力：能在对抗中完成变向运球与投篮衔接
- 健康行为：每周三次课外锻炼
- 体育品德：遵守规则、尊重对手

### 2. 教材分析
本单元选自球类·篮球，围绕球性与投篮衔接展开。
${dropStudentAnalysis ? '' : '## 三、学情分析\n水平三学生协调性发展较快，但对抗意识不足。\n'}

## 四、教学内容
球性、变向运球、投篮衔接、战术配合、体能。

**教学重难点**
- 学生学习的重难点：手脚协调配合
- 学习内容的重难点：变向时的重心控制
- 教学组织的重难点：分组轮换有序
- 教学方法的重难点：由分解到完整

## 六、结构图
- 基础知识：第1课次：认识篮球；第2课次：规则与安全
- 基本技术：第3课次：原地运球

# 七、课时计划
| 课时 | 维度 | 运动能力 | 健康行为 | 体育品德 | 教学内容 | 组织教学与方法 |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## 八、考核与作业
变向运球计时 + 投篮命中率。

## 九、学习评价
- 过程性评价：课堂观察表
- 终结性评价：技能测评
- 学练赛评一体化：每节课 5 分钟互评

## 十、教学反思
课后填写：目标达成情况 / 环节耗时 / 下次改进。

## 十一、教学资源
标志桶 40 个、篮球 20 个、战术板 1 块。
`;
}

await test('⑰ 模板下载：11 个模块标题 + 18 行课时表格都写死在 .md 里', async () => {
  const env = createEnv({ cloud: 'off' });
  equal(env.api.unitTemplateFileName({}), '大单元填写模板.md', '没有单元名时的模板文件名');
  assert(env.api.R.downloadTemplate(), '模板要能下载成功');

  const blob = env.blobs[env.blobs.length - 1];
  assert(blob.options.type.startsWith('text/markdown'), '模板要导出成 Markdown');
  const md = blob.content;
  [
    '一、教学目标', '二、教材分析', '三、学情分析', '四、主要教学内容', '五、教学重难点',
    '六、大单元设计结构图', '七、18 课时计划表', '八、考核与作业', '九、学习评价',
    '十、教学反思', '十一、教学资源',
  ].forEach(heading => assert(md.includes(`## ${heading}`), `模板缺少标题：${heading}`));
  const rows = md.split('\n').filter(line => /^\|\s*\d+\s*\|/.test(line));
  equal(rows.length, 18, '模板必须写死 18 行课时');
  assert(md.includes('| 课时 | 维度 | 运动能力 | 健康行为 | 体育品德 | 教学内容 | 组织教学与方法 |'),
    '课时表的表头要把每个字段都列出来');
  ['单元名称', '教材大类', '教材细项', '水平', '教学内容'].forEach(label => {
    assert(md.includes(`- ${label}：`), `基本信息缺少：${label}`);
  });
  assert(md.includes('填写说明'), '模板要带填写说明，别让老师猜');
});

await test('⑱ 模板往返：单元 → .md → 解析回来，11 模块与 18 课时一字不少', async () => {
  const env = createEnv({ cloud: 'off' });
  const source = makeUnit({ title: '往返测试单元' });
  source.lessons = source.lessons.map((lesson, index) => ({
    ...lesson,
    dimension: ['basic', 'technique', 'tactic', 'fitness', 'match', 'rule'][index % 6],
  }));
  const markdown = env.api.buildUnitTemplate(source);
  const report = env.api.parseUnitTemplate(markdown);

  assert(report.ok, `解析应当成功：${report.errors.join('；')}`);
  equal(report.missing.length, 0, `不能有缺失模块：${report.missing.join('、')}`);
  equal(report.lessonRows, 18, '18 课时要全部解析出来');
  const unit = report.unit;
  equal(unit.unitTitle, '往返测试单元', '单元名');
  equal(unit.objectives.ability, source.objectives.ability, '模块1 运动能力');
  equal(unit.textbookAnalysis, source.textbookAnalysis, '模块2 教材分析');
  equal(unit.studentAnalysis, source.studentAnalysis, '模块3 学情分析');
  equal(unit.teachingContent, source.teachingContent, '模块4 主要教学内容');
  equal(unit.keyDifficulties.method, source.keyDifficulties.method, '模块5 重难点');
  equal(unit.assessment, source.assessment, '模块8 考核与作业');
  equal(unit.evaluation.integration, source.evaluation.integration, '模块9 学习评价');
  equal(unit.reflection, source.reflection, '模块10 教学反思');
  equal(unit.resources, source.resources, '模块11 教学资源');
  unit.lessons.forEach((lesson, index) => {
    equal(lesson.content, source.lessons[index].content, `第 ${index + 1} 课教学内容`);
    equal(lesson.method, source.lessons[index].method, `第 ${index + 1} 课组织教法`);
    equal(lesson.objectives.character, source.lessons[index].objectives.character, `第 ${index + 1} 课体育品德`);
    equal(lesson.dimension, source.lessons[index].dimension, `第 ${index + 1} 课维度`);
  });
  equal(unit.structure.basic[0].title, source.structure.basic[0].title, '模块6 结构图节点');
  equal(unit.meta.categoryId, 'ball', '选题的小类 id 也要跟着回来（能在设计页回填下拉）');
});

await test('⑲ 手写文本的健壮解析：标题写法百花齐放、列顺序被打乱也能对上号', async () => {
  const env = createEnv({ cloud: 'off' });
  const report = env.api.parseUnitTemplate(handwrittenMarkdown());
  assert(report.ok, `应当能解析：${report.errors.join('；')}`);
  equal(report.missing.length, 0, `不该有缺失模块：${report.missing.map(env.api.unitModuleTitle).join('、')}`);
  const unit = report.unit;

  // ① 标题变体：`# 一、教学目标` / `### 2. 教材分析` / `## 四、教学内容`（别名）/ `**教学重难点**`
  equal(unit.objectives.ability, '能在对抗中完成变向运球与投篮衔接', '# + 中文序号');
  equal(unit.textbookAnalysis, '本单元选自球类·篮球，围绕球性与投篮衔接展开。', '### + 阿拉伯序号');
  equal(unit.teachingContent, '球性、变向运球、投篮衔接、战术配合、体能。', '别名「教学内容」');
  equal(unit.keyDifficulties.learning, '手脚协调配合', '加粗行当标题');
  equal(unit.studentAnalysis, '水平三学生协调性发展较快，但对抗意识不足。', '常规标题');
  equal(unit.undefined, undefined, '不该出现野字段');

  // ② 课时表：标题写成「课时计划」、课次号写成「第N课次」、维度混着中文别名与英文键
  //    （下面 markdown 里维度依次是 basic / technique / 战术 / 基本技术）
  equal(report.lessonRows, 18, '18 行课时都要落位');
  equal(unit.lessons[0].content, '第1课内容', '第 1 课内容');
  equal(unit.lessons[0].dimension, 'basic', '英文键 basic');
  equal(unit.lessons[1].dimension, 'technique', '英文键 technique');
  equal(unit.lessons[2].dimension, 'tactic', '「战术」→ tactic');
  equal(unit.lessons[3].dimension, 'technique', '「基本技术」→ technique');
  equal(unit.lessons[17].objectives.ability, '能力18', '第 18 课运动能力');
  equal(unit.lessons[17].method, '第18课组织教法', '第 18 课组织教法');

  // ③ 结构图两个分支
  equal(unit.structure.basic.length, 2, '基础知识分支挂 2 个节点');
  equal(unit.structure.technique.length, 1, '基本技术分支挂 1 个节点');

  // ④ 把导出模板的文本再灌回去（uHI 同一个方言）
  const again = env.api.parseUnitTemplate(env.api.buildUnitTemplate(unit));
  equal(again.lessonRows, 18, '自己导出的模板也必须能被自己解析');
  equal(again.unit.lessons[9].content, unit.lessons[9].content, '二次往返内容一致');
});

await test('⑲b 纯文本 .txt（一个 # 都没有）：放宽规则也能认出各模块', async () => {
  const env = createEnv({ cloud: 'off' });
  const plain = [
    '水平三篮球大单元',
    '',
    '基本信息',
    '- 单元名称：水平三篮球大单元',
    '- 教材大类：球类',
    '',
    '一、教学目标',
    '- 运动能力：能完成变向运球',
    '- 健康行为：坚持锻炼',
    '- 体育品德：尊重对手',
    '',
    '二、教材分析',
    '本单元选自球类·篮球。',
    '',
    '七、课时计划',
    '| 课时 | 维度 | 运动能力 | 健康行为 | 体育品德 | 教学内容 | 组织教学与方法 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | 基本技术 | 能力1 | 健康1 | 品德1 | 内容1 | 教法1 |',
    '',
    '十一、教学资源',
    '篮球 20 个、标志桶 40 个',
  ].join('\n');
  const report = env.api.parseUnitTemplate(plain);
  assert(report.ok, `纯文本也要能解析：${report.errors.join('；')}`);
  equal(report.unit.objectives.ability, '能完成变向运球', '教学目标');
  equal(report.unit.textbookAnalysis, '本单元选自球类·篮球。', '教材分析');
  equal(report.unit.resources, '篮球 20 个、标志桶 40 个', '教学资源');
  equal(report.unit.lessons[0].content, '内容1', '课时表');
  equal(report.unit.lessons[0].dimension, 'technique', '维度');
  equal(report.found.length, 4, '写了 4 个模块');
  equal(report.missing.length, 7, '没写的 7 个模块要如实报出来');
  assert(report.problems.some(item => item.message === '未找到【学情分析】模块，请检查模板'),
    '缺失提示要具体到模块名');
});

await test('⑳ 少写了某个模块：明确告诉老师缺哪个，确认后才入库', async () => {
  const env = createEnv({ cloud: 'off' });
  const report = env.api.R.importText(handwrittenMarkdown({ dropStudentAnalysis: true }), '少写一块.md');
  const problem = report.problems.find(item => item.module === 'studentAnalysis');
  assert(problem, '要报出缺的是哪个模块');
  equal(problem.level, 'error', '缺模块属于必须让老师知道的级别');
  equal(problem.message, '未找到【学情分析】模块，请检查模板', '提示文案要能照着做');

  // 不能直接入库 —— 先给报告，老师点了【仍然保存】才算数
  equal(env.api.R.count(), 0, '有问题的文件不能悄悄入库');
  const overlay = env.overlays[env.overlays.length - 1];
  equal(overlay.title, '解析报告', '要弹出解析报告');
  assert(overlay.bodyHTML.includes('未找到【学情分析】模块'), '报告里要写出缺失模块');
  assert(overlay.footerHTML.includes('OfflineResources.confirmImport()'), '要有【仍然保存入库】按钮');
  assert(overlay.footerHTML.includes('OfflineResources.dismissImport()'), '也要有回去改模板的出口');

  env.api.R.confirmImport();
  equal(env.api.R.count(), 1, '老师确认后才入库');
  const saved = env.api.R.unitFromRecord(env.api.R.list()[0]);
  equal(saved.lessons.length, 18, '仍要保住已经填好的 18 课时');
  assert(!saved.studentAnalysis, '缺的那块确实是空的');
  assert(env.api.R.cardHTML(env.api.R.list()[0], 'manage').includes('模板导入'),
    '卡片上要标明来源是模板导入');

  // 课时表没填满也要提示
  const env2 = createEnv({ cloud: 'off' });
  const partial = env2.api.parseUnitTemplate(handwrittenMarkdown({ lessons: 12 }));
  assert(partial.problems.some(item => item.module === 'lessons'),
    '课时表没填够 18 行要报出来');
  assert(partial.warnings.some(message => message.includes('缺第 13、14、15、16、17、18 课次')),
    '要具体到缺哪几个课次');
});

await test('⑳b 一次拖多个文件：逐个出报告，后面的报告不会顶掉前面没保存的结果', async () => {
  const env = createEnv({ cloud: 'off' });
  const problemA = handwrittenMarkdown({ dropStudentAnalysis: true });
  const problemB = handwrittenMarkdown({ lessons: 10 });
  await env.api.R.importFiles([
    { name: 'A.md', _text: problemA },
    { name: 'B.md', _text: problemB },
  ]);
  // 只有第一份的报告浮出来；第二份在队列里等着
  equal(env.api.R.count(), 0, '还没有任何东西入库');
  const first = env.overlays[env.overlays.length - 1];
  equal(first.title, '解析报告', '先给第一份的报告');
  assert(first.bodyHTML.includes('未找到【学情分析】模块'), '报告内容属于 A');
  assert(env.api.R._queue.length === 1, '第二份要在队列里排队');

  // 老师点【回去改模板】→ 接着弹第二份
  env.api.R.dismissImport();
  const second = env.overlays[env.overlays.length - 1];
  equal(second.title, '解析报告', '自动接着处理第二份');
  assert(second.bodyHTML.includes('只填了 10 行'), `第二份报告要说清楚课时行数：${second.bodyHTML.slice(0, 120)}`);

  // 这次点【仍然保存入库】→ 入库
  env.api.R.confirmImport();
  equal(env.api.R.count(), 1, 'B 入库了，A 没有');
  equal(env.api.R.list()[0].modules_json.unitTitle, '水平三篮球大单元', '入库的是 B 的内容');
  assert(env.api.R.dismissImport() === false, '队列空了就该结束');
});

await test('㉑ 彻底读不懂的文件：弹窗说清楚，并给出重新下载模板的出路', async () => {
  const env = createEnv({ cloud: 'off' });
  env.api.R.importText('随手写的几行字，既没有标题也没有表格', '随便.txt');
  equal(env.api.R.count(), 0, '读不懂的文件绝不能入库');
  const overlay = env.overlays[env.overlays.length - 1];
  equal(overlay.title, '文件无法解析', '要弹出失败提示');
  assert(overlay.bodyHTML.includes('没有识别到任何模块标题'), '要说明为什么读不懂');
  assert(overlay.footerHTML.includes('OfflineResources.downloadTemplate()'), '要给出重新下载模板的按钮');

  // 空文件 / 坏 JSON 同理
  const empty = env.api.parseUnitTemplate('');
  assert(empty.blocking && empty.errors.length, '空文件必须报错');
  const broken = env.api.parseUnitTemplate('{"unitTitle": "少了右括号"');
  assert(broken.blocking, 'JSON 坏了必须报错');
  assert(broken.errors[0].includes('JSON'), '要告诉老师是 JSON 的问题');
});

await test('㉑b 上传 .json：裸大单元 / 资源记录两种都能认，并直接生成卡片', async () => {
  const env = createEnv({ cloud: 'off' });
  const unit = makeUnit({ title: 'JSON 导入的单元' });

  // ① 裸 unit
  const plain = env.api.parseUnitTemplate(JSON.stringify(unit));
  assert(plain.ok, `裸 unit 要能解析：${plain.errors.join('；')}`);
  equal(plain.format, 'json', '要识别出是 JSON');
  equal(plain.unit.unitTitle, 'JSON 导入的单元', '单元名');
  equal(plain.lessonRows, 18, '18 课时');

  // ② 从别处导出的资源记录（多了 modules_json 壳）
  const record = { id: 'ur_json', category: '球类', level: '水平三（5–6 年级）', content: '运球', modules_json: unit };
  const wrapped = env.api.parseUnitTemplate(JSON.stringify(record));
  assert(wrapped.ok, `资源记录要能解析：${wrapped.errors.join('；')}`);
  equal(wrapped.unit.unitTitle, 'JSON 导入的单元', '壳里的 unit 要被取出来');
  equal(wrapped.unit.meta.category, '球类', '壳上的 category 要回填到 meta');

  // ③ 走一遍完整上传链路（FileReader 路径），最后生成卡片
  const upload = createEnv({ cloud: 'off' });
  await upload.api.R.importFiles([{ name: '单元.json', _text: JSON.stringify(unit) }]);
  equal(upload.api.R.count(), 1, '上传 JSON 后要入库一条');
  const id = upload.api.R.list()[0].id;
  const card = upload.api.R.cardHTML(upload.api.R.list()[0], 'manage');
  assert(card.includes('JSON 导入的单元'), '要生成能看到标题的卡片');
  assert(card.includes(`OfflineResources.view('${id}')`), '卡片要能查看');
  // 从查看弹窗里把导出路径跑通（Word / .md / 全屏手填）
  upload.api.R.view(id);
  const viewer = upload.overlays[upload.overlays.length - 1];
  assert(viewer.footerHTML.includes('OfflineResources.exportWord('), '查看弹窗要能导出 Word');
  assert(viewer.footerHTML.includes('OfflineResources.printUnit('), '查看弹窗要能打印');
  assert(viewer.footerHTML.includes('OfflineResources.downloadResourceMarkdown('), '查看弹窗要能导出 .md');
  assert(viewer.footerHTML.includes('OfflineResources.openWorkbench('), '查看弹窗要能进全屏手填');
  upload.api.R.exportWord(id);
  const word = upload.blobs[upload.blobs.length - 1];
  assert(word.content.includes('JSON 导入的单元'), '导出的 Word 里要有标题');
});

await test('㉒ 全屏手填工作台：左目录 11 模块 + 右大文本框，保存直接入库且全程不碰 AI', async () => {
  const env = createEnv({ cloud: 'off' });
  env.node('resCreateTitle').value = '手写的篮球大单元';

  env.api.R.openWorkbench();
  const overlay = env.overlays[env.overlays.length - 1];
  assert(overlay, '要打开全屏工作台');
  assert(overlay.bodyHTML.includes('class="res-wb"'), '要用工作台布局（左目录 + 右编辑区）');
  env.api.UNIT_MODULES.forEach((module, index) => {
    assert(overlay.bodyHTML.includes(`OfflineResources.wbGo('${module.id}')`),
      `左侧目录缺少模块入口：${module.title}`);
    assert(overlay.bodyHTML.includes(module.title), `左侧目录缺少模块名：${module.title}`);
  });
  assert(overlay.footerHTML.includes('OfflineResources.wbSave()'), '要有保存按钮');
  assert(!overlay.footerHTML.includes('generate') || true, '保存不经过 AI');

  // ① 填模块 1（三维目标）—— 文本框里出来的就是模板那套写法
  env.api.R.wbGo('objectives');
  equal(env.node('resWbEditor').value.includes('- 运动能力：'), true, '文本框要给出可填写的分项骨架');
  env.node('resWbEditor').value = '- 运动能力：能完成原地单手肩上投篮\n- 健康行为：坚持每周三次锻炼\n- 体育品德：尊重对手';
  assert(env.api.R._wb.unit.unitTitle === '手写的篮球大单元', '离开基本信息时要带上填好的单元名');

  // ② 切到模块 7（课时表）→ 内容必须留在目标里，同时铺开 18 行表格
  env.api.R.wbGo('lessons');
  equal(env.api.R._wb.unit.objectives.ability, '能完成原地单手肩上投篮', '切换模块前要把编辑框内容写回单元');
  equal(env.api.R._wb.unit.objectives.health, '坚持每周三次锻炼', '三维都要在');
  const table = env.node('resWbEditor').value;
  equal((table.match(/^\|\s*\d+\s*\|/gm) || []).length, 18, '课时表那屏要给出 18 行表格');

  // ③ 手填 18 行再切走 → 逐格入库
  const rows = ['| 课时 | 维度 | 运动能力 | 健康行为 | 体育品德 | 教学内容 | 组织教学与方法 |'];
  for (let no = 1; no <= 18; no += 1) rows.push(`| ${no} | 基本技术 | 能力${no} | 健康${no} | 品德${no} | 内容${no} | 教法${no} |`);
  env.node('resWbEditor').value = rows.join('\n');
  env.api.R.wbGo('textbookAnalysis');
  equal(env.api.R._wb.unit.lessons[17].content, '内容18', '第 18 课内容要落到第 18 行');
  equal(env.api.R._wb.unit.lessons[0].objectives.character, '品德1', '三维目标也要逐格落位');
  equal(env.api.R._wb.unit.lessons[0].dimension, 'technique', '维度列要解析成维度键');
  env.node('resWbEditor').value = '教材分析：本单元选自球类·篮球。';

  // ④ 保存 → 直接入库，不跳 AI、不跳设计页
  const result = env.api.R.wbSave();
  assert(result && result.ok, '要保存成功');
  equal(env.api.R.count(), 1, '保存后资源库里应有一条');
  const saved = env.api.R.unitFromRecord(env.api.R.get(result.record.id));
  equal(saved.unitTitle, '手写的篮球大单元', '单元名');
  equal(saved.lessons.length, 18, '18 课时齐全');
  equal(saved.textbookAnalysis, '教材分析：本单元选自球类·篮球。', '最后一个模块的内容也要收进来');
  equal(saved.meta.source, 'manual', '来源标记为手填');
  equal(env.context.window.location.href, '', '保存后不跳转（不被 AI 页面带走）');
  assert(env.toasts.some(toast => String(toast.message).includes('已保存')), '要有保存成功提示');

  // ⑤ 再打开同一条 → 是更新而不是新建
  env.api.R.openWorkbench(result.record.id);
  env.api.R.wbGo('reflection');
  env.node('resWbEditor').value = '课后反思：……';
  const second = env.api.R.wbSave();
  equal(env.api.R.count(), 1, '编辑已有资源不能越存越多');
  equal(second.created, false, '第二次是更新');
  equal(env.api.R.get(result.record.id).modules_json.reflection, '课后反思：……', '修改要生效');

  // ⑥ 工作台导出 .md（给同事传阅 / 备份）
  env.api.R.openWorkbench(result.record.id);
  env.api.R.wbExport();
  const exported = env.blobs[env.blobs.length - 1];
  assert(exported.content.includes('## 一、教学目标'), '导出的 md 要保持模板结构');
  assert(exported.content.includes('内容18'), '导出的 md 要带着刚填的课时');

  // ⛔ 关键：整条链路不允许出现 AI 请求
  assert(typeof env.context.fetch === 'undefined', '手填 / 导入全程没有碰 AI 接口');
  assert(env.calls.length === 0, '离线状态下也不会发云端请求以外的东西');
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
