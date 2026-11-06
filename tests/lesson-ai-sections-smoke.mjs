/**
 * AI 教案生成回归测试（node tests/lesson-ai-sections-smoke.mjs）
 *
 * 覆盖「防截断 4 步改造」的每一项：
 *   ① 强制压低思考      —— lib/ai-core.js 的 buildUpstreamRequestBody 带 reasoning_effort:'low'
 *   ② 纯文本分隔符协议  —— 后端 Prompt 逐段写清 ===KEY===，前端 parseLessonSections 按 === 切段
 *   ③ 解除字数封印 + 详实度/创新性 —— 每段改字数下限、角色设定、创新硬要求、四维度、Few-shot 范例
 *   ④ 流式容错 + 断点保护 —— 前端超时 120 秒，接收中断也保留已收到的文字
 *
 * 只测纯逻辑（不碰网络、不碰真实 AI）；真实链路由 tests/e2e/lesson-ai-truncation.e2e.js 覆盖。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  buildLessonRequest, buildUpstreamRequestBody,
  LESSON_SECTIONS, LESSON_SECTION_KEYS, LESSON_AI_MAX_TOKENS,
  LESSON_SYSTEM_PROMPT, LESSON_PROCESS_DIMENSIONS, LESSON_INNOVATION_RULES, LESSON_INNOVATION_EXAMPLE,
} = require(path.join(ROOT, 'lib/ai-core.js'));

const lessonsSource = fs.readFileSync(path.join(ROOT, 'js/lessons.js'), 'utf8');

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

/* 从 js/lessons.js 里抠出纯函数与常量，在 vm 沙箱里跑（不加载整个页面） */
function extractBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`js/lessons.js 里找不到 ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    else if (source[i] === '}') {
      depth--;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`提取 ${name} 失败`);
}
function extractConst(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([\\s\\S]*?);\\n`));
  if (!match) throw new Error(`js/lessons.js 里找不到 ${name}`);
  return match[1];
}
const sandbox = {
  LESSON_SECTION_TITLES: vm.runInNewContext(`(${extractConst(lessonsSource, 'LESSON_SECTION_TITLES')})`),
};
vm.runInNewContext(`${extractBlock(lessonsSource, 'parseLessonSections')}\nthis.parseLessonSections = parseLessonSections;`, sandbox);

const FRONTEND_KEYS = Object.keys(sandbox.LESSON_SECTION_TITLES);
const FRONTEND_TIMEOUT = Number(vm.runInNewContext(`(${extractConst(lessonsSource, 'LESSON_AI_TIMEOUT_MS')})`));

console.log('\n🧪 AI 教案生成（防截断 4 步改造）回归测试\n');

/* ================= ① 强制压低模型思考 ================= */

await test('① 上游请求体带 reasoning_effort=low（思考不再吃满 max_tokens）', async () => {
  const built = buildLessonRequest({ grade: '三年级', topic: '篮球原地运球', studentCount: 30 });
  assert(!built.error, `buildLessonRequest 返回错误：${built.error?.message}`);
  const body = JSON.parse(buildUpstreamRequestBody(
    { apiUrl: 'https://example.test/v4/chat/completions', apiKey: 'k', model: 'glm-5.3-flashx' },
    built,
  ));
  equal(body.reasoning_effort, 'low', 'reasoning_effort 必须是 low');
  equal(body.stream, true, '必须是流式');
  assert(body.max_tokens >= 8192, `max_tokens 太小：${body.max_tokens}`);
  equal(body.max_tokens, LESSON_AI_MAX_TOKENS, 'max_tokens 必须与 LESSON_AI_MAX_TOKENS 一致');
});

/* ================= ② 纯文本 === 分隔符协议 ================= */

