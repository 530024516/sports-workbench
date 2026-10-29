/**
 * Store 数据丢失防线回归测试（无浏览器依赖，node tests/store-smoke.mjs 直接跑）
 *
 * 复现的是线上那个「刷新后 pe_sports_meet_v1 从 216 条变成 0 条」的 Bug：
 *   ① 报名页 / 赛程页按 F5，主数据瞬间空
 *   ② 两个页面表现不一致（赛程能靠备份拉起来，报名拉不起来）
 *   ③ 云端被污染成 0 条后，本地不反推，还打印「本次无差异」
 *
 * 做法：把 js/store.js 塞进 vm 沙箱，用假的 localStorage / window / fetch 驱动 Store.start()，
 *       再断言「读到的条数」「有没有把本地数据反推回云端」「有没有被兄弟页面的空值冲掉」。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_SOURCE = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');

const MEET_KEY = 'pe_sports_meet_v1';
const BACKUP_KEY = 'pe_sports_meet_backup_v1';
const ATHLETE_COUNT = 216;

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

function makeAthletes(count = ATHLETE_COUNT) {
  return Array.from({ length: count }, (_, index) => ({
    id: `a-${index}`, name: `学生${index}`, gender: index % 2 ? '男' : '女', className: '三年级1班', grade: '三年级',
  }));
}

function makeMeetData(count = ATHLETE_COUNT) {
  return {
    athletes: makeAthletes(count),
    registrations: makeAthletes(count).map((a, i) => ({ id: `r-${i}`, athleteId: a.id, eventName: '60米', genderGroup: '男子组' })),
    heats: [],
    laneCount: 4,
  };
}

const EMPTY_MEET = { athletes: [], registrations: [], heats: [], laneCount: 4 };

class FakeStorageEvent extends CustomEvent {
  constructor(init) {
    super('storage');
    this.key = init.key;
    this.newValue = init.newValue ?? null;
    this.oldValue = init.oldValue ?? null;
  }
}

/**
 * @param {object} options
 * @param {Record<string, string>} options.seed localStorage 初始内容（值给对象会自动 JSON 化）
 * @param {(request: {url:string, method:string, body:any}) => any} options.cloud
 *        决定 /api/data 的返回值；返回 pending 可以让请求永远挂着（用来验「不等云端」）
 */
