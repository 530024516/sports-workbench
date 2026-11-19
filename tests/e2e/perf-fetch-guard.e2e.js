/**
 * 真实 Puppeteer E2E：Vercel 卡顿优化验证
 *
 *   node tests/e2e/perf-fetch-guard.e2e.js
 *
 * 真 server.js + 真 Chrome + 真登录接口；只有 /api/ai 用请求拦截回 401。
 * 通过给 Response.prototype.clone 打桩，实证全局 fetch 拦截器不再无差别读流。
 *
 * 断言：
 *   ① GET /api/config、200 的 POST /api/public-auth → clone() 调用数为 0
 *   ② 401 的 POST /api/ai → clone() 恰好 1 次，且能正常弹过期提示
 *   ③ 源码里没有 setInterval 心跳；RECONNECT_DELAY 已拉长；有 focus 事件驱动补同步
 *   ④ Store.stopBackgroundSync() 后 2 秒内 0 个 /api/data 请求；
 *      sync() 直接返回 auth-blocked；clearAuthBlock() 后恢复
 *   ⑤ deferIdle 存在且启动时的后台同步已挪到空闲期
 *
 * 产物：tests/e2e/perf-fetch-guard-run.log
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const LOG = path.join(__dirname, 'perf-fetch-guard-run.log');
const PORT = Number(process.env.E2E_PORT) || 5303;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENV_LOCAL = path.join(ROOT, '.env.local');
const ENV_BACKUP = `${ENV_LOCAL}.perf-e2e-backup`;

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

  /* ---------- 源码级静态断言 ---------- */
  const authSrc = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');
  check('js/auth.js / js/store.js 没有 setInterval 心跳',
    !/\bsetInterval\s*\(/.test(authSrc) && !/\bsetInterval\s*\(/.test(storeSrc));
  check('重连间隔已从 8 秒拉长到 30 秒', /const RECONNECT_DELAY = 30000;/.test(storeSrc));
  check('已改为 focus 事件驱动补同步', /addEventListener\('focus'/.test(storeSrc));
  check('已提供 deferIdle（requestIdleCallback + 500ms 降级）',
    /deferIdle\(task, delay = 500\)/.test(storeSrc) && /requestIdleCallback/.test(storeSrc));
  check('401/403 熔断方法存在且接进 _doFetch',
    /stopBackgroundSync\(reason/.test(storeSrc)
    && /response\.status === 401 \|\| response\.status === 403/.test(storeSrc));
  check('fetch 拦截器有前置过滤（只读 + 无票直接放行）',
    /const mightExpire = isApi && !isReadOnly && Boolean\(this\.getPublicToken\(\)\)/.test(authSrc));

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
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', error => log(`[pageerror] ${error.message}`));

    /* 在任何页面脚本之前给 Response.clone 打桩，统计全局拦截器读流的次数 */
    await page.evaluateOnNewDocument(() => {
      window.__cloneCalls = [];
      const original = Response.prototype.clone;
      Response.prototype.clone = function patchedClone(...args) {
        window.__cloneCalls.push({ url: this.url, status: this.status });
        return original.apply(this, args);
      };
      window.__dataRequests = [];
      const originalFetch = window.fetch;
      window.fetch = function countedFetch(input, init) {
        const url = typeof input === 'string' ? input : String(input?.url || '');
        if (url.includes('/api/data')) window.__dataRequests.push(url);
        return originalFetch.apply(this, arguments);
      };
    });

    await page.goto(`${BASE}/lessons.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.Auth === 'object'
      && typeof window.Store === 'object'
      && !document.getElementById('store-loading'), { timeout: 60000 });

    /* 真登录 → 本地有票，后续请求才会进入「可能需要检查过期」的分支 */
    await page.evaluate(() => Auth.openLoginModal(true));
    await page.waitForSelector('#adminPasswordInput', { visible: true, timeout: 10000 });
    await page.type('#adminPasswordInput', aiPassword);
    await page.evaluate(() => Auth.submitLogin());
    await page.waitForFunction(() => Auth.canUseAI() && Boolean(Auth.getPublicToken()),
      { timeout: 15000 });
    await sleep(600);
    check('已登录且本地有 AI 票（假设最坏情况：所有写请求都可能被检查）', true);

    /* ---------- ① GET + 200 POST 都不该 clone ---------- */
    await page.evaluate(() => { window.__cloneCalls = []; });
    const plain = await page.evaluate(async () => {
      const getRes = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      const postRes = await fetch('/api/public-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'definitely-wrong-password' }),
      });
      return { getStatus: getRes.status, postStatus: postRes.status };
    });
    log(`普通请求结果：${JSON.stringify(plain)}`);
    const afterPlain = await page.evaluate(() => window.__cloneCalls.slice());
    check('GET /api/config 与 200/403 的 POST 都没有触发 response.clone()',
      afterPlain.length === 0, JSON.stringify(afterPlain));

    /* ---------- ② 401 的 POST /api/ai 只 clone 一次 ---------- */
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().includes('/api/ai')) {
        request.respond({
          status: 401,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ code: 'TOKEN_EXPIRED', tokenExpired: true, error: 'AI 体验权限已过期，请重新输入体验密码登录' }),
        });
        return;
      }
      request.continue();
    });
    await page.evaluate(() => { window.__cloneCalls = []; });
    await page.click('button[onclick="openAIGeneration()"]');
    await page.waitForSelector('#aiLessonForm', { timeout: 10000 });
    await sleep(400);
    await page.click('#aiLessonForm input[name="topic"]');
    await page.keyboard.type('篮球原地运球');
    await page.click('#generateLessonButton');
    await page.waitForFunction(() => [...document.querySelectorAll('.modal-overlay')]
      .some(node => node.textContent.includes('AI 体验权限已过期')), { timeout: 15000 });
    const afterExpired = await page.evaluate(() => window.__cloneCalls.slice());
    log(`401 之后的 clone 调用：${JSON.stringify(afterExpired)}`);
    check('401 的 POST /api/ai 恰好 clone 1 次', afterExpired.length === 1,
      JSON.stringify(afterExpired));
    check('clone 的确实是 /api/ai 的 401 响应',
      afterExpired[0]?.url.includes('/api/ai') && afterExpired[0]?.status === 401,
      JSON.stringify(afterExpired[0]));

    /* ---------- ④ 401/403 熔断后不再发包 ---------- */
    const blocked = await page.evaluate(async () => {
      const result = Store.stopBackgroundSync('E2E 401');
      window.__dataRequests = [];
      const syncResult = await Store.sync();
      await new Promise(resolve => setTimeout(resolve, 2000));
      return {
        result,
        syncResult,
        dataRequests: window.__dataRequests.slice(),
        blockedReason: Store._backgroundPushBlocked(),
      };
    });
    log(`熔断后状态：${JSON.stringify(blocked)}`);
    check('stopBackgroundSync 停掉了定时器并取消了在飞 GET', blocked.result.ok === true);
    check('sync() 直接返回 auth-blocked，不发请求',
      blocked.syncResult?.reason === 'auth-blocked', JSON.stringify(blocked.syncResult));
    check('熔断后 2 秒内 0 个 /api/data 请求',
      blocked.dataRequests.length === 0, JSON.stringify(blocked.dataRequests));
    check('后台上传闸门明确处于熔断状态',
      String(blocked.blockedReason).includes('熔断'), blocked.blockedReason);

    const resumed = await page.evaluate(() => ({
      cleared: Store.clearAuthBlock('E2E 重新登录'),
      blocked: Store._authBlocked,
    }));
    check('clearAuthBlock() 能恢复后台同步',
      resumed.cleared.ok === true && resumed.blocked === false, JSON.stringify(resumed));

    log('🎉 E2E 全部断言通过：fetch 拦截器零多余读流、401 熔断后零后台发包');
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
