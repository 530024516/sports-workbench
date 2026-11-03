import core from '../lib/ai-core.js';
import adminAuth from '../lib/admin-auth.js';

/**
 * Vercel Serverless Function：统一 AI 入口
 * 前端统一请求 /api/ai，通过 req.body.type 区分业务类型：
 *   - lesson  ：教案生成 / 续写
 *   - unit    ：大单元教学设计
 *   - fitness ：健身训练计划
 * 所有类型均开启 stream: true，并以 SSE（text/event-stream）流式回写给前端。
 *
 * ⛔ 权限闸门：AI 生成属于写操作（消耗额度 + 结果写库），游客一律 403。
 */
export default async function handler(req, res) {
  if (!adminAuth.requireAdmin(req, res)) return;
  await core.handleAiRequest(req, res);
}
