/**
 * 大单元设计模块回归测试（node tests/unit-design-smoke.mjs）
 *
 * 覆盖三块：
 *   ① js/unit-catalog.js   —— 教材/水平/教学内容字典的结构完整性与"不编造"约束
 *   ② lib/ai-core.js       —— 一键生成的请求体：11 个模块要求、18 课时、足够大的 max_tokens
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
  buildUnitRequest, UNIT_STAGE_MAX_TOKENS, UNIT_LESSON_CHUNK, UNIT_LESSON_BATCHES,
  unitContextBrief, unitDimensionStats, unitDimensionQuota, unitLessonPlan, UNIT_DIMENSION_BRANCH,
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

await test('④ 阶段① 模块 1–6：结构图严格照 18 课次计划表，且不吐课时表', async () => {
  const stage1 = buildUnitRequest({ ...UNIT_SELECTION, stage: 'analysis', itemId: 'basketball', levelId: 'L3' });
  assert(!stage1.error, `阶段① 不应报错：${stage1.error?.message}`);
  equal(stage1.stage, 'analysis', '阶段标记要回传，便于前端确认自己在跑哪一步');
  equal(stage1.response_format?.type, 'json_object', '阶段① 必须要求 JSON 输出');
  equal(stage1.max_tokens, UNIT_STAGE_MAX_TOKENS.analysis, '阶段① 用阶段专用预算');

  const prompt1 = stage1.messages[1].content;
  [
    '运动能力', '教材分析', '学情分析', '主要教学内容',
    '学生学习的重难点', '学习内容的重难点', '教学组织的重难点', '教学方法的重难点',
    '基础知识', '基本技术', '技战术运用', '专项体能',
  ].forEach(keyword => assert(prompt1.includes(keyword), `阶段① prompt 缺少要求：${keyword}`));
  assert(!prompt1.includes('"lessons"'), '阶段① 绝不能让 AI 同时吐 18 课时表（那正是被截断的原因）');
  assert(!prompt1.includes('必须恰好 18 项'), '阶段① 不该出现"恰好 18 项课时"的要求');
  assert(prompt1.replace(/\s/g, '').includes('2200字'), '阶段① 要有明确的字数硬约束');
  // 18 课次计划表：课次号 → 维度 → 具体项目，结构图必须照此输出
  assert(prompt1.includes('18 课次计划表'), '阶段① 要给出排定的 18 课次计划表');
  ['第1课次｜', '第18课次｜'].forEach(mark => assert(prompt1.includes(mark), `计划表缺少课次：${mark}`));
  assert(prompt1.includes('结构图必须严格照此输出'), '结构图必须严格照计划表');
});

await test('④b 阶段② 只写模块 8–11：课时表交给 3 个并发批次，不再一次性吐 18 课时', async () => {
  const stage2 = buildUnitRequest({ ...UNIT_SELECTION, stage: 'tail', itemId: 'basketball', levelId: 'L3' });
  assert(!stage2.error, `阶段② 不应报错：${stage2.error?.message}`);
  equal(stage2.response_format?.type, 'json_object', '阶段② 必须要求 JSON 输出');
  const prompt2 = stage2.messages[1].content.replace(/\s/g, '');
  ['assessment', 'evaluation', 'reflection', 'resources'].forEach(field => {
    assert(prompt2.includes(field), `阶段② prompt 缺少字段：${field}`);
  });
  assert(prompt2.includes('绝对不要输出lessons'), '阶段② 必须明确禁止输出课时表（避免把输出撑爆）');
  assert(!prompt2.includes('恰好18项'), '阶段② 不该再要求"恰好 18 项"课时');
  // 输出量必须压得住：整个 JSON ≤ 800 字
  assert(prompt2.includes('整个JSON≤800字'), '阶段② 要有严格的字数上限');
  assert(stage2.max_tokens >= 8192, `阶段② 的 max_tokens 要 ≥ 8192（实际 ${stage2.max_tokens}）`);

  // 智谱请求必须恒开 stream（流式才能边收边看，也是截断检测的前提）
  const source = fs.readFileSync(path.join(ROOT, 'lib/ai-core.js'), 'utf8');
  assert(/stream:\s*true/.test(source), '请求智谱必须开启 stream: true');

  // 三批并发：1–6 / 7–12 / 13–18，每批只写 6 个课时
  UNIT_LESSON_BATCHES.forEach(([from, to]) => {
    const batch = buildUnitRequest({ ...UNIT_SELECTION, stage: 'lessons', itemId: 'basketball', levelId: 'L3', from, to });
    const prompt = batch.messages[1].content;
    equal(batch.meta.from, from, '批次起点要回传');
    equal(batch.meta.to, to, '批次终点要回传');
    assert(batch.max_tokens >= 8192, `课时表批次的 max_tokens 要 ≥ 8192（实际 ${batch.max_tokens}）`);
    assert(prompt.includes(`第 ${from}–${to} 课次`), `批次要写明本批范围：${from}–${to}`);
    assert(prompt.includes(`恰好 ${to - from + 1} 项`), '批次要写明本批恰好几项');
    assert(prompt.includes(`第${from}课次｜`) && prompt.includes(`第${to}课次｜`), '批次要带本批课次计划表');
    assert(!prompt.includes(`第${to + 1}课次｜`) && !prompt.includes(`第${from - 1}课次｜`),
      '批次只能带自己那几课次，不能把别的批次也塞进来');
    ['≤20字', '≤35字', '宁可写短'].forEach(rule => {
      assert(prompt.replace(/\s/g, '').includes(rule), `课时表批次缺少硬约束：${rule}`);
    });
  });
});

await test('⑤ 选题不全 / 超长输入 / 未知阶段都给出明确报错', async () => {
  equal(buildUnitRequest({ stage: 'analysis', category: '球类', item: '', level: '水平二', topic: '运球' }).error?.status, 400, '缺细项应报 400');
  equal(buildUnitRequest({ ...UNIT_SELECTION, stage: 'tail', topic: 'x'.repeat(200) }).error?.status, 400, '超长应报 400');
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
      write: (key, value) => { context.__saved = { key, value }; },
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
    renderUnitModules, renderUnitModuleBody, autoFixStructure,
    normalizeStructureBranch, recoverPartialUnitJSON,
    populateUnitSelectors, currentUnitSelection, onUnitCategoryChange, onUnitLevelChange, refreshUnitTopics,
    // 分步生成
    generateWholeUnit, generateLessonTableOnly, mergeUnitStage, unitStageContext,
    unitMissingLessonNumbers, unitMissingRanges, unitTailMissing, requestUnitStage, closeUnitModals,
    // 下面几个在 unit-model.js 里以「接收 unit」的纯函数形态存在，这里绑到页面的 unitData 上
    missingStructureNumbers: () => missingStructureNumbers(unitData),
    buildUnitExportHTML: () => buildUnitExportHTML(unitData),
    unitModuleCompleted: (id = 'objectives') => unitModuleCompleted(unitData, id),
    getUnit: () => unitData, setUnit: value => { unitData = value; },
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

function injectFakeAI(env, script) {
  const calls = [];
  env.context.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    script.onRequest?.(body, env);
    if (body.stage === 'analysis') return fakeStream(JSON.stringify(script.stage1));
    if (body.stage === 'tail') {
      if (script.truncateTail) return fakeStream('{"assessment":"考核内', { truncate: true });
      // 收尾四项（不再带 lessons —— 课时表由 lessons 批次负责）
      const { lessons, ...tailOnly } = script.stage2;
      return fakeStream(JSON.stringify(tailOnly));
    }
    if (body.stage === 'lessons') {
      const lessons = [];
      for (let no = body.from; no <= body.to; no += 1) {
        const source = (script.stage2.lessons || []).find(lesson => lesson.no === no);
        lessons.push(source || {
          no,
          objectives: { ability: `能力${no}`, health: `健康${no}`, character: `品德${no}` },
          content: `补-${no}`, method: `教法${no}`,
        });
      }
      // 模拟"写到第 N 课时的 content 中间被掐断"：前面的课时必须能被抢救回来（只掐断一次，补全时不再掐）
      let pendingTruncate = script.truncateBatchAt;
      if (pendingTruncate >= body.from && pendingTruncate <= body.to) {
        script.truncateBatchAt = undefined;
        const full = JSON.stringify({ lessons });
        const target = lessons.find(lesson => lesson.no === pendingTruncate);
        // 断在 content 的值中间（值还没写完、引号也没闭合）—— 最真实的截断形态
        const cutIndex = full.indexOf(`"content":"${target.content}"`) + '"content":"'.length + 2;
        assert(cutIndex > 0, '构造的截断样本不对');
        return fakeStream(full.slice(0, cutIndex), { truncate: true });
      }
      return fakeStream(JSON.stringify({ lessons }));
    }
    if (body.stage === 'closing') {
      return fakeStream(JSON.stringify({
        assessment: '考核与作业（补齐）',
        evaluation: { process: '过程性（补齐）', summative: '终结性（补齐）', integration: '一体化（补齐）' },
        reflection: '反思框架（补齐）', resources: '资源清单（补齐）',
      }));
    }
    return fakeStream('{}');
  };
  return calls;
}

/** 阶段① 的完整返回（模块 1–6） */
function stage1Payload() {
  return {
    unitTitle: '水平三篮球大单元',
    objectives: { ability: '阶段一能力', health: '阶段一健康', character: '阶段一品德' },
    textbookAnalysis: '阶段一教材分析内容',
    studentAnalysis: '阶段一学情分析内容',
    teachingContent: '1. 球性\n2. 运球',
    keyDifficulties: { learning: '学', content: '内', organization: '组', method: '法' },
    structure: {
      basic: [{ no: 1, title: '第1课次：球性' }, { no: 2, title: '第2课次：规则' }],
      technique: Array.from({ length: 8 }, (_, i) => ({ no: i + 3, title: `第${i + 3}课次：技术` })),
      tactics: Array.from({ length: 5 }, (_, i) => ({ no: i + 11, title: `第${i + 11}课次：战术` })),
      fitness: Array.from({ length: 3 }, (_, i) => ({ no: i + 16, title: `第${i + 16}课次：体能` })),
    },
  };
}

