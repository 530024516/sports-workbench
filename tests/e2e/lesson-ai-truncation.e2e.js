/**
 * 真实 Puppeteer E2E：跑通一次【真实的 AI 教案生成】，断言不截断、不断段、能填进表单
 *
 *   node tests/e2e/lesson-ai-truncation.e2e.js
 *
 * 全程真实：真实 server.js 进程、真实 Chrome、真实 DOM、真实点击、真实 SSE 流、
 * 真实智谱 GLM 上游调用。没有任何假 DOM / 假 fetch / 假 AI。
 *
 * 操作路径：
 *   ① 以【真实 .env.local】启动 server.js（真实智谱 Key + 真实管理员密码）
 *   ② 打开 lessons.html → 注入管理员登录态
 *   ③ 真实点击【✨ AI 生成教案】→ 填课题/年级/人数 → 真实点击【生成教案草稿】
 *   ④ 等待真实 SSE 流结束
 *   ⑤ 断言：9 个 === 分段全部有内容 / 没有 JSON 残留 / 提示"未被截断"
 *   ⑥ 真实点击【📋 填入教案表单】→ 断言表单各输入框都已被填上
 *
 * 产物：
 *   tests/e2e/lesson-ai-draft-pass.png（草稿弹窗截图）
 *   tests/e2e/lesson-ai-form-pass.png（填入表单后截图）
 *   tests/e2e/lesson-ai-raw-output.txt（AI 原始输出全文）
 *   tests/e2e/lesson-ai-run.log（完整终端日志）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const OUT = __dirname;
const SHOT_DRAFT = path.join(OUT, 'lesson-ai-draft-pass.png');
const SHOT_FORM = path.join(OUT, 'lesson-ai-form-pass.png');
const RAW_OUT = path.join(OUT, 'lesson-ai-raw-output.txt');
const LOG = path.join(OUT, 'lesson-ai-run.log');
const PORT = Number(process.env.E2E_PORT) || 5211;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENV_LOCAL = path.join(ROOT, '.env.local');
const ENV_BACKUP = `${ENV_LOCAL}.e2e-backup`;

/** 后端 lib/ai-core.js 的分段 key 清单（必须与 LESSON_SECTIONS 一一对应） */
const SECTIONS = [
  'CONTENT', 'TARGET', 'KEYPOINT', 'EQUIPMENT',
  'PREPARATION', 'BASIC_PART', 'END_PART', 'DENSITY', 'REFLECTION',
];
const SECTION_TITLES = {
  CONTENT: '教学内容', TARGET: '教学目标', KEYPOINT: '教学重难点', EQUIPMENT: '场地与器材',
  PREPARATION: '准备部分', BASIC_PART: '基本部分', END_PART: '结束部分',
  DENSITY: '预计练习密度与心率', REFLECTION: '课后反思',
};
const TOPIC = '篮球原地运球';
const GRADE = '三年级';
const STUDENT_COUNT = '32';

const lines = [];
function log(message) {
  const line = `[E2E ${new Date().toISOString().slice(11, 23)}] ${message}`;
  lines.push(line);
  console.log(line);
}
function check(label, ok, detail = '') {
  log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`断言失败：${label}${detail ? ` — ${detail}` : ''}`);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}
async function waitServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await get(`${BASE}/lessons.html`);
      if (status === 200) return;
    } catch (error) { /* 还没起来，继续轮询 */ }
    await sleep(250);
  }
  throw new Error(`server.js 在 ${timeoutMs}ms 内没有就绪（${BASE}）`);
}
/** 从 .env.local 里读一个键（E2E 需要真实管理员密码 + 真实智谱 Key） */
function readEnvValue(key) {
  if (!fs.existsSync(ENV_LOCAL)) return '';
  const content = fs.readFileSync(ENV_LOCAL, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && match[1] === key) return match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}

/**
 * 把 .env.local 临时换成「不含 Supabase」的版本：
 * 智谱 Key 与管理员密码保留（本次要打真实 AI 接口），
 * 只摘掉 Supabase 三行 —— 让数据层走本地模式，既不污染老师云端，也不用等 8 秒读超时。
 * 无论成功失败，finally / process exit 都会原样恢复。
 */
