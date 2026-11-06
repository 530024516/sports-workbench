/**
 * AI 能力核心：教案 / 大单元 / 健身助手 共用
 * 同时被本地 node server.js 与 Vercel Serverless Function（api/ai.js）复用
 *
 * 环境变量优先级：
 *   1. AI_API_URL / AI_API_KEY / AI_MODEL（自定义覆盖）
 *   2. ZHIPU_API_KEY / ZHIPU_MODEL（Vercel 部署时使用）
 *   3. VITE_ZHIPUAI_API_KEY / VITE_ZHIPUAI_MODEL（本地 .env.local）
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { requireAdmin } = require('./admin-auth.js');
const unitCatalog = require(path.resolve(__dirname, '..', 'js', 'unit-catalog.js'));
// 截断 JSON 的强制修复（手写扫描器，不引第三方依赖）：模型吐到一半被掐断时抢救已生成的内容
const { repairTruncatedJSON } = require(path.resolve(__dirname, '..', 'js', 'json-repair.js'));

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ZHIPUAI_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_MODEL = 'glm-5.3-flashx';

const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 120000;
const LESSON_AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 32768;
/* ⚠️ 推理模型（glm-5.x 等）默认先吐一大段 reasoning_content，而前端只读 delta.content。
   实测 lesson_single 的 1024 tokens 会被思考过程（约 2300 字）全部吃光 →
   finish_reason=length、正文 0 字 → 18 个课时在浏览器里全空白。
   reasoning_effort:'low' 让模型直接给正文（实测思考 0 字、4.5s、finish_reason=stop）。
   非推理模型会忽略这个字段；如需完全不带，设 AI_REASONING_EFFORT=none。 */
const AI_REASONING_EFFORT = String(process.env.AI_REASONING_EFFORT || 'low').trim();
/**
 * 大单元生成改为「按模块分步生成 + 前端自动拼装」的流水线模式。
 *
 * 根因：模型有【单次输出上限】（实测 3600 字左右就被掐断），
 *      一次请求既要写 10 个模块又要写 18 个课时，输出量必然越界 —— JSON 被拦腰截断。
 * 治法：每次请求只负责一小块内容，把输出量压到上限之内；前端按顺序发起多个请求，
 *      每拿到一块就立刻合并进当前数据 —— 于是【不可能再出现截断】，还能边等边看。
 *
 * 阶段划分（输出量已被各自的字数约束钉死）：
 *   ① analysis   模块 1–5 ：单元名称 / 教学目标 / 教材分析 / 学情分析 / 主要教学内容 / 教学重难点
 *   ② structure  模块 6   ：18 个结构图节点 + 主要项目
 *   ③ lessons    模块 7   ：一次只写 1 个课时（startLesson / endLesson），共 18 批，输出 Markdown 表格
 *   ④ closing    模块 8–9 ：考核与作业 / 教学反思
 *   ⑤ rubric     模块 10 ：单元学习评价表（四等级量规 + 素养占比 + 细分得分点）
 *
 * ⚠️ max_tokens 只是上限，真正决定成败的是模型自身的单次输出上限。
 *    现在改用【纯文本 + 固定分隔符】，被掐断最多丢一段、不会整份作废，
 *    所以长文本阶段（analysis / lessons / rubric）可以放开字数写足 —— 写短了才是真正的浪费。 */
const UNIT_STAGE_MAX_TOKENS = {
  analysis: Number(process.env.UNIT_ANALYSIS_MAX_TOKENS) || 8192,
  analysis_part1: Number(process.env.UNIT_ANALYSIS_MAX_TOKENS) || 8192,
  analysis_part2: Number(process.env.UNIT_ANALYSIS_MAX_TOKENS) || 8192,
  structure: Number(process.env.UNIT_STRUCTURE_MAX_TOKENS) || 2048,
  lessons: Number(process.env.UNIT_LESSONS_MAX_TOKENS) || 2048,
  lesson_single: Number(process.env.UNIT_LESSON_SINGLE_MAX_TOKENS) || 1024,
  closing: Number(process.env.UNIT_CLOSING_MAX_TOKENS) || 2048,
  rubric: Number(process.env.UNIT_RUBRIC_MAX_TOKENS) || 3072,
};
/** 课时表分批：一次只写 1 个课时（批越小越不可能被截断） */
const UNIT_LESSON_CHUNK = Number(process.env.UNIT_LESSON_CHUNK) || 1;
//** 18 课时的固定分批：18 批，每批 1 个课时 */
const UNIT_LESSON_BATCHES = Array.from({ length: 18 }, (_, index) => [index + 1, index + 1]);
const UNIT_AI_MAX_TOKENS = Math.max(...Object.values(UNIT_STAGE_MAX_TOKENS));
const FITNESS_AI_MAX_TOKENS = 4096;

const MAX_BODY_BYTES = {
  lesson: 64 * 1024,
  unit: 32 * 1024,
  fitness: 16 * 1024,
};
const MAX_RESPONSE_BYTES = {
  lesson: 16 * 1024 * 1024,
  unit: 16 * 1024 * 1024,
  fitness: 8 * 1024 * 1024,
};
// 类型未知时先按通用上限读取请求体，确定类型后再按类型上限校验
const GENERIC_MAX_BODY_BYTES = 64 * 1024;

const TYPE_ALIASES = {
  lesson: 'lesson',
  'generate-lesson': 'lesson',
  unit: 'unit',
  'unit-design': 'unit',
  'generate-unit-design': 'unit',
  fitness: 'fitness',
  'generate-fitness': 'fitness',
};

// 兜底：若未安装 dotenv（例如直接 node server.js 且没跑 npm install），仍尝试手读 .env.local
// 已由 dotenv 写入的变量不会被覆盖；任何解析异常只警告，不让服务启动失败
function loadLocalEnvironment() {
  const envPath = path.join(PROJECT_ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        console.warn(`[env] 忽略 .env.local 第 ${index + 1} 行（格式无法解析）`);
        return;
      }
      const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    });
  } catch (error) {
    console.warn(`[env] 读取 .env.local 失败，已忽略：${error.message}`);
  }
}

loadLocalEnvironment();

function resolveAIConfig() {
  const placeholder = /^(你的智谱API_Key|your_zhipu_api_key)$/i;
  const candidates = [
    { url: process.env.AI_API_URL, key: process.env.AI_API_KEY, model: process.env.AI_MODEL },
    { url: process.env.ZHIPU_API_URL, key: process.env.ZHIPU_API_KEY, model: process.env.ZHIPU_MODEL },
    { url: null, key: process.env.VITE_ZHIPUAI_API_KEY, model: process.env.VITE_ZHIPUAI_MODEL },
  ];
  for (const candidate of candidates) {
    const apiKey = String(candidate.key || '').trim();
    if (!apiKey || placeholder.test(apiKey)) continue;
    const apiUrl = String(candidate.url || ZHIPUAI_API_URL).trim() || ZHIPUAI_API_URL;
    const model = String(candidate.model || '').trim() || DEFAULT_MODEL;
    return { apiUrl, apiKey, model };
  }
  return { apiUrl: '', apiKey: '', model: '' };
}

/* ---------- 通用工具 ---------- */

function sendJson(res, status, data) {
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }
  res.status(status).json(data);
}

function getStreamFinishReason(frame) {
  const dataLines = [];
  frame.split(/\r?\n/).forEach(line => {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  });
  const data = dataLines.join('\n');
  if (!data || data === '[DONE]') return '';
  try {
    return JSON.parse(data)?.choices?.[0]?.finish_reason || '';
  } catch {
    return '';
  }
}

/** 从一帧 SSE 里取出本帧的文本增量（用于服务端累计内容，好在截断时抢救） */
function getStreamDeltaContent(frame) {
  const line = String(frame).split(/\r?\n/).find(item => item.startsWith('data:'));
  if (!line) return '';
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return '';
  try {
    const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
    return typeof delta === 'string' ? delta : '';
  } catch {
    return '';
  }
}

function getAIUpstreamError(statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    return '智谱 API Key 无效或无权访问，请检查密钥和账户权限。';
  }
  if (statusCode === 429) {
    return '智谱 API 请求过于频繁或额度不足，请稍后重试并检查账户额度。';
  }
  if (statusCode === 400) {
    return '智谱 API 拒绝了请求，请检查模型名称、请求参数和 JSON 模式配置。';
  }
  return `AI 服务返回错误（HTTP ${statusCode}）`;
}

function getAIRequestError(error) {
  if (['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error.code)) {
    return 'AI 处理时间较长或连接中断，请稍后重试。';
  }
  return `AI 服务请求失败：${error.message}`;
}

function isLocalAIRequest(req) {
  if (process.env.VERCEL) return true;
  const remoteAddress = req.socket?.remoteAddress || '';
  if (remoteAddress !== '::1' && remoteAddress !== '127.0.0.1' && !remoteAddress.startsWith('::ffff:127.')) return false;
  const origin = req.headers?.origin;
  return !origin || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin);
}

// 读取请求体：Vercel 会预解析 req.body，本地 node 走原始流
// 返回 { input, bytes }，类型确定后再按类型上限校验大小
function readJsonBody(req, maxBytes) {
  const parse = text => {
    try {
      return { input: JSON.parse(text || '{}'), bytes: Buffer.byteLength(text || '') };
    } catch {
      const error = new Error('请求必须是有效 JSON');
      error.status = 400;
      throw error;
    }
  };

  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      resolve({ input: req.body, bytes: Buffer.byteLength(JSON.stringify(req.body)) });
      return;
    }
    if (typeof req.body === 'string') {
      try {
        resolve(parse(req.body));
      } catch (error) {
        reject({ status: 400, message: error.message });
      }
      return;
    }
    if (typeof req.on !== 'function') {
      reject({ status: 400, message: '缺少请求体' });
      return;
    }
    const chunks = [];
    let receivedBytes = 0;
    let settled = false;
    req.on('data', chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        settled = true;
        reject({ status: 413, message: '请求内容过大' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', error => {
      if (!settled) reject({ status: 400, message: `读取请求失败：${error.message}` });
    });
    req.on('end', () => {
      if (settled) return;
      try {
        resolve(parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject({ status: 400, message: error.message });
      }
    });
  });
}

/* ---------- Prompt 构建 ---------- */

const LESSON_SYSTEM_PROMPT = '你是一名拥有20年经验的省级优秀体育教研员。请根据用户输入为小学体育课编写详尽、专业、安全、可执行的教案。最终只输出 Markdown 正文，不输出 JSON、代码围栏或额外解释。请直接输出核心教学步骤和教师口令，不要输出任何过多的寒暄、背景解释或废话，把所有的字数额度都留给具体的教学环节。使用二级模块标题、三级环节标题、列表与粗体标签。必须包含教学内容、教学目标（三维）、重难点、场地器材、教学过程、预计练习密度与心率、课后反思。**【四、教学过程】必须极其详尽，严格分为以下三个部分，缺少任何一部分均视为不合格：**\n**1. 准备部分（约 8 分钟）**：必须写明热身活动内容、教师口令、组织形式（如四列横队）。\n**2. 基本部分（约 25 分钟）**：这是核心，必须分为（1）导入与示范（2）学生分组练习（3）学练赛环节。每个环节必须详细写出：①教师怎么教、怎么巡视 ②学生怎么练、分几组、每人练几次 ③易犯错误及纠正方法。\n**3. 结束部分（约 7 分钟）**：必须写明放松动作、总结讲评内容、回收器材。各部分时间必须标明且合计40分钟。内容符合小学年龄并写明场地器材安全要求。';

