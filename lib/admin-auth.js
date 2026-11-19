/**
 * 管理员 / 游客 权限校验（服务端唯一权威）
 *
 * 规则：
 *   · GET / HEAD / OPTIONS  → 放行（游客可以看数据）
 *   · POST / PUT / PATCH / DELETE → 必须带请求头 X-Admin-Password，
 *     且与服务端环境变量 ADMIN_PASSWORD 一致，否则一律 403。
 *
 * ⛔ 安全底线（默认拒绝）：
 *   服务端没有配置 ADMIN_PASSWORD 时【谁都不许写】。
 *   宁可把老师自己锁在门外，也绝不能让"忘了配密码"变成"任何人都能改数据"。
 *   这时会返回一条能看懂的错误信息，方便一眼定位。
 *
 * 密码比较用 crypto.timingSafeEqual（定长比较），
 * 避免"按返回时间猜密码"的时序侧信道。
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ADMIN_HEADER = 'x-admin-password';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// 登录校验的失败次数上限：同一 IP 连错 5 次就锁 10 分钟（防暴力破解）
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

/* ---------- 公开离线版双密码（无状态 JWT） ---------- */
/** AI 体验票有效期：12 小时，过期后必须重新输入 AI 密码 */
const PUBLIC_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const PUBLIC_TOKEN_HEADER = 'x-public-ai-token';
const PUBLIC_AI_ROLE = 'ai_guest';
const JWT_ALGORITHM = 'HS256';
/**
 * ⚠️ 不再有服务端内存 Map：票是一张自包含的 JWT（payload 里带 role + exp），
 * 任何实例只用同一个 JWT_SECRET 验签即可 —— 后端重启 / 多实例 / Serverless 冷启动都不影响 12 小时内的票。
 * JWT_SECRET 本地来自 .env.local，Vercel 来自项目环境变量（两边必须同值）。
 */
const getJwtSecret = () => String(process.env.JWT_SECRET || '').trim();

/** 登录失败计数：ip → { fails, until } */
const loginAttempts = new Map();

function getAdminPassword() {
  return String(process.env.ADMIN_PASSWORD || '').trim();
}

/** 服务端有没有配管理员密码 */
function isAdminConfigured() {
  return Boolean(getAdminPassword());
}

/** 定长比较（长度不同直接判否，不抛异常） */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** 公开版两个密码（服务端读取，前端永远拿不到明文） */
function getPublicPasswords() {
  return {
    local: String(process.env.PUBLIC_PASSWORD_LOCAL || '').trim(),
    ai: String(process.env.PUBLIC_PASSWORD_AI || '').trim(),
  };
}

function isPublicConfigured() {
  const { local, ai } = getPublicPasswords();
  return Boolean(local || ai);
}

/** 从请求头里取出 AI 体验票（兼容 Node 把同名头解析成数组的情况） */
function readPublicAiToken(req) {
  const raw = req?.headers?.[PUBLIC_TOKEN_HEADER];
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return String(raw || '').trim();
}

/** 为 AI 体验密码签发一张 12 小时有效的 JWT；票本身不是密码，也不暴露密码 */
function createPublicAiToken() {
  const secret = getJwtSecret();
  if (!secret) throw new Error('服务端未配置 JWT_SECRET，无法签发 AI 体验票');
  return jwt.sign({ role: PUBLIC_AI_ROLE }, secret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: Math.floor(PUBLIC_TOKEN_TTL_MS / 1000),
  });
}

/**
 * 无状态校验 AI 体验票：只验签 + 看 role + 看 exp，不查任何内存状态。
 * @returns {{ok:boolean, expired?:boolean, reason?:string, payload?:object}}
 */
