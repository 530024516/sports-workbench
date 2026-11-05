/**
 * 体测 · 页面打印 回归测试
 * node tests/fitness-print-smoke.mjs 直接跑
 *
 * 覆盖：
 *   ① 三个页面右上角都有绿色【🖨️ 打印当前页面】按钮
 *   ② 页眉：INh工作台 - [体测数据/成绩排名/统计分析看板] 打印时间：…
 *   ③ 纸张方向：成绩列表/排名 横向，看板 纵向
 *   ④ 打印件里没有导航/筛选器/按钮/事件属性
 *   ⑤ 图表被换成 Base64 高清图片（getDataURL pixelRatio:2）
 *   ⑥ 表格主体保留，成绩册"上成绩 / 下得分"两行排版保留
 *   ⑦ 打印走隐藏 iframe → iframe.contentWindow.print()
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

console.log('\n🧪 体测页面打印回归测试\n');

/* ================= 打印区里的假页面 ================= */

const CONTENT_HTML = `
  <div class="fitness-bi-control">
    <div class="fitness-bi-tab-row">
      <button class="fitness-bi-tab is-active" onclick="switchGrade('三年级')">三年级</button>
      <button class="fitness-bi-tab" onclick="switchGrade('一年级')">一年级</button>
    </div>
    <div class="fitness-bi-control-actions">
      <span class="fitness-bi-scope" id="fitnessDashboardScope">三年级 · 12 人</span>
      <button class="btn btn-secondary" onclick="exportCsv()">⬇️ 导出 CSV</button>
    </div>
  </div>
  <div class="card">
    <div class="card-header">
      <span class="card-title">📋 体测成绩册</span>
      <select class="form-control" id="recordsGradeFilter"><option>全部年级</option></select>
    </div>
    <div class="table-wrapper">
      <table class="data-table fitness-gradebook-table">
        <thead><tr><th>姓名</th><th>身高</th></tr></thead>
        <tbody>
          <tr>
            <td><button type="button" class="fitness-gb-name-link" onclick="openFitnessDiagnosis(0)">张一</button></td>
            <td><span class="fitness-gb-val">140<span class="fitness-gb-unit">cm</span></span><span class="fitness-gb-pts is-good">80</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <div class="fitness-weak-chart" id="fitnessWeakChart"><canvas width="800" height="300"></canvas></div>
  </div>
`;

