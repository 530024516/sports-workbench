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

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ZHIPUAI_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_MODEL = 'glm-5.3-flashx';

const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 120000;
const LESSON_AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 32768;
/**
 * 大单元生成改为「分步拼接」：
 *   让模型在一次回复里吐出 11 个模块 + 18 课时，实测必然被模型的输出上限截断
 *   （3661 字就断了，说明该模型的单次输出上限约在 2k–4k 中文字左右）。
 *   所以拆成两次请求，必要时还有更细的兜底环节：
 *
 *   ① analysis  模块 1–6（教学目标 / 教材分析 / 学情分析 / 主要教学内容 / 重难点 / 结构图）
 *   ② tail      模块 7–11（18 课时计划表 / 考核与作业 / 学习评价 / 教学反思 / 教学资源）
 *                —— 带上阶段①的精简结果当上下文，并对 18 课时下死字数字数约束
 *   ③ lessons   仅课时表，支持 from/to 分批（② 仍被截断时点【单独生成课时表】走这条路）
 *   ④ closing   仅模块 8–11 四个小字段（几乎不会截断）
 *
 * ⚠️ 每个阶段的预算都刻意压得很小：max_tokens 只是上限，真正决定成败的是模型自身的输出上限，
 *    所以 prompt 里还写了硬性的字数约束（并把「宁可写短也必须输出完整」作为第一优先级）。
 */
const UNIT_STAGE_MAX_TOKENS = {
  analysis: Number(process.env.UNIT_ANALYSIS_MAX_TOKENS) || 4096,
  tail: Number(process.env.UNIT_TAIL_MAX_TOKENS) || 8192,
  lessons: Number(process.env.UNIT_LESSONS_MAX_TOKENS) || 6144,
  closing: Number(process.env.UNIT_CLOSING_MAX_TOKENS) || 4096,
};
/** 兜底分批：单独生成课时表时每批几个课时（批越小越不容易被截断） */
const UNIT_LESSON_CHUNK = Number(process.env.UNIT_LESSON_CHUNK) || 6;
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
 * 大单元「一键生成」请求 —— 一次性产出全部 11 个模块（含 18 课时计划表）。
 * 数据量很大，所以这里刻意用较大的 max_tokens 并配合流式输出（handleAiRequest 恒定 stream: true），
 * 同时在 streamAiResponse 里开了 finish_reason=length 的截断检测，截断会给前端发 truncated 事件。
 */
/* 阶段①：模块 1–6 */
const UNIT_SCHEMA_ANALYSIS = `{
  "unitTitle": "单元名称（20 字以内）",
  "objectives": { "ability": "运动能力目标", "health": "健康行为目标", "character": "体育品德目标" },
  "textbookAnalysis": "教材分析",
  "studentAnalysis": "学情分析",
  "teachingContent": "主要教学内容",
  "keyDifficulties": { "learning": "学生学习的重难点", "content": "学习内容的重难点", "organization": "教学组织的重难点", "method": "教学方法的重难点" },
  "structure": {
    "basic":      [ { "no": 1, "title": "第1课次：认识篮球（球性练习）" } ],
    "technique":  [ { "no": 2, "title": "第2课次：……" } ],
    "tactics":    [ { "no": 11, "title": "第11课次：……" } ],
    "fitness":    [ { "no": 16, "title": "第16课次：……" } ]
  }
}`;

/* 阶段②：模块 7–11（18 课时是被截断的主因，所以字段示例本身就是"精简版"） */
const UNIT_SCHEMA_TAIL = `{
  "lessons": [
    { "no": 1, "objectives": { "ability": "≤20字", "health": "≤20字", "character": "≤20字" },
      "content": "≤35字的核心教学内容", "method": "≤35字的核心组织步骤" }
    /* ……必须恰好 18 项，no 从 1 递增到 18…… */
  ],
  "assessment": "考核与作业（≤200字）",
  "evaluation": { "process": "过程性评价（≤120字）", "summative": "终结性评价（≤120字）", "integration": "学练赛评一体化（≤120字）" },
  "reflection": "教学反思框架模板（≤200字）",
  "resources": "教学资源（≤200字）"
}`;

/* 阶段③：只出一小段课时表 */
const UNIT_SCHEMA_LESSONS = `{
  "lessons": [
    { "no": 1, "objectives": { "ability": "≤20字", "health": "≤20字", "character": "≤20字" },
      "content": "≤35字的核心教学内容", "method": "≤35字的核心组织步骤" }
  ]
}`;

