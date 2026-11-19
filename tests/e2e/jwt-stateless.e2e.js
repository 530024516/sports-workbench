/**
 * 真实 E2E：AI 体验 JWT 无状态验证 —— 签发 → 强行重启服务 → 旧 JWT 依然能请求 AI
 *
 *   node tests/e2e/jwt-stateless.e2e.js
 *
 * 全程真实：真 server.js 进程（启动两次，第二次是全新进程 / 内存全空）、真 HTTP 请求、
 * 真登录接口、真 /api/ai 闸门与 SSE 转发。
 * 只有「智谱上游」用本地 HTTPS mock 顶替（测的是鉴权链路，不烧额度、不受网络波动影响）。
 *
 * 断言：
 *   ① 真登录 AI 密码拿到 3 段 JWT（role=ai_guest / exp=12h）
 *   ② 杀掉服务、换一个全新进程 → 带着【旧 JWT】POST /api/ai 仍返回 200 + SSE 正文
 *   ③ 伪造 JWT / 过期 JWT → 401 + code=TOKEN_EXPIRED
 *   ④ 本地密码仍拿不到票，没票请求 AI 仍是 403 ADMIN_REQUIRED
 *
 * 产物：tests/e2e/jwt-stateless-run.log
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const LOG = path.join(__dirname, 'jwt-stateless-run.log');
const PORT = Number(process.env.E2E_PORT) || 5291;
const UPSTREAM_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const ENV_LOCAL = path.join(ROOT, '.env.local');
const MOCK_CONTENT = 'JWT 无状态验证内容-重启后依然拿到 AI 回复';

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
function readEnvValue(key) {
  if (!fs.existsSync(ENV_LOCAL)) return '';
  for (const line of fs.readFileSync(ENV_LOCAL, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && match[1] === key) return match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}
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
    try { if (await get(`${BASE}/index.html`) === 200) return; } catch (error) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error(`server.js 在 ${timeoutMs}ms 内没有就绪`);
}
/** 真 HTTP POST：收集完整响应（含 SSE 流） */
function post(pathname, body, headers = {}, base = BASE) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(pathname, base);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (error) { /* SSE 不是 JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
    req.end(payload);
  });
}
/** 起一个全新的 server.js 进程；env 指向本地 HTTPS mock 上游 */
function startServer(tag) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_API_URL: `https://127.0.0.1:${UPSTREAM_PORT}/chat/completions`,
      AI_API_KEY: 'e2e-mock-key',
      AI_MODEL: 'e2e-mock-model',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',   // 仅测试进程：信任自签证书
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => log(`[${tag}] ${String(chunk).trim()}`));
  server.stderr.on('data', chunk => log(`[${tag}:err] ${String(chunk).trim()}`));
  return server;
}
function stopServer(server) {
  return new Promise(resolve => {
    if (!server || server.killed) return resolve();
    server.once('exit', resolve);
    server.kill('SIGTERM');
    setTimeout(resolve, 3000);
  });
}

