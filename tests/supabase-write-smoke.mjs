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
const {
  writeCollectionRows, dedupeRowsById, chunkList, writeData, writeMany,
  isEmptyPayload, unitDesignFilledFields, UNIT_DESIGN_KEY,
  purgeRetiredKeys, STORE_SCHEMA, STORE_KEYS, RETIRED_CLOUD_KEYS, RETIRED_TABLES,
  readAllData, readKey, inspectKey,
} = require(path.join(ROOT, 'lib/supabase.js'));

const STUDENTS_KEY = 'pe_students';

/* 大单元「空壳」：unitSavePayload() 对 createEmptyUnit() 的真实输出形态 ——
   13 个字段、18 个空格子，还带一份自带文字的默认量规模板（rubric 最会骗人）。
   过去后端只看 Object.keys().length，这份东西就被当成有效数据写进 unit_designs。 */
const UNIT_KEY = UNIT_DESIGN_KEY;
function hollowUnit() {
  return {
    meta: { unitTitle: '', category: '', item: '', level: '', topic: '', dimensions: [], generatedAt: '' },
    unitTitle: '', objectives: '', textbookAnalysis: '', studentAnalysis: '', teachingContent: '',
    keyDifficulties: {}, structure_nodes: [], main_projects: [],
    lessons: Array.from({ length: 18 }, (_, index) => ({
      no: index + 1, dimension: '', objectives: '', content: '', method: '',
    })),
    assessment: '', reflection: '',
    rubric: {
      levels: [{ name: '优秀', range: '90-100', ability: '达标', health: '达标', character: '达标' }],
      literacyWeights: [{ literacy: '运动能力', percent: 60 }],
      scoreItems: [{ name: '技能', points: 10, desc: '说明' }], note: '',
    },
  };
}
function fullUnit() {
  const unit = hollowUnit();
  unit.objectives = '运动能力：能在对抗中完成急停急起变向运球。';
  unit.teachingContent = '绕障碍运球接力、原地预摆弹性屈伸。';
  unit.lessons[0].objectives = '能说出屈膝含胸、摆臂蹬地的发力顺序。';
  return unit;
}

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
  /** 所有 from(table) 的访问轨迹：用来断言「students 表再也没被 SELECT 过」 */
  const accesses = [];
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
        select() {
          accesses.push({ op: 'select', table: name });
          pending = { op: 'select', filters: [] };
          return api;
        },
        /* readAllData / readKey 的链式调用：假 client 只需让链路走通 */
        order() { return api; },
        limit() { return api; },
        maybeSingle: async () => ({ data: [...rows.values()][0] || null, error: null }),
        upsert(payload, upsertOptions) {
          accesses.push({ op: 'upsert', table: name });
          calls.push({ type: 'upsert', table: name, payload, options: upsertOptions });
          if (options.failUpsert) {
            return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "fitness_records_pkey"' } });
          }
          // 单例键（unit_designs / app_settings）传的是一行对象，集合键传的是数组
          (Array.isArray(payload) ? payload : [payload]).forEach(row => rows.set(row.id, row));
          return Promise.resolve({ data: null, error: null });
        },
        insert(payload) {
          calls.push({ type: 'insert', table: name, payload });
          payload.forEach(row => rows.set(row.id, row));
          return Promise.resolve({ data: null, error: null });
        },
        delete() {
          accesses.push({ op: 'delete', table: name });
          const call = { type: 'delete', table: name, ids: null };
          calls.push(call);
          pending = { op: 'delete', filters: [], call };
          return api;
        },
        in(column, values) { pending.filters.push({ column, values }); return api; },
        neq(column, value) { pending.filters.push({ column, value }); return api; },
        /* 按 id 等值：purgeRetiredKeys / purgeMeetData 会直接 await .eq('id', key)，
           所以这里要返回既能 await、又能 .maybeSingle() 的结果。DELETE 时真删行并回 count。 */
        eq(column, value) {
          const run = () => {
            const matched = [...rows.keys()].filter(id => String(id) === String(value));
            if (pending.op === 'delete') {
              matched.forEach(id => rows.delete(id));
              if (pending.call) pending.call.ids = matched;
              return { data: null, error: null, count: matched.length };
            }
            return {
              data: [...rows.values()].find(row => String(row[column]) === String(value)) || null,
              error: null,
            };
          };
          return {
            maybeSingle: async () => run(),
            then: (onOk, onErr) => Promise.resolve().then(run).then(onOk, onErr),
          };
        },
        then(onOk, onErr) {
          let result = { data: null, error: null };
          if (pending.op === 'select') {
            result = { data: [...rows.values()].map(row => ({ id: row.id, data: row.data, updated_at: row.updated_at })), error: null };
          } else if (pending.op === 'delete') {
            const inFilter = pending.filters.find(item => Array.isArray(item.values));
            /* 整表 DELETE：purgeRetiredKeys 用 neq('id', 哨兵) 命中全部真实行 */
            const neqFilter = pending.filters.find(item => item.column === 'id'
              && item.value !== undefined && !Array.isArray(item.values));
            let removed = 0;
            if (inFilter) {
              inFilter.values.forEach(id => { if (rows.delete(id)) removed += 1; });
              if (pending.call) pending.call.ids = [...inFilter.values];
            } else if (neqFilter) {
              for (const id of [...rows.keys()]) {
                if (String(id) !== String(neqFilter.value)) { rows.delete(id); removed += 1; }
              }
              if (pending.call) pending.call.ids = removed;
            }
            result = { data: null, error: null, count: removed };
          }
          return Promise.resolve(result).then(onOk, onErr);
        },
      };
      return api;
    },
  };
  return { client, calls, accesses, tables, rowsOf };
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
  const report = await writeMany({ pe_lesson_plans: [], pe_attendance: [{ id: 'A1' }] }, { client });
  const empty = report.find(item => item.key === 'pe_lesson_plans');
  equal(empty.status, 'skipped-empty', '空的那一项要标记为跳过，而不是报错');
  equal(rowsOf('lesson_plans').size, 1, '云端的教案一根都不能少');
  equal(rowsOf('attendance').size, 1, '有数据的键照常写入');
});

