/**
 * 后端写入安全性回归测试（node tests/supabase-write-smoke.mjs 直接跑）
 *
 * 复现的是那次「上传体测数据 → 云端报 duplicate key → 刷新后本地云端全空」的现场：
 *   ① 批量导入体测记录时，for 循环里连续用 `F${Date.now()}` 生成 id → 几十条记录 id 全撞车
 *   ② 服务端是"先 DELETE 全表、再 INSERT"：INSERT 整批失败 → 表被清空，而一条数据没写进去
 *   ③ 前端拿到 502 后一直重试 → 每一轮都先 DELETE → 云端永远是 0 条
 *   ④ 刷新时云端返回空数组 → SWR 把本地那份真实数据覆盖掉 → 双空
 *
 * 这里用假的 Supabase 客户端把第 ②③ 步钉死：
 *   · 必须走 upsert（onConflict: 'id'），不能再出现 insert
 *   · 顺序必须是"先写后删"：upsert 失败时旧数据必须一根汗毛都不少
 *   · 同 id 的行必须去重（撞车不再触发主键冲突）
 *   · 空数据且没有清空意图时，一行都不许删
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { writeCollectionRows, dedupeRowsById, chunkList, writeData, writeMany } = require(path.join(ROOT, 'lib/supabase.js'));

/* ------------------------------ 断言器 ------------------------------ */

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
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

/* ------------------------------ 假 Supabase 客户端 ------------------------------ */

/**
 * @param {Record<string, Array>} initial 表名 → 初始行
 * @param {{failUpsert?: boolean}} options 让 upsert 失败（模拟主键冲突 / 字段类型不符）
 */
function makeFakeSupabase(initial = {}, options = {}) {
  const calls = [];
  const tables = new Map();
  Object.entries(initial).forEach(([name, list]) => {
    tables.set(name, new Map(list.map(row => [row.id, row])));
  });
  const rowsOf = name => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };

  const client = {
    from(name) {
      const rows = rowsOf(name);
      let pending = { op: 'select', filters: [] };
      const api = {
        select() { pending = { op: 'select', filters: [] }; return api; },
        upsert(payload, upsertOptions) {
          calls.push({ type: 'upsert', table: name, payload, options: upsertOptions });
          if (options.failUpsert) {
            return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "fitness_records_pkey"' } });
          }
          payload.forEach(row => rows.set(row.id, row));
          return Promise.resolve({ data: null, error: null });
        },
        insert(payload) {
          calls.push({ type: 'insert', table: name, payload });
          payload.forEach(row => rows.set(row.id, row));
          return Promise.resolve({ data: null, error: null });
        },
        delete() {
          const call = { type: 'delete', table: name, ids: null };
          calls.push(call);
          pending = { op: 'delete', filters: [], call };
          return api;
        },
        in(column, values) { pending.filters.push({ column, values }); return api; },
        neq(column, value) { pending.filters.push({ column, value }); return api; },
        then(onOk, onErr) {
          let result = { data: null, error: null };
          if (pending.op === 'select') {
            result = { data: [...rows.values()].map(row => ({ id: row.id, updated_at: row.updated_at })), error: null };
          } else if (pending.op === 'delete') {
            const filter = pending.filters.find(item => item.values);
            if (filter) {
              filter.values.forEach(id => rows.delete(id));
              if (pending.call) pending.call.ids = [...filter.values];
            }
            result = { data: null, error: null };
          }
          return Promise.resolve(result).then(onOk, onErr);
        },
      };
      return api;
    },
  };
  return { client, calls, tables, rowsOf };
}

/* ------------------------------ 用例 ------------------------------ */

console.log('\n🧪 Supabase 写入安全回归测试\n');

await test('① 必须用 upsert(onConflict: id)，绝不能再出现 insert', async () => {
  const { client, calls, rowsOf } = makeFakeSupabase({ fitness_records: [{ id: 'F1' }] });
  const payload = [{ id: 'F1', data: { v: 1 } }, { id: 'F2', data: { v: 2 } }];
  await writeCollectionRows(client, 'fitness_records', payload, {});
  const upserts = calls.filter(call => call.type === 'upsert');
  equal(upserts.length, 1, '必须调用一次 upsert');
  equal(upserts[0].options?.onConflict, 'id', '必须指定 onConflict: id');
  equal(calls.filter(call => call.type === 'insert').length, 0, '不能再调用 insert');
  equal(rowsOf('fitness_records').size, 2, '两条数据都要在表里');
});

