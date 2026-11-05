/**
 * 【一键清空体测数据】界面回归测试（无浏览器依赖，node tests/fitness-purge-ui-smoke.mjs 直接跑）
 *
 * 覆盖：
 *   ① 页面顶部确实有红色的【🗑️ 清空体测数据】按钮；
 *   ② 点按钮弹出确认框，里面写清楚"清什么 / 不清什么"，并要求手动输入 DELETE；
 *   ③ 没输入 DELETE 时绝不清空（只提示）；
 *   ④ 输入 DELETE 后调用 Store.clearKey('pe_fitness_records')，成功后刷新页面数据。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FITNESS_SOURCE = fs.readFileSync(path.join(ROOT, 'js/fitness.js'), 'utf8');

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

console.log('\n🧪 一键清空体测数据 · 界面回归测试\n');

/* ================= 假数据 ================= */

const STUDENTS = [
  { id: 'S1', name: '张三', gender: '男', grade: '三年级', class: '三1班' },
  { id: 'S2', name: '李四', gender: '女', grade: '三年级', class: '三2班' },
];
const RECORDS = [
  { id: 'F1', studentId: 'S1', studentName: '张三', grade: '三年级', class: '三1班', testType: 'run50', testName: '50米跑', unit: '秒', value: 8.1, testDate: '2026-10-01' },
  { id: 'F2', studentId: 'S2', studentName: '李四', grade: '三年级', class: '三2班', testType: 'jumpRope', testName: '1分钟跳绳', unit: '个', value: 120, testDate: '2026-10-01' },
];

/* ================= 沙箱 ================= */

function createEnv() {
  const nodes = new Map();
  const makeNode = id => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, className: '',
    dataset: {}, style: {}, checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, focus() {},
    closest: () => null, appendChild() {}, remove() {},
  });
  const documentStub = {
    readyState: 'complete',
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeNode(id));
      return nodes.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeNode('tmp'),
    body: null,
  };

  const toasts = [];
  const modals = [];
  const clearCalls = [];
  let storeData = { pe_fitness_records: RECORDS };

  const context = vm.createContext({
    document: documentStub,
    console,
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    setTimeout, clearTimeout,
    Layout: { init() {} },
    DB: {
      FITNESS_ITEMS: [{ key: 'run50', name: '50米跑', unit: '秒', icon: '🏃' }],
      // 名册由体测记录派生（系统里已无独立的学生名单）
      getFitnessStudents: () => {
        const map = new Map();
        storeData.pe_fitness_records.forEach(record => {
          const id = String(record.studentId || '');
          if (!id || map.has(id)) return;
          map.set(id, {
            id,
            name: record.studentName || '',
            gender: record.gender || '',
            grade: record.grade || '',
            class: record.class || '',
          });
        });
        return [...map.values()];
      },
      getFitnessRecords: () => storeData.pe_fitness_records,
      getGrade: () => ({ level: '及格', class: 'pass' }),
      getFitnessScore: () => null,
    },
    Store: {
      read: (key, fallback = []) => (key in storeData ? storeData[key] : fallback),
      write: (key, value) => { storeData[key] = value; },
      onReady: () => () => {},
      clearKey: async (key, options) => {
        clearCalls.push({ key, options });
        storeData[key] = [];
        return { ok: true, mode: 'supabase', key, cloudCleared: true };
      },
    },
    showToast: (message, type = 'success') => toasts.push({ message, type }),
    // 成绩册在另一个文件里（这个用例只关心"清空"流程），给个最小替身即可
    FITNESS_GRADEBOOK_STATE: { grade: 'all', className: 'all', search: '', sort: 'desc' },
    renderFitnessGradebookTable: () => '',
    fitnessGradebookBuild: () => ({ state: {}, students: [], rows: [], columns: [] }),
    updateFitnessWeakChart: () => {},
    showModal: (title, bodyHTML, footerHTML = '', overlayClass = '') => {
      modals.push({ title, bodyHTML, footerHTML, overlayClass });
      return makeNode('overlay');
    },
    closeModal: () => {},
  });
  context.globalThis = context;
  new vm.Script(`${FITNESS_SOURCE}\n;globalThis.__env = { requestFitnessPurge, confirmFitnessPurge };`,
    { filename: 'js/fitness.js' }).runInContext(context);

  return {
    nodes, modals, toasts, clearCalls, context,
    pageHTML: () => nodes.get('page-content')?.innerHTML || '',
    input: () => nodes.get('fitnessPurgeConfirm'),
  };
}

/* ================= 用例 ================= */

await test('① 页面顶部有红色的【🗑️ 清空体测数据】按钮', () => {
  const env = createEnv();
  const html = env.pageHTML();
  assert(html.includes('requestFitnessPurge()'), '页面必须有调用 requestFitnessPurge() 的按钮');
  assert(html.includes('清空体测数据'), '按钮上要写明"清空体测数据"');
  assert(html.includes('btn-danger'), '按钮必须是危险色（红色）');
});

await test('② 点按钮弹出确认框：写清清什么 / 不清什么，并要求输入 DELETE', () => {
  const env = createEnv();
  env.context.__env.requestFitnessPurge();
  equal(env.modals.length, 1, '应弹出且只弹一个确认框');
  const modal = env.modals[0];
  assert(modal.bodyHTML.includes('DELETE'), '确认框必须要求输入 DELETE');
  assert(modal.bodyHTML.includes('2'), '确认框要显示将要删除的记录条数');
  assert(modal.bodyHTML.includes('教案'), '确认框要说明其它数据（教案等）不受影响');
  assert(modal.footerHTML.includes('confirmFitnessPurge'), '确认按钮必须走二次确认');
});

await test('③ 没输入 DELETE 时绝不清空，只给提示', async () => {
  const env = createEnv();
  env.context.__env.requestFitnessPurge();
  env.input().value = 'delete';           // 大小写不对
  await env.context.__env.confirmFitnessPurge();
  equal(env.clearCalls.length, 0, '没输入正确的确认词时绝不能调用 clearKey');
  assert(env.toasts.some(item => item.type === 'error'), '应该给出错误提示');
});

await test('④ 输入 DELETE 后调用 clearKey 清空体测数据，并刷新页面', async () => {
  const env = createEnv();
  env.context.__env.requestFitnessPurge();
  env.input().value = ' DELETE ';
  await env.context.__env.confirmFitnessPurge();
  equal(env.clearCalls.length, 1, '应调用一次 clearKey');
  equal(env.clearCalls[0].key, 'pe_fitness_records', '只能清体测数据这一个键');
  assert(env.toasts.some(item => item.type === 'success' && item.message.includes('已清空体测数据')),
    '清空成功要有成功提示');
  equal(env.nodes.get('fitnessTotalRecords')?.textContent, 0, '总记录数要立刻变成 0');
});

/* ------------------------------ 汇总 ------------------------------ */
const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exit(1);
