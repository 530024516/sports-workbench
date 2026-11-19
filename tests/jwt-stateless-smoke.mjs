/**
 * AI 体验票 JWT 化回归测试（node tests/jwt-stateless-smoke.mjs）
 *
 * 覆盖 5 项改造：
 *   ① JWT_SECRET 签发 / 验签
 *   ② payload = { role:'ai_guest' }，有效期 12h（43200 秒）
 *   ③ AI 闸门：有效 JWT 放行；过期 / 伪造 → 401 TOKEN_EXPIRED；没票 → 仍是 403 ADMIN_REQUIRED
 *   ④ JWT 只能碰 AI 路由，碰 /api/data 照样 403
 *   ⑤ 本地密码与 JWT 完全无关；模拟清空内存（重载模块）后旧 JWT 依然有效
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jwt = require('jsonwebtoken');
const SECRET = 'test-jwt-secret-for-smoke-only';
const ADMIN_PWD = 'test-admin-pwd';
const AI_PWD = 'test-ai-pwd';
const LOCAL_PWD = 'test-local-pwd';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

/** 每个用例重新加载模块：admin-auth 里有登录失败计数，必须隔离；顺便模拟"内存被清空" */
function loadAuth() {
  Object.keys(require.cache)
    .filter(key => key.includes('admin-auth.js') || key.includes('admin-core.js'))
    .forEach(key => delete require.cache[key]);
  process.env.JWT_SECRET = SECRET;
  process.env.ADMIN_PASSWORD = ADMIN_PWD;
  process.env.PUBLIC_PASSWORD_AI = AI_PWD;
  process.env.PUBLIC_PASSWORD_LOCAL = LOCAL_PWD;
  return {
    auth: require(path.join(ROOT, 'lib/admin-auth.js')),
    core: require(path.join(ROOT, 'lib/admin-core.js')),
  };
}

function makeReqRes({ method = 'POST', url = '/api/ai', headers = {} } = {}) {
  let status = 0;
  let payload = null;
  const res = {
    headersSent: false, writableEnded: false,
    writeHead(code) { status = code; this.headersSent = true; },
    end(text) { payload = text ? JSON.parse(text) : null; this.writableEnded = true; },
  };
  return {
    req: { method, url, headers, socket: { remoteAddress: '127.0.0.1' } },
    res,
    status: () => status,
    payload: () => payload,
  };
}
const ticketHeader = token => ({ 'x-public-ai-token': token });

console.log('\n🧪 AI 体验票 JWT 化回归测试\n');

let issuedToken = '';

await test('① AI 密码签发真正的 JWT：3 段、role=ai_guest、12h 有效', () => {
  const { auth } = loadAuth();
  const result = auth.verifyPublicPassword(AI_PWD, { socket: { remoteAddress: '127.0.0.1' } });
  equal(result.ok, true, 'AI 密码应该通过');
  equal(result.mode, 'ai', '模式必须是 ai');
  issuedToken = result.token;
  equal(String(issuedToken).split('.').length, 3, '必须是 header.payload.signature 三段式 JWT');
  const payload = jwt.verify(issuedToken, SECRET, { algorithms: ['HS256'] });
  equal(payload.role, 'ai_guest', 'payload.role 必须是 ai_guest');
  equal(payload.exp - payload.iat, 12 * 60 * 60, '有效期必须是 12 小时（43200 秒）');
});

await test('① 本地密码与 JWT 无关：只开本机功能，绝不拿票', () => {
  const { auth } = loadAuth();
  const result = auth.verifyPublicPassword(LOCAL_PWD, { socket: { remoteAddress: '127.0.0.1' } });
  equal(result.ok, true, '本地密码应该通过');
  equal(result.mode, 'local', '模式必须是 local');
  equal(Boolean(result.token), false, '本地密码绝不能签发 AI JWT');
  /* 没配 JWT_SECRET 时本地密码照样能登 */
  delete process.env.JWT_SECRET;
  const withoutSecret = auth.verifyPublicPassword(LOCAL_PWD, { socket: { remoteAddress: '127.0.0.1' } });
  equal(withoutSecret.ok, true, '本地密码不应依赖 JWT_SECRET');
  process.env.JWT_SECRET = SECRET;
});

await test('③ 有效 JWT 放行 AI 请求（allowPublicAI=true）', () => {
  const { auth } = loadAuth();
  const { req, res, status } = makeReqRes({ headers: ticketHeader(issuedToken) });
  equal(auth.requireAdmin(req, res, { allowPublicAI: true }), true, '有效 JWT 必须放行');
  equal(status(), 0, '放行时不该写任何响应');
});