await test('② 先写后删：upsert 失败时旧数据一根汗毛都不能少（表绝不能被洗空）', async () => {
  const { client, calls, rowsOf } = makeFakeSupabase(
    { fitness_records: [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }] },
    { failUpsert: true },
  );
  let threw = false;
  try {
    await writeCollectionRows(client, 'fitness_records', [{ id: 'F1', data: {} }], {});
  } catch (error) {
    threw = true;
  }
  assert(threw, 'upsert 失败必须把错误抛出去（前端据此判定写入失败）');
  equal(rowsOf('fitness_records').size, 3, '写入失败时旧数据必须完整保留 —— 这一条就是"表被洗空"的防线');
  equal(calls.filter(call => call.type === 'delete').length, 0, '写入失败时不得执行任何删除');
});

await test('③ 只 upsert、不推断删除：没带 deletedIds 就一个旧行都不许删（旧快照伤不到新数据）', async () => {
  const { client, calls, rowsOf } = makeFakeSupabase({
    fitness_records: [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }],
  });
  const result = await writeCollectionRows(client, 'fitness_records', [{ id: 'F1', data: {} }], {});
  equal(result.written, 1, '写入 1 条');
  equal(result.removed, 0, '没点名要删 → 一条都不许删（这就是"空数据自杀式覆盖"的根治点）');
  equal(rowsOf('fitness_records').size, 3, '云端的老行必须原封不动');
  equal(calls.filter(call => call.type === 'delete').length, 0, '不许发出任何删除');
  equal(calls[0].type, 'upsert', '第一个动作必须是 upsert');
});

await test('③b 点了名要删的 id 才会被删（且只删这些）', async () => {
  const { client, calls, rowsOf } = makeFakeSupabase({
    fitness_records: [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }],
  });
  const result = await writeCollectionRows(client, 'fitness_records', [{ id: 'F1', data: {} }], {
    deletedIds: ['F2'],
  });
  equal(result.removed, 1, '只删了点名的 F2');
  const ids = [...rowsOf('fitness_records').keys()].sort();
  equal(ids.join(','), 'F1,F3', 'F3 没被点名，必须留下');
  const order = calls.map(call => call.type);
  assert(order.indexOf('upsert') < order.indexOf('delete'), '删除必须发生在写入之后');
});


await test('④ 同 id 去重：批量导入时 id 撞车不再触发主键冲突', async () => {
  const rows = [
    { id: 'F1750000000000', data: { v: 1 } },
    { id: 'F1750000000000', data: { v: 2 } },
    { id: 'F1750000000001', data: { v: 3 } },
  ];
  const deduped = dedupeRowsById(rows);
  equal(deduped.length, 2, '同 id 只保留一条');
  equal(deduped.find(row => row.id === 'F1750000000000').data.v, 2, '同 id 保留最后出现的那条');
  const { client, calls } = makeFakeSupabase({ fitness_records: [] });
  await writeCollectionRows(client, 'fitness_records', deduped, {});
  const upserted = calls.find(call => call.type === 'upsert');
  equal(new Set(upserted.payload.map(row => row.id)).size, upserted.payload.length, '写进数据库的 id 必须互不相同');
});

await test('⑤ 空载荷 + 没有清空意图 → 直接抛错中断（一个字节都不写、一个字节都不删）', async () => {
  const { client, calls, rowsOf } = makeFakeSupabase({ fitness_records: [{ id: 'F1' }, { id: 'F2' }] });
  let error = null;
  try {
    await writeCollectionRows(client, 'fitness_records', [], {});
  } catch (thrown) {
    error = thrown;
  }
  assert(error, '必须抛错中断');
  equal(error.status, 400, '必须是 400');
  equal(rowsOf('fitness_records').size, 2, '云端的行一根都不能少');
  equal(calls.length, 0, '连一次 upsert / delete 都不许发');
});


await test('⑥ 空数据 + 明确清空意图（clear=true）→ 才允许把表清空', async () => {
  const { client, rowsOf } = makeFakeSupabase({ fitness_records: [{ id: 'F1' }, { id: 'F2' }] });
  const result = await writeCollectionRows(client, 'fitness_records', [], { clear: true });
  equal(result.skippedClear, undefined, '明确清空时不跳过一次清空');
  equal(rowsOf('fitness_records').size, 0, '用户亲手清空才允许删光');
});

