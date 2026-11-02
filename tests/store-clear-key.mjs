/**
 * 【一键清空体测数据】回归测试（无浏览器依赖，node tests/store-clear-key.mjs 直接跑）
 *
 * 复现的是这次的真实事故：
 *   老师手动清空 Supabase 的体测表 → 前端一刷新，"防丢机制"把本地缓存又反推回云端，
 *   刚洗干净的表又被旧数据填满。
 *
 * 因此 clearKey() 必须做到四件事：
 *   ① 内存 / localStorage / 本地备份 / 防覆盖锁 一次清干净；
 *   ② 云端收到带 clearIntent: true 的清空请求；
 *   ③ 只清体测数据（学生名单、教案一律不动）；
 *   ④ 绝对不触发"反推自愈" —— 云端回来的旧数据不复活，也不被推回云端。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_SOURCE = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');

const FITNESS_KEY = 'pe_fitness_records';
const STUDENTS_KEY = 'pe_students';
const PLANS_KEY = 'pe_lesson_plans';
const LOCK_PREFIX = 'pe_store_unconfirmed_v1::';
const SIGNAL_KEY = 'pe_meet_purge_epoch_v1';

const FITNESS_RECORDS = [
  { id: 'F1', studentId: 'S1', testType: 'run50', testName: '50米跑', value: 8.1, unit: '秒', testDate: '2026-10-01' },
  { id: 'F2', studentId: 'S2', testType: 'jumpRope', testName: '1分钟跳绳', value: 120, unit: '个', testDate: '2026-10-01' },
];
const STUDENTS = [
  { id: 'S1', name: '张三', gender: '男', grade: '三年级', class: '三1班' },
  { id: 'S2', name: '李四', gender: '女', grade: '三年级', class: '三2班' },
];

/* ------------------------------ 测试用假环境 ------------------------------ */

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    clear: () => map.clear(),
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
  };
}

class FakeStorageEvent extends CustomEvent {
  constructor(init) {
    super('storage');
    this.key = init.key;
    this.newValue = init.newValue ?? null;
    this.oldValue = init.oldValue ?? null;
  }
}

function createStore(options = {}) {
  const { seed = {}, cloud = () => ({ mode: 'supabase', data: {} }), post = null } = options;
  const storage = makeStorage(seed);
  const calls = [];
  const events = [];
  const logs = [];
  const pendingTimers = new Map();
  let timerId = 0;

  const win = new EventTarget();
  win.parent = win;
  win.top = win;
  win.CustomEvent = CustomEvent;
  win.addEventListener('store:sync', event => events.push(event.detail));

  const timers = {
    setTimeout(fn, delay = 0) {
      timerId += 1;
      pendingTimers.set(timerId, fn);
      return timerId;
    },
    clearTimeout(id) { pendingTimers.delete(id); },
    pending: () => pendingTimers.size,
    runNext() {
      const entry = pendingTimers.entries().next();
      if (entry.done) return false;
      pendingTimers.delete(entry.value[0]);
      entry.value[1]();
      return true;
    },
  };

  const fetchStub = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (method === 'POST') {
      if (typeof post === 'function') {
        const custom = await post({ url, method, body });
        if (custom) return custom;
      }
      return { ok: true, status: 200, json: async () => ({ mode: 'supabase', ok: true, report: [] }) };
    }
    const payload = await cloud({ url, method, body });
    if (!payload) return new Promise(() => {});
    if (typeof payload === 'object' && 'ok' in payload) return payload;
    return { ok: true, status: 200, json: async () => payload };
  };

  const silentConsole = ['log', 'warn', 'error'].reduce((acc, level) => {
    acc[level] = (...args) => logs.push(`[${level}] ${args.map(String).join(' ')}`);
    return acc;
  }, {});

  const sandbox = {
    window: win,
    localStorage: storage,
    document: { readyState: 'loading', addEventListener() {}, body: null },
    fetch: fetchStub,
    console: silentConsole,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    AbortController,
    CustomEvent,
    Event,
    structuredClone,
    __storage: storage,
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  new vm.Script(`${STORE_SOURCE}\n;globalThis.__Store = Store;`, { filename: 'js/store.js' }).runInContext(context);
  const Store = sandbox.__Store;

  const microtasks = async (times = 30) => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  };
  const pump = async (rounds = 40) => {
    for (let i = 0; i < rounds; i += 1) {
      await microtasks();
      if (!timers.pending()) return;
      timers.runNext();
    }
  };

  return {
    Store,
    window: win,
    storage,
    calls,
    events,
    logs,
    pump,
    /** 清空之后发过的"带着数据"的 POST —— 反推自愈就会走这条路 */
    pushbacksSince: index => calls.slice(index)
      .filter(call => call.method === 'POST'
        && Array.isArray(call.body?.value) && call.body.value.length > 0),
  };
}

