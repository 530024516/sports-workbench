/**
 * 真实 Puppeteer E2E：AI 体验票过期（401 TOKEN_EXPIRED）→ 前端自动清状态 + 弹窗重新登录
 *
 *   node tests/e2e/ai-token-expired.e2e.js
 *
 * 真 server.js + 真 Chrome + 真登录接口；只有 /api/ai 用请求拦截回 401（模拟过期票）。
 *
 * 断言：
 *   ① 真登录 AI 密码 → canUseAI=true、有票
 *   ② 点【生成教案草稿】收到 401 TOKEN_EXPIRED
 *   ③ 弹窗出现指定文案，canUseAI=false、本地票被清空、纯本地模式保留
 *   ④ AI 按钮重新置灰；点「重新输入体验密码」能打开登录框
 *
 * 产物：tests/e2e/ai-token-expired-pass.png / ai-token-expired-run.log
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const OUT = __dirname;
const SHOT = path.join(OUT, 'ai-token-expired-pass.png');
const LOG = path.join(OUT, 'ai-token-expired-run.log');
const PORT = Number(process.env.E2E_PORT) || 5295;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENV_LOCAL = path.join(ROOT, '.env.local');
const ENV_BACKUP = `${ENV_LOCAL}.expired-e2e-backup`;
const EXPIRED_BODY = JSON.stringify({
  error: 'AI 体验权限已过期，请重新输入体验密码登录',
  code: 'TOKEN_EXPIRED',
  tokenExpired: true,
});

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
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}
async function waitServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await get(`${BASE}/lessons.html`) === 200) return; } catch (error) { /* 还没起来 */ }
    await sleep(200);
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
    log('.env.local 已原样恢复');
  } catch (error) {
    log(`⚠️ .env.local 恢复失败，请手动从 ${ENV_BACKUP} 还原：${error.message}`);
  }
}

async function main() {
  const aiPassword = readEnvValue('PUBLIC_PASSWORD_AI');
  check('.env.local 配了 PUBLIC_PASSWORD_AI', Boolean(aiPassword));
  if (swapEnvWithoutSupabase()) {
    log('已临时摘掉 Supabase 配置，结束自动恢复');
    process.on('exit', restoreEnv);
  }
  let server = null;
  let browser = null;
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => log(`[server] ${String(chunk).trim()}`));
    server.stderr.on('data', chunk => log(`[server:err] ${String(chunk).trim()}`));
    await waitServer();

    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROME,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    log(`真实 Chrome 已启动：${await browser.version()}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', error => log(`[pageerror] ${error.message}`));
    await page.goto(`${BASE}/lessons.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.Auth === 'object'
      && !document.getElementById('store-loading'), { timeout: 60000 });

    /* 真登录 AI 体验密码 */
    await page.evaluate(() => Auth.openLoginModal(true));
    await page.waitForSelector('#adminPasswordInput', { visible: true, timeout: 10000 });
    await page.type('#adminPasswordInput', aiPassword);
    await page.evaluate(() => Auth.submitLogin());
    await page.waitForFunction(() => Auth.canUseAI() === true && Boolean(Auth.getPublicToken()),
      { timeout: 15000 });
    log('已用 AI 体验密码真实登录：canUseAI=true 且本地有票');

    /* 拦住 /api/ai，回 401 TOKEN_EXPIRED（模拟票过期） */
    const expiredRequests = [];
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().includes('/api/ai')) {
        expiredRequests.push({
          url: request.url(),
          token: request.headers()['x-public-ai-token'] || '',
        });
        request.respond({
          status: 401,
          contentType: 'application/json; charset=utf-8',
          body: EXPIRED_BODY,
        });
        return;
      }
      request.continue();
    });

    /* 真点【AI 生成教案】→ 真点【生成教案草稿】
       等登录弹窗的 300ms 关闭动画走完，否则遮罩会吃掉第一次点击 */
    await sleep(600);
    await page.click('button[onclick="openAIGeneration()"]');
    await page.waitForSelector('#aiLessonForm', { timeout: 10000 });
    await sleep(400);
    await page.click('#aiLessonForm input[name="topic"]');
    await page.keyboard.type('篮球原地运球');
    await page.click('#generateLessonButton');
    log('已真实点击「生成教案草稿」，等待 401…');

    await page.waitForFunction(() => [...document.querySelectorAll('.modal-overlay')]
      .some(node => node.textContent.includes('AI 体验权限已过期')), { timeout: 15000 });
    check('服务端确实收到带 X-Public-AI-Token 的 AI 请求',
      expiredRequests.length > 0 && Boolean(expiredRequests[0].token),
      `${expiredRequests.length} 次`);

    const state = await page.evaluate(() => ({
      modalText: [...document.querySelectorAll('.modal-overlay')]
        .map(node => node.textContent).join(' '),
      canUseAI: Auth.canUseAI(),
      token: Auth.getPublicToken(),
      localMode: Auth.isLocalMode(),
      aiButtons: [...document.querySelectorAll('[data-ai-action]')].map(node => node.disabled),
    }));
    log(`401 后的页面状态：${JSON.stringify(state)}`);
    check('弹窗包含指定文案「AI 体验权限已过期，请重新输入体验密码登录」',
      state.modalText.includes('AI 体验权限已过期，请重新输入体验密码登录'),
      state.modalText.slice(0, 200));
    check('canUseAI 已被清除', state.canUseAI === false);
    check('本地过期票已被清除', state.token === '');
    check('纯本地模式保留（只清 AI 权限，不踢出本地数据环境）', state.localMode === true);
    check('AI 按钮已重新置灰', state.aiButtons.length > 0 && state.aiButtons.every(Boolean),
      JSON.stringify(state.aiButtons));

    await page.screenshot({ path: SHOT, fullPage: false });
    log(`截图已保存：${SHOT}`);

    /* 点「重新输入体验密码」→ 登录框应弹出 */
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(node => node.textContent.includes('重新输入体验密码'));
      btn?.click();
    });
    await page.waitForSelector('#adminPasswordInput', { visible: true, timeout: 10000 });
    check('点「重新输入体验密码」能打开登录框', true);

    log('🎉 E2E 全部断言通过：401 自动清票 + 弹窗提示 + 重新登录入口可用');
    return { ok: true };
  } finally {
    if (browser) { try { await browser.close(); } catch (error) { /* 忽略 */ } }
    if (server) {
      try { server.kill('SIGTERM'); } catch (error) { /* 忽略 */ }
      log('server.js 已关闭');
    }
    restoreEnv();
    fs.writeFileSync(LOG, `${lines.join('\n')}\n`, 'utf8');
    console.log(`完整日志已保存：${LOG}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    log(`❌ E2E 失败：${error?.stack || error}`);
    process.exit(1);
  });
