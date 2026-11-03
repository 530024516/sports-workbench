import core from '../lib/admin-core.js';

/**
 * Vercel Serverless Function：管理员登录校验
 *   POST /api/admin { password } → { ok: true } 或 403 密码错误
 *
 * 这个接口本身是"门"，不受写操作闸门限制（否则永远无法登录）。
 */
export default async function handler(req, res) {
  await core.handleAdminRequest(req, res);
}
