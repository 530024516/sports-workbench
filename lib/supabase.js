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
const { STORE_SCHEMA, STORE_KEYS, MEET_DATA_KEYS } = require('./store-schema.js');

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

/**
 * 具名列型表的一行 → 前端资源对象。
 * 只挑认识的字面量列出来，其余（将来加的列）原样带上，
 * 这样表里多一列也不会让前端报错 —— 但「完整 11 模块」永远是 modules_json。
 */
function normalizeRow(row) {
  const modules = row?.modules_json ?? {};
  return {
    id: row?.id ?? '',
    category: row?.category ?? '',
    level: row?.level ?? '',
    content: row?.content ?? '',
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
    modules_json: modules,
    ord: row?.ord ?? 0,
  };
}

/**
 * 前端资源数组 → offline_resources 表的一行（具名列型专用）。
 * 抽成纯函数是为了能在回归测试里直接验证「存进库的列名与取值」，
 * 而不是只看代码里有没有写过这些字段。
 * ⚠️ id 为空的行必须丢掉：text 主键为空会让整批 insert 失败，
 *    从而把其它正常资源也一起弄丢（宁可少一行，不可全表写入失败）。
 */
function buildRowShapedRows(value, now = new Date().toISOString()) {
  return (Array.isArray(value) ? value : [])
    // 先丢掉没有 id 的记录，再编号：ord 表示"最终落库顺序"，中间被丢的行不该占号，
    // 否则列表显示时会留下空洞，也让"第几个"失去意义
    .filter(item => String(item?.id ?? ''))
    .map((item, ord) => ({
      id: String(item?.id ?? ''),
      category: item?.category ?? '',
      level: item?.level ?? '',
      content: item?.content ?? '',
      modules_json: item?.modules_json ?? {},
      created_at: item?.created_at || now,
      updated_at: item?.updated_at || now,
      ord,
    }));
}

/** 读取单个键：具名列型 / 数组集合 / 对象集合 / 单例 */
async function readKey(client, key, config) {
  // 具名列型：整行就是一个业务对象（离线资源库），不再是 { id, data } 的通用包装
  if (config.rowShaped) {
    const { data, error } = await client
      .from(config.table)
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(row => normalizeRow(row));
  }

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

  /* 具名列型（离线资源库）：一行 = 一个资源，字段直接是业务列。
     和集合一样走「整表替换」语义，保证删除与排序生效。 */
  if (config.rowShaped) {
    const rows = buildRowShapedRows(value, now);

    const table = client.from(config.table);
    const { error: deleteError } = await table.delete().neq('id', '__keep_none__');
    if (deleteError) throw deleteError;
    if (rows.length) {
      const { error: insertError } = await table.insert(rows);
      if (insertError) throw insertError;
    }
    return { key, table: config.table, count: rows.length };
  }

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

/**
 * 一键清空本次运动会：按存储键定位到行，直接 DELETE（不是写空值，行彻底消失）。
 * 传 null / 未知键会被跳过；report 里逐键回报删了哪张表，便于排障。
 */
async function purgeMeetData(keys = MEET_DATA_KEYS) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase 未配置：缺少 SUPABASE_URL / SUPABASE_ANON_KEY');

  const report = [];
  const wanted = Array.isArray(keys) ? keys : MEET_DATA_KEYS;
  for (const key of wanted) {
    const config = STORE_SCHEMA[key];
    if (!config) {
      report.push({ key, table: '—', status: 'skipped', count: 0 });
      continue;
    }
    try {
      const { error, count } = await client
        .from(config.table)
        .delete({ count: 'exact' })
        .eq('id', key);
      if (error) throw error;
      report.push({ key, table: config.table, status: 'ok', count: count ?? 1 });
    } catch (error) {
      report.push({
        key, table: config.table, status: 'error', count: 0,
        message: error?.message || String(error),
      });
    }
  }
  return report;
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
  MEET_DATA_KEYS,
  isSupabaseConfigured,
  getSupabaseClient,
  getConfigSource,
  readAllData,
  writeData,
  writeMany,
  purgeMeetData,
  // 具名列型（离线资源库）的行映射：导出便于回归测试直接验证列名与取值
  buildRowShapedRows,
  normalizeRow,
};