await test('⑦ 删除分批：一次删几百行也不会把 URL 撑爆', async () => {
  equal(chunkList([1, 2, 3, 4, 5], 2).length, 3, '5 个按 2 个一批 = 3 批');
  equal(chunkList([], 50).length, 0, '空数组不产生批次');
  const rows = Array.from({ length: 120 }, (_, index) => ({ id: `F${index}` }));
  const { client, rowsOf } = makeFakeSupabase({ fitness_records: rows });
  await writeCollectionRows(client, 'fitness_records', [{ id: 'F-new' }], {
    deletedIds: rows.map(row => row.id),
  });
  equal(rowsOf('fitness_records').size, 1, '120 条点名要删的旧行全部清掉，只剩新的那条');
});


await test('⑧ 空载荷（空数组）+ 没有 clearIntent → 直接 400 拒绝，一个字都不许写', async () => {
  const { client, calls, rowsOf } = makeFakeSupabase({ lesson_plans: [{ id: 'L1' }] });
  let error = null;
  try {
    await writeData('pe_lesson_plans', [], { client });
  } catch (thrown) {
    error = thrown;
  }
  assert(error, '必须抛错（前端据此判定这次没写进去）');
  equal(error.status, 400, '必须是 400 —— 不能是 5xx，否则前端会当成"暂时失败"无限重试');
  equal(error.code, 'EMPTY_PAYLOAD_REFUSED', '错误码要能被识别');
  equal(rowsOf('lesson_plans').size, 1, '云端的数据一根都不能少');
  equal(calls.length, 0, '连一次 upsert / delete 都不许发');
});

await test('⑨ clearIntent=true（用户亲手清空）→ 才允许把表清空', async () => {
  const { client, rowsOf } = makeFakeSupabase({ lesson_plans: [{ id: 'L1' }, { id: 'L2' }] });
  await writeData('pe_lesson_plans', [], { client, clear: true });
  equal(rowsOf('lesson_plans').size, 0, '用户亲手清空才允许删光');
});

await test('⑩ 单例键写 null 且没有 clearIntent → 同样 400 拒绝（不许删行）', async () => {
  const { client, calls, rowsOf } = makeFakeSupabase({ app_settings: [{ id: 'pe_week_mode' }] });
  let error = null;
  try {
    await writeData('pe_week_mode', null, { client });
  } catch (thrown) {
    error = thrown;
  }
  assert(error, '必须拒绝');
  equal(error.status, 400, '必须是 400');
  equal(rowsOf('app_settings').size, 1, '那一行不能被删');
  equal(calls.filter(call => call.type === 'delete').length, 0, '不许发出删除');
});

await test('⑪ 并发保护：别人在我之后写的行（updated_at 更新）不会被我的旧快照删掉', async () => {
  const older = new Date(Date.now() - 60000).toISOString();
  const newer = new Date(Date.now() + 60000).toISOString();     // 比服务端本次写入还新
  const { client, rowsOf } = makeFakeSupabase({
    lesson_plans: [
      { id: 'L-old', updated_at: older },   // 比我这次写入更旧 → 该删
      { id: 'L-new', updated_at: newer },   // 别人刚写的 → 一个都不许删
    ],
  });
  await writeData('pe_lesson_plans', [{ id: 'L-mine', data: {} }], {
    client,
    deletedIds: ['L-old', 'L-new'],
  });
  const ids = [...rowsOf('lesson_plans').keys()];
  assert(ids.includes('L-mine'), '我这条必须写进去');
  assert(ids.includes('L-new'), '别人在我之后写的行必须留下（并发保护）');
  assert(!ids.includes('L-old'), '比我旧、且点名要删的行应该被删掉');
});

await test('⑫ 删除永远按【id 列表】执行，绝不出现整表 DELETE', async () => {
  const { client, calls } = makeFakeSupabase({
    lesson_plans: [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }],
  });
  await writeData('pe_lesson_plans', [{ id: 'L1', data: {} }], { client, deletedIds: ['L2', 'L3'] });
  const deletes = calls.filter(call => call.type === 'delete');
  equal(deletes.length, 1, '应该只有一次删除');
  assert(Array.isArray(deletes[0].ids) && deletes[0].ids.length === 2,
    '删除必须带上明确的 id 列表（没有 id 列表 = 整表 DELETE，一律禁止）');
  assert(!deletes[0].ids.includes('L1'), '保留下来的行不能被删');
});

