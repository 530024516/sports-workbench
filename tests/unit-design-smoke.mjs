/**
 * 大单元设计模块回归测试（node tests/unit-design-smoke.mjs）
 *
 * 覆盖三块：
 *   ① js/unit-catalog.js   —— 教材/水平/教学内容字典的结构完整性与"不编造"约束
 *   ② lib/ai-core.js       —— 一键生成的请求体：10 个模块要求、18 课时、足够大的 max_tokens
 *   ③ js/unit-design.js    —— 页面逻辑（存取对错句/DOM，用 vm + 假 DOM 加载后直接调函数）
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  buildUnitRequest, buildUpstreamRequestBody, UNIT_STAGE_MAX_TOKENS, UNIT_LESSON_CHUNK, UNIT_LESSON_BATCHES,
  unitContextBrief, unitDimensionStats, unitDimensionQuota, unitLessonPlan, UNIT_DIMENSION_BRANCH,
  UNIT_FORMAT_ANALYSIS, UNIT_FORMAT_ANALYSIS_PART1, UNIT_FORMAT_ANALYSIS_PART2,
  UNIT_FORMAT_LESSONS, UNIT_FORMAT_RUBRIC, UNIT_BACKEND_VERSION,
} = require(path.join(ROOT, 'lib/ai-core.js'));
const { repairTruncatedJSON } = require(path.join(ROOT, 'js/json-repair.js'));
const catalog = require(path.join(ROOT, 'js/unit-catalog.js'));
const model = require(path.join(ROOT, 'js/unit-model.js'));

const UNIT_SELECTION = {
  category: '球类', item: '篮球',
  level: '水平三（5–6 年级）', topic: '行进间变向运球、急停急起与运球投篮衔接',
};

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

console.log('\n🧪 大单元设计模块回归测试\n');

/* ================= ① 映射字典 ================= */

await test('① 字典覆盖课标六大类，且每个细项在每个水平都有可选教学内容', async () => {
  const labels = catalog.UNIT_CATALOG.map(category => category.label);
  ['球类', '田径类', '体操类', '中华传统体育类', '新兴体育类', '水上或冰雪类'].forEach(label => {
    assert(labels.includes(label), `缺少教材大类：${label}`);
  });
  equal(catalog.UNIT_LEVELS.length, 4, '水平必须是水平一至四');
  const empty = [];
  catalog.UNIT_CATALOG.forEach(category => category.items.forEach(item => {
    catalog.UNIT_LEVELS.forEach(level => {
      if (!catalog.listUnitTopics(item.id, level.id).length) empty.push(`${item.label}/${level.label}`);
    });
  }));
  assert(empty.length === 0, `这些组合没有任何教学内容：${empty.join('、')}`);
});

await test('② 无法确认的条目统一以 [待确认] 标注，且没有编造的乱码', async () => {
  let total = 0;
  let pending = 0;
  const garbage = [];
  catalog.UNIT_CATALOG.forEach(category => category.items.forEach(item => {
    catalog.UNIT_LEVELS.forEach(level => catalog.listUnitTopics(item.id, level.id).forEach(topic => {
      total += 1;
      if (catalog.isUnitTopicPending(topic)) pending += 1;
      if (/[A-Za-z]{3,}/.test(topic) && !topic.includes('Spirit of the Game')) garbage.push(topic);
    }));
  }));
  assert(pending > 0, '应当存在 [待确认] 条目（场馆/条件依赖的条目不能假装确定）');
  equal(garbage.length, 0, `存在疑似乱码条目：${garbage.join(' | ')}`);
  console.log(`     （共 ${total} 条教学内容，其中 [待确认] ${pending} 条）`);
});

await test('③ 三级联动查询行为正确', async () => {
  equal(catalog.listUnitTopics('basketball', 'L1').length > 0, true, '篮球/水平一应有条目');
  equal(catalog.listUnitTopics('basketball', 'xxxx').length, 0, '未知水平返回空');
  equal(catalog.listUnitTopics('不存在的项目', 'L1').length, 0, '未知细项返回空');
  equal(catalog.unitLevelLabel('L3'), '水平三（5–6 年级）', '水平显示名正确');
  equal(catalog.findUnitCatalogItem('swimming').category.label, '水上或冰雪类', '细项能反查所属大类');
});

/* ================= ② AI 请求构建 ================= */

await test('④ 阶段① 模块 1–5：改成【纯文本】输出（拒绝 JSON），结构图与课时表交给独立请求', async () => {
  // 前置分析已彻底拆成两段请求：任一段被截断，另一段照样能落地
  const stage1 = buildUnitRequest({ ...UNIT_SELECTION, stage: 'analysis_part1', itemId: 'basketball', levelId: 'L3' });
  const stage1b = buildUnitRequest({ ...UNIT_SELECTION, stage: 'analysis_part2', itemId: 'basketball', levelId: 'L3' });
  assert(!stage1.error, `阶段① 不应报错：${stage1.error?.message}`);
  assert(!stage1b.error, `阶段①b 不应报错：${stage1b.error?.message}`);
  equal(stage1.stage, 'analysis_part1', '阶段标记要回传，便于前端确认自己在跑哪一步');
  equal(stage1b.stage, 'analysis_part2', '第二段阶段标记也要回传');
  equal(stage1.meta.format, 'text', '阶段① 要标明走纯文本');
  equal(stage1b.meta.format, 'text', '阶段①b 要标明走纯文本');
  equal(stage1.response_format, undefined, '阶段① 绝不能再要求 JSON 输出（长文本用 JSON 包裹必被截断）');
  equal(stage1b.response_format, undefined, '阶段①b 绝不能再要求 JSON 输出');
  // max_tokens 要设大，留足空间（截断的根因就是输出上限）
  assert(stage1.max_tokens >= 6144, `阶段① 的 max_tokens 要够大（实际 ${stage1.max_tokens}）`);
  assert(stage1b.max_tokens >= 6144, `阶段①b 的 max_tokens 要够大（实际 ${stage1b.max_tokens}）`);

  const prompt1 = stage1.messages[1].content;
  const prompt1b = stage1b.messages[1].content;
  // 第一段只写模块 1–3
  ['===TITLE===', '===OBJECTIVES===', '===TEXTBOOK===', '===STUDENTS===']
    .forEach(marker => assert(prompt1.includes(marker), `阶段① prompt 缺少分隔符：${marker}`));
  ['===CONTENT===', '===DIFFICULTIES==='].forEach(marker =>
    assert(prompt1b.includes(marker), `阶段①b prompt 缺少分隔符：${marker}`));
  assert(!prompt1.includes('===CONTENT==='), '第一段不该出现模块 4 的分隔符');
  assert(!prompt1b.includes('===OBJECTIVES==='), '第二段不该出现模块 2 的分隔符');
  [
    '运动能力', '教材分析', '学情分析', '主要教学内容',
    '学生学习重难点', '学习内容重难点', '教学组织重难点', '教学方法重难点',
    '重点：', '难点：',
  ].forEach(keyword => assert((prompt1 + prompt1b).includes(keyword), `阶段① prompt 缺少要求：${keyword}`));
  assert(prompt1.includes('不要输出 JSON'), '阶段① 必须明确禁止输出 JSON');
  assert(!prompt1.includes('JSON 结构'), '阶段① 不该再贴 JSON 模板');
  assert(!prompt1.includes('"lessons"'), '阶段① 绝不能让 AI 同时吐 18 课时表（那正是被截断的原因）');
  // 篇幅要求：每段 ≤ 800 字（拆得越碎越不会被截断）
  assert(prompt1.replace(/\s/g, '').includes('≤800字'), '阶段① 要写明每段 ≤ 800 字');
  assert(prompt1b.replace(/\s/g, '').includes('≤800字'), '阶段①b 要写明每段 ≤ 800 字');
  assert(!prompt1.includes('3000–4500'), '前置分析已拆两段，不再要求 3000+ 字');
  // Few-shot：运动能力六件事 + 教材两段 + 重难点"原因 + 应对措施"
  ['积极参与', '知道', '能够说出', '学练', '国家学生体质健康标准', '观看']
    .forEach(keyword => assert(prompt1.includes(keyword), `阶段① Few-shot 缺少要素：${keyword}`));
  ['原因是', '应对措施是'].forEach(keyword => assert(prompt1b.includes(keyword), `阶段①b Few-shot 缺少要素：${keyword}`));
  assert(prompt1.includes('范文示例'), '阶段① 要给出 Few-shot 范文');
  assert(prompt1b.includes('范文示例'), '阶段①b 要给出 Few-shot 范文');
  // 系统提示词也要换成纯文本版
  assert(!stage1.messages[0].content.includes('合法 JSON 对象'), '纯文本阶段的系统提示词不能要求 JSON');
  assert(stage1.messages[0].content.includes('纯文本'), '纯文本阶段的系统提示词要说明输出格式');
});

await test('④a 阶段② 结构图（模块 6）：严格照 18 课次计划表输出', async () => {
  const stage2 = buildUnitRequest({ ...UNIT_SELECTION, stage: 'structure', itemId: 'basketball', levelId: 'L3' });
  assert(!stage2.error, `结构图阶段不应报错：${stage2.error?.message}`);
  equal(stage2.response_format?.type, 'json_object', '结构图阶段必须要求 JSON 输出');
  const prompt2 = stage2.messages[1].content;
  assert(prompt2.includes('必须恰好 18 项'), '结构图节点必须恰好 18 个');
  assert(prompt2.includes('id 从 1 到 18'), '结构图节点的 id 必须是 1–18');
  assert(prompt2.includes('基础知识 / 基本技术 / 技战术运用 / 展示或比赛'), 'dimension 只能是四条泳道');
  assert(prompt2.includes('18 课次计划表'), '结构图阶段要给出排定的 18 课次计划表');
  ['第1课次｜', '第18课次｜'].forEach(mark => assert(prompt2.includes(mark), `计划表缺少课次：${mark}`));
  assert(prompt2.includes('结构图节点必须严格照此输出'), '结构图必须严格照计划表');
  assert(!prompt2.includes('"lessons"'), '结构图阶段不该吐课时表');
  assert(stage2.max_tokens <= 3072, `结构图阶段的 max_tokens 要压小（实际 ${stage2.max_tokens}）`);
});

await test('④b 阶段③④⑤：收尾（8–10）、课时表（18 批 × 1 课时）、评价量规（11）各自独立', async () => {
  // ③ closing：模块 8–10
  const closing = buildUnitRequest({ ...UNIT_SELECTION, stage: 'closing', itemId: 'basketball', levelId: 'L3' });
  assert(!closing.error, `收尾阶段不应报错：${closing.error?.message}`);
  const closingPrompt = closing.messages[1].content.replace(/\s/g, '');
  ['assessment', 'reflection'].forEach(field => {
    assert(closingPrompt.includes(field), `收尾阶段 prompt 缺少字段：${field}`);
  });
  assert(!closingPrompt.includes('"rubric"'), '评价量规是独立请求，收尾阶段的 schema 里不该出现 rubric');
  assert(closingPrompt.includes('整个JSON≤900字'), '收尾阶段要有严格的字数上限');
  assert(closing.max_tokens <= 3072, `收尾阶段的 max_tokens 要压小（实际 ${closing.max_tokens}）`);

  // ④ rubric：模块 10（纯文本 + Markdown 表格）
  const rubric = buildUnitRequest({ ...UNIT_SELECTION, stage: 'rubric', itemId: 'basketball', levelId: 'L3' });
  assert(!rubric.error, `评价量规阶段不应报错：${rubric.error?.message}`);
  equal(rubric.meta.format, 'text', '评价量规阶段要走纯文本');
  equal(rubric.response_format, undefined, '评价量规阶段绝不能再要求 JSON 输出');
  const rubricPrompt = rubric.messages[1].content;
  ['===RUBRIC===', '===WEIGHTS===', '===SCORES===']
    .forEach(marker => assert(rubricPrompt.includes(marker), `评价量规 prompt 缺少分隔符：${marker}`));
  assert(rubricPrompt.includes('| 等级 | 分值 | 运动能力 | 健康行为 | 体育品德 |'),
    '评价量规 prompt 要给出等级表的表头');
  assert(rubricPrompt.includes('不要输出 JSON'), '评价量规必须明确禁止输出 JSON');
  assert(!rubricPrompt.includes('"lessons"'), '评价量规阶段不该吐课时表');
  assert(rubric.max_tokens <= 3072, `评价量规阶段的 max_tokens 要压小（实际 ${rubric.max_tokens}）`);

  // 智谱请求必须恒开 stream（流式才能边收边看，也是截断检测的前提）
  const source = fs.readFileSync(path.join(ROOT, 'lib/ai-core.js'), 'utf8');
  assert(/stream:\s*true/.test(source), '请求智谱必须开启 stream: true');

  // 18 个课时：每次只写 1 个课时（纯文本 + 一行 Markdown 表格）
  equal(UNIT_LESSON_BATCHES.length, 18, '18 课时必须拆成 18 批（一次只写一个课时）');
  UNIT_LESSON_BATCHES.forEach(([from, to]) => {
    const batch = buildUnitRequest({
      ...UNIT_SELECTION, stage: 'lessons', itemId: 'basketball', levelId: 'L3', startLesson: from, endLesson: to,
    });
    equal(batch.meta.from, from, '批次起点要回传');
    equal(batch.meta.to, to, '批次终点要回传');
    equal(batch.meta.count, 1, '每批只有 1 个课时');
    equal(batch.meta.format, 'text', '课时阶段要走纯文本（Markdown 表格）');
    equal(batch.response_format, undefined, '课时阶段绝不能再要求 JSON 输出');
    assert(batch.max_tokens <= 2048, `课时表批次的 max_tokens 要压小（实际 ${batch.max_tokens}）`);
    const prompt = batch.messages[1].content;
    // ⚠️ 维度不再由 AI 输出（它会照抄成 "===DIMENSION===\ntechnique"，把课时行解析带偏）：
    //    维度改由系统排定 —— prompt 里只作为【输入】告诉模型，输出端由前端按计划表回填。
    assert(!prompt.includes('===DIMENSION==='), '课时阶段不该再要求 AI 输出维度分隔符（维度由系统排定）');
    assert(prompt.includes('本课次维度（系统排定'), '课时阶段要把这一课的维度作为输入告诉模型');
    assert(prompt.includes('不要写任何维度字段名或分隔标记'), '课时阶段要明确禁止输出维度相关内容');
    assert(prompt.includes('| 课次 | 学习目标 | 主要学习内容 | 教学策略 |'), '要给出 4 列表头');
    assert(prompt.includes('不要输出 JSON'), '必须明确禁止输出 JSON');
    // 字数封印已解除：一次只写 1 个课时，不怕截断，反过来要求写细写足
    assert(prompt.includes('120–180 字'), '每一格都要写 120–180 字的完整教学段落');
    assert(!prompt.includes('每段不超过 20 字'), '不能再有 20 字上限（那会让教案干瘪）');
    assert(!prompt.includes('每段不超过 50 字'), '不能再有 50 字上限（那会让教案干瘪）');
    assert(prompt.includes('50–70 字'), '学习目标三段每段 50–70 字');
    assert(prompt.includes('30–40 字'), '内容与策略的每个要素 30–40 字');
    assert(prompt.includes('Markdown 有序列表'), '内容与策略要按 Markdown 列表逐项写');
    ['【学习目标】', '【主要学习内容】', '【教学策略 / 学练活动】'].forEach(title =>
      assert(prompt.includes(title), `要写死单元格小标题：${title}`));
    ['热身小游戏', '技术学练', '展示与比赛', '体能练习'].forEach(key =>
      assert(prompt.includes(key), `主要学习内容四要素缺少：${key}`));
    ['情境导入', '教与学的方法', '比赛活动', '教学评价'].forEach(key =>
      assert(prompt.includes(key), `教学策略四要素缺少：${key}`));
    assert(prompt.includes(`第${from}课次`), '要写明本批的课次号');
    assert(prompt.includes('<br>'), '要写明单元格内用 <br> 换行');
    assert(prompt.includes(`第${from}课次｜`), '批次要带本批课次计划表');
  });
});
await test('⑤ 选题不全 / 超长输入 / 未知阶段都给出明确报错', async () => {
  equal(buildUnitRequest({ stage: 'analysis', category: '球类', item: '', level: '水平二', topic: '运球' }).error?.status, 400, '缺细项应报 400');
  equal(buildUnitRequest({ ...UNIT_SELECTION, stage: 'rubric', topic: 'x'.repeat(200) }).error?.status, 400, '超长应报 400');
  equal(buildUnitRequest({ ...UNIT_SELECTION, stage: '第3阶段' }).error?.status, 400, '未知阶段应报 400');
  assert(buildUnitRequest({ stage: 'closing', category: '球类', item: '篮球', level: '水平二', topic: '运球', topicPending: true })
    .messages[1].content.includes('待确认'), '待确认条目要提示 AI 保留替代方案');
});

/* ================= ③ 页面逻辑（假 DOM） ================= */

function createUnitEnv() {
  const nodes = new Map();
  const makeNode = id => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, className: '',
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, querySelector: () => null, addEventListener() {},
  });
  const overlays = [];
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
    body: null,
  };
  const win = {
    confirm: () => true,
    addEventListener() {},
    dispatchEvent() {},
  };
  const toasts = [];
  const context = vm.createContext({
    document: documentStub,
    window: win,
    console,
    TextDecoder,                    // 页面读 SSE 流时需要
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    Layout: { init() {} },
    Store: {
      read: () => null,
      write: (key, value, options) => {
        context.__saved = { key, value, options };
        if (!Array.isArray(context.__writes)) context.__writes = [];
        context.__writes.push({ key, value, options });
      },
      onReady: callback => callback('local'),
    },
    setTimeout,
    clearTimeout,
    showToast: (message, type) => toasts.push({ message, type }),
    showModal: (title, bodyHTML, footerHTML) => {
      const overlay = {
        title, bodyHTML, footerHTML,
        remove() { const index = overlays.indexOf(overlay); if (index >= 0) overlays.splice(index, 1); },
      };
      overlays.push(overlay);
      return overlay;
    },
    closeModal: () => { overlays.length = 0; },
  });
  context.globalThis = context;
  // 按页面里的 <script> 顺序注入：模型 → 字典 → JSON 修复 → 页面脚本
  ['js/unit-model.js', 'js/unit-catalog.js', 'js/json-repair.js', 'js/unit-design.js'].forEach(file => {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  });
  new vm.Script(`globalThis.__api = {
    createEmptyUnit, normalizeUnit, loadUnitData, migrateLegacyUnit, applyGeneratedUnit,
    renderUnitModules, renderUnitModuleBody, autoFixStructure, unitMatrixDrawLinks,
    normalizeStructureNodes, normalizeMainProjects, unitMatrixDimensionLabel, unitMatrixDimensionId,
    buildUnitStructureMatrixHTML, recoverPartialUnitJSON,
    populateUnitSelectors, currentUnitSelection, onUnitCategoryChange, onUnitLevelChange, refreshUnitTopics,
    // 分步生成
    generateWholeUnit, generateLessonTableOnly, mergeUnitStage, unitStageContext,
    unitMissingLessonNumbers, unitMissingRanges, unitTailMissing, requestUnitStage, closeUnitModals,
    // 课次-维度计划表（前端版，用于和后端对账）
    unitLessonPlanFor, unitCurrentLessonPlan, unitDimensionQuotaFor, unitDimensionStatsFor,
    unitCheckBackendVersion, UNIT_CLIENT_VERSION,
    // 空壳防线 / 保存链路
    unitSavePayload, saveUnitData, unitPayloadFilledModules, syncUnitKeyWithResource,
    UNIT_SAVE_LIVE_FIELDS, UNIT_STORAGE_KEY,
    // 下面几个在 unit-model.js 里以「接收 unit」的纯函数形态存在，这里绑到页面的 unitData 上
    missingStructureNumbers: () => missingStructureNumbers(unitData),
    buildUnitExportHTML: () => buildUnitExportHTML(unitData),
    unitModuleCompleted: (id = 'objectives') => unitModuleCompleted(unitData, id),
    getUnit: () => unitData, setUnit: value => { unitData = value; },
    UNIT_MODULES,
  };`, { filename: 'extract.js' }).runInContext(context);
  return {
    context, api: context.__api, nodes, win, overlays, toasts,
    node: id => documentStub.getElementById(id),
  };
}