/** 阶段② 的完整返回（模块 7–11），truncateTo 传数字可模拟"只写到了第 N 课时" */
function stage2Payload(truncateTo = 18) {
  return {
    lessons: Array.from({ length: truncateTo }, (_, index) => ({
      no: index + 1,
      objectives: { ability: `能力${index + 1}`, health: `健康${index + 1}`, character: `品德${index + 1}` },
      content: `阶段二-${index + 1}`, method: `组织教法${index + 1}`,
    })),
    assessment: '考核内容',
    evaluation: { process: '过程性', summative: '终结性', integration: '一体化' },
    reflection: '反思模板',
    resources: '资源清单',
  };
}

/** 模拟 AI 返回的完整结果 */
function sampleGenerated() {
  const lessons = Array.from({ length: 18 }, (_, index) => ({
    no: index + 1,
    objectives: { ability: `能力目标${index + 1}`, health: `健康目标${index + 1}`, character: `品德目标${index + 1}` },
    content: `教学内容${index + 1}`,
    method: `组织教法${index + 1}`,
  }));
  return {
    unitTitle: '水平三篮球大单元',
    objectives: { ability: '能力', health: '健康', character: '品德' },
    textbookAnalysis: '教材分析内容',
    studentAnalysis: '学情分析内容',
    teachingContent: '1. 知识\n2. 技术',
    keyDifficulties: { learning: '学生学习', content: '学习内容', organization: '教学组织', method: '教学方法' },
    structure: {
      basic: [{ no: 1, title: '第1课次：认识篮球（球性练习）' }, { no: 2, title: '第2课次：规则与安全' }],
      technique: Array.from({ length: 8 }, (_, i) => ({ no: i + 3, title: `第${i + 3}课次：技术` })),
      tactics: Array.from({ length: 5 }, (_, i) => ({ no: i + 11, title: `第${i + 11}课次：战术` })),
      fitness: Array.from({ length: 3 }, (_, i) => ({ no: i + 16, title: `第${i + 16}课次：体能` })),
    },
    lessons,
    assessment: '考核与作业内容',
    evaluation: { process: '过程性', summative: '终结性', integration: '一体化' },
    reflection: '反思模板',
    resources: '资源清单',
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
    assert(lesson.objectives.ability && lesson.objectives.health && lesson.objectives.character,
      `第 ${index + 1} 课缺少三维目标`);
  });
  equal(api.missingStructureNumbers().length, 0, '结构图必须覆盖 1–18 且无重复');
});

