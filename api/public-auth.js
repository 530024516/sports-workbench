import core from '../lib/admin-core.js';

/**
 * Vercel Serverless Function：公开离线版双密码登录
 *   POST /api/public-auth { password }
 *     → { mode:'local' } 或 { mode:'ai', token }
 *
 * 本地密码永远拿不到 AI token；AI token 只放行 AI 路由，不能碰 /api/data。
 */
export default async function handler(req, res) {
  await core.handlePublicAuthRequest(req, res);
}
