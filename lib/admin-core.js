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
const { isAdminConfigured, verifyPassword, sendJson } = require('./admin-auth.js');

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

module.exports = { handleAdminRequest };