await test('⑭ 接口层：空载荷写入返回 400（不是 5xx —— 否则前端会无限重试刷屏）', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
  // 带上管理员密码：这条用例验的是"空载荷被拒"，不是权限（权限由 admin-auth-smoke 覆盖）
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'e2e-admin-secret';
  const { handleDataRequest } = require(path.join(ROOT, 'lib/data-api.js'));
  const req = {
    method: 'POST',
    url: '/api/data',
    headers: { 'x-admin-password': process.env.ADMIN_PASSWORD },
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
    attendance: [{ id: 'A1', data: { id: 'A1' } }],
    lesson_plans: [{ id: 'L1', data: { id: 'L1' } }],
  });
  // 前端 clearKey() 发过来的正是这种请求：value=null + clear + clearIntent
  const result = await writeData('pe_fitness_records', null, { client, clear: true });
  equal(result.count, 0, '清空后写入条数必须是 0');
  equal(rowsOf('fitness_records').size, 0, '体测表必须被清空');
  equal(rowsOf('attendance').size, 1, '考勤记录不能被清空');
  equal(rowsOf('lesson_plans').size, 1, '教案不能被清空');
  assert(!calls.some(call => call.type === 'upsert' && call.table !== 'fitness_records'),
    '清空时不该往其它表写任何东西');
  assert(!calls.some(call => call.type === 'insert'), '清空时一律不许 insert');
});

await test('⑰ 大单元空壳：13 个字段 + 自带文字的默认量规也必须判为空', async () => {
  const hollow = hollowUnit();
  assert(Object.keys(hollow).length > 10, '空壳确实有一堆 key —— 旧的 Object.keys 判定会放行');
  equal(unitDesignFilledFields(hollow).length, 0, '空壳 0 个模块有内容');
  equal(isEmptyPayload(hollow, UNIT_KEY), true, '按内容判定必须识别为空壳');
  const full = fullUnit();
  equal(isEmptyPayload(full, UNIT_KEY), false, '真有内容的大单元不能被误杀');
  assert(unitDesignFilledFields(full).includes('objectives'), '教学目标要算内容');
  assert(unitDesignFilledFields(full).includes('lessons'), '课时文本要算内容');
  equal(isEmptyPayload(hollow, 'pe_lesson_plans'), false, '其它键仍沿用旧口径，不受影响');
});

