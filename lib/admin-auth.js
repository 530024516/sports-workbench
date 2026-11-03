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

const ADMIN_HEADER = 'x-admin-password';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// 登录校验的失败次数上限：同一 IP 连错 5 次就锁 10 分钟（防暴力破解）
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

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
function requireAdmin(req, res) {
  if (!isWriteMethod(req?.method)) return true;      // 读操作直接放行
  if (res?.headersSent) return false;                // 已经被拦过一次了，别重复写响应
  if (isAdminRequest(req)) return true;
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
  MAX_LOGIN_FAILURES,
  LOGIN_LOCK_MS,
  getAdminPassword,
  isAdminConfigured,
  isAdminRequest,
  isWriteMethod,
  requireAdmin,
  safeEqual,
  sendJson,
  verifyPassword,
};