function verifyPublicAiToken(token) {
  const value = String(token || '').trim();
  if (!value) return { ok: false, reason: '缺少 AI 体验票' };
  const secret = getJwtSecret();
  if (!secret) return { ok: false, reason: '服务端未配置 JWT_SECRET' };
  let payload;
  try {
    payload = jwt.verify(value, secret, { algorithms: [JWT_ALGORITHM] });
  } catch (error) {
    const expired = error?.name === 'TokenExpiredError';
    return {
      ok: false,
      expired,
      reason: expired ? 'AI 体验票已过期' : `AI 体验票无效（${error?.message || '签名不匹配'}）`,
    };
  }
  if (!payload || typeof payload !== 'object' || payload.role !== PUBLIC_AI_ROLE) {
    return { ok: false, reason: 'AI 体验票角色不匹配' };
  }
  return { ok: true, payload };
}

/** 请求头里带的是否是一张有效的 AI 体验票（保留旧签名给调用方用） */
function isPublicAiTokenRequest(req) {
  return verifyPublicAiToken(readPublicAiToken(req)).ok;
}

/**
 * 校验公开版密码：
 *   · 本地密码 → { ok:true, mode:'local' }，只开本机功能，不给服务端票；
 *   · AI 密码   → { ok:true, mode:'ai', token }，只有它拿到可调用 /api/ai 的票。
 */
function verifyPublicPassword(password, req) {
  const value = String(password || '').trim();
  const { local, ai } = getPublicPasswords();
  if (!local && !ai) {
    return { ok: false, reason: '服务端未配置公开版密码（PUBLIC_PASSWORD_LOCAL / PUBLIC_PASSWORD_AI）' };
  }
  if (isLocked(clientIp(req))) {
    return { ok: false, reason: '密码错误次数过多，请稍后再试' };
  }
  if (local && safeEqual(value, local)) {
    loginAttempts.delete(clientIp(req));
    return { ok: true, mode: 'local' };
  }
  if (ai && safeEqual(value, ai)) {
    loginAttempts.delete(clientIp(req));
    try {
      return { ok: true, mode: 'ai', token: createPublicAiToken() };
    } catch (error) {
      /* 密码是对的，但服务端没配 JWT_SECRET —— 由 admin-core 返回 503 明确提示配置问题 */
      return { ok: true, mode: 'ai', token: '', reason: error.message };
    }
  }
  const outcome = recordFailure(clientIp(req));
  return {
    ok: false,
    reason: outcome.locked ? '密码错误次数过多，已临时锁定 10 分钟' : '公开版密码错误',
  };
}

/** 从请求里取出客户端带来的管理员密码 */
function readProvidedPassword(req) {
  const raw = req?.headers?.[ADMIN_HEADER];
  if (Array.isArray(raw)) return String(raw[0] || '');
  return String(raw || '');
}

/** 这个请求是不是管理员？ */
function isAdminRequest(req) {
  const expected = getAdminPassword();
  if (!expected) return false;                       // 服务端没配密码 → 谁都不是管理员
  const provided = readProvidedPassword(req).trim();
  if (!provided) return false;
  return safeEqual(provided, expected);
}