/* 阶段④：模块 8–11 */
const UNIT_SCHEMA_CLOSING = `{
  "assessment": "考核与作业（≤200字）",
  "evaluation": { "process": "过程性评价", "summative": "终结性评价", "integration": "学练赛评一体化" },
  "reflection": "教学反思框架模板",
  "resources": "教学资源"
}`;

/** 18 课时表的字数硬约束：阶段②与阶段③共用，是整套方案能否跑通的关键 */
const UNIT_LESSON_BREVITY_RULES = [
  '⛔ 字数硬约束（这是本次能否完整输出的关键，优先级高于文采）：',
  '   · lessons 必须恰好 18 项（按 no 从 1 递增到 18），一项都不能少；',
  '   · 每个课时 objectives 的三个字段各 ≤ 20 字，用一句话说清"学生能做什么"；',
  '   · content ≤ 35 字：只写本课时核心内容与练习形式；',
  '   · method ≤ 35 字：只写核心组织步骤，例如"四组轮换×3→纠错→组内赛→小结"；',
  '   · 每课时内不得换行、不得写序号以外的套话，单个课时的总字数控制在 110 字以内；',
  '宁可写短，也必须保证 18 个课时全部输出完整 —— 被截断的输出等于全部作废。',
].join('\n');

const UNIT_SYSTEM_PROMPT = [
  '你是深耕《义务教育体育与健康课程标准（2022年版）》的省级体育教研员，擅长大单元教学设计。',
  '严格依据课标：核心素养 = 运动能力 + 健康行为 + 体育品德；坚持"教会、勤练、常赛"，落实"学、练、赛、评"一体化。',
  '输出必须是、且仅是一个合法 JSON 对象（不要 Markdown 代码块、不要任何解释性文字）。',
  '语言：规范的简体中文书面语，具体、可观察、可直接用于教研交檔；不要空话套话，不要编造已发生的评价数据。',
  '安全红线：活动内容必须符合学生年龄特点与学校场地器材实际，写明分组、轮换、保护帮助与安全提示；不得设计危险动作。',
].join('\n');

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
  return { category, item, level, topic, pending: input.topicPending === true };
}

function unitTopicSentence(selection) {
  const lines = [`选题：教材大类：${selection.category}；教材细项：${selection.item}；教学水平：${selection.level}；教学内容：${selection.topic}。本单元按 18 课时设计。`];
  if (selection.pending) {
    lines.push('⚠️ 该教学内容属于"待确认"条目（可能因地域、场馆或课时条件存在差异），请在设计中保留必要的替代方案与安全提醒，并提示教师结合本校实际核对。');
  }
  return lines.join('\n');
}

/**
 * 把前端传来的「上一阶段结果」压成一小段上下文。
 * 必须压缩：上下文越长，留给输出的预算越少；但是我们又需要让后半部分与前半部分连贯。
 */
function unitContextBrief(context, limit = 1200) {
  if (!context || typeof context !== 'object') return '';
  const clip = (value, max) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const lines = [];
  if (context.unitTitle) lines.push(`单元名称：${clip(context.unitTitle, 40)}`);
  const objectives = context.objectives || {};
  const objectiveParts = [['运动能力', objectives.ability], ['健康行为', objectives.health], ['体育品德', objectives.character]]
    .filter(([, value]) => value);
  if (objectiveParts.length) lines.push(`单元目标：${objectiveParts.map(([label, value]) => `${label}｜${clip(value, 90)}`).join('；')}`);
  if (context.teachingContent) lines.push(`主要教学内容：${clip(context.teachingContent, 240)}`);
  const difficulties = context.keyDifficulties || {};
  const difficultyParts = [['学生学习', difficulties.learning], ['学习内容', difficulties.content],
    ['教学组织', difficulties.organization], ['教学方法', difficulties.method]].filter(([, value]) => value);
  if (difficultyParts.length) lines.push(`重难点：${difficultyParts.map(([label, value]) => `${label}｜${clip(value, 60)}`).join('；')}`);
  if (Array.isArray(context.lessonTitles) && context.lessonTitles.length) {
    lines.push(`18 课次框架（课次号：名称）：${context.lessonTitles
      .map(node => `${node.no}：${clip(node.title, 24)}`).join('；')}`);
  }
  return clip(lines.join('\n'), limit);
}

