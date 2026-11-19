/**
 * 管理员登录接口（/api/admin）
 *
 * 本地 node server.js 与 Vercel Serverless Function（api/admin.js）共用同一份实现。
 *
 *   GET  /api/admin              → { adminConfigured: boolean }（前端用来提示"服务端还没配密码"）
 *   POST /api/admin { password } → 校验密码：ok=true / 403 密码错误
 *
 * ⚠️ 这个接口本身就是"门"，所以它【不】受 requireAdmin 保护
 *    （否则永远无法登录）。它只做一件事：验证密码。
 */
const {
  isAdminConfigured, verifyPassword, sendJson,
  isPublicConfigured, verifyPublicPassword,
} = require('./admin-auth.js');

/** 本地原始流 / Vercel 预解析 body 都支持 */
async function readJsonBody(req) {
  if (req?.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {});
      } catch {
        reject(new Error('请求必须是有效 JSON'));
      }
    });
  });
}

async function handleAdminRequest(req, res) {
  const method = String(req?.method || 'GET').toUpperCase();

  if (method === 'GET' || method === 'HEAD') {
    sendJson(res, 200, { ok: true, adminConfigured: isAdminConfigured() });
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { error: '仅支持 GET / POST 请求' });
    return;
  }

  // 读取请求体（Vercel 预解析 / 本地原始流，两种都支持）
  let body = {};
  try {
    if (req.body && typeof req.body === 'object') {
      body = req.body;
    } else {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('error', reject);
        req.on('end', () => {
          try {
            resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {});
          } catch {
            reject(new Error('请求必须是有效 JSON'));
          }
        });
      });
    }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error?.message || '请求体解析失败' });
    return;
  }

  const result = verifyPassword(body?.password, req);
  if (result.ok) {
    console.log('[auth] ✅ 管理员密码校验通过');
    sendJson(res, 200, { ok: true });
    return;
  }
  console.warn(`[auth] ⛔ 管理员密码校验失败：${result.reason}`);
  sendJson(res, 403, { ok: false, error: result.reason || '密码错误' });
}

/**
 * 公开离线版登录（/api/public-auth）
 *
 *   POST { password } → 匹配 PUBLIC_PASSWORD_LOCAL 时回 { mode:'local' }；
 *                       匹配 PUBLIC_PASSWORD_AI 时额外回一张 12h 有效的 JWT（role=ai_guest）。
 *   本地密码【永远】拿不到票，也就无法调用 /api/ai —— 这是防滥用的服务端底线。
 *   JWT 是无状态的：后端重启 / 多实例 / Vercel 冷启动后，旧票照样有效，直到 exp 到期。
 */
async function handlePublicAuthRequest(req, res) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    sendJson(res, 200, { ok: true, publicConfigured: isPublicConfigured() });
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 GET / POST 请求' });
    return;
  }
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error?.message || '请求体解析失败' });
    return;
  }
  const result = verifyPublicPassword(body?.password, req);
  if (!result.ok) {
    console.warn(`[auth] ⛔ 公开版登录失败：${result.reason}`);
    sendJson(res, 403, { ok: false, code: 'PUBLIC_AUTH_INVALID', error: result.reason });
    return;
  }
  /* 密码对了但没签出票 = 服务端缺 JWT_SECRET，明确报配置问题，别误报成密码错 */
  if (result.mode === 'ai' && !result.token) {
    console.warn('[auth] ⛔ AI 体验票签发失败：服务端未配置 JWT_SECRET');
    sendJson(res, 503, {
      ok: false,
      code: 'JWT_SECRET_MISSING',
      error: result.reason || '服务端未配置 JWT_SECRET，请在 .env.local 或 Vercel 环境变量中配置',
    });
    return;
  }
  console.log(`[auth] ✅ 公开版登录成功：${result.mode === 'ai' ? 'AI 体验（JWT 12h）' : '纯本地'}模式`);
  sendJson(res, 200, {
    ok: true,
    mode: result.mode,
    token: result.token || '',
    isLocalMode: true,
    canUseAI: result.mode === 'ai',
  });
}

module.exports = { handleAdminRequest, handlePublicAuthRequest };