await test('⑤ 模拟后端重启 / 清空内存：同一个旧 JWT 依然放行', () => {
  const first = loadAuth();
  const firstOk = first.auth.isPublicAiTokenRequest({
    headers: ticketHeader(issuedToken),
  });
  equal(firstOk, true, '第一台实例应认这张票');

  /* 删除模块缓存 = 所有内存 Map / 闭包状态全部归零，等价于进程重启 */
  Object.keys(require.cache)
    .filter(key => key.includes('admin-auth.js') || key.includes('admin-core.js'))
    .forEach(key => delete require.cache[key]);
  const restarted = loadAuth();
  const { req, res, status } = makeReqRes({ headers: ticketHeader(issuedToken) });
  equal(restarted.auth.requireAdmin(req, res, { allowPublicAI: true }), true,
    '重启后旧 JWT 仍必须放行（无状态）');
  equal(status(), 0, '不该返回任何错误响应');
});

await test('③ 伪造 JWT → 401 + code=TOKEN_EXPIRED', () => {
  const { auth } = loadAuth();
  const forged = `${issuedToken.slice(0, -2)}xx`;
  const { req, res, status, payload } = makeReqRes({ headers: ticketHeader(forged) });
  equal(auth.requireAdmin(req, res, { allowPublicAI: true }), false, '伪造票必须拦下');
  equal(status(), 401, '必须是 401（不是 403）');
  equal(payload().code, 'TOKEN_EXPIRED', '错误码必须是 TOKEN_EXPIRED');
  equal(payload().tokenExpired, true, '必须带 tokenExpired 标记');
  assert(String(payload().error).includes('重新输入体验密码登录'), '错误文案要提示重新登录');
});

await test('③ 过期 JWT → 401 + code=TOKEN_EXPIRED', () => {
  const { auth } = loadAuth();
  const expired = jwt.sign({ role: 'ai_guest' }, SECRET, { algorithm: 'HS256', expiresIn: -10 });
  const { req, res, status, payload } = makeReqRes({ headers: ticketHeader(expired) });
  equal(auth.requireAdmin(req, res, { allowPublicAI: true }), false, '过期票必须拦下');
  equal(status(), 401, '必须是 401');
  equal(payload().code, 'TOKEN_EXPIRED', '错误码必须是 TOKEN_EXPIRED');
  assert(String(payload().reason).includes('过期'), '要说明是过期');
});

await test('③ 角色不对的合法签名 JWT → 401（防提权）', () => {
  const { auth } = loadAuth();
  const wrongRole = jwt.sign({ role: 'admin' }, SECRET, { algorithm: 'HS256', expiresIn: '12h' });
  const { req, res, status } = makeReqRes({ headers: ticketHeader(wrongRole) });
  equal(auth.requireAdmin(req, res, { allowPublicAI: true }), false, '角色不匹配必须拦下');
  equal(status(), 401, '必须是 401');
});

await test('③ 没带票 → 仍是 403 ADMIN_REQUIRED（游客行为不变）', () => {
  const { auth } = loadAuth();
  const { req, res, status, payload } = makeReqRes({ headers: {} });
  equal(auth.requireAdmin(req, res, { allowPublicAI: true }), false, '游客必须拦下');
  equal(status(), 403, '没票仍是 403');
  equal(payload().code, 'ADMIN_REQUIRED', '错误码保持原样');
});

await test('④ JWT 不能碰 /api/data：没有 allowPublicAI 时照样 403', () => {
  const { auth } = loadAuth();
  const { req, res, status, payload } = makeReqRes({
    url: '/api/data', headers: ticketHeader(issuedToken),
  });
  equal(auth.requireAdmin(req, res), false, '数据接口必须拦下 AI 票');
  equal(status(), 403, '必须是 403');
  equal(payload().code, 'ADMIN_REQUIRED', '不能用 AI 票读写云端数据');
});

await test('② 没配 JWT_SECRET 时拒绝签发（fail closed），且不误报密码错', async () => {
  const { core } = loadAuth();
  delete process.env.JWT_SECRET;   // loadAuth 会写回测试密钥，必须在加载模块之后再删
  let status = 0;
  let payload = null;
  const res = {
    headersSent: false,
    writeHead(code) { status = code; this.headersSent = true; },
    end(text) { payload = text ? JSON.parse(text) : null; },
  };
  const chunks = [];
  const req = {
    method: 'POST', url: '/api/public-auth', socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) { if (event === 'data') this._data = fn; if (event === 'end') this._end = fn; },
  };
  const pending = core.handlePublicAuthRequest(req, res);
  req._data(Buffer.from(JSON.stringify({ password: AI_PWD })));
  req._end();
  await pending;
  equal(status, 503, '缺 JWT_SECRET 必须是 503 配置错误');
  equal(payload.code, 'JWT_SECRET_MISSING', '错误码要能一眼定位配置问题');
  process.env.JWT_SECRET = SECRET;
});

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} 共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项\n`);
if (failed.length) {
  failed.forEach(item => console.error(`  ✗ ${item.name}\n    ${item.error.stack || item.error.message}`));
  process.exit(1);
}
