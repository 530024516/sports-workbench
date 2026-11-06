/**
 * 统一数据接口 /api/data（Node 风格 handler，本地 server.js 与 Vercel api/data.js 共用）
 *
 * GET  /api/data            → { mode: 'supabase', data: { 键名: 值 } }  （未配置时 mode: 'local'）
 * GET  /api/data?op=schema  → { mode, configured, keys: [{ key, table, label, ... }] }
 * GET  /api/data?op=inspect&key=… → { exists, bytes, filledCount, filledFields, preview }（排障：库里到底有没有数据）
 * POST /api/data            → body: { key, value } 或 { values: { 键名: 值 } }（批量，迁移用）
 *                             或 { op: 'purge', scope: 'meet' }（一键清空本次运动会，按表 DELETE）
 */
const supabase = require('./supabase.js');
const { STORE_SCHEMA, MEET_DATA_KEYS } = require('./store-schema.js');
const { requireAdmin } = require('./admin-auth.js');

/**
 * /api/data 请求体上限：10MB。
 * 大单元 10 个模块 + 18 个课时的整份资源库列表是「一份 value」，
 * 以前 8MB 且超限直接 req.destroy() 掐断 socket —— 浏览器/网关看到的就是 502 Bad Gateway，
 * 连续 3 次写失败还会把 Store 熔断。现在放宽到 10MB，并且超限回明确 413，不再掐连接。
 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 体积超限：明确 413，绝不掐断 socket（掐断会被浏览器/网关报成 502） */
function bodyTooLargeError(bytes, maxBodyBytes) {
  const error = new Error(`请求内容过大（${(bytes / 1024 / 1024).toFixed(1)}MB，上限 ${(maxBodyBytes / 1024 / 1024).toFixed(0)}MB）`);
  error.status = 413;
  error.code = 'PAYLOAD_TOO_LARGE';
  return error;
}

// Vercel 会预解析 req.body；本地 node 走原始流。两条路径都要量体积。
function readJsonBody(req, maxBodyBytes = MAX_BODY_BYTES) {
  if (req.body && typeof req.body === 'object') {
    const bytes = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
    if (bytes > maxBodyBytes) return Promise.reject(bodyTooLargeError(bytes, maxBodyBytes));
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string') {
    const bytes = Buffer.byteLength(req.body, 'utf8');
    if (bytes > maxBodyBytes) return Promise.reject(bodyTooLargeError(bytes, maxBodyBytes));
    return Promise.resolve(JSON.parse(req.body || '{}'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > maxBodyBytes) {
        // ⚠️ 不要 req.destroy()：那是 502 的直接来源。继续把流读完，再统一回 413。
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('error', error => reject(error));
    req.on('end', () => {
      if (tooLarge) {
        reject(bodyTooLargeError(received, maxBodyBytes));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('请求必须是有效 JSON'));
      }
    });
  });
}

function describeSchema() {
  return Object.entries(STORE_SCHEMA).map(([key, config]) => ({
    key,
    table: config.table,
    label: config.label,
    singleton: Boolean(config.singleton),
    objectMap: Boolean(config.objectMap),
    rowShaped: Boolean(config.rowShaped),
  }));
}

/**
 * 清空意图（clearIntent）：只有用户在界面上亲手清空时才为 true。
 * 两个名字都认（clear / clearIntent），方便前端与旧脚本都能表达同一个意思。
 * ⚠️ 除此之外的一切"空"都不算清空意图 —— 那多半是某个页面的内存快照是空的。
 */
function hasClearIntent(body = {}) {
  return body.clear === true || body.clearIntent === true;
}

/**
 * 客户端点名要删的 id 列表（可选）。
 * 服务端【只】删这些 id —— 不再按"这次 payload 里没带的"去推断旧行。
 * 这是"旧快照把新数据当旧行删掉"这场灾难的根治点。
 */
function readDeletedIds(body = {}) {
  if (!Array.isArray(body.deletedIds)) return [];
  return body.deletedIds.map(id => String(id ?? '')).filter(Boolean).slice(0, 2000);
}

