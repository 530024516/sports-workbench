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

/**
 * 请求体上限：与本地 server.js / lib/data-api.js 一致，10MB。
 * ⚠️ Vercel 平台自身还有一层更严的硬限制（约 4.5MB，Serverless Function 请求体），
 *    代码无法绕过 —— 所以前端在 4MB 就主动拦截并提示，绝不把大载荷发到这里被平台掐断。
 *    本函数不设任何「读到一半主动断开」的逻辑：超限由 lib/data-api.js 回明确 413。
 */
const DATA_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** 大 payload 写 Supabase 需要更长时间：30s 容易在写库途中被平台掐成 502 */
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!adminAuth.requireAdmin(req, res)) return;
  await dataApi.handleDataRequest(req, res, { maxBodyBytes: DATA_MAX_BODY_BYTES });
}
