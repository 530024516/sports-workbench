/**
 * 本地开发服务器：静态站点 + AI 代理
 * AI 逻辑统一放在 lib/ai-core.js，与 Vercel 函数 api/ai.js 共用同一套代码。
 * 线上部署到 Vercel 时不会使用本文件。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleAiRequest } = require('./lib/ai-core.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5123;

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

// 前端取 Supabase 连接信息（anon key 本就是公开密钥，但仍只在本机/同源下提供）
function sendSupabaseConfig(req, res) {
  if (!isConfigAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '仅允许本机访问' }));
    return;
  }
  const payload = JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
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

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/api/config') {
    sendSupabaseConfig(req, res);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(AI_ROUTES, pathname)) {
    handleAiRequest(req, res, { type: AI_ROUTES[pathname] || undefined });
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
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`体育教师工作台运行中: http://localhost:${PORT}`);
});