/* ---------- 假 AI 服务：把每次请求记下来，并按脚本返回 SSE 流 ---------- */

function selectUnitTopic(env) {
  env.api.populateUnitSelectors();
  env.node('ud2Category').value = 'ball';
  env.api.onUnitCategoryChange();
  env.node('ud2Item').value = 'basketball';
  env.node('ud2Level').value = 'L3';
  env.api.onUnitLevelChange();
}

/** 把一段文本切成 SSE 帧的 ReadableStream 替身（可选在末尾追加 truncated 事件） */
function fakeStream(content, { truncate = false } = {}) {
  const frames = String(content).match(/[\s\S]{1,300}/g) || [];
  const encoder = new TextEncoder();
  let index = 0;
  let finished = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (index < frames.length) {
            const piece = frames[index];
            index += 1;
            return { value: encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`), done: false };
          }
          if (truncate && !finished) {
            finished = true;
            return { value: encoder.encode(`event: truncated\ndata: ${JSON.stringify({ warning: '达到输出上限' })}\n\n`), done: false };
          }
          return { value: undefined, done: true };
        },
        cancel: async () => {},
      }),
    },
  };
}

/** 纯文本版的前置分析 · 第一段（analysis_part1：模块 1–3） */
function analysisPart1Payload() {
  return `===TITLE===
水平三篮球大单元

===OBJECTIVES===
1.运动能力：阶段一能力目标
2.健康行为：阶段一健康目标
3.体育品德：阶段一品德目标

===TEXTBOOK===
阶段一教材分析内容

===STUDENTS===
阶段一学情分析内容`;
}

/** 纯文本版的前置分析 · 第二段（analysis_part2：模块 4–5） */
function analysisPart2Payload() {
  return `===CONTENT===
阶段一教学内容内容

===DIFFICULTIES===
学生学习重难点：重点：阶段一学重点 难点：阶段一学难点
学习内容重难点：重点：阶段一内重点 难点：阶段一内难点
教学组织重难点：重点：阶段一org重点 难点：阶段一org难点
教学方法重难点：重点：阶段一法重点 难点：阶段一法难点`;
}

/** 兼容：一次拿全两段 */
function analysisTextPayload() {
  return `${analysisPart1Payload()}

${analysisPart2Payload()}`;
}

/** 纯文本版的单课时（lesson_single 阶段：一行管道分隔的纯文本，不是 JSON、不是表格） */
function lessonSinglePayload(no, dimension = 'technique') {
  return `第${no}课次 | 学习目标：【学习目标】<br>运动能力：阶段二能力${no}，能在对抗中完成急停急起变向运球。<br>健康行为：阶段二健康${no}，知道热身与放松的方法，具备安全意识。<br>体育品德：阶段二品德${no}，遵守规则、克服困难、帮助同伴。 | 主要学习内容：【主要学习内容】<br>1.热身小游戏：阶段二内容${no}，绕障碍运球接力。<br>2.技术学练：原地预摆弹性屈伸，30次×2组。<br>3.展示与比赛：2对2半场对抗赛。<br>4.体能练习：折返跑4×30米，2组。 | 教学策略：【教学策略 / 学练活动】<br>1.情境导入：阶段二教法${no}，特种兵训练营闯关。<br>2.教与学的方法：示范讲解与自主学习相结合。<br>3.比赛活动：实时赛与小组赛结合。<br>4.教学评价：语言激励与勋章奖励，组评师评结合。`;
}

/** 纯文本版的单元学习评价表（rubric 阶段：Markdown 表格） */
function rubricTextPayload() {
  return `===RUBRIC===
| 等级 | 分值 | 运动能力 | 健康行为 | 体育品德 |
| --- | --- | --- | --- | --- |
| 优秀 | 85-100 | 优能力 | 优健康 | 优品德 |
| 良好 | 75-84 | 良能力 | 良健康 | 良品德 |
| 合格 | 60-74 | 合格能力 | 合格健康 | 合格品德 |
| 不合格 | 60以下 | 不合格能力 | 不合格健康 | 不合格品德 |

===WEIGHTS===
| 核心素养 | 占比 |
| --- | --- |
| 运动能力 | 60% |
| 健康行为 | 20% |
| 体育品德 | 20% |

===SCORES===
| 得分点 | 核心素养 | 分值 | 评价要点 |
| --- | --- | --- | --- |
| 运动知识 | 运动能力 | 12 | 知识要点 |
| 运动技能 | 运动能力 | 36 | 技能要点 |
| 专项体能 | 运动能力 | 6 | 体能要点 |
| 学习参与 | 运动能力 | 6 | 参与要点 |
| 健康知识 | 健康行为 | 6 | 健康知识要点 |
| 运动习惯 | 健康行为 | 8 | 习惯要点 |
| 心理健康 | 健康行为 | 6 | 心理要点 |
| 体育精神 | 体育品德 | 8 | 精神要点 |
| 道德品质 | 体育品德 | 6 | 品质要点 |
| 规则意识 | 体育品德 | 6 | 规则要点 |`;
}

/** 纯文本版的单个课时（一次只写一个课时：一行 Markdown 表格，带小标题 + 详实内容） */
function lessonTextPayload(no, dimension = 'technique') {
  return [
    '===DIMENSION===',
    dimension,
    '',
    '===LESSON===',
    '| 课次 | 学习目标 | 主要学习内容 | 教学策略与学练活动 |',
    '| --- | --- | --- | --- |',
    `| 第${no}课次 | **【学习目标】**<br>运动能力：阶段二能力${no}，能在对抗中完成急停急起变向运球并运用到比赛。<br>健康行为：阶段二健康${no}，知道热身与放松的方法，具备安全意识。<br>体育品德：阶段二品德${no}，遵守规则、克服困难、帮助同伴。 | **【主要学习内容】**<br>1.热身小游戏：阶段二内容${no}，绕障碍运球接力。<br>2.技术学练：原地预摆弹性屈伸，30次×2组。<br>3.展示与比赛：2对2半场对抗赛。<br>4.体能练习：折返跑4×30米，2组。 | **【教学策略 / 学练活动】**<br>情境导入：阶段二教法${no}，特种兵训练营闯关。<br>教与学的方法：示范讲解与自主学习相结合。<br>比赛活动：实时赛与小组赛结合。<br>教学评价：语言激励与勋章奖励，组评师评结合。 |`,
  ].join('\n');
}

function injectFakeAI(env, script) {
  const calls = [];
  env.context.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    script.onRequest?.(body, env);
    if (body.stage === 'analysis_part1') {
      // 前置分析第一段（模块 1–3）：分隔符 + 纯文本
      return fakeStream(script.analysisPart1Text || script.analysisText || analysisPart1Payload());
    }
    if (body.stage === 'analysis_part2') {
      // 前置分析第二段（模块 4–5）
      return fakeStream(script.analysisPart2Text || analysisPart2Payload());
    }
    if (body.stage === 'analysis') {
      // 兼容旧客户端的单次 analysis
      return fakeStream(script.analysisText || analysisTextPayload());
    }
    if (body.stage === 'structure') {
      return fakeStream(JSON.stringify({
        structure_nodes: script.stage1.structure_nodes,
        main_projects: script.stage1.main_projects,
      }));
    }
    if (body.stage === 'lesson_single') {
      // 新版：一次只写一个课时（一行管道分隔的纯文本）
      const no = body.lessonNo ?? body.startLesson ?? body.from;
      if (script.truncateLessonNo === no) {
        script.truncateLessonNo = undefined;
        const text = lessonSinglePayload(no);
        return fakeStream(text.slice(0, text.length - 120), { truncate: true });
      }
      if (script.failLessonNo === no) {
        const times = script.failLessonTimes === undefined ? 2 : script.failLessonTimes;
        if (times > 0) {
          script.failLessonTimes = times - 1;
          // 「一直失败」= AI 一个字都没吐出来。解析器现在极度容错：
          // 只要写了半截表格也会救回上屏、不算失败，不能再拿半截文本冒充失败。
          return fakeStream('', { truncate: true });
        }
      }
      return fakeStream(lessonSinglePayload(no));
    }
    if (body.stage === 'lessons') {
      // 兼容旧的 lessons 阶段：一次只写一个课时（一行 Markdown 表格）
      const from = body.startLesson ?? body.from;
      const to = body.endLesson ?? body.to;
      const no = from;
      if (script.truncateLessonNo === no) {
        script.truncateLessonNo = undefined;
        const text = lessonTextPayload(no);
        return fakeStream(text.slice(0, text.length - 120), { truncate: true });
      }
      if (script.failLessonNo === no) {
        // 连续失败 failLessonTimes 次（默认 2 次 = 初次 + 一次重试），之后恢复正常
        const times = script.failLessonTimes === undefined ? 2 : script.failLessonTimes;
        if (times > 0) {
          script.failLessonTimes = times - 1;
          // 同上：真失败必须一个字都没有；半截表格现在会被救回并算「有内容」
          return fakeStream('', { truncate: true });
        }
      }
      if (from !== to) {
        // 兼容旧的"一次多课时"调用：逐个返回
        const lessons = [];
        for (let item = from; item <= to; item += 1) lessons.push(lessonTextPayload(item));
        return fakeStream(lessons.join('\n'));
      }
      const lessons = [];
      return fakeStream(lessonTextPayload(no));
    }
    if (body.stage === 'closing') {
      if (script.truncateClosing) return fakeStream('{"assessment":"考核内', { truncate: true });
      return fakeStream(JSON.stringify({
        assessment: '考核与作业（收尾）',
        reflection: '反思框架（收尾）',
      }));
    }
    if (body.stage === 'rubric') {
      // 纯文本阶段：Markdown 表格
      return fakeStream(script.rubricText || rubricTextPayload());
    }
    return fakeStream('{}');
  };
  return calls;
}

/** 阶段① 的完整返回（模块 1–6）—— 结构图是"18 个节点 + 主要项目"的新结构 */
function stage1Payload() {
  return {
    unitTitle: '水平三篮球大单元',
    objectives: '运动能力：阶段一能力\n\n健康行为：阶段一健康\n\n体育品德：阶段一品德',
    textbookAnalysis: '阶段一教材分析内容',
    studentAnalysis: '阶段一学情分析内容',
    teachingContent: '1. 球性\n2. 运球',
    keyDifficulties: { learning: '学', content: '内', organization: '组', method: '法' },
    structure_nodes: Array.from({ length: 18 }, (_, index) => ({
      id: index + 1,
      dimension: index < 2 ? '基础知识' : (index < 10 ? '基本技术' : (index < 16 ? '技战术运用' : '展示或比赛')),
      title: `课次${index + 1}`,
    })),
    main_projects: ['篮球运球', '传切配合'],
  };
}

/** 模块 10 的标准返回（评价量规表） */
function rubricSample() {
  return {
    levels: [
      { name: '优秀', range: '85-100', ability: 'a', health: 'h', character: 'c' },
      { name: '良好', range: '75-84', ability: 'a', health: 'h', character: 'c' },
      { name: '合格', range: '60-74', ability: 'a', health: 'h', character: 'c' },
      { name: '不合格', range: '60以下', ability: 'a', health: 'h', character: 'c' },
    ],
    literacyWeights: [{ name: '运动能力', percent: 60 }, { name: '健康行为', percent: 20 }, { name: '体育品德', percent: 20 }],
    scoreItems: [{ name: '运动知识', literacy: '运动能力', points: 12, desc: 'd' }],
    note: 'n',
  };
}

/** 阶段② 的完整返回（模块 7–11），truncateTo 传数字可模拟"只写到了第 N 课时" */
function stage2Payload(truncateTo = 18) {
  return {
    lessons: Array.from({ length: truncateTo }, (_, index) => ({
      no: index + 1,
      objectives: `1.运动能力：能力${index + 1}\n2.健康行为：健康${index + 1}\n3.体育品德：品德${index + 1}`,
      content: `阶段二-${index + 1}`, method: `组织教法${index + 1}`,
    })),
    assessment: '考核内容',
    reflection: '反思模板',
    rubric: rubricSample(),
  };
}

/** 模拟 AI 返回的完整结果 */
function sampleGenerated() {
  const lessons = Array.from({ length: 18 }, (_, index) => ({
    no: index + 1,
    objectives: `1.运动能力：能力目标${index + 1}\n2.健康行为：健康目标${index + 1}\n3.体育品德：品德目标${index + 1}`,
    content: `教学内容${index + 1}`,
    method: `组织教法${index + 1}`,
  }));
  return {
    unitTitle: '水平三篮球大单元',
    objectives: '运动能力：能力\n\n健康行为：健康\n\n体育品德：品德',
    textbookAnalysis: '教材分析内容',
    studentAnalysis: '学情分析内容',
    teachingContent: '1. 知识\n2. 技术',
    keyDifficulties: { learning: '学生学习', content: '学习内容', organization: '教学组织', method: '教学方法' },
    structure_nodes: Array.from({ length: 18 }, (_, index) => ({
      id: index + 1,
      dimension: index < 2 ? '基础知识' : (index < 10 ? '基本技术' : (index < 16 ? '技战术运用' : '展示或比赛')),
      title: `第${index + 1}课次内容`,
    })),
    main_projects: ['篮球运球', '传切配合'],
    lessons,
    assessment: '考核与作业内容',
    reflection: '反思模板',
    rubric: { levels: [{ name: '优秀', range: '85-100', ability: 'a', health: 'h', character: 'c' }, { name: '良好', range: '75-84', ability: 'a', health: 'h', character: 'c' }, { name: '合格', range: '60-74', ability: 'a', health: 'h', character: 'c' }, { name: '不合格', range: '60以下', ability: 'a', health: 'h', character: 'c' }], literacyWeights: [{ name: '运动能力', percent: 60 }, { name: '健康行为', percent: 20 }, { name: '体育品德', percent: 20 }], scoreItems: [{ name: '运动知识', literacy: '运动能力', points: 12, desc: 'd' }], note: 'n' },
  };
}

const env = createUnitEnv();
const { api } = env;

await test('⑥ AI 返回结果落库：18 课时齐全 + 结构图恰好覆盖 1–18', async () => {
  api.applyGeneratedUnit(sampleGenerated(), {
    categoryId: 'ball', categoryLabel: '球类', itemId: 'basketball', itemLabel: '篮球',
    levelId: 'L3', levelLabel: '水平三（5–6 年级）', topic: '教学content', valid: true,
  });
  const data = api.getUnit();
  equal(data.lessons.length, 18, '课时表必须恰好 18 行');
  data.lessons.forEach((lesson, index) => {
    equal(lesson.no, index + 1, `第 ${index + 1} 行课次序号错乱`);
    assert(typeof lesson.objectives === 'string' && lesson.objectives.includes('运动能力')
      && lesson.objectives.includes('健康行为') && lesson.objectives.includes('体育品德'),
    `第 ${index + 1} 课缺少三维目标段落`);
  });
  equal(api.missingStructureNumbers().length, 0, '结构图必须覆盖 1–18 且无重复');
});

await test('⑦ 残缺 AI 结果也能兜底：少课时 / 脏数据不会让页面崩', async () => {
  api.setUnit(api.createEmptyUnit());
  const broken = { ...sampleGenerated(), lessons: [{ no: 1, content: '只有一课' }], structure_nodes: '不是数组' };
  api.applyGeneratedUnit(broken, null);
  const data = api.getUnit();
  equal(data.lessons.length, 18, '课时不足要补齐到 18 行');
  equal(Array.isArray(data.structure_nodes), true, 'structure_nodes 坏了也要还原成数组');
  equal(data.structure_nodes.length, 0, '脏的结构图不能进页面');
  equal(typeof data.lessons[5].objectives, 'string', '缺失字段补空字符串而不是 undefined');
});

await test('⑧ 结构图缺课次能被发现并一键补全', async () => {
  api.setUnit(api.createEmptyUnit());
  api.applyGeneratedUnit({ ...sampleGenerated(), structure_nodes: [{ id: 1, dimension: '基础知识', title: '认识篮球' }] }, null);
  const missing = api.missingStructureNumbers();
  equal(missing.length, 17, '应发现 17 个缺失课次');
  api.autoFixStructure();
  equal(api.missingStructureNumbers().length, 0, '补全后应覆盖全部 18 个课次');
  const data = api.getUnit();
  equal(data.structure_nodes.length, 18, '补全后应有 18 个节点');
  ['基础知识', '基本技术', '技战术运用', '展示或比赛'].forEach(dimension => {
    assert(data.structure_nodes.some(node => node.dimension === dimension), `补全后要有「${dimension}」泳道的节点`);
  });
});

await test('⑨ 渲染：10 个模块 + 18 个「查看详细教案」按钮', async () => {
  api.applyGeneratedUnit(sampleGenerated(), null);
  api.renderUnitModules();
  const html = env.nodes.get('ud2Modules').innerHTML;
  for (let index = 1; index <= 10; index += 1) {
    assert(html.includes(`模块 ${index}`), `缺少模块 ${index}`);
  }
  assert(!html.includes('模块 11'), '精简到 10 个模块后不该再有模块 11');
  ['教学目标', '教材分析', '学情分析', '主要教学内容', '教学重难点', '大单元设计结构图',
    '18 课时计划表', '考核与作业', '教学反思', '单元学习评价表']
    .forEach(title => assert(html.includes(title), `面板缺少模块标题：${title}`));
  assert(!html.includes('学习评价</span>'), '模块 9「学习评价」已删除，面板里不该再有它');
  const lessonTable = api.renderUnitModuleBody('lessons');
  const detailButtons = lessonTable.match(/showUnitLessonDetail\(/g) || [];
  equal(detailButtons.length, 0, '课时表精简成 4 列后不再有「查看详细教案」按钮');
  assert(lessonTable.includes('学习目标（三维段落）'), '课时表要有「学习目标（三维段落）」列');
  assert(lessonTable.includes('主要学习内容（结构化）'), '课时表要有「主要学习内容（结构化）」列');
  assert(lessonTable.includes('教学策略 / 学练活动'), '课时表要有「教学策略 / 学练活动」列');
});

await test('⑩ 四个重难点子维度各有独立输入框，教学目标合并成一个大文本框', async () => {
  api.applyGeneratedUnit(sampleGenerated(), null);
  const body = api.renderUnitModuleBody('keyDifficulties');
  ['learning', 'content', 'organization', 'method'].forEach(field => {
    assert(body.includes(`keyDifficulties.${field}`), `教学重难点缺少子维度：${field}`);
  });
  const objectivesBody = api.renderUnitModuleBody('objectives');
  assert(objectivesBody.includes('data-unit-path="objectives"'), '教学目标要合并成一个输入框');
  assert(!objectivesBody.includes('objectives.ability'), '教学目标不再拆成三个小框');
  assert(!objectivesBody.includes('objectives.health'), '教学目标不再拆成三个小框');
  assert(!objectivesBody.includes('objectives.character'), '教学目标不再拆成三个小框');
  assert(objectivesBody.includes('运动能力') && objectivesBody.includes('健康行为') && objectivesBody.includes('体育品德'),
    '教学目标框里要写清三维的写法');
});

await test('⑪ 截断的 JSON 能抢救回来', async () => {
  const full = JSON.stringify(sampleGenerated());
  const cut = full.slice(0, Math.floor(full.length * 0.82));
  const recovered = api.recoverPartialUnitJSON(cut);
  assert(recovered && typeof recovered === 'object', '应能从头部的 JSON 抢救出部分对象');
  assert(recovered.objectives || recovered.unitTitle, '至少能拿到开头的字段');
  equal(api.recoverPartialUnitJSON('完全不是JSON'), null, '彻底无效时返回 null 而不是抛异常');
});

await test('⑫ 导出 / 打印 HTML 包含 10 个模块与完整课时表', async () => {
  api.applyGeneratedUnit(sampleGenerated(), null);
  const html = api.buildUnitExportHTML();
  ['一、教学目标', '二、教材分析', '三、学情分析', '四、主要教学内容', '五、教学重难点',
    '六、大单元设计结构图', '七、18 课时计划表', '八、考核与作业',
    '九、教学反思', '十、单元学习评价表'].forEach(heading => assert(html.includes(heading), `导出缺少章节：${heading}`));
  assert(!html.includes('九、学习评价'), '导出里不该再有「学习评价」章节');
  assert(!html.includes('十一、'), '导出章节不该再有第十一章');
  assert(html.includes('优秀') && html.includes('85-100'), '导出要带上评价量规的四等级');
  assert(html.includes('运动知识') && html.includes('12'), '导出要带上细分得分点');
  const rows = html.match(/<td>第 \d+ 课<\/td>/g) || [];
  equal(rows.length, 18, '导出的课时表必须是 18 行');
  assert(html.includes('ud2-mx-table'), '导出要带上结构图矩阵表');
  assert(html.includes('基础知识') && html.includes('展示或比赛'), '导出要带上四条维度泳道');
  assert(html.includes('主要项目'), '导出要带上「主要项目」行');
  assert(html.includes('篮球运球'), '导出要带上 AI 提炼的主要项目');
});

await test('⑬ 旧版（分步生成）数据能迁移到新结构，不丢老师以前的内容', async () => {
  const legacy = {
    theme: '旧天天单元',
    textbookAnalysis: '旧的教材分析',
    studentAnalysis: '旧的学情分析',
    keyPoints: '旧重点',
    difficulties: '旧难点',
    coreQuestion: '旧核心问题',
    objectives: { ability: '旧能力', health: '旧健康', character: '旧品德' },   // 旧版拆分形态
    assessment: '旧考核',
    evaluationSummary: '旧评价汇总',
    reflection: '旧反思',
    lessons: Array.from({ length: 18 }, (_, index) => ({
      objective: '旧目标', content: `旧内容${index + 1}`, method: '旧方法', application: '旧运用', evaluation: '旧评价',
    })),
  };
  const migrated = api.migrateLegacyUnit(legacy);
  equal(migrated.unitTitle, '旧天天单元', '单元名要保留');
  equal(migrated.objectives, '运动能力：旧能力\n\n健康行为：旧健康\n\n体育品德：旧品德', '旧版拆分目标要合并保留');
  equal(migrated.lessons.length, 18, '18 课时结构要迁移过来');
  assert(migrated.lessons[0].content.includes('旧内容1'), '课时内容要保留');
  equal(api.unitModuleCompleted('textbookAnalysis'), true, '有内容就该标成已完成');
});

await test('⑬b 旧数据（11 模块版）读进来不报错：旧「学习评价」被忽略，反思落到模块 9、量规落到模块 10', async () => {
  const env = createUnitEnv();
  const legacy = {
    ...env.api.createEmptyUnit(),
    unitTitle: '旧单元',
    // 老数据里带着已删除的「学习评价」字段
    evaluation: { process: '旧过程性评价', summative: '旧终结性评价', integration: '旧一体化' },
    reflection: '旧反思内容',
    rubric: rubricSample(),
  };
  const normalized = env.api.normalizeUnit(legacy);
  equal(normalized.evaluation, undefined, '旧的「学习评价」要被整个忽略');
  assert(!JSON.stringify(normalized).includes('旧过程性评价'), '旧「学习评价」的内容不能进任何字段');
  equal(normalized.reflection, '旧反思内容', '旧「教学反思」要原样保留（自动落到新模块 9）');
  equal(normalized.rubric.levels.length, 4, '旧「单元学习评价表」要保留（自动落到新模块 10）');
  env.api.setUnit(normalized);
  equal(env.api.unitModuleCompleted('reflection'), true, '反思要算作已完成');

  // 模块编号：教学反思 = 模块 9，单元学习评价表 = 模块 10（按 UNIT_MODULES 的顺序对齐）
  const ids = api.UNIT_MODULES.map(module => module.id);
  const titles = api.UNIT_MODULES.map(module => module.title);
  equal(ids.length, 10, '现在是 10 个模块');
  equal(ids.indexOf('reflection'), 8, '教学反思要落在第 9 位');
  equal(ids.indexOf('rubric'), 9, '单元学习评价表要落在第 10 位');
  assert(!ids.includes('evaluation'), '「学习评价」模块要彻底删除');
  assert(!titles.includes('学习评价'), '「学习评价」模块要彻底删除');
  assert(titles[8] === '教学反思' && titles[9] === '单元学习评价表', '模块 9 / 模块 10 的标题要对齐');
  assert(!api.renderUnitModuleBody('evaluation').includes('过程性评价'), '页面里不该再有学习评价模块');
});

await test('⑭ 三级下拉框联动：选完教材+水平才出教学内容，换水平会跟着换', async () => {
  const fresh = createUnitEnv();
  fresh.api.populateUnitSelectors();
  const { nodes } = fresh;
  nodes.get('ud2Category').value = 'ball';
  fresh.api.onUnitCategoryChange();
  nodes.get('ud2Item').value = 'basketball';
  nodes.get('ud2Level').value = '';
  fresh.api.onUnitLevelChange();
  equal(nodes.get('ud2Topic').disabled, true, '没选水平时教学内容不可选');

  nodes.get('ud2Level').value = 'L1';
  fresh.api.onUnitLevelChange();
  const level1Topics = nodes.get('ud2Topic').innerHTML;
  equal(nodes.get('ud2Topic').disabled, false, '选完水平后教学内容应可选');

  nodes.get('ud2Level').value = 'L3';
  fresh.api.onUnitLevelChange();
  assert(nodes.get('ud2Topic').innerHTML !== level1Topics, '换水平后教学内容列表必须跟着变');
  assert(fresh.api.currentUnitSelection().valid, '三个选项齐了才算可生成');
});

await test('⑮ 后续阶段带上前面阶段的上下文；课时表一次只写一个课时；上下文要被压缩', async () => {
  const built = buildUnitRequest({
    ...UNIT_SELECTION,
    stage: 'closing',
    context: {
      unitTitle: '水平三篮球大单元',
      objectives: '运动能力：能说出并做出三种运球\n健康行为：每周三次练习\n体育品德：遵守规则',
      keyDifficulties: { method: '示范-分解-完整' },
      lessonTitles: [{ no: 1, title: '第1课次：球性' }, { no: 18, title: '第18课次：班级联赛' }],
    },
  });
  const prompt = built.messages[1].content;
  assert(prompt.includes('水平三篮球大单元'), '收尾阶段要带上前面阶段的单元名');
  assert(prompt.includes('第1课次：球性'), '收尾阶段要带上结构图（保证后半部分与前半部分连贯）');
  assert(prompt.includes('每周三次练习'), '收尾阶段要带上三维目标');

  // 一次只写一个课时
  const chunk = buildUnitRequest({ ...UNIT_SELECTION, stage: 'lessons', startLesson: 13, endLesson: 13 });
  equal(chunk.meta.from, 13, '分批起止要回传');
  equal(chunk.meta.to, 13, '分批起止要回传');
  equal(chunk.meta.count, 1, '一次只写 1 个课时');
  const chunkPrompt = chunk.messages[1].content;
  assert(chunkPrompt.includes('第 13 课次'), '分批 prompt 要写明区间');
  assert(chunkPrompt.includes('第13课次'), '分批 prompt 要写明课次号');
  assert(chunkPrompt.includes('恰好 1 项') === false, '单课时不再用"恰好 N 项"的表述');
  // 旧参数名 from / to 仍然可用（兼容旧前端）
  const legacy = buildUnitRequest({ ...UNIT_SELECTION, stage: 'lessons', from: 4, to: 4 });
  equal(legacy.meta.from, 4, '旧的 from 参数仍要生效');
  equal(legacy.meta.to, 4, '旧的 to 参数仍要生效');

  const fat = buildUnitRequest({ ...UNIT_SELECTION, stage: 'closing', context: { teachingContent: '长'.repeat(3000) } });
  assert(fat.messages[1].content.length < 3000,
    `上下文必须被压缩（当前 ${fat.messages[1].content.length} 字），否则输出预算会被输入吃掉`);
  equal(UNIT_LESSON_CHUNK <= 1, true, `每批课时数要压到 1（当前 ${UNIT_LESSON_CHUNK}），远离模型输出上限`);
});
await test('⑯ 前端拼接：22 次请求（分析 + 结构图 + 18 个课时 + 收尾 + 量规），每一步都立刻合并 + 局部渲染', async () => {
  const env = createUnitEnv();
  selectUnitTopic(env);
  const renderedBefore = [];
  const calls = injectFakeAI(env, {
    stage1: stage1Payload(),
    stage2: stage2Payload(),
    onRequest: (body, currentEnv) => {
      // 记录每次请求发出时页面上已经能看到什么（验证"边等边看"）
      renderedBefore.push(currentEnv.node('ud2Modules').innerHTML);
    },
  });

  await env.api.generateWholeUnit();
  // ① 23 次请求：前置分析 2 + 结构图 1 + 18 个课时 + 收尾 1 + 量规 1
  equal(calls.length, 23, '必须恰好 23 次请求（前置分析 2 + 结构图 1 + 18 课时 + 收尾 1 + 量规 1）');
  equal(calls[0].stage, 'analysis_part1', '第一次是前置分析第一段（模块 1–3）');
  equal(calls[1].stage, 'analysis_part2', '第二次是前置分析第二段（模块 4–5）');
  equal(calls[2].stage, 'structure', '第三次是结构图');
  const lessonCalls = calls.filter(call => call.stage === 'lesson_single');
  equal(lessonCalls.length, 18, '课时表必须 18 次请求（一次一个课时）');
  assert(lessonCalls.every(call => Number.isInteger(call.lessonNo)), '每个课时请求都要带 lessonNo');
  equal(
    lessonCalls.map(call => call.lessonNo).sort((a, b) => a - b).join(','),
    '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18',
    '18 个课次一个都不能少',
  );
  const closingIndex = calls.findIndex(call => call.stage === 'closing');
  const rubricIndex = calls.findIndex(call => call.stage === 'rubric');
  assert(closingIndex > 19, '收尾必须排在 18 个课时之后');
  assert(rubricIndex > closingIndex, '评价量规排在收尾之后');
  // 串行的好处：每一步都带着前面已经生成的内容
  equal(calls[1].context.unitTitle, '水平三篮球大单元', '结构图这一步要带上分析阶段的单元名');
  equal(calls[closingIndex].context.unitTitle, '水平三篮球大单元', '收尾这一步也要带上上下文');
  // 边等边看：第 3 步（第一个课时）发出时，模块 1–5 的内容必须已经渲染到页面
  assert(renderedBefore[2].includes('阶段一教材分析内容'), '第一步完成后必须立刻渲染，页面要能边等边看');

  const data = env.api.getUnit();
  equal(data.unitTitle, '水平三篮球大单元', '单元名来自分析阶段');
  equal(data.textbookAnalysis, '阶段一教材分析内容', '前面的模块不能被后面的请求冲掉');
  equal(data.lessons.length, 18, '合并后仍是 18 行课时表');
  assert(data.lessons[17].content.includes('阶段二内容18'), '第 18 课时要落到第 18 行');
  assert(data.lessons[0].objectives.includes('运动能力'), '课时的三维目标要落库');
  equal(data.structure_nodes.length, 18, '结构图 18 个节点要落库');
  assert(data.rubric && data.rubric.levels.length === 4, '模块 10 的评价量规要落库');
  equal(env.api.unitMissingLessonNumbers().length, 0, '全部成功时不应有缺失课时');
  equal(env.api.unitTailMissing().length, 0, '模块 8–11 应齐全');
  equal(env.overlays.length, 0, '没截断就不该弹窗打扰老师');
  assert(env.toasts.some(toast => String(toast.message).includes('已生成')), '应提示生成成功');
});
await test('⑰ 某个课时被截断 → 只重试那一课，前面成功的课次一律不丢', async () => {
  const env = createUnitEnv();
  selectUnitTopic(env);
  // 模拟：第 9 课次那一次请求在表格中间被掐断（只掐一次，重试时正常返回）
  const calls = injectFakeAI(env, {
    stage1: stage1Payload(), stage2: stage2Payload(), truncateLessonNo: 9,
  });

  await env.api.generateWholeUnit();
  const retried = calls.filter(call => call.stage === 'lesson_single' && call.lessonNo === 9);
  equal(retried.length, 2, '被截断的那一课要自动重试一次，而不是推翻整个流程');
  equal(env.api.unitMissingLessonNumbers().length, 0, '重试成功后 18 课时必须齐全');
  const data = env.api.getUnit();
  equal(data.lessons[8].content.includes('阶段二内容9'), true, '第 9 课时重试后要补齐');
  equal(data.lessons[17].content.includes('阶段二内容18'), true, '第 18 课时要落位');
  equal(data.textbookAnalysis, '阶段一教材分析内容', '重试不能推翻前面已经生成好的模块');
  equal(env.overlays.length, 0, '重试成功就不该弹窗打扰老师');
});

await test('⑰b 某一课一直失败 → 流水线继续跑完其余步骤，最后提示补全（已成功的课次全部保留）', async () => {
  const env = createUnitEnv();
  selectUnitTopic(env);
  const calls = injectFakeAI(env, {
    stage1: stage1Payload(), stage2: stage2Payload(), failLessonNo: 9,
  });

  await env.api.generateWholeUnit();
  const failed = calls.filter(call => call.stage === 'lesson_single' && call.lessonNo === 9);
  equal(failed.length, 2, '失败的那一课只重试 UNIT_STAGE_RETRY 次，不无限重试');
  // 关键：失败的那一课不能中断整条流水线
  assert(calls.some(call => call.stage === 'closing'), '某一课失败后，收尾阶段仍要继续生成');
  assert(calls.some(call => call.stage === 'rubric'), '某一课失败后，评价量规仍要继续生成');
  const data = env.api.getUnit();
  equal(data.textbookAnalysis, '阶段一教材分析内容', '已成功的模块必须保留');
  equal(data.rubric.levels.length, 4, '评价量规要照常生成');
  equal(env.api.unitMissingLessonNumbers().join(','), '9', '只缺被掐断的那一个课次');

  const dialog = env.overlays[env.overlays.length - 1];
  assert(dialog, '必须弹出提示窗');
  assert(/课次缺失/.test(dialog.title) && /点击【补全】按钮单独生成该课次/.test(dialog.title),
    `弹窗标题要写明缺失课次与补全入口：${dialog.title}`);
  assert(dialog.footerHTML.includes('generateLessonTableOnly()'), '弹窗必须提供【补全】按钮');

  // 点【补全】：只补缺失的那一个课次，已写好的内容不动
  const before = calls.length;
  await env.api.generateLessonTableOnly();
  const batchCalls = calls.slice(before).filter(call => call.stage === 'lessons');
  equal(batchCalls.length, 1, '只有 1 个缺失课次，就只发 1 次请求');
  equal(batchCalls[0].startLesson, 9, '从缺失的第 9 课次开始');
  equal(batchCalls[0].endLesson, 9, '到缺失的最后一个课次结束');

  const after = env.api.getUnit();
  equal(env.api.unitMissingLessonNumbers().length, 0, '补生成后 18 课时必须齐全');
  equal(after.lessons[0].content.includes('阶段二内容1'), true, '已有内容不能被覆盖');
  equal(after.lessons[8].content.includes('阶段二内容9'), true, '第 9 课时要落在第 9 行');
  equal(after.lessons[12].content.includes('阶段二内容13'), true, '第 13 课时是另一次请求生成的，不能被冲掉');
  equal(env.overlays.length, 0, '补生成前应自动关掉提示窗');
});

await test('⑱ 分批区间按连续段切分，不会把已写好的课时重生成一遍', async () => {
  const env = createUnitEnv();
  const ranges = env.api.unitMissingRanges([8, 9, 10, 11, 12, 13, 14, 18]);
  equal(ranges.length, 8, '一次只写一个课时 → 每个缺失课次单独一批');
  equal(ranges.map(range => range.join(',')).join(' '), '8 9 10 11 12 13 14 18', '缺失的课次要逐个成批');
  equal(env.api.unitMissingRanges([]).length, 0, '没有缺失就不该发请求');
});

await test('⑲ 田径类重构为四子类，且每个子类在四个水平都有具体教学内容', async () => {
  const athletics = catalog.UNIT_CATALOG.find(category => category.id === 'athletics');
  assert(athletics, '缺少田径类');
  equal(athletics.items.length, 4, '田径必须正好四个子类');
  const ids = athletics.items.map(item => item.id);
  ['running', 'jumping', 'throwing', 'combined'].forEach(id => {
    assert(ids.includes(id), `缺少田径子类：${id}`);
  });
  athletics.items.forEach(item => {
    catalog.UNIT_LEVELS.forEach(level => {
      const topics = catalog.listUnitTopics(item.id, level.id);
      assert(topics.length >= 3, `${item.label}/${level.label} 条目太少（${topics.length} 条）`);
    });
  });
  // 水平一必须游戏化、水平四必须进入完整技术
  const l1 = catalog.listUnitTopics('running', 'L1').join('');
  assert(l1.includes('游戏'), '水平一应以游戏化基本技能为主');
  const l4 = catalog.listUnitTopics('jumping', 'L4').join('');
  assert(l4.includes('完整技术'), '水平四应进入完整技术');
});

await test('⑳ 老师点名的具体项目都在字典里（跑/跳/投/综合逐项核对）', async () => {
  const all = ['running', 'jumping', 'throwing', 'combined']
    .flatMap(id => ['L1', 'L2', 'L3', 'L4'].map(level => catalog.listUnitTopics(id, level).join('｜')))
    .join('｜');
  const required = [
    '50 米快速跑', '迎面接力跑', '障碍跑',
    '立定跳远', '急行跳远', '投掷垒球', '双手前掷实心球', '跑＋跳组合',
    '蹲踞式起跑', '耐久跑', '上挑式接力跑', '跨越式跳高', '侧向推实心球', '跑跳投综合积分赛',
    '下压式接力跑', '跨栏跑', '蹲踞式跳远完整技术', '跨越式跳高完整技术', '全能挑战',
  ];
  const missing = required.filter(keyword => !all.includes(keyword));
  assert(missing.length === 0, `字典里缺少这些老师点名的项目：${missing.join('、')}`);
});

await test('㉑ 旧田径细项 id 仍可反查（老师以前保存的大单元不会失效）', async () => {
  equal(catalog.findUnitCatalogItem('sprint')?.item.id, 'running', '旧"短跑"应映射到"跑类"');
  equal(catalog.findUnitCatalogItem('longJump')?.item.id, 'jumping', '旧"跳远"应映射到"跳跃类"');
  equal(catalog.findUnitCatalogItem('highJump')?.item.id, 'jumping', '旧"跳高"应映射到"跳跃类"');
  equal(catalog.findUnitCatalogItem('distanceRun')?.item.id, 'running', '旧"耐久跑"应映射到"跑类"');
  assert(catalog.listUnitTopics('sprint', 'L2').length > 0, '旧 id 仍能取到教学内容');
  equal(catalog.listUnitTopics('不存在', 'L1').length, 0, '未知 id 仍返回空');
});

await test('㉒ 体操新增支撑跳跃、中华传统体育新增跳绳、新兴体育含花样跳绳/飞盘/定向运动', async () => {
  const pick = (categoryId) => {
    const category = catalog.UNIT_CATALOG.find(entry => entry.id === categoryId);
    return category.items.map(item => `${item.label}`).join('｜');
  };
  assert(catalog.findUnitCatalogItem('vault')?.item.label.includes('支撑跳跃'), '体操类要有独立的「支撑跳跃」细项');
  assert(catalog.findUnitCatalogItem('tradRope')?.item.label.includes('跳绳'), '中华传统体育类要有「跳绳」细项');
  ['ropeSkipping', 'frisbee', 'orienteering'].forEach(id => {
    assert(catalog.findUnitCatalogItem(id), `新兴体育类缺少细项：${id}`);
  });
  assert(pick('gymnastics').includes('技巧'), '体操类仍要有技巧');
  assert(pick('gymnastics').includes('韵律操'), '体操类仍要有韵律操');
  assert(pick('traditional').includes('武术') && pick('traditional').includes('毽球'), '传统类要有武术与毽球');
  // 每个细项、每个水平都必须有内容（新增细项最容易漏水平）
  ['vault', 'tradRope'].forEach(id => catalog.UNIT_LEVELS.forEach(level => {
    assert(catalog.listUnitTopics(id, level.id).length >= 3, `${id}/${level.id} 内容缺失`);
  }));
});

await test('㉓ AI prompt 必须带上「细项 + 水平的具体教学内容清单」，不能让 AI 泛泛写"田径"', async () => {
  // ① 前端带 topicList 过来
  const withList = buildUnitRequest({
    ...UNIT_SELECTION, stage: 'analysis', itemId: 'running', levelId: 'L3',
    topicList: ['蹲踞式起跑（各就位—预备—跑）', '蹲踞式跳远：助跑—踏跳—腾空步—落地'],
  });
  const prompt1 = withList.messages[1].content;
  assert(prompt1.includes('具体教学内容清单'), 'prompt 要有教学内容清单标题');
  assert(prompt1.includes('蹲踞式起跑'), '清单里的具体项目要写进 prompt');
  assert(prompt1.includes('禁止用'), '要禁止 AI 用笼统表述充当课时内容');

  // ② 旧客户端不带清单时，后端要能按 itemId/levelId 从字典反查
  const byId = buildUnitRequest({ ...UNIT_SELECTION, stage: 'closing', itemId: 'running', levelId: 'L2' });
  const prompt2 = byId.messages[1].content;
  assert(prompt2.includes('具体教学内容清单'), '没带清单也要能从字典反查出来');
  assert(prompt2.includes('50 米快速跑'), '反查出的清单要包含该水平的具体项目');
  assert(prompt2.includes('蹲踞式起跑') === false, '不能把别的水平的项目塞进来');

  // ③ 阶段② 的上下文里也要带清单（unitContextBrief）
  const withContext = buildUnitRequest({
    ...UNIT_SELECTION, stage: 'closing', itemId: 'running', levelId: 'L3',
    context: { unitTitle: '水平三跑类大单元', topicList: ['上挑式接力跑', '跨越式跳高'] },
  });
  const prompt3 = withContext.messages[1].content;
  assert(prompt3.includes('本细项·本水平的教学内容清单'), 'unitContextBrief 必须包含教学内容清单');
  assert(prompt3.includes('上挑式接力跑'), '上下文清单要能被带进阶段②');

  // ④ 分批课时表：带的是"本批课次计划表"（维度 + 具体项目），不再整份清单全塞（省 token 给输出）
  const chunk = buildUnitRequest({ ...UNIT_SELECTION, stage: 'lessons', from: 13, to: 18, itemId: 'running', levelId: 'L4' });
  const chunkPrompt = chunk.messages[1].content;
  assert(chunkPrompt.includes('本批课次计划表'), '分批课时要带本批课次计划表');
  ['第13课次｜', '第18课次｜'].forEach(mark => assert(chunkPrompt.includes(mark), `计划表缺少${mark}`));
  assert(!chunkPrompt.includes('具体教学内容清单'), '分批课时不该再带整份清单（输入越短，输出越完整）');
  const planBlock = chunkPrompt.split('本批课次计划表')[1] || '';
  assert(/（basic|technique|tactic|fitness|match|rule|watch）/.test(planBlock), '计划表要标明每个课次的维度键');
});

await test('㉔ 教学内容清单会被清洗：条数有上限、超长条目被截断，但不会截掉整个维度', async () => {
  const fat = buildUnitRequest({
    ...UNIT_SELECTION, stage: 'analysis',
    topicList: Array.from({ length: 40 }, (_, index) => `第${index + 1}条${'很'.repeat(80)}内容`),
  });
  const prompt = fat.messages[1].content;
  // 只数"教学内容清单"那一段（prompt 里还有模块编号列表，不能混在一起数）
  const block = prompt.split('具体教学内容清单')[1]?.split('⛔')[0] || '';
  const listed = (block.match(/^\s+\d+\.\s/gm) || []).length;
  assert(listed > 0 && listed <= 24, `清单条数应被限制在 24 条以内（实际 ${listed}）`);
  assert(!prompt.includes('很'.repeat(80)), '超长条目必须被截断');

  // 篮球水平三有 20 条（含比赛 / 规则 / 观赏），必须完整进 prompt，不能被上限削掉维度
  const full = catalog.unitTopicListWithDimension('basketball', 'L3');
  const built = buildUnitRequest({ ...UNIT_SELECTION, stage: 'analysis', topicList: full });
  const fullBlock = built.messages[1].content.split('具体教学内容清单')[1]?.split('⛔')[0] || '';
  equal((fullBlock.match(/^\s+\d+\.\s/gm) || []).length, full.length, '20 条清单应完整进入 prompt');
  ['【比赛】', '【规则】', '【体能】'].forEach(tag => {
    assert(fullBlock.includes(tag), `清单被截断，丢掉了${tag}维度的内容`);
  });
});

await test('㉕ 球类按七大维度组织：五个细项、水平二至四都挂到维度上', async () => {
  equal(catalog.UNIT_DIMENSIONS.length, 7, '维度必须正好七个');
  const ids = catalog.UNIT_DIMENSIONS.map(dimension => dimension.id);
  ['basic', 'technique', 'tactic', 'fitness', 'match', 'rule', 'watch'].forEach(id => {
    assert(ids.includes(id), `缺少维度：${id}`);
  });
  const ball = catalog.UNIT_CATALOG.find(category => category.id === 'ball');
  ['basketball', 'football', 'volleyball', 'tableTennis', 'badminton'].forEach(itemId => {
    ['L2', 'L3', 'L4'].forEach(levelId => {
      const entries = catalog.unitTopicEntries(itemId, levelId);
      assert(entries.length >= 6, `${itemId}/${levelId} 条目太少（${entries.length}）`);
      entries.forEach(entry => {
        assert(ids.includes(entry.dimension), `${itemId}/${levelId} 存在不属于七大维度的条目：${entry.text}`);
      });
      const groups = catalog.unitTopicGroups(itemId, levelId);
      // 分组后条数不能变（不能漏项、也不能重复）
      const grouped = groups.reduce((sum, group) => sum + group.topics.length, 0);
      equal(grouped, entries.length, `${itemId}/${levelId} 分组后条目数对不上`);
      // 维度顺序必须按 基础知识→基本技术→战术→体能→比赛→规则→观赏
      const order = groups.map(group => group.id);
      const ranked = order.map(id => ids.indexOf(id));
      assert(ranked.every((value, index) => index === 0 || value > ranked[index - 1]),
        `${itemId}/${levelId} 维度顺序错乱：${order.join('、')}`);
    });
  });
});

await test('㉖ 用户点名的球类具体项目逐条在库（含战术/体能/比赛/规则/观赏）', async () => {
  const textOf = (itemId, levelId) => catalog.listUnitTopics(itemId, levelId).join('｜');
  const checks = [
    ['basketball', 'L2', ['双手胸前传接球', '双手胸前投篮', '追逐跑', '折线跑', '滚球', '观看篮球比赛']],
    ['basketball', 'L3', ['顺步持球突破', '单手肩上传接球', '长传快攻', '传切配合', '侧掩护', '半场人盯人防守', '起跳摸高', '绕球', '3v3', '5v5', '裁判手势']],
    ['basketball', 'L4', ['运球转身', '击地传球', '行进间低手投篮', '交叉步持球突破', '抢篮板', '短传快攻', '运球掩护', '突分', '策应', '区域联防', '滑步接力']],
    ['football', 'L2', ['脚内侧传球', '接球', '射门', '二到三人传接球', '翻滚', '起动跑', '比赛时间', '换人']],
    ['football', 'L3', ['行进间传接球', '射门技术组合', '防守技术', '二三人局部配合', '运球过人', '5v5', '7v7', '越位']],
    ['football', 'L4', ['长传球', '接空中球', '正面防守', '侧面防守', '定位球战术', '11 人制']],
    ['volleyball', 'L2', ['准备姿势', '垫球', '传球', '发球游戏', '轮转游戏', '排球游戏节']],
    ['volleyball', 'L3', ['正面双手垫球', '正面双手传球', '侧面下手发球', '正面下手发球', '原地扣球', '6 人站位与轮转', '低网']],
    ['volleyball', 'L4', ['体侧垫球', '背垫', '背传', '顺网传球', '正面上手发球', '正面扣球', '单人拦网', '位置分工', '接发球阵形', '中一二进攻', '防守战术']],
    ['tableTennis', 'L2', ['握拍', '平击发球', '推挡', '正手攻球', '左推右攻', '颠球比赛']],
    ['tableTennis', 'L3', ['急长发球', '左推右攻战术', '发上旋球抢攻', '摸台角', '7 分制', '11 分制']],
    ['tableTennis', 'L4', ['拉下旋球', '正手转与不转发球', '推挡侧身攻', '连续进攻战术', '双打战术', '多球练习']],
    ['badminton', 'L2', ['正手握拍', '反手握拍', '正手发高远球', '挑球', '放网', '击高远球', '杀球', '单打基本站位']],
    ['badminton', 'L3', ['正手网前球', '正手吊球', '后场击球组合', '杀上网', '重复放网', '下压上网', '双打站位', '4 角移动步法', '双打挑战赛']],
    ['badminton', 'L4', ['反手发网前球', '挡球', '扑球', '中场两侧击球', '全场步法', '四方球战术', '拉吊突击', '双打攻防战术', '连续杀球']],
  ];
  const missing = [];
  checks.forEach(([itemId, levelId, keywords]) => {
    const text = textOf(itemId, levelId);
    keywords.forEach(keyword => { if (!text.includes(keyword)) missing.push(`${itemId}/${levelId}：${keyword}`); });
  });
  assert(missing.length === 0, `字典里缺少这些项目：${missing.join('；')}`);
});

await test('㉗ 水平二没有战术（篮球），维度缺失时不硬凑条目', async () => {
  const groups = catalog.unitTopicGroups('basketball', 'L2');
  const ids = groups.map(group => group.id);
  assert(!ids.includes('tactic'), '篮球水平二不该出现战术维度（课标：水平二不设战术）');
  assert(ids.includes('watch'), '篮球水平二要有观赏维度');
  assert(catalog.unitTopicGroups('basketball', 'L3').some(group => group.id === 'tactic'), '水平三起要有战术维度');
});

await test('㉘ AI 拿到的清单带维度前缀，并要求 18 课时覆盖各维度', async () => {
  const list = catalog.unitTopicListWithDimension('basketball', 'L3');
  assert(list.some(entry => entry.startsWith('【基本技术】')), '清单条目要带维度前缀');
  assert(list.some(entry => entry.startsWith('【战术】')), '战术条目要带维度前缀');
  const built = buildUnitRequest({
    category: '球类', item: '篮球', level: '水平三（5–6 年级）', topic: '原地单手肩上投篮',
    stage: 'analysis', itemId: 'basketball', levelId: 'L3', topicList: list,
  });
  const prompt = built.messages[1].content;
  assert(prompt.includes('【基本技术】'), 'prompt 里的清单要带维度');
  assert(prompt.includes('按下面的配额分配'), '要要求 18 课时按维度配额覆盖各维度');
  // 不带清单时按 id 反查也要带维度
  const byId = buildUnitRequest({
    category: '球类', item: '篮球', level: '水平四（7–9 年级）', topic: '运球转身', stage: 'closing',
    itemId: 'basketball', levelId: 'L4',
  });
  assert(byId.messages[1].content.includes('【战术】'), '按 id 反查时也要带维度');
});

await test('㉙ 下拉框按维度分组渲染，但取值仍是原文（不影响已保存的数据）', async () => {
  const env = createUnitEnv();
  env.api.populateUnitSelectors();
  env.node('ud2Category').value = 'ball';
  env.api.onUnitCategoryChange();
  env.node('ud2Item').value = 'basketball';
  env.node('ud2Level').value = 'L3';
  env.api.onUnitLevelChange();
  const html = env.node('ud2Topic').innerHTML;
  const groups = (html.match(/<optgroup label="([^"]+)"/g) || [])
    .map(tag => (tag.match(/label="([^"]+)"/)?.[1] || ''));
  ['基础知识', '基本技术', '战术', '体能', '比赛', '规则'].forEach(label => {
    assert(groups.includes(label), `下拉框缺少维度分组：${label}`);
  });
  assert(groups.indexOf('基本技术') < groups.indexOf('战术'), '维度顺序要先技术后战术');
  assert(html.includes('value="原地单手肩上投篮"'), '选项取值必须是原文，便于与已保存的大单元对上');
  // 水平一没有维度，仍按普通列表渲染
  env.node('ud2Level').value = 'L1';
  env.api.onUnitLevelChange();
  assert(!env.node('ud2Topic').innerHTML.includes('<optgroup'), '水平一按普通列表渲染');
});

await test('㉚ 体操类拆出单杠 / 双杠 / 艺术体操，并按维度录入（双杠仅水平四）', async () => {
  const gymnastics = catalog.UNIT_CATALOG.find(category => category.id === 'gymnastics');
  const labels = gymnastics.items.map(item => item.label).join('｜');
  ['技巧', '支撑跳跃', '单杠', '双杠', '艺术体操'].forEach(keyword => {
    assert(labels.includes(keyword), `体操类缺少细项：${keyword}`);
  });
  // 旧 id「器械（单杠/双杠）」仍能反查，老师以前保存的数据不失效
  equal(catalog.findUnitCatalogItem('apparatus')?.item.id, 'horizontalBar', '旧"器械"应映射到"单杠"');
  assert(catalog.listUnitTopics('apparatus', 'L2').length > 0, '旧 id 仍能取到教学内容');

  // 双杠按教材只在水平四开设：水平一至三只给衔接准备，且必须带 [待确认]
  ['L1', 'L2', 'L3'].forEach(levelId => {
    const entries = catalog.unitTopicEntries('parallelBars', levelId);
    assert(entries.length >= 1, `双杠${levelId} 也要有衔接内容（否则下拉框会空）`);
    entries.forEach(entry => assert(catalog.isUnitTopicPending(entry.text), `双杠${levelId} 不是正式内容，必须标 [待确认]`));
  });

  // 体操无战术维度，不能为了凑维度硬编条目
  ['skills', 'vault', 'horizontalBar', 'rhythmic'].forEach(itemId => {
    ['L2', 'L3', 'L4'].forEach(levelId => {
      const ids = catalog.unitTopicGroups(itemId, levelId).map(group => group.id);
      assert(!ids.includes('tactic'), `${itemId}/${levelId} 体操不该有战术维度`);
      assert(ids.includes('technique'), `${itemId}/${levelId} 要有基本技术维度`);
    });
  });
});

await test('㉛ 用户点名的体操项目逐条在库（技巧/支撑跳跃/单杠/双杠/艺术体操）', async () => {
  const textOf = (itemId, levelId) => catalog.listUnitTopics(itemId, levelId).join('｜');
  const checks = [
    ['skills', 'L2', ['前滚翻', '后滚翻', '仰卧推起成桥', '跪跳起', '挺身跳', '简单组合', '仰卧起坐', '平板支撑']],
    ['skills', 'L3', ['侧手翻', '燕式平衡', '肩肘倒立', '组合动作', '横叉', '纵叉']],
    ['skills', 'L4', ['头手倒立', '创编', '俯卧撑']],
    ['vault', 'L3', ['山羊分腿腾越', '助跑', '踏跳', '支撑', '腾空', '落地', '俯撑爬行']],
    ['vault', 'L4', ['横箱分腿腾越', '标准解析', '组合动作创编', '推小车']],
    ['horizontalBar', 'L2', ['跳上成支撑', '前翻下', '组合动作', '悬垂举腿']],
    ['horizontalBar', 'L3', ['支撑后摆下', '单腿摆越成骑撑', '单腿向后摆越成支撑', '推小车接力赛']],
    ['horizontalBar', 'L4', ['单腿摆越成骑撑—单腿向后摆越成支撑', '成套动作创编', '引体向上']],
    ['parallelBars', 'L4', ['支撑摆动', '支撑后摆下', '外侧坐越两杠挺身下', '组合动作', '双杠臂屈伸', '推小车', '悬垂举腿']],
    ['rhythmic', 'L2', ['手位', '脚位', '步伐', '跳步', '波浪', '韵律操组合', '基础体能']],
    ['rhythmic', 'L3', ['六种基本手型', '常用手位', '下肢动作', '啦啦操组合', '创编动作', '俯撑钻爬']],
    ['rhythmic', 'L4', ['常用手型', '步法', '健美操动作组合', '结合音乐', '靠墙静蹲']],
  ];
  const missing = [];
  checks.forEach(([itemId, levelId, keywords]) => {
    const text = textOf(itemId, levelId);
    keywords.forEach(keyword => { if (!text.includes(keyword)) missing.push(`${itemId}/${levelId}：${keyword}`); });
  });
  assert(missing.length === 0, `字典里缺少这些项目：${missing.join('；')}`);
  // 六种手型的具体名称无法从课标确认，必须见 [待确认]
  assert(catalog.listUnitTopics('rhythmic', 'L3').some(topic => topic.includes('六种') && catalog.isUnitTopicPending(topic)),
    '六种手型应标 [待确认]');
});

await test('㉜ 田径四子类按维度录入，用户点名的项目逐条在库', async () => {
  const ids = catalog.UNIT_DIMENSIONS.map(dimension => dimension.id);
  ['running', 'jumping', 'throwing', 'combined'].forEach(itemId => {
    ['L2', 'L3', 'L4'].forEach(levelId => {
      const entries = catalog.unitTopicEntries(itemId, levelId);
      assert(entries.length >= 3, `${itemId}/${levelId} 条目太少（${entries.length}）`);
      entries.forEach(entry => {
        assert(ids.includes(entry.dimension), `${itemId}/${levelId} 有不属于七大维度的条目：${entry.text}`);
      });
      // 跑/跳/投是技术类，必须有技术维度；跑跳投综合按老师给的内容以「比赛 / 综合活动」为主
      const mainDimension = itemId === 'combined' ? 'match' : 'technique';
      assert(entries.some(entry => entry.dimension === mainDimension),
        `${itemId}/${levelId} 要有${itemId === 'combined' ? '比赛' : '基本技术'}维度`);
      // 水平一保持游戏化的扁平列表（不与维度混用）
      assert(catalog.unitTopicEntries(itemId, 'L1').every(entry => !entry.dimension), `${itemId}/L1 应保持游戏化扁平列表`);
    });
  });

  const textOf = (itemId, levelId) => catalog.listUnitTopics(itemId, levelId).join('｜');
  const checks = [
    ['running', 'L2', ['站立式起跑', '快速跑', '迎面接力跑', '障碍跑', '简化规则比赛']],
    ['running', 'L3', ['蹲踞式起跑', '短跑', '耐久跑', '上挑式接力跑', '十字接力', '计时跑体能']],
    ['running', 'L4', ['蹲踞式起跑与起跑后的加速跑', '途中跑', '终点冲刺', '下压式接力跑', '跨栏跑', '定向越野体能']],
    ['jumping', 'L2', ['立定跳远', '模仿跳跃游戏', '跳格子游戏']],
    ['jumping', 'L3', ['急行跳远', '跨越式跳高', '跳上跳下台阶']],
    ['jumping', 'L4', ['蹲踞式跳远完整技术', '跨越式跳高完整技术', '背越式', '挺身式']],
    ['throwing', 'L2', ['抛接轻物', '掷远游戏', '原地投掷沙包', '双手前掷实心球']],
    ['throwing', 'L3', ['上步投掷垒球', '双手前掷实心球', '侧向推实心球']],
    ['throwing', 'L4', ['侧向滑步推实心球', '双手头上掷实心球', '多种姿势投掷']],
    ['combined', 'L2', ['跑＋跳组合游戏', '跑＋投组合', '简化田径积分赛']],
    ['combined', 'L3', ['跑跳投综合积分赛', '小组全能挑战']],
    ['combined', 'L4', ['个人 / 小组全能比赛', '田径专项体能组合赛']],
  ];
  const missing = [];
  checks.forEach(([itemId, levelId, keywords]) => {
    const text = textOf(itemId, levelId);
    keywords.forEach(keyword => { if (!text.includes(keyword)) missing.push(`${itemId}/${levelId}：${keyword}`); });
  });
  assert(missing.length === 0, `字典里缺少这些项目：${missing.join('；')}`);

  // 无法确认的仍要标 [待确认]：跨栏跑、800/1000 米、背越式/挺身式、侧向推实心球、滑步推实心球、全能换算
  const pending = ['running', 'jumping', 'throwing', 'combined']
    .flatMap(itemId => ['L3', 'L4'].flatMap(levelId => catalog.listUnitTopics(itemId, levelId)))
    .filter(catalog.isUnitTopicPending);
  ['跨栏跑', '800 米', '背越式', '侧向推实心球', '侧向滑步推实心球'].forEach(keyword => {
    assert(pending.some(topic => topic.includes(keyword)), `${keyword} 属于无法确认的内容，应标 [待确认]`);
  });
});

await test('㉝ 中华传统类新增 中国式摔跤 / 舞龙 / 长拳，新兴体育类定向运动·轮滑·花样跳绳按维度录入', async () => {
  const labelsOf = (categoryId) => {
    const category = catalog.UNIT_CATALOG.find(entry => entry.id === categoryId);
    return category.items.map(item => item.label).join('｜');
  };
  ['wrestling', 'dragon', 'changquan'].forEach(id => {
    assert(catalog.findUnitCatalogItem(id), `传统类缺少细项：${id}`);
  });
  assert(labelsOf('traditional').includes('中国式摔跤'), '传统类要有「中国式摔跤」');
  assert(labelsOf('traditional').includes('舞龙'), '传统类要有「舞龙」');
  assert(labelsOf('traditional').includes('长拳'), '传统类要有「长拳」');
  assert(labelsOf('emerging').includes('花样跳绳'), '新兴类要有「花样跳绳」');

  // 六个细项 × 四个水平都不得空白（新增细项最容易漏水平）
  ['wrestling', 'dragon', 'changquan', 'orienteering', 'roller', 'ropeSkipping'].forEach(itemId => {
    catalog.UNIT_LEVELS.forEach(level => {
      assert(catalog.listUnitTopics(itemId, level.id).length >= 1, `${itemId}/${level.id} 内容缺失`);
    });
    // 水平一至三保持游戏化扁平；水平二至四挂到维度上
    assert(catalog.unitTopicEntries(itemId, 'L1').every(entry => !entry.dimension), `${itemId}/L1 应保持游戏化扁平列表`);
    const ids = catalog.UNIT_DIMENSIONS.map(dimension => dimension.id);
    ['L2', 'L3', 'L4'].forEach(levelId => {
      const entries = catalog.unitTopicEntries(itemId, levelId);
      assert(entries.length >= 3, `${itemId}/${levelId} 条目太少（${entries.length}）`);
      entries.forEach(entry => {
        assert(ids.includes(entry.dimension), `${itemId}/${levelId} 有不属于七大维度的条目：${entry.text}`);
      });
    });
  });
});

await test('㉞ 用户点名的传统与新兴项目逐条在库，无法确认的标 [待确认]', async () => {
  const textOf = (itemId, levelId) => catalog.listUnitTopics(itemId, levelId).join('｜');
  const checks = [
    ['wrestling', 'L2', ['礼仪', '卷体', '前倒', '拉', '撒', '插', '闪', '步法']],
    ['wrestling', 'L3', ['侧滚翻', '抱腿', '手别', '推手对抗赛']],
    ['wrestling', 'L4', ['后倒展腹', '抢背', '抱腿', '挑腿', '实战对抗赛', '裁判规则']],
    ['dragon', 'L2', ['礼仪', '高举', '平端', '圆场', '矮步', '游龙']],
    ['dragon', 'L3', ['8 字舞龙', '组团造型', '串联']],
    ['dragon', 'L4', ['穿腾', '舞龙套路', '创编', '比赛']],
    ['changquan', 'L2', ['拳', '掌', '勾', '弓步', '马步', '仆步', '冲拳', '劈掌', '弹踢', '五步拳']],
    ['changquan', 'L3', ['正踢', '拍脚', '少年拳第一套', '武术健身操', '组合技术运用']],
    ['changquan', 'L4', ['侧踹', '望月平衡', '少年拳第二套', '健身长拳', '攻防演练']],
    ['orienteering', 'L2', ['概念与分类', '磁北线', '百米定向', '地图对北', '拇指辅行', '百米定向比赛']],
    ['orienteering', 'L3', ['颜色分类', '边跑边读图', '沿线行进', '短距离接力赛']],
    ['orienteering', 'L4', ['等高线', '地貌判读', '瞄准法', '指北针', '积分赛', '团队赛', '心肺耐力']],
    ['roller', 'L2', ['起源', '装备', '摔倒', '直线滑行', '制动器', '直线速度赛']],
    ['roller', 'L3', ['交叉步滑行', '8 字刹停', 'T 字刹停', '单腿蹬', '竞速赛']],
    ['roller', 'L4', ['正滑蛇形', '倒滑', '弯道滑行', '绕圈计时赛', '平衡']],
    ['ropeSkipping', 'L2', ['并脚跳', '双脚交换跳', '开合跳', '正摇编花', '1 分钟双脚交换跳']],
    ['ropeSkipping', 'L3', ['并脚左右跳', '后摇跳', '双摇跳', '车轮跳', '交互绳', '30 秒双摇跳']],
    ['ropeSkipping', 'L4', ['弹踢腿跳', '钟摆跳', '双摇编花', '长短绳组合', '网绳', '挑战接龙']],
  ];
  const missing = [];
  checks.forEach(([itemId, levelId, keywords]) => {
    const text = textOf(itemId, levelId);
    keywords.forEach(keyword => { if (!text.includes(keyword)) missing.push(`${itemId}/${levelId}：${keyword}`); });
  });
  assert(missing.length === 0, `字典里缺少这些项目：${missing.join('；')}`);

  const pending = ['wrestling', 'dragon', 'changquan', 'orienteering', 'roller', 'ropeSkipping']
    .flatMap(itemId => ['L2', 'L3', 'L4'].flatMap(levelId => catalog.listUnitTopics(itemId, levelId)))
    .filter(catalog.isUnitTopicPending);
  ['少年拳第一套', '少年拳第二套', '实战对抗赛', '裁判规则', '舞龙比赛', '网绳'].forEach(keyword => {
    assert(pending.some(topic => topic.includes(keyword)), `${keyword} 属于无法确认的内容，应标 [待确认]`);
  });
});

await test('㉟ 选题的全部维度完整进 prompt：清单 + 逐维度课时配额（篮球/水平二，含观赏）', async () => {
  const list = catalog.unitTopicListWithDimension('basketball', 'L2');
  const built = buildUnitRequest({
    category: '球类', item: '篮球', level: '水平二（3–4 年级）', topic: '双手胸前投篮（小篮球规则、低篮架）',
    stage: 'analysis', itemId: 'basketball', levelId: 'L2', topicList: list,
  });
  const prompt = built.messages[1].content;

  // ① 清单里的每一条都要出现（不能因为清洗上限丢维度）
  list.forEach(entry => {
    const body = entry.replace(/^【[^】]+】/, '');
    assert(prompt.includes(body), `prompt 里缺少清单条目：${entry}`);
  });
  // ② 六个维度全部出现
  const stats = unitDimensionStats(list);
  ['基础知识', '基本技术', '体能', '比赛', '规则', '观赏'].forEach(label => {
    assert(stats.some(stat => stat.label === label), `维度统计缺少：${label}`);
    assert(prompt.includes(`【${label}】`), `prompt 里缺少维度：${label}`);
  });
  // ③ 配额：每个维度 ≥1，合计正好 18
  const quota = unitDimensionQuota(stats);
  equal(quota.reduce((sum, item) => sum + item.lessons, 0), 18, '维度配额合计必须是 18 课时');
  quota.forEach(item => assert(item.lessons >= 1, `${item.label} 至少要 1 个课时`));
  assert(prompt.includes('维度配额') || prompt.includes('按下面的配额分配'), 'prompt 要给出维度配额');
  // ④ 七大维度 → 四条泳道的归并规则要写清楚（AI 才知道节点该放哪一行）
  assert(prompt.includes('专项体能→基本技术'), '要给出维度 → 泳道的归并对照');
  assert(prompt.includes('规则与裁判→技战术运用'), '要给出维度 → 泳道的归并对照');
  assert(prompt.includes('观赏与评价→展示或比赛'), '要给出维度 → 泳道的归并对照');
  // ⑤ 结构图阶段的节点契约（18 个节点 + 四条泳道 + 主要项目）
  const structurePrompt = buildUnitRequest({
    ...UNIT_SELECTION, stage: 'structure', itemId: 'basketball', levelId: 'L3',
  }).messages[1].content;
  assert(structurePrompt.includes('structure_nodes'), '结构图阶段要输出 structure_nodes');
  assert(structurePrompt.includes('main_projects'), '结构图阶段要输出 main_projects');
  assert(structurePrompt.includes('基础知识 / 基本技术 / 技战术运用 / 展示或比赛'), '节点维度只能是四条泳道');
});

await test('㊱ 阶段②/③/④ 的上下文必须同时保住「教学内容清单」与「18 课次框架」', async () => {
  // 以前是"拼完再整体截断"，1200 字上限会把这两段砍掉 —— 现在按优先级保留
  const context = {
    unitTitle: '水平三篮球大单元',
    topicList: catalog.unitTopicListWithDimension('basketball', 'L3'),   // 20 条，含维度前缀
    objectives: '运动能力：能完成原地单手肩上投篮\n健康行为：养成锻炼习惯\n体育品德：遵守规则、尊重对手',
    teachingContent: '本单元覆盖运球、传接球、投篮、战术配合、体能、比赛、规则与观赏八个方面的内容。'.repeat(3),
    keyDifficulties: { learning: '出手角度', content: '上下肢协调用力', organization: '分组轮换', method: '分解到完整' },
    lessonTitles: Array.from({ length: 18 }, (_, index) => ({ no: index + 1, title: `第${index + 1}课次：项目${index + 1}` })),
  };
  // 收尾模块（tail / closing）不写课时，输入不是瓶颈 → 带完整清单与维度配额
  ['closing', 'rubric'].forEach(stage => {
    const built = buildUnitRequest({
      ...UNIT_SELECTION, stage, itemId: 'basketball', levelId: 'L3', context,
    });
    const prompt = built.messages[1].content;
    assert(prompt.includes('本细项·本水平的教学内容清单'), `${stage} 阶段的上下文丢了教学内容清单`);
    ['【基本技术】', '【战术】', '【体能】', '【比赛】', '【规则】'].forEach(tag => {
      assert(prompt.includes(tag), `${stage} 阶段的上下文丢了${tag}维度`);
    });
    assert(prompt.includes('18 课次框架'), `${stage} 阶段的上下文丢了 18 课次框架`);
    assert(prompt.includes('第18课次'), `${stage} 阶段的上下文里 18 课次框架不完整`);
    assert(prompt.includes('按下面的配额分配'), `${stage} 阶段要有维度配额`);
  });

  // 课时表批次：只带"本批次涉及的维度"的条目，其余维度一律不带（把 token 让给输出）
  const plan = unitLessonPlan(catalog.unitTopicListWithDimension('basketball', 'L3'));
  UNIT_LESSON_BATCHES.forEach(([from, to]) => {
    const built = buildUnitRequest({
      ...UNIT_SELECTION, stage: 'lessons', itemId: 'basketball', levelId: 'L3', from, to, context,
    });
    const prompt = built.messages[1].content;
    const batchDimensions = [...new Set(plan.filter(row => row.no >= from && row.no <= to).map(row => row.dimension))];
    assert(batchDimensions.length >= 1, `第 ${from}–${to} 批次应有维度`);
    const labelOf = id => (catalog.UNIT_DIMENSIONS.find(dimension => dimension.id === id) || {}).label;
    batchDimensions.forEach(id => {
      assert(prompt.includes(`【${labelOf(id)}】`), `第 ${from}–${to} 批次必须带上本批用到的【${labelOf(id)}】条目`);
    });
    catalog.UNIT_DIMENSIONS.filter(dimension => !batchDimensions.includes(dimension.id)).forEach(dimension => {
      assert(!prompt.includes(`【${dimension.label}】`),
        `第 ${from}–${to} 批次不该带【${dimension.label}】条目（本批用不到，会白白吃掉输出预算）`);
    });
    // 课次框架仍要带（否则批次之间不连贯）
    assert(prompt.includes('18 课次框架'), `第 ${from}–${to} 批次的上下文丢了 18 课次框架`);
  });
  // 优先级：空间不够时先丢"主要教学内容"这类次要段落，清单与课次框架必须留下
  const tight = unitContextBrief({ ...context, teachingContent: '很'.repeat(5000) }, 700);
  assert(tight.length <= 700, `上下文不能超过上限（实际 ${tight.length} 字）`);
  assert(tight.includes('教学内容清单'), '空间不足时也必须保住教学内容清单');
  assert(tight.includes('第18课次'), '空间不足时也必须保住完整的 18 课次框架');
  const teachingLine = tight.split('\n').find(line => line.startsWith('主要教学内容')) || '';
  assert(teachingLine.length < 120,
    `次要段落（主要教学内容）要被截断或整段丢掉，不能挤占清单与课次框架（实际 ${teachingLine.length} 字）`);
  ['【基本技术】', '【战术】', '【规则】'].forEach(tag => {
    assert(tight.includes(tag), `空间不足时清单里的${tag}维度也必须留下`);
  });
});

await test('㊲ 18 课时按多维结构落地：lesson.dimension + 结构图泳道 + 维度覆盖统计', async () => {
  // ① 模型层：结构图 = 4 条维度泳道，且兼容七大维度键与中文标签
  const laneIds = model.UNIT_MATRIX_DIMENSIONS.map(dimension => dimension.id);
  ['basic', 'technique', 'tactics', 'match'].forEach(id => {
    assert(laneIds.includes(id), `结构图缺少泳道：${id}`);
  });
  equal(model.UNIT_MATRIX_DIMENSIONS.length, 4, '矩阵固定 4 条维度泳道');
  equal(model.unitMatrixDimensionLabel('tactic'), '技战术运用', '战术维度要落到「技战术运用」泳道');
  equal(model.unitMatrixDimensionLabel('fitness'), '基本技术', '专项体能要落到「基本技术」泳道');
  equal(model.unitMatrixDimensionLabel('rule'), '技战术运用', '规则与裁判要落到「技战术运用」泳道');
  equal(model.unitMatrixDimensionLabel('watch'), '展示或比赛', '观赏与评价要落到「展示或比赛」泳道');
  equal(model.unitMatrixDimensionId('展示或比赛'), 'match', '中文标签也要能反查泳道 id');

  // ② 旧版「七大维度分支」数据要自动迁移成新矩阵节点（老师以前存的内容不能白丢）
  const normalized = model.normalizeUnit({
    structure: { tactic: [{ no: 11, title: '传切配合' }], watch: [{ no: 18, title: '观看比赛' }] },
    lessons: [{ no: 1, dimension: 'technique', content: '原地运球' }],
    meta: { dimensions: ['technique', 'match'] },
  });
  equal(normalized.structure_nodes.length, 2, '旧分支数据要迁成矩阵节点');
  equal(normalized.structure_nodes[0].dimension, '技战术运用', 'tactic 分支的节点落到「技战术运用」泳道');
  equal(normalized.structure_nodes[1].dimension, '展示或比赛', 'watch 分支的节点落到「展示或比赛」泳道');
  equal(normalized.structure_nodes[0].id, 11, '节点要保住课次号');
  equal(normalized.lessons[0].dimension, 'technique', '课时的 dimension 要保留');
  equal(normalized.meta.dimensions.length, 2, 'meta.dimensions 要保留');
  equal(normalized.structure, undefined, '旧分支结构迁移后不再保留');

  // ③ AI 输出带 dimension 时，18 课时的维度覆盖可统计
  const unit = model.createEmptyUnit();
  const quota = unitDimensionQuota(unitDimensionStats(catalog.unitTopicListWithDimension('basketball', 'L2')));
  let no = 1;
  quota.forEach(item => {
    for (let index = 0; index < item.lessons; index += 1) {
      unit.lessons[no - 1].dimension = item.id;
      no += 1;
    }
  });
  const coverage = model.unitDimensionCoverage(unit);
  equal(Object.keys(coverage).length, quota.length, '维度覆盖的维度数应与配额一致');
  quota.forEach(item => equal(coverage[item.id].length, item.lessons, `${item.label} 的课时数应与配额一致`));

  // ④ 课时的 dimension 要能落到结构图对应泳道（AI 没给结构图时的兜底补齐）
  const filled = model.autoFillStructure({ ...unit, structure_nodes: [] });
  equal(filled.structure_nodes.length, 18, '兜底补齐后 18 个课次都要挂载');
  ['基础知识', '基本技术', '技战术运用', '展示或比赛'].forEach(dimension => {
    assert(filled.structure_nodes.some(node => node.dimension === dimension),
      `兜底补齐后要有「${dimension}」泳道的节点`);
  });

  // ⑤ 七大维度键 → 泳道的对照表本身要完整
  Object.keys(UNIT_DIMENSION_BRANCH).forEach(dimensionId => {
    assert(model.unitMatrixDimensionId(dimensionId), `维度键 ${dimensionId} 找不到对应泳道`);
  });
});

await test('㊳ 18 课次计划表：课次号 / 维度 / 具体项目一一排定，18 批合起来覆盖全部维度', async () => {
  const list = catalog.unitTopicListWithDimension('basketball', 'L3');
  const plan = unitLessonPlan(list);
  equal(plan.length, 18, '计划表必须是 18 个课次');
  // 课次号连续、不重不漏
  plan.forEach((row, index) => equal(row.no, index + 1, `第 ${index + 1} 行的课次号不对`));
  // 计划覆盖清单里的每一个维度，且每个维度 ≥1 课时
  const stats = unitDimensionStats(list);
  const quota = unitDimensionQuota(stats);
  equal(quota.reduce((sum, item) => sum + item.lessons, 0), 18, '配额合计 18 课时');
  quota.forEach(item => {
    const rows = plan.filter(row => row.dimension === item.id);
    equal(rows.length, item.lessons, `${item.label} 的计划课次数应与配额一致`);
    rows.forEach(row => assert(row.topic && row.topic.length > 2, `第 ${row.no} 课次要有具体项目`));
  });
  // 项目要真的来自清单（不能凭空编）
  const topicTexts = list.map(entry => entry.replace(/^【[^】]+】/, '').replace(/^\[待确认\]\s*/, '').trim());
  plan.forEach(row => {
    const base = row.topic.replace(/（进阶提高）|（综合运用与比赛检验）/, '');
    assert(topicTexts.includes(base), `第 ${row.no} 课次的项目不在清单里：${row.topic}`);
  });
  // 18 批的划分：每批 1 个课时，合起来正好 1–18
  const covered = UNIT_LESSON_BATCHES.flatMap(([from, to]) => plan.filter(row => row.no >= from && row.no <= to));
  equal(covered.length, 18, '18 批合起来必须覆盖 18 个课次');
  UNIT_LESSON_BATCHES.forEach(([from, to]) => equal(to - from + 1, 1, '每批固定 1 个课时'));
  equal(UNIT_LESSON_BATCHES.map(([from]) => from).join(','), '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18', '课次号 1–18 各一次');
  // 计划可复算：同一份清单每次算出来都一样（否则三批并发会排乱）
  const again = unitLessonPlan(list);
  equal(JSON.stringify(again), JSON.stringify(plan), '计划表必须是确定性的（并发依赖这一点）');
});

await test('㊴ 截断 JSON 强制修复：断在字符串里 / 断在冒号后 / 断在对象里都能救回已生成的课时', async () => {
  const full = {
    lessons: Array.from({ length: 6 }, (_, index) => ({
      no: index + 1,
      dimension: 'technique',
      objectives: '1.运动能力：能完成\n2.健康行为：愿参与\n3.体育品德：守规则',
      content: `内容${index + 1}`,
      method: `教法${index + 1}`,
    })),
    assessment: '考核',
  };
  const text = JSON.stringify(full);
  // ① 断在字符串中间
  const cutInString = text.slice(0, text.indexOf('"content":"内容4"') + 12);
  const repaired1 = repairTruncatedJSON(cutInString);
  assert(repaired1 && Array.isArray(repaired1.lessons), '断在字符串里也要能救出 lessons');
  assert(repaired1.lessons.length >= 3, `应保住前 3 个完整课时（实际 ${repaired1.lessons.length}）`);
  equal(repaired1.lessons[0].content, '内容1', '已生成的课时内容要原样保住');
  // ② 断在键名/冒号后面（老写法补括号会失败，因为补出来是 {"method":}）
  const cutAfterColon = text.slice(0, text.indexOf('"method":"教法4"') + 10);
  const repaired2 = repairTruncatedJSON(cutAfterColon);
  assert(repaired2 && Array.isArray(repaired2.lessons), '断在冒号后也要能救回');
  // ③ 断在嵌套对象里
  const cutInObject = text.slice(0, text.indexOf('"objectives":{"ability":"能完成","health":"愿参与","char') + 60);
  const repaired3 = repairTruncatedJSON(cutInObject);
  assert(repaired3 && Array.isArray(repaired3.lessons), '断在嵌套对象里也要能救回');
  // 完整的 JSON 原样返回；彻底无效的返回 null 而不是抛异常
  equal(JSON.stringify(repairTruncatedJSON(text)), JSON.stringify(full), '完整 JSON 要原样解析');
  equal(repairTruncatedJSON('完全不是JSON'), null, '彻底无效时返回 null');
  equal(repairTruncatedJSON(''), null, '空内容返回 null');
  // 页面里的 recoverPartialUnitJSON 走的就是这套实现
  const env = createUnitEnv();
  const partial = env.api.recoverPartialUnitJSON(cutInString);
  assert(partial && Array.isArray(partial.lessons), '页面函数要复用这套修复逻辑');
});

await test('㊵ 一键生成：22 次请求（分析 + 结构图 + 18 个课时 + 收尾 + 量规），合并成完整 18 课时', async () => {
  const env = createUnitEnv();
  selectUnitTopic(env);
  const list = catalog.unitTopicListWithDimension('basketball', 'L3');
  const plan = unitLessonPlan(list);
  const calls = [];
  env.context.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.stage === 'analysis_part1') {
      // 前置分析第一段（模块 1–3）：分隔符 + 纯文本
      return fakeStream([
        '===TITLE===', '篮球大单元', '',
        '===OBJECTIVES===', '1.运动能力：能投篮', '2.健康行为：爱运动', '3.体育品德：守规则', '',
        '===TEXTBOOK===', '教材分析', '',
        '===STUDENTS===', '学情分析',
      ].join('\n'));
    }
    if (body.stage === 'analysis_part2') {
      // 前置分析第二段（模块 4–5）
      return fakeStream([
        '===CONTENT===', '教学内容', '',
        '===DIFFICULTIES===',
        '学生学习重难点：重点：学重点 难点：学难点',
        '学习内容重难点：重点：内重点 难点：内难点',
        '教学组织重难点：重点：组重点 难点：组难点',
        '教学方法重难点：重点：法重点 难点：法难点',
      ].join('\n'));
    }
    if (body.stage === 'structure') {
      return fakeStream(JSON.stringify({
        structure_nodes: plan.map((row, index) => ({ id: index + 1, dimension: '基本技术', title: `第${index + 1}课次` })),
        main_projects: ['篮球运球'],
      }));
    }
    if (body.stage === 'lesson_single') {
      const no = body.lessonNo ?? body.startLesson ?? body.from;
      return fakeStream(lessonSinglePayload(no));
    }
    if (body.stage === 'lessons') {
      // 纯文本阶段：一行 Markdown 表格
      const no = body.startLesson ?? body.from;
      return fakeStream([
        '===DIMENSION===', plan[no - 1].dimension, '',
        '===LESSON===',
        '| 课次 | 学习目标 | 主要学习内容 | 教学策略与学练活动 |',
        '| --- | --- | --- | --- |',
        `| 第${no}课次 | 1.运动能力：能力${no}<br>2.健康行为：健康${no}<br>3.体育品德：品德${no} | 1.热身：阶段二内容${no}<br>2.学练：急停急起<br>3.比赛：2对2对抗<br>4.体能：折返跑 | 情境导入：视频欣赏<br>教法：示范分层<br>评价：师评自评 |`,
      ].join('\n'));
    }
    if (body.stage === 'closing') {
      return fakeStream(JSON.stringify({
        assessment: '考核',
        reflection: '反思',
      }));
    }
    if (body.stage === 'rubric') return fakeStream(rubricTextPayload());
    return fakeStream('{}');
  };

  await env.api.generateWholeUnit();
  // ① 固定 22 次请求：analysis + structure + 18 批 lessons + closing + rubric
  const stageCounts = calls.reduce((map, body) => {
    map[body.stage] = (map[body.stage] || 0) + 1;
    return map;
  }, {});
  equal(stageCounts.analysis_part1, 1, '前置分析第一段只请求一次');
  equal(stageCounts.analysis_part2, 1, '前置分析第二段只请求一次');
  equal(stageCounts.structure, 1, '结构图只请求一次');
  equal(stageCounts.lesson_single, 18, '课时表必须 18 次请求（一次一个课时）');
  equal(stageCounts.closing, 1, '收尾只请求一次');
  equal(stageCounts.rubric, 1, '评价量规只请求一次');
  const ranges = calls.filter(body => body.stage === 'lesson_single')
    .map(body => `${body.lessonNo}`)
    .sort((a, b) => Number(a) - Number(b));
  equal(ranges.join(','), '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18',
    '18 次请求的课次号必须是 1–18 各一次');

  // ② 18 课时合并后齐全，且维度按计划排布
  const unit = env.api.getUnit();
  equal(unit.lessons.length, 18, '合并后仍是 18 个课时');
  equal(env.api.unitMissingLessonNumbers().length, 0, '不应有缺失课时');
  unit.lessons.forEach((lesson, index) => {
    equal(lesson.content.includes(`阶段二内容${index + 1}`), true,
      `第 ${index + 1} 课时要落在正确的位置（按 no 落位，不能按返回顺序错位）`);
    equal(lesson.dimension, plan[index].dimension, `第 ${index + 1} 课时的维度要符合计划表`);
    assert(lesson.objectives.includes('运动能力'), `第 ${index + 1} 课时的三维目标要落库`);
  });
  // ③ 结构图与收尾模块也拿到了
  equal(unit.structure_nodes.length, 18, '结构图 18 个节点');
  equal(env.api.unitTailMissing().length, 0, '模块 8–11 应齐全');

  /* ---- 换一个脚本：某一课被截断 → 流水线继续跑完 → 弹窗提示补全 ---- */
  const env2 = createUnitEnv();
  selectUnitTopic(env2);
  env2.context.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.stage === 'analysis_part1') {
      return fakeStream(['===TITLE===', '篮球大单元', '', '===OBJECTIVES===', '1.运动能力：能投篮', '2.健康行为：爱运动', '3.体育品德：守规则'].join('\n'));
    }
    if (body.stage === 'analysis_part2') {
      return fakeStream(['===CONTENT===', '教学内容'].join('\n'));
    }
    if (body.stage === 'structure') {
      return fakeStream(JSON.stringify({
        structure_nodes: plan.map((row, index) => ({ id: index + 1, dimension: '基本技术', title: `第${index + 1}课次` })),
      }));
    }
    if (body.stage === 'lesson_single') {
      const no = body.lessonNo ?? body.startLesson ?? body.from;
      // 「被掐断」必须模拟成 AI 一个字都没吐出来：解析器现在极度容错，
      // 半截表格也会救回上屏、课次不再算缺失（这正是「有字就得看到字」的契约）。
      if (no === 14) return fakeStream('', { truncate: true });
      return fakeStream(lessonSinglePayload(no));
    }
    if (body.stage === 'lessons') {
      const no = body.startLesson ?? body.from;
      if (no === 14) return fakeStream('', { truncate: true });
      return fakeStream([
        '===DIMENSION===', plan[no - 1].dimension, '',
        '===LESSON===',
        '| 课次 | 学习目标 | 主要学习内容 | 教学策略与学练活动 |',
        '| --- | --- | --- | --- |',
        `| 第${no}课次 | 1.运动能力：能力${no}<br>2.健康行为：健康${no}<br>3.体育品德：品德${no} | 1.热身：阶段二内容${no}<br>2.学练：急停急起<br>3.比赛：2对2对抗<br>4.体能：折返跑 | 情境导入：视频欣赏<br>教法：示范分层<br>评价：师评自评 |`,
      ].join('\n'));
    }
    if (body.stage === 'closing') return fakeStream(JSON.stringify({ assessment: '考核', reflection: '反思' }));
    if (body.stage === 'rubric') return fakeStream(rubricTextPayload());
    return fakeStream('{}');
  };
  await env2.api.generateWholeUnit();
  const missing = env2.api.unitMissingLessonNumbers();
  assert(missing.includes(14), `第 14 课次应缺失（实际缺 ${missing.join('、')}）`);
  assert(!missing.includes(13) && !missing.includes(15),
    '其它课次照常生成，不能被牵连（一次只写一个课时，互不影响）');
  const dialog = env2.overlays.find(overlay => /补全/.test(overlay.title || ''));
  assert(dialog, '缺课次时要弹窗提示');
  assert(/课次缺失/.test(dialog.title) && /点击【补全】按钮单独生成该课次/.test(dialog.title),
    `弹窗标题要给出缺失课次与补全入口（实际：${dialog.title}）`);
  assert(/generateLessonTableOnly\(\)/.test(dialog.footerHTML), '弹窗的【补全】按钮要能直接补生成');
});
/** 从结构矩阵 HTML 里抽出每一行：{ head, cells, raw } */
function parseMatrixRows(html) {
  const rows = [];
  const re = /<tr class="ud2-mx-row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  let hit = re.exec(String(html || ''));
  while (hit) {
    const raw = hit[0];
    const headMatch = raw.match(/<th class="ud2-mx-rowhead"[^>]*>([\s\S]*?)<\/th>/);
    const cells = (raw.match(/<td class="ud2-mx-cell[^"]*"[^>]*>[\s\S]*?<\/td>/g) || []);
    rows.push({ head: headMatch ? headMatch[1].trim() : '', cells, raw });
    hit = re.exec(String(html || ''));
  }
  return rows;
}

await test('㊶ 结构图是"4 条维度泳道 × 18 个课次"的矩阵，底部并一行「主要项目」', async () => {
  const { api } = createUnitEnv();
  api.applyGeneratedUnit(sampleGenerated(), null);
  const html = api.renderUnitModuleBody('structure');

  // 外层：横向滚动 + 连线层（SVG）
  assert(html.includes('ud2-mx-scroll'), '结构图外层要有横向滚动容器');
  assert(html.includes('<svg class="ud2-mx-links"'), '要有独立的连线层（SVG）');
  const css = fs.readFileSync(path.join(ROOT, 'css/sports-meet.css'), 'utf8');
  assert(/\.ud2-mx-scroll\s*\{[^}]*overflow-x:\s*auto/.test(css), '滚动容器要允许横向滚动（节点不被挤压变形）');

  // 表头：1–18 课次
  const colHeads = html.match(/<th class="ud2-mx-colhead"[^>]*>(\d+)<\/th>/g) || [];
  equal(colHeads.length, 18, 'X 轴必须是 18 个课次列');
  assert(html.includes('维度 \\ 课次'), '左上角要有「维度 \\ 课次」角标');

  // 行：4 条泳道 + 主要项目
  const rows = parseMatrixRows(html);
  equal(rows.length, 5, 'Y 轴必须是 4 条维度泳道 + 1 行主要项目');
  ['基础知识', '基本技术', '技战术运用', '展示或比赛', '主要项目'].forEach((label, index) => {
    equal(rows[index].head, label, `第 ${index + 1} 行行头不对`);
  });
  rows.slice(0, 4).forEach((row, index) => {
    equal(row.cells.length, 18, `第 ${index + 1} 条泳道必须正好 18 个格子`);
  });
  assert(rows[4].raw.includes('colspan="18"'), '「主要项目」行必须跨列合并（colspan=18）');
  assert(rows[4].raw.includes('main_projects.0'), '「主要项目」行要能编辑主要项目');
});

await test('㊷ 节点按 dimension 放进对应泳道的对应课次格子里', async () => {
  const { api } = createUnitEnv();
  api.setUnit(api.createEmptyUnit());
  api.applyGeneratedUnit({
    ...sampleGenerated(),
    structure_nodes: [
      { id: 1, dimension: '基础知识', title: '认识篮球' },
      { id: 2, dimension: '基本技术', title: '原地运球' },
      { id: 3, dimension: '技战术运用', title: '二打一配合' },
      { id: 4, dimension: '展示或比赛', title: '教学比赛' },
    ],
  }, null);
  const rows = parseMatrixRows(api.renderUnitModuleBody('structure'));

  // 行序：基础知识 / 基本技术 / 技战术运用 / 展示或比赛
  assert(rows[0].cells[0].includes('data-no="1"'), '第 1 课次要落在「基础知识」行');
  assert(!rows[0].cells[1].includes('data-no="1"'), '第 1 课次不能同时出现在别的行');
  assert(rows[1].cells[1].includes('data-no="2"'), '第 2 课次要落在「基本技术」行');
  assert(rows[2].cells[2].includes('data-no="3"'), '第 3 课次要落在「技战术运用」行');
  assert(rows[3].cells[3].includes('data-no="4"'), '第 4 课次要落在「展示或比赛」行');
  // 节点卡片：序号 + 标题 + 维度下拉
  assert(rows[0].cells[0].includes('ud2-mx-node-no">1<'), '节点要有课次序号');
  assert(rows[0].cells[0].includes('认识篮球'), '节点要有课次标题');
  assert(rows[0].cells[0].includes('ud2-mx-node-dim'), '节点要能改归属维度');
  assert(rows[0].cells[0].includes('structure_nodes.0.title'), '标题要绑定到对应的节点下标');
});

await test('㊸ 基础连线：按 1→18 顺序把相邻节点连起来，带箭头且不压住卡片', async () => {
  const env = createUnitEnv();
  const { api } = env;
  // 造一个"有尺寸"的矩阵 DOM：18 个节点按泳道分布（前 2 个在基础知识行，其余在基本技术行）
  const nodes = Array.from({ length: 18 }, (_, index) => {
    const row = index < 2 ? 'basic' : 'technique';
    const top = row === 'basic' ? 30 : 120;
    return {
      dataset: { no: String(index + 1), row },
      style: {},
      getBoundingClientRect: () => ({
        left: 100 + index * 60, right: 100 + index * 60 + 56,
        top, bottom: top + 40, width: 56, height: 40,
      }),
    };
  });
  const inner = {
    scrollWidth: 1400, scrollHeight: 420,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1400, bottom: 420, width: 1400, height: 420 }),
    querySelectorAll: () => nodes,
  };
  const svg = { innerHTML: '', setAttribute() {} };
  env.context.document.querySelector = selector => (
    selector === '.ud2-mx-inner' ? inner : (selector === '.ud2-mx-links' ? svg : null)
  );

  api.unitMatrixDrawLinks();
  const markup = svg.innerHTML;
  const paths = markup.match(/<path class="ud2-mx-link/g) || [];
  equal(paths.length, 17, '18 个节点之间要有 17 条连线');
  assert(markup.includes('marker-end="url(#ud2-mx-arrow)"'), '每条连线都要带箭头');
  assert(markup.includes('id="ud2-mx-arrow"'), '要定义箭头 marker');
  assert(markup.includes('is-cross'), '跨泳道的连线要单独标记（is-cross）');
  assert(!markup.includes('is-cross" d="M 156 50'), '同一泳道内不应标成跨行');
});

await test('㊹ 主要项目：AI 给的 1–3 个项目要能合并、能落库、能显示在合并行里', async () => {
  const { api } = createUnitEnv();
  api.setUnit(api.createEmptyUnit());
  api.mergeUnitStage({ main_projects: ['篮球运球', '传切配合'] }, null, 'structure');
  equal(api.getUnit().main_projects.length, 2, '主要项目要落库');
  const html = api.renderUnitModuleBody('structure');
  assert(html.includes('篮球运球'), '合并行里要显示主要项目');
  assert(html.includes('ud2-mx-row-main'), '要有「主要项目」这一行');
  api.mergeUnitStage({ main_projects: '原地运球、传接球、三打三' }, null, 'structure');
  equal(api.getUnit().main_projects.length, 3, '顿号分隔的写法也要认，最多 3 个');
});

await test('㊺ 结构图节点按课次号落位：AI 只回一部分也不会错位', async () => {
  const { api } = createUnitEnv();
  api.setUnit(api.createEmptyUnit());
  api.mergeUnitStage({
    structure_nodes: [
      { id: 7, dimension: '技战术运用', title: '战术基础' },
      { id: 3, dimension: '基本技术', title: '运球技术' },
    ],
  }, null, 'structure');
  const list = api.getUnit().structure_nodes;
  equal(list.length, 2, '两个节点都要收下');
  equal(list[0].id, 3, '节点要按课次号排序');
  equal(list[1].id, 7, '节点要按课次号排序');
  equal(list[0].dimension, '基本技术', '维度要归一到四条泳道');
  equal(list[1].dimension, '技战术运用', '维度要归一到四条泳道');
  // 维度写错 / 写别名时也要能兜住
  api.mergeUnitStage({ structure_nodes: [{ id: 9, dimension: 'fitness', title: '体能练习' }] }, null, 'structure');
  equal(api.getUnit().structure_nodes.find(node => node.id === 9).dimension, '基本技术',
    '七大维度键要能映射到四条泳道');
});

await test('㊻ 课时表不再展示「维度」列，但底层照旧记录维度', async () => {
  const { api } = createUnitEnv();
  api.setUnit(api.createEmptyUnit());

  // ① 底层数据模型：一行没动 —— AI 给的维度照旧落库
  api.mergeUnitStage({
    lessons: [
      { no: 1, dimension: 'basic', content: '认识篮球', method: '讲解示范' },
      { no: 2, dimension: 'technique', content: '原地运球', method: '分层练习' },
    ],
  }, null, 'lessons');
  equal(api.getUnit().lessons[0].dimension, 'basic', '底层仍要记录第 1 课的维度');
  equal(api.getUnit().lessons[1].dimension, 'technique', '底层仍要记录第 2 课的维度');

  // ② 前端展示：表头与每行的「维度」列都没了
  const html = api.renderUnitModuleBody('lessons');
  assert(!/>维度</.test(html), '课时表不应再有「维度」表头');
  assert(!html.includes('data-unit-path="lessons.0.dimension"'), '课时表不应再有维度下拉框');
  assert(!html.includes('unitDimensionOptions'), '不该再渲染维度下拉');
  const headBlock = (html.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
  const heads = headBlock.match(/<th\b[^>]*>/g) || [];
  equal(heads.length, 4, '课时表表头应是 4 列（课次 / 学习目标 / 主要学习内容 / 教学策略）');

  // ③ 腾出来的宽度分给「教学内容」和「组织教学与方法」
  assert(html.includes('width:34%">主要学习内容（结构化）'), '主要学习内容列要占 34%');
  assert(html.includes('width:31%">教学策略 / 学练活动'), '教学策略列要占 31%');

  // ④ 依赖底层的统计照旧在
  assert(html.includes('维度分布'), '顶部的维度分布统计要保留（它读的是底层 dimension）');
});

await test('㊼ 单元学习评价表：四等级 + 素养占比 60/20/20 + 得分点合计 100 分', async () => {
  const { api } = createUnitEnv();
  api.setUnit(api.createEmptyUnit());

  // ① 标准模板：等级、占比、得分点都要齐
  const rubric = api.getUnit().rubric;
  equal(rubric.levels.length, 4, '要有四个等级');
  equal(rubric.levels.map(level => level.range).join(','), '85-100,75-84,60-74,60以下', '等级区间要符合课标');
  equal(rubric.levels.map(level => level.name).join(','), '优秀,良好,合格,不合格', '等级名称要对');
  const weights = Object.fromEntries(rubric.literacyWeights.map(item => [item.name, item.percent]));
  equal(weights['运动能力'], 60, '运动能力占 60%');
  equal(weights['健康行为'], 20, '健康行为占 20%');
  equal(weights['体育品德'], 20, '体育品德占 20%');
  const total = rubric.scoreItems.reduce((sum, item) => sum + item.points, 0);
  equal(total, 100, '细分得分点合计 100 分');
  const byLiteracy = rubric.scoreItems.reduce((acc, item) => {
    acc[item.literacy] = (acc[item.literacy] || 0) + item.points;
    return acc;
  }, {});
  equal(byLiteracy['运动能力'], 60, '运动能力得分点合计 60 分');
  equal(byLiteracy['健康行为'], 20, '健康行为得分点合计 20 分');
  equal(byLiteracy['体育品德'], 20, '体育品德得分点合计 20 分');
  assert(rubric.scoreItems.some(item => item.name === '运动知识' && item.points === 12), '要有"运动知识 12 分"');
  assert(rubric.scoreItems.some(item => item.name === '运动技能' && item.points === 36), '要有"运动技能 36 分"');

  // ② 前端渲染成量规表
  const html = api.renderUnitModuleBody('rubric');
  assert(html.includes('ud2-rubric-table'), '要有量规表');
  assert(html.includes('优秀') && html.includes('85-100'), '表里要有等级与区间');
  assert(html.includes('运动能力') && html.includes('60'), '表里要有素养占比');
  assert(html.includes('运动知识') && html.includes('36'), '表里要有细分得分点');
  assert(html.includes('data-unit-path="rubric.note"'), '要有可编辑的评价说明');

  // ③ AI 返回的 rubric 能落库，残缺的自动补成标准模板
  api.mergeUnitStage({
    rubric: { levels: [{ name: '优秀', range: '85-100', ability: '好' }], note: '师评为主' },
  }, null, 'rubric');
  const stored = api.getUnit().rubric;
  equal(stored.levels.length, 4, '只有 1 个等级时要补齐成 4 个');
  equal(stored.literacyWeights.length, 3, '缺占比时要补齐');
  equal(stored.scoreItems.length, 10, '缺得分点时要补齐');
  equal(stored.note, '师评为主', '评价说明要保留');
});

await test('㊽ Prompt 已按省级教研教案的规范改写', async () => {
  const stage1 = buildUnitRequest({ ...UNIT_SELECTION, stage: 'analysis_part1', itemId: 'basketball', levelId: 'L3' });
  const stage1b = buildUnitRequest({ ...UNIT_SELECTION, stage: 'analysis_part2', itemId: 'basketball', levelId: 'L3' });
  const prompt1 = stage1.messages[1].content;
  const prompt1b = stage1b.messages[1].content;
  // ① 学习目标：三段式（一行一段）+ 三维要素清单
  assert(prompt1.includes('教学目标三段'), '学习目标要强制写成三段');
  ['运动能力段写满', '健康行为段写满', '体育品德段写满'].forEach(key =>
    assert(prompt1.includes(key), `学习目标缺少要素清单：${key}`));
  assert(prompt1.includes('国家学生体质健康标准'), '学习目标要提到《国家学生体质健康标准》');
  assert(prompt1.includes('每周 3 次课外锻炼'), '健康行为要有课外锻炼频次');
  assert(prompt1.includes('每学期观看不少于 8 次比赛'), '运动能力要有观赛次数');
  // ② 教材分析：两段
  assert(prompt1.includes('必须分两段'), '教材分析要分两段');
  ['基础知识与基本技能', '技战术运用', '规则与裁判方法', '观赏与评价'].forEach(key =>
    assert(prompt1.includes(key), `教材分析第一段缺少：${key}`));
  assert(prompt1.includes('核心素养价值'), '教材分析第二段要写核心素养价值');
  // ③ 重难点：四维 + 重点/难点 + 原因 + 应对措施（这段在第二段请求里）
  assert(prompt1b.includes('重点：…… 难点：……'), '重难点要强制重点/难点写法');
  ['学生学习重难点', '学习内容重难点', '教学组织重难点', '教学方法重难点']
    .forEach(key => assert(prompt1b.includes(key), `重难点缺少子维度：${key}`));
  assert(prompt1b.includes('为什么它会成为重难点'), '重难点要写清"为什么是重难点"');
  assert(prompt1b.includes('具体怎么破'), '重难点要写清"怎么破"');

  // ④ 课时表：三段式目标 / 四要素内容 / 四要素策略 + 详实度要求（字数封印已解除）
  const batch = buildUnitRequest({ ...UNIT_SELECTION, stage: 'lessons', itemId: 'basketball', levelId: 'L3', from: 1, to: 6 });
  const prompt2 = batch.messages[1].content;
  assert(prompt2.includes('运动能力：'), '课时目标要三段式');
  assert(prompt2.includes('体育品德：'), '课时目标要三段式');
  ['热身小游戏', '技术学练', '展示与比赛', '体能练习'].forEach(key =>
    assert(prompt2.includes(key), `主要学习内容缺少：${key}`));
  ['情境导入', '教与学的方法', '比赛活动', '教学评价'].forEach(key =>
    assert(prompt2.includes(key), `教学策略缺少：${key}`));
  assert(prompt2.includes('120–180 字'), '每一格都要写 120–180 字的完整教学段落');
  assert(!prompt2.includes('每段不超过 20 字'), '不能再有 20 字上限（那会让教案干瘪）');
  assert(!prompt2.includes('每段不超过 50 字'), '不能再有 50 字上限（那会让教案干瘪）');
  assert(prompt2.includes('Markdown 有序列表'), '内容与策略要按 Markdown 列表逐项写');

  // ⑤ 模块 10：评价量规表的标准要写进 prompt
  const stage2 = buildUnitRequest({ ...UNIT_SELECTION, stage: 'rubric', itemId: 'basketball', levelId: 'L3' });
  const prompt3 = stage2.messages[1].content;
  ['85-100', '75-84', '60-74', '60以下'].forEach(range =>
    assert(prompt3.includes(range), `评价量规缺少等级区间：${range}`));
  assert(prompt3.includes('运动知识 12'), '评价量规要写明运动知识 12 分');
  assert(prompt3.includes('运动技能 36'), '评价量规要写明运动技能 36 分');
  assert(prompt3.includes('运动能力 60% / 健康行为 20% / 体育品德 20%'), '评价量规要写明素养占比');
  assert(prompt3.includes('| 核心素养 | 占比 |'), '评价量规要给出占比表的表头');
});

await test('㊾ 旧数据（拆分版三维目标）能自动并成段落文本，不报错也不丢内容', async () => {
  const { api } = createUnitEnv();
  api.setUnit(api.createEmptyUnit());
  // 旧版：教学目标是三个小字段、课时目标也是三个小字段
  api.mergeUnitStage({
    objectives: { ability: '旧能力', health: '旧健康', character: '旧品德' },
  }, null, 'analysis');
  api.mergeUnitStage({
    lessons: [{ no: 1, dimension: 'technique', objectives: { ability: '课能力', health: '课健康', character: '课品德' } }],
  }, null, 'lessons');
  const data = api.getUnit();
  assert(typeof data.objectives === 'string', '教学目标要并成一段文本');
  assert(data.objectives.includes('旧能力') && data.objectives.includes('旧健康') && data.objectives.includes('旧品德'),
    '三段内容一个都不能丢');
  assert(typeof data.lessons[0].objectives === 'string', '课时目标也要并成一段文本');
  assert(data.lessons[0].objectives.includes('课品德'), '课时的三维内容不能丢');
  equal(data.lessons[0].dimension, 'technique', '维度字段照旧保留');
  // 再走一遍 normalize（存进 localStorage 再读出来）也不能变形
  const again = api.normalizeUnit(JSON.parse(JSON.stringify(data)));
  assert(again.objectives.includes('旧能力'), '存取往返后内容仍在');
  equal(again.lessons[0].objectives, data.lessons[0].objectives, '存取往返后课时目标不变');
});

await test('㊿ 纯文本解析：分隔符切分 + 三段目标还原 + 四维重难点', async () => {
  const text = [
    '===TITLE===',
    '水平三篮球大单元',
    '',
    '===OBJECTIVES===',
    '1.运动能力：能力目标',
    '2.健康行为：健康目标',
    '3.体育品德：品德目标',
    '',
    '===TEXTBOOK===',
    '第一段教材分析',
    '',
    '第二段教材价值',
    '',
    '===STUDENTS===',
    '学情分析段落',
    '',
    '===CONTENT===',
    '1. 知识：篮球规则',
    '2. 技术：运球与投篮',
    '',
    '===DIFFICULTIES===',
    '学生学习重难点：重点：学重点 难点：学难点',
    '学习内容重难点：重点：内重点 难点：内难点',
    '教学组织重难点：重点：组重点 难点：组难点',
    '教学方法重难点：重点：法重点 难点：法难点',
  ].join('\n');
  const parsed = model.parseUnitAnalysisText(text);
  equal(parsed.unitTitle, '水平三篮球大单元', '单元名要切出来');
  equal(parsed.objectives, '运动能力：能力目标\n\n健康行为：健康目标\n\n体育品德：品德目标', '目标要还原成三段');
  assert(parsed.textbookAnalysis.includes('第一段教材分析') && parsed.textbookAnalysis.includes('第二段教材价值'),
    '教材分析两段都要保留');
  equal(parsed.studentAnalysis, '学情分析段落', '学情分析要切出来');
  assert(parsed.teachingContent.includes('知识：篮球规则'), '主要内容要切出来');
  equal(parsed.keyDifficulties.learning, '重点：学重点\n难点：学难点', '重难点要按子维度还原（重点/难点各一行）');
  equal(parsed.keyDifficulties.method, '重点：法重点\n难点：法难点', '教学方法子维度也要还原');
});

await test('㊿b 容错：少了分隔符的段落直接跳过，其余照常，绝不抛异常', async () => {
  const text = [
    '===TITLE===', '只剩单元名', '',
    '===OBJECTIVES===', '1.运动能力：能力目标', '2.健康行为：健康目标', '3.体育品德：品德目标',
  ].join('\n');
  const parsed = model.parseUnitAnalysisText(text);
  equal(parsed.unitTitle, '只剩单元名', '有的段照样解析');
  assert(parsed.objectives.includes('能力目标'), '目标照样解析');
  equal(parsed.textbookAnalysis, undefined, '缺的段不该出现（更不能是空串把老师已有内容覆盖掉）');
  equal(parsed.keyDifficulties, undefined, '缺的重难点段直接跳过');
  // 空文本、脏文本都不能抛异常
  ['', '   ', '随便一段没有分隔符的文本', '===OBJECTIVES===', '===\n==='].forEach(raw => {
    const out = model.parseUnitAnalysisText(raw);
    assert(out && typeof out === 'object', '脏文本也要安全返回');
  });
});

await test('㊿c 量规表纯文本解析：四等级 + 60/20/20 + 10 个得分点', async () => {
  const parsed = model.parseUnitRubricText(rubricTextPayload());
  equal(parsed.rubric.levels.length, 4, '要解析出 4 个等级');
  equal(parsed.rubric.levels[0].name, '优秀', '等级顺序要对');
  equal(parsed.rubric.levels[0].range, '85-100', '等级区间要保留');
  equal(parsed.rubric.levels[0].ability, '优能力', '三维描述要解析到对应列');
  equal(parsed.rubric.literacyWeights.length, 3, '素养占比要 3 项');
  equal(parsed.rubric.literacyWeights[0].percent, 60, '运动能力占比 60');
  equal(parsed.rubric.scoreItems.length, 10, '得分点要 10 条');
  equal(parsed.rubric.scoreItems[0].points, 12, '得分点分值要解析');
  equal(parsed.rubric.scoreItems[0].literacy, '运动能力', '得分点要带上核心素养');
  // 列表写法「- 运动知识：12分」也能认
  const listParsed = model.parseUnitRubricText('===SCORES===\n- 运动知识：12分\n- 运动技能：36分');
  equal(listParsed.rubric.scoreItems.length, 2, '列表写法也要能解析');
  equal(listParsed.rubric.scoreItems[1].points, 36, '列表写法的分值要对');
});

await test('㊿d 流水线：analysis 少几段也不失败，其它模块照常生成并落库', async () => {
  const env = createUnitEnv();
  selectUnitTopic(env);
  const calls = injectFakeAI(env, {
    stage1: stage1Payload(),
    stage2: stage2Payload(),
    analysisText: [
      '===TITLE===', '只有单元名', '',
      '===OBJECTIVES===', '1.运动能力：能力目标', '2.健康行为：健康目标', '3.体育品德：品德目标',
    ].join('\n'),
  });

  await env.api.generateWholeUnit();
  equal(calls.filter(call => call.stage === 'analysis_part1').length, 1, '前置分析第一段只请求一次（缺的只是可选段落，不该重试）');
  equal(calls.filter(call => call.stage === 'analysis_part2').length, 1, '前置分析第二段只请求一次');
  const data = env.api.getUnit();
  equal(data.unitTitle, '只有单元名', '有的段要落库');
  assert(data.objectives.includes('能力目标'), '目标要落库');
  equal(data.lessons.length, 18, '课时表照常生成');
  equal(env.api.unitMissingLessonNumbers().length, 0, '不该有缺失课时');
  equal(env.overlays.length, 0, '不该弹窗（缺的是可选段落，不是缺课次）');
});

await test('㊿e 课时表详实化：写足内容 + 小标题加粗 + 输入框自适应高度', async () => {
  const env = createUnitEnv();
  const parsed = model.parseUnitLessonText(lessonTextPayload(3));
  equal(parsed.lessons.length, 1, '一个课时要解析出一行');
  const lesson = parsed.lessons[0];
  assert(!lesson.objectives.includes('**'), '输入框里不该留 Markdown 星号');
  assert(lesson.objectives.startsWith('【学习目标】'), '小标题要保留（页面上用【】呈现）');
  assert(lesson.objectives.includes('运动能力：'), '三段式目标要保留');
  assert(lesson.content.includes('技术学练：'), '内容四要素要保留');
  assert(lesson.method.includes('教学评价：'), '策略四要素要保留');
  assert(lesson.objectives.split('\n').length >= 4, '换行要还原成多段（不能挤成一行）');

  // 渲染：输入框按内容给高度（有上下限，页面既不被撑爆也不被截字）
  const unit = env.api.createEmptyUnit();
  unit.lessons = Array.from({ length: 18 }, (_, index) => ({
    no: index + 1, dimension: 'technique',
    objectives: lesson.objectives, content: lesson.content, method: lesson.method,
  }));
  env.api.setUnit(env.api.normalizeUnit(unit));
  const html = env.api.renderUnitModuleBody('lessons');
  equal((html.match(/<textarea/g) || []).length, 54, '18 课 × 3 格 = 54 个输入框');
  const rows = [...html.matchAll(/rows="(\d+)"/g)].map(match => Number(match[1]));
  equal(rows.length, 54, '每个输入框都要有 rows');
  assert(Math.min(...rows) >= 6 && Math.max(...rows) <= 20, 'rows 要落在 6–20 之间（自适应但有上下限）');

  // 导出：换行还原成 <br>，【小标题】还原成加粗
  const exported = env.api.buildUnitExportHTML();
  assert(exported.includes('<b>【学习目标】</b>'), '导出时小标题要加粗');
  assert(exported.includes('<br>'), '导出时换行要还原');

  // CSS：最小高度 + 内部滚动（内容再长也不会被遮挡）
  const css = fs.readFileSync(path.join(ROOT, 'css/sports-meet.css'), 'utf8');
  assert(/\.ud2-lesson-table textarea[\s\S]*?min-height:\s*170px/.test(css), '输入框要有最小高度');
  assert(/\.ud2-lesson-table textarea[\s\S]*?max-height:\s*340px/.test(css), '输入框要有最大高度（页面不被撑爆）');
  assert(/\.ud2-lesson-table textarea[\s\S]*?overflow-y:\s*auto/.test(css), '内容超出要在框内滚动（文字不被遮挡）');
});

await test('㊿f Few-shot 范文本身必须能被前端解析器正确切开（格式与解析不许脱节）', async () => {
  // ① 前置分析范文：三段目标 / 两段教材 / 四维重难点（含"原因 + 应对措施"）
  const analysis = model.parseUnitAnalysisText(UNIT_FORMAT_ANALYSIS);
  assert(analysis.objectives, '范文要能切出教学目标');
  equal(analysis.objectives.split('\n\n').length, 3, '目标要切成运动能力/健康行为/体育品德三段');
  ['运动能力：', '健康行为：', '体育品德：'].forEach(label =>
    assert(analysis.objectives.includes(label), `目标段缺少：${label}`));
  assert(analysis.textbookAnalysis.includes('第一段：'), '教材分析要保留第一段');
  assert(analysis.textbookAnalysis.includes('第二段：'), '教材分析要保留第二段');
  assert(analysis.studentAnalysis.includes('水平三'), '学情分析要切出来');
  assert(analysis.teachingContent.includes('1. 知识：'), '主要内容要切出来');
  const diff = analysis.keyDifficulties || {};
  equal(Object.keys(diff).length, 4, '重难点要切出四个子维度');
  assert(diff.learning.includes('重点：') && diff.learning.includes('难点：'), '重难点要拆成重点/难点两行');
  assert(diff.learning.includes('原因是'), '"为什么是重难点"要留在文本里');
  assert(diff.learning.includes('应对措施是'), '"怎么破"要留在文本里');

  // ② 课时表范文：一行 Markdown 表格 + 三组小标题
  const lesson = model.parseUnitLessonText(UNIT_FORMAT_LESSONS);
  equal(lesson.lessons.length, 1, '课时范文要解析出一课');
  const one = lesson.lessons[0];
  assert(one.objectives.startsWith('【学习目标】'), '学习目标要有小标题');
  assert(one.content.includes('【主要学习内容】'), '学习内容要有小标题');
  assert(one.method.includes('【教学策略 / 学练活动】'), '教学策略要有小标题');
  ['1.热身小游戏：', '2.技术学练：', '3.展示与比赛：', '4.体能练习：']
    .forEach(key => assert(one.content.includes(key), `学习内容缺少：${key}`));
  ['1.情境导入：', '2.教与学的方法：', '3.比赛活动：', '4.教学评价：']
    .forEach(key => assert(one.method.includes(key), `教学策略缺少：${key}`));
  assert(!one.objectives.includes('**'), '星号要剥掉');

  // ③ 量规范文：结构化模型照旧（等级 / 占比 / 得分点一个都不能少）
  const rubric = model.parseUnitRubricText(UNIT_FORMAT_RUBRIC);
  equal(rubric.rubric.levels.length, 4, '量规要 4 个等级');
  equal(rubric.rubric.literacyWeights.length, 3, '量规要 3 项素养占比');
  equal(rubric.rubric.scoreItems.length, 10, '量规要 10 个得分点');
  assert(rubric.rubric.levels[0].ability.length > 30, '等级描述要写透（不是四个字口号）');
});

await test('㊿g 解析器极致宽容：代码块围栏 / 没有分隔符 / 分隔符粘字，都要能救回来', async () => {
  const row = '| 第7课次 | **【学习目标】**<br>运动能力：能急停急起变向运球<br>健康行为：会热身放松<br>体育品德：守规则 | 1.热身小游戏：绕障碍运球接力<br>2.技术学练：原地预摆弹性屈伸<br>3.展示与比赛：2对2半场对抗赛<br>4.体能练习：折返跑4×30米 | 1.情境导入：特种兵训练营<br>2.教与学的方法：示范讲解与自主学习结合<br>3.比赛活动：实时赛与小组赛结合<br>4.教学评价：语言激励与勋章奖励 |';

  // ① AI 把表格包在 ```markdown 代码块里 —— 必须自动剥离
  const fenced = ['```markdown', '===DIMENSION===', 'technique', '', row, '```'].join('\n');
  const a = model.parseUnitLessonText(fenced, { no: 7 });
  equal(a.lessons.length, 1, '代码块围栏里的表格要能解析出来');
  equal(a.lessons[0].no, 7, '课次号要认出来');
  equal(a.dimension, 'technique', '维度要从 ===DIMENSION=== 拿');
  assert(a.lessons[0].content.includes('技术学练：'), '单元格内容要完整');

  // ② 完全没有分隔符，只有一张表 + 一堆废话 —— 兜底全文扫表
  const noisy = [
    '好的，下面是第 7 课次的详细教案，请老师参考：',
    '',
    '| 课次 | 学习目标 | 主要学习内容 | 教学策略 |',
    '|---|---|---|---|',
    row,
    '',
    '以上就是第 7 课次的内容，如需调整请自行斟酌。',
  ].join('\n');
  const b = model.parseUnitLessonText(noisy, { no: 7 });
  equal(b.lessons.length, 1, '没有分隔符也要能靠全文扫表救回来');
  equal(b.lessons[0].no, 7, '课次号要认出来');
  assert(b.lessons[0].objectives.includes('运动能力：'), '目标要救回来');

  // ③ 分隔符前面粘着别的字（"好的：===OBJECTIVES==="）—— 宽松匹配要认得出来
  const glued = ['好的，以下是内容：===OBJECTIVES===', '1.运动能力：能投篮', '===STUDENTS===', '学情很稳'].join('\n');
  const map = model.splitUnitTextSections(glued);
  assert(map.OBJECTIVES && map.OBJECTIVES.includes('能投篮'), '粘字的分隔符也要能切出来');
  assert(map.STUDENTS && map.STUDENTS.includes('学情很稳'), '第二个分隔符也要能切出来');

  // ④ 前置分析两段：各自独立解析，缺哪段不影响另一段
  const p1 = model.parseUnitAnalysisText(UNIT_FORMAT_ANALYSIS_PART1);
  assert(p1.objectives.includes('运动能力：'), '第一段要切出教学目标');
  assert(p1.textbookAnalysis.includes('第一段：'), '第一段要切出教材分析');
  assert(p1.studentAnalysis.includes('水平三'), '第一段要切出学情分析');
  equal(p1.teachingContent, undefined, '第一段不该有主要教学内容');
  const p2 = model.parseUnitAnalysisText(UNIT_FORMAT_ANALYSIS_PART2);
  assert(p2.teachingContent.includes('知识：'), '第二段要切出主要教学内容');
  equal(Object.keys(p2.keyDifficulties || {}).length, 4, '第二段要切出四维重难点');
  assert(p2.keyDifficulties.learning.includes('原因是'), '重难点要保留原因与应对措施');
});

await test('㊾ 前后端课次-维度计划表必须完全一致（防止两边算法漂移）', async () => {  const env = createUnitEnv();
  const list = catalog.unitTopicListWithDimension('basketball', 'L3');
  const backendPlan = unitLessonPlan(list);
  const frontendPlan = env.api.unitLessonPlanFor(list);
  equal(frontendPlan.length, backendPlan.length, '前后端计划表长度一致');
  frontendPlan.forEach((row, index) => {
    const back = backendPlan[index];
    equal(row.no, back.no, `第 ${index + 1} 行课次号一致`);
    equal(row.dimension, back.dimension, `第 ${row.no} 课次的维度前后端一致`);
    equal(row.dimensionLabel, back.dimensionLabel, `第 ${row.no} 课次的维度名前后端一致`);
    equal(row.topic, back.topic, `第 ${row.no} 课次的项目前后端一致`);
  });

  // 后端 prompt 里写的维度，必须等于前端排定的这一课的维度（这条是真正的"请求带对了"）
  const context = { brief: '（测试用上下文）' };
  for (const row of backendPlan) {
    const built = buildUnitRequest({
      ...UNIT_SELECTION, stage: 'lesson_single', itemId: 'basketball', levelId: 'L3',
      lessonNo: row.no, dimension: row.dimension, context,
    });
    const prompt = built.messages[1].content;
    assert(prompt.includes(`第${row.no}课次`), `lesson_single prompt 要写明课题次 ${row.no}`);
    assert(prompt.includes(row.dimension), `lesson_single prompt 要带上第 ${row.no} 课的维度 ${row.dimension}`);
    assert(prompt.includes(row.dimensionLabel), `lesson_single prompt 要带上维度中文名 ${row.dimensionLabel}`);
  }
});

await test('㊿h 维度不再由 AI 输出：前端按系统排定的计划表回填（AI 吐残渣也不影响）', async () => {
  const env = createUnitEnv();
  env.api.setUnit(env.api.createEmptyUnit());
  // 选好选题 → 前端自己算出 18 课的计划表（含每一课的维度）
  selectUnitTopic(env);
  const plan = env.api.unitCurrentLessonPlan();
  assert(plan.length > 0, '前端计划表要有课次');

  // AI 回的课时里【没有】dimension（现在的 prompt 就不要求它输出）
  env.api.mergeUnitStage({
    lessons: [{ no: plan[0].no, objectives: '目标文本', content: '内容文本', method: '策略文本' }],
  }, null, 'lesson_single');
  const stored = env.api.getUnit().lessons.find(item => item.no === plan[0].no);
  assert(Boolean(stored), '课时要落到对应课次上');
  equal(stored.dimension, plan[0].dimension, 'AI 没给维度时，前端要按计划表回填（结构图泳道靠它）');

  // AI 吐了 ===DIMENSION=== 残渣 → 表格照样解析得出来，维度也不受影响
  const row = '| 第7课次 | **【学习目标】**<br>运动能力：能急停急起变向运球<br>健康行为：会热身放松<br>体育品德：守规则 | 1.热身小游戏：绕障碍运球接力<br>2.技术学练：原地预摆弹性屈伸<br>3.展示与比赛：2对2半场对抗赛<br>4.体能练习：折返跑4×30米 | 1.情境导入：特种兵训练营<br>2.教与学的方法：示范讲解与自主学习结合<br>3.比赛活动：实时赛与小组赛结合<br>4.教学评价：语言激励与勋章奖励 |';
  const polluted = model.parseUnitLessonText(['===DIMENSION===', 'technique', '', row].join('\n'), { no: 7 });
  equal(polluted.lessons.length, 1, 'AI 照抄维度标记时，课时行照样解析出来');
  equal(polluted.dimension, 'technique', '老模型回了维度就认下来（兼容）');
});

await test('㊿i 后端版本戳：前后端一致，且版本对不上时前端会点名警告重新部署', async () => {
  const env = createUnitEnv();
  equal(env.api.UNIT_CLIENT_VERSION, UNIT_BACKEND_VERSION, '前端期望的后端版本必须与后端一致');
  assert(String(UNIT_BACKEND_VERSION).length > 0, '后端必须有版本号');

  const warnings = [];
  const origin = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    env.api.unitCheckBackendVersion({ headers: { get: () => '1999-01-01-old' } });
    env.api.unitCheckBackendVersion({ headers: { get: () => UNIT_BACKEND_VERSION } });
    env.api.unitCheckBackendVersion({ headers: { get: () => null } });
    env.api.unitCheckBackendVersion(null);
  } finally {
    console.warn = origin;
  }
  equal(warnings.length, 1, '只有版本对不上时才警告（对得上 / 老后端不回头 / 没响应都不该吵）');
  assert(warnings[0].includes('重新部署'), '警告里必须写明要重新部署后端');
});