function createEnv() {
  const calls = { getDataURL: [], printed: false, written: '', focused: 0 };

  const makeElement = (id, extra = {}) => ({
    id,
    innerHTML: '',
    textContent: '',
    style: {},
    value: '',
    ...extra,
  });

  const chartElement = makeElement('fitnessWeakChart');
  chartElement.__chart = {
    getWidth: () => 800,
    getHeight: () => 300,
    getDataURL: options => {
      calls.getDataURL.push({ id: 'fitnessWeakChart', options });
      return 'data:image/png;base64,QUJD';
    },
  };

  const content = makeElement('fitnessContent', { innerHTML: CONTENT_HTML });
  const scope = makeElement('fitnessDashboardScope', { textContent: '三年级 · 12 人' });

  const frame = makeElement('fitnessPrintFrame');
  frame.contentWindow = {
    document: {
      open() {}, close() {},
      write(html) { calls.written = html; },
    },
    print() { calls.printed = true; },
    focus() { calls.focused += 1; },
  };

  const elements = new Map([
    ['fitnessContent', content],
    ['fitnessDashboardScope', scope],
    ['fitnessPrintFrame', frame],
    ['fitnessWeakChart', chartElement],
  ]);

  const documentStub = {
    readyState: 'complete',
    baseURI: 'http://localhost/fitness.html',
    getElementById(id) { return elements.get(id) || null; },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createElement: () => makeElement('tmp'),
    body: { appendChild() {}, removeChild() {} },
  };

  const context = vm.createContext({
    document: documentStub,
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math,
    RegExp, URL, isNaN, parseFloat, parseInt,
    setTimeout, clearTimeout,
    navigator: {},
    echarts: {
      getInstanceByDom: element => (element && element.__chart) || null,
    },
    Store: { read: () => [], write: () => {}, onReady: () => () => {} },
    showToast: () => {},
    Layout: { init() {} },
    frameSize: () => ({ width: frame.style.width, height: frame.style.height }),
  });
  context.globalThis = context;
  context.window = context;
  context.parent = context;
  context.location = { search: '', href: 'http://localhost/fitness.html' };
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.dispatchEvent = () => {};

  new vm.Script(fs.readFileSync(path.join(ROOT, 'js/fitness-print.js'), 'utf8'), { filename: 'js/fitness-print.js' })
    .runInContext(context);

  new vm.Script(`globalThis.__api = {
    header: title => fitnessPrintHeaderHTML(title),
    now: () => fitnessPrintNowText(),
    body: (rawHTML, chartImages) => fitnessPrintBuildBodyHTML(rawHTML, chartImages),
    pageBody: key => {
      if (key === 'ranking') return fitnessPrintRankingBody();
      if (key === 'dashboard') return fitnessPrintDashboardBody();
      return fitnessPrintRecordsBody();
    },
    document: (key, body) => fitnessPrintDocumentHTML(FITNESS_PRINT_PAGES[key], body),
    print: key => printFitnessPage(key),
    orientation: key => FITNESS_PRINT_PAGES[key].orientation,
    chartDataURL: id => fitnessPrintChartDataURL(id),
    removeByClass: (html, cls) => fitnessPrintRemoveByClass(html, cls),
    strip: html => fitnessPrintStripInteractive(html),
    replaceImage: (html, id, url) => fitnessPrintReplaceWithImage(html, id, url),
    frameSize: () => frameSize(),
  };`, { filename: 'extract.js' }).runInContext(context);

  return { api: context.__api, calls };
}

/* ================= 用例 ================= */

