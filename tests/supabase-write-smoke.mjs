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
const { writeCollectionRows, dedupeRowsById, chunkList } = require(path.join(ROOT, 'lib/supabase.js'));

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
        delete() { calls.push({ type: 'delete', table: name }); pending = { op: 'delete', filters: [] }; return api; },
        in(column, values) { pending.filters.push({ column, values }); return api; },
        neq(column, value) { pending.filters.push({ column, value }); return api; },
        then(onOk, onErr) {
          let result = { data: null, error: null };
          if (pending.op === 'select') {
            result = { data: [...rows.values()].map(row => ({ id: row.id })), error: null };
          } else if (pending.op === 'delete') {
            const filter = pending.filters.find(item => item.values);
            if (filter) filter.values.forEach(id => rows.delete(id));
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

await test('③ 写成功后才删旧行：本次没带的旧记录要从云端消失（整表替换语义）', async () => {
  const { client, calls, rowsOf } = makeFakeSupabase({
    fitness_records: [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }],
  });
  const result = await writeCollectionRows(client, 'fitness_records', [{ id: 'F1', data: {} }], {});
  equal(result.written, 1, '写入 1 条');
  equal(result.removed, 2, '删掉 2 条旧行');
  equal(rowsOf('fitness_records').size, 1, '表里只剩这次带来的那条');
  const order = calls.map(call => call.type);
  equal(order[0], 'upsert', '第一个动作必须是 upsert（先写后删）');
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

await test('⑤ 空数据 + 没有清空意图 → 一行都不删（不许把云端洗成 0 条）', async () => {
  const { client, calls, rowsOf } = makeFakeSupabase({ fitness_records: [{ id: 'F1' }, { id: 'F2' }] });
  const result = await writeCollectionRows(client, 'fitness_records', [], {});
  equal(result.skippedClear, true, '要明确报告"这次是空写入，已跳过清空"');
  equal(rowsOf('fitness_records').size, 2, '云端的行一根都不能少');
  equal(calls.filter(call => call.type === 'delete').length, 0, '不许发出任何删除');
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
  await writeCollectionRows(client, 'fitness_records', [{ id: 'F-new' }], {});
  equal(rowsOf('fitness_records').size, 1, '120 条旧行全部清掉，只剩新的那条');
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