await test('㊿j 真实 Markdown 表格不许被误判成表头：有字就得进 textarea，绝不空白', async () => {
  const env = createUnitEnv();
  env.api.setUnit(env.api.createEmptyUnit());
  // 现场原文：一行里既有「第2课次」又有「【学习目标】」，旧表头正则会把它整行丢掉
  const row = '| 第2课次 | **【学习目标】**<br>运动能力：能做出行进间变向运球<br>健康行为：主动热身<br>体育品德：遵守规则 | '
    + '1.热身：绕障碍运球<br>2.学练：变向运球<br>3.比赛：2对2 | 1.情境导入<br>2.示范讲解 |';
  const parsed = model.parseUnitLessonText(row, { no: 2 });
  equal(parsed.lessons.length, 1, '真实样本要解析出一课');
  equal(parsed.lessons[0].no, 2, '课次号要认出来');
  assert(parsed.lessons[0].rawFallback !== true, '正常表格不该走兜底（表头误判已修复）');
  assert(parsed.lessons[0].objectives.includes('体育品德：'), '三维目标要拆进目标格');
  assert(parsed.lessons[0].content.includes('比赛：2对2'), '学习内容要拆进内容格');
  assert(parsed.lessons[0].method.includes('示范讲解'), '教学策略要拆进策略格');
  assert(!parsed.lessons[0].objectives.includes('**') && !parsed.lessons[0].objectives.includes('<br>'),
    '加粗符号与 <br> 都要清掉');

  // 解析全崩时：整段原文强制塞进该课 textarea，不能留空白
  const broken = ['抱歉，我没能按表格输出。', '**【第 5 课次】** 学习目标：运动能力——能变向运球<br>健康行为：主动热身',
    '主要内容：绕障碍运球接力', '教学策略：情境导入、小组合作'].join('\n');
  const fallback = model.parseUnitLessonText(broken, { no: 5 });
  equal(fallback.lessons.length, 1, '解析全崩也要产出 1 课，绝不返回空数组');
  equal(fallback.lessons[0].rawFallback, true, '要标记原文兜底');
  assert(fallback.lessons[0].objectives.includes('绕障碍运球接力'), '原文整段要留下来');

  env.api.mergeUnitStage({ lessons: [...parsed.lessons, ...fallback.lessons] }, null, 'lesson_single');
  const html = env.api.renderUnitModuleBody('lessons');
  const cell2 = html.match(/<textarea[^>]*data-unit-path="lessons\.1\.objectives"[^>]*>([\s\S]*?)<\/textarea>/);
  const cell5 = html.match(/<textarea[^>]*data-unit-path="lessons\.4\.objectives"[^>]*>([\s\S]*?)<\/textarea>/);
  assert(cell2 && cell2[1].includes('体育品德：'), '第 2 课 textarea 里要有解析出来的目标');
  assert(cell5 && cell5[1].includes('绕障碍运球接力'), '第 5 课 textarea 里要有 AI 原文');
  assert(!html.includes('失败重试'), '界面上不许出现「失败重试」');
  equal(env.api.unitMissingLessonNumbers().includes(2), false, '有目标的课次不算缺失');
});

