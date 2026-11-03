import dataApi from '../lib/data-api.js';
import adminAuth from '../lib/admin-auth.js';

/**
 * Vercel Serverless Function：统一数据读写
 * 与本地 server.js 共用 lib/data-api.js，因此共用同一套 Supabase 客户端配置
 * （SUPABASE_URL / SUPABASE_ANON_KEY 在 Vercel 项目环境变量中配置）。
 *
 * ⛔ 权限闸门：读放行，写必须带 X-Admin-Password。
 *    lib/data-api.js 里已经拦了一道，这里再显式拦一次 ——
 *    即使将来有人在 lib 里改坏了逻辑，这个入口仍然守得住（纵深防御）。
 */
export default async function handler(req, res) {
  if (!adminAuth.requireAdmin(req, res)) return;
  await dataApi.handleDataRequest(req, res);
}