async function main() {
  const aiPassword = readEnvValue('PUBLIC_PASSWORD_AI');
  const localPassword = readEnvValue('PUBLIC_PASSWORD_LOCAL');
  const secret = readEnvValue('JWT_SECRET');
  check('.env.local 配了 PUBLIC_PASSWORD_AI', Boolean(aiPassword));
  check('.env.local 配了 PUBLIC_PASSWORD_LOCAL', Boolean(localPassword));
  check('.env.local 配了 JWT_SECRET', Boolean(secret) && secret.length >= 32,
    `长度 ${secret.length}`);

  let upstream = null;
  let server = null;
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-e2e-'));
  try {
    /* ---------- 本地 HTTPS mock 上游：返回最小 SSE ---------- */
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
    upstream = https.createServer({
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }, (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        log(`[mock-upstream] 收到上游请求，Authorization=${req.headers.authorization}`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: MOCK_CONTENT } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise(resolve => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));
    log(`本地 HTTPS mock 上游已就绪：https://127.0.0.1:${UPSTREAM_PORT}`);

    /* ---------- 实例 ①：真登录，签发 JWT ---------- */
    server = startServer('实例①');
    await waitServer();
    const aiLogin = await post('/api/public-auth', { password: aiPassword });
    check('AI 密码真登录成功', aiLogin.status === 200 && aiLogin.json?.ok === true,
      `HTTP ${aiLogin.status}`);
    const token = aiLogin.json?.token || '';
    check('拿到的是 3 段 JWT', token.split('.').length === 3, token.slice(0, 24) + '…');
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    check('payload.role === ai_guest', payload.role === 'ai_guest', JSON.stringify(payload));
    check('有效期 12 小时', payload.exp - payload.iat === 12 * 60 * 60,
      `${payload.exp - payload.iat} 秒`);

    const localLogin = await post('/api/public-auth', { password: localPassword });
    check('本地密码依然能登录，且拿不到 JWT',
      localLogin.status === 200 && localLogin.json?.mode === 'local' && !localLogin.json?.token,
      `HTTP ${localLogin.status} / mode=${localLogin.json?.mode}`);

    /* ---------- 强行重启：杀掉进程，换一个全新 server.js ---------- */
    await stopServer(server);
    server = null;
    log('实例① 已 SIGTERM 关闭（服务端内存全部清空）');
    await sleep(400);
    server = startServer('实例②');
    await waitServer();
    log('实例② 已是全新进程，重新就绪');

    /* ---------- 核心断言：旧 JWT 在重启后的实例依然可用 ---------- */
    const aiBody = { type: 'lesson', grade: '三年级', topic: '篮球原地运球', studentCount: 30 };
    const afterRestart = await post('/api/ai', aiBody, { 'X-Public-AI-Token': token });
    check('【核心】重启后带旧 JWT 请求 /api/ai 成功（HTTP 200）',
      afterRestart.status === 200, `HTTP ${afterRestart.status} / ${afterRestart.text.slice(0, 160)}`);
    check('【核心】SSE 正文完整收到（鉴权通过后真转发了上游）',
      afterRestart.text.includes(MOCK_CONTENT), afterRestart.text.slice(0, 200));

    /* ---------- 过期 / 伪造票 → 401 TOKEN_EXPIRED ---------- */
    const forged = await post('/api/ai', aiBody, { 'X-Public-AI-Token': `${token.slice(0, -2)}xx` });
    check('伪造 JWT → 401', forged.status === 401, `HTTP ${forged.status}`);
    check('伪造 JWT → code=TOKEN_EXPIRED', forged.json?.code === 'TOKEN_EXPIRED',
      JSON.stringify(forged.json));
    const expired = jwt.sign({ role: 'ai_guest' }, secret, { algorithm: 'HS256', expiresIn: -10 });
    const expiredRes = await post('/api/ai', aiBody, { 'X-Public-AI-Token': expired });
    check('过期 JWT → 401 + code=TOKEN_EXPIRED',
      expiredRes.status === 401 && expiredRes.json?.code === 'TOKEN_EXPIRED',
      `HTTP ${expiredRes.status} / ${JSON.stringify(expiredRes.json)}`);
    check('401 文案提示重新登录',
      String(expiredRes.json?.error || '').includes('重新输入体验密码登录'),
      expiredRes.json?.error);

    /* ---------- 没票 → 仍是 403，本地密码与 JWT 无关 ---------- */
    const noTicket = await post('/api/ai', aiBody);
    check('没带票请求 AI → 仍是 403 ADMIN_REQUIRED',
      noTicket.status === 403 && noTicket.json?.code === 'ADMIN_REQUIRED',
      `HTTP ${noTicket.status} / ${JSON.stringify(noTicket.json)}`);

    log('🎉 E2E 全部断言通过：JWT 无状态，重启后旧票依然能调用 AI');
    return { ok: true };
  } finally {
    if (upstream) await new Promise(resolve => upstream.close(resolve));
    if (server) await stopServer(server);
    try { fs.rmSync(certDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
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
