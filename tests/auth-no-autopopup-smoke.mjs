/**
 * 【游客浏览不该弹登录框】回归测试（node tests/auth-no-autopopup-smoke.mjs 直接跑）
 *
 * 复现的真实问题：
 *   以游客身份浏览，切到任何一个页面就会自动弹出"管理员登录"框。
 *   根因：每次页面初始化都会跑后台静默同步（断点续传 + 待写队列补推），
 *        这些写请求被后端 403 → 前端就弹登录框。
 *
 * 本测试要求：
 *   ① 游客浏览（页面初始化 / 同步 / 补推 / 续传）→ 一个写请求都不发，更不弹窗
 *   ② 游客写入 → 不发请求，只给 3 秒轻提示
 *   ③ 后端返回 403 → 只给轻提示，不弹窗
 *   ④ Auth.openLoginModal() 被动调用 → 不弹窗（只有手动点击顶栏才弹）
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_SOURCE = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
const STORE_SOURCE = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');

const results = [];
async function test(name, fn) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('用例超时')), 5000));
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

console.log('\n🧪 游客浏览不弹登录框 回归测试\n');

const LOCK_PREFIX = 'pe_store_unconfirmed_v1::';

/**
 * 造一个"游客身份 + 有残留待写数据"的完整环境
 * （模拟管理员以前在这台电脑上写过、当时离线没推上去 → 盘上留了锁）
 */
function createEnv({ admin = false } = {}) {
  const storage = new Map([
    ['pe_attendance', JSON.stringify([{ id: 'S1', name: '张三' }])],
    [`${LOCK_PREFIX}pe_attendance`, JSON.stringify({ at: Date.now(), critical: true, clear: false, attempts: 1 })],
  ]);
  if (admin) {
    storage.set('isAdmin', 'true');
    storage.set('pe_admin_password', 'admin-pw');
  }

  const calls = [];
  const toasts = [];
  const modals = [];
  const pendingTimers = new Map();
  let timerId = 0;

  const fetchStub = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url, method, headers: init.headers || {} });
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ mode: 'supabase', data: { pe_attendance: [{ id: 'S1', name: '张三' }] } }),
      };
    }
    // 写请求：模拟后端 403（游客无权修改数据）
    return {
      ok: false,
      status: 403,
      json: async () => ({ error: '游客无权修改数据', code: 'ADMIN_REQUIRED', adminRequired: true }),
    };
  };

  const documentStub = {
    readyState: 'complete',
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null }),
    body: { querySelectorAll: () => [], appendChild() {} },
  };

  /* ⚠️ window 就是全局对象本身（跟浏览器一样）——
     否则 auth.js 给 window.fetch 打的补丁，store.js 用全局 fetch 时根本享受不到。 */
  const sandbox = new EventTarget();
  sandbox.window = sandbox;
  sandbox.parent = sandbox;
  sandbox.top = sandbox;
  sandbox.CustomEvent = CustomEvent;
  sandbox.fetch = fetchStub;
  sandbox.document = documentStub;
  sandbox.localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    get length() { return storage.size; },
    key: index => [...storage.keys()][index] ?? null,
  };
  sandbox.console = { log() {}, warn() {}, error() {} };
  sandbox.setTimeout = (fn, delay = 0) => {
    timerId += 1;
    pendingTimers.set(timerId, fn);
    return timerId;
  };
  sandbox.clearTimeout = id => pendingTimers.delete(id);
  sandbox.AbortController = AbortController;
  sandbox.Event = Event;
  sandbox.structuredClone = structuredClone;
  sandbox.Date = Date;
  sandbox.JSON = JSON;
  sandbox.Math = Math;
  sandbox.Promise = Promise;
  sandbox.showToast = (message, type = 'success') => toasts.push({ message, type });
  sandbox.showModal = (title, body, footer) => { modals.push({ title, body, footer }); };
  sandbox.closeModal = () => {};
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  new vm.Script(`${AUTH_SOURCE}\n;globalThis.__Auth = Auth;`, { filename: 'js/auth.js' }).runInContext(ctx);
  new vm.Script(`${STORE_SOURCE}\n;globalThis.__Store = Store;`, { filename: 'js/store.js' }).runInContext(ctx);
  const win = sandbox;

  const micro = async (n = 40) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
  const pump = async (rounds = 30) => {
    for (let i = 0; i < rounds; i += 1) {
      await micro();
      if (!pendingTimers.size) return;
      const entry = pendingTimers.entries().next();
      if (entry.done) return;
      pendingTimers.delete(entry.value[0]);
      entry.value[1]();
    }
  };

  return {
    Auth: sandbox.__Auth, Store: sandbox.__Store, win, calls, toasts, modals, storage, pump,
    posts: () => calls.filter(call => call.method !== 'GET'),
  };
}

