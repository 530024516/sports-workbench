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
  buildUnitRequest, UNIT_STAGE_MAX_TOKENS, UNIT_LESSON_CHUNK,
} = require(path.join(ROOT, 'lib/ai-core.js'));
const catalog = require(path.join(ROOT, 'js/unit-catalog.js'));

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

await test('④ 拆两次请求：阶段① 模块 1–6 / 阶段② 模块 7–11，都是 JSON 模式且各自有预算', async () => {
  const stage1 = buildUnitRequest({ ...UNIT_SELECTION, stage: 'analysis' });
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
  assert(!/lessons/.test(prompt1), '阶段① 绝不能让 AI 同时吐 18 课时表（那正是被截断的原因）');
  assert(prompt1.replace(/\s/g, '').includes('2200字'), '阶段① 要有明确的字数硬约束');

  const stage2 = buildUnitRequest({ ...UNIT_SELECTION, stage: 'tail' });
  assert(!stage2.error, `阶段② 不应报错：${stage2.error?.message}`);
  equal(stage2.response_format?.type, 'json_object', '阶段② 必须要求 JSON 输出');
  const prompt2 = stage2.messages[1].content.replace(/\s/g, '');
  ['lessons', 'assessment', 'evaluation', 'reflection', 'resources'].forEach(field => {
    assert(prompt2.includes(field), `阶段② prompt 缺少字段：${field}`);
  });
  assert(prompt2.includes('恰好18项'), '阶段② 必须强调 lessons 恰好 18 项');
  assert(prompt2.includes('≤20字'), '阶段② 必须给三维目标下 ≤20 字的硬约束');
  assert(prompt2.includes('≤35字'), '阶段② 必须给内容与组织教法下 ≤35 字的硬约束');
  assert(prompt2.includes('宁可写短'), '阶段② 要把"宁可写短也要输出完整"写成最高优先级');
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
  // 按页面里的 <script> 顺序注入：模型 → 字典 → 页面脚本
  ['js/unit-model.js', 'js/unit-catalog.js', 'js/unit-design.js'].forEach(file => {
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
      if (!script.truncateStage2) return fakeStream(JSON.stringify(script.stage2));
      // 真实截断的样子：JSON 断在第 N 个课时的开头，尾部缺失（所以收尾模块也一并丢失）
      const full = JSON.stringify({ lessons: script.stage2.lessons });
      const cutIndex = full.indexOf(`,{"no":${script.truncateStage2}`);
      assert(cutIndex > 0, '构造的截断样本不对');
      return fakeStream(full.slice(0, cutIndex), { truncate: true });
    }
    if (body.stage === 'lessons') {
      const lessons = [];
      for (let no = body.from; no <= body.to; no += 1) {
        lessons.push({
          no,
          objectives: { ability: `能力${no}`, health: `健康${no}`, character: `品德${no}` },
          content: `补-${no}`, method: `教法${no}`,
        });
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

await test('⑯ 前端两次请求无缝拼接：阶段① 先渲染，阶段② 合并成完整 11 模块', async () => {
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
  equal(calls.length, 2, '必须正好发两次请求');
  equal(calls[0].stage, 'analysis', '第一次必须是阶段①');
  equal(calls[1].stage, 'tail', '第二次必须是阶段②');
  equal(typeof calls[1].context, 'object', '第二次请求要带上阶段① 的结果当上下文');
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

await test('⑰ 阶段② 仍被截断 → 弹窗提示并给出【单独生成课时表】，点后分批补齐且不覆盖已有内容', async () => {
  const env = createUnitEnv();
  selectUnitTopic(env);
  // 模拟：阶段② 写到第 9 个课时就被模型输出上限截断（ salvage 后只剩前 8 个课时，收尾模块也没了）
  const calls = injectFakeAI(env, { stage1: stage1Payload(), stage2: stage2Payload(9), truncateStage2: 9 });

  await env.api.generateWholeUnit();
  const missing = env.api.unitMissingLessonNumbers();
  equal(missing.length, 10, '应发现第 9–18 课时缺失');
  equal(missing[0], 9, '第一个缺失的是第 9 课次');
  equal(env.api.getUnit().lessons[7].content, '阶段二-8', '已被抢救出来的第 8 课时要保住');

  const dialog = env.overlays[env.overlays.length - 1];
  assert(dialog, '必须弹出提示窗');
  assert(dialog.bodyHTML.includes('18课时表过长导致截断'), `弹窗文案不对：${dialog.title}`);
  assert(dialog.footerHTML.includes('generateLessonTableOnly()'), '弹窗必须提供【单独生成课时表】按钮');

  const tailCallsBefore = calls.length;
  await env.api.generateLessonTableOnly();
  const batchCalls = calls.slice(tailCallsBefore);
  assert(batchCalls.some(call => call.stage === 'lessons'), '点击后要按批补生成课时表');
  const lessonCalls = batchCalls.filter(call => call.stage === 'lessons');
  equal(lessonCalls[0].from, 9, '第一批从第 9 课次开始');
  equal(lessonCalls[0].to, 14, `第一批 ${UNIT_LESSON_CHUNK} 个课时`);
  equal(lessonCalls[1].from, 15, '第二批从第 15 课次开始');
  equal(lessonCalls[1].to, 18, '第二批收尾到第 18 课次');
  assert(batchCalls.some(call => call.stage === 'closing'), '收尾模块还缺时要单独补一次');

  const data = env.api.getUnit();
  equal(env.api.unitMissingLessonNumbers().length, 0, '补生成后 18 课时必须齐全');
  equal(data.lessons[0].content, '阶段二-1', '分批返回必须按 no 落位，不能挤到第 1 行覆盖已有内容');
  equal(data.lessons[8].content, '补-9', '第 9 课时要落在第 9 行');
  equal(data.lessons[17].content, '补-18', '第 18 课时要落在第 18 行');
  equal(data.resources, '资源清单（补齐）', '收尾模块也要补齐');
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

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