await test('⑱ 退役键 POST 空壳 → 拒绝写入、不抛错，云端一行都不许新增', async () => {
  const { client, rowsOf, calls } = makeFakeSupabase({ unit_designs: [{ id: UNIT_KEY, data: fullUnit() }] });
  const report = await writeData(UNIT_KEY, hollowUnit(), { client });
  equal(report.status, 'retired', '必须明确标记该键已退役');
  equal(report.retired, true, 'retired 标记');
  equal(report.count, 0, '一行都没写');
  equal(calls.filter(call => call.type === 'upsert').length, 0, '一个 upsert 都不能发');
  equal(rowsOf('unit_designs').size, 1, '历史行原封不动（由 purgeRetiredKeys 统一删）');
});

await test('⑲ 退役键 POST 完整数据 → 同样拒绝上云（架构上就不该有这个键）', async () => {
  const { client, rowsOf, calls } = makeFakeSupabase();
  const report = await writeData(UNIT_KEY, fullUnit(), { client });
  equal(report.count, 0, '不写任何行');
  equal(report.status, 'retired', '回 retired 而不是假装落库成功');
  equal(rowsOf('unit_designs').size, 0, 'unit_designs 里不新增行');
  equal(calls.filter(call => call.type === 'upsert').length, 0, '不发 upsert');
  equal(STORE_SCHEMA[UNIT_KEY], undefined, '云端 schema 里已无该键');
  assert(RETIRED_CLOUD_KEYS[UNIT_KEY]?.table === 'unit_designs', '退役映射仍记得要删哪张表');
});

await test('⑳ purgeRetiredKeys 把云端历史脏行物理删除（按 id DELETE）', async () => {
  const { client, rowsOf, calls } = makeFakeSupabase({ unit_designs: [{ id: UNIT_KEY, data: hollowUnit() }] });
  equal(rowsOf('unit_designs').size, 1, '先造一行历史脏数据');
  const report = await purgeRetiredKeys(client);
  equal(report[0].status, 'ok', '删除成功');
  equal(report[0].deleted, true, '标记已删除');
  equal(report[0].count, 1, '删掉 1 行');
  equal(rowsOf('unit_designs').size, 0, '行彻底消失，不是写空值');
  assert(calls.some(call => call.type === 'delete' && call.table === 'unit_designs'), '确实发了 DELETE');
});

await test('㉑ 其它键的写入日志仍打印 value 长度与前 100 字符', async () => {
  const { client } = makeFakeSupabase();
  const logs = [];
  const origin = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    await writeData('pe_schedule_v1', { week: '第 1 周', rows: [{ day: '周一', content: '快速跑' }] }, { client });
  } finally {
    console.log = origin;
  }
  const line = logs.find(item => item.includes('写入成功'));
  assert(line, '必须有一条写入成功日志');
  assert(/\d+ 字符 \/ \d+ 字节/.test(line), '日志要写清 value 长度');
  assert(line.includes('前 100 字符：'), '日志要打印前 100 字符');
});

await test('㉒ 接口层：退役键 POST 不再谎报 count:1 的假成功', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'e2e-admin-secret';
  const { handleDataRequest } = require(path.join(ROOT, 'lib/data-api.js'));
  const req = {
    method: 'POST', url: '/api/data',
    headers: { 'x-admin-password': process.env.ADMIN_PASSWORD },
    body: { key: UNIT_KEY, value: hollowUnit() },
    on() {},
  };
  let status = 0;
  let payload = null;
  const res = {
    headersSent: false, writableEnded: false,
    writeHead(code) { status = code; },
    end(body) { payload = body ? JSON.parse(body) : null; this.writableEnded = true; },
  };
  await handleDataRequest(req, res);
  equal(status, 200, '老客户端不报错（避免前端重试风暴）');
  const item = payload?.report?.[0];
  equal(item?.status, 'retired', '明确回 retired');
  equal(item?.count, 0, '绝不能回 count:1');
});

