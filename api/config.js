/**
 * Vercel Serverless Function：Supabase 配置状态
 *
 * 只返回「是否已配置」的布尔值，不下发任何密钥——
 * SUPABASE_URL / SUPABASE_ANON_KEY 只在服务端 process.env 中使用，浏览器拿不到。
 * 环境变量：SUPABASE_URL、SUPABASE_ANON_KEY（可选 SUPABASE_SERVICE_ROLE_KEY）
 */
import supabase from '../lib/supabase.js';

export default function handler(req, res) {
  const configured = Boolean(supabase.isSupabaseConfigured());
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    configured,                    // 统一字段名：前端只读这个布尔值
    supabaseConfigured: configured, // 旧字段，保留兼容
    keySource: configured ? supabase.getConfigSource() : '', // 仅 'anon' / 'service_role' 标记，不含密钥
  });
}
