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
 * ⛔ 权限闸门：AI 生成属于写操作（消耗额度 + 结果写库），游客一律 403；
 *   只有持有效 AI 体验 JWT（role=ai_guest、12h 内）的公开用户例外，过期票返回 401 TOKEN_EXPIRED。
 */

/**
 * 平台侧最长执行时间：120 秒。
 * 与 lib/ai-core.js 的 AI_TIMEOUT_MS = 120000、本地 server.js、vercel.json 保持一致；
 * 不设（默认 10 秒）或设成 60 秒，都会让平台在模型还没吐完时主动掐断 SSE 流。
 */
export const config = { maxDuration: 120 };

/** AI 上游请求超时（毫秒）：显式 120000，不许任何一层提前断开连接 */
const AI_TIMEOUT_MS = 120000;

export default async function handler(req, res) {
  /* 公开体验票（无状态 JWT，role=ai_guest，12h）只放行 AI 路由；
     过期 / 伪造 → 401 TOKEN_EXPIRED，前端据此清本地状态并提示重新登录。 */
  if (!adminAuth.requireAdmin(req, res, { allowPublicAI: true })) return;
  await core.handleAiRequest(req, res, { timeoutMs: AI_TIMEOUT_MS, allowPublicAI: true });
}
