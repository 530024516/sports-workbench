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

/**
 * ⏱ 读取严格超时（默认 8 秒）。
 * readAllData() 是【串行】逐表查询全部 18 个键：任意一张表挂住，后面的表都得陪着等，
 * 累加起来远超前端 REQUEST_TIMEOUT 的 20 秒 —— 后端绝不能傻等那么久。
 * 写入单独留 30 秒：整份大单元 upsert 比读取慢，套 8 秒会误伤正常保存。
 */
const READ_TIMEOUT_MS = Number(process.env.SUPABASE_READ_TIMEOUT_MS) || 8000;
const WRITE_TIMEOUT_MS = Number(process.env.SUPABASE_WRITE_TIMEOUT_MS) || 30000;
/** 单表耗时超过它就打印「疑似慢表」告警 */
const SLOW_TABLE_MS = Number(process.env.SUPABASE_SLOW_TABLE_MS) || 3000;
/** 单表最大读取行数：0 = 不限制（默认绝不悄悄丢数据）；排障时可配 SUPABASE_READ_LIMIT=200 */
const READ_ROW_LIMIT = Number(process.env.SUPABASE_READ_LIMIT || 0);
/** 超时表自动跳过：默认关闭，避免静默丢数据；配 SUPABASE_AUTO_SKIP_SLOW=1 开启 */
const AUTO_SKIP_SLOW = String(process.env.SUPABASE_AUTO_SKIP_SLOW || '').trim() === '1';
/** 本进程内被判为「超时慢表」而临时跳过的表名（重启进程即重置） */
const autoSkippedTables = new Set();
/**
 * 🌐 断网熔断：断网时 17 张表串行、每张等满 8 秒 = 136 秒，会把整个请求和 Node 进程拖死。
 * 连续 2 张表超时 / 总耗时超过 12 秒，就判定「数据库整体不可达」：
 * 剩余表直接跳过并记入 errors，让后端立刻快速失败，前端安静用本地缓存。
 */
const READ_TOTAL_BUDGET_MS = Number(process.env.SUPABASE_READ_TOTAL_BUDGET_MS) || 12000;
const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** 显式跳过名单：SUPABASE_SKIP_TABLES=offline_resources,fitness_records（表名或存储键都认） */
function skippedTables() {
  return new Set(String(process.env.SUPABASE_SKIP_TABLES || '')
    .split(',').map(item => item.trim()).filter(Boolean));
}

/**
 * 给 supabase-js 的底层 fetch 装超时：GET/HEAD 8 秒、写操作 30 秒。
 * 用 AbortController 真正掐断连接，而不是只在 JS 层 Promise.race 假装超时 ——
 * 后者会留一个挂死的 socket，Node 进程照样被拖住。
 */
function createTimeoutFetch() {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== 'function' || typeof AbortController === 'undefined') return undefined;
  return (input, init = {}) => {
    if (init?.signal) return nativeFetch(input, init);   // 调用方自带 signal，尊重它
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const timeout = method === 'GET' || method === 'HEAD' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let request;
    try {
      request = nativeFetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    return Promise.resolve(request).finally(() => clearTimeout(timer));
  };
}

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
  const timeoutFetch = createTimeoutFetch();
  /* 连接策略：supabase-js 的 PostgREST 请求【不自动重试】，这里也没有包任何重试循环；
     不启用 realtime（断网时长连接会反复重连），auth 也关掉自动刷新 token。
     所以「网络不好时无限套娃」不来自客户端重试，而来自 readAllData 串行 17 表 × 8 秒，
     由下面的总预算 + 连续超时熔断兜住。 */
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(timeoutFetch ? { global: { fetch: timeoutFetch } } : {}),
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
 * 这样表里多一列也不会让前端报错 —— 但「完整 10 模块」永远是 modules_json。
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
 * 空载荷错误：调用方想把某张业务表"清空"，但没有带明确的清空意图。
 * ⛔ 这是「手机端刷新 → 云端教案凭空消失」的最后一道闸门：
 *    空数组（多半是某个页面的内存快照是空的）绝不允许被当成"清空指令"写进云端。
 *    只有用户在界面上亲手清空（clearIntent: true）才允许。
 */
class EmptyPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmptyPayloadError';
    this.status = 400;
    this.code = 'EMPTY_PAYLOAD_REFUSED';
  }
}

