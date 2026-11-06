/**
 * 本地开发服务器：静态站点 + AI 代理 + 数据接口
 * AI 逻辑统一放在 lib/ai-core.js，与 Vercel 函数 api/ai.js 共用同一套代码。
 * 线上部署到 Vercel 时不会使用本文件。
 */

// 必须在所有 require 之前：先读 .env，再用 .env.local 覆盖
// （Vercel 上这两个文件都不存在，dotenv 静默跳过，直接使用平台环境变量）
require('dotenv').config();
require('dotenv').config({ path: `${__dirname}/.env`, override: true });
require('dotenv').config({ path: `${__dirname}/.env.local`, override: true });

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleAiRequest } = require('./lib/ai-core.js');
const { handleDataRequest } = require('./lib/data-api.js');
const { handleAdminRequest } = require('./lib/admin-core.js');
const { requireAdmin } = require('./lib/admin-auth.js');
const supabase = require('./lib/supabase.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5123;
/**
 * AI 请求超时（毫秒）：显式 120000，与 lib/ai-core.js 的 AI_TIMEOUT_MS 默认值、
 * Vercel api/ai.js 的 config.maxDuration = 120 保持一致。
 * 大单元 18 课时严格串行，单课生成可能耗时较久；服务端绝不在这 120 秒之内主动掐断连接。
 */
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 120000;
/** /api/data 请求体上限：10MB（纯原生 http，接收逻辑在 lib/data-api.js 的 readJsonBody）。
 *  大单元 10 模块 + 18 课时的整份资源库列表很容易超过旧版 8MB；超限现在回 413，不再掐断 socket。 */
const DATA_MAX_BODY_BYTES = 10 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// 兼容旧地址：/api/ai 的类型由请求体 type 决定，旧路由固定类型
const AI_ROUTES = {
  '/api/ai': '',
  '/api/generate-lesson': 'lesson',
  '/api/generate-unit-design': 'unit',
  '/api/fitness': 'fitness',
};

// Supabase 配置状态（不下发密钥，密钥只存在于服务端 process.env）
function sendSupabaseConfig(req, res) {
  if (!isConfigAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '仅允许本机访问' }));
    return;
  }
  const configured = Boolean(supabase.isSupabaseConfigured());
  const payload = JSON.stringify({
    configured,                     // 统一字段名，与 api/config.js 一致
    supabaseConfigured: configured, // 旧字段，保留兼容
    keySource: configured ? supabase.getConfigSource() : '',
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function isConfigAllowed(req) {
  if (process.env.VERCEL) return true;
  const remoteAddress = req.socket?.remoteAddress || '';
  if (remoteAddress !== '::1' && remoteAddress !== '127.0.0.1' && !remoteAddress.startsWith('::ffff:127.')) return false;
  const origin = req.headers?.origin;
  return !origin || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin);
}

/* ---------------------------------------------------------------------------
 * 崩溃可观测性 + 请求兜底。
 * 以前 /api/data 的 handleDataRequest 是 async，这里直接调用、既不 await 也不 catch：
 * 写 Supabase 报错 / 客户端提前断开时 sendJson 抛错 → 未处理的 Promise 拒绝 →
 * Node 进程退出 → 浏览器只看到 502 Bad Gateway 和 "signal is aborted"，
 * 控制台一个栈都看不到。现在：打印真实崩溃栈 + 单个请求失败不再带走整个进程。
 * ⚠️ 本文件只用于本地开发服务器（Vercel 不走这里）。
 * --------------------------------------------------------------------------- */
function logCrash(kind, error) {
  console.error(`\n[server] ⛔ ${kind} —— 已捕获并打印真实崩溃栈，进程继续运行`);
  console.error(error?.stack || String(error));
  console.error('[server] 排障提示：栈里若出现 supabase / writeData，请检查 SUPABASE_URL、表结构与字段类型；'
    + '若出现 headersSent / EPIPE，说明客户端请求已提前 abort\n');
}
process.on('uncaughtException', error => logCrash('uncaughtException 未捕获异常', error));
process.on('unhandledRejection', reason => logCrash(
  'unhandledRejection 未处理的 Promise 拒绝',
  reason instanceof Error ? reason : new Error(String(reason)),
));

/** async handler 兜底：漏过 try/catch 的异常转成明确 502 JSON，绝不留成未处理拒绝 */
function guardAsync(task, res, label) {
  Promise.resolve().then(task).catch(error => {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    logCrash(`${label} handler 抛出异常`, wrapped);
    if (res.headersSent) {
      if (!res.writableEnded) { try { res.end(); } catch (writeError) { /* 连接已断 */ } }
      return;
    }
    try {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: `${label} 处理异常：${wrapped.message}`,
        code: 'HANDLER_CRASHED',
        hint: '服务端已打印崩溃栈；本次写入未生效，本地数据完好保留',
      }));
    } catch (writeError) {
      console.error('[server] 回写 502 失败（客户端可能已断开）', writeError);
    }
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  // 前端超时 abort 时响应流会 emit error；不监听就会升级成 uncaughtException
  res.on('error', error => console.warn(`[server] 响应流已断开 ${req.method} ${pathname}：${error?.message || error}`));
  if (pathname === '/api/config') {
    sendSupabaseConfig(req, res);
    return;
  }
  // 管理员登录校验（这个接口是"门"本身，不受写操作闸门限制）
  if (pathname === '/api/admin') {
    guardAsync(() => handleAdminRequest(req, res), res, '/api/admin');
    return;
  }
  /* ⛔ 权限闸门（安全底线）：GET 放行，POST/PUT/DELETE 必须带 X-Admin-Password。
     lib/data-api.js 与 lib/ai-core.js 里也各有一道，这里是入口处的第三道（纵深防御）。 */
  if (pathname === '/api/data') {
    if (!requireAdmin(req, res)) return;
    guardAsync(() => handleDataRequest(req, res, { maxBodyBytes: DATA_MAX_BODY_BYTES }), res, '/api/data');
    return;
  }
  if (Object.prototype.hasOwnProperty.call(AI_ROUTES, pathname)) {
    if (!requireAdmin(req, res)) return;
    guardAsync(() => handleAiRequest(req, res, { type: AI_ROUTES[pathname] || undefined, timeoutMs: AI_TIMEOUT_MS }), res, pathname);
    return;
  }

  let urlPath = decodeURIComponent(pathname);
  if (urlPath === '/') urlPath = '/index.html';

  // 安全检查
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (path.basename(filePath).startsWith('.env')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404 Not Found</h1>');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      // 本地开发期禁用缓存：否则改完 html/js 后浏览器仍用旧版本，
      // 会出现「页面上有按钮、点了却没反应」（旧 HTML 没引新脚本）这类查不出原因的问题
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

/* SSE 是长连接：显式禁用 socket 空闲超时，确保服务端不会在 AI_TIMEOUT_MS（120 秒）
   之前主动掐断正在吐字的流式响应。真正的超时只由 lib/ai-core.js 里
   https.request 的 timeout = 120000 兜底。 */
server.timeout = 0;
server.requestTimeout = Math.max(server.requestTimeout || 0, AI_TIMEOUT_MS + 30000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`体育教师工作台运行中: http://localhost:${PORT}`);
  console.log(supabase.isSupabaseConfigured()
    ? `数据存储: Supabase（${supabase.getConfigSource()} key）`
    : '数据存储: localStorage（未检测到 SUPABASE_URL / SUPABASE_ANON_KEY）');
});
