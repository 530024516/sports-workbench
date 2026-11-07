/**
 * 管理员 / 游客 权限回归测试（node tests/admin-auth-smoke.mjs 直接跑）
 *
 * 验的是"安全底线"：游客绝对无法通过接口篡改数据。
 *   ① GET（读数据）放行
 *   ② POST / PUT / DELETE 没带密码 → 403
 *   ③ 带错密码 → 403
 *   ④ 带正确密码 → 放行
 *   ⑤ 服务端没配密码 → 谁都不许写（默认拒绝，绝不"忘了配就全开"）
 *   ⑥ AI 接口同样拦
 *   ⑦ /api/admin 登录校验：对 / 错 / 暴力破解锁定
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-admin-secret';

const results = [];
async function test(name, fn) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('用例超时')), 4000));
  try {
    await Promise.race([fn(), timeout]);
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

/** 每个用例都重新加载模块：lib 里的失败计数是模块级状态，必须隔离 */
function loadAuth(password) {
  Object.keys(require.cache)
    .filter(key => key.includes('admin-auth.js') || key.includes('admin-core.js'))
    .forEach(key => delete require.cache[key]);
  if (password === null) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = password;
  return {
    auth: require(path.join(ROOT, 'lib/admin-auth.js')),
    core: require(path.join(ROOT, 'lib/admin-core.js')),
  };
}

/** 假 req/res：把响应抓下来断言 */
function makeReqRes({ method = 'POST', url = '/api/data', headers = {}, body = null } = {}) {
  let status = 0;
  let payload = null;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code) { status = code; this.headersSent = true; },
    end(text) { payload = text ? JSON.parse(text) : null; this.writableEnded = true; },
  };
  return { req: { method, url, headers, socket: { remoteAddress: '127.0.0.1' }, body }, res, status: () => status, payload: () => payload };
}

console.log('\n🧪 管理员 / 游客 权限回归测试\n');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

await test('① GET（读数据）一律放行，不需要密码', () => {
  const { auth } = loadAuth(SECRET);
  equal(auth.isWriteMethod('GET'), false, 'GET 不是写方法');
  equal(auth.isWriteMethod('post'), true, 'POST 是写方法');
  equal(auth.isWriteMethod('PUT'), true, 'PUT 是写方法');
  equal(auth.isWriteMethod('DELETE'), true, 'DELETE 是写方法');
});

await test('② 写操作没带密码 → 403 + 游客无权修改数据', () => {
  const { auth } = loadAuth(SECRET);
  const { req, res, status, payload } = makeReqRes({ method: 'POST', headers: {} });
  const pass = auth.requireAdmin(req, res);
  equal(pass, false, '必须拦下');
  equal(status(), 403, '必须返回 403 Forbidden');
  equal(payload().error, '游客无权修改数据', '错误信息要写清楚');
  equal(payload().code, 'ADMIN_REQUIRED', '要带可识别的错误码');
});

await test('③ 写操作带【错误】密码 → 403', () => {
  const { auth } = loadAuth(SECRET);
  const { req, res, status } = makeReqRes({ method: 'POST', headers: { 'x-admin-password': 'wrong' } });
  equal(auth.requireAdmin(req, res), false, '密码错必须拦下');
  equal(status(), 403, '必须返回 403');
});

await test('④ 写操作带【正确】密码 → 放行', () => {
  const { auth } = loadAuth(SECRET);
  const { req, res } = makeReqRes({ method: 'POST', headers: { 'x-admin-password': SECRET } });
  equal(auth.requireAdmin(req, res), true, '管理员必须放行');
  equal(res.writableEnded, false, '放行时不该写任何响应（交给业务处理）');
  // 前后带空格也要认（浏览器 / 复制粘贴常见）
  const padded = makeReqRes({ method: 'POST', headers: { 'x-admin-password': `  ${SECRET}  ` } });
  equal(auth.requireAdmin(padded.req, padded.res), true, '密码前后的空格要忽略');
});

await test('⑤ 服务端没配 ADMIN_PASSWORD → 谁都不许写（默认拒绝）', () => {
  const { auth } = loadAuth(null);
  equal(auth.isAdminConfigured(), false, '应识别为"未配置"');
  const withPassword = makeReqRes({ method: 'POST', headers: { 'x-admin-password': 'anything' } });
  equal(auth.requireAdmin(withPassword.req, withPassword.res), false, '没配密码时任何人都不放行');
  equal(withPassword.status(), 403, '必须返回 403');
  assert(String(withPassword.payload().error).includes('ADMIN_PASSWORD'), '错误信息要指出是服务端没配密码');
});

await test('⑥ 数据接口：GET 放行 / POST 拦截（走真实 handleDataRequest）', async () => {
  const { auth } = loadAuth(SECRET);
  const { handleDataRequest } = require(path.join(ROOT, 'lib/data-api.js'));

  const guest = makeReqRes({ method: 'POST', body: { key: 'pe_attendance', value: [{ id: 'HACK' }] } });
  await handleDataRequest(guest.req, guest.res);
  equal(guest.status(), 403, '游客写数据必须 403');
  equal(guest.payload().error, '游客无权修改数据', '错误信息要一致');
});

await test('⑦ AI 接口：游客一律 403（AI 属于写操作）', async () => {
  const { auth } = loadAuth(SECRET);
  const { handleAiRequest } = require(path.join(ROOT, 'lib/ai-core.js'));
  const guest = makeReqRes({ method: 'POST', url: '/api/ai', body: { type: 'lesson' } });
  await handleAiRequest(guest.req, guest.res);
  equal(guest.status(), 403, '游客调 AI 必须 403');
  equal(guest.payload().code, 'ADMIN_REQUIRED', '要带可识别的错误码');
});

await test('⑧ /api/admin 登录校验：密码错 → 403；密码对 → 200', async () => {
  const { core } = loadAuth(SECRET);
  const bad = makeReqRes({ method: 'POST', url: '/api/admin', body: { password: 'nope' } });
  await core.handleAdminRequest(bad.req, bad.res);
  equal(bad.status(), 403, '密码错必须 403');
  equal(bad.payload().ok, false, 'ok 必须是 false');

  const good = makeReqRes({ method: 'POST', url: '/api/admin', body: { password: SECRET } });
  await core.handleAdminRequest(good.req, good.res);
  equal(good.status(), 200, '密码正确必须 200');
  equal(good.payload().ok, true, 'ok 必须是 true');
});

await test('⑨ 暴力破解防护：连错 5 次后临时锁定', async () => {
  const { core } = loadAuth(SECRET);
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    const attempt = makeReqRes({ method: 'POST', url: '/api/admin', body: { password: 'wrong' } });
    await core.handleAdminRequest(attempt.req, attempt.res);
    last = attempt.payload();
  }
  assert(String(last.error).includes('锁定'), `第 5 次应提示锁定，实际：${last.error}`);
  // 锁住之后即使密码正确也进不来
  const correct = makeReqRes({ method: 'POST', url: '/api/admin', body: { password: SECRET } });
  await core.handleAdminRequest(correct.req, correct.res);
  equal(correct.status(), 403, '锁定期间正确密码也不能通过');
});

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exit(1);