await test('㉓ 清理指令 + inspect 诊断：都认得这个已退役的键', async () => {
  const report = await purgeRetiredKeys(makeFakeSupabase().client, ['pe_big_unit_design_v1']);
  equal(report.length, 1, '一条清理结果');
  equal(report[0].table, 'unit_designs', '删的是 unit_designs');
  const unknown = await purgeRetiredKeys(makeFakeSupabase().client, ['pe_not_a_key']);
  equal(unknown[0].status, 'skipped-unknown', '未知键跳过，不乱删');
});

/* ==================== pe_students 彻底退役 ==================== */

await test('㉔ 注册已摘除：STORE_SCHEMA / STORE_KEYS 里没有 pe_students，退役映射到 students 整表', () => {
  equal(STORE_SCHEMA[STUDENTS_KEY], undefined, '云端 schema 不再有这个键');
  assert(!STORE_KEYS.includes(STUDENTS_KEY), '云端键清单不再有这个键');
  equal(RETIRED_CLOUD_KEYS[STUDENTS_KEY]?.table, 'students', '退役映射仍记得要清哪张表');
  equal(RETIRED_CLOUD_KEYS[STUDENTS_KEY]?.wholeTable, true, '集合型旧数据要整表清，不是只删一行');
  assert(RETIRED_TABLES.has('students'), 'students 表列入「绝不 SELECT」名单');
  assert(STORE_KEYS.includes('pe_fitness_records'), '体测记录仍然正常同步');
  assert(STORE_KEYS.includes('pe_offline_resources_v1'), '离线资源库仍然正常同步');
});

await test('㉕ readKey 遇到退役键 / 退役表直接返回 null，一个 SELECT 都不发', async () => {
  const { client, accesses } = makeFakeSupabase({ students: [{ id: 'S1' }] });
  equal(await readKey(client, STUDENTS_KEY, { table: 'students' }), null, '退役键不许读');
  equal(await readKey(client, 'some_future_key', { table: 'students' }), null, '哪怕键名换了，退役表也不许读');
  equal(accesses.filter(item => item.op === 'select').length, 0, '零次 SELECT');
});

await test('㉖ readAllData 整轮同步绝不查询 students 表（只有一次整表清理 DELETE）', async () => {
  const legacy = Array.from({ length: 300 }, (_, i) => ({ id: `S${i}`, data: { id: `S${i}` } }));
  const { client, accesses, rowsOf } = makeFakeSupabase({ students: legacy });
  const result = await readAllData({ client });
  assert(result && result.data, '同步要正常返回');
  equal(accesses.filter(item => item.op === 'select' && item.table === 'students').length, 0,
    'students 表零次 SELECT：几百条废数据不再拖慢启动');
  assert(accesses.some(item => item.op === 'delete' && item.table === 'students'),
    '下次同步顺手发一次整表 DELETE 清理历史脏数据');
  equal(rowsOf('students').size, 0, '整表 300 行被物理删光');
  assert(!Object.prototype.hasOwnProperty.call(result.data, STUDENTS_KEY),
    '同步结果里不该再出现 pe_students 这一格');
});

await test('㉗ 老前端 POST pe_students → writeData 直接拒绝（retired/rejected，0 次 upsert）', async () => {
  const { client, rowsOf, calls, accesses } = makeFakeSupabase({ students: [{ id: 'S1', data: {} }] });
  const report = await writeData(STUDENTS_KEY, [{ id: 'S9', name: '李四' }], { client });
  equal(report.status, 'retired', '明确回 retired');
  equal(report.retired, true, 'retired 标记');
  equal(report.rejected, true, '明确标记「写入被拒绝」');
  equal(report.table, 'students', '回包说清拦在哪张表');
  equal(report.count, 0, '一行都没写');
  equal(accesses.filter(item => item.op === 'upsert' && item.table === 'students').length, 0, '零次 upsert');
  equal(rowsOf('students').size, 1, '云端历史行原封不动，交给 purge 统一删');
  equal(calls.filter(call => call.type === 'insert').length, 0, '也不许 insert');
});