/** 判断一个值是不是"空载荷"（空数组 / 空对象 / null） */
function isEmptyPayload(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * 集合型表（数组 / 对象映射）的整表写入。
 *
 * ⛔ 绝对锁（最高优先级）：payload 是空数组时【直接抛错中断】——
 *    一个字节都不许写，更不许删。只有明确收到 clearIntent: true（用户亲手清空）才放行。
 *    以前这里会"按这次没带的旧行"去删（整表替换语义），
 *    结果手机端拿着旧快照推上来时，把电脑端刚写进去的新教案当成旧行删掉 ——
 *    这就是"空数据自杀式覆盖"的真凶。现在改成【只删客户端点名要删的 id】。
 *
 * 写入流程：
 *   ① 空载荷 → 抛错中断（除非 clearIntent）
 *   ② 先 upsert（onConflict: 'id'，同 id 覆盖而不是报错，写入幂等）
 *   ③ 只按【deletedIds】精准删除（逐 id 删，绝不 DELETE 全表）
 *   ④ 并发保护：比我这份快照还新的行（别人在我之后写的）一个都不许删
 */
async function writeCollectionRows(client, tableName, payload, options = {}) {
  const table = client.from(tableName);
  const ids = payload.map(row => row.id);

  /* ⛔ 绝对锁：空载荷直接中断 —— 不 upsert、不 delete、不做任何事。 */
  if (!payload.length && !options.clear) {
    throw new EmptyPayloadError(
      `拒绝写入空数据：${tableName}。`
      + '只有明确收到 clearIntent: true（用户在界面上亲手清空）才允许清空这张表。',
    );
  }

  // ① 先把数据安全写进去（幂等）
  if (payload.length) {
    const { error: upsertError } = await table.upsert(payload, { onConflict: 'id' });
    if (upsertError) throw upsertError;
  }

  // ② 用户亲手清空：把该表的行按【id 列表】删光（仍然不是 DELETE 全表）
  if (options.clear) {
    const { data: existing, error: selectError } = await table.select('id');
    if (selectError) throw selectError;
    const all = (existing || []).map(row => row.id);
    for (const chunk of chunkList(all, 50)) {
      const { error: deleteError } = await table.delete().in('id', chunk);
      if (deleteError) throw deleteError;
    }
    return { written: payload.length, removed: all.length, keptConcurrent: 0 };
  }

  /* ③ 只删"客户端点名要删"的 id（deletedIds）—— 绝不推断、绝不整表替换。
     为什么必须显式：手机端拿着旧快照推上来时，按"这次没带的旧行"去删，
     就会把电脑端刚写进去的新教案当成旧行删掉 —— 旧快照再也伤不到新数据。 */
  const requested = Array.isArray(options.deletedIds)
    ? [...new Set(options.deletedIds.map(id => String(id ?? '')).filter(Boolean))]
    : [];
  if (!requested.length) {
    return { written: payload.length, removed: 0, keptConcurrent: 0 };
  }
  const { data: existing, error: selectError } = await table.select('id, updated_at');
  if (selectError) throw selectError;
  const reference = options.reference || options.now || new Date().toISOString();
  const targets = new Set(requested);
  const rows = (existing || []).filter(row => targets.has(String(row.id)));
  // ④ 并发保护：比我这份快照还新的行（别人在我之后写的）一个都不许删
  const deletable = rows.filter(row => !row?.updated_at || row.updated_at <= reference);
  const keptConcurrent = rows.length - deletable.length;
  for (const chunk of chunkList(deletable.map(row => row.id), 50)) {
    const { error: deleteError } = await table.delete().in('id', chunk);
    if (deleteError) throw deleteError;
  }
  return { written: payload.length, removed: deletable.length, keptConcurrent };
}

/** 兜底超时：即使注入的 fetch 没生效（或注入的假 client 永远不返回），8 秒也一定抛错 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} 超过 ${ms}ms，已放弃本次读取（本地缓存继续可用）`);
      error.name = 'SupabaseReadTimeout';
      error.code = 'SUPABASE_READ_TIMEOUT';
      error.status = 504;
      reject(error);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 读取单个键：具名列型 / 数组集合 / 对象集合 / 单例（一律带 8 秒硬超时） */
async function readKey(client, key, config) {
  const label = `读取表 ${config.table}（${key}）`;
  const run = async () => {
    // 具名列型：整行就是一个业务对象（离线资源库），不再是 { id, data } 的通用包装
    if (config.rowShaped) {
      let query = client
        .from(config.table)
        .select('*')
        .order('created_at', { ascending: false });
      /* offline_resources 每行都带完整的 modules_json（10 模块 × 18 课时），
         全表 select('*') 最容易把 GET 拖垮。配 SUPABASE_READ_LIMIT=200 可限条数。 */
      if (READ_ROW_LIMIT > 0 && typeof query.limit === 'function') query = query.limit(READ_ROW_LIMIT);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(row => normalizeRow(row));
    }

    let query = config.singleton
      ? client.from(config.table).select('data').eq('id', key).maybeSingle()
      : client.from(config.table).select('data').order('ord', { ascending: true });
    if (!config.singleton && READ_ROW_LIMIT > 0 && typeof query.limit === 'function') {
      query = query.limit(READ_ROW_LIMIT);
    }
    const { data, error } = await query;
    if (error) throw error;

    if (config.singleton) return data?.data ?? null;
    if (config.objectMap) {
      const mapped = {};
      (data || []).forEach(row => { mapped[row.data?.date || row.id] = row.data; });
      return mapped;
    }
    return (data || []).map(row => row.data);
  };
  return withTimeout(run(), READ_TIMEOUT_MS, label);
}

/**
 * 读取全部键（串行逐表 + 逐表计时 + 逐表容错 / 逐表跳过）
 * 逐表容错：某张表结构不对（例如缺 data 列）或超时时，只让该键为空并记入 errors，
 * 不影响其他表；前端会把 errors 里的键当成「没读到」，一律保留本地缓存。
 * ⚠️ 这里是 for 串行，不是 Promise.all —— 所以任何一张慢表都会把总耗时直接累加。
 */
async function readAllData() {
  const client = getSupabaseClient();
  if (!client) return null;
  const data = {};
  const errors = [];
  const skip = skippedTables();
  const totalStarted = Date.now();
  const total = Object.keys(STORE_SCHEMA).length;
  let consecutiveTimeouts = 0;
  let circuitOpen = false;
  const quickSkip = (key, config, message) => {
    data[key] = null;
    errors.push({ key, table: config.table, message, skipped: true, circuitOpen: true });
  };
  for (const [key, config] of Object.entries(STORE_SCHEMA)) {
    /* 🌐 熔断：判定网络断开后，剩余表不再逐张等满 8 秒，直接快速跳过 */
    if (circuitOpen) {
      quickSkip(key, config, '数据库不可达，已快速跳过（断网熔断）');
      continue;
    }
    if (Date.now() - totalStarted > READ_TOTAL_BUDGET_MS) {
      circuitOpen = true;
      console.warn(`[Supabase] ⛔ 读取总耗时超过 ${READ_TOTAL_BUDGET_MS}ms，判定数据库不可达；`
        + '剩余表全部快速跳过（避免断网时 17 表 × 8 秒套娃）');
      quickSkip(key, config, '读取总预算耗尽，已快速跳过');
      continue;
    }
    /* 慢表 / 脏数据表的「暂时跳过」：
       显式配 SUPABASE_SKIP_TABLES，或 SUPABASE_AUTO_SKIP_SLOW=1 时本进程已超时的表。
       跳过的键记入 errors → 前端 _applyCloud 的 failedKeys 会保留本地缓存，绝不覆盖。 */
    if (skip.has(config.table) || skip.has(key) || autoSkippedTables.has(config.table)) {
      data[key] = null;
      errors.push({ key, table: config.table, message: '已暂时跳过（疑似慢表/脏数据），本次使用本地缓存', skipped: true });
      console.warn(`[Supabase] 读取表 ${config.table}（${key}）已暂时跳过：疑似慢表，前端会保留本地缓存`);
      continue;
    }
    const started = Date.now();
    try {
      data[key] = await readKey(client, key, config);
      const cost = Date.now() - started;
      consecutiveTimeouts = 0;
      console.log(`[Supabase] 读取表 ${config.table}（${key}）耗时 ${cost} ms`);
      if (cost >= SLOW_TABLE_MS) {
        console.warn(`[Supabase] ⚠️ 表 ${config.table}（${key}）偏慢（${cost} ms ≥ ${SLOW_TABLE_MS} ms）。`
          + ` 若是脏数据堆积，可在 .env.local 配 SUPABASE_SKIP_TABLES=${config.table} 暂时跳过，`
          + ' 或 SUPABASE_READ_LIMIT=200 限制拉取条数');
      }
    } catch (error) {
      const cost = Date.now() - started;
      const message = error?.message || String(error);
      /* 两种超时路径都算：底层 fetch 先 abort（Supabase 抛 AbortError），
         或 withTimeout 兜底先触发（SUPABASE_READ_TIMEOUT）。 */
      const timedOut = error?.code === 'SUPABASE_READ_TIMEOUT'
        || error?.name === 'AbortError'
        || /abort|timeout|超时|fetch failed|不可达/i.test(message);
      data[key] = null;
      errors.push({ key, table: config.table, message, costMs: cost, timedOut });
      console.warn(`[Supabase] 读取表 ${config.table}（${key}）失败，耗时 ${cost} ms：${message}`);
      if (timedOut) {
        consecutiveTimeouts += 1;
        if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          circuitOpen = true;
          console.warn(`[Supabase] ⛔ 连续 ${consecutiveTimeouts} 张表超时（fetch failed / ${READ_TIMEOUT_MS}ms），`
            + '判定网络断开；剩余表快速跳过，后端立刻返回，前端安静回退本地缓存');
        }
      } else {
        consecutiveTimeouts = 0;
      }
      if (AUTO_SKIP_SLOW && timedOut) {
        autoSkippedTables.add(config.table);
        console.warn(`[Supabase] ⏭ ${config.table} 已加入本进程临时跳过名单，后续 GET 不再等它（重启服务可重置）`);
      }
    }
  }
  console.log(`[Supabase] 全部表读取完成，总耗时 ${Date.now() - totalStarted} ms`
    + `（成功 ${total - errors.length}/${total}，失败/跳过 ${errors.length}）`);
  // 全部失败 = 数据库整体不可用（连不上/密钥错），必须让上层报错并回退本地，
  // 否则前端会把"读不到"误认为"云端是空的"
  if (errors.length === total) {
    throw new Error(errors[0].message);
  }
  return { data, errors };
}

