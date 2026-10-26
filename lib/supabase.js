/**
 * Supabase 客户端 + 数据读写（服务端专用）
 *
 * 环境变量：
 *   SUPABASE_URL              项目 URL（必填）
 *   SUPABASE_ANON_KEY         anon key（必填，配合 RLS 策略使用）
 *   SUPABASE_SERVICE_ROLE_KEY service_role key（可选，配置后优先使用，可跳过 RLS）
 *
 * 本地 server.js 与 Vercel api/data.js 都通过本模块访问数据库，配置完全一致。
 * 浏览器拿不到 process.env，所以前端只与 /api/data 通信，不直接接触密钥。
 */
const { createClient } = require('@supabase/supabase-js');
const { STORE_SCHEMA, STORE_KEYS } = require('./store-schema.js');

let cachedClient = null;
let cachedKeySource = '';

function readConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  // service_role 优先级更高：本地脚本或需要绕过 RLS 时使用
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  const source = process.env.SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : (process.env.SUPABASE_ANON_KEY ? 'anon' : '');
  return { url, key, source };
}

function isSupabaseConfigured() {
  const { url, key } = readConfig();
  return Boolean(url && key);
}

/** 惰性创建并缓存客户端（环境变量在 serverless 冷启动时读取） */
function getSupabaseClient() {
  const { url, key, source } = readConfig();
  if (!url || !key) return null;
  if (cachedClient && cachedKeySource === `${url}|${key}`) return cachedClient;
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedKeySource = `${url}|${key}`;
  cachedClient.__keySource = source;
  return cachedClient;
}

function getConfigSource() {
  const { source } = readConfig();
  return source;
}

/** 读取单个键：数组集合 / 对象集合 / 单例 */
async function readKey(client, key, config) {
  const query = config.singleton
    ? client.from(config.table).select('data').eq('id', key).maybeSingle()
    : client.from(config.table).select('data').order('ord', { ascending: true });

  const { data, error } = await query;
  if (error) throw error;

  if (config.singleton) return data?.data ?? null;
  if (config.objectMap) {
    const mapped = {};
    (data || []).forEach(row => { mapped[row.data?.date || row.id] = row.data; });
    return mapped;
  }
  return (data || []).map(row => row.data);
}

/**
 * 读取全部键
 * 逐表容错：某张表结构不对（例如缺 data 列）时只让该键为空并记入 errors，
 * 不影响其他表，避免一次故障导致整个工作台读不到数据
 */
async function readAllData() {
  const client = getSupabaseClient();
  if (!client) return null;
  const data = {};
  const errors = [];
  for (const [key, config] of Object.entries(STORE_SCHEMA)) {
    try {
      data[key] = await readKey(client, key, config);
    } catch (error) {
      data[key] = null;
      errors.push({ key, table: config.table, message: error?.message || String(error) });
    }
  }
  // 全部失败 = 数据库整体不可用（连不上/密钥错），必须让上层报错并回退本地，
  // 否则前端会把"读不到"误认为"云端是空的"
  if (errors.length === Object.keys(STORE_SCHEMA).length) {
    throw new Error(errors[0].message);
  }
  return { data, errors };
}

/** 写入单个键：单例 upsert；集合整表替换（保证顺序与删除生效） */
async function writeData(key, value) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase 未配置：缺少 SUPABASE_URL / SUPABASE_ANON_KEY');

  const config = STORE_SCHEMA[key];
  if (!config) throw new Error(`未知的存储键：${key}`);
  const now = new Date().toISOString();

  if (config.singleton) {
    // 传入 null 表示清空该设置（删行），避免写入违反 data not null 约束的空值
    if (value === null || value === undefined) {
      const { error } = await client.from(config.table).delete().eq('id', key);
      if (error) throw error;
      return { key, table: config.table, count: 0 };
    }
    const { error } = await client
      .from(config.table)
      .upsert({ id: key, data: value, ord: 0, updated_at: now }, { onConflict: 'id' });
    if (error) throw error;
    return { key, table: config.table, count: 1 };
  }

  const rows = config.objectMap
    ? Object.entries(value || {}).map(([mapKey, item]) => ({
      id: String(item?.date || mapKey),
      data: { ...(item || {}), date: item?.date || mapKey },
    }))
    : (Array.isArray(value) ? value : []).map(item => ({ id: String(item?.id ?? ''), data: item }));

  const payload = rows
    .filter(row => row.id)
    .map((row, ord) => ({ ...row, ord, updated_at: now }));

  const table = client.from(config.table);
  const { error: deleteError } = await table.delete().neq('id', '__keep_none__');
  if (deleteError) throw deleteError;
  if (payload.length) {
    const { error: insertError } = await table.insert(payload);
    if (insertError) throw insertError;
  }
  return { key, table: config.table, count: payload.length };
}

/** 批量写入（迁移工具用）：返回逐键结果 */
async function writeMany(values = {}) {
  const report = [];
  for (const key of STORE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      report.push({ key, status: 'skipped', count: 0 });
      continue;
    }
    try {
      const result = await writeData(key, values[key]);
      report.push({ key, status: 'ok', count: result.count, table: result.table });
    } catch (error) {
      report.push({ key, status: 'error', count: 0, message: error?.message || String(error) });
    }
  }
  return report;
}

module.exports = {
  STORE_SCHEMA,
  STORE_KEYS,
  isSupabaseConfigured,
  getSupabaseClient,
  getConfigSource,
  readAllData,
  writeData,
  writeMany,
};