const UNIT_STAGE_BUILDERS = {
  /** ① 模块 1–6：前置分析 + 重难点 + 结构图 */
  analysis(selection) {
    const prompt = [
      '请为一个 18 课时的大单元教学设计生成【前半部分：模块 1–6】。',
      unitTopicSentence(selection),
      '本次只输出下面 6 个模块（外加 unitTitle），【禁止】输出模块 7–11 的任何内容 —— 课时表与评价会在下一步单独生成：',
      '',
      '1. unitTitle（单元名称）：20 字以内。',
      '2. objectives（教学目标）：必须分三个维度书写 —— ability（运动能力）、health（健康行为）、character（体育品德），每维度不少于两条，使用"学生能够……"的可观察表述。',
      '3. textbookAnalysis（教材分析）：说明本单元主要内容、承载了核心素养的哪些方面、锻炼价值与育人价值。',
      '4. studentAnalysis（学情分析）：结合所选水平学生的认知特点、身体发育特点、已有经验与个体差异来写。',
      '5. teachingContent（主要教学内容）：结构化列出本单元覆盖的知识、技术、战术、体能与比赛活动，用编号分行排版。',
      '6. keyDifficulties（教学重难点）：必须拆成四个子维度 —— learning（学生学习的重难点）、content（学习内容的重难点）、organization（教学组织的重难点）、method（教学方法的重难点）。',
      '7. structure（大单元设计结构图）：以 basic（基础知识）、technique（基本技术）、tactics（技战术运用）、fitness（专项体能）四个主干分支组织，把 18 个课时【分别挂载】到对应分支下。每个节点形如 {"no": 课次号, "title": "第N课次：具体名称"}。四个分支的 no 合并后必须恰好是 1–18 各一次，不得重复或遗漏。',
      '',
      '⛔ 字数硬约束：本次回复请控制在 2200 字以内；每个标量字段 120–220 字；structure 每个节点标题 ≤ 16 字。',
      '宁可精炼，也必须把 structure 的 18 个节点完整输出，并保持 JSON 合法 —— 被截断的输出无法使用。',
      '',
      `请严格按以下 JSON 结构输出（字段名与层级不得改动）：\n${UNIT_SCHEMA_ANALYSIS}`,
    ].join('\n');
    return { temperature: 0.6, max_tokens: UNIT_STAGE_MAX_TOKENS.analysis, prompt };
  },

  /** ② 模块 7–11：带阶段① 上下文，且 18 课时必须极度精简 */
  tail(selection, input) {
    const brief = unitContextBrief(input.context);
    const prompt = [
      '这是第二阶段。第一阶段已经完成了【模块 1–6（教学目标、教材分析、学情分析、主要教学内容、教学重难点、大单元结构图）】，结果如下：',
      '───── 第一阶段结果（仅供参考，保持一致，不要重复输出这些字段） ─────',
      brief || '（未提供上下文）',
      '─────────────────────────────────────────────────────',
      unitTopicSentence(selection),
      '',
      '现在请【只】补充后半部分【模块 7–11】，输出的顶层键只能有：lessons、assessment、evaluation、reflection、resources。',
      '7. lessons（18 课时计划表）：必须恰好 18 项，按 no 从 1 到 18 顺序排列，课次框架见上面第一阶段的结构图。',
      '8. assessment（考核与作业）：依据课标学业质量要求设计考核内容与标准，并给出可执行的课内外作业。',
      '9. evaluation（学习评价）：process（过程性评价）、summative（终结性评价）、integration（"学、练、赛、评"一体化安排），须给出可操作的评价工具或观察点。',
      '10. reflection（教学反思）：生成可供教师课后填写的反思框架模板（含待填维度与引导问题），不得以"本节课效果良好"这类已成事实的口吻撰写。',
      '11. resources（教学资源）：推荐图文资料、视频资源与器材清单（含数量建议与安全检查要点）。',
      '',
      UNIT_LESSON_BREVITY_RULES,
      '另外：assessment / reflection / resources 各 ≤ 200 字；evaluation 三个字段各 ≤ 120 字。整个 JSON 请控制在 3500 字以内。',
      '',
      `请严格按以下 JSON 结构输出（字段名与层级不得改动）：\n${UNIT_SCHEMA_TAIL}`,
    ].join('\n');
    return { temperature: 0.5, max_tokens: UNIT_STAGE_MAX_TOKENS.tail, prompt };
  },

  /** ③ 只出一小段课时表（from/to），用于阶段② 被截断后的兜底补齐 */
  lessons(selection, input) {
    const from = Math.max(1, Number.parseInt(input.from, 10) || 1);
    const to = Math.max(from, Number.parseInt(input.to, 10) || 18);
    const count = to - from + 1;
    const brief = unitContextBrief(input.context);
    const prompt = [
      `请只生成本单元的【第 ${from}–${to} 课次】（共 ${count} 个课时），其它课次不要输出。`,
      unitTopicSentence(selection),
      '───── 已有信息（保持一致） ─────',
      brief || '（未提供上下文）',
      '──────────────────────────',
      `返回结构里 lessons 数组必须【恰好 ${count} 项】，no 从 ${from} 连续递增到 ${to}，顺序不得打乱。`,
      '课次之间要目标递进、内容连贯，并体现"学练赛"。',
      '',
      UNIT_LESSON_BREVITY_RULES,
      `输出的总字数请控制在 ${count * 110} 字以内。`,
      '',
      `请严格按以下 JSON 结构输出：\n${UNIT_SCHEMA_LESSONS}`,
    ].join('\n');
    return { temperature: 0.5, max_tokens: UNIT_STAGE_MAX_TOKENS.lessons, prompt, meta: { from, to, count } };
  },

  /** ④ 模块 8–11：小请求，给阶段② 的收尾做兜底 */
  closing(selection, input) {
    const brief = unitContextBrief(input.context);
    const prompt = [
      '请为本单元补充【模块 8–11 的收尾四项】，顶层键只能有：assessment、evaluation、reflection、resources。',
      unitTopicSentence(selection),
      '───── 已有信息（保持一致） ─────',
      brief || '（未提供上下文）',
      '──────────────────────────',
      '8. assessment（考核与作业）：依据课标学业质量要求设计考核内容与标准，并给出可执行的课内外作业。',
      '9. evaluation（学习评价）：process（过程性评价）、summative（终结性评价）、integration（"学、练、赛、评"一体化安排）。',
      '10. reflection（教学反思）：生成课后填写的反思框架模板（不得以已成事实的口吻撰写）。',
      '11. resources（教学资源）：图文资料、视频资源与器材清单（含数量建议与安全检查要点）。',
      '',
      '⛔ 字数硬约束：assessment / reflection / resources 各 ≤ 200 字；evaluation 三个字段各 ≤ 120 字。整个 JSON ≤ 800 字。',
      '',
      `请严格按以下 JSON 结构输出：\n${UNIT_SCHEMA_CLOSING}`,
    ].join('\n');
    return { temperature: 0.6, max_tokens: UNIT_STAGE_MAX_TOKENS.closing, prompt };
  },
};