/* ------------------------------ 用例 ------------------------------ */

await test('① 游客浏览：页面初始化 + 同步 + 补推续传 → 零写请求、零弹窗', async () => {
  const env = createEnv();
  await env.Store.start();
  await env.pump();
  // 再手动触发一次同步（模拟切页 / 定时轮询）
  await env.Store.sync();
  await env.pump();
  equal(env.posts().length, 0, '游客浏览时绝不能发出任何写请求（后台补推/续传也要跳过）');
  equal(env.modals.length, 0, '绝不能自动弹出登录框');
  assert(env.calls.some(call => call.method === 'GET'), '读请求（GET）应该照常发出');
});

await test('② 游客写入：不发请求，只给 3 秒轻提示，不弹窗', async () => {
  const env = createEnv();
  await env.Store.start();
  await env.pump();
  env.Auth._markUserAction();          // 模拟"用户刚刚点了一下"
  const before = env.posts().length;
  env.Store.write('pe_attendance', [{ id: 'S9', name: '李四' }]);
  await env.pump();
  equal(env.posts().length, before, '游客写入不能发出任何请求');
  equal(env.modals.length, 0, '不能弹登录框');
  assert(env.toasts.some(item => String(item.message).includes('游客只能查看数据')),
    `应该给出轻提示，实际提示：${JSON.stringify(env.toasts)}`);
});

await test('②-2 后台写入（页面初始化迁移）→ 完全静默，不提示不弹窗', async () => {
  const env = createEnv();
  await env.Store.start();
  await env.pump();
  const toastsBefore = env.toasts.length;
  env.Store.write('pe_attendance', [{ id: 'S9', name: '李四' }]);   // 没有任何用户操作
  await env.pump();
  equal(env.toasts.length, toastsBefore, '后台写入不该冒提示（否则每切一页就烦一次）');
  equal(env.modals.length, 0, '不能弹登录框');
});

await test('③ 游客写重要表单（writeCritical）：明确返回"未写入云端"，不弹窗', async () => {
  const env = createEnv();
  await env.Store.start();
  await env.pump();
  const result = await env.Store.writeCritical('pe_attendance', [{ id: 'S9', name: '李四' }], { label: '学生' });
  equal(result.ok, false, '游客写入云端必须失败（不能谎报成功）');
  equal(result.adminRequired, true, '要带上 adminRequired 标记');
  equal(env.posts().length, 0, '不能发出任何写请求');
  equal(env.modals.length, 0, '不能弹登录框');
});

await test('④ 后端返回 403（ADMIN_REQUIRED）→ 只轻提示，不弹窗', async () => {
  const env = createEnv({ admin: true });          // 先以管理员身份让请求真的发出去
  await env.Store.start();
  await env.pump();
  // 模拟：管理员在别处退出了登录，本页缓存里的密码失效 → 后端 403
  env.storage.delete('isAdmin');
  env.storage.delete('pe_admin_password');
  env.Auth._markUserAction();
  let rejected = null;
  try {
    await env.Store._fetchJSON('/api/data', { method: 'POST', body: JSON.stringify({ key: 'pe_attendance' }) });
  } catch (error) {
    rejected = error;
  }
  assert(rejected, '请求应该被拒绝');
  equal(env.modals.length, 0, '403 绝不能弹登录框');
  assert(env.toasts.some(item => String(item.message).includes('游客只能查看数据')),
    `403 应该给轻提示，实际：${JSON.stringify(env.toasts)}`);
});

await test('⑤ Auth.openLoginModal() 被被动调用 → 不弹窗（只轻提示）', async () => {
  const env = createEnv();
  env.Auth._markUserAction();
  env.Auth.openLoginModal();                 // 没带 manual=true
  equal(env.modals.length, 0, '非手动调用不得弹登录框');
  assert(env.toasts.length > 0, '应该给一条轻提示');
});

await test('⑥ 手动点顶栏按钮 → 才允许弹登录框', async () => {
  const env = createEnv();
  env.Auth.toggle();
  equal(env.modals.length, 1, '手动点击必须弹出登录框');
  assert(String(env.modals[0].title).includes('管理员登录'), '标题要对');
});

await test('⑦ 管理员浏览：写请求照常发出，并带 X-Admin-Password', async () => {
  const env = createEnv({ admin: true });
  await env.Store.start();
  await env.pump();
  env.Store.write('pe_attendance', [{ id: 'S9', name: '李四' }]);
  await env.pump();
  const posts = env.posts();
  assert(posts.length > 0, '管理员的写入必须真的发出去');
  assert(posts.some(call => call.headers['X-Admin-Password'] === 'admin-pw'),
    '写请求必须带管理员密码');
  equal(env.modals.length, 0, '管理员不该看到登录框');
});

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exit(1);