function buildLessonRequest(input) {
  const grade = String(input.grade || '').trim();
  const topic = String(input.topic || '').trim();
  const count = Number(input.studentCount);
  const isContinuation = input.mode === 'continue';
  const currentLesson = input.lesson;

  if (!/^([一二三四五六]年级)$/.test(grade) || !topic || topic.length > 120 || !Number.isInteger(count) || count < 1 || count > 100) {
    return { error: { status: 400, message: '请提供有效的年级、课题和 1–100 人的班级人数' } };
  }
  if (isContinuation && (
    !currentLesson || typeof currentLesson !== 'object' || Array.isArray(currentLesson)
    || typeof currentLesson.content !== 'string' || !currentLesson.content.trim()
  )) {
    return { error: { status: 400, message: '继续扩写需要提供当前教案内容' } };
  }

  const prompt = [
    `请为小学体育课生成一份详尽、专业、可直接用于课堂的完整教案，授课年级：${grade}，班级人数：${count}，课题：${topic}。`,
    '只输出 Markdown 正文，不要输出 JSON，不要使用 Markdown 代码围栏，不要在正文之外添加解释。',
    '请直接输出核心教学步骤和教师口令，不要输出任何过多的寒暄、背景解释或废话，把所有的字数额度都留给具体的教学环节。',
    '使用清晰的 ## 一级模块标题、### 环节标题、列表和 **粗体标签**，内容包含：一、教学内容；二、教学目标（运动能力、健康行为、体育品德）；三、教学重难点；四、场地器材；五、教学过程；六、预计练习密度与心率；七、课后反思。',
    '**【四、教学过程】必须极其详尽，严格分为以下三个部分，缺少任何一部分均视为不合格：**\n**1. 准备部分（约 8 分钟）**：必须写明热身活动内容、教师口令、组织形式（如四列横队）。\n**2. 基本部分（约 25 分钟）**：这是核心，必须分为（1）导入与示范（2）学生分组练习（3）学练赛环节。每个环节必须详细写出：①教师怎么教、怎么巡视 ②学生怎么练、分几组、每人练几次 ③易犯错误及纠正方法。\n**3. 结束部分（约 7 分钟）**：必须写明放松动作、总结讲评内容、回收器材。',
    '教学过程每一部分和每个子环节都要标明时间；8+25+7分钟合计40分钟。基本部分必须围绕具体技能，描述教师示范讲解与巡视、学生分组和个人练习次数、组织队形、练习递进、学练赛规则、安全提醒、常见错误及具体纠正方法。不得用一段泛泛总结替代实施步骤。',
    '安全要求：活动适合小学年龄，写明场地检查、学生间距、器材使用和停止活动的安全信号；器材安排适应班级人数，不臆造未提供的特殊条件。课后反思写成供教师课后填写的观察维度和问题，不得假称课堂已发生。',
    isContinuation
      ? `请接着上述内容继续生成教案的剩余部分，不要重复前面的内容，只输出续写的那一部分 Markdown 正文。重点补足或细化上述【四、教学过程】的三个部分，特别是25分钟基本部分中的三个子环节与每个环节的具体师生活动。当前已生成的教案内容：\n${String(currentLesson.content || '')}`
      : '请用具体、可执行的教学步骤描述每个环节，避免重复套话。',
  ].join('\n');

  return {
    temperature: 0.65,
    max_tokens: LESSON_AI_MAX_TOKENS,
    messages: [
      { role: 'system', content: LESSON_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  };
}

/**
 * 大单元「一键生成」的请求 —— 拆成 5 个小阶段，每次只吐一小块内容。
 * 每次请求的输出量都被 Prompt 里的字数约束钉死，因此不会再撞上模型的单次输出上限。
 */
/* ① 模块 1–5：前置分析 —— 【纯文本格式】（禁止 JSON）
   为什么不用 JSON：大段文字用 JSON 包装极易被模型的单次输出上限拦腰截断
   （{"objectives":"……" 这种长字符串一旦被砍断，整份 JSON 直接作废）。
   改用固定分隔符的纯文本后：分隔符本身很短、几乎不可能被切断；
   缺一段只会丢那一段，前面的段落照样能用 —— 这才是最防截断的终极方案。

   ⚠️ 下面不是占位符，而是【完整的 Few-shot 范文】（以篮球为例）：
      字数封印已经解除，这一节就是省级教研长文的水准样板 ——
      AI 照着这个密度、这个术语密度、这个论证方式来写，再换成当前选题的内容。 */
/* ①-1 模块 1–3：教学目标 / 教材分析 / 学情分析 —— 【纯文本格式】（禁止 JSON）
   前置分析拆成两段请求（part1 / part2），每段 ≤ 800 字 —— 拆得越碎，越不可能被截断。 */
const UNIT_FORMAT_ANALYSIS_PART1 = `===TITLE===
水平三篮球大单元

===OBJECTIVES===
1.运动能力：学生积极参与篮球运动的学习与比赛，能在对抗中运用急停急起变向运球与传切配合；知道篮球发展历史、比赛规则与安全常识；能够说出"跨步急停急起"与"运球投篮衔接"的动作要领与练习方法；能在降低要求的 2 对 2 游戏中反复学练并逐步规范；发展速度、灵敏、力量、耐力与柔韧，达到《国家学生体质健康标准》合格水平；每学期观看不少于 8 次比赛并能作简要评述。
2.健康行为：学生了解运动性损伤预防与常见急救方法，能主动完成热身与放松整理；能列举本项目的安全注意事项并遵守器材使用与归位规则；能制定并坚持每周 3 次课外锻炼计划并记录运动量；集体活动中与同伴保持安全的练习距离。
3.体育品德：学生克服畏难与失败心理、承受运动负荷并坚持完成任务；自觉遵守比赛规则与裁判判罚、公平竞争；主动承担组织者、裁判者与服务者角色，表现出团队协作意识；集体生活中文明礼貌、乐于助人。

===TEXTBOOK===
第一段：本单元以篮球为载体，覆盖基础知识与基本技能（球性练习、传接球、原地与行进间运球）、技战术运用（行进间变向运球、急停急起与运球投篮衔接、二打一与传切配合）、体能（速度、灵敏、力量、耐力、柔韧）、展示与比赛（2 对 2 半场对抗赛、三对三教学比赛、"争夺阵地"得分赛）、规则与裁判方法（走步、违例、犯规判罚、学生轮值裁判）、观赏与评价（观看 CBA 与校园联赛片段并评述技术战术）。18 个课次遵循"单一动作—组合动作—对抗运用"的递进线索。
第二段：篮球教材是落实"教会、勤练、常赛"的最佳载体。运动能力方面，球性练习与对抗比赛能发展协调性、时空感与战术决策能力，也是达成《国家学生体质健康标准》速度与耐力素质的重要途径；健康行为方面，密集的场地器材安全要求与热身放松环节，能让学生在真实情境中形成自我保护意识与规律锻炼习惯；体育品德方面，规则执行、裁判轮换与比赛胜负观，使规则意识与团队协作在真实情境中自然生成。

===STUDENTS===
水平三（5–6 年级）学生处于动作协调性快速发展期，注意力持续约 20 分钟，形象思维占优势，教学须"短步骤、高频次、强反馈"。该水平学生已有一定球性经验与基本跑跳能力，能完成简单原地运球与传接球，但运球抬头少、重心偏高、变向时机判断弱，对"急停急起与运球投篮衔接"这类重心快速转换的组合动作普遍畏难，对规则与裁判的理解停留在"看哨子"的层面。个体差异明显：部分女生力量与协调性偏弱、参与度低，部分男生好胜心强但动作变形大。教学中应按"降低要求、分层练习、比赛贯通"组织，用同伴互助照顾差异。`;

/* ①-2 模块 4–5：主要教学内容 / 教学重难点 —— 【纯文本格式】（禁止 JSON） */
const UNIT_FORMAT_ANALYSIS_PART2 = `===CONTENT===
1. 知识：篮球起源与发展、场地与规则、违例与犯规判罚、简单战术配合原理、比赛观赏与评述要点。
2. 技术：双手胸前传球、双手击地传球、原地高低运球、行进间直线运球、体前与背后变向运球、跨步急停急起、运球投篮衔接、双手投篮、行进间单手低手投篮。
3. 战术：二打一"墙式"配合、三角传球配合、传切配合、攻守转换基本站位、"1 字形"进攻落位与联防站位。
4. 体能：反应速度（折返跑、起动）、灵敏性（变向跑、绕障碍）、力量（负重蹲起、核心支撑）、耐力（连续运球折返、间歇跑）、柔韧（肩髋拉伸）。
5. 比赛活动：球性热身赛、2 对 2 半场对抗赛、三对三教学比赛、"争夺阵地"得分赛、全班循环赛与单元末技能达标赛。

===DIFFICULTIES===
学生学习重难点：重点：急停急起与运球投篮衔接的动作时机与重心转换；难点：连续变向后重心偏高、衔接步法混乱。原因是该技术要把两个动作在快速移动中连成整体，而该水平学生本体感觉尚在发展；应对措施是"分解—慢速—完整—加对抗"四级练习阶梯，用标志物提示落脚点，以"急—停—起—投"节奏口令固定动作顺序。
学习内容重难点：重点：二打一传切配合中传球队员的观察时机与接球队员的跑位；难点：变向后的接球判断。原因是战术配合建立在个人技术熟练与两人默契之上；应对措施是先固定"一人定点+一人跑动"的角色分工，用起动口令提示时机，再按成功次数计分的简化比赛固化跑位。
教学组织重难点：重点：18 课次跨 18 个班次、每班 40–45 人的器材轮换与练习密度；难点：器材不足导致等待时间过长与拥挤碰撞。原因是器材数量与班级人数不匹配；应对措施是"4 人小组定点练习—2 组轮换"的紧凑组织，每组配一名小组长负责器材归位与安全提醒，等待时间设计为模仿练习与拉伸。
教学方法重难点：重点：动作错误的即时发现与纠正；难点：初学者常把"急停"做成"急扑"。原因是初学阶段本体感觉尚未建立，单纯口头提示难以纠正；应对措施是"示范—对比—口诀—即时评价"四步法，用正误对比建立动作表象，共性错误集体纠正、个别错误个别辅导。`;

/** 两个 part 拼起来（回归测试与兼容用；实际请求只发其中一段） */
const UNIT_FORMAT_ANALYSIS = `${UNIT_FORMAT_ANALYSIS_PART1}

${UNIT_FORMAT_ANALYSIS_PART2}`;

/* ② 模块 6：结构图（18 个节点 + 主要项目） */
const UNIT_SCHEMA_STRUCTURE = `{
  "structure_nodes": [
    { "id": 1, "dimension": "基础知识", "title": "认识篮球与球性练习" },
    { "id": 2, "dimension": "基本技术", "title": "运球与游戏" }
    /* 必须恰好 18 项，id 从 1 到 18 各一次，不重复不遗漏；
       dimension 只能取：基础知识 / 基本技术 / 技战术运用 / 展示或比赛；
       title 只写这一课次的核心内容（≤12 字），不要写"第N课次："前缀。 */
  ],
  "main_projects": ["篮球运球", "传切配合"]
    /* 1–3 个主要项目名称（字符串数组），用于结构图底部的"主要项目"行。 */
}`;

/* ③ 模块 7：课时表（一次只写本批的 3 个课时） */
const UNIT_SCHEMA_LESSONS = `{
  "lessons": [
    { "no": 1, "dimension": "technique",
      "objectives": "1.运动能力：……\\n2.健康行为：……\\n3.体育品德：……",
      "content": "1.热身小游戏：……；2.技术学练：……；3.展示与比赛：……；4.体能练习：……",
      "method": "情境导入：……；教与学的方法：……；比赛活动：……；教学评价：……" }
  ]
}`;

/* ④ 模块 8–9：考核与作业 / 教学反思
   ⚠️ 原【模块 9：学习评价（纯文本）】已删除 —— 它与模块 10 的量规表内容重复。 */
const UNIT_SCHEMA_CLOSING = `{
  "assessment": "考核与作业（≤200字）",
  "reflection": "教学反思框架模板（≤200字）"
}`;

/* ③ 模块 7：课时表 —— 【一行 Markdown 表格】
   一次只写一个课时，表格只有一行 —— 被截断也只少半行，不会整份作废。
   单元格内部结构写死：学习目标三段 / 学习内容四要素 / 教学策略四要素，
   每格 100–150 字，写足写细（省级优质课的详实度），不再压缩成短语。 */
const UNIT_FORMAT_LESSONS = `| 课次 | 学习目标 | 主要学习内容 | 教学策略 |
|---|---|---|---|
| 第7课次 | **【学习目标】**<br>运动能力：学生积极参与篮球练习，能在对抗中运用急停急起变向运球完成突破，知道急停急起与运球投篮衔接的动作要领，能说出屈膝含胸、摆臂蹬地的发力顺序，发展速度、灵敏与协调素质。<br>健康行为：学生了解运动性损伤的预防方法，能主动完成热身与放松整理，养成练习前热身习惯，具备自我保护与安全意识。<br>体育品德：学生在对抗练习中克服紧张与畏难情绪，遵守比赛规则与裁判判罚，公平竞争并主动帮助同伴完成任务。 | **【主要学习内容】**<br>1.热身小游戏：绕障碍运球接力——两人一组绕 4 个标志桶往返接力，球不掉地即得 1 星，先完成 5 次的小组升级为"尖子队"。<br>2.技术学练：原地预摆弹性屈伸——屈膝含胸、摆臂蹬地、踝关节发力，30 次×2 组，体会起动时上下肢的协调配合。<br>3.展示与比赛：争夺阵地立定跳远比赛——两队各守一个半场，以远跳距离与落地稳定性判定阵地归属，先占 3 个阵地获胜。<br>4.体能练习：折返跑 4×30 米，间歇 30 秒，做 2 组，发展反应速度与下肢爆发力。 | **【教学策略 / 学练活动】**<br>1.情境导入：特种兵训练营——播放篮球经典比赛片段，明确本课三个闯关任务与闯关标准，学生以"特种兵小队员"身份接受挑战。<br>2.教与学的方法：示范讲解与自主学习相结合，先完整示范再分解练习，按"分解—慢速—完整—加对抗"四级练习阶梯推进，同伴互评纠错。<br>3.比赛活动：实时赛（比规则、比动作）与小组赛结合，实时赛按哨声启动比抢球与比脚步，小组赛按成功次数计分，输队做体能加练惩罚游戏。<br>4.教学评价：语言激励与勋章奖励，组评与师评相结合，按动作规范度与任务完成度记星，达标小队获得"特种兵勋章"。`;

/* ③-b 单课时（lesson_single）：一行纯文本，管道分隔 —— 连 Markdown 表格都不要
   模型最容易在这里"顺手"吐 JSON 数组；纯文本一行 + 明确的管道分隔，几乎不可能跑偏。
   解析端两种格式都认（Markdown 表格行 / 管道分隔行）。 */
const UNIT_FORMAT_LESSON_SINGLE = `第7课次 | 学习目标：【学习目标】<br>运动能力：学生积极参与篮球练习，能在对抗中运用急停急起变向运球完成突破，知道动作要领，发展速度、灵敏与协调素质。<br>健康行为：学生了解运动性损伤预防，能主动完成热身与放松整理，具备自我保护与安全意识。<br>体育品德：学生在对抗练习中克服紧张与畏难情绪，遵守比赛规则与裁判判罚，公平竞争并帮助同伴。 | 主要学习内容：【主要学习内容】<br>1.热身小游戏：绕障碍运球接力——两人一组绕 4 个标志桶往返接力，球不掉地得 1 星。<br>2.技术学练：原地预摆弹性屈伸——屈膝含胸、摆臂蹬地，30 次×2 组，体会起动发力顺序。<br>3.展示与比赛：争夺阵地立定跳远比赛——两队各守一个半场，按远跳距离判定阵地归属。<br>4.体能练习：折返跑 4×30 米，间歇 30 秒，做 2 组，发展反应速度与下肢爆发力。 | 教学策略：【教学策略 / 学练活动】<br>1.情境导入：特种兵训练营——播放篮球经典比赛片段，明确本课三个闯关任务与闯关标准。<br>2.教与学的方法：示范讲解与自主学习相结合，先完整示范再分解练习，按"分解—慢速—完整—加对抗"四级阶梯推进。<br>3.比赛活动：实时赛（比规则、比动作）与小组赛结合，实时赛按哨声启动，小组赛按成功次数计分。<br>4.教学评价：语言激励与勋章奖励，组评与师评相结合，按动作规范度与任务完成度记星。`;

/* ⑤ 模块 10：单元学习评价表 —— 【纯文本 + Markdown 表格】（禁止 JSON）
   量规表同样改用纯文本：表格行短、分隔符稳，截断了也只是少一两行，
   等级区间 / 素养占比 / 得分点合计这些硬约束由前端的 normalizeUnitRubric 兜底补齐。 */
const UNIT_FORMAT_RUBRIC = `===RUBRIC===
| 等级 | 分值 | 运动能力 | 健康行为 | 体育品德 |
| --- | --- | --- | --- | --- |
| 优秀 | 85-100 | 急停急起与运球投篮衔接动作规范熟练，能在对抗中灵活运用并主动创造传球机会，2 对 2 比赛中连续参与进攻与防守，体能测评达到优秀水平 | 每周 3 次课外锻炼并完整记录运动量，热身与放松主动完成，能准确说出本项目的常见损伤与预防方法 | 主动承担组织与裁判工作，规则判罚正确，比赛中公平竞争并主动鼓励同伴，赢得起也输得起 |
| 良好 | 75-84 | 技术较规范，能在比赛中有意识运用所练技术，偶有动作变形但能自行纠正 | 能坚持锻炼，基本掌握热身放松方法，能列举常见安全注意事项 | 能遵守规则，正确面对比分得失，能配合小组完成分工任务 |
| 合格 | 60-74 | 基本动作要领掌握，能在教师提示下完成主要练习任务，参与比赛但技术运用较少 | 在提醒下参与热身放松，能说出 1–2 条常见安全注意事项 | 在监督下遵守规则，能参与比赛与展示，愿意为小组出力 |
| 不合格 | 60以下 | 基本动作不熟练，练习任务完成困难，需教师或同伴持续帮助 | 不愿参与锻炼，不了解热身放松与安全常识 | 不能遵守规则，比赛中出现明显争执行为，需要教师干预 |

===WEIGHTS===
| 核心素养 | 占比 |
| --- | --- |
| 运动能力 | 60% |
| 健康行为 | 20% |
| 体育品德 | 20% |

===SCORES===
| 得分点 | 核心素养 | 分值 | 评价要点 |
| --- | --- | --- | --- |
| 运动知识 | 运动能力 | 12 | 考察篮球规则、违例判罚与技战术原理的掌握，采用课堂提问与规则情境判断题，答对 3 题以上记满分 |
| 运动技能 | 运动能力 | 36 | 考察急停急起与运球投篮衔接的动作规范与熟练度、传切配合的运用，采用技能达标与比赛表现各占一半评定 |
| 专项体能 | 运动能力 | 6 | 速度、灵敏与耐力达到《国家学生体质健康标准》合格水平，依据体测数据与课堂折返跑成绩评定 |
| 学习参与 | 运动能力 | 6 | 主动参与分组轮换、器材整理与小组自主练习，按出勤、任务完成度与小组贡献记分 |
| 健康知识 | 健康行为 | 6 | 理解运动性损伤预防与急救常识，能说出本项目常见伤害及预防方法，采用情境问答评定 |
| 运动习惯 | 健康行为 | 8 | 主动完成课前热身与课后放松，坚持每周 3 次课外锻炼并记录，依据打卡记录与课堂观察评定 |
| 心理健康 | 健康行为 | 6 | 能调节比赛胜负情绪、承受失败挫折并正确认识自我表现，采用自评与同伴互评结合评定 |
| 体育精神 | 体育品德 | 8 | 超越自我、遵守规则、公平竞争、积极进取，对抗中主动拼抢且不埋怨队友 |
| 道德品质 | 体育品德 | 6 | 文明礼貌、团结合作、尊重他人与爱护器材场地，每违反一次扣 1 分 |
| 规则意识 | 体育品德 | 6 | 能正确执行走步、违例与犯规判罚，担任裁判时判罚准确、乐于接受他人监督 |`;

/**
 * 课时表的内容规格。
 * 早前为了躲截断，把每格压到 20/50 字，结果教案干瘪失去价值；
 * 现在一次只写 1 个课时、输出量天然很小，截断风险已消失 ——
 * 于是反过来要求写细写足：每一格都是一份可以直接照着上课的微型教案。
 */
function unitLessonDetailRules(count) {
  const scope = count === 1 ? '本课时' : `这 ${count} 个课时`;
  return [
    '⛔ 内容详实度（写死 —— 要详实，但绝不是越长越好）：',
    `   · ${scope}的每一格写成 120–180 字的完整教学段落，绝不能只写几个字的短语（"运球练习""加强练习"这类不合格）；`,
    '   · 「学习目标」三段（运动能力 / 健康行为 / 体育品德），每段 50–70 字，按"积极参与……知道……能够说出……在……中运用……发展……素质"写可观察的表现；',
    '   · 「主要学习内容」用 Markdown 有序列表逐项写（1. 2. 3. 4.），四要素缺一不可：1.热身小游戏 / 2.技术学练 / 3.展示与比赛 / 4.体能练习；',
    '   ·   每项 30–40 字，写清【练什么 + 怎么练 + 练到什么程度】：动作名称、练习方法、组数次数、组织形式（如"原地预摆弹性屈伸——屈膝含胸、摆臂蹬地，30 次×2 组"）；',
    '   · 「教学策略 / 学练活动」同样用 Markdown 有序列表，四要素缺一不可：1.情境导入 / 2.教与学的方法 / 3.比赛活动 / 4.教学评价；',
    '   ·   每项 30–40 字，写清情境主题与任务、教法组合、比赛规则、评价办法（如"特种兵训练营""争夺阵地立定跳远比赛""实时赛（比规则/比动作）"）；',
    '   · 三格的第一行分别是小标题：【学习目标】【主要学习内容】【教学策略 / 学练活动】（可加 ** 加粗，前端会自动去掉星号）；',
    '   · 单元格内部换行一律用 <br>（不要用真实换行，否则表格会散架）；',
    '   · 必须出现体育专业术语：动作名称、练习方法、分组轮换、练习密度与强度、评价方式；',
    '   · 不得写"同上""略""详见上文"这类占位或空话。',
    '   · ⚠️ 三格合计控制在 450–600 字：写细但不啰嗦，写完立刻停 —— 超出这个量，格式就会被撑坏。',
  ].join('\n');
}

const UNIT_SYSTEM_PROMPT = [
  '你是深耕《义务教育体育与健康课程标准（2022年版）》的省级体育教研员，擅长大单元教学设计。',
  '严格依据课标：核心素养 = 运动能力 + 健康行为 + 体育品德；坚持"教会、勤练、常赛"，落实"学、练、赛、评"一体化。',
  '输出必须是、且仅是一个合法 JSON 对象（不要 Markdown 代码块、不要任何解释性文字）。',
  '语言：规范的简体中文书面语，具体、可观察、可直接用于教研交檔；不要空话套话，不要编造已发生的评价数据。',
  '安全红线：活动内容必须符合学生年龄特点与学校场地器材实际，写明分组、轮换、保护帮助与安全提示；不得设计危险动作。',
].join('\n');

/**
 * 纯文本阶段的系统提示词（analysis / rubric）。
 * 与 JSON 版的关键差别：明确"不要输出 JSON"，改为按分隔符输出纯文本 ——
 * 长文本用 JSON 包裹时被截断，等于整份作废；纯文本最多丢一段。
 */
const UNIT_SYSTEM_PROMPT_TEXT = [
  '你是深耕《义务教育体育与健康课程标准（2022年版）》的省级体育教研员，擅长大单元教学设计。',
  '严格依据课标：核心素养 = 运动能力 + 健康行为 + 体育品德；坚持"教会、勤练、常赛"，落实"学、练、赛、评"一体化。',
  '输出格式：【纯文本】。按用户指定的分隔符（如 ===OBJECTIVES===）组织内容；',
  '不要输出 JSON、不要输出 Markdown 代码块、不要写任何解释或开场白。',
  // 课时表的写法示例直接写进系统提示词 —— 模型照着示例写，比在用户提示词里反复强调管用得多
  '课时表（单课时）的输出形态就长这样，一行一课次，不要写成 JSON 数组、不要写大括号：',
  '第X课次 | 学习目标：…… | 主要学习内容：…… | 教学策略：……',
  '语言：规范的简体中文书面语，具体、可观察、可直接用于教研交檔；不要空话套话，不要编造已发生的评价数据。',
  '安全红线：活动内容必须符合学生年龄特点与学校场地器材实际，写明分组、轮换、保护帮助与安全提示；不得设计危险动作。',
].join('\n');

/**
 * 教学内容清单的清洗：只收短字符串，最多 24 条、每条 ≤ 80 字。
 * 24 条是按「篮球水平三/四 20 条」定的 —— 截得更狠会把比赛 / 规则 / 观赏这些维度整个丢掉，
 * 那样 AI 就又退化成只写技术了（实测最长的一条是 65 字的 [待确认] 条目，所以单条上限取 80）。
 * 输入侧多几百字不影响输出上限（真正的瓶颈是模型的输出）。
 */
function readTopicList(input) {
  if (!Array.isArray(input.topicList)) return [];
  return input.topicList
    .map(entry => String(entry || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(entry => (entry.length > 80 ? `${entry.slice(0, 80)}…` : entry))
    .slice(0, 24);
}

/** 选题校验：四个阶段的请求都要先过这一关 */
function readUnitSelection(input) {
  const category = String(input.category || '').trim();
  const item = String(input.item || '').trim();
  const level = String(input.level || '').trim();
  const topic = String(input.topic || '').trim();
  if (!category || !item || !level || !topic) {
    return { error: { status: 400, message: '请先在页面上完成「教材大类/细项」「水平」「教学内容」三项选择' } };
  }
  if ([category, item, level, topic].some(text => text.length > 80)) {
    return { error: { status: 400, message: '选项内容过长，请检查后重试' } };
  }
  // 前端会带上「细项 + 水平对应的具体教学内容清单」；没带（旧客户端）就按字典反查，保证 prompt 始终有抓手
  const topicList = readTopicList(input);
  const itemId = String(input.itemId || '').trim();
  const levelId = String(input.levelId || '').trim();
  return {
    category, item, level, topic,
    pending: input.topicPending === true,
    topicList: topicList.length ? topicList : unitCatalogTopics(itemId, levelId),
  };
}

/* 结构图分支键 ↔ 七大维度 id 的对照（战术的分支键沿用历史值 tactics） */
const UNIT_DIMENSION_BRANCH = {
  basic: 'basic',
  technique: 'technique',
  tactic: 'tactics',
  fitness: 'fitness',
  match: 'match',
  rule: 'rule',
  watch: 'watch',
};

/** 清单条目形如「【基本技术】原地运球」—— 取出维度名；没有前缀则返回空串 */
function unitDimensionLabelOf(entry) {
  const matched = String(entry || '').match(/^【([^】]+)】/);
  return matched ? matched[1] : '';
}

/** 统计清单里出现了哪些维度、各有多少条（按 UNIT_DIMENSIONS 顺序） */
function unitDimensionStats(topicList) {
  const known = unitCatalog.UNIT_DIMENSIONS || [];
  const stats = [];
  topicList.forEach(entry => {
    const label = unitDimensionLabelOf(entry);
    if (!label) return;
    let stat = stats.find(item => item.label === label);
    if (!stat) {
      const dimension = known.find(item => item.label === label);
      stat = { id: dimension ? dimension.id : '', label, count: 0 };
      stats.push(stat);
    }
    stat.count += 1;
  });
  const rankOf = label => {
    const index = known.findIndex(item => item.label === label);
    return index < 0 ? 99 : index;
  };
  return stats.sort((a, b) => rankOf(a.label) - rankOf(b.label));
}

/**
 * 18 课时在各维度上的"课标配比"（相对权重，不是绝对课时数）。
 * 按专项运动技能大单元的通行结构：技术为主体，知识/体能/比赛各占一部分，规则与观赏点到为止。
 * 只按"清单条目数"比例分会出问题：花样跳绳的比赛只有 2 条、技术有 5 条时，
 * 比例分配会算出 5 个比赛课时（同一条内容重复 3 遍），配比权重才是老师认的结构。
 */
const UNIT_DIMENSION_WEIGHT = {
  basic: 2, technique: 8, tactic: 3, fitness: 2.5, match: 2.5, rule: 1, watch: 1,
};

/**
 * 把 18 个课时按维度分配：每个维度至少 1 课时，余下按上面的配比权重给，合计必须正好 18。
 * 另外给每个维度加了"条目数 × 2"的上限（同一条内容最多上两课时：学习 + 进阶），
 * 超出的课时回流给权重最高的维度（通常是技术），避免"30 秒双摇计时赛"连上四节课。
 */
function unitDimensionQuota(stats, total = 18) {
  const items = (Array.isArray(stats) ? stats : [])
    .filter(stat => stat && stat.count > 0)
    .map(stat => ({ id: stat.id, label: stat.label, count: stat.count, lessons: 1 }));
  if (!items.length) return [];
  let left = total - items.length;
  if (left <= 0) return items;

  const weightOf = item => UNIT_DIMENSION_WEIGHT[item.id] ?? 2;
  const totalWeight = items.reduce((sum, item) => sum + weightOf(item), 0) || 1;
  items.forEach(item => { item.lessons += Math.floor((left * weightOf(item)) / totalWeight); });

  // 上限：同一维度的课时数不超过"条目数 × 2"
  let freed = 0;
  items.forEach(item => {
    const cap = Math.max(1, item.count * 2);
    if (item.lessons > cap) {
      freed += item.lessons - cap;
      item.lessons = cap;
    }
  });
  // 回流的课时按权重给"还没到上限"的维度
  const capOf = item => Math.max(1, item.count * 2);
  const byWeight = items.slice().sort((a, b) => weightOf(b) - weightOf(a));
  let index = 0;
  while (freed > 0 && index < total * 4) {
    const target = byWeight[index % byWeight.length];
    if (target.lessons < capOf(target)) {
      target.lessons += 1;
      freed -= 1;
    }
    index += 1;
  }
  // 所有维度都到上限了（内容很单一的细项，例如只有 1 条基础 + 3 条技术的跳跃类）：
  // 剩下的全给权重最高的维度 —— 宁可技术课时多，也不能让 18 个课时凑不满
  while (freed > 0) {
    byWeight[0].lessons += 1;
    freed -= 1;
  }
  // 取整误差：多退少补，保证总和正好等于 total
  const sum = () => items.reduce((total_, item) => total_ + item.lessons, 0);
  while (sum() < total) {
    const target = byWeight.find(item => item.lessons < capOf(item)) || byWeight[0];
    target.lessons += 1;
  }
  while (sum() > total) {
    const target = byWeight.slice().reverse().find(item => item.lessons > 1);
    if (!target) break;
    target.lessons -= 1;
  }
  return items;
}

/**
 * 18 课时计划表：把「课次号 → 维度 → 具体项目」一次性排定（纯函数，前后端可复算）。
 *
 * 有了它，课时表请求就【不需要再带整份教学内容清单】—— 每个批次只带自己那 6 行计划，
 * 输入 token 大幅下降，输出空间全部留给课时本身；同时 18 课时的维度分布也就被钉死了。
 *
 * 排布规则：
 *   ① 每个维度的课次数 = unitDimensionQuota() 的配额（每维度 ≥1，合计 18）；
 *   ② 维度顺序 = 基础知识 → 基本技术 → 战术 → 体能 → 比赛 → 规则 → 观赏（符合"先学后练再赛"）；
 *   ③ 同一维度内按清单条目顺序取用；条目不够时循环复用并标注进阶（进阶提高 / 综合运用与比赛检验）。
 */
function unitLessonPlan(topicList, total = 18) {
  const stats = unitDimensionStats(topicList);
  if (!stats.length) return [];
  const known = unitCatalog.UNIT_DIMENSIONS || [];
  const byDimension = new Map();
  topicList.forEach(entry => {
    const label = unitDimensionLabelOf(entry);
    if (!label) return;
    const dimension = known.find(item => item.label === label);
    if (!dimension) return;
    const list = byDimension.get(dimension.id) || [];
    list.push(entry.replace(/^【[^】]+】/, '').replace(/^\[待确认\]\s*/, '').trim());
    byDimension.set(dimension.id, list);
  });

  const plan = [];
  let no = 1;
  unitDimensionQuota(stats, total).forEach(item => {
    const entries = byDimension.get(item.id) || [item.label];
    for (let index = 0; index < item.lessons; index += 1) {
      const base = entries[index % entries.length] || item.label;
      const round = Math.floor(index / entries.length);
      const suffix = round === 0 ? '' : round === 1 ? '（进阶提高）' : '（综合运用与比赛检验）';
      plan.push({
        no,
        dimension: item.id,
        dimensionLabel: item.label,
        topic: `${base}${suffix}`,
      });
      no += 1;
    }
  });
  return plan.slice(0, total);
}

/** 计划表文本：只输出 [from, to] 这一段课次（分批请求时每批只给 6 行）
 *  ⚠️ withDimension=false：把维度从计划表里摘掉（只保留课次号与具体项目）。
 *     「维度」是系统排定的（前端 unitCurrentLessonPlan 已有），模型知道了更好写，
 *     但绝不能让它【输出】维度 —— 输出里多出来的 dimension / ===DIMENSION=== 就是废话。 */
function unitLessonPlanText(selection, from = 1, to = 18, options = {}) {
  const withDimension = options.withDimension !== false;
  const plan = unitLessonPlan(selection.topicList).filter(row => row.no >= from && row.no <= to);
  if (!plan.length) return '';
  const lines = [`【本批课次计划表】（第 ${from}–${to} 课次，课次号 · 具体项目已排定）：`];
  plan.forEach(row => {
    lines.push(withDimension
      ? `  第${row.no}课次｜${row.dimensionLabel}（${row.dimension}）｜${row.topic}`
      : `  第${row.no}课次｜${row.topic}`);
  });
  return lines.join('\n');
}

/**
 * 「这一课属于哪个维度」—— 只作为【输入】告诉模型（它据此写对内容），
 * 并明令禁止输出。维度键是前端排定的，输出与否都不影响数据正确性。
 */
function unitLessonDimensionHint(planRow) {
  if (!planRow) return '';
  return `  · 本课次维度（系统排定，仅供你理解本课定位）：${planRow.dimensionLabel}（${planRow.dimension}）`
    + ' —— 它只是给你定位用的，绝对不要写进输出，也不要写任何维度字段名或分隔标记；';
}

/**
 * 清掉上下文里的"维度噪音"。
 * 上一阶段的产物（尤其是批量课时表）里可能带着 ===DIMENSION=== / basic / technique 这类标记，
 * 模型看到就会照抄 —— 实测它照抄出来的 "===DIMENSION===\ntechnique" 直接把那一课的解析带偏。
 * 这里在进 prompt 前先把它们洗掉：只保留内容，不留标记。
 */
function unitStripDimensionNoise(text) {
  const raw = String(text ?? '');
  if (!raw) return '';
  return raw
    // ① 整段 ===DIMENSION=== … 到下一个分隔符为止
    .replace(/===DIMENSION===[\s\S]*?(?====[A-Z_]+===|$)/gi, '')
    // ② 单独一行的维度键（basic / technique / tactic / fitness / match / rule / watch）
    .replace(/^\s*(basic|technique|tactic|fitness|match|rule|watch)\s*$/gim, '')
    // ③ "dimension 取值 xxx" / "dimension: xxx" 这类说明
    .replace(/dimension\s*(取值|[:：])\s*[a-zA-Z_]+/gi, '')
    // ④ 正文里夹带的英文维度键（前后是分隔符或括号）
    .replace(/[（(]\s*(basic|technique|tactic|fitness|match|rule|watch)\s*[)）]/gi, '')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

/** 按字典反查教学内容清单（带维度前缀，与前端传过来的格式一致） */
function unitCatalogTopics(itemId, levelId) {
  if (!itemId || !levelId) return [];
  if (typeof unitCatalog.unitTopicListWithDimension === 'function') {
    return unitCatalog.unitTopicListWithDimension(itemId, levelId);
  }
  return (typeof unitCatalog.unitCatalogBrief === 'function'
    ? unitCatalog.unitCatalogBrief(itemId, levelId)?.topics
    : null) || [];
}

/**
 * 「所选细项 + 水平」对应的具体教学内容清单（给 AI 的硬抓手）。
 * 没有它，AI 只会泛泛地写"田径""球类"；有了它，18 课时会逐一落到具体项目上。
 */
function unitTopicCatalogText(selection) {
  if (!selection.topicList.length) return '';
  const stats = unitDimensionStats(selection.topicList);
  const lines = [
    `【${selection.item} · ${selection.level} 的具体教学内容清单】（共 ${selection.topicList.length} 条）：`,
    ...selection.topicList.map((entry, index) => `  ${index + 1}. ${entry}`),
    '⛔ 本单元必须围绕上面的具体项目来构建：把清单里的项目逐条分配到 18 个课次中，',
    `   禁止用"${selection.category}练习""综合练习""素质练习"这类笼统表述充当课时内容。`,
  ];
  if (!stats.length) return lines.join('\n');
  const quota = unitDimensionQuota(stats);
  lines.push(`条目前的【】是该内容的维度。本单元共涉及 ${stats.length} 个维度，18 课时必须按下面的配额分配（硬要求，不是建议）：`);
  quota.forEach(item => {
    lines.push(`   ${item.label}：${item.lessons} 个课时（清单 ${item.count} 条）→ dimension 取值 "${item.id}"`);
  });
  lines.push(`   合计 ${quota.reduce((sum, item) => sum + item.lessons, 0)} 个课时，每个维度至少 1 个课时，不得把课时全给技术。`);
  lines.push('维度与字段取值的对照（lessons[].dimension 必须用这里的英文键）：');
  lines.push(`   ${Object.keys(UNIT_DIMENSION_BRANCH).join('、')}`
    + '（basic 基础知识 / technique 基本技术 / tactic 战术 / fitness 体能 / match 比赛 / rule 规则 / watch 观赏）');
  lines.push('   提示：结构图节点 structure_nodes[].dimension 用中文泳道名（基础知识 / 基本技术 / 技战术运用 / 展示或比赛），'
    + '其中专项体能→基本技术、规则与裁判→技战术运用、观赏与评价→展示或比赛。');
  return lines.join('\n');
}

function unitTopicSentence(selection, extra = '') {
  const lines = [`选题：教材大类：${selection.category}；教材细项：${selection.item}；教学水平：${selection.level}；教学内容：${selection.topic}。本单元按 18 课时设计。`];
  const catalog = unitTopicCatalogText(selection);
  if (catalog) lines.push(catalog);
  if (extra) lines.push(extra);
  if (selection.pending) {
    lines.push('⚠️ 该教学内容属于"待确认"条目（可能因地域、场馆或课时条件存在差异），请在设计中保留必要的替代方案与安全提醒，并提示教师结合本校实际核对。');
  }
  return lines.join('\n');
}

/**
 * 把前端传来的「上一阶段结果」压成一小段上下文。
 * 必须压缩：上下文越长，留给输出的预算越少；但是我们又需要让后半部分与前半部分连贯。
 */
/**
 * @param {object} context 上一阶段结果
 * @param {object|number} options
 *   · 传数字 = 只看总字数上限（旧写法，保留兼容）
 *   · 传对象：{ limit, dimensions }
 *     - limit：总字数上限（课时表批次用 900，收尾模块用 2600）
 *     - dimensions：本批次真正要用到的维度 id 数组 —— 只把这些维度的清单条目带进 prompt。
 *       例：第 1–6 课次都是基础知识与基本技术，就没必要把体能、规则、观赏的条目塞进去，
 *       省下来的 token 全部留给输出。
 */
function unitContextBrief(context, options = {}) {
  if (!context || typeof context !== 'object') return '';
  const config = typeof options === 'number' ? { limit: options } : (options || {});
  const limit = Number(config.limit) > 0 ? Number(config.limit) : 2600;
  const onlyDimensions = Array.isArray(config.dimensions) ? config.dimensions : null;
  const known = unitCatalog.UNIT_DIMENSIONS || [];
  // 只留本批次用得上的维度条目：输入侧瘦身，输出侧才有空间写完 18 个课时
  const topicEntries = (Array.isArray(context.topicList) ? context.topicList : []).filter(entry => {
    if (!onlyDimensions) return true;
    const label = unitDimensionLabelOf(entry);
    const dimension = known.find(item => item.label === label);
    return !label || onlyDimensions.includes(dimension ? dimension.id : '');
  });
  const clip = (value, max) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const objectives = context.objectives || '';
  const difficulties = context.keyDifficulties || {};
  /**
   * 每一段都带 rank：数字越小越重要。
   * 以前是"拼完再整体截断"，结果 18 课次框架和教学内容清单的尾巴会被一起砍掉 ——
   * 后半段（课时表）就失去了抓手。现在改成按优先级保留，超限先丢次要段落。
   *   0 = 18 课次框架（没有它，阶段②的课时会和阶段①的结构图对不上）
   *   1 = 教学内容清单（没有它，AI 又退化成写"篮球练习"）
   *   2+ = 单元名称 / 目标 / 教学内容 / 重难点（丢了不影响课时表的维度结构）
   */
  const blocks = [
    {
      rank: 2,
      text: () => (context.unitTitle ? `单元名称：${clip(context.unitTitle, 40)}` : ''),
    },
    {
      rank: 1,
      text: () => (topicEntries.length
        ? `${onlyDimensions ? '本批次涉及的维度条目' : '本细项·本水平的教学内容清单（带维度）'}：${topicEntries.map(entry => clip(entry, 48)).join('；')}`
        : ''),
    },
    {
      rank: 3,
      // 学习目标现在是一段文本（运动能力 / 健康行为 / 体育品德 三段），旧版是三个字段也照样认
      text: () => {
        const text = typeof objectives === 'string'
          ? objectives
          : [['运动能力', objectives.ability], ['健康行为', objectives.health], ['体育品德', objectives.character]]
            .filter(([, value]) => value)
            .map(([label, value]) => `${label}｜${value}`).join('；');
        return text ? `单元目标：${clip(text, 220)}` : '';
      },
    },
    {
      rank: 4,
      text: () => (context.teachingContent ? `主要教学内容：${clip(context.teachingContent, 240)}` : ''),
    },
    {
      rank: 5,
      text: () => {
        const parts = [['学生学习', difficulties.learning], ['学习内容', difficulties.content],
          ['教学组织', difficulties.organization], ['教学方法', difficulties.method]].filter(([, value]) => value);
        return parts.length ? `重难点：${parts.map(([label, value]) => `${label}｜${clip(value, 60)}`).join('；')}` : '';
      },
    },
    {
      rank: 0,
      text: () => (Array.isArray(context.lessonTitles) && context.lessonTitles.length
        ? `18 课次框架（课次号：名称）：${context.lessonTitles.map(node => `${node.no}：${clip(node.title, 24)}`).join('；')}`
        : ''),
    },
  ];

  const ordered = blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => a.block.rank - b.block.rank);
  const kept = [];
  let used = 0;
  ordered.forEach(({ block, index }) => {
    const text = block.text();
    if (!text) return;
    if (used + text.length <= limit) {
      kept.push({ index, text });
      used += text.length + 1;
      return;
    }
    const room = limit - used;
    if (room > 40) kept.push({ index, text: `${text.slice(0, room - 1)}…` });   // 高优先级段落宁可截断也不能整段丢
    used = limit;
  });
  return kept.sort((a, b) => a.index - b.index).map(entry => entry.text).join('\n');
}

/**
 * 单课时的内容规格：比课时表更紧凑（一次只有一课）。
 * 目标：单次输出 < 500 字 —— 绝不可能撞上模型的输出上限。
 */
function unitLessonSingleRules() {
  return [
    '⛔ 内容规格（写死）：',
    '   · 「学习目标」三段（运动能力 / 健康行为 / 体育品德），每段 40–60 字；',
    '   · 「主要学习内容」四要素（1.热身小游戏 / 2.技术学练 / 3.展示与比赛 / 4.体能练习），每项 25–35 字；',
    '   · 「教学策略」四要素（1.情境导入 / 2.教与学的方法 / 3.比赛活动 / 4.教学评价），每项 25–35 字；',
    '   · 三格分别以【学习目标】【主要学习内容】【教学策略 / 学练活动】开头；',
    '   · 必须出现体育专业术语（动作名称、练习方法、组数次数、组织形式、评价方式）；',
    '   · 不得写"同上""略""详见上文"这类占位词；',
    '   · 三格合计 250–400 字：写完立刻停，多一个字都不要加。',
  ].join('\n');
}

const UNIT_STAGE_BUILDERS = {
  /**
   * ①-1 模块 1–3：单元名称 / 教学目标 / 教材分析 / 学情分析 —— 【纯文本输出】
   *
   * ⚠️ 前置分析已彻底拆成两段请求（analysis_part1 / analysis_part2）：
   *    一次只写 3 个模块、每段 ≤ 800 字 —— 拆得越碎，越不可能被模型的输出上限拦腰截断。
   *    （原来一次写 6 个模块 3000+ 字，实测会被截断。）
   */
  analysis_part1(selection) {
    const prompt = [
      '请为一个 18 课时的大单元教学设计生成【模块 1–3：单元名称 / 教学目标 / 教材分析 / 学情分析】。',
      unitTopicSentence(selection),
      '',
      '⛔ 输出格式：【纯文本】。绝对不要输出 JSON、不要输出 Markdown 代码块、不要加任何解释或开场白。',
      '   必须严格按下面的分隔符顺序输出，每个分隔符独占一行、分隔符原样写出来：',
      '   ⚠️ 下面是一份【范文示例】（以篮球为例），它的术语密度与论证方式就是本次要达到的水准；',
      '      内容必须全部替换成本次选题的项目、术语与数据，绝不可照抄篮球。',
      '',
      UNIT_FORMAT_ANALYSIS_PART1,
      '',
      '各段写法：',
      '1. ===TITLE=== 单元名称，20 字以内。',
      '2. ===OBJECTIVES=== 教学目标三段，一行一段（「运动能力：」「健康行为：」「体育品德：」这三个开头必须保留）。',
      '   · 运动能力段写满六件事：①积极参与；②知道（项目起源、价值与安全常识）；③能够说出（动作要领与练习方法）；④学练（在降低要求的游戏与对抗中反复练习、逐步规范）；⑤发展（速度/灵敏/力量/耐力/柔韧）并达到《国家学生体质健康标准》合格水平；⑥每学期观看不少于 8 次比赛并能作简要评述。',
      '   · 健康行为段写满：①了解运动性损伤预防与急救；②养成（热身/放松）习惯；③列举并遵守安全注意事项；④每周 3 次课外锻炼并记录运动量；⑤集体活动中的安全距离与器材规范。',
      '   · 体育品德段写满：①克服畏难与失败心理、承受运动负荷；②遵守规则与裁判判罚、公平竞争；③承担组织者/裁判者/服务者角色、团队协作；④文明礼貌、乐于助人。',
      '   · 必须"可观察、可评价"，不要写"培养兴趣""增强体质"这类无法评价的表述。',
      '3. ===TEXTBOOK=== 教材分析，必须分两段（两段之间空一行）：',
      '   · 第一段（结构化内容）：按"基础知识与基本技能、技战术运用、体能、展示与比赛、规则与裁判方法、观赏与评价"写清本单元覆盖什么，并点明 18 课次的递进线索；',
      '   · 第二段（核心素养价值）：逐条写教材如何承载运动能力、健康行为、体育品德，写清锻炼价值与育人价值。',
      '4. ===STUDENTS=== 学情分析：结合所选水平学生的认知特点、身体发育特点、已有经验、个体差异与常见障碍来写，并落到教学对策上。',
      '',
      '⛔ 篇幅要求：本次回复 ≤ 800 字（要详实，但绝不是越长越好）。',
      '   · ===TITLE=== ≤ 20 字；===OBJECTIVES=== 三段各 90–130 字；===TEXTBOOK=== 两段合计 260–320 字；===STUDENTS=== 180–240 字。',
      '   · 写完就停 —— 不要教学理念、课标原文、情绪渲染与重复句。',
      '',
      '必须把 4 个分隔符全部写出来 —— 少一个分隔符，那一段就作废。',
    ].join('\n');
    return { temperature: 0.6, max_tokens: UNIT_STAGE_MAX_TOKENS.analysis_part1, prompt, meta: { format: 'text' } };
  },

  /**
   * ①-2 模块 4–5：主要教学内容 / 教学重难点 —— 【纯文本输出】
   *
   * ⚠️ 与 analysis_part1 配套：两次请求 = 两段独立输出，任一段被截断都不影响另一段。
   */
  analysis_part2(selection) {
    const prompt = [
      '请为一个 18 课时的大单元教学设计生成【模块 4–5：主要教学内容 / 教学重难点】。',
      unitTopicSentence(selection),
      '',
      '⛔ 输出格式：【纯文本】。绝对不要输出 JSON、不要输出 Markdown 代码块、不要加任何解释或开场白。',
      '   必须严格按下面的分隔符顺序输出，每个分隔符独占一行、分隔符原样写出来：',
      '   ⚠️ 下面是一份【范文示例】（以篮球为例），它的术语密度与论证方式就是本次要达到的水准；',
      '      内容必须全部替换成本次选题的项目、术语与数据，绝不可照抄篮球。',
      '',
      UNIT_FORMAT_ANALYSIS_PART2,
      '',
      '各段写法：',
      '1. ===CONTENT=== 主要教学内容：用编号分行列出知识、技术、战术、体能与比赛活动，每一类都要列出具体项目名称（写到动作名，如"跨步急停急起""传切配合"）。',
      '2. ===DIFFICULTIES=== 教学重难点，四行，每行一个子维度，写成「XX重难点：重点：…… 难点：……；原因是……；应对措施是……。」：',
      '   · 学生学习重难点：学生理解、掌握与应用上的主要障碍；',
      '   · 学习内容重难点：本项目技术/战术本身的关键与难点；',
      '   · 教学组织重难点：分组、轮换、场地器材与安全组织上的难点；',
      '   · 教学方法重难点：示范讲解、练习阶梯、纠错与评价方法上的难点。',
      '   · 每一行都必须写清三件事：【为什么它会成为重难点】（结合学生实际或项目本身的特点分析原因）+【具体怎么破】（可操作的练习阶梯、教法、评价与组织措施）。',
      '',
      '⛔ 篇幅要求：本次回复 ≤ 800 字（要详实，但绝不是越长越好）。',
      '   · ===CONTENT=== 200–300 字；===DIFFICULTIES=== 四行各 110–150 字。',
      '   · 写完就停 —— 不要教学理念、课标原文、情绪渲染与重复句。',
      '',
      '必须把 2 个分隔符全部写出来 —— 少一个分隔符，那一段就作废。',
    ].join('\n');
    return { temperature: 0.6, max_tokens: UNIT_STAGE_MAX_TOKENS.analysis_part2, prompt, meta: { format: 'text' } };
  },

  /** 兼容旧客户端：仍然接受单个 analysis 阶段（= part1 + part2 一起生成） */
  analysis(selection) {
    const prompt = [
      '请为一个 18 课时的大单元教学设计生成【模块 1–5：单元名称 / 教学目标 / 教材分析 / 学情分析 / 主要教学内容 / 教学重难点】。',
      unitTopicSentence(selection),
      '',
      '⛔ 输出格式：【纯文本】。绝对不要输出 JSON、不要输出 Markdown 代码块、不要加任何解释或开场白。',
      '   必须严格按下面的分隔符顺序输出，每个分隔符独占一行、分隔符原样写出来：',
      '',
      UNIT_FORMAT_ANALYSIS,
      '',
      '⛔ 篇幅要求：本次回复 ≤ 1600 字；每段都要详实，但绝不是越长越好。',
      '必须把 6 个分隔符全部写出来 —— 少一个分隔符，那一段就作废。',
    ].join('\n');
    return { temperature: 0.6, max_tokens: UNIT_STAGE_MAX_TOKENS.analysis, prompt, meta: { format: 'text' } };
  },

  /** ② 模块 6：结构图（18 个节点 + 主要项目）—— 严格照 18 课次计划表输出 */
  structure(selection, input) {
    const plan = unitLessonPlanText(selection, 1, 18);
    const context = input.context || {};
    const brief = [
      context.unitTitle ? `单元名称：${context.unitTitle}` : '',
      context.objectives ? `单元目标：${String(context.objectives).replace(/\s+/g, ' ').slice(0, 260)}` : '',
      context.teachingContent ? `主要教学内容：${String(context.teachingContent).replace(/\s+/g, ' ').slice(0, 260)}` : '',
    ].filter(Boolean).join('\n');
    const extra = [
      plan,
      '⛔ 上面这份「18 课次计划表」已经把每个课次号对应的维度与具体项目排定，结构图节点必须严格照此输出：',
      '   · 每课次一个节点，id = 课次号，18 个课次一个都不能少；',
      '   · 节点标题直接用计划表里的具体项目名（去掉"第N课次："前缀），不要写成"田径练习""综合练习"；',
      '   · 维度按下面的归并规则从计划表的七大维度折算成四条泳道，不要自创维度名。',
    ].filter(Boolean).join('\n');
    const prompt = [
      '请为一个 18 课时的大单元教学设计生成【模块 6：大单元设计结构图】。',
      unitTopicSentence(selection, extra),
      '───── 已有信息（保持一致，只作参考，不要重复输出） ─────',
      brief || '（未提供上下文）',
      '──────────────────────────',
      '本次【只】输出模块 6，顶层键只能是 structure_nodes 与 main_projects。',
      '⛔ 绝对不要输出 unitTitle、objectives、lessons、rubric 等其它模块 —— 那些由其它请求负责。',
      '1. structure_nodes：必须恰好 18 项，id 从 1 到 18 各一次，不重复不遗漏。每个节点形如 {"id": 课次号, "dimension": "维度", "title": "课次核心内容"}。',
      '   · dimension 只能取这四个值之一：基础知识 / 基本技术 / 技战术运用 / 展示或比赛；',
      '   · 计划表里的七大维度按下面的规则归并到这四条泳道：基础知识→基础知识；基本技术→基本技术；战术→技战术运用；专项体能→基本技术；比赛与展示→展示或比赛；规则与裁判→技战术运用；观赏与评价→展示或比赛；',
      '   · title 只写这一课次的核心内容（如"运球与游戏"），直接用计划表里的项目名，不要写"第N课次："前缀。',
      '2. main_projects（主要项目）：从本单元教学内容清单里提炼 1–3 个项目名称（如"篮球运球""两人传接球"），字符串数组，用顿号分隔的短词，不要写成句子。',
      '',
      '⛔ 字数硬约束：本次回复 ≤ 800 字；每个节点的 title ≤ 12 字；main_projects ≤ 3 个、每个 ≤ 10 字。',
      '宁可精炼，也必须把 structure_nodes 的 18 个节点完整输出，并保持 JSON 合法 —— 被截断的输出无法使用。',
      '',
      `请严格按以下 JSON 结构输出（字段名与层级不得改动）：\n${UNIT_SCHEMA_STRUCTURE}`,
    ].join('\n');
    return { temperature: 0.5, max_tokens: UNIT_STAGE_MAX_TOKENS.structure, prompt, meta: { nodes: 18 } };
  },

  /**
   * ③ 课时表 —— 【纯文本 + 一行 Markdown 表格】（禁止 JSON）
   * 一次只写 1 个课时：输出量小到不可能被截断；
   * 就算被截断，Markdown 表格也只是少半行内容，不会整份作废。
   */
  lessons(selection, input) {
    // startLesson / endLesson 是新参数名；from / to 保留兼容（旧前端仍用这两个名字）
    const rawStart = input.startLesson ?? input.from;
    const rawEnd = input.endLesson ?? input.to;
    const from = Math.max(1, Number.parseInt(rawStart, 10) || 1);
    const to = Math.min(18, Math.max(from, Number.parseInt(rawEnd, 10) || from));
    const count = to - from + 1;
    const plan = unitLessonPlan(selection.topicList).filter(row => row.no >= from && row.no <= to);
    const dimensions = [...new Set(plan.map(row => row.dimension))];
    const brief = unitStripDimensionNoise(unitContextBrief(input.context, { limit: 600, dimensions }));
    const current = plan[0] || {};
    const prompt = [
      `本次【只】生成第 ${from} 课次这一个课时：一次只写一个，但必须写细、写足、写得像省级优质课的完整教案。`,
      `选题：教材大类：${selection.category}；教材细项：${selection.item}；教学水平：${selection.level}；教学内容：${selection.topic}。`,
      ...(selection.pending
        ? ['⚠️ 该教学内容属于"待确认"条目，请保留必要的替代方案与安全提醒，并提示教师结合本校实际核对。']
        : []),
      unitLessonPlanText(selection, from, to),
      '───── 已有信息（保持一致，只作参考，不要重复输出） ─────',
      brief || '（未提供上下文）',
      '──────────────────────────',
      '⛔ 请直接输出以下格式的纯文本，不要包含任何其他内容 —— 不要输出 JSON、不要解释、不要寒暄、不要思考过程、不要 Markdown 代码块围栏、不要"好的以下是"这类开场白：',
      '',
      UNIT_FORMAT_LESSONS,
      '',
      '写法要求：',
      `   · 表格只放【一行】数据，课次号必须写成「第${from}课次」；`,
      '   · ⛔ 表格以外的任何字符都不许有：不要任何自定义分隔标记，不要维度名称 / 字段名 / 英文键；',
      '   · 三格都要写满，不得留空、不得写占位词；',
      unitLessonDimensionHint(current),
      '',
      unitLessonDetailRules(count),
      '',
      '⚠️ 只输出上面这一小段表格就结束 —— 多写一个字都会被当成格式污染，前端会解析失败。',
    ].join('\n');
    return {
      temperature: 0.5,
      max_tokens: UNIT_STAGE_MAX_TOKENS.lessons,
      prompt,
      meta: { format: 'text', from, to, count, dimensions },
    };
  },
  /**
   * ③-b 单课时（lesson_single）——【纯文本一行】
   *
   * ⚠️ 这是"绝不可能截断"的那一档：
   *   · 一次只写 1 个课时（lessonNo 指定），输出量 < 500 字；
   *   · 格式是一行管道分隔的纯文本，不是 Markdown 表格，更不是 JSON；
   *   · 请求体【绝不带】response_format（带了就一定是被 json_object 拐去吐 JSON 数组）。
   * 参数：lessonNo（也兼容 startLesson / from）。
   */
  lesson_single(selection, input) {
    const rawNo = input.lessonNo ?? input.startLesson ?? input.from;
    const no = Math.max(1, Math.min(18, Number.parseInt(rawNo, 10) || 1));
    const plan = unitLessonPlan(selection.topicList).filter(row => row.no === no);
    const current = plan[0] || {};
    const brief = unitStripDimensionNoise(unitContextBrief(input.context, { limit: 500 }));
    const prompt = [
      `本次【只】生成第 ${no} 课次这一个课时。`,
      `选题：教材大类：${selection.category}；教材细项：${selection.item}；教学水平：${selection.level}；教学内容：${selection.topic}。`,
      ...(selection.pending
        ? ['⚠️ 该教学内容属于"待确认"条目，请保留必要的替代方案与安全提醒。']
        : []),
      unitLessonPlanText(selection, no, no),
      '───── 已有信息（保持一致，只作参考，不要重复输出） ─────',
      brief || '（未提供上下文）',
      '──────────────────────────',
      '⛔⛔⛔ 最高优先级硬约束（违反任何一条，这次请求就算失败）：',
      '⛔ 禁止输出 JSON！输出里绝对不允许出现大括号 { }、方括号 [ ]、双引号包裹的键名或任何 JSON 字段名！',
      '⛔ 禁止包含任何解释、寒暄、思考过程、前言后语！',
      '⛔ 禁止使用 Markdown 代码块标记（如 ```json 或 ```）！',
      '⛔ 禁止输出数组、禁止一次写多个课时！',
      '⛔ 禁止输出任何维度相关内容：不要写维度名称、不要写维度字段名、不要写维度英文键、不要写任何自定义分隔标记！',
      '⛔ 表格（这一行）以外的任何字符都不许有：不要标题、不要空行、不要分隔线、不要"以下是"这类开场白！',
      unitLessonDimensionHint(current),
      '✅ 直接输出一行一个课时的纯文本列表，长得必须和下面这行一模一样（内容换成当前课题次）：',
      '',
      UNIT_FORMAT_LESSON_SINGLE,
      '',
      '写法要求：',
      `   · 第一格必须是「第${no}课次」；`,
      '   · 三格依次是：学习目标 / 主要学习内容 / 教学策略，用竖线 " | " 分隔，竖线前后各留一个空格；',
      '   · 每格内部换行用 <br>，不要用真实换行；',
      '   · 三格都要写满，但每格 120–180 字即可 —— 写多了反而会被截断，写完立刻停；',
      '   · 写完这一行就结束，后面不许再有任何字符。',
      '',
      unitLessonSingleRules(),
    ].join('\n');
    return {
      temperature: 0.5,
      max_tokens: UNIT_STAGE_MAX_TOKENS.lesson_single,
      prompt,
      meta: { format: 'text', lessonNo: no, dimension: current.dimension || 'basic' },
    };
  },

  /** ④ 模块 8–9：考核与作业 / 教学反思 */
  closing(selection, input) {
    const brief = unitContextBrief(input.context, { limit: 1200 });
    const prompt = [
      '请为本单元补充【模块 8–9：考核与作业 / 教学反思】，顶层键只能有：assessment、reflection。',
      unitTopicSentence(selection, '考核内容与评价标准要对应清单中的具体项目（如"50 米快速跑的成绩标准"），不要写空泛的"综合评定"。'),
      '───── 已有信息（保持一致） ─────',
      brief || '（未提供上下文）',
      '──────────────────────────',
      '8. assessment（考核与作业）：依据课标学业质量要求设计考核内容与标准，并给出可执行的课内外作业。',
      '9. reflection（教学反思）：生成可供教师课后填写的反思框架模板（含待填维度与引导问题），不得以"本节课效果良好"这类已成事实的口吻撰写。',
      '⛔ 绝对不要输出 lessons、structure_nodes 或 rubric —— 那些由其它独立请求负责。',
      '',
      '⛔ 字数硬约束：assessment / reflection 各 ≤ 200 字。整个 JSON ≤ 900 字。',
      '宁可写短，也必须保证 JSON 完整合法 —— 被截断的输出无法使用。',
      '',
      `请严格按以下 JSON 结构输出（字段名与层级不得改动）：\n${UNIT_SCHEMA_CLOSING}`,
    ].join('\n');
    return { temperature: 0.5, max_tokens: UNIT_STAGE_MAX_TOKENS.closing, prompt };
  },

/** ⑤ 模块 10：单元学习评价表（四等级量规 + 核心素养占比 + 细分得分点）
   *  【纯文本 + Markdown 表格输出】—— 不再用 JSON：量规表被 JSON 包裹时，
   *  一旦被截断整张表直接作废；改成纯文本后最多缺一两行，前端还能用标准模板补齐。 */
  rubric(selection, input) {
    const brief = unitContextBrief(input.context, { limit: 900 });
    const prompt = [
      '请为本单元生成【模块 10：单元学习评价表】。',
      unitTopicSentence(selection, '评价要点要结合本单元的具体技术与比赛项目来写。'),
      '───── 已有信息（保持一致） ─────',
      brief || '（未提供上下文）',
      '──────────────────────────',
      '⛔ 输出格式：【纯文本 + Markdown 表格】。绝对不要输出 JSON、不要输出代码块、不要加任何解释或开场白。',
      '   必须严格按下面的分隔符与表格形式输出：',
      '   ⚠️ 下面是一份【格式与写法示例】（篮球），结构、分值、行列一个字都不能改；描述内容必须换成当前选题。',
      '',
      UNIT_FORMAT_RUBRIC,
      '',
      '写法要求：',
      '   · ===RUBRIC=== 正好 4 行等级，顺序与取值固定为 优秀 85-100 / 良好 75-84 / 合格 60-74 / 不合格 60以下；',
      '     三列分别是运动能力、健康行为、体育品德的表现描述，每格写成 60–100 字的可观察行为描述（能直接拿去对照打分）。',
      '   · ===WEIGHTS=== 正好 3 行 —— 运动能力 60% / 健康行为 20% / 体育品德 20%。',
      '   · ===SCORES=== 正好 10 个得分点，必须覆盖三大素养且分值合计 100 分：',
      '     运动能力 60 分 = 运动知识 12 + 运动技能 36 + 专项体能 6 + 学习参与 6；',
      '     健康行为 20 分 = 健康知识 6 + 运动习惯 8 + 心理健康 6；',
      '     体育品德 20 分 = 体育精神 8 + 道德品质 6 + 规则意识 6。',
      '     评价要点列写清"看什么、怎么判"，并结合本单元的具体技术与比赛。',
      '⛔ 绝对不要输出课时表、考核、反思或结构图 —— 那些由其它独立请求负责。',
      '',
      '⛔ 篇幅要求（分隔符纯文本，不怕截断 —— 把每个等级写透，别写成四句口号）：',
      '   · 等级描述每格 60–100 字，写清"达到什么表现、在什么情境下、达到什么程度"，要能被裁判直接拿去对照打分；',
      '   · 得分点的评价要点每项 50–80 字，写清"看什么动作/行为、达到什么标准、怎么记录"，并结合本单元的具体技术与比赛；',
      '   · 整个回复 1800–2500 字；结构（三张表的行数与列数、分值）一个字都不能改，只有描述可以写厚。',
      '必须把三个分隔符与三张表格全部写完 —— 少一个分隔符，那一段就作废。',
    ].join('\n');
    return { temperature: 0.5, max_tokens: UNIT_STAGE_MAX_TOKENS.rubric, prompt, meta: { format: 'text' } };
  },
};

/**
 * 走【纯文本】输出的阶段：内容长、JSON 包裹极易被截断。
 * 这两个阶段不发 response_format，模型直接按分隔符输出纯文本，前端用正则切分。
 */
const UNIT_TEXT_STAGES = new Set(['analysis', 'analysis_part1', 'analysis_part2', 'lessons', 'lesson_single', 'rubric']);

/**
 * stage 别名表：前端叫法与后端 builder 的对应关系。
 * 有了它，"lesson_single / lessons / lesson" 都能走通同一个 builder，
 * 前端改 stage 名不会立刻 400。
 */
const UNIT_STAGE_ALIASES = {
  lesson_single: 'lesson_single',
  lesson: 'lesson_single',
  lessons: 'lessons',
  analysis: 'analysis',
  analysis_part1: 'analysis_part1',
  analysis_part2: 'analysis_part2',
  analysis1: 'analysis_part1',
  analysis2: 'analysis_part2',
  structure: 'structure',
  closing: 'closing',
  rubric: 'rubric',
};

/** 后端版本戳：前端拿到它就知道后端是不是最新版（防止"改了代码没重新部署"） */
const UNIT_BACKEND_VERSION = '2026-11-06-split-v3';

function buildUnitRequest(input) {
  const selection = readUnitSelection(input);
  if (selection.error) return { error: selection.error };
  const rawStage = String(input.stage || 'analysis').trim();
  const stage = UNIT_STAGE_ALIASES[rawStage] || rawStage;
  const builder = Object.prototype.hasOwnProperty.call(UNIT_STAGE_BUILDERS, stage)
    ? UNIT_STAGE_BUILDERS[stage]
    : null;
  if (!builder) {
    return {
      error: {
        status: 400,
        message: `未知的生成阶段：${rawStage}（后端版本 ${UNIT_BACKEND_VERSION}）。`
          + '若前端用了新阶段名（analysis_part1 / analysis_part2 / lesson_single），'
          + '说明服务器上的后端代码还没更新 —— 请重新部署后再试。',
      },
    };
  }

  const built = builder(selection, input);
  const isText = UNIT_TEXT_STAGES.has(stage);
  return {
    stage,
    meta: { ...(built.meta || {}), format: isText ? 'text' : 'json', backendVersion: UNIT_BACKEND_VERSION },
    temperature: built.temperature,
    max_tokens: built.max_tokens,
    // ⚠️ 纯文本阶段【绝不发】response_format —— 一旦带上 json_object，
    //    模型就会去吐 JSON 数组，长文本被截断后整份作废（这正是老问题的根因）。
    ...(isText ? {} : { response_format: { type: 'json_object' } }),
    messages: [
      { role: 'system', content: isText ? UNIT_SYSTEM_PROMPT_TEXT : UNIT_SYSTEM_PROMPT },
      { role: 'user', content: built.prompt },
    ],
  };
}

const FITNESS_SYSTEM_PROMPT = [
  '你是一名拥有 NSCA-CPT 认证的专业私人健身教练，同时具备运动康复与体能训练背景。请根据用户提供的训练部位与可用器械，为其编排一份可直接执行的一日训练计划。',
  '只输出 Markdown 正文，不要输出 JSON，不要使用 Markdown 代码围栏，不要在正文之外添加任何解释或开场白。',
  '正文必须严格包含以下四个二级标题模块，顺序不可调整，缺少任何一项均视为不合格：',
  '## 一、热身：用表格或列表写明动作名称、目标肌群/关节与建议时间（总计约 8-10 分钟）。',
  '## 二、正式训练：用 Markdown 表格列出每个动作，表头必须为「动作名称 | 组数 | 次数/时长 | 组间休息」，并紧接列表补充该动作的要点（发力感、节奏或替代动作）。安排 4-6 个动作，符合所给器械条件。',
  '## 三、拉伸放松：列出针对本次训练部位的静态拉伸动作与保持时间（总计约 5-8 分钟）。',
  '## 四、动作注意事项：分条列出动作规范、呼吸节奏、常见错误、疼痛或不适的停止信号，以及循序渐进的负荷建议。',
  '器械约束：只能使用用户列出的器械。若用户无器械或仅选择「无器械」，全部动作必须替换为自重训练（如俯卧撑、深蹲、箭步蹲、平板支撑、引体向上替代动作等），不得出现哑铃、杠铃或器械区动作。',
  '安全约束：面向普通成年人，不推荐危险或超高难度动作；涉及腰椎、膝关节、肩关节的动作必须写明保护要点；提醒有心血管疾病、伤病或孕期人群先咨询医生。',
].join('\n');

function buildFitnessRequest(input) {
  const bodyPart = String(input.bodyPart || '').trim();
  if (!bodyPart || bodyPart.length > 60) {
    return { error: { status: 400, message: '请提供有效的训练部位（1-60 字）' } };
  }

  let equipment = [];
  if (Array.isArray(input.equipment)) {
    equipment = input.equipment
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 20);
  } else if (typeof input.equipment === 'string') {
    equipment = input.equipment.split(/[,，、;；]/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  if (!equipment.length) equipment = ['无器械'];

  const hasEquipment = !equipment.every(item => item === '无器械');
  const prompt = [
    `请为一名普通成年人编排一份今日训练计划。目标训练部位：${bodyPart}。可用器械：${equipment.join('、')}。`,
    hasEquipment
      ? '所有动作只能使用上述可用器械，不得出现清单之外的器械。'
      : '用户当前没有任何器械，全部动作必须采用自重训练方案，并说明徒手进阶与退阶方式。',
    '输出 Markdown 正文，严格包含「一、热身」「二、正式训练」「三、拉伸放松」「四、动作注意事项」四个模块，正式训练用表格给出动作名称、组数、次数/时长与组间休息。',
  ].join('\n');

  return {
    temperature: 0.7,
    max_tokens: FITNESS_AI_MAX_TOKENS,
    messages: [
      { role: 'system', content: FITNESS_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  };
}

const BUILDERS = {
  lesson: buildLessonRequest,
  unit: buildUnitRequest,
  fitness: buildFitnessRequest,
};

/* ---------- 流式转发 ---------- */

function streamAiResponse(res, options) {
  const {
    apiUrl, apiKey, requestBody, type,
    timeoutMs = AI_TIMEOUT_MS,
    maxResponseBytes = MAX_RESPONSE_BYTES[type] || 8 * 1024 * 1024,
    label = 'AI',
    detectTokenLimit = false,
  } = options;

  const requestUrl = new URL(apiUrl);
  const proxyReq = https.request(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(requestBody),
    },
    timeout: timeoutMs,
  }, proxyRes => {
    const upstreamFailed = proxyRes.statusCode < 200 || proxyRes.statusCode >= 300;
    let responseBytes = 0;
    let frameBuffer = '';
    let contentBuffer = '';
    let hitTokenLimit = false;

    if (!upstreamFailed) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
    }

    proxyRes.on('data', chunk => {
      responseBytes += chunk.length;
      if (responseBytes > maxResponseBytes) {
        if (!upstreamFailed && !res.writableEnded) {
          res.write(`event: truncated\ndata: ${JSON.stringify({ warning: 'AI 响应已达到安全传输上限，以下为已收到的部分内容。' })}\n\n`);
          res.end();
        }
        proxyReq.destroy();
        return;
      }
      if (upstreamFailed) return;

      if (detectTokenLimit) {
        frameBuffer += chunk.toString('utf8');
        let separatorIndex = frameBuffer.indexOf('\n\n');
        while (separatorIndex !== -1) {
          const frame = frameBuffer.slice(0, separatorIndex);
          frameBuffer = frameBuffer.slice(separatorIndex + 2);
          if (getStreamFinishReason(frame) === 'length') hitTokenLimit = true;
          contentBuffer += getStreamDeltaContent(frame);
          separatorIndex = frameBuffer.indexOf('\n\n');
        }
      }

      if (!res.write(chunk)) {
        proxyRes.pause();
        res.once('drain', () => proxyRes.resume());
      }
    });

    proxyRes.on('end', () => {
      if (upstreamFailed) {
        console.error(`${label} AI 上游请求失败：HTTP ${proxyRes.statusCode}`);
        sendJson(res, 502, { error: getAIUpstreamError(proxyRes.statusCode) });
        return;
      }
      if (detectTokenLimit && hitTokenLimit && !res.writableEnded) {
        // 服务端也跑一遍修复：把"抢救出多少课时"直接告诉前端，避免老师猜
        const salvaged = repairTruncatedJSON(contentBuffer);
        const salvagedLessons = Array.isArray(salvaged?.lessons) ? salvaged.lessons.length : 0;
        res.write(`event: truncated\ndata: ${JSON.stringify({
          warning: salvagedLessons
            ? `已达到模型单次输出上限：已抢救出 ${salvagedLessons} 个课时，还缺的课次请点【补全】单独生成。`
            : '已达到模型单次输出上限，内容可能未写完，可点击「继续生成」续写剩余部分。',
          salvagedLessons,
        })}\n\n`);
      }
      res.end();
    });

    proxyRes.on('aborted', () => {
      if (res.headersSent && !res.writableEnded) {
        res.write(`event: truncated\ndata: ${JSON.stringify({ warning: 'AI 连接中断，已收到的内容已保留，可能不完整。' })}\n\n`);
        res.end();
      }
    });
  });

  proxyReq.on('timeout', () => {
    const error = new Error(`AI 请求超过 ${Math.round(timeoutMs / 1000)} 秒`);
    error.code = 'ETIMEDOUT';
    proxyReq.destroy(error);
  });
  proxyReq.on('error', error => {
    console.error(`${label} AI 请求失败：${error.code || error.message}`);
    const message = getAIRequestError(error);
    if (!res.headersSent) {
      sendJson(res, 502, { error: message });
    } else if (!res.writableEnded && !res.destroyed) {
      res.write(`event: truncated\ndata: ${JSON.stringify({ warning: `AI 连接中断（${message}），已收到的内容已保留，可能不完整。` })}\n\n`);
      res.end();
    }
  });
  if (typeof res.on === 'function') {
    res.on('close', () => {
      if (!res.writableEnded) proxyReq.destroy();
    });
  }
  proxyReq.end(requestBody);
}

/* ---------- 统一入口 ---------- */

/**
 * 上游 AI 请求体：生产入口与「真实接口闭环测试」共用同一份构造逻辑，
 * 避免测试脚本自己拼一份参数、和线上跑的不是同一个请求。
 */
function buildUpstreamRequestBody(config, built) {
  return JSON.stringify({
    model: config.model,
    temperature: built.temperature,
    max_tokens: built.max_tokens,
    stream: true,
    messages: built.messages,
    ...(built.response_format ? { response_format: built.response_format } : {}),
    // 只给推理模型压低思考量；设 AI_REASONING_EFFORT=none 可完全不带这个字段
    ...(AI_REASONING_EFFORT && AI_REASONING_EFFORT !== 'none'
      ? { reasoning_effort: AI_REASONING_EFFORT } : {}),
  });
}

async function handleAiRequest(req, res, options = {}) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '仅支持 POST 请求' });
    return;
  }
  /* ⛔ 权限闸门（安全底线）：AI 生成属于写操作，游客一律拦截。
     AI 调用会消耗额度、会把生成结果写进云端，绝不能对游客开放。 */
  if (!requireAdmin(req, res)) return;
  if (!isLocalAIRequest(req)) {
    sendJson(res, 403, { error: 'AI 生成接口仅允许本机访问' });
    return;
  }

  const config = resolveAIConfig();
  if (!config.apiUrl || !config.apiKey || !config.model) {
    sendJson(res, 503, {
      error: 'AI 服务尚未配置。本地请在 .env.local 中设置智谱 API Key；Vercel 部署请在项目环境变量中设置 ZHIPU_API_KEY 与 ZHIPU_MODEL。',
    });
    return;
  }
  let requestUrl;
  try {
    requestUrl = new URL(config.apiUrl);
  } catch {
    sendJson(res, 500, { error: 'AI 接口地址配置不是有效 URL' });
    return;
  }
  if (requestUrl.protocol !== 'https:') {
    sendJson(res, 500, { error: 'AI 接口地址必须使用 HTTPS' });
    return;
  }

  let parsed;
  try {
    parsed = await readJsonBody(req, GENERIC_MAX_BODY_BYTES);
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 400, { error: error.message });
    return;
  }

  const rawType = options.type || parsed.input?.type || '';
  const type = TYPE_ALIASES[String(rawType).trim().toLowerCase()];
  if (!type) {
    sendJson(res, 400, { error: '请提供有效的请求类型（lesson / unit / fitness）' });
    return;
  }
  if (parsed.bytes > MAX_BODY_BYTES[type]) {
    sendJson(res, 413, { error: '请求内容过大' });
    return;
  }

  const built = BUILDERS[type](parsed.input);
  if (built.error) {
    sendJson(res, built.error.status, { error: built.error.message });
    return;
  }

  /* 后端版本戳回传：前端据此发现「前端已更新、后端还没重新部署」。
     少了这一条，旧后端会让 analysis_part1 / lesson_single 直接 400，
     而用户看到的只是一句"未知的生成阶段"，根本不知道是部署问题。 */
  if (type === 'unit' && typeof res.setHeader === 'function') {
    try { res.setHeader('X-Unit-Backend-Version', UNIT_BACKEND_VERSION); } catch { /* 某些运行时不支持自定义头 */ }
  }

  const requestBody = buildUpstreamRequestBody(config, built);

  streamAiResponse(res, {
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    requestBody,
    type,
    // 入口（server.js / api/ai.js）显式传 120000；没传时回落到同一默认值，绝不提前掐断流
    timeoutMs: options.timeoutMs || AI_TIMEOUT_MS,
    label: { lesson: '教案', unit: '大单元', fitness: '健身计划' }[type],
    // 大单元一次性生成的内容量极大，同样要检测"被模型单次输出上限截断"，好让前端提示续写/重试
    detectTokenLimit: type === 'lesson' || type === 'unit',
  });
}

module.exports = {
  handleAiRequest,
  loadLocalEnvironment,
  resolveAIConfig,
  isLocalAIRequest,
  // 导出请求构建器与预算常量供回归测试使用（不影响线上行为）
  buildUnitRequest, buildUpstreamRequestBody,
  unitContextBrief,
  unitDimensionStats,
  unitDimensionQuota,
  unitLessonPlan,
  unitLessonPlanText,
  UNIT_DIMENSION_BRANCH,
  UNIT_AI_MAX_TOKENS,
  UNIT_STAGE_MAX_TOKENS,
  UNIT_LESSON_CHUNK,
  UNIT_LESSON_BATCHES,
  // Few-shot 范文（供回归测试验证"范文本身能被前端解析器正确切开"）
  UNIT_FORMAT_ANALYSIS,
  UNIT_FORMAT_ANALYSIS_PART1,
  UNIT_FORMAT_ANALYSIS_PART2,
  UNIT_FORMAT_LESSONS,
  UNIT_FORMAT_LESSON_SINGLE,
  UNIT_FORMAT_RUBRIC,
  UNIT_BACKEND_VERSION,
};
