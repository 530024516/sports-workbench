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

/**
 * 按 id 去重（同一个 id 只保留最后一条）。
 *
 * ⚠️ 这条是血泪教训：体测"批量导入"是 for 循环里连续调 addFitnessRecord()，
 *    而 id 取的是 `F${Date.now()}` —— 40 条记录落在同一毫秒里，id 全都相同。
 *    服务端一条 INSERT 里有两行同 id → Postgres 整条语句拒绝：
 *    "duplicate key value violates unique constraint fitness_records_pkey" → 502。
 *    去重放在服务端，保证任何来源的数据都不会再触发主键冲突。
 */
function dedupeRowsById(rows) {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const id = String(row?.id ?? '');
    if (!id) return;
    map.set(id, row);          // 同 id 后出现的覆盖先出现的
  });
  return [...map.values()];
}

/** 把数组切成固定大小的块（批量 in 查询用，避免 URL 过长被网关拒绝） */
function chunkList(list, size = 50) {
  const chunks = [];
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));
  return chunks;
}

/**
 * 集合型表（数组 / 对象映射）的整表写入。
 *
 * ⚠️ 以前的写法是【先 DELETE 全表，再 INSERT】—— 这两步不是原子的，
 *    于是踩到了三个致命坑：
 *      ① DELETE 成功、INSERT 失败（主键冲突 / 字段类型不符 / 连接中断）
 *         → 表被清空，而数据一条没写进去（前端还拿到 502 → 继续重试 → 反复洗表）；
 *      ② 同一批数据里有两条同 id → INSERT 整批失败（同上，表被清空）；
 *      ③ 两个请求并发时，先发的那条 INSERT 会把后发的 INSERT 顶成主键冲突。
 *    这就是"上传体测数据 → 云端报 duplicate key → 表空了 → 刷新后本地也被洗掉"的完整链条。
 *
 * 现在改成：
 *   ① 【先 upsert】—— onConflict: 'id'，同 id 覆盖而不是报错，写入幂等；
 *      失败时旧数据原封不动，绝不会"删成功、写失败"把表洗空。
 *   ② 【写成功后再删旧行】—— 只删这次没带的那几行（分批 in 查询，URL 不会爆）。
 *   ③ 空数组且没有清空意图 → 一行都不删（防止把云端洗成 0 条）。
 */
async function writeCollectionRows(client, tableName, payload, options = {}) {
  const table = client.from(tableName);
  const ids = payload.map(row => row.id);

  // ① 先把数据安全写进去（幂等）
  if (payload.length) {
    const { error: upsertError } = await table.upsert(payload, { onConflict: 'id' });
    if (upsertError) throw upsertError;
  }

  // ② 空数据：没有明确"清空"意图时，绝不删云端的行
  //    （前端把空数组推上来，往往是某个页面的内存快照是空的，不是用户要清空）
  if (!payload.length && !options.clear) {
    return { written: 0, removed: 0, skippedClear: true };
  }

  // ③ 再删掉这次没带的旧行（整表替换语义：老师删掉的记录要从云端消失）
  const { data: existing, error: selectError } = await table.select('id');
  if (selectError) throw selectError;
  const keep = new Set(ids);
  const stale = (existing || []).map(row => row.id).filter(id => !keep.has(id));
  for (const chunk of chunkList(stale, 50)) {
    const { error: deleteError } = await table.delete().in('id', chunk);
    if (deleteError) throw deleteError;
  }
  return { written: payload.length, removed: stale.length };
}

/** 读取单个键：具名列型 / 数组集合 / 对象集合 / 单例 */
async function readKey(client, key, config) {  // 具名列型：整行就是一个业务对象（离线资源库），不再是 { id, data } 的通用包装
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

/**
 * 写入单个键：单例 upsert；集合"先 upsert 后删旧行"（保证顺序与删除生效，且绝不写空表）
 * @param {string} key
 * @param {*} value
 * @param {{clear?: boolean}} options clear=true 表示"用户在界面上亲手清空"，允许把该表清空
 */
async function writeData(key, value, options = {}) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase 未配置：缺少 SUPABASE_URL / SUPABASE_ANON_KEY');

  const config = STORE_SCHEMA[key];
  if (!config) throw new Error(`未知的存储键：${key}`);
  const now = new Date().toISOString();

  /* 具名列型（离线资源库）：一行 = 一个资源，字段直接是业务列。
     同样改成"先 upsert 再删旧行"，否则"删成功、写失败"会把整张资源表清空。 */
  if (config.rowShaped) {
    const rows = buildRowShapedRows(value, now);
    const result = await writeCollectionRows(client, config.table, rows, options);
    return { key, table: config.table, count: rows.length, ...result };
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

  // 同 id 去重（批量导入时 id 会撞车 —— 这就是 duplicate key 的源头）
  const deduped = dedupeRowsById(rows);
  const payload = deduped.map((row, ord) => ({ ...row, ord, updated_at: now }));

  const result = await writeCollectionRows(client, config.table, payload, options);
  return { key, table: config.table, count: payload.length, ...result };
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
async function writeMany(values = {}, options = {}) {
  const report = [];
  for (const key of STORE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      report.push({ key, status: 'skipped', count: 0 });
      continue;
    }
    try {
      const result = await writeData(key, values[key], options);
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
  // 写入安全相关：导出便于回归测试直接验证"用的是 upsert、且先写后删"
  dedupeRowsById,
  writeCollectionRows,
  chunkList,
};