await test('㊿k 真实接口闭环保护：推理模型必须压低思考量，否则 max_tokens 被吃光、正文 0 字', async () => {
  // 现场：glm-5.3-flashx 是「始终思考」模型，1024 tokens 会全被 reasoning_content 吃掉，
  //       finish_reason=length、delta.content 为空 → 浏览器里 18 个课时全空白。
  const built = buildUnitRequest({ ...UNIT_SELECTION, stage: 'lesson_single', lessonNo: 1 });
  const body = JSON.parse(buildUpstreamRequestBody(
    { apiUrl: 'https://example.com', apiKey: 'x', model: 'glm-5.3-flashx' }, built,
  ));
  equal(body.reasoning_effort, 'low', '请求体必须带 reasoning_effort:low（真实接口实测 4.5s 正常 stop）');
  equal(body.stream, true, '仍要开启流式');
  assert(!body.response_format, '纯文本阶段不能带 response_format');
  equal(body.max_tokens, UNIT_STAGE_MAX_TOKENS.lesson_single, 'token 预算要跟阶段配置一致');
  equal(body.model, 'glm-5.3-flashx', 'model 要来自生产配置');

  // 关掉开关时不带该字段（兼容非推理模型）
  const coreSource = fs.readFileSync(path.join(ROOT, 'lib/ai-core.js'), 'utf8');
  assert(/AI_REASONING_EFFORT\s*=\s*String\(process\.env\.AI_REASONING_EFFORT \|\| 'low'\)/.test(coreSource),
    '推理强度要可用环境变量覆盖（AI_REASONING_EFFORT=none 可完全关闭）');
  assert(/reasoning_effort: AI_REASONING_EFFORT/.test(coreSource), '参数要真的写进上游请求体');
});