await test('⑦ 残缺 AI 结果也能兜底：少课时 / 脏数据不会让页面崩', async () => {
  const broken = { ...sampleGenerated(), lessons: [{ no: 1, content: '只有一课' }], structure: '不是对象' };
  api.applyGeneratedUnit(broken, null);
  const data = api.getUnit();
  equal(data.lessons.length, 18, '课时不足要补齐到 18 行');
  equal(Array.isArray(data.structure.basic), true, 'structure 坏了也要还原成四个数组');
  equal(typeof data.lessons[5].objectives.health, 'string', '缺失字段补空字符串而不是 undefined');
});

await test('⑧ 结构图缺课时能被发现并一键补全', async () => {
  api.applyGeneratedUnit({ ...sampleGenerated(), structure: { basic: [{ no: 1, title: '第1课次：认识篮球' }] } }, null);
  const missing = api.missingStructureNumbers();
  equal(missing.length, 17, '应发现 17 个缺失课次');
  api.autoFixStructure();
  equal(api.missingStructureNumbers().length, 0, '补全后应覆盖全部 18 个课次');
});

await test('⑨ 渲染：11 个模块 + 18 个「查看详细教案」按钮', async () => {
  api.applyGeneratedUnit(sampleGenerated(), null);
  api.renderUnitModules();
  const html = env.nodes.get('ud2Modules').innerHTML;
  for (let index = 1; index <= 11; index += 1) {
    assert(html.includes(`模块 ${index}`), `缺少模块 ${index}`);
  }
  ['教学目标', '教材分析', '学情分析', '主要教学内容', '教学重难点', '大单元设计结构图',
    '18 课时计划表', '考核与作业', '学习评价', '教学反思', '教学资源']
    .forEach(title => assert(html.includes(title), `面板缺少模块标题：${title}`));
  const detailButtons = html.match(/showUnitLessonDetail\(/g) || [];
  equal(detailButtons.length, 18, '每一课时都要有「查看详细教案」按钮');
});

await test('⑩ 四个重难点子维度、三维目标各有独立输入框', async () => {
  api.applyGeneratedUnit(sampleGenerated(), null);
  const body = api.renderUnitModuleBody('keyDifficulties');
  ['learning', 'content', 'organization', 'method'].forEach(field => {
    assert(body.includes(`keyDifficulties.${field}`), `教学重难点缺少子维度：${field}`);
  });
  const objectivesBody = api.renderUnitModuleBody('objectives');
  ['ability', 'health', 'character'].forEach(field => {
    assert(objectivesBody.includes(`objectives.${field}`), `教学目标缺少维度：${field}`);
  });
});

await test('⑪ 截断的 JSON 能抢救回来', async () => {
  const full = JSON.stringify(sampleGenerated());
  const cut = full.slice(0, Math.floor(full.length * 0.82));
  const recovered = api.recoverPartialUnitJSON(cut);
  assert(recovered && typeof recovered === 'object', '应能从头部的 JSON 抢救出部分对象');
  assert(recovered.objectives || recovered.unitTitle, '至少能拿到开头的字段');
  equal(api.recoverPartialUnitJSON('完全不是JSON'), null, '彻底无效时返回 null 而不是抛异常');
});

await test('⑫ 导出 / 打印 HTML 包含 11 个模块与完整课时表', async () => {
  api.applyGeneratedUnit(sampleGenerated(), null);
  const html = api.buildUnitExportHTML();
  ['一、教学目标', '二、教材分析', '三、学情分析', '四、主要教学内容', '五、教学重难点',
    '六、大单元设计结构图', '七、18 课时计划表', '八、考核与作业', '九、学习评价',
    '十、教学反思', '十一、教学资源'].forEach(heading => assert(html.includes(heading), `导出缺少章节：${heading}`));
  const rows = html.match(/<td>第 \d+ 课<\/td>/g) || [];
  equal(rows.length, 18, '导出的课时表必须是 18 行');
  assert(html.includes('基础知识') && html.includes('专项体能'), '导出要带上结构图四个分支');
});

await test('⑬ 旧版（分步生成）数据能迁移到新结构，不丢老师以前的内容', async () => {
  const legacy = {
    theme: '旧天天单元',
    textbookAnalysis: '旧的教材分析',
    studentAnalysis: '旧的学情分析',
    keyPoints: '旧重点',
    difficulties: '旧难点',
    coreQuestion: '旧核心问题',
    objectives: { ability: '旧能力', health: '旧健康', character: '旧品德' },
    assessment: '旧考核',
    evaluationSummary: '旧评价汇总',
    reflection: '旧反思',
    lessons: Array.from({ length: 18 }, (_, index) => ({
      objective: '旧目标', content: `旧内容${index + 1}`, method: '旧方法', application: '旧运用', evaluation: '旧评价',
    })),
  };
  const migrated = api.migrateLegacyUnit(legacy);
  equal(migrated.unitTitle, '旧天天单元', '单元名要保留');
  equal(migrated.objectives.ability, '旧能力', '三维目标要保留');
  equal(migrated.lessons.length, 18, '18 课时结构要迁移过来');
  assert(migrated.lessons[0].content.includes('旧内容1'), '课时内容要保留');
  equal(api.unitModuleCompleted('textbookAnalysis'), true, '有内容就该标成已完成');
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

await test('⑮ 阶段②带上阶段①上下文；课时表支持分批请求；上下文要被压缩', async () => {
  const built = buildUnitRequest({
    ...UNIT_SELECTION,
    stage: 'tail',
    context: {
      unitTitle: '水平三篮球大单元',
      objectives: { ability: '能说出并做出三种运球', health: '每周三次练习', character: '遵守规则' },
      keyDifficulties: { method: '示范-分解-完整' },
      lessonTitles: [{ no: 1, title: '第1课次：球性' }, { no: 18, title: '第18课次：班级联赛' }],
    },
  });
  const prompt = built.messages[1].content;
  assert(prompt.includes('水平三篮球大单元'), '阶段② 要带上阶段① 的单元名');
  assert(prompt.includes('第1课次：球性'), '阶段② 要带上阶段① 的结构图（保证后半部分与前半部分连贯）');
  assert(prompt.includes('每周三次练习'), '阶段② 要带上阶段① 的三维目标');

  const chunk = buildUnitRequest({ ...UNIT_SELECTION, stage: 'lessons', from: 13, to: 18 });
  equal(chunk.meta.from, 13, '分批起止要回传');
  equal(chunk.meta.to, 18, '分批起止要回传');
  equal(chunk.meta.count, 6, '分批数量要回传');
  const chunkPrompt = chunk.messages[1].content;
  assert(chunkPrompt.includes('第 13–18 课次'), '分批 prompt 要写明区间');
  assert(chunkPrompt.includes('恰好 6 项'), '分批 prompt 要写明本次只出 6 项');

  const fat = buildUnitRequest({ ...UNIT_SELECTION, stage: 'tail', context: { teachingContent: '长'.repeat(3000) } });
  assert(fat.messages[1].content.length < 3000,
    `上下文必须被压缩（当前 ${fat.messages[1].content.length} 字），否则输出预算会被输入吃掉`);
  equal(UNIT_LESSON_CHUNK <= 6, true, `每批课时数要足够小（当前 ${UNIT_LESSON_CHUNK}），远离模型输出上限`);
});

await test('⑯ 前端拼接：阶段① 先渲染，阶段② 用 1 + 3 个并发请求合并成完整 11 模块', async () => {
  const env = createUnitEnv();
  selectUnitTopic(env);
  let phase1RenderedBeforePhase2 = false;
  const calls = injectFakeAI(env, {
    stage1: stage1Payload(),
    stage2: stage2Payload(),
    onRequest: (body, currentEnv) => {
      if (body.stage === 'tail') {
        phase1RenderedBeforePhase2 = currentEnv.node('ud2Modules').innerHTML.includes('阶段一教材分析内容');
      }
    },
  });

  await env.api.generateWholeUnit();
  // 阶段① 一次 + 阶段② 4 个并发（收尾四项 + 课时表 3 批）
  equal(calls.length, 5, '必须是 1 次阶段① + 4 个并发请求');
  equal(calls[0].stage, 'analysis', '第一次必须是阶段①');
  equal(calls[1].stage, 'tail', '第二个是收尾四项');
  const lessonCalls = calls.filter(call => call.stage === 'lessons');
  equal(lessonCalls.length, 3, '课时表必须是 3 个并发批次');
  equal(lessonCalls.map(call => `${call.from}-${call.to}`).join(','), '1-6,7-12,13-18', '三批覆盖 1–18');
  equal(typeof calls[1].context, 'object', '阶段② 的请求要带上阶段① 的结果当上下文');
  equal(calls[1].context.unitTitle, '水平三篮球大单元', '上下文里要有阶段① 的单元名');
  assert(phase1RenderedBeforePhase2, '阶段② 发出之前，阶段① 的内容必须已经渲染到页面上');

  const data = env.api.getUnit();
  equal(data.unitTitle, '水平三篮球大单元', '单元名来自阶段①');
  equal(data.textbookAnalysis, '阶段一教材分析内容', '阶段① 的模块不能被阶段② 冲掉');
  equal(data.lessons.length, 18, '合并后仍是 18 行课时表');
  assert(data.lessons[17].content.includes('阶段二-18'), '阶段② 的第 18 课时要落到第 18 行');
  equal(data.resources, '资源清单', '模块 11 也要落库');
  equal(env.api.unitMissingLessonNumbers().length, 0, '两次请求都成功时不应有缺失课时');
  equal(env.overlays.length, 0, '没截断就不该弹窗打扰老师');
  assert(env.toasts.some(toast => String(toast.message).includes('已生成')), '应提示生成成功');
});

await test('⑰ 某批次仍被截断 → 抢救已写出的课时 + 弹窗提示【补全】，点后只补缺失课次且不覆盖已有内容', async () => {
  const env = createUnitEnv();
  selectUnitTopic(env);
  // 模拟：第 7–12 批写到第 9 课时的半截被掐断；收尾四项那次请求也被截断
  const calls = injectFakeAI(env, {
    stage1: stage1Payload(), stage2: stage2Payload(), truncateBatchAt: 9, truncateTail: true,
  });

  await env.api.generateWholeUnit();
  const missing = env.api.unitMissingLessonNumbers();
  equal(missing.length, 4, '只应缺第 9–12 课时（第 1–6、13–18 批照常成功）');
  equal(missing.join(','), '9,10,11,12', '缺失的是被截断那一批的后半段');
  equal(env.api.getUnit().lessons[6].content, '阶段二-7', '第 7 课时要保住');
  equal(env.api.getUnit().lessons[7].content, '阶段二-8', '被截断批次里已写完的第 8 课时要抢救下来');
  // 收尾四项那次请求被截断 → 要用更小的 closing 请求兜底
  assert(calls.some(call => call.stage === 'closing'), '收尾四项被截断时要单独补一次');
  equal(env.api.getUnit().resources, '资源清单（补齐）', '收尾模块要补齐');

  const dialog = env.overlays[env.overlays.length - 1];
  assert(dialog, '必须弹出提示窗');
  assert(/课次缺失/.test(dialog.title) && /点击【补全】按钮单独生成该课次/.test(dialog.title),
    `弹窗标题要写明缺失课次与补全入口：${dialog.title}`);
  assert(dialog.footerHTML.includes('generateLessonTableOnly()'), '弹窗必须提供【补全】按钮');

  const before = calls.length;
  await env.api.generateLessonTableOnly();
  const batchCalls = calls.slice(before).filter(call => call.stage === 'lessons');
  equal(batchCalls.length, 1, '只有 4 个缺失课次，一批就够');
  equal(batchCalls[0].from, 9, '从缺失的第 9 课次开始');
  equal(batchCalls[0].to, 12, '到缺失的最后一个课次结束');

  const data = env.api.getUnit();
  equal(env.api.unitMissingLessonNumbers().length, 0, '补生成后 18 课时必须齐全');
  equal(data.lessons[0].content, '阶段二-1', '已有内容不能被覆盖');
  equal(data.lessons[8].content, '阶段二-9', '第 9 课时要落在第 9 行');
  equal(data.lessons[11].content, '阶段二-12', '第 12 课时要落在第 12 行');
  equal(data.lessons[12].content, '阶段二-13', '第 13 课时是另一批生成的，不能被冲掉');
  equal(env.overlays.length, 0, '补生成前应自动关掉提示窗');
});

await test('⑱ 分批区间按连续段切分，不会把已写好的课时重生成一遍', async () => {
  const env = createUnitEnv();
  const ranges = env.api.unitMissingRanges([8, 9, 10, 11, 12, 13, 14, 18]);
  equal(ranges.length, 3, '缺少的课次应切成：8–13、14、18 三批');
  equal(ranges[0].join(','), '8,9,10,11,12,13', '第一段每批不超过 6 个');
  equal(ranges[1].join(','), '14', '余下单独成批');
  equal(ranges[2].join(','), '18', '孤立课次单独成批');
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
  const byId = buildUnitRequest({ ...UNIT_SELECTION, stage: 'tail', itemId: 'running', levelId: 'L2' });
  const prompt2 = byId.messages[1].content;
  assert(prompt2.includes('具体教学内容清单'), '没带清单也要能从字典反查出来');
  assert(prompt2.includes('50 米快速跑'), '反查出的清单要包含该水平的具体项目');
  assert(prompt2.includes('蹲踞式起跑') === false, '不能把别的水平的项目塞进来');

  // ③ 阶段② 的上下文里也要带清单（unitContextBrief）
  const withContext = buildUnitRequest({
    ...UNIT_SELECTION, stage: 'tail', itemId: 'running', levelId: 'L3',
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
    category: '球类', item: '篮球', level: '水平四（7–9 年级）', topic: '运球转身', stage: 'tail',
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
  // ④ 结构图分支键的对照要写清楚（AI 才知道 tactic→tactics）
  assert(prompt.includes('tactic→tactics'), '要给出维度 → 结构图分支键的对照');
  // ⑤ 阶段① 的结构图要按维度分支布置
  assert(prompt.includes('分支键与维度的对应'), '阶段①要说明结构图按维度分支');
});

await test('㊱ 阶段②/③/④ 的上下文必须同时保住「教学内容清单」与「18 课次框架」', async () => {
  // 以前是"拼完再整体截断"，1200 字上限会把这两段砍掉 —— 现在按优先级保留
  const context = {
    unitTitle: '水平三篮球大单元',
    topicList: catalog.unitTopicListWithDimension('basketball', 'L3'),   // 20 条，含维度前缀
    objectives: { ability: '能完成原地单手肩上投篮', health: '养成锻炼习惯', character: '遵守规则、尊重对手' },
    teachingContent: '本单元覆盖运球、传接球、投篮、战术配合、体能、比赛、规则与观赏八个方面的内容。'.repeat(3),
    keyDifficulties: { learning: '出手角度', content: '上下肢协调用力', organization: '分组轮换', method: '分解到完整' },
    lessonTitles: Array.from({ length: 18 }, (_, index) => ({ no: index + 1, title: `第${index + 1}课次：项目${index + 1}` })),
  };
  // 收尾模块（tail / closing）不写课时，输入不是瓶颈 → 带完整清单与维度配额
  ['tail', 'closing'].forEach(stage => {
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

await test('㊲ 18 课时按多维结构落地：lesson.dimension + 结构图分支 + 维度覆盖统计', async () => {
  // ① 模型层：结构图分支 = 七大维度，且兼容历史键 tactics / 维度键 tactic
  const branchIds = model.UNIT_STRUCTURE_BRANCHES.map(branch => branch.id);
  ['basic', 'technique', 'tactics', 'fitness', 'match', 'rule', 'watch'].forEach(id => {
    assert(branchIds.includes(id), `结构图缺少分支：${id}`);
  });
  equal(model.structureBranchOfDimension('tactic'), 'tactics', '战术维度要映射到历史分支键 tactics');
  const normalized = model.normalizeUnit({
    structure: { tactic: [{ no: 11, title: '第11课次：传切配合' }], watch: [{ no: 18, title: '第18课次：观看比赛' }] },
    lessons: [{ no: 1, dimension: 'technique', content: '原地运球' }],
    meta: { dimensions: ['technique', 'match'] },
  });
  equal(normalized.structure.tactics.length, 1, '维度键 tactic 的数据要收进 tactics 分支');
  equal(normalized.structure.watch.length, 1, '新分支 watch 要被保留');
  equal(normalized.lessons[0].dimension, 'technique', '课时的 dimension 要保留');
  equal(normalized.meta.dimensions.length, 2, 'meta.dimensions 要保留');
  equal(normalized.structure.match.length, 0, '没用到的维度分支是空数组，不能是 undefined');

  // ② AI 输出带 dimension 时，18 课时的维度覆盖可统计
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

  // ③ 课时的 dimension 要能落到结构图对应分支（AI 没给 structure 时的兜底补齐）
  const filled = model.autoFillStructure({ ...unit, structure: {} });
  const allNodes = model.UNIT_STRUCTURE_BRANCHES.flatMap(branch => filled.structure[branch.id]);
  equal(allNodes.length, 18, '兜底补齐后 18 个课次都要挂载');
  assert(filled.structure.watch.length >= 1, '观赏维度要有课次挂到 watch 分支');
  assert(filled.structure.match.length >= 1, '比赛维度要有课次挂到 match 分支');

  // ④ 维度键 → 分支键的对照表本身要完整
  Object.values(UNIT_DIMENSION_BRANCH).forEach(branch => {
    assert(branchIds.includes(branch), `维度分支键 ${branch} 不在结构图分支里`);
  });
});

await test('㊳ 18 课次计划表：课次号 / 维度 / 具体项目一一排定，三批合起来覆盖全部维度', async () => {
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
  // 三批并发的划分：每批 6 个，合起来正好 1–18
  const covered = UNIT_LESSON_BATCHES.flatMap(([from, to]) => plan.filter(row => row.no >= from && row.no <= to));
  equal(covered.length, 18, '三批合起来必须覆盖 18 个课次');
  UNIT_LESSON_BATCHES.forEach(([from, to]) => equal(to - from + 1, 6, '每批固定 6 个课时'));
  // 计划可复算：同一份清单每次算出来都一样（否则三批并发会排乱）
  const again = unitLessonPlan(list);
  equal(JSON.stringify(again), JSON.stringify(plan), '计划表必须是确定性的（并发依赖这一点）');
});

await test('㊴ 截断 JSON 强制修复：断在字符串里 / 断在冒号后 / 断在对象里都能救回已生成的课时', async () => {
  const full = {
    lessons: Array.from({ length: 6 }, (_, index) => ({
      no: index + 1,
      dimension: 'technique',
      objectives: { ability: '能完成', health: '愿参与', character: '守规则' },
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

await test('㊵ 一键生成：课时表 3 批并发 + 收尾四项，合并成完整 18 课时；缺课次时弹窗引导补全', async () => {
  const env = createUnitEnv();
  selectUnitTopic(env);
  const list = catalog.unitTopicListWithDimension('basketball', 'L3');
  const plan = unitLessonPlan(list);
  const lessonOf = no => {
    const row = plan[no - 1];
    return {
      no,
      dimension: row.dimension,
      objectives: { ability: `能力${no}`, health: `健康${no}`, character: `品德${no}` },
      content: `第${no}课内容`,
      method: `第${no}课教法`,
    };
  };
  const calls = [];
  env.context.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.stage === 'analysis') {
      return fakeStream(JSON.stringify({
        unitTitle: '篮球大单元',
        objectives: { ability: '能投篮', health: '爱运动', character: '守规则' },
        structure: { technique: Array.from({ length: 18 }, (_, index) => ({ no: index + 1, title: `第${index + 1}课次` })) },
      }));
    }
    if (body.stage === 'tail') {
      return fakeStream(JSON.stringify({ assessment: '考核', evaluation: { process: '过程', summative: '终结', integration: '一体' }, reflection: '反思', resources: '资源' }));
    }
    if (body.stage === 'lessons') {
      const lessons = [];
      for (let no = body.from; no <= body.to; no += 1) lessons.push(lessonOf(no));
      return fakeStream(JSON.stringify({ lessons }));
    }
    return fakeStream('{}');
  };

  await env.api.generateWholeUnit();
  // ① 必须是 1 次 analysis + 1 次 tail + 3 次 lessons（并发）
  const stageCounts = calls.reduce((map, body) => {
    map[body.stage] = (map[body.stage] || 0) + 1;
    return map;
  }, {});
  equal(stageCounts.analysis, 1, '阶段① 只请求一次');
  equal(stageCounts.tail, 1, '收尾四项只请求一次');
  equal(stageCounts.lessons, 3, '课时表必须拆成 3 批');
  const ranges = calls.filter(body => body.stage === 'lessons').map(body => `${body.from}-${body.to}`);
  equal(ranges.join(','), '1-6,7-12,13-18', '三批的范围必须是 1–6 / 7–12 / 13–18');

  // ② 三批合并后 18 课时齐全，且维度按计划排布
  const unit = env.api.getUnit();
  equal(unit.lessons.length, 18, '合并后仍是 18 个课时');
  equal(env.api.unitMissingLessonNumbers().length, 0, '不应有缺失课时');
  unit.lessons.forEach((lesson, index) => {
    equal(lesson.content, `第${index + 1}课内容`, `第 ${index + 1} 课时要落在正确的位置（按 no 落位，不能按返回顺序错位）`);
    equal(lesson.dimension, plan[index].dimension, `第 ${index + 1} 课时的维度要符合计划表`);
  });
  // ③ 收尾四项也拿到了
  equal(env.api.unitTailMissing().length, 0, '模块 8–11 应齐全');

  /* ---- 换一个脚本：第 13–18 批被截断 → 弹窗提示补全 ---- */
  const env2 = createUnitEnv();
  selectUnitTopic(env2);
  env2.context.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.stage === 'analysis') {
      return fakeStream(JSON.stringify({ unitTitle: '篮球大单元', objectives: { ability: '能投篮' } }));
    }
    if (body.stage === 'tail') return fakeStream(JSON.stringify({ assessment: '考核', evaluation: {}, reflection: '反思', resources: '资源' }));
    if (body.stage === 'lessons') {
      if (body.from === 13) {
        // 真实截断的样子：第 13、14 课时写完，第 15 课时断在半截字符串里
        const lessons = [lessonOf(13), lessonOf(14), { no: 15, dimension: 'match', objectives: {}, content: '半截内容', method: '半截' }];
        const text = JSON.stringify({ lessons });
        return fakeStream(text.slice(0, text.indexOf('半截内容') + 2), { truncate: true });
      }
      const lessons = [];
      for (let no = body.from; no <= body.to; no += 1) lessons.push(lessonOf(no));
      return fakeStream(JSON.stringify({ lessons }));
    }
    return fakeStream('{}');
  };
  await env2.api.generateWholeUnit();
  const missing = env2.api.unitMissingLessonNumbers();
  assert(missing.includes(15) && missing.includes(16) && missing.includes(17) && missing.includes(18),
    `第 15–18 课次应缺失（实际缺 ${missing.join('、')}）`);
  assert(!missing.includes(13) && !missing.includes(14),
    '被截断批次里已经写完的第 13、14 课时要抢救下来（修复逻辑生效）');
  const dialog = env2.overlays.find(overlay => /补全/.test(overlay.title || ''));
  assert(dialog, '缺课次时要弹窗提示');
  assert(/课次缺失/.test(dialog.title) && /点击【补全】按钮单独生成该课次/.test(dialog.title),
    `弹窗标题要给出缺失课次与补全入口（实际：${dialog.title}）`);
  assert(/generateLessonTableOnly\(\)/.test(dialog.footerHTML), '弹窗的【补全】按钮要能直接补生成');
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
