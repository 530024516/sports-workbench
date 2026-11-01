/**
 * 体测记录 id 唯一性回归测试（node tests/data-id-smoke.mjs 直接跑）
 *
 * 那次数据丢失的源头就在这里：
 *   批量导入体测记录是在 for 循环里连续调用 addFitnessRecord()，
 *   而旧版 id = `F${Date.now()}` —— 几十条记录落在同一毫秒里，id 【完全相同】。
 *   服务端一条 INSERT 里出现两行同 id → Postgres 整条语句拒绝：
 *   "duplicate key value violates unique constraint fitness_records_pkey" → 502；
 *   而服务端在那之前已经 DELETE 过整张表 → 表被清空 → 云端 0 条 → 刷新后本地也被洗掉。
 *
 * 这里把时间与随机数都【冻住】（模拟"同一毫秒内批量导入"这个最坏情况），
 * 逼出唯一性只能来自序号计数器 —— 旧版实现在这个环境下必然撞车。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_JS = path.join(ROOT, 'js/data.js');

/* ------------------------------ 断言器 ------------------------------ */

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
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

/* ------------------------------ 沙箱 ------------------------------ */

/**
 * 载入 js/data.js：冻结 Date.now 与 Math.random，
 * 用内存 Map 当作 Store 的存储后端。
 * @param {number} fixedNow 冻结后的时间戳
 */
function loadDataModule(fixedNow = 1750000000000) {
  const source = fs.readFileSync(DATA_JS, 'utf8');
  const store = new Map();
  const writes = [];

  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedNow);
      else super(...args);
    }
    static now() { return fixedNow; }
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    Date: FrozenDate,
    Math: Object.create(Math),
    setTimeout() {},
    clearTimeout() {},
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    Store: {
      read(key, fallback) { return store.has(key) ? store.get(key) : fallback; },
      write(key, value) { store.set(key, value); writes.push({ key, value }); },
      onReady() {},          // 不触发数据迁移，测试只关心 id 生成
    },
  };
  // 冻结随机数：唯一性必须由序号计数器保证，而不是靠运气
  sandbox.Math.random = () => 0.5;
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(`${source}\n;globalThis.__DB = DB;`, context, { filename: 'js/data.js' });
  return { DB: sandbox.__DB, store, writes };
}

/* ------------------------------ 用例 ------------------------------ */

console.log('\n🧪 体测记录 id 唯一性回归测试\n');

await test('① 同一毫秒内批量导入 40 条，id 全部不同（修复前只有 1 个唯一 id）', async () => {
  const { DB } = loadDataModule();
  const ids = [];
  for (let index = 0; index < 40; index += 1) {
    const record = DB.addFitnessRecord({ studentId: 'S1', name: `学生${index}`, height: 165 });
    ids.push(record.id);
  }
  const unique = new Set(ids);
  equal(unique.size, 40, '40 条记录必须产生 40 个不同的 id');
  equal(ids.length, unique.size, 'id 列表里不允许有重复');
});

await test('② id 格式保持 "F" 前缀（历史数据兼容，不影响已有记录）', async () => {
  const { DB } = loadDataModule();
  const record = DB.addFitnessRecord({ studentId: 'S1', name: '张三' });
  assert(typeof record.id === 'string', 'id 必须是字符串');
  assert(record.id.startsWith('F'), `id 必须以 F 开头，实际 ${record.id}`);
  assert(record.id.length > 1, 'id 不能只有 F 一个字符');
});

await test('③ 连续 500 次生成仍无碰撞（序号 + 时间戳 + 随机尾巴三重保险）', async () => {
  const { DB } = loadDataModule();
  const ids = new Set();
  for (let index = 0; index < 500; index += 1) {
    ids.add(DB.addFitnessRecord({ studentId: 'S2', name: `学生${index}` }).id);
  }
  equal(ids.size, 500, '500 条记录必须产生 500 个不同的 id');
});

await test('④ saveFitnessRecords 按 id 去重（老数据里的重复 id 不会一直留在库里）', async () => {
  const { DB, store } = loadDataModule();
  const dup = [
    { id: 'F-dup', name: '旧的那条' },
    { id: 'F-dup', name: '新的一条' },
    { id: 'F-other', name: '另一条' },
  ];
  DB.saveFitnessRecords(dup);
  const saved = store.get('pe_fitness_records');
  equal(saved.length, 2, '同 id 只保留一条');
  equal(saved.find(row => row.id === 'F-dup').name, '新的一条', '同 id 保留最后出现的那条');
});

await test('⑤ addFitnessRecord 传入已存在的 id → 顶掉旧记录而不是追加一条', async () => {
  const { DB, store } = loadDataModule();
  DB.addFitnessRecord({ id: 'F-fixed', name: '原始' });
  DB.addFitnessRecord({ id: 'F-fixed', name: '修改后' });
  const saved = store.get('pe_fitness_records');
  equal(saved.length, 1, '同 id 不能变成两条');
  equal(saved[0].name, '修改后', '后写的应当顶掉先写的');
});

await test('⑥ 回归对照：旧写法 `F${Date.now()}` 在同毫秒内必然撞车（证明本测试有效）', async () => {
  const fixedNow = 1750000000000;
  const naive = Array.from({ length: 40 }, () => `F${fixedNow}`);
  const unique = new Set(naive);
  equal(unique.size, 1, '旧生成器 40 条只会得到 1 个 id —— 这就是 duplicate key 的来源');
});

await test('⑦ 体测记录集合能整表写回 Store（写云端时 payload 里 id 互不相同）', async () => {
  const { DB, store } = loadDataModule();
  for (let index = 0; index < 30; index += 1) {
    DB.addFitnessRecord({ studentId: 'S3', name: `学生${index}` });
  }
  const saved = store.get('pe_fitness_records');
  equal(saved.length, 30, '30 条记录都在');
  equal(new Set(saved.map(row => row.id)).size, 30, '写云端的 payload 里 id 必须互不相同（否则整批 INSERT 会被主键约束拒绝）');
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