/* ------------------------------ 断言器 ------------------------------ */

const results = [];
async function test(name, fn) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('用例超时（可能存在死等/死锁）')), 4000));
  try {
    await Promise.race([fn(), timeout]);
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

/* ------------------------------ 用例 ------------------------------ */

console.log('\n🧪 一键清空体测数据 回归测试\n');

await test('① 一次清干净：内存 + localStorage + 备份 + 防覆盖锁 + 云端', async () => {
  const env = createStore({
    seed: {
      [FITNESS_KEY]: FITNESS_RECORDS,
      [STUDENTS_KEY]: STUDENTS,
      [`${FITNESS_KEY}__local_backup`]: FITNESS_RECORDS,
      [`pe_sports_meet_backup_v1::${FITNESS_KEY}`]: { savedAt: Date.now(), key: FITNESS_KEY, data: FITNESS_RECORDS },
    },
    cloud: () => ({ mode: 'supabase', data: { [FITNESS_KEY]: FITNESS_RECORDS, [STUDENTS_KEY]: STUDENTS } }),
  });
  await env.Store.start();
  await env.pump();
  equal(env.Store.read(FITNESS_KEY, []).length, 2, '清空前应读到 2 条体测记录');

  // 本页正握着一把"云端未确认"的锁（最容易被当成待补推把旧数据推回云端）
  env.Store._markUnconfirmed(FITNESS_KEY, FITNESS_RECORDS, {});

  const result = await env.Store.clearKey(FITNESS_KEY, { label: '体测数据' });
  equal(result.cloudCleared, true, '云端清空应成功');
  equal(env.Store.read(FITNESS_KEY, []).length, 0, '内存缓存应已清空');
  equal(env.storage.getItem(FITNESS_KEY), null, 'localStorage 镜像应已清空');
  equal(env.storage.getItem(`${FITNESS_KEY}__local_backup`), null, '本地备份（__local_backup）应已清空');
  equal(env.storage.getItem(`pe_sports_meet_backup_v1::${FITNESS_KEY}`), null, '时光机分槽备份应已清空');
  equal(env.storage.getItem(`${LOCK_PREFIX}${FITNESS_KEY}`), null, '防覆盖锁应已解除');
  equal(env.Store._pendingWrites.has(FITNESS_KEY), false, '待写队列里的这一条应已移除');

  const clearCall = env.calls.find(call => call.method === 'POST' && call.body?.key === FITNESS_KEY);
  assert(clearCall, '应向云端发一次清空请求');
  equal(clearCall.body.value, null, '清空请求的载荷必须是 null');
  equal(clearCall.body.clear, true, '清空请求必须带 clear=true');
  equal(clearCall.body.clearIntent, true, '清空请求必须带 clearIntent=true');
});

await test('② 只清体测数据：学生名单 / 教案一律不动', async () => {
  const env = createStore({
    seed: { [FITNESS_KEY]: FITNESS_RECORDS, [STUDENTS_KEY]: STUDENTS, [PLANS_KEY]: [{ id: 'L1', title: '跳绳教案' }] },
    cloud: () => ({
      mode: 'supabase',
      data: { [FITNESS_KEY]: FITNESS_RECORDS, [STUDENTS_KEY]: STUDENTS, [PLANS_KEY]: [{ id: 'L1', title: '跳绳教案' }] },
    }),
  });
  await env.Store.start();
  await env.pump();
  await env.Store.clearKey(FITNESS_KEY, { label: '体测数据' });
  await env.pump();

  equal(env.Store.read(STUDENTS_KEY, []).length, 2, '学生名单不能被清掉');
  equal(env.Store.read(PLANS_KEY, []).length, 1, '教案不能被清掉');
  assert(env.storage.getItem(STUDENTS_KEY) !== null, 'localStorage 里的学生名单必须保留');
  assert(env.storage.getItem(PLANS_KEY) !== null, 'localStorage 里的教案必须保留');
  equal(env.calls.filter(call => call.method === 'POST' && call.body?.key === STUDENTS_KEY).length, 0,
    '绝不能向云端发学生名单的清空请求');
  equal(env.calls.filter(call => call.method === 'POST' && call.body?.key === PLANS_KEY).length, 0,
    '绝不能向云端发教案的清空请求');
});

await test('③ 清空后云端仍返回旧数据 → 本地不复活、也不反推回云端', async () => {
  const env = createStore({
    seed: { [FITNESS_KEY]: FITNESS_RECORDS, [STUDENTS_KEY]: STUDENTS },
    cloud: () => ({ mode: 'supabase', data: { [FITNESS_KEY]: FITNESS_RECORDS, [STUDENTS_KEY]: STUDENTS } }),
  });
  await env.Store.start();
  await env.pump();

  const mark = env.calls.length;
  await env.Store.clearKey(FITNESS_KEY, { label: '体测数据' });
  await env.pump();
  // 再同步一次：模拟云端清空慢半拍 / 失败，同步结果里还带着旧数据
  await env.Store.sync();
  await env.pump();

  equal(env.Store.read(FITNESS_KEY, []).length, 0, '云端回来的旧数据绝不能复活到本地');
  equal(env.pushbacksSince(mark).length, 0, '绝不能把旧数据反推回云端（反推自愈）');
});

await test('④ 清空后云端已是空 → 本地保持空，不触发反推自愈', async () => {
  const env = createStore({
    seed: { [FITNESS_KEY]: FITNESS_RECORDS, [STUDENTS_KEY]: STUDENTS },
    cloud: () => ({ mode: 'supabase', data: { [FITNESS_KEY]: [], [STUDENTS_KEY]: STUDENTS } }),
  });
  await env.Store.start();
  await env.pump();

  const mark = env.calls.length;
  await env.Store.clearKey(FITNESS_KEY, { label: '体测数据' });
  await env.pump();
  await env.Store.sync();
  await env.pump();

  equal(env.Store.read(FITNESS_KEY, []).length, 0, '清空后本地必须保持空');
  equal(env.pushbacksSince(mark).length, 0, '清空后不能再有任何反推自愈的推送');
});

await test('⑤ 兄弟页面收到清空指令 → 跟着清空并解除防覆盖锁', async () => {
  const env = createStore({
    seed: { [FITNESS_KEY]: FITNESS_RECORDS },
    cloud: () => ({ mode: 'supabase', data: { [FITNESS_KEY]: FITNESS_RECORDS } }),
  });
  await env.Store.start();
  await env.pump();
  env.Store._markUnconfirmed(FITNESS_KEY, FITNESS_RECORDS, {});

  // 另一个标签页执行了清空：写世代号信号 + 触发 storage 事件
  env.storage.setItem(SIGNAL_KEY, JSON.stringify({ epoch: 1, at: Date.now(), keys: [FITNESS_KEY] }));
  env.window.dispatchEvent(new FakeStorageEvent({ key: FITNESS_KEY, newValue: null }));

  equal(env.Store.read(FITNESS_KEY, []).length, 0, '兄弟页面应跟着清空');
  equal(env.storage.getItem(`${LOCK_PREFIX}${FITNESS_KEY}`), null, '防覆盖锁必须解除（否则旧数据会被补推回云端）');
  equal(env.Store._pendingWrites.has(FITNESS_KEY), false, '待写队列里的这一条必须移除');
});

await test('⑥ 过期很久的清空信号一律不认（不会误删新导入的数据）', async () => {
  const env = createStore({
    seed: { [FITNESS_KEY]: FITNESS_RECORDS },
    cloud: () => ({ mode: 'supabase', data: { [FITNESS_KEY]: FITNESS_RECORDS } }),
  });
  await env.Store.start();
  await env.pump();

  // 20 秒前的清空信号（超过 PURGE_SIGNAL_TTL_MS = 10 秒）
  env.storage.setItem(SIGNAL_KEY, JSON.stringify({ epoch: 1, at: Date.now() - 20000, keys: [FITNESS_KEY] }));
  env.window.dispatchEvent(new FakeStorageEvent({ key: FITNESS_KEY, newValue: null }));

  equal(env.Store.read(FITNESS_KEY, []).length, 2, '过期信号不得清空本地数据');
});

/* ------------------------------ 汇总 ------------------------------ */
const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exit(1);