await test('② Prompt 逐段写清 ===KEY===，且禁止 JSON / 代码围栏', async () => {
  const built = buildLessonRequest({ grade: '三年级', topic: '篮球原地运球', studentCount: 30 });
  const prompt = built.messages.map(m => m.content).join('\n');
  LESSON_SECTION_KEYS.forEach(key => {
    assert(prompt.includes(`===${key}===`), `Prompt 里缺少分段标记 ===${key}===`);
  });
  assert(/不要输出\s*JSON|禁止\s*JSON/.test(prompt), 'Prompt 必须明确禁止 JSON');
  assert(!/```json/.test(prompt), 'Prompt 不应出现 JSON 代码围栏示例');
});

await test('② 前后端分段 key 严格一一对应（漏一个就会丢一段）', async () => {
  equal(FRONTEND_KEYS.join(','), LESSON_SECTION_KEYS.join(','), '前端 LESSON_SECTION_TITLES 与后端 LESSON_SECTIONS 的 key 不一致');
  equal(LESSON_SECTION_KEYS.length, 9, '分段数量必须是 9');
});

await test('② 前端按 === 切段：9 段齐全、内容一字不差', async () => {
  const sample = [
    '===CONTENT===', '教学内容正文',
    '===TARGET===', '1.运动能力：xxx', '2.健康行为：yyy', '3.体育品德：zzz',
    '===KEYPOINT===', '重点：aaa', '难点：bbb',
    '===EQUIPMENT===', '器材：ccc',
    '===PREPARATION===', '准备部分正文',
    '===BASIC_PART===', '基本部分正文',
    '===END_PART===', '结束部分正文',
    '===DENSITY===', '密度：ddd',
    '===REFLECTION===', '反思：eee',
  ].join('\n');
  const parsed = sandbox.parseLessonSections(sample);
  equal(parsed.hasSections, true, '必须识别出分段');
  equal(parsed.order.join(','), LESSON_SECTION_KEYS.join(','), '分段顺序不对');
  equal(parsed.sections.CONTENT, '教学内容正文', 'CONTENT 段内容不对');
  equal(parsed.sections.TARGET, '1.运动能力：xxx\n2.健康行为：yyy\n3.体育品德：zzz', 'TARGET 段必须保留换行');
  equal(parsed.sections.KEYPOINT, '重点：aaa\n难点：bbb', 'KEYPOINT 段内容不对');
  equal(parsed.sections.REFLECTION, '反思：eee', 'REFLECTION 段内容不对');
});

await test('② 缺一段只丢那一段：前面的段落照样能用（防截断核心）', async () => {
  const truncated = [
    '===CONTENT===', '教学内容正文',
    '===TARGET===', '1.运动能力：xxx',
    '===KEYPOINT===', '重点：aaa', '难点：bbb',
    '===EQUIPMENT===', '器材：ccc',
    '===PREPARATION===', '准备部分正文',
    '===BASIC_PART===', '基本部分写到一半就被掐断了',
    // 后面的 END_PART / DENSITY / REFLECTION 全都缺了
  ].join('\n');
  const parsed = sandbox.parseLessonSections(truncated);
  equal(parsed.sections.BASIC_PART, '基本部分写到一半就被掐断了', '被掐断的那段也要保留已写出的内容');
  equal(parsed.sections.CONTENT, '教学内容正文', '前面的段落不能因为后面缺失而丢');
  equal(parsed.sections.REFLECTION, undefined, '缺失的段应为空');
  assert(!Object.keys(parsed.sections).includes('END_PART'), '缺失的段不该凭空出现');
});

await test('② 同名段以后出现的为准（续写补全会再给一次同名段）', async () => {
  const continued = [
    '===BASIC_PART===', '第一版基本部分',
    '===BASIC_PART===', '第二版基本部分（更完整）',
  ].join('\n');
  const parsed = sandbox.parseLessonSections(continued);
  equal(parsed.sections.BASIC_PART, '第二版基本部分（更完整）', '同名段必须取最新一份');
});

/* ================= ③ 解除字数封印 + 详实度 / 创新性 ================= */

const LESSON_SAMPLE_INPUT = { grade: '三年级', topic: '篮球原地运球', studentCount: 30 };
function lessonPromptParts() {
  const built = buildLessonRequest(LESSON_SAMPLE_INPUT);
  assert(!built.error, `buildLessonRequest 返回错误：${built.error?.message}`);
  return { built, system: built.messages[0].content, user: built.messages[1].content };
}

await test('③ 每段都有字数下限，且 Prompt 里再无任何字数封印', async () => {
  LESSON_SECTIONS.forEach(section => {
    assert(Number.isInteger(section.min) && section.min > 0, `${section.key} 缺字数下限`);
    assert(section.min >= 120, `${section.key} 下限过低：${section.min}`);
    assert(section.limit === undefined, `${section.key} 还留着 limit 上限字段`);
  });
  const { system, user } = lessonPromptParts();
  const prompt = `${system}\n${user}`;
  LESSON_SECTIONS.forEach(section => {
    assert(prompt.includes(`不少于 ${section.min} 字`), `Prompt 里没有 ${section.key} 的字数下限`);
  });
  ['不超过', '字以内', '请控制每个环节的字数', '不要废话', '控制在要求的字数以内']
    .forEach(seal => assert(!prompt.includes(seal), `Prompt 里还残留字数封印「${seal}」`));
  assert(prompt.includes('总字数在 2500 字左右'), '要写明总字数目标');
  assert(prompt.includes('极度详实'), '要写明详实度要求');
  assert(prompt.includes('内容越具体越好'), '要写明越具体越好');
});

await test('③ 角色设定 + 2022 课标「学练赛评一体化」+ 创新硬要求', async () => {
  const { system, user } = lessonPromptParts();
  ['20 年经验的省级体育教研员', '擅长创设新颖的教学情境',
    '义务教育体育与健康课程标准（2022年版）', '学练赛评一体化', '充满创意的体育课']
    .forEach(word => assert(system.includes(word), `系统提示词缺少「${word}」`));
  ['情境创新', '器材一物多用', '游戏化教学', '评价创新', '差异化设计',
    '特种兵训练营', '星际探险', '积分挑战赛', '闯关夺星']
    .forEach(word => assert(user.includes(word), `创新要求缺少「${word}」`));
  equal(LESSON_INNOVATION_RULES.length >= 6, true, '创新规则要逐条列出');
});

await test('③ 教学过程每个子环节都被钉死四个维度', async () => {
  const { user } = lessonPromptParts();
  ['教师活动', '学生活动', '组织形式', '安全与易犯错误']
    .forEach(word => assert(user.includes(word), `四维度缺少「${word}」`));
  ['教师【原话口令】', '每人几次', '互评', '达标标准',
    '四列横队', '分组散点', '圆形队', '前后 1 米']
    .forEach(word => assert(user.includes(word), `四维度细则缺少「${word}」`));
  ['PREPARATION', 'BASIC_PART', 'END_PART']
    .forEach(key => assert(user.includes(`===${key}===`), `教学过程缺少 ${key} 的写作要求`));
  assert(user.includes('至少 3 个、建议 4 个子环节'), '基本部分要拆子环节');
  equal(LESSON_PROCESS_DIMENSIONS.length, 4, '四维度模板必须是 4 条');
});

await test('③ Few-shot 创新范例已拼进 Prompt，且不会污染 === 分段协议', async () => {
  const { user } = lessonPromptParts();
  assert(LESSON_INNOVATION_EXAMPLE.length >= 300,
    `范例太短（${LESSON_INNOVATION_EXAMPLE.length} 字），起不到示范密度的作用`);
  ['发射火箭', '火箭舱', '积分挑战赛', '能量门', '标志桶', '教师活动', '组织形式', '安全与易犯错误']
    .forEach(word => assert(LESSON_INNOVATION_EXAMPLE.includes(word), `范例缺少「${word}」`));
  assert(!/===\s*[A-Z_]+\s*===/.test(LESSON_INNOVATION_EXAMPLE),
    '范例里不能出现 ===KEY===（否则会被前端 parseLessonSections 误切段）');
  assert(user.includes(LESSON_INNOVATION_EXAMPLE), '范例必须真的拼进 user Prompt');
});

await test('③ 续写模式也带上四维度与创意要求，且不再要求精简', async () => {
  const built = buildLessonRequest({
    ...LESSON_SAMPLE_INPUT, mode: 'continue', lesson: { content: '===CONTENT===\n已有内容' },
  });
  assert(!built.error, `续写请求返回错误：${built.error?.message}`);
  const user = built.messages[1].content;
  assert(user.includes('教师活动（含教师原话口令）'), '续写也要写教师原话口令');
  assert(user.includes('组织形式（具体队形与间距）'), '续写也要写队形');
  assert(user.includes('安全与易犯错误'), '续写也要写易错点');
  assert(!/请控制每个环节的字数|不要废话/.test(user), '续写也不能带字数封印');
});

await test('③ 技术架构不变：纯文本 === 分段 + 禁 JSON + 流式 + 大 token 预算', async () => {
  const { built, system, user } = lessonPromptParts();
  assert(system.includes('禁止输出 JSON'), '系统提示词必须禁 JSON');
  assert(system.includes('大括号 { }'), '要明确禁止大括号');
  assert(user.includes('不要输出 JSON'), 'user Prompt 必须禁 JSON');
  LESSON_SECTION_KEYS.forEach(key => assert(system.includes(`===${key}===`), `系统提示词缺 ${key}`));
  assert(!built.response_format, '绝不能传 response_format: json_object');
  equal(built.max_tokens, LESSON_AI_MAX_TOKENS, 'max_tokens 必须保持不变');
  const body = JSON.parse(buildUpstreamRequestBody(
    { apiUrl: 'https://example.test/v4/chat/completions', apiKey: 'k', model: 'glm-5.3-flashx' },
    built,
  ));
  equal(body.stream, true, '必须继续走流式');
  equal(body.reasoning_effort, 'low', '仍要压低思考量，给正文留 token');
  assert(!body.response_format, '上游请求体也不能带 response_format');
});

/* ================= ④ 流式容错 + 断点保护 ================= */

await test('④ 前端超时放宽到 120 秒（与服务端 AI_TIMEOUT_MS 对齐）', async () => {
  equal(FRONTEND_TIMEOUT, 120000, 'LESSON_AI_TIMEOUT_MS 必须是 120000');
  assert(lessonsSource.includes('AbortController'), '必须用 AbortController 控制超时');
  assert(lessonsSource.includes('clearTimeout'), '必须在 finally 里清理定时器');
});

await test('④ 断点保护：接收中断也保留已收到的文字，绝不清空页面', async () => {
  const streamFn = extractBlock(lessonsSource, 'streamLessonMarkdown');
  assert(/catch\s*\([^)]*\)\s*\{[\s\S]*?broken\s*=\s*true/.test(streamFn),
    '读取流的 catch 里必须标记 broken（而不是直接抛错）');
  assert(/catch\s*\([^)]*\)\s*\{[\s\S]*?content\.length/.test(streamFn),
    'catch 里必须统计已收到的字数（说明内容被保留）');
  assert(!/catch\s*\([^)]*\)\s*\{\s*throw\s+/.test(streamFn),
    'catch 里不能直接抛错把已收到的内容丢掉');
  assert(/truncated:\s*truncated\s*\|\|\s*broken/.test(streamFn),
    '中断必须标记为 truncated（前端提示可续写），而不是当成成功');
  const genFn = extractBlock(lessonsSource, 'generateLessonWithAI');
  assert(/kept\s*=\s*String\(aiLessonDraft\?\.content/.test(genFn),
    '生成失败分支必须保留已收到的内容');
  assert(/已保留/.test(genFn), '生成失败分支必须提示"已保留"');
});

await test('④ 生成完成后按分段回填表单：分段 → 对应输入框', async () => {
  assert(lessonsSource.includes('fillLessonFormFromSections'), '必须有分段回填函数');
  ['objectiveKnowledge', 'objectiveSkill', 'objectiveAttitude', 'keyPoints',
    'difficultyPoints', 'equipment', 'practiceDensity', 'reflection']
    .forEach(name => assert(lessonsSource.includes(`'${name}'`), `没有回填字段 ${name}`));
  assert(/renderLessonProcessSteps/.test(lessonsSource), '教学过程必须用 DOM 属性回填（长文本不走 HTML 字符串往返）');
});

/* ---------------- 汇总 ---------------- */
const failed = results.filter(r => !r.ok);
console.log(`\n${failed.length ? '❌' : '✅'} 共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项\n`);
if (failed.length) {
  failed.forEach(item => console.error(`  ✗ ${item.name}\n    ${item.error.stack || item.error.message}`));
  process.exit(1);
}