async function handleDataRequest(req, res, options = {}) {
  const method = (req.method || 'GET').toUpperCase();
  const configured = supabase.isSupabaseConfigured();
  // 本地 server.js 与 Vercel api/data.js 都可显式传入；不传时用 10MB 默认值
  const maxBodyBytes = Number(options.maxBodyBytes) || MAX_BODY_BYTES;

  /* ⛔ 权限闸门（安全底线）：读放行，写必须带管理员密码。
     本地 server.js 与 Vercel api/data.js 共用这段逻辑，一处生效两处都拦得住。 */
  if (!requireAdmin(req, res)) return;

  try {
    if (method === 'GET') {
      const pathname = (req.url || '/').split('?')[0];
      const query = (req.url || '').includes('?') ? req.url.split('?')[1] : '';
      const op = new URLSearchParams(query).get('op') || '';
      if (op === 'schema') {
        sendJson(res, 200, {
          mode: configured ? 'supabase' : 'local',
          configured,
          keySource: supabase.getConfigSource(),
          keys: describeSchema(),
        });
        return;
      }
      /* 🔎 排障：GET /api/data?op=inspect&key=pe_big_unit_design_v1
         POST 回 ok:true 但页面没数据时，用这个直接看库里那一行有没有、是不是空壳。
         例如：
           exists:true, filledCount:0  → 行在，但存的是 10 模块全空的空壳（本次事故）
           exists:false                → 表里根本没有这一行
         filledCount>0 且页面仍空      → 问题在前端读取 / 视图优先级锁 */
      if (op === 'inspect') {
        const key = new URLSearchParams(query).get('key') || '';
        if (!key || !Object.prototype.hasOwnProperty.call(STORE_SCHEMA, key)) {
          sendJson(res, 400, { error: `请提供有效的 key（可选值见 /api/data?op=schema），收到：${key || '(空)'}` });
          return;
        }
        if (!configured) {
          sendJson(res, 200, { mode: 'local', configured: false, key, exists: false, hint: '服务端未配置 Supabase，读不到云端数据' });
          return;
        }
        sendJson(res, 200, { mode: 'supabase', configured: true, ...(await supabase.inspectKey(key)) });
        return;
      }
      if (!configured) {
        sendJson(res, 200, { mode: 'local', configured: false, data: null });
        return;
      }
      const result = await supabase.readAllData();
      // 同时下发键 → 表映射，前端据此判断单例/对象型（迁移页与清空逻辑要用）
      // errors：个别表结构异常时回传，前端提示具体是哪张表，而不是整页空白
      sendJson(res, 200, {
        mode: 'supabase',
        configured: true,
        data: result.data,
        errors: result.errors,
        keys: describeSchema(),
      });
      return;
    }

    if (method === 'POST') {
      if (!configured) {
        sendJson(res, 503, { error: 'Supabase 未配置：请在环境变量中设置 SUPABASE_URL 与 SUPABASE_ANON_KEY' });
        return;
      }
      const body = await readJsonBody(req, maxBodyBytes);

      // 一键清空本次运动会：服务端按表 DELETE，比前端逐个写 null 更彻底
      if (body.op === 'purge' && body.scope === 'meet') {
        const keys = Array.isArray(body.keys) && body.keys.length
          ? body.keys.filter(key => key in STORE_SCHEMA)
          : MEET_DATA_KEYS;
        const report = await supabase.purgeMeetData(keys);
        sendJson(res, 200, { mode: 'supabase', ok: true, scope: 'meet', report });
        return;
      }
      if (body.values && typeof body.values === 'object') {
        const report = await supabase.writeMany(body.values, {
          clear: hasClearIntent(body),
          snapshotAt: typeof body.snapshotAt === 'string' ? body.snapshotAt : undefined,
          deletedIds: readDeletedIds(body),
        });
        sendJson(res, 200, { mode: 'supabase', ok: true, report });
        return;
      }
      if (typeof body.key === 'string' && Object.prototype.hasOwnProperty.call(body, 'value')) {
        // clearIntent=true：调用方明确说"用户在界面上亲手清空"，服务端才允许把该表清空。
        // 没有它却传来空数组 → 服务端直接 400 拒绝（绝不让空快照把云端洗成 0 条）
        // snapshotAt：客户端本地快照的生成时间 —— 并发写入时用它判断"哪些行比我新"
        // deletedIds：客户端点名要删的 id —— 服务端只删这些，绝不按"这次没带的"去推断
        const result = await supabase.writeData(body.key, body.value, {
          clear: hasClearIntent(body),
          snapshotAt: typeof body.snapshotAt === 'string' ? body.snapshotAt : undefined,
          deletedIds: readDeletedIds(body),
        });
        sendJson(res, 200, { mode: 'supabase', ok: true, report: [{ ...result, status: 'ok' }] });
        return;
      }
      sendJson(res, 400, { error: '请求体需为 { key, value } 或 { values: { ... } }' });
      return;
    }

    sendJson(res, 405, { error: '仅支持 GET / POST' });
  } catch (error) {
    const message = error?.message || String(error);
    /* 打印真实栈：502 究竟是写 Supabase 超时、主键/字段类型冲突，还是响应流已断，
       以前只有一句 message，前端只剩 502 + signal is aborted，无从定位。 */
    console.error('[api/data] 处理失败', message, '\n', error?.stack || '');
    if (!res.headersSent) {
      /* ⛔ 空载荷被拒（400）：这不是"服务器坏了"，而是"这次请求不该发生"。
         绝不能返回 5xx —— 前端会把 5xx 当成"写失败"从而无限重试，
         而空载荷重试一万次也还是空，只会把请求队列刷满。
         返回 400 让前端立刻停止重试，并把本地数据原样留住。 */
      /* 体积超限是「这次请求没发出去」，不是服务器坏了：回 413 + 明确指引，
         别回 502 —— 前端会把 502 当写失败无限重试，3 次就把这个键熔断了。 */
      if (error?.status === 413 || error?.code === 'PAYLOAD_TOO_LARGE') {
        sendJson(res, 413, {
          error: message,
          code: 'PAYLOAD_TOO_LARGE',
          hint: `本次数据超过 ${(maxBodyBytes / 1024 / 1024).toFixed(0)}MB 未写入云端；本地数据完好保留。请精简资源库后重试，或在控制台执行 Store.retryFailedKeys()。`,
        });
        return;
      }
      if (error?.status === 400 || error?.code === 'EMPTY_PAYLOAD_REFUSED') {
        sendJson(res, 400, {
          error: message,
          code: 'EMPTY_PAYLOAD_REFUSED',
          hint: '空数据写入已被拒绝：云端数据未被改动。只有用户在界面上亲手清空（clearIntent: true）才会清空某张表。',
        });
        return;
      }
      // ⛔ 5xx 的语义是"这次写入没成功" —— 前端必须把本地数据原样留住，绝不能拿云端的旧值/空值覆盖本地
      sendJson(res, 502, {
        error: `读写 Supabase 失败：${message}`,
        hint: '本次写入未生效，本地数据已保留；请检查 Supabase 表结构与数据后再重试',
      });
    } else if (!res.writableEnded) res.end();
  }
}

module.exports = { handleDataRequest, MAX_BODY_BYTES };