/**
 * 写入单个键：单例 upsert；集合"先 upsert 后删旧行"（保证顺序与删除生效，且绝不写空表）
 * @param {string} key
 * @param {*} value
 * @param {{clear?: boolean, client?: object}} options clear=true 表示"用户在界面上亲手清空"，允许把该表清空
 *        client 为可选的客户端注入点（回归测试用假客户端跑完整写入链路）
 * @throws {EmptyPayloadError} 收到空载荷且没有明确清空意图时抛 400 —— 绝不把空快照写进云端
 */
async function writeData(key, value, options = {}) {
  const client = options.client || getSupabaseClient();
  if (!client) throw new Error('Supabase 未配置：缺少 SUPABASE_URL / SUPABASE_ANON_KEY');

  const config = STORE_SCHEMA[key];
  if (!config) throw new Error(`未知的存储键：${key}`);
  const now = new Date().toISOString();
  const clearIntent = options.clear === true;
  // 并发判定基准：优先用客户端给的 snapshotAt（这份本地快照是什么时候生成的）
  const reference = options.snapshotAt || now;

  /* ⛔ 绝对防线：空载荷一律拒绝（除非调用方明确声明"用户亲手清空"）。
     这条挡的就是「手机端刷新 → 本地空快照被当成清空指令 → 云端教案凭空消失」。
     抛 EmptyPayloadError（400），让调用方知道"这次没写进去"，而不是静默把云端洗成 0 条。 */
  if (!clearIntent && isEmptyPayload(value)) {
    throw new EmptyPayloadError(
      `拒绝写入空数据：${key}（${config.label}）。`
      + '只有用户在界面上亲手清空（clearIntent: true）才允许把云端这张表清空。',
    );
  }

  /* 具名列型（离线资源库）：一行 = 一个资源，字段直接是业务列。
     同样改成"先 upsert 再删旧行"，否则"删成功、写失败"会把整张资源表清空。 */
  if (config.rowShaped) {
    const rows = buildRowShapedRows(value, now);
    const result = await writeCollectionRows(client, config.table, rows, { ...options, clear: clearIntent, now, reference });
    return { key, table: config.table, count: rows.length, ...result };
  }

  if (config.singleton) {
    // 传入 null 表示清空该设置（删行），避免写入违反 data not null 约束的空值
    if (value === null || value === undefined) {
      // 上面的空载荷防线已经拦住了"没有清空意图"的 null；走到这里说明是用户明确要清空
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

  const result = await writeCollectionRows(client, config.table, payload, { ...options, clear: clearIntent, now, reference });
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
      // 空载荷被拒：这不是"迁移失败"，而是"这一项本地本来就没有，别去动云端"
      if (error?.code === 'EMPTY_PAYLOAD_REFUSED') {
        report.push({ key, status: 'skipped-empty', count: 0, message: error.message });
        continue;
      }
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
  // 空载荷防线
  EmptyPayloadError,
  isEmptyPayload,
  // 读取超时 / 逐表耗时排障（导出便于回归测试驱动假 client）
  READ_TIMEOUT_MS,
  SLOW_TABLE_MS,
  READ_ROW_LIMIT,
  READ_TOTAL_BUDGET_MS,
  MAX_CONSECUTIVE_TIMEOUTS,
  readKey,
  withTimeout,
  createTimeoutFetch,
};