function swapEnvWithoutSupabase() {
  if (!fs.existsSync(ENV_LOCAL)) return false;
  const original = fs.readFileSync(ENV_LOCAL, 'utf8');
  const stripped = original
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:export\s+)?SUPABASE_(?:URL|ANON_KEY|SERVICE_ROLE_KEY)\s*=/.test(line))
    .join('\n');
  if (stripped === original) return false;
  if (fs.existsSync(ENV_BACKUP)) fs.unlinkSync(ENV_BACKUP);
  fs.copyFileSync(ENV_LOCAL, ENV_BACKUP);
  fs.writeFileSync(ENV_LOCAL, stripped, 'utf8');
  return true;
}
function restoreEnv() {
  if (!fs.existsSync(ENV_BACKUP)) return;
  try {
    fs.copyFileSync(ENV_BACKUP, ENV_LOCAL);
    fs.unlinkSync(ENV_BACKUP);
    log('.env.local 已原样恢复（含 Supabase 配置）');
  } catch (error) {
    log(`⚠️ .env.local 恢复失败，请手动从 ${ENV_BACKUP} 还原：${error.message}`);
  }
}

/** 真实点击：先滚动到视口中央，再诊断有没有被遮挡，最后真的按下鼠标 */
async function clickReal(page, selector, label = selector) {
  await page.waitForSelector(selector, { timeout: 15000, visible: true });
  await page.evaluate(sel => {
    document.querySelector(sel)?.scrollIntoView({ block: 'center', inline: 'center' });
  }, selector);
  await sleep(250);
  const diag = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      topTag: at ? at.tagName : 'none',
      topId: at ? at.id : '',
      covered: at !== el && !el.contains(at),
    };
  }, selector);
  log(`点击前诊断「${label}」：${JSON.stringify(diag)}`);
  if (diag.covered) throw new Error(`「${label}」被 ${diag.topTag}#${diag.topId} 挡住了，无法真实点击`);
  await page.click(selector);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let server = null;
  let browser = null;
  const browserConsole = [];
  const aiRequests = [];

  try {
    /* ---------- ① 以【真实 .env.local】启动 server.js ----------
       本测试要打真实的智谱接口，所以 .env.local 必须保留；
       但把 Supabase 变量置空（loadLocalEnvironment 只在变量 undefined 时才覆盖，
       置空即可让数据层走本地模式），避免测试污染老师云端的数据。 */
    const adminPassword = readEnvValue('ADMIN_PASSWORD');
    const apiKey = readEnvValue('VITE_ZHIPUAI_API_KEY');
    const model = readEnvValue('VITE_ZHIPUAI_MODEL');
    check('.env.local 里配置了真实管理员密码', Boolean(adminPassword));
    check('.env.local 里配置了真实智谱 API Key', Boolean(apiKey) && apiKey.length > 20,
      `key 长度 ${apiKey.length}`);
    log(`真实模型：${model || '(未指定，走默认)'}`);

    const swapped = swapEnvWithoutSupabase();
    log(swapped
      ? '已临时把 .env.local 里的 Supabase 配置摘掉（保留智谱 Key 与管理员密码）：数据层走本地模式，不污染云端'
      : '.env.local 无需改动');
    process.on('exit', restoreEnv);

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => log(`[server] ${String(chunk).trim()}`));
    server.stderr.on('data', chunk => log(`[server:err] ${String(chunk).trim()}`));
    await waitServer();
    log(`server.js 已启动：${BASE}（PID ${server.pid}，真实智谱 Key 已加载）`);

    if (!fs.existsSync(CHROME)) throw new Error(`找不到真实 Chrome：${CHROME}`);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROME,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    log(`真实 Chrome 已启动：${await browser.version()}`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1100 });
    page.on('console', msg => {
      const text = `[browser:${msg.type()}] ${msg.text()}`;
      browserConsole.push(text);
      if (/\[AI 教案\]|生成中断|截断|续写/.test(msg.text())) log(text);
    });
    page.on('pageerror', error => {
      browserConsole.push(`[pageerror] ${error.message}`);
      log(`[pageerror] ${error.message}`);
    });
    page.on('request', req => {
      if (req.url().includes('/api/ai')) aiRequests.push({ method: req.method(), url: req.url() });
    });

    /* ---------- ② 打开真实页面并注入管理员登录态 ---------- */
    await page.goto(`${BASE}/lessons.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof window.Auth !== 'undefined' && typeof window.parseLessonSections === 'function'
        && document.querySelector('button[onclick="openAIGeneration()"]'),
      { timeout: 25000 },
    );
    await page.evaluate(pwd => {
      localStorage.setItem('isAdmin', 'true');
      localStorage.setItem('pe_admin_password', pwd);
    }, adminPassword);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof window.Auth !== 'undefined' && window.Auth.isAdmin()
        && document.querySelector('button[onclick="openAIGeneration()"]'),
      { timeout: 25000 },
    );
    /* ⛔ 必须等 Store 的冷启动遮罩撤掉，否则按钮被盖住、点不动 */
    await page.waitForFunction(() => !document.getElementById('store-loading'),
      { timeout: 60000 });
    log('已注入真实管理员登录态（isAdmin=true + 真实密码）；Store 冷启动遮罩已撤掉');

    /* ---------- ③ 真实点击【✨ AI 生成教案】并填表 ---------- */
    await clickReal(page, 'button[onclick="openAIGeneration()"]', '✨ AI 生成教案');
    await page.waitForSelector('#aiLessonForm', { timeout: 10000 });
    await sleep(400);   // 等弹窗 .show 动画结束，确保按钮真的可点
    await page.select('#aiLessonForm select[name="grade"]', GRADE);
    await page.$eval('#aiLessonForm input[name="studentCount"]', el => { el.value = ''; });
    await clickReal(page, '#aiLessonForm input[name="studentCount"]', '班级人数输入框');
    await page.keyboard.type(STUDENT_COUNT);
    await clickReal(page, '#aiLessonForm input[name="topic"]', '课题输入框');
    await page.keyboard.type(TOPIC);
    const formState = await page.evaluate(() => ({
      grade: document.querySelector('#aiLessonForm select[name="grade"]')?.value,
      count: document.querySelector('#aiLessonForm input[name="studentCount"]')?.value,
      topic: document.querySelector('#aiLessonForm input[name="topic"]')?.value,
      btnVisible: Boolean(document.querySelector('#generateLessonButton')?.offsetParent),
    }));
    check('AI 生成表单已真实填写', formState.topic === TOPIC && formState.grade === GRADE
      && formState.count === STUDENT_COUNT, JSON.stringify(formState));
    check('【生成教案草稿】按钮对管理员可见', formState.btnVisible === true);

    /* ---------- ④ 真实点击【生成教案草稿】，等待真实 SSE 流结束 ---------- */
    const startedAt = Date.now();
    await clickReal(page, '#generateLessonButton', '✨ 生成教案草稿');
    log('已真实点击「✨ 生成教案草稿」，等待智谱真实流式返回…');

    let lastLen = -1;
    let finished = null;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => {
        let raw = '';
        let hasDraft = false;
        try {
          hasDraft = typeof aiLessonDraft !== 'undefined' && Boolean(aiLessonDraft);
          raw = hasDraft ? String(aiLessonDraft.content || '') : '';
        } catch (error) { /* 忽略 */ }
        const cont = document.getElementById('continueLessonButton');
        const contHint = document.getElementById('lessonContinueHint');
        const hint = document.getElementById('lessonSectionHint');
        return {
          rawLen: raw.length,
          contDisabled: cont ? cont.disabled : null,
          contHint: contHint ? contHint.textContent : '',
          hint: hint ? hint.textContent : '',
          hasDraft,
        };
      });
      if (state.rawLen !== lastLen) {
        lastLen = state.rawLen;
        if (state.rawLen > 0) log(`… 已收到 ${state.rawLen} 字`);
      }
      if (state.contHint && /失败|中断|超时/.test(state.contHint)) {
        throw new Error(`AI 生成失败：${state.contHint}`);
      }
      /* 结束条件：续写按钮恢复可用（= 流已结束）且正文非空 */
      if (state.hasDraft && state.contDisabled === false && state.rawLen > 0) {
        finished = state;
        break;
      }
      await sleep(1000);
    }
    if (!finished) throw new Error('180 秒内没有等到 AI 生成结束（流没有正常收尾）');
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    log(`AI 真实生成结束，耗时 ${elapsed} 秒`);

    /* ---------- ⑤ 断言：分段完整、无 JSON 残留、未被截断 ---------- */
    const report = await page.evaluate(() => {
      const raw = (typeof aiLessonDraft !== 'undefined' && aiLessonDraft)
        ? String(aiLessonDraft.content || '') : '';
      const parsed = parseLessonSections(raw);
      return {
        raw,
        sections: parsed.sections,
        order: parsed.order,
        hasSections: parsed.hasSections,
        hint: document.getElementById('lessonSectionHint')?.textContent || '',
        contHint: document.getElementById('lessonContinueHint')?.textContent || '',
        previewText: document.getElementById('aiGeneratedLessonContent')?.textContent || '',
      };
    });
    fs.writeFileSync(RAW_OUT, report.raw, 'utf8');
    log(`AI 原始输出已落盘：${RAW_OUT}（${report.raw.length} 字）`);

    check('真实调用了 /api/ai 接口', aiRequests.length > 0, `共 ${aiRequests.length} 次`);
    check('原始输出里确实用了 === 分隔符协议', report.hasSections === true,
      `解析到 ${report.order.length} 段：${report.order.join('、')}`);
    check('九个分段全部到齐', SECTIONS.every(key => report.order.includes(key)),
      report.order.join('、'));
    for (const key of SECTIONS) {
      const body = String(report.sections[key] || '').trim();
      check(`分段 ${key}（${SECTION_TITLES[key]}）有内容`, body.length > 0, `${body.length} 字`);
    }
    check('原始输出里能看到 ===XXX=== 字面分隔符',
      SECTIONS.every(key => report.raw.includes(`===${key}===`)));
    check('输出不是 JSON（首字符不是 {）', !report.raw.trim().startsWith('{'));
    check('输出里没有 JSON 代码围栏', !/```json|```JSON/.test(report.raw));
    check('输出里没有残留的 JSON 键名对（如 "objectiveSkill":）',
      !/"(objectiveSkill|keyPoints|processSteps|reflection)"\s*:/.test(report.raw));
    /* 🔓 字数封印解除后的"详实度"护栏：既要不截断，也不能退化回平庸提纲。
       以后谁再把"不超过 N 字 / 不要废话"加回 Prompt，这几条会先红。 */
    check('全文够详实（不少于 2500 字）', report.raw.length >= 2500, `${report.raw.length} 字`);
    const basicLen = String(report.sections.BASIC_PART || '').trim().length;
    check('基本部分够详实（不少于 900 字）', basicLen >= 900, `${basicLen} 字`);
    ['教师活动', '学生活动', '组织形式', '安全与易犯错误']
      .forEach(word => check(`教学过程写出「${word}」`, report.raw.includes(word)));
    check('创新情境真的落进正文（不是口号）', /情境|战队|勋章|积分|闯关|特训营/.test(report.raw));
    check('页面提示明确写"未被截断"', /未被截断/.test(report.hint), report.hint);
    check('没有出现"这些分段还没有内容"的缺段提示', !/还没有内容/.test(report.hint), report.hint);
    check('没有截断/续写警告', !/⚠️/.test(report.contHint), report.contHint);
    check('预览区已经渲染出正文', report.previewText.trim().length > 200,
      `${report.previewText.trim().length} 字`);

    const previewText = report.previewText;
    ['教学目标', '教学重难点', '场地与器材', '准备部分', '基本部分', '结束部分', '课后反思']
      .forEach(title => check(`预览区包含「${title}」`, previewText.includes(title)));

    await page.screenshot({ path: SHOT_DRAFT, fullPage: false });
    log(`草稿弹窗截图已保存：${SHOT_DRAFT}`);

    /* ---------- ⑥ 真实点击【📋 填入教案表单】，断言各输入框 ---------- */
    const preFill = await page.evaluate(() => {
      const parsed = parseLessonSections(String(aiLessonDraft?.content || ''));
      return {
        draftLen: String(aiLessonDraft?.content || '').length,
        prepLen: String(parsed.sections.PREPARATION || '').length,
        overlays: document.querySelectorAll('.modal-overlay').length,
        forms: document.querySelectorAll('#lessonForm').length,
      };
    });
    log(`点击「填入教案表单」前：${JSON.stringify(preFill)}`);
    await clickReal(page, '#fillLessonFormButton', '📋 填入教案表单');
    await page.waitForSelector('#lessonForm', { timeout: 10000 });
    await sleep(400);
    const form = await page.evaluate(() => {
      const node = document.getElementById('lessonForm');
      const val = name => String(node?.querySelector(`[name="${name}"]`)?.value || '').trim();
      const rows = [...node.querySelectorAll('.lesson-process-row')].map(row => ({
        stage: row.querySelector('[data-process-stage]').value.trim(),
        minutes: row.querySelector('[data-process-minutes]').value.trim(),
        content: row.querySelector('[data-process-content]').value.trim(),
        contentLen: row.querySelector('[data-process-content]').value.length,
      }));
      return {
        title: val('title'), grade: val('grade'), sport: val('sport'), duration: val('duration'),
        markdownBody: val('content'),
        objectiveKnowledge: val('objectiveKnowledge'),
        objectiveSkill: val('objectiveSkill'),
        objectiveAttitude: val('objectiveAttitude'),
        keyPoints: val('keyPoints'),
        difficultyPoints: val('difficultyPoints'),
        equipment: val('equipment'),
        practiceDensity: val('practiceDensity'),
        reflection: val('reflection'),
        rows,
        overlays: document.querySelectorAll('.modal-overlay').length,
        forms: document.querySelectorAll('#lessonForm').length,
        containers: document.querySelectorAll('#lessonProcessSteps').length,
        containerHtmlLen: (document.getElementById('lessonProcessSteps')?.innerHTML || '').length,
      };
    });
    log(`填入后的表单：${JSON.stringify(form, null, 2)}`);

    check('课题已填入', form.title === TOPIC, form.title);
    check('教案 Markdown 正文已填入（还原后的正文，不含 === 分隔符）',
      form.markdownBody.length > 200 && !/===[A-Z_]+===/.test(form.markdownBody),
      `${form.markdownBody.length} 字`);
    check('三维目标 · 知识与认知 有内容', form.objectiveKnowledge.length > 0, form.objectiveKnowledge);
    check('三维目标 · 运动技能 有内容', form.objectiveSkill.length > 0, form.objectiveSkill);
    check('三维目标 · 情感态度与社会适应 有内容', form.objectiveAttitude.length > 0, form.objectiveAttitude);
    check('教学重点 有内容', form.keyPoints.length > 0, form.keyPoints);
    check('教学难点 有内容', form.difficultyPoints.length > 0, form.difficultyPoints);
    check('场地与器材 有内容', form.equipment.length > 0, form.equipment);
    check('预计练习密度与心率 有内容', form.practiceDensity.length > 0, form.practiceDensity);
    check('课后反思 有内容', form.reflection.length > 0, form.reflection);
    check('教学过程填了 3 个环节', form.rows.length === 3, `${form.rows.length} 个`);
    ['准备部分', '基本部分', '结束部分'].forEach((stage, index) => {
      const row = form.rows[index] || {};
      const key = ['PREPARATION', 'BASIC_PART', 'END_PART'][index];
      const sectionLen = String(report.sections[key] || '').trim().length;
      check(`环节「${stage}」有内容`, row.content && row.content.length > 0, row.content?.slice(0, 40));
      check(`环节「${stage}」时长已填`, Number(row.minutes) > 0, `${row.minutes} 分钟`);
      /* 🔥 严格比对：输入框里的内容必须和分段原文【逐字一致】，不能只剩第一行 */
      check(`环节「${stage}」内容与分段原文完全一致（未被截断）`,
        row.contentLen === sectionLen,
        `输入框 ${row.contentLen} 字 / 分段原文 ${sectionLen} 字`);
    });
    const totalMinutes = form.rows.reduce((sum, row) => sum + (Number(row.minutes) || 0), 0);
    check('三个环节时长合计 40 分钟', totalMinutes === 40, `${totalMinutes} 分钟`);

    await page.screenshot({ path: SHOT_FORM, fullPage: false });
    log(`填入表单截图已保存：${SHOT_FORM}`);

    log('🎉 E2E 全部断言通过：真实 AI 生成 → 九段齐全 → 未被截断 → 全部填进教案表单');
    return { ok: true };
  } finally {
    if (browser) { try { await browser.close(); } catch (error) { /* 忽略 */ } }
    if (server) {
      try { server.kill('SIGTERM'); } catch (error) { /* 忽略 */ }
      log('server.js 已关闭');
    }
    restoreEnv();
    fs.writeFileSync(LOG, `${lines.join('\n')}\n\n----- 浏览器完整 console -----\n${browserConsole.join('\n')}\n`, 'utf8');
    console.log(`完整日志已保存：${LOG}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    log(`❌ E2E 失败：${error?.stack || error}`);
    process.exit(1);
  });