await test('㉘ 旧迁移脚本 { values } 里的 pe_students → 明确回 retired，students 表一根汗毛不动', async () => {
  const { client, rowsOf, accesses } = makeFakeSupabase({ students: [{ id: 'S1' }] });
  const report = await writeMany({ pe_lesson_plans: [{ id: 'L1' }], [STUDENTS_KEY]: [{ id: 'S2' }] }, { client });
  const item = report.find(entry => entry.key === STUDENTS_KEY);
  equal(item?.status, 'retired', '退役键要出现在报告里，而不是无声消失');
  equal(item?.rejected, true, '写明被拒绝');
  equal(item?.count, 0, '没写任何行');
  equal(rowsOf('students').size, 1, '旧名单数据一行都没被写进去');
  equal(rowsOf('lesson_plans').size, 1, '其它键照常迁移');
  assert(!accesses.some(entry => entry.op === 'upsert' && entry.table === 'students'), 'students 零次 upsert');
});

await test('㉙ purgeRetiredKeys 把 students 整表几百行物理删光；unit_designs 仍只删指定行', async () => {
  const legacy = Array.from({ length: 300 }, (_, i) => ({ id: `S${i}`, data: {} }));
  const { client, rowsOf, calls } = makeFakeSupabase({
    students: legacy,
    unit_designs: [{ id: UNIT_KEY, data: hollowUnit() }, { id: 'keep-me', data: fullUnit() }],
  });
  const report = await purgeRetiredKeys(client);
  const students = report.find(item => item.key === STUDENTS_KEY);
  equal(students?.status, 'ok', '整表清理成功');
  equal(students?.wholeTable, true, '标记为整表清理');
  equal(students?.count, 300, '300 行全删');
  equal(rowsOf('students').size, 0, 'students 表彻底清空');
  equal(rowsOf('unit_designs').size, 1, 'unit_designs 只删 id=key 那一行，别的不动');
  assert(calls.some(call => call.type === 'delete' && call.table === 'students'), '确实发了 DELETE');
});

await test('㉚ 手动 DROP TABLE 之后：清理识别为 dropped，不再当成失败刷告警', async () => {
  const missing = { code: '42P01', message: 'relation "public.students" does not exist' };
  const thenable = { then: (onOk, onErr) => Promise.reject(missing).then(onOk, onErr) };
  const client = {
    from: () => ({ delete: () => ({ neq: () => thenable, eq: () => thenable }) }),
  };
  const report = await purgeRetiredKeys(client, [STUDENTS_KEY]);
  equal(report[0].status, 'dropped', '表已不存在，回 dropped 而不是 error');
  equal(report[0].count, 0, '没有行可删');
});

await test('㉛ inspect 诊断 + 接口层 POST：都认得 pe_students 已退役', async () => {
  const { client, accesses } = makeFakeSupabase({ students: [{ id: 'S1' }] });
  const info = await inspectKey(STUDENTS_KEY, { client });
  equal(info.retired, true, '诊断明确说它已退役');
  equal(info.table, 'students', '指向历史表');
  equal(info.wholeTable, true, '说明它是整表型旧数据');
  equal(accesses.filter(item => item.op === 'select').length, 0, 'inspect 不查表、更不删行');

  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'e2e-admin-secret';
  const { handleDataRequest } = require(path.join(ROOT, 'lib/data-api.js'));
  const req = {
    method: 'POST', url: '/api/data',
    headers: { 'x-admin-password': process.env.ADMIN_PASSWORD },
    body: { key: STUDENTS_KEY, value: [{ id: 'S9' }] },
    on() {},
  };
  let status = 0;
  let payload = null;
  const res = {
    headersSent: false, writableEnded: false,
    writeHead(code) { status = code; },
    end(body) { payload = body ? JSON.parse(body) : null; this.writableEnded = true; },
  };
  await handleDataRequest(req, res);
  equal(status, 200, '老客户端不报错（避免重试风暴）');
  equal(payload?.report?.[0]?.status, 'retired', '接口层明确回 retired，不谎报 ok');
  equal(payload?.report?.[0]?.rejected, true, '接口层明确回「写入被拒绝」');
  equal(payload?.report?.[0]?.count, 0, '绝不能回 count:1');
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