/** 是不是写方法 */
function isWriteMethod(method) {
  return WRITE_METHODS.has(String(method || 'GET').toUpperCase());
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * 写操作守门员：游客一律 403。
 * @returns {boolean} true = 放行；false = 已拦下（调用方必须 return）
 */
function requireAdmin(req, res, options = {}) {
  if (!isWriteMethod(req?.method)) return true;      // 读操作直接放行
  if (res?.headersSent) return false;                // 已经被拦过一次了，别重复写响应
  if (isAdminRequest(req)) return true;
  /* 🪪 AI 体验密码签发的服务端票只放行 AI 路由；
     /api/data 即使带这张票也照样 403 —— 公开用户永远碰不到云端数据。 */
  if (options.allowPublicAI) {
    const token = readPublicAiToken(req);
    /* 带了票但验不过（过期 / 伪造 / 角色不对）→ 401 让前端清状态并提示重新登录；
       没带票仍走下面的 403 ADMIN_REQUIRED，保持原有游客行为不变。 */
    if (token) {
      const verified = verifyPublicAiToken(token);
      if (verified.ok) return true;
      console.warn(`[auth] ⛔ 已拒绝无效 AI 体验票：${req?.method} ${req?.url || ''}（${verified.reason}）`);
      sendJson(res, 401, {
        error: 'AI 体验权限已过期，请重新输入体验密码登录',
        code: 'TOKEN_EXPIRED',
        tokenExpired: true,
        reason: verified.reason,
      });
      return false;
    }
  }
  const configured = isAdminConfigured();
  console.warn(`[auth] ⛔ 已拦截未授权的写操作：${req?.method} ${req?.url || ''}`
    + (configured ? '（管理员密码不正确）' : '（服务端未配置 ADMIN_PASSWORD）'));
  sendJson(res, 403, {
    error: configured ? '游客无权修改数据' : '服务端未配置管理员密码（ADMIN_PASSWORD），写入操作已被拒绝',
    code: 'ADMIN_REQUIRED',
    adminRequired: true,
    adminConfigured: configured,
  });
  return false;
}

/* --------------------------- 登录校验（/api/admin） --------------------------- */

function clientIp(req) {
  return String(req?.socket?.remoteAddress || req?.headers?.['x-forwarded-for'] || 'unknown');
}

/** 这个 IP 现在是不是被锁住了 */
function isLocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.until && Date.now() < entry.until) return true;
  if (entry.until && Date.now() >= entry.until) loginAttempts.delete(ip);
  return false;
}

function recordFailure(ip) {
  const entry = loginAttempts.get(ip) || { fails: 0, until: 0 };
  entry.fails += 1;
  if (entry.fails >= MAX_LOGIN_FAILURES) {
    // 到上限：锁定，计数归零（解锁后重新给满 5 次机会）
    entry.until = Date.now() + LOGIN_LOCK_MS;
    entry.fails = 0;
    loginAttempts.set(ip, entry);
    return { locked: true, until: entry.until };
  }
  loginAttempts.set(ip, entry);
  return { locked: false, left: MAX_LOGIN_FAILURES - entry.fails };
}

/**
 * 校验管理员密码（登录用）
 * @returns {{ok:boolean, reason?:string, lockedUntil?:number}}
 */
function verifyPassword(password, req) {
  const ip = clientIp(req);
  if (!isAdminConfigured()) {
    return { ok: false, reason: '服务端未配置管理员密码（ADMIN_PASSWORD），请在 .env.local 或 Vercel 环境变量中配置' };
  }
  if (isLocked(ip)) {
    const entry = loginAttempts.get(ip);
    return { ok: false, reason: `密码错误次数过多，请 ${Math.ceil(((entry?.until || 0) - Date.now()) / 60000)} 分钟后再试`, lockedUntil: entry?.until || 0 };
  }
  const provided = String(password || '').trim();
  if (!provided || !safeEqual(provided, getAdminPassword())) {
    const outcome = recordFailure(ip);
    return {
      ok: false,
      reason: outcome.locked
        ? '密码错误次数过多，已临时锁定 10 分钟'
        : `密码错误，还可尝试 ${outcome.left} 次`,
      lockedUntil: outcome.until || 0,
    };
  }
  loginAttempts.delete(ip);
  return { ok: true };
}

module.exports = {
  ADMIN_HEADER,
  PUBLIC_TOKEN_HEADER,
  PUBLIC_AI_ROLE,
  JWT_ALGORITHM,
  getJwtSecret,
  MAX_LOGIN_FAILURES,
  LOGIN_LOCK_MS,
  PUBLIC_TOKEN_TTL_MS,
  getAdminPassword,
  isAdminConfigured,
  isAdminRequest,
  isWriteMethod,
  requireAdmin,
  safeEqual,
  sendJson,
  verifyPassword,
  getPublicPasswords,
  isPublicConfigured,
  isPublicAiTokenRequest,
  readPublicAiToken,
  verifyPublicAiToken,
  createPublicAiToken,
  verifyPublicPassword,
};
