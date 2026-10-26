/**
 * Vercel Serverless Function：Supabase 配置状态
 * 只返回「是否已配置」，不下发任何密钥——密钥只在服务端 process.env 中使用。
 * 环境变量：SUPABASE_URL、SUPABASE_ANON_KEY（可选 SUPABASE_SERVICE_ROLE_KEY）
 */
import supabase from '../lib/supabase.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    supabaseConfigured: supabase.isSupabaseConfigured(),
    keySource: supabase.getConfigSource(),
  });
}