await test('⑯ 旧快照推上来时，云端的新数据一根都不能少（核心防线）', async () => {
  // 手机端拿着旧快照（只有 L1）推上来，云端其实已经有 L1 + L2（电脑端刚生成的）
  const { client, rowsOf } = makeFakeSupabase({
    lesson_plans: [{ id: 'L1' }, { id: 'L2' }],
  });
  await writeData('pe_lesson_plans', [{ id: 'L1', data: {} }], { client });
  const ids = [...rowsOf('lesson_plans').keys()].sort();
  equal(ids.join(','), 'L1,L2', '旧快照绝不能把云端那条新教案当成"该删的旧行"删掉');
});


await test('⑬ 批量迁移：空的那一项标记为 skipped-empty（不算失败），云端一个字节都不动', async () => {
  const { client, rowsOf } = makeFakeSupabase({ lesson_plans: [{ id: 'L1' }] });
  const report = await writeMany({ pe_lesson_plans: [], pe_students: [{ id: 'S1' }] }, { client });
  const empty = report.find(item => item.key === 'pe_lesson_plans');
  equal(empty.status, 'skipped-empty', '空的那一项要标记为跳过，而不是报错');
  equal(rowsOf('lesson_plans').size, 1, '云端的教案一根都不能少');
  equal(rowsOf('students').size, 1, '有数据的键照常写入');
});

await test('⑭ 接口层：空载荷写入返回 400（不是 5xx —— 否则前端会无限重试刷屏）', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
  const { handleDataRequest } = require(path.join(ROOT, 'lib/data-api.js'));
  const req = {
    method: 'POST',
    url: '/api/data',
    body: { key: 'pe_lesson_plans', value: [] },
    on() {},
  };
  let status = 0;
  let payload = null;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code) { status = code; },
    end(body) { payload = body ? JSON.parse(body) : null; this.writableEnded = true; },
  };
  await handleDataRequest(req, res);
  equal(status, 400, '接口必须返回 400');
  equal(payload.code, 'EMPTY_PAYLOAD_REFUSED', '要带可识别的错误码');
  assert(payload.hint, '要给出修复办法的提示');
});

await test('⑮ snapshotAt 并发保护：另一台设备在我这份快照【之后】写的行，一个都不许删', async () => {
  const snapshotAt = new Date(Date.now() - 60000).toISOString();        // 我的快照是 1 分钟前
  const afterSnapshot = new Date(Date.now() - 30000).toISOString();    // 对方在我快照之后写的
  const { client, rowsOf } = makeFakeSupabase({
    lesson_plans: [
      { id: 'L-old', updated_at: new Date(Date.now() - 120000).toISOString() }, // 我快照之前就有的旧行 → 该删
      { id: 'L-new', updated_at: afterSnapshot },                              // 我快照之后对方写的 → 必须留下
    ],
  });
  await writeData('pe_lesson_plans', [{ id: 'L-mine', data: {} }], {
    client,
    snapshotAt,
    deletedIds: ['L-old', 'L-new'],
  });
  const ids = [...rowsOf('lesson_plans').keys()];
  assert(ids.includes('L-new'), '对方在我快照之后写的行必须留下（两端同时在线不能互相抹掉）');
  assert(!ids.includes('L-old'), '我快照之前就存在、且点名要删的行应该被删掉');
  assert(ids.includes('L-mine'), '我这条必须写进去');
});

await test('⑯ 一键清空体测数据（clearIntent）→ 体测表整表清空，其它表一根汗毛都不少', async () => {
  const { client, rowsOf, calls } = makeFakeSupabase({
    fitness_records: [
      { id: 'F1', data: { id: 'F1', studentId: 'S1' } },
      { id: 'F2', data: { id: 'F2', studentId: 'S2' } },
    ],
    students: [{ id: 'S1', data: { id: 'S1', name: '张三' } }],
    lesson_plans: [{ id: 'L1', data: { id: 'L1' } }],
  });
  // 前端 clearKey() 发过来的正是这种请求：value=null + clear + clearIntent
  const result = await writeData('pe_fitness_records', null, { client, clear: true });
  equal(result.count, 0, '清空后写入条数必须是 0');
  equal(rowsOf('fitness_records').size, 0, '体测表必须被清空');
  equal(rowsOf('students').size, 1, '学生名单不能被清空');
  equal(rowsOf('lesson_plans').size, 1, '教案不能被清空');
  assert(!calls.some(call => call.type === 'upsert' && call.table !== 'fitness_records'),
    '清空时不该往其它表写任何东西');
  assert(!calls.some(call => call.type === 'insert'), '清空时一律不许 insert');
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
