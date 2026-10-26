/**
 * Vercel Serverless Function：向前端下发 Supabase 连接信息
 * 环境变量：SUPABASE_URL、SUPABASE_ANON_KEY（在 Vercel 项目设置中配置）
 * anon key 是设计为可公开的密钥，真正的保护依赖 Supabase 的 RLS 策略。
 */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
}
