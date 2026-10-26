import dataApi from '../lib/data-api.js';

/**
 * Vercel Serverless Function：统一数据读写
 * 与本地 server.js 共用 lib/data-api.js，因此共用同一套 Supabase 客户端配置
 * （SUPABASE_URL / SUPABASE_ANON_KEY 在 Vercel 项目环境变量中配置）。
 */
export default async function handler(req, res) {
  await dataApi.handleDataRequest(req, res);
}