await test('㊿l 空壳保存绝不推云端：选题变更时 unit_designs 不会被洗空', async () => {
  const env = createUnitEnv();
  env.api.setUnit(env.api.createEmptyUnit());
  const hollow = env.api.unitSavePayload();
  // 复现事故现场：空模板照样吐出 13 个字段、18 个空格子、一份自带文字的默认量规
  assert(Object.keys(hollow).length >= 10, '空壳 payload 确实有很多 key');
  equal(env.api.unitPayloadFilledModules(hollow).length, 0, '但 10 个模块 0 个有内容');

  env.context.__writes = [];
  env.api.saveUnitData({ silent: true });       // 选题变更走的正是这条路
  const writes = env.context.__writes;
  equal(writes.length, 1, '只写一次');
  equal(writes[0].options?.push, false, '必须只落本地（push:false），绝不 POST /api/data');
});

await test('㊿m 主键已有完整数据时，空壳视图连本地都不许覆盖', async () => {
  const env = createUnitEnv();
  const full = env.api.createEmptyUnit();
  full.objectives = '运动能力：能完成急停急起变向运球。';
  env.context.Store.read = () => full;         // 主键 / 云端里是完整的
  env.api.setUnit(env.api.createEmptyUnit());  // 但当前视图是空壳（页面初始化竞态）
  env.context.__writes = [];
  env.api.saveUnitData({ silent: true });
  equal(env.context.__writes.length, 0, '整个保存必须被跳过');
});

