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
const UNIT_AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 8192;
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

const UNIT_SECTIONS = {
  analysis: {
    fields: 'theme,textbookAnalysis,studentAnalysis,keyPoints,difficulties,objectives{ability,health,character}',
    instruction: '补全前置分析与三维学习目标，具体、可观察，适合小学体育大单元。',
  },
  questions: {
    fields: 'coreQuestion,lessons[18]{question}',
    instruction: '先给出单元核心问题，再按循序渐进、前后衔接的方式设计18课时主要问题。',
  },
  lessons: {
    fields: 'lessons[18]{objective,content,method,application,evaluation}',
    instruction: '基于已有单元信息设计18课次计划，课次之间目标递进、内容连贯，活动符合小学体育安全要求。',
  },
  assessment: {
    fields: 'assessment,homework,evaluationSummary,reflection',
    instruction: '补全单元总评方式、可执行的课内外作业、评价数据汇总方案及可供教师修改的反思提示。',
  },
};

const UNIT_SYSTEM_PROMPT = '你是小学体育大单元设计助手。请使用结构化、精炼的学术语言输出，直奔主题，不要输出任何多余的寒暄、解释或总结性废话。只输出符合要求的 JSON，不要输出任何额外解释文字或 Markdown 代码块标记。需要课次内容时，必须将18个课次作为 JSON 数组返回；不得省略、合并或调换课次。确保内容适合小学体育教学且安全可执行。';

function buildUnitRequest(input) {
  const section = String(input.section || '').trim();
  const config = Object.prototype.hasOwnProperty.call(UNIT_SECTIONS, section) ? UNIT_SECTIONS[section] : null;
  if (!config || !input.unit || typeof input.unit !== 'object' || Array.isArray(input.unit)) {
    return { error: { status: 400, message: '请提供有效的大单元板块与数据对象' } };
  }

  const prompt = [
    '你是小学体育大单元教学设计助手。结合已有内容，生成可直接编辑的简体中文教学设计草稿。',
    '以学生安全、循序渐进、运动能力/健康行为/体育品德融合、可观察评价为原则；不得编造已发生的评价数据。',
    '请使用结构化、精炼的学术语言输出，直奔主题，不要输出任何多余的寒暄、解释或总结性废话。',
    '不要覆盖已有信息，重点补全所选板块。只输出合法 JSON，不要包含任何额外的解释文字或 Markdown 代码块标记。',
    `当前板块：${section}。必须返回字段结构：${config.fields}。`,
    'questions 和 lessons 板块中的 lessons 必须是恰好包含18项的 JSON 数组，并按课时顺序对应；questions 中每项必须包含 question 字符串，lessons 中每项必须包含所要求的课时字段。不需要生成的字段可返回空字符串。',
    config.instruction,
    `现有大单元数据：${JSON.stringify(input.unit)}`,
  ].join('\n');

  return {
    temperature: 0.5,
    max_tokens: UNIT_AI_MAX_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: UNIT_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
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
    detectTokenLimit: type === 'lesson',
  });
}

module.exports = {
  handleAiRequest,
  loadLocalEnvironment,
  resolveAIConfig,
  isLocalAIRequest,
};