await test('① 三个页面右上角都有绿色的【🖨️ 打印当前页面】按钮', async () => {
  const records = fs.readFileSync(path.join(ROOT, 'js/fitness.js'), 'utf8');
  const ranking = fs.readFileSync(path.join(ROOT, 'js/fitness-ranking.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(ROOT, 'js/fitness-dashboard.js'), 'utf8');

  assert(records.includes("printFitnessPage('records')"), '成绩列表要有打印按钮');
  assert(ranking.includes("printFitnessPage('ranking')"), '成绩排名要有打印按钮');
  assert(dashboard.includes("printFitnessPage('dashboard')"), '统计分析看板要有打印按钮');

  [records, ranking, dashboard].forEach(source => {
    assert(source.includes('btn-success'), '打印按钮要用绿色样式 btn-success');
    assert(source.includes('🖨️ 打印当前页面'), '按钮文案要一致');
  });

  // 绿色按钮样式要在全局 CSS 里
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  assert(/\.btn-success\s*\{[^}]*var\(--success\)/.test(css), '全局 CSS 要有 .btn-success 绿色按钮');
});

await test('② 页眉格式：INh工作台 - [标题] 打印时间：YYYY-MM-DD HH:mm', async () => {
  const { api } = createEnv();
  const header = api.header('体测数据');
  assert(header.includes('INh工作台 - 体测数据'), '页眉要有 INh工作台 - 标题');
  assert(header.includes('打印时间：'), '页眉要有打印时间');
  assert(/打印时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(header), '时间格式应为 YYYY-MM-DD HH:mm');
  equal(api.now().length, 16, '时间字符串长度 16');
});

await test('③ 纸张方向：成绩列表/排名 横向，看板 纵向', async () => {
  const { api } = createEnv();
  equal(api.orientation('records'), 'landscape', '成绩列表横向');
  equal(api.orientation('ranking'), 'landscape', '成绩排名横向');
  equal(api.orientation('dashboard'), 'portrait', '统计分析看板纵向');

  assert(api.document('records', '<p>x</p>').includes('size: A4 landscape'), '横向页要写 A4 landscape');
  assert(api.document('dashboard', '<p>x</p>').includes('size: A4 portrait'), '纵向页要写 A4 portrait');
});

await test('④ 打印件里没有导航、筛选器、按钮和事件属性', async () => {
  const { api } = createEnv();
  const body = api.body(CONTENT_HTML, {});
  assert(!body.includes('<button'), '不能有按钮');
  assert(!body.includes('<select'), '不能有筛选下拉框');
  assert(!body.includes('<input'), '不能有输入框');
  assert(!body.includes('fitness-bi-control'), '看板的筛选/操作区要整块删掉');
  assert(!body.includes('onclick'), '不能有事件属性');
  assert(!body.includes('onchange'), '不能有事件属性');
  assert(body.includes('fitness-gradebook-table'), '表格主体要保留');
  assert(body.includes('体测成绩册'), '卡片标题要保留');
});

await test('⑤ 图表被换成 Base64 高清图片（pixelRatio: 2、白底）', async () => {
  const { api, calls } = createEnv();
  const body = api.body(CONTENT_HTML, { fitnessWeakChart: 'data:image/png;base64,QUJD' });
  assert(body.includes('<img class="fp-chart-img"'), '图表容器要换成 img');
  assert(body.includes('src="data:image/png;base64,QUJD"'), 'img 要带 Base64 图片');
  assert(!body.includes('<canvas'), 'canvas 不能进打印件');
  assert(!body.includes('id="fitnessWeakChart"'), '图表容器本身要消失');

  // 真实的取图路径：getDataURL({ pixelRatio: 2, backgroundColor: '#fff' })
  equal(api.chartDataURL('fitnessWeakChart'), 'data:image/png;base64,QUJD', 'getDataURL 的返回值');
  equal(calls.getDataURL.length, 1, '应该调用过一次 getDataURL');
  equal(calls.getDataURL[0].options.pixelRatio, 2, 'pixelRatio 要是 2');
  equal(calls.getDataURL[0].options.backgroundColor, '#fff', '背景色要是白色');
});

await test('⑥ 成绩册"上原始成绩 / 下国标得分"的两行排版保留', async () => {
  const { api } = createEnv();
  const body = api.body(CONTENT_HTML, {});
  assert(body.includes('fitness-gb-val'), '原始成绩那行要保留');
  assert(body.includes('fitness-gb-pts'), '折算得分那行要保留');
  assert(body.includes('is-good'), '绿色等级底色类要保留');
});

await test('⑥-2 姓名不能被清洗掉（姓名是个 button，但内容必须留下）', async () => {
  const { api } = createEnv();
  const body = api.body(CONTENT_HTML, {});
  assert(!body.includes('<button'), '按钮标签本身要去掉');
  assert(body.includes('张一'), '★姓名必须保留！');
  assert(body.includes('fitness-gb-name-link'), '姓名保留原来的样式类');
});

await test('⑦ 打印走隐藏 iframe → iframe.contentWindow.print()', async () => {
  const { api, calls } = createEnv();
  api.print('records');
  assert(calls.written.length > 0, '应该往 iframe 里写了 HTML');
  assert(calls.written.includes('INh工作台 - 体测数据'), 'iframe 里要有页眉');
  assert(calls.written.includes('css/fitness-print.css'), 'iframe 里要引打印样式');
  assert(calls.written.includes('size: A4 landscape'), 'iframe 里要有 @page 规则');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert(calls.printed, '应该调用了 iframe 的 print()');
  assert(calls.focused > 0, '打印前应该聚焦 iframe');
});

await test('⑧ 看板打印：带统计范围口径，筛选区不进打印件', async () => {
  const { api } = createEnv();
  const body = api.pageBody('dashboard');
  assert(body.includes('统计范围：'), '看板打印要保留统计范围');
  assert(body.includes('三年级 · 12 人'), '统计范围内容');
  assert(!body.includes('fitness-bi-control'), '筛选区不能进打印件');

  const doc = api.document('dashboard', body);
  assert(doc.includes('INh工作台 - 统计分析看板'), '页眉标题');
  assert(doc.includes('size: A4 portrait'), '纵向打印');
});

await test('⑨ 嵌套结构删得干净：删外层不会误伤内层内容', async () => {
  const { api } = createEnv();
  const html = `
    <div class="wrapper">
      <div class="fitness-bi-control">
        <div class="inner"><button class="btn">导出</button><span>要删</span></div>
      </div>
      <div class="keep">要留</div>
    </div>`;
  const out = api.removeByClass(html, 'fitness-bi-control');
  assert(!out.includes('要删'), '被删块的内容要一起消失');
  assert(out.includes('要留'), '旁边的内容不能误伤');
  assert(out.includes('class="wrapper"'), '外层容器要保留');
});

await test('⑩ 批量删除同类块（页面里可能有多个筛选区）', async () => {
  const { api } = createEnv();
  const html = `
    <div class="segmented">A</div><p>中间</p>
    <div class="segmented">B</div><p>结尾</p>`;
  const out = api.removeByClass(html, 'segmented');
  assert(!out.includes('>A<'), '第一块要删');
  assert(!out.includes('>B<'), '第二块要删');
  assert(out.includes('中间') && out.includes('结尾'), '其它内容保留');
});

await test('⑪ 成绩册表格本体保留（不再套任何缩放容器）', async () => {
  const { api } = createEnv();
  const html = `<div class="table-wrapper"><table class="data-table fitness-gradebook-table"><tbody><tr><td>1</td></tr></tbody></table></div>`;
  const out = api.body(html, {});
  assert(out.includes('fitness-gradebook-table'), '表格本身要保留');
  assert(!out.includes('fp-gb-zoom'), '缩放由 CSS 直接作用在表格上，不需要额外容器');
});

await test('⑫ 打印 CSS 的关键排版规则都在（自适应表格方案）', async () => {
  const raw = fs.readFileSync(path.join(ROOT, 'css/fitness-print.css'), 'utf8');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');   // 去掉注释，只看真正的规则

  // ① 隐藏序号
  assert(/\.fitness-gb-no\s*\{[^}]*display:\s*none/.test(css), '要隐藏序号列');
  // ② 彻底放弃 fixed + 百分比列宽
  assert(/table-layout:\s*auto\s*!important/.test(css), '要改成 table-layout: auto（内容自己决定宽度）');
  assert(!/table-layout:\s*fixed/.test(css), '不能再有 table-layout: fixed');
  assert(!/nth-child\(\d+\)[^{]*\{[^}]*width:/.test(css), '不能再用 nth-child 百分比硬分列宽');
  // ③ 全局自适应（终极方案）
  assert(/\.fp-body table\s*\{[^}]*table-layout:\s*auto\s*!important/.test(css), 'table 要 auto 布局');
  assert(/\.fp-body table\s*\{[^}]*width:\s*100%\s*!important/.test(css), 'table 要宽 100%');
  assert(/\.fp-body table\s*\{[^}]*max-width:\s*100%\s*!important/.test(css), 'table 要 max-width:100%');
  assert(/\.fp-body table\s*\{[^}]*min-width:\s*0\s*!important/.test(css), 'table 要 min-width:0');
  assert(/\.fp-body table\s*\{[^}]*word-break:\s*break-all\s*!important/.test(css), 'table 要 word-break:break-all（永不溢出）');
  // ④ 单元格：1px 0 内边距 + 9px 字号
  assert(/\.fp-body table th,\s*\n?\.fp-body table td\s*\{[^}]*padding:\s*1px\s+0\s*!important/.test(css), '单元格 padding 要 1px 0 并提权');
  assert(/\.fp-body table th,\s*\n?\.fp-body table td\s*\{[^}]*font-size:\s*9px\s*!important/.test(css), '单元格字号要 9px');
  // ⑤ 所有 min-width 一律为 0（消灭 1080px 这类内部最小宽度）
  const minWidths = [...css.matchAll(/min-width:\s*([^;}]+)/g)].map(m => m[1].trim());
  assert(minWidths.length > 0, '（断言有效性）打印 CSS 里应该有 min-width 声明');
  minWidths.forEach(value => {
    assert(/^0(\s*!important)?$/.test(value), `所有 min-width 必须是 0，实际是 "${value}"`);
  });
  // ⑥ 彻底干掉内部滚动条
  assert(/\.fp-body\s*\{[^}]*overflow:\s*hidden\s*!important/.test(css), '.fp-body 要 overflow:hidden');
  assert(/\.fp-body \.table-wrapper\s*\{[^}]*overflow:\s*hidden\s*!important/.test(css), '.table-wrapper 要 overflow:hidden');
  // ⑦ 不再用物理缩放（zoom / transform 会把行切一半）
  assert(!/zoom\s*:/i.test(css), '不能再用 zoom 缩放');
  assert(!/transform\s*:\s*scale/.test(css), '不能再用 transform:scale 缩放');
  assert(!/width:\s*150%/.test(css), '不能再用 150% 宽度撑开');
  // ⑧ 分页安全
  assert(/table tr\s*\{[^}]*page-break-inside:\s*avoid\s*!important/.test(css), '行不能被分页切断');
  assert(/table tr\s*\{[^}]*break-inside:\s*avoid\s*!important/.test(css), '行不能被分页切断');
  assert(/table thead\s*\{[^}]*display:\s*table-header-group\s*!important/.test(css), '表头要跨页重复');
  // ⑨ 表格所在卡片不能禁止分页（否则第 1 页空白）
  const cardBlock = (css.match(/\.fp-body \.card\s*\{[^}]*\}/) || [''])[0];
  assert(!/break-inside/.test(cardBlock), '成绩册卡片不能设 break-inside:avoid（会空掉第 1 页）');
  // ⑩ 上下两行不许重叠
  assert(/\.fitness-gb-val\s*\{[^}]*display:\s*block/.test(css), '原始成绩必须 display:block');
  assert(/\.fitness-gb-val\s*\{[^}]*line-height:\s*1\.35/.test(css), '原始成绩要留行高');
  assert(/\.fitness-gb-pts\s*\{[^}]*display:\s*block/.test(css), '得分必须 display:block');
  assert(/\.fitness-gb-pts\s*\{[^}]*margin-bottom:\s*2px/.test(css), '得分要留 margin-bottom');
  // ⑪ 盒模型 + 边框
  assert(/box-sizing:\s*border-box\s*!important/.test(css), '表格/单元格要强制 border-box');
  assert(/border-collapse:\s*collapse\s*!important/.test(css), '要强制 border-collapse: collapse');
  // ⑫ 备注/弱项必须完整显示
  assert(/fitness-gb-note-col[\s\S]*?white-space:\s*normal\s*!important/.test(css), '备注列不能单行截断');
  assert(/fitness-gb-weak-col[\s\S]*?white-space:\s*normal\s*!important/.test(css), '弱项列不能单行截断');
});

await test('⑬ 打印 iframe 视口 = 可打印宽度（不能是整页宽）', async () => {
  const { api } = createEnv();
  api.print('records');
  // A4 横向 297mm - @page 左右各 10mm = 277mm ≈ 1047px，取 1030px 留余量
  const size = api.frameSize();
  equal(size.width, '1030px', '横向 iframe 视口应为 1030px（可打印宽度 1047px 减余量）');
  equal(size.height, '700px', '横向 iframe 高度应为 700px');

  api.print('dashboard');
  const portrait = api.frameSize();
  equal(portrait.width, '700px', '纵向 iframe 视口应为 700px（A4 纵向可打印区 190mm ≈ 718px）');
  equal(portrait.height, '1030px', '纵向 iframe 高度应为 1030px');
});

/* ================= 汇总 ================= */

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  failed.forEach(item => console.log(`  ❌ ${item.name}：${item.error.message}`));
  process.exitCode = 1;
}