function buildUnitRequest(input) {
  const selection = readUnitSelection(input);
  if (selection.error) return { error: selection.error };
  const stage = String(input.stage || 'analysis').trim();
  const builder = Object.prototype.hasOwnProperty.call(UNIT_STAGE_BUILDERS, stage)
    ? UNIT_STAGE_BUILDERS[stage]
    : null;
  if (!builder) return { error: { status: 400, message: `未知的生成阶段：${stage}` } };

  const built = builder(selection, input);
  return {
    stage,
    meta: built.meta || {},
    temperature: built.temperature,
    max_tokens: built.max_tokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: UNIT_SYSTEM_PROMPT },
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
        res.write(`event: truncated\ndata: ${JSON.stringify({ warning: '已达到模型单次输出上限，内容可能未写完，可点击「继续生成」续写剩余部分。' })}\n\n`);
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

async function handleAiRequest(req, res, options = {}) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '仅支持 POST 请求' });
    return;
  }
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

  const requestBody = JSON.stringify({
    model: config.model,
    temperature: built.temperature,
    max_tokens: built.max_tokens,
    stream: true,
    messages: built.messages,
    ...(built.response_format ? { response_format: built.response_format } : {}),
  });

  streamAiResponse(res, {
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    requestBody,
    type,
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
  buildUnitRequest,
  UNIT_AI_MAX_TOKENS,
  UNIT_STAGE_MAX_TOKENS,
  UNIT_LESSON_CHUNK,
};
