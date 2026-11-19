/**
 * 公开纯本地离线版 E2E 闭环：
 *   ① 输入【纯本地密码】→ 顶栏徽章 / AI 按钮置灰 / 写数据零 POST / guest_ 命名空间
 *   ② 输入【AI 体验密码】→ AI 按钮解锁 / 触发生成 / 生成结果保存在 guest_ 本地草稿
 *
 *   node tests/e2e/public-local-mode.e2e.js
 *
 * 真 server.js + 真 Chrome + 真登录接口；AI 上游用页内 fetch stub 返回固定 SSE，
 * 这样测的是权限链路而不是智谱额度。每次 /api/ai 请求头都会记录并断言带 AI 票。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PORT) || 5255;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENV_LOCAL = path.join(ROOT, '.env.local');
const ENV_BACKUP = `${ENV_LOCAL}.public-e2e-backup`;
const LOG = path.join(__dirname, 'public-local-mode-run.log');

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
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}
async function waitServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await get(`${BASE}/lessons.html`) === 200) return; } catch (error) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('server.js 没有就绪');
}
function readEnvValue(key) {
  if (!fs.existsSync(ENV_LOCAL)) return '';
  for (const line of fs.readFileSync(ENV_LOCAL, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && match[1] === key) return match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}
function swapEnvWithoutSupabase() {
  if (!fs.existsSync(ENV_LOCAL)) return false;
  const original = fs.readFileSync(ENV_LOCAL, 'utf8');
  const stripped = original.split(/\r?\n/)
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
  } catch (error) {
    log(`⚠️ .env.local 恢复失败，请手动还原：${error.message}`);
  }
}

let server = null;
let browser = null;

async function loginWithPassword(page, password) {
  await page.evaluate(() => {
    if (window.Auth?.isLocalMode?.()) { window.Auth.clearAdmin(); window.Auth.refresh(); }
  });
  log(`打开登录框，输入密码（${password === readEnvValue('PUBLIC_PASSWORD_AI') ? 'AI 体验' : '纯本地'}）`);
  await page.evaluate(() => window.Auth.openLoginModal(true));
  await page.waitForSelector('#adminPasswordInput', { visible: true, timeout: 10000 });
  await page.type('#adminPasswordInput', password);
  await page.evaluate(() => window.Auth.submitLogin());
  await page.waitForFunction(mode => window.Auth?.isLocalMode?.() === true
    && window.Auth.canUseAI() === (mode === 'ai'), { timeout: 15000 },
  password === readEnvValue('PUBLIC_PASSWORD_AI') ? 'ai' : 'local');
}

async function main() {
  const localPassword = readEnvValue('PUBLIC_PASSWORD_LOCAL');
  const aiPassword = readEnvValue('PUBLIC_PASSWORD_AI');
  check('.env.local 配了 PUBLIC_PASSWORD_LOCAL', Boolean(localPassword));
  check('.env.local 配了 PUBLIC_PASSWORD_AI', Boolean(aiPassword));
  check('两个公开密码不一样', localPassword !== aiPassword);
  if (swapEnvWithoutSupabase()) {
    log('已临时摘掉 Supabase 配置：启动阶段不会去拉云端，专注本地权限链路');
    process.on('exit', restoreEnv);
  }

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => log(`[server] ${String(chunk).trim()}`));
  server.stderr.on('data', chunk => log(`[server:err] ${String(chunk).trim()}`));
  await waitServer();

  browser = await puppeteer.launch({
    headless: true, executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const apiDataPosts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/data')) {
      apiDataPosts.push(request.url());
    }
  });
  await page.goto(`${BASE}/lessons.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.Auth === 'object' && typeof window.Store === 'object');

  /* ---------------- 阶段 ①：纯本地密码 ---------------- */
  await loginWithPassword(page, localPassword);
  const localState = await page.evaluate(() => ({
    local: Auth.isLocalMode(), ai: Auth.canUseAI(),
    badge: document.getElementById('publicModeBadge')?.textContent || '',
    adminHidden: document.getElementById('adminToggleBtn')?.hidden,
    aiButtons: [...document.querySelectorAll('[data-ai-action]')].map(node => ({
      disabled: node.disabled, title: node.title, id: node.id,
    })),
  }));
  check('纯本地密码 → isLocalMode=true', localState.local);
  check('纯本地密码 → canUseAI=false', !localState.ai);
  check('顶栏徽章显示「纯本地版（无AI）」', localState.badge.includes('纯本地版（无AI）'), localState.badge);
  check('管理员登录入口已隐藏', localState.adminHidden === true);
  check('AI 生成按钮全部置灰', localState.aiButtons.length > 0
    && localState.aiButtons.every(button => button.disabled), JSON.stringify(localState.aiButtons));
  check('悬浮提示是指定文案', localState.aiButtons.every(button => button.title.includes('AI 体验密码登录')));

  await page.evaluate(() => Store.write('pe_e2e_probe', [{ id: 'local-only', value: 42 }]));
  await sleep(300);
  const localWrite = await page.evaluate(() => ({
    namespaced: window.localStorage.getItem('guest_pe_e2e_probe'),
    original: window.localStorage.getItem('pe_e2e_probe'),
  }));
  check('写数据落在 guest_ 命名空间', Boolean(localWrite.namespaced), localWrite.namespaced || '');
  check('管理员命名空间零污染', localWrite.original === null);
  check('纯本地模式下写数据零 POST /api/data', apiDataPosts.length === 0,
    `${apiDataPosts.length} 次`);

  /* ---------------- 阶段 ②：AI 体验密码 ---------------- */
  await loginWithPassword(page, aiPassword);
  const aiState = await page.evaluate(() => ({
    ai: Auth.canUseAI(),
    token: Auth.getPublicToken(),
    badge: document.getElementById('publicModeBadge')?.textContent || '',
    aiButtons: [...document.querySelectorAll('[data-ai-action]')].map(node => ({
      disabled: node.disabled, id: node.id,
    })),
  }));
  check('AI 密码 → canUseAI=true', aiState.ai);
  check('AI 密码 → 服务端签发了票', Boolean(aiState.token));
  check('顶栏徽章显示「本地畅玩版」', aiState.badge.includes('本地畅玩版'), aiState.badge);
  check('AI 按钮恢复可用', aiState.aiButtons.length > 0
    && aiState.aiButtons.every(button => !button.disabled), JSON.stringify(aiState.aiButtons));

  /* 网络层接住 AI 请求：Auth 的 fetch 守卫会照常加票，这里只回固定 SSE，不烧智谱额度 */
  const aiTokens = [];
  const frame = data => `data: ${JSON.stringify(data)}\n\n`;
  const sseBody = frame({ choices: [{ delta: { content: '===CONTENT===\nE2E 垫球教学内容' } }] })
    + frame({ choices: [{ delta: { content: '\n===TARGET===\nE2E 教学目标' } }] })
    + frame({ choices: [{ delta: { content: '\n===REFLECTION===\nE2E 课后反思' } }] })
    + 'data: [DONE]\n\n';
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/api/ai') || url.includes('/api/generate-')) {
      const headers = request.headers();
      aiTokens.push(headers['x-public-ai-token'] || headers['X-Public-AI-Token'] || '');
      request.respond({ status: 200, contentType: 'text/event-stream', body: sseBody });
      return;
    }
    request.continue();
  });

  await page.evaluate(() => window.openAIGeneration());
  await page.waitForSelector('#aiLessonForm', { visible: true });
  await page.type('input[name="topic"]', 'E2E 垫球测试课');
  await page.click('#generateLessonButton');
  await page.waitForFunction(() => (document.getElementById('aiGeneratedLessonContent')?.textContent || '')
    .includes('E2E 垫球教学内容'), { timeout: 20000 });
  await page.evaluate(() => window.saveAIGeneratedLesson());
  await sleep(400);

  const result = await page.evaluate(() => {
    const plans = JSON.parse(window.localStorage.getItem('guest_pe_lesson_plans') || '[]');
    return {
      saved: plans.some(plan => String(plan.title || '').includes('E2E 垫球测试课')),
      originalPlans: window.localStorage.getItem('pe_lesson_plans'),
      lessonKeys: Object.keys(window.localStorage).filter(key => key.includes('lesson')),
      toasts: [...document.querySelectorAll('.toast')].map(node => node.textContent),
    };
  });
  log(`保存后诊断：${JSON.stringify(result)}；AI 票：${aiTokens.length} 次`);
  check('生成结果成功保存在 guest_ 本地草稿', result.saved);
  check('生成结果不写进管理员命名空间', result.originalPlans === null);
  check('AI 请求带 X-Public-AI-Token', aiTokens.length > 0
    && aiTokens.every(token => Boolean(token)), JSON.stringify(aiTokens));
  check('整个流程零 POST /api/data', apiDataPosts.length === 0, `${apiDataPosts.length} 次`);

  log('🎉 E2E 全部通过：纯本地密码禁 AI 且零云端 POST；AI 密码解锁后生成结果留在 guest_ 本机命名空间');
}

main()
  .catch(error => {
    log(`❌ E2E 失败：${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch (error) { /* 忽略 */ }
    try { if (server) server.kill('SIGTERM'); } catch (error) { /* 忽略 */ }
    restoreEnv();
    fs.writeFileSync(LOG, `${lines.join('\n')}\n`);
    log(`完整日志：${LOG}`);
  });
