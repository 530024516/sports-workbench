/**
 * 真实 Puppeteer E2E：纯净管理员模式下的性能与熔断回归
 *
 *   node tests/e2e/perf-fetch-guard.e2e.js
 *
 * 真 server.js + 真 Chrome + 真管理员登录。
 * 断言：
 *   ① auth.js 已无 installFetchGuard（没有任何全局 fetch 拦截 / clone().json()）
 *   ② GET /api/config、200/403 的 POST 都不会触发 response.clone()
 *   ③ 源码无 setInterval 心跳、重连间隔 30s、focus 事件补同步、deferIdle 延迟加载
 *   ④ Store.stopBackgroundSync() 后 2 秒内 0 个 /api/data 请求，
 *      sync() 返回 auth-blocked；clearAuthBlock() 后恢复
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
const PORT = Number(process.env.E2E_PORT) || 5307;
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
  const adminPassword = readEnvValue('ADMIN_PASSWORD');
  check('.env.local 配了 ADMIN_PASSWORD', Boolean(adminPassword));

  const authSrc = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');
  check('auth.js 已彻底删除 installFetchGuard', !/installFetchGuard/.test(authSrc));
  check('auth.js 没有 clone().json() 全局读流', !/\.clone\(\)\.json\(\)/.test(authSrc));
  check('js/auth.js / js/store.js 没有 setInterval 心跳',
    !/\bsetInterval\s*\(/.test(authSrc) && !/\bsetInterval\s*\(/.test(storeSrc));
  check('重连间隔已拉长到 30 秒', /const RECONNECT_DELAY = 30000;/.test(storeSrc));
  check('已改为 focus 事件驱动补同步', /addEventListener\('focus'/.test(storeSrc));
  check('已提供 deferIdle（requestIdleCallback + 500ms 降级）',
    /deferIdle\(task, delay = 500\)/.test(storeSrc) && /requestIdleCallback/.test(storeSrc));
  check('401/403 熔断方法仍在', /stopBackgroundSync\(reason/.test(storeSrc));

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

    await page.evaluateOnNewDocument(() => {
      window.__cloneCalls = [];
      const original = Response.prototype.clone;
      Response.prototype.clone = function patchedClone(...args) {
        window.__cloneCalls.push({ url: this.url, status: this.status });
        return original.apply(this, args);
      };
      window.__dataRequests = [];
      const originalFetch = window.fetch;
      window.fetch = function countedFetch(input) {
        const url = typeof input === 'string' ? input : String(input?.url || '');
        if (url.includes('/api/data')) window.__dataRequests.push(url);
        return originalFetch.apply(this, arguments);
      };
    });

    await page.goto(`${BASE}/lessons.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.Auth === 'object'
      && typeof window.Store === 'object'
      && !document.getElementById('store-loading'), { timeout: 60000 });

    await page.evaluate(() => Auth.openLoginModal(true));
    await page.waitForSelector('#adminPasswordInput', { visible: true, timeout: 10000 });
    await page.type('#adminPasswordInput', adminPassword);
    await page.evaluate(() => Auth.submitLogin());
    await page.waitForFunction(() => Auth.isAdmin() === true, { timeout: 15000 });
    await sleep(600);
    check('管理员登录成功', true);

    await page.evaluate(() => { window.__cloneCalls = []; });
    const responses = await page.evaluate(async password => {
      const getRes = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      const okRes = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const badRes = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      return { get: getRes.status, ok: okRes.status, bad: badRes.status };
    }, adminPassword);
    log(`普通请求结果：${JSON.stringify(responses)}`);
    const cloneCalls = await page.evaluate(() => window.__cloneCalls.slice());
    check('GET 与 200/403 的 POST 都没有触发 response.clone()',
      cloneCalls.length === 0, JSON.stringify(cloneCalls));

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
    check('sync() 直接返回 auth-blocked', blocked.syncResult?.reason === 'auth-blocked',
      JSON.stringify(blocked.syncResult));
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

    log('🎉 E2E 全部断言通过：无全局 fetch 拦截、熔断后零后台发包');
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