function createStore(options = {}) {
  const { seed = {}, cloud = () => ({ mode: 'supabase', data: {} }) } = options;
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
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ mode: 'supabase', ok: true, report: [] }) };
    const payload = await cloud({ url, method, body });
    if (!payload) return new Promise(() => {});          // 故意挂着：模拟「云端很慢」
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
  // 追加导出：Store 是脚本顶层 const，沙箱里拿不到，得手动挂出来
  new vm.Script(`${STORE_SOURCE}\n;globalThis.__Store = Store;`, { filename: 'js/store.js' }).runInContext(context);
  const Store = sandbox.__Store;

  const microtasks = async (times = 30) => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  };

  /** 跑干 sparing：把 Store 里排的 setTimeout（重试 / 补推）逐个触发 */
  const pump = async (rounds = 40) => {
    for (let i = 0; i < rounds; i += 1) {
      await microtasks();
      if (!timers.pending()) return;
      timers.runNext();
    }
  };

  const meetFromStorage = key => {
    const raw = storage.getItem(key === 'backup' ? BACKUP_KEY : MEET_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const athletesIn = value => (value && Array.isArray(value.athletes) ? value.athletes.length
    : Array.isArray(value?.data?.athletes) ? value.data.athletes.length : 0);
  const postsToCloud = () => calls.filter(call => call.method === 'POST' && call.body?.key === MEET_KEY);
  global.__lastLogs = logs;   // --debug 时打印沙箱日志，定位卡死的用例

  return {
    Store,
    window: win,
    storage,
    calls,
    events,
    logs,
    pump,
    meetFromStorage,
    athletesIn,
    postsToCloud,
    /** 模拟「另一个 iframe 把某个键改写成空值」 */
    siblingWriteEmpty(key = MEET_KEY) {
      const event = new FakeStorageEvent({ key, newValue: JSON.stringify(EMPTY_MEET) });
      win.dispatchEvent(event);
    },
    siblingRemove(key = MEET_KEY) {
      win.dispatchEvent(new FakeStorageEvent({ key, newValue: null }));
    },
  };
}

/* ------------------------------ 断言器 ------------------------------ */

const results = [];
async function test(name, fn) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('用例超时（可能存在死等/死锁）')), 4000));
  const debug = process.argv.includes('--debug');
  try {
    await Promise.race([fn(), timeout]);
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ❌ ${name}\n     ${error.message}`);
    if (debug) console.log('     ---- 沙箱日志 ----\n     ' + (global.__lastLogs || []).join('\n     '));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

/* ------------------------------ 用例 ------------------------------ */

console.log('\n🧪 Store 数据防线回归测试\n');

await test('① 启动第一原则：主数据为空时，不等云端就同步从备份拉起 216 条', async () => {
  const env = createStore({
    seed: { [MEET_KEY]: EMPTY_MEET, [BACKUP_KEY]: { savedAt: Date.now(), key: MEET_KEY, count: ATHLETE_COUNT, data: makeMeetData() } },
    cloud: () => null,                 // 云端永远挂着，任何"等云端"的实现都会挂在这里
  });
  const ready = env.Store.start();
  await env.pump();
  await ready.catch(() => {});
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, 'start() 后应立刻读到备份里的 216 条');
  equal(env.athletesIn(env.meetFromStorage()), ATHLETE_COUNT, 'localStorage 主数据应立刻回写成 216 条');
  assert(env.events.some(detail => Array.isArray(detail?.changed) && detail.changed.includes(MEET_KEY)),
    '应派发 store:sync 事件让页面重绘');
});

await test('② 报名页冷启动：连 read() 之前都没 load 过的场景也能自愈（不等 start）', async () => {
  const env = createStore({
    seed: { [BACKUP_KEY]: { savedAt: Date.now(), key: MEET_KEY, count: ATHLETE_COUNT, data: makeMeetData() } },
    cloud: () => null,
  });
  // 报名页 registration.js 在脚本顶层就 Store.read()，那时 Store.start() 还没被调度起来
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, 'read() 之前未 start 也应命中备份');
});

await test('③ 云端返回 0 条 + 本地有 216 条 → 拒绝覆盖并把本地数据反推回云端', async () => {
  const env = createStore({
    seed: { [MEET_KEY]: makeMeetData() },
    cloud: () => ({ mode: 'supabase', data: { [MEET_KEY]: EMPTY_MEET } }),
  });
  await env.Store.start();
  await env.pump();
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, '本地 216 条不能被云端 0 条覆盖');
  const repairs = env.postsToCloud().filter(call => env.athletesIn(call.body?.value) === ATHLETE_COUNT);
  assert(repairs.length > 0, '应立刻调用 _pushBackToCloud() 把 216 条推回云端');
});

await test('④ 云端返回 0 条 + 本地也是 0 条 → 从备份拉起并反推云端（不再打印"本次无差异"）', async () => {
  const env = createStore({
    seed: { [MEET_KEY]: EMPTY_MEET, [BACKUP_KEY]: { savedAt: Date.now(), key: MEET_KEY, count: ATHLETE_COUNT, data: makeMeetData() } },
    cloud: () => ({ mode: 'supabase', data: { [MEET_KEY]: EMPTY_MEET } }),
  });
  await env.Store.start();
  await env.pump();
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, '本地+云端都是空时必须由备份救回来');
  equal(env.athletesIn(env.meetFromStorage()), ATHLETE_COUNT, '恢复后要写回 localStorage');
  assert(env.postsToCloud().some(call => env.athletesIn(call.body?.value) === ATHLETE_COUNT),
    '恢复后必须把 216 条反推回云端，修好被污染的表');
  assert(!env.logs.some(line => line.includes('本次无差异')), '不能出现「本次无差异」的假成功日志');
});

await test('⑤ 兄弟 iframe 传来空的主数据 → 本页直接无视，保留自己的 216 条', async () => {
  const env = createStore({ seed: { [MEET_KEY]: makeMeetData() }, cloud: () => null });
  await env.Store.start();
  await env.pump();
  env.siblingWriteEmpty();
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, '兄弟页面的空状态不许覆盖本地');
  env.siblingRemove();
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, '兄弟页面删键（storage newValue=null）也不许清空本地');
});

await test('⑥ 明确的清空指令（一键清空）例外：本页必须真的清空，且不被备份复活', async () => {
  const env = createStore({
    seed: { [MEET_KEY]: makeMeetData(), [BACKUP_KEY]: { savedAt: Date.now(), key: MEET_KEY, count: ATHLETE_COUNT, data: makeMeetData() } },
    cloud: () => ({ mode: 'supabase', data: {} }),
  });
  const step = process.argv.includes('--debug') ? message => console.log(`     [step] ${message}`) : () => {};
  await env.Store.start();
  step('start done');
  await env.pump();
  step('pump done');
  await Promise.race([
    env.Store.purgeMeetData(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('purgeMeetData 卡死')), 1500)),
  ]);
  step('purge done');
  await env.pump();
  step('after purge pump done');
  equal(env.athletesIn(env.meetFromStorage()), 0, '一键清空后 localStorage 主数据应为空');
  assert(!env.storage.getItem(BACKUP_KEY), '一键清空必须连备份一起删');
  // 兄弟页面（另一个 iframe）收到"被清空"的 storage 事件时必须跟着清空，且不能从备份复活
  const sibling = createStore({ seed: Object.fromEntries(env.storage.map), cloud: () => ({ mode: 'supabase', data: {} }) });
  await sibling.Store.start();
  await sibling.pump();
  equal(sibling.athletesIn(sibling.Store.read(MEET_KEY, null)), 0, '清空后新开的页面不能从备份复活');
  sibling.siblingWriteEmpty();
  equal(sibling.athletesIn(sibling.Store.read(MEET_KEY, null)), 0, '清空指令之后传来的空值是要生效的，不能再被防污染拦住');
});

await test('⑦ 云端有 216 条、本地为空且无备份 → 正常采用云端（防线不能误伤正常拉取）', async () => {
  const env = createStore({
    seed: {},
    cloud: () => ({ mode: 'supabase', data: { [MEET_KEY]: makeMeetData() } }),
  });
  await env.Store.start();
  await env.pump();
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, '云端有数据时应正常落到本地');
});

await test('⑧ 空数据不得写进云端：本地空 + 没有清空意图时，绝不 POST 0 条', async () => {
  const env = createStore({ seed: {}, cloud: () => ({ mode: 'supabase', data: {} }) });
  await env.Store.start();
  await env.pump();
  // 模拟"某页面内存里是空数据却要整个写回"（这正是把云端洗成 0 条的元凶之一）
  env.Store.write(MEET_KEY, EMPTY_MEET);
  await env.pump();
  const posted = env.postsToCloud().filter(call => env.athletesIn(call.body?.value) === 0);
  equal(posted.length, 0, '本机本来就没数据时，不能把空数据推上去污染云端');
});

await test('⑨ 用户亲手点的清空要能写进云端（上面的防线不能误伤真实意图）', async () => {
  const env = createStore({ seed: { [MEET_KEY]: makeMeetData() }, cloud: () => ({ mode: 'supabase', data: { [MEET_KEY]: makeMeetData() } }) });
  await env.Store.start();
  await env.pump();
  await env.Store.writeCritical(MEET_KEY, EMPTY_MEET, { label: '清空全部报名', force: true });
  await env.pump();
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), 0, '用户清空后本地应为空');
  assert(env.postsToCloud().some(call => env.athletesIn(call.body?.value) === 0), '用户亲手清空必须真的写到云端');
});

await test('⑩ 备份按存储键分槽：写过项目库 / 模板配置后，报名数据的备份仍在（刷新能自愈）', async () => {
  const env = createStore({
    seed: { [MEET_KEY]: makeMeetData(), [BACKUP_KEY]: { savedAt: Date.now(), key: MEET_KEY, count: ATHLETE_COUNT, data: makeMeetData() } },
    cloud: () => ({ mode: 'supabase', data: {} }),
  });
  await env.Store.start();
  await env.pump();
  env.Store.write('pe_sports_meet_events_v1', [{ name: '60米' }]);
  env.Store.write('pe_meet_template_config_v1', { gradeLimit: false });
  await env.pump();
  // 兄弟 iframe 把 main key 洗成了 0 条（没有清空意图）
  env.storage.setItem(MEET_KEY, JSON.stringify(EMPTY_MEET));
  env.siblingWriteEmpty();
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, '本页有数据时，兄弟页面的空快照一律无视');
  // 然后再按 F5：新 Store 实例从盘上读到的已经是 0 条，此时必须还能被备份拉起来
  const reloaded = createStore({
    seed: { ...Object.fromEntries(env.storage.map), [MEET_KEY]: EMPTY_MEET },
    cloud: () => ({ mode: 'supabase', data: { [MEET_KEY]: EMPTY_MEET } }),
  });
  await reloaded.Store.start();
  await reloaded.pump();
  equal(reloaded.athletesIn(reloaded.Store.read(MEET_KEY, null)), ATHLETE_COUNT,
    '刷新后本地+云端都是 0 条，备份必须还能把 216 条拉回来（备份没被别的键顶掉）');
});

await test('⑪ 过期的清空指令不得生效：残留的世代号不能抹掉之后新导入的数据', async () => {
  const env = createStore({
    seed: {
      [MEET_KEY]: makeMeetData(),
      // 模拟"很久以前做过一次一键清空"，世代号一直留在 localStorage 里
      [ 'pe_meet_purge_epoch_v1']: JSON.stringify({ epoch: 3, at: Date.now() - 3600 * 1000 }),
    },
    cloud: () => ({ mode: 'supabase', data: {} }),
  });
  await env.Store.start();
  await env.pump();
  env.siblingWriteEmpty();
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, '一小时前清空的世代号不能清掉今天的 216 条');
});

await test('⑫ read() 早于 start() 时必须从 localStorage 取到数据（不能返回 null 让 UI 空白）', async () => {
  const env = createStore({ seed: { [MEET_KEY]: makeMeetData() }, cloud: () => null });
  // 报名页 registration.js 顶层就是 pageData = loadMeetData()，那时 Store.start() 还没跑
  const value = env.Store.read(MEET_KEY, null);
  equal(env.athletesIn(value), ATHLETE_COUNT, 'start() 之前 read() 也必须是 216 条');
});

await test('⑬ window.forceRecover()：暂停云端 → 备份强行写回主键 → 云端再也盖不动', async () => {
  const env = createStore({
    seed: { [MEET_KEY]: makeMeetData(), [BACKUP_KEY]: { savedAt: Date.now(), key: MEET_KEY, count: ATHLETE_COUNT, data: makeMeetData() } },
    cloud: () => ({ mode: 'supabase', data: { [MEET_KEY]: EMPTY_MEET } }),   // 云端是 0 条
  });
  await env.Store.start();
  await env.pump();
  // 模拟"刷新一瞬间主数据被谁写成了 0"
  env.Store.cache.set(MEET_KEY, EMPTY_MEET);
  env.storage.setItem(MEET_KEY, JSON.stringify(EMPTY_MEET));
  const report = env.Store.forceRecover();
  assert(report.ok, 'forceRecover 应报告恢复成功');
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, 'forceRecover 后立刻能读到 216 条');
  equal(env.athletesIn(env.meetFromStorage()), ATHLETE_COUNT, 'forceRecover 必须写回 localStorage');
  assert(env.Store._cloudPaused === true, 'forceRecover 必须暂停云端同步');
  // 暂停之后再同步：云端的 0 条一个键都不许改
  await env.Store.sync();
  await env.pump();
  equal(env.athletesIn(env.Store.read(MEET_KEY, null)), ATHLETE_COUNT, '暂停期间云端 0 条绝不能再覆盖本地');
  // 派发了 store:sync，页面靠它重绘
  assert(env.events.some(detail => Array.isArray(detail?.changed) && detail.changed.includes(MEET_KEY)),
    'forceRecover 必须派发 store:sync 让页面重绘');
});

await test('⑭ forceRecover 之后可以手动把数据推回云端修好被污染的云表', async () => {
  const env = createStore({
    seed: { [MEET_KEY]: EMPTY_MEET, [BACKUP_KEY]: { savedAt: Date.now(), key: MEET_KEY, count: ATHLETE_COUNT, data: makeMeetData() } },
    cloud: () => ({ mode: 'supabase', data: { [MEET_KEY]: EMPTY_MEET } }),
  });
  await env.Store.start();
  await env.pump();
  env.Store.forceRecover();
  env.Store.pushLocalToCloud();
  await env.pump();
  assert(env.postsToCloud().some(call => env.athletesIn(call.body?.value) === ATHLETE_COUNT),
    'pushLocalToCloud() 必须把 216 条推回云端');
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
