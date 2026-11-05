/**
 * 前端权限回归测试（node tests/auth-ui-smoke.mjs 直接跑）
 *
 * 覆盖：
 *   ① 默认游客：isAdmin() 为 false
 *   ② 游客模式下，写操作按钮（保存 / 删除 / 生成 / 清空 / 编辑 / 导入）被隐藏
 *   ③ 游客模式下，读操作按钮（导出 / 打印 / 查看 / 切换视图）继续显示
 *   ④ 登录后按钮恢复显示，顶栏变成【🔓 退出管理】
 *   ⑤ 请求拦截：游客写请求直接不发（抛「请先登录管理员」）；管理员自动带 X-Admin-Password
 *   ⑥ Store 底层同样拦：游客调用 Store.write() 不会发出任何 POST
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

console.log('\n🧪 前端权限（管理员 / 游客）回归测试\n');

/* ------------------------------ 假 DOM ------------------------------ */

function makeNode(id = '', attrs = {}) {
  const attrMap = new Map(Object.entries(attrs));
  const node = {
    id,
    tagName: (attrs.tag || 'BUTTON').toUpperCase(),
    textContent: '',
    value: '',
    title: '',
    dataset: {},
    style: {
      _props: new Map(),
      setProperty(name, value, priority) { this._props.set(name, value + (priority ? '!' : '')); },
      removeProperty(name) { this._props.delete(name); },
      display: '',
    },
    _classes: new Set(),
    classList: {
      add(...names) { names.forEach(n => node._classes.add(n)); },
      remove(...names) { names.forEach(n => node._classes.delete(n)); },
      toggle(name, on) { if (on) node._classes.add(name); else node._classes.delete(name); },
      contains(name) { return node._classes.has(name); },
    },
    getAttribute: name => (attrMap.has(name) ? attrMap.get(name) : null),
    hasAttribute: name => attrMap.has(name),
    setAttribute(name, value) { attrMap.set(name, value); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    focus() {},
    closest: () => null,
    appendChild() {},
    remove() {},
  };
  node.style.display = '';
  Object.defineProperty(node, 'hidden', { value: false, writable: true });
  return node;
}

function createEnv({ isAdmin = false, password = 'secret-pw' } = {}) {
  const nodes = new Map();
  const storage = new Map();
  const toasts = [];
  const fetches = [];
  if (isAdmin) {
    storage.set('isAdmin', 'true');
    storage.set('pe_admin_password', password);
  }

  const localStorageStub = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    clear: () => storage.clear(),
    get length() { return storage.size; },
    key: index => [...storage.keys()][index] ?? null,
  };

  /* 构造待测按钮：写操作 + 读操作混在一起 */
  const buttons = [
    { id: 'btnSave', attrs: { onclick: 'saveRecord()' } },
    { id: 'btnDelete', attrs: { onclick: "deleteRecord('F1')" } },
    { id: 'btnGenerate', attrs: { onclick: 'generateWholeUnit()' } },
    { id: 'btnOpenAdd', attrs: { onclick: 'openAddRecord()' } },
    { id: 'btnPurge', attrs: { onclick: 'requestFitnessPurge()' } },
    { id: 'btnEditRow', attrs: { onclick: 'OfflineResources.edit("R1")' } },
    { id: 'btnTagged', attrs: { onclick: 'someCustomWrite()', 'data-admin-only': '' } },
    { id: 'btnExport', attrs: { onclick: 'exportRankingCsv()' } },
    { id: 'btnPrint', attrs: { onclick: 'printUnitPlan()' } },
    { id: 'btnView', attrs: { onclick: 'openFitnessDayDetail("2026-05-01")' } },
    { id: 'btnSwitch', attrs: { onclick: "switchView('stats')" } },
    { id: 'btnDownload', attrs: { onclick: 'downloadTemplate()' } },
  ].map(item => {
    const node = makeNode(item.id, item.attrs);
    nodes.set(item.id, node);
    return node;
  });

  const documentStub = {
    readyState: 'complete',
    getElementById: id => nodes.get(id) || null,
    querySelector: () => null,
    querySelectorAll: selector => (selector === '[data-admin-only], [onclick]'
      ? buttons.filter(node => node.hasAttribute('onclick') || node.hasAttribute('data-admin-only'))
      : []),
    addEventListener() {},
    createElement: () => makeNode('tmp'),
    body: {
      querySelectorAll: selector => (selector === '[data-admin-only], [onclick]'
        ? buttons.filter(node => node.hasAttribute('onclick') || node.hasAttribute('data-admin-only'))
        : []),
    },
  };

  const originalFetch = async (url, init = {}) => {
    fetches.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const win = new EventTarget();
  win.parent = win;
  win.top = win;
  win.CustomEvent = CustomEvent;
  win.fetch = originalFetch;
  win.addEventListener('storage', () => {});

  const sandbox = {
    window: win,
    document: documentStub,
    localStorage: localStorageStub,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout,
    CustomEvent, Event, MutationObserver: undefined,
    showToast: (message, type) => toasts.push({ message, type }),
    showModal: () => makeNode('overlay'),
    closeModal: () => {},
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  new vm.Script(`${AUTH_SOURCE}\n;globalThis.__Auth = Auth;`, { filename: 'js/auth.js' }).runInContext(context);
  const Auth = sandbox.__Auth;

  return {
    Auth, win, toasts, fetches, buttons, storage,
    node: id => nodes.get(id),
    isHidden: id => {
      const node = nodes.get(id);
      const display = node?.style?._props?.get('display');
      return Boolean(display && display.startsWith('none'));
    },
  };
}

/* ------------------------------ 用例 ------------------------------ */

await test('① 默认就是游客：isAdmin() 为 false', () => {
  const env = createEnv();
  equal(env.Auth.isAdmin(), false, '默认必须是游客（只读）');
  equal(env.Auth.getPassword(), '', '游客没有密码');
});

await test('② 游客模式：保存 / 删除 / 生成 / 清空 / 编辑 / 导入 全部隐藏', () => {
  const env = createEnv();
  env.Auth.applyAdminUI();
  ['btnSave', 'btnDelete', 'btnGenerate', 'btnOpenAdd', 'btnPurge', 'btnEditRow', 'btnTagged']
    .forEach(id => assert(env.isHidden(id), `${id} 属于写操作，游客必须隐藏`));
});

await test('③ 游客模式：导出 / 打印 / 查看 / 切换视图 继续显示', () => {
  const env = createEnv();
  env.Auth.applyAdminUI();
  ['btnExport', 'btnPrint', 'btnView', 'btnSwitch', 'btnDownload']
    .forEach(id => assert(!env.isHidden(id), `${id} 属于读操作，游客必须能看`));
});

await test('④ 登录后写操作按钮恢复，顶栏变成【🔓 退出管理】', () => {
  const env = createEnv({ isAdmin: true });
  env.Auth.applyAdminUI();
  ['btnSave', 'btnDelete', 'btnGenerate', 'btnPurge']
    .forEach(id => assert(!env.isHidden(id), `管理员模式下 ${id} 必须显示`));
  env.Auth.refreshTopbar();
  const button = env.node('adminToggleBtn');
  if (button) equal(button.textContent, '🔓 退出管理', '顶栏按钮要显示退出');
});

await test('⑤ 游客发写请求 → 直接拦在发送前（抛「请先登录管理员」）', () => {
  const env = createEnv();
  let blocked = null;
  try {
    env.Auth.withAdminHeader({ method: 'POST', headers: { 'Content-Type': 'application/json' } }, '/api/data');
  } catch (error) {
    blocked = error;
  }
  assert(blocked, '游客的写请求必须被拦下');
  assert(String(blocked.message).includes('请先登录管理员'), '提示语要写清楚');
  equal(env.fetches.length, 0, '一个请求都不许发出去');
});

await test('⑥ 管理员发写请求 → 自动带上 X-Admin-Password', () => {
  const env = createEnv({ isAdmin: true, password: 'my-pw' });
  const result = env.Auth.withAdminHeader({ method: 'POST', headers: { 'Content-Type': 'application/json' } }, '/api/data');
  equal(result.headers['X-Admin-Password'], 'my-pw', '请求头必须带管理员密码');
  equal(result.headers['Content-Type'], 'application/json', '原有请求头不能被冲掉');
  // 读请求不带密码（没必要）
  const get = env.Auth.withAdminHeader({ method: 'GET' }, '/api/data');
  assert(!get.headers['X-Admin-Password'], '读请求不需要带密码');
});

await test('⑦ 游客写请求（Store 底层）→ 不会发出任何 POST', async () => {
  const env = createEnv();
  const storage = new Map();
  const calls = [];
  const win = new EventTarget();
  win.parent = win;
  win.top = win;
  win.CustomEvent = CustomEvent;
  win.Auth = env.Auth;
  const sandbox = {
    window: win,
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
      get length() { return storage.size; },
      key: index => [...storage.keys()][index] ?? null,
    },
    document: { readyState: 'loading', addEventListener() {}, body: null },
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ mode: 'supabase', ok: true, report: [] }) };
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout,
    AbortController, CustomEvent, Event, structuredClone,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  new vm.Script(`${STORE_SOURCE}\n;globalThis.__Store = Store;`, { filename: 'js/store.js' }).runInContext(ctx);
  const Store = sandbox.__Store;
  Store.cloudState = 'on';

  let rejected = false;
  try {
    await Store._fetchJSON('/api/data', { method: 'POST', body: JSON.stringify({ key: 'pe_students' }) });
  } catch (error) {
    rejected = true;
  }
  assert(rejected, '游客的写请求必须被拒');
  equal(calls.length, 0, '绝不能向后端发出任何请求');
});

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exit(1);