await test('㊿n 有内容的大单元 → 正常推云端，日志报出模块数', async () => {
  const env = createUnitEnv();
  const full = env.api.createEmptyUnit();
  full.objectives = '运动能力：能完成急停急起变向运球。';
  full.lessons[0].objectives = '能说出屈膝含胸的发力顺序。';
  env.api.setUnit(full);
  env.context.__writes = [];
  env.api.saveUnitData({ silent: true });
  const writes = env.context.__writes;
  equal(writes.length, 1, '写一次');
  equal(writes[0].options, undefined, 'cloud=true → 不带 push:false，正常推云端');
  assert(String(writes[0].value.objectives).includes('急停急起'), '提交的是完整内容，不是空壳');
});

await test('㊿o 保存到资源库后：空记录绝不覆盖主表，完整记录才写主键', async () => {
  const env = createUnitEnv();
  // 用假的 OfflineResources 模拟「资源库里那条记录是空的」
  env.context.OfflineResources = {
    unitFromRecord: () => env.api.createEmptyUnit(),
  };
  env.context.__writes = [];
  const blocked = env.api.syncUnitKeyWithResource({ id: 'ur_empty' });
  equal(blocked, null, '空记录必须返回 null（保存失败，不谎报成功）');
  equal(env.context.__writes.length, 0, '一次 Store.write 都不能发');

  const full = env.api.createEmptyUnit();
  full.objectives = '运动能力：能完成急停急起变向运球。';
  env.context.OfflineResources = { unitFromRecord: () => full };
  const synced = env.api.syncUnitKeyWithResource({ id: 'ur_full' });
  assert(synced, '有内容的记录要正常同步');
  equal(String(synced.objectives), full.objectives, '写进主键的是完整 10 模块数据');
  assert(env.context.__writes.length > 0, '要真的写到 Store');
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
