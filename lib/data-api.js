/**
 * 统一数据接口 /api/data（Node 风格 handler，本地 server.js 与 Vercel api/data.js 共用）
 *
 * GET  /api/data            → { mode: 'supabase', data: { 键名: 值 } }  （未配置时 mode: 'local'）
 * GET  /api/data?op=schema  → { mode, configured, keys: [{ key, table, label, ... }] }
 * POST /api/data            → body: { key, value } 或 { values: { 键名: 值 } }（批量，迁移用）
 */
const supabase = require('./supabase.js');
const { STORE_SCHEMA } = require('./store-schema.js');

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Vercel 会预解析 req.body；本地 node 走原始流
function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string') {
    return Promise.resolve(JSON.parse(req.body || '{}'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', error => reject(error));
    req.on('end', () => {
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
  }));
}

async function handleDataRequest(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  const configured = supabase.isSupabaseConfigured();

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
      const body = await readJsonBody(req);

      if (body.values && typeof body.values === 'object') {
        const report = await supabase.writeMany(body.values);
        sendJson(res, 200, { mode: 'supabase', ok: true, report });
        return;
      }
      if (typeof body.key === 'string' && Object.prototype.hasOwnProperty.call(body, 'value')) {
        const result = await supabase.writeData(body.key, body.value);
        sendJson(res, 200, { mode: 'supabase', ok: true, report: [{ ...result, status: 'ok' }] });
        return;
      }
      sendJson(res, 400, { error: '请求体需为 { key, value } 或 { values: { ... } }' });
      return;
    }

    sendJson(res, 405, { error: '仅支持 GET / POST' });
  } catch (error) {
    const message = error?.message || String(error);
    console.error('[api/data] 处理失败', message);
    if (!res.headersSent) sendJson(res, 502, { error: `读写 Supabase 失败：${message}` });
    else if (!res.writableEnded) res.end();
  }
}

module.exports = { handleDataRequest, MAX_BODY_BYTES };
