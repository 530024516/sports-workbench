/**
 * 真实 Puppeteer E2E：复现「切走再切回大单元设计 Tab，完整视图被旧半截主键覆盖」
 *
 *   node tests/e2e/tab-zombie.e2e.js
 *
 * 全程真实：真实 server.js 进程、真实 Chrome、真实 DOM、真实点击、真实 localStorage、
 * 真实页面导航。没有任何假 DOM / 假 Store / 假 fetch。
 *
 * 操作路径（与用户描述一致）：
 *   ① 预置一条【模块 1-6 完整】的离线资源 + 一份【旧半截】pe_big_unit_design_v1 主键
 *   ② 打开大单元设计页 → 点击「📦 从离线资源库加载」→ 载入完整资源
 *   ③ 在模块 1 真实键入一段修改
 *   ④ 点击「保存到离线资源库」
 *   ⑤ 点击左侧导航「体测数据」→ 再点击「大单元设计」切回
 *   ⑥ 断言：模块 4 / 5 内容还在，模块 1 的修改还在，绝不能变回旧半截数据
 *   ⑦ 架构解耦验收：pe_big_unit_design_v1 只存本机（零云端 POST）、视图锁已失效；
 *      pe_offline_resources_v1 仍是唯一云端入口；本地刷新 / 切页不丢数据
 *
 * 产物：tests/e2e/tab-zombie-pass.png（截图）、tests/e2e/tab-zombie-run.log（完整终端日志）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const OUT = __dirname;
const SHOT = path.join(OUT, 'tab-zombie-pass.png');
const LOG = path.join(OUT, 'tab-zombie-run.log');
const PORT = Number(process.env.E2E_PORT) || 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENV_LOCAL = path.join(ROOT, '.env.local');
const ENV_BACKUP = `${ENV_LOCAL}.e2e-backup`;

const M4 = '模块4完整内容-E2E-知识技术战术体能比赛活动';
const M5 = '模块5完整内容-E2E-学习重难点';
const EDIT = '模块1修改标记-E2E-老师改过的教学目标';
const STALE_TITLE = '旧半截数据-E2E';
const STALE_OBJ = '旧目标半截-E2E';

const lines = [];
function log(message) {
  const line = `[E2E ${new Date().toISOString().slice(11, 23)}] ${message}`;
  lines.push(line);
  console.log(line);
}
function check(label, ok, detail = '') {
  log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`断言失败：${label}${detail ? ` — ${detail}` : ''}`);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}
async function waitServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await get(`${BASE}/unit-design.html`);
      if (status === 200) return;
    } catch (error) { /* 还没起来，继续轮询 */ }
    await sleep(250);
  }
  throw new Error(`server.js 在 ${timeoutMs}ms 内没有就绪（${BASE}）`);
}

/** 展开左侧「教学管理」分组（若折叠）并真实点击对应导航项 */
async function clickNav(page, pageId) {
  await page.waitForSelector(`a[data-page="${pageId}"]`, { timeout: 15000 });
  const expanded = await page.$eval('#navGroup-teaching', el => !el.hidden).catch(() => false);
  if (!expanded) {
    await page.click('.nav-group[data-nav-group="teaching"] .nav-group-toggle');
    log(`展开左侧「教学管理」分组（准备点击 ${pageId}）`);
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }),
    page.click(`a[data-page="${pageId}"]`),
  ]);
  log(`已真实点击左侧导航 → ${pageId}（当前 URL：${page.url()}）`);
}

async function readyUnitPage(page, stage) {
  await page.waitForFunction(
    () => typeof window.Store !== 'undefined'
      && typeof window.OfflineResources !== 'undefined'
      && typeof window.createEmptyUnit === 'function'
      && document.getElementById('ud2Modules'),
    { timeout: 25000 },
  );
  await page.waitForFunction(() => document.getElementById('ud2Modules').innerHTML.length > 0,
    { timeout: 25000 });
  log(`${stage}：unit-design.html 已就绪`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let server = null;
  let browser = null;
  let envMoved = false;
  const browserConsole = [];
  const postBodies = [];

  try {
    /* ---------- ① 以「纯本地模式」启动真实 server.js ----------
       临时把 .env.local 挪开（dotenv 的 override:true 会覆盖环境变量），
       让 /api/data 走本地文件后端：这样 E2E 只检验"本机切页"逻辑，
       不会被云端快照干扰；无论成功失败，finally 都会原样恢复。 */
    if (fs.existsSync(ENV_LOCAL)) {
      if (fs.existsSync(ENV_BACKUP)) fs.unlinkSync(ENV_BACKUP);
      fs.renameSync(ENV_LOCAL, ENV_BACKUP);
      envMoved = true;
      log('已临时停用 .env.local（server.js 走本地模式；结束自动恢复）');
    }
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => log(`[server] ${String(chunk).trim()}`));
    server.stderr.on('data', chunk => log(`[server:err] ${String(chunk).trim()}`));
    await waitServer();
    log(`server.js 已启动：${BASE}（PID ${server.pid}）`);

    if (!fs.existsSync(CHROME)) throw new Error(`找不到真实 Chrome：${CHROME}`);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROME,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    log(`真实 Chrome 已启动：${await browser.version()}`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    page.on('console', msg => {
      const text = `[browser:${msg.type()}] ${msg.text()}`;
      browserConsole.push(text);
      if (/⚠️ 试图在切换Tab|🔒 切回页面|✅ 保存到离线资源库|已把资源库这份完整数据同步进本机草稿|忽略 store:sync|草稿已自动保存至本机浏览器/.test(msg.text())) {
        log(text);
      }
    });
    page.on('pageerror', error => { browserConsole.push(`[pageerror] ${error.message}`); log(`[pageerror] ${error.message}`); });
    page.on('request', req => {
      if (req.url().includes('/api/data') && req.method() === 'POST') {
        postBodies.push(req.postData() || '');
      }
    });

    /* ---------- ② 预置真实 localStorage：完整资源 + 旧半截主键 ---------- */
    await page.goto(`${BASE}/unit-design.html`, { waitUntil: 'domcontentloaded' });
    await readyUnitPage(page, '首次打开');
    await page.evaluate(({ m4, m5, staleTitle, staleObj, adminPwd }) => {
      localStorage.setItem('isAdmin', 'true');
      localStorage.setItem('pe_admin_password', adminPwd || 'e2e');
      localStorage.removeItem('pe_store_view_pin_v1');
      localStorage.removeItem('pe_big_unit_design_v1__step_backup');
      localStorage.removeItem('pe_store_local_backup_meta_v1');

      const unit = createEmptyUnit();
      unit.unitTitle = 'E2E 完整大单元（模块 1-6 齐全）';
      unit.objectives = '模块1 原始目标：运动能力 / 健康行为 / 体育品德（未修改）';
      unit.textbookAnalysis = '模块2 完整内容-E2E-教材分析';
      unit.studentAnalysis = '模块3 完整内容-E2E-学情分析';
      unit.teachingContent = m4;
      unit.keyDifficulties = {
        learning: m5,
        content: '模块5 完整内容-E2E-学习内容重难点',
        organization: '模块5 完整内容-E2E-教学组织重难点',
        method: '模块5 完整内容-E2E-教学方法重难点',
      };
      unit.assessment = '模块8 完整内容-E2E-考核与作业';
      unit.reflection = '模块9 完整内容-E2E-教学反思';

      const record = OfflineResources.recordFromUnit(unit, {
        id: 'e2e-full-unit', source: 'manual', created_at: new Date().toISOString(),
      });
      localStorage.setItem('pe_offline_resources_v1', JSON.stringify([record]));

      // 用户描述的「旧半截主键」：只有模块 1，模块 4/5 全空
      const stale = createEmptyUnit();
      stale.unitTitle = staleTitle;
      stale.objectives = staleObj;
      stale.teachingContent = '';
      stale.keyDifficulties = {};
      localStorage.setItem('pe_big_unit_design_v1', JSON.stringify(stale));
      return true;
    }, { m4: M4, m5: M5, staleTitle: STALE_TITLE, staleObj: STALE_OBJ, adminPwd: process.env.E2E_ADMIN_PASSWORD || '' });
    log('已预置：离线资源库 1 条【模块 1-6 完整】资源；主键 pe_big_unit_design_v1 = 旧半截数据');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await readyUnitPage(page, '预置后重载');
    const seeded = await page.evaluate(() => ({
      key: JSON.parse(localStorage.getItem('pe_big_unit_design_v1') || '{}'),
      list: JSON.parse(localStorage.getItem('pe_offline_resources_v1') || '[]'),
    }));
    check('预置生效：主键确实是旧半截数据', seeded.key.unitTitle === STALE_TITLE && !seeded.key.teachingContent);
    check('预置生效：资源库里的资源含模块 4/5', seeded.list.length === 1
      && String(seeded.list[0].modules_json?.teachingContent || '').includes(M4)
      && String(seeded.list[0].modules_json?.keyDifficulties?.learning || '').includes(M5));

    /* ---------- ③ 真实点击「从离线资源库加载」 ---------- */
    await page.click('button[onclick="openUnitResourcePicker()"]');
    await page.waitForSelector('.modal-overlay .res-card-actions button.btn-primary', { timeout: 10000 });
    await sleep(500);   // 等 modal 的 .show 动画结束，确保按钮真的可点
    const btnDiag = await page.evaluate(() => {
      const btn = document.querySelector('.modal-overlay .res-card-actions button.btn-primary');
      const r = btn.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        html: btn.outerHTML.slice(0, 180),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        topElement: at ? at.outerHTML.slice(0, 120) : 'none',
        disabled: btn.disabled,
        pickerSet: typeof OfflineResources._picker === 'function',
      };
    });
    log(`载入按钮诊断：${JSON.stringify(btnDiag)}`);
    log('已真实点击「📦 从离线资源库加载」，选择弹窗已打开');
    await page.click('.modal-overlay .res-card-actions button.btn-primary');
    await sleep(600);
    const pickDiag = await page.evaluate(() => {
      let listLen = -1;
      let hasGet = false;
      try { listLen = OfflineResources.list().length; } catch (e) { listLen = `ERR:${e.message}`; }
      try { hasGet = Boolean(OfflineResources.get('e2e-full-unit')); } catch (e) { hasGet = `ERR:${e.message}`; }
      return {
        listLen,
        hasGet,
        modalCount: document.querySelectorAll('.modal-overlay').length,
        unitTitle: typeof unitData !== 'undefined' ? unitData.unitTitle : 'NO_unitData',
        m4: typeof unitData !== 'undefined' ? String(unitData.teachingContent || '').slice(0, 50) : '',
        status: (document.getElementById('ud2Status')?.textContent || '').slice(0, 120),
        modulesHTML: (document.getElementById('ud2Modules')?.innerHTML || '').slice(0, 160),
      };
    });
    log(`载入诊断：${JSON.stringify(pickDiag)}`);
    await page.waitForFunction(
      m4 => (document.querySelector('[data-unit-path="teachingContent"]')?.value || '').includes(m4),
      { timeout: 15000 }, M4,
    );
    const loaded = await page.evaluate(() => ({
      m4: document.querySelector('[data-unit-path="teachingContent"]')?.value || '',
      m5: document.querySelector('[data-unit-path="keyDifficulties.learning"]')?.value || '',
    }));
    check('载入完整资源：模块 4 有内容', loaded.m4.includes(M4));
    check('载入完整资源：模块 5 有内容', loaded.m5.includes(M5));
    log('已真实点击「载入到设计页」，模块 4 / 5 均已渲染');

    /* ---------- ④ 真实修改模块 1 ---------- */
    await page.click('.ud2-module[data-module="objectives"] .ud2-module-head');
    await page.waitForSelector('[data-unit-path="objectives"]');
    await page.$eval('[data-unit-path="objectives"]', el => { el.focus(); el.select(); });
    await page.keyboard.type(EDIT);
    const m1AfterEdit = await page.$eval('[data-unit-path="objectives"]', el => el.value);
    check('模块 1 真实键入修改', m1AfterEdit.includes(EDIT), m1AfterEdit.slice(0, 40));
    log(`已在模块 1 真实键入：${EDIT}`);

    /* ---------- ⑤ 真实点击「保存到离线资源库」 ---------- */
    await page.click('button[onclick="saveUnitToResources()"]');
    await page.waitForFunction(
      ({ m4, edit }) => {
        const key = JSON.parse(localStorage.getItem('pe_big_unit_design_v1') || '{}');
        return String(key.teachingContent || '').includes(m4) && String(key.objectives || '').includes(edit);
      },
      { timeout: 15000 }, { m4: M4, edit: EDIT },
    );
    const afterSave = await page.evaluate(() => ({
      key: JSON.parse(localStorage.getItem('pe_big_unit_design_v1') || '{}'),
      list: JSON.parse(localStorage.getItem('pe_offline_resources_v1') || '[]'),
      cache: Store.read('pe_big_unit_design_v1', null),
      status: document.getElementById('ud2Status')?.textContent || '',
      localOnly: typeof Store.isLocalOnly === 'function'
        && Store.isLocalOnly('pe_big_unit_design_v1'),
      resourcesLocalOnly: typeof Store.isLocalOnly === 'function'
        && Store.isLocalOnly('pe_offline_resources_v1'),
    }));
    check('保存后主键已含模块 4 完整内容', String(afterSave.key.teachingContent || '').includes(M4));
    check('保存后主键已含模块 5 完整内容',
      String(afterSave.key.keyDifficulties?.learning || '').includes(M5));
    check('保存后主键已含模块 1 修改', String(afterSave.key.objectives || '').includes(EDIT));
    check('保存后主键与资源库数据绝对一致',
      String(afterSave.list[0]?.modules_json?.teachingContent || '').includes(M4)
      && String(afterSave.list[0]?.modules_json?.objectives || '').includes(EDIT));
    check('保存后 Store 内存缓存也是最新版',
      String(afterSave.cache?.teachingContent || '').includes(M4)
      && String(afterSave.cache?.objectives || '').includes(EDIT));
    /* 🏠 架构解耦：主键只存本机、离线资源库才是唯一云端入口 */
    check('主键已加入「仅本地」白名单', afterSave.localOnly === true);
    check('离线资源库仍走云端同步（不在仅本地白名单里）', afterSave.resourcesLocalOnly === false);
    check('保存成功提示为「已存入资源库并同步云端」',
      afterSave.status.includes('已存入资源库并同步云端'), afterSave.status.slice(0, 100));
    check('保存过程没有把主键 POST 到 /api/data',
      !postBodies.some(body => body.includes('pe_big_unit_design_v1')),
      `实际 POST ${postBodies.length} 次`);
    log('已真实点击「保存到离线资源库」；主键缓存 / 本地 / 资源库三处均为完整数据，且主键零云端请求');

    /* ---------- ⑥ 真实点击左侧导航：体测数据 → 大单元设计 ---------- */
    await clickNav(page, 'fitness');
    await page.waitForFunction(() => document.querySelector('a[data-page="unit-design"]'), { timeout: 20000 });
    log('已在体测数据页停留（页面已完整重建，页内 unitData 归零）');
    await clickNav(page, 'unit-design');
    await page.waitForFunction(() => document.querySelector('[data-unit-path="teachingContent"]'),
      { timeout: 25000 });
    await sleep(1200);   // 给后台 store:sync 一个真实窗口，确认它不会覆盖视图

    const back = await page.evaluate(() => {
      const diag = source => ({
        title: String(source?.unitTitle || source?.meta?.unitTitle || '').slice(0, 40),
        m1: String(source?.objectives || '').slice(0, 40),
        m4: String(source?.teachingContent || '').slice(0, 40),
        m5: String(source?.keyDifficulties?.learning || '').slice(0, 40),
      });
      return {
        m1: document.querySelector('[data-unit-path="objectives"]')?.value || '',
        m4: document.querySelector('[data-unit-path="teachingContent"]')?.value || '',
        m5: document.querySelector('[data-unit-path="keyDifficulties.learning"]')?.value || '',
        title: document.querySelector('.ud2-modules-title h2')?.textContent || '',
        key: JSON.parse(localStorage.getItem('pe_big_unit_design_v1') || '{}'),
        pinned: typeof Store.isViewPinned === 'function' && Store.isViewPinned('pe_big_unit_design_v1'),
        hasGuard: typeof guardTabSwitchReload === 'function',
        startReadsLocalOnly: typeof readLocalUnitDraftNow === 'function',
        diag: {
          localStorage: diag(JSON.parse(localStorage.getItem('pe_big_unit_design_v1') || '{}')),
          cache: diag(Store.read('pe_big_unit_design_v1', null)),
          unitData: typeof unitData !== 'undefined' ? diag(unitData) : 'NO_unitData',
          stepBackup: diag((JSON.parse(localStorage.getItem('pe_big_unit_design_v1__step_backup') || '{}').data) || {}),
        },
      };
    });
    log(`切回后诊断：${JSON.stringify(back.diag)}`);
    log(`切回后标题：${back.title}`);
    log(`切回后模块 4：${back.m4.slice(0, 60)}`);
    log(`切回后模块 5：${back.m5.slice(0, 60)}`);
    log(`切回后模块 1：${back.m1.slice(0, 60)}`);

    /* ---------- ⑦ 最终断言 ---------- */
    check('【核心】切回后模块 4 内容仍在', back.m4.includes(M4));
    check('【核心】切回后模块 5 内容仍在', back.m5.includes(M5));
    check('【核心】切回后模块 1 的修改仍保留', back.m1.includes(EDIT));
    check('【核心】视图没有变回旧半截数据',
      !back.title.includes(STALE_TITLE) && !back.m1.includes(STALE_OBJ) && !back.m4.includes(STALE_OBJ));
    check('切回后 localStorage 主键仍是完整数据',
      String(back.key.teachingContent || '').includes(M4) && String(back.key.objectives || '').includes(EDIT));
    check('【架构解耦】该键的视图优先级锁已失效（不再需要防云端覆盖）', back.pinned === false);
    /* 🏠 主键永不发云端请求。本 E2E 以纯本地模式启动（cloudState=off），
       离线资源库本来也不会真的 POST；但无论哪种模式，POST 里都绝不能出现主键。 */
    check('【架构解耦】整个流程零次「主键上云」的 POST',
      !postBodies.some(body => body.includes('pe_big_unit_design_v1')),
      `实际 POST ${postBodies.length} 次`);
    check('浏览器日志确认「主键只同步本机草稿、云端由资源库负责」',
      browserConsole.some(line => line.includes('已把资源库这份完整数据同步进本机草稿'))
      && browserConsole.some(line => line.includes('云端由离线资源库负责')));
    log(`架构解耦验收：主键零云端 POST（实际总 POST ${postBodies.length} 次），`
      + '离线资源库仍是唯一云端入口');
    check('切页保护仍在：guardTabSwitchReload + 启动直读本机草稿',
      back.hasGuard === true && back.startReadsLocalOnly === true);
    check('没有出现任何页面脚本异常',
      !browserConsole.some(line => line.startsWith('[pageerror]')));
    check('浏览器日志没有出现「已从分步物理备份补回」（旧备份没被塞回）',
      !browserConsole.some(line => line.includes('已从分步物理备份补回')));

    /* ---------- ⑧ 真实 F5 刷新：本机草稿必须原样恢复 ---------- */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await readyUnitPage(page, '保存后刷新');
    await page.waitForSelector('[data-unit-path="teachingContent"]', { timeout: 20000 });
    await sleep(800);   // 给后台同步一个窗口，确认它不会覆盖本机草稿
    const afterReload = await page.evaluate(() => ({
      m1: document.querySelector('[data-unit-path="objectives"]')?.value || '',
      m4: document.querySelector('[data-unit-path="teachingContent"]')?.value || '',
      m5: document.querySelector('[data-unit-path="keyDifficulties.learning"]')?.value || '',
      key: JSON.parse(localStorage.getItem('pe_big_unit_design_v1') || '{}'),
      pinned: typeof Store.isViewPinned === 'function' && Store.isViewPinned('pe_big_unit_design_v1'),
    }));
    check('【核心】刷新后模块 4 内容仍在', afterReload.m4.includes(M4));
    check('【核心】刷新后模块 5 内容仍在', afterReload.m5.includes(M5));
    check('【核心】刷新后模块 1 的修改仍在', afterReload.m1.includes(EDIT));
    check('刷新后 localStorage 主键仍是完整数据',
      String(afterReload.key.teachingContent || '').includes(M4)
      && String(afterReload.key.objectives || '').includes(EDIT));
    check('刷新后依然不需要视图优先级锁', afterReload.pinned === false);
    log('真实 F5 刷新验收通过：本机草稿完整恢复，视图锁已不再需要');

    await page.screenshot({ path: SHOT, fullPage: false });
    log(`截图已保存：${SHOT}`);
    log('🎉 E2E 全部断言通过：切走再切回 + F5 刷新，模块 4/5 完整、模块 1 修改保留，'
      + '旧半截数据没有诈尸；主键零云端请求，离线资源库是唯一云端入口');

    return { ok: true };
  } finally {
    if (browser) { try { await browser.close(); } catch (error) { /* 忽略 */ } }
    if (server) {
      try { server.kill('SIGTERM'); } catch (error) { /* 忽略 */ }
      log('server.js 已关闭');
    }
    if (envMoved) {
      fs.renameSync(ENV_BACKUP, ENV_LOCAL);
      log('.env.local 已原样恢复');
    }
    fs.writeFileSync(LOG, `${lines.join('\n')}\n\n----- 浏览器完整 console -----\n${browserConsole.join('\n')}\n`, 'utf8');
    console.log(`完整日志已保存：${LOG}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    log(`❌ E2E 失败：${error?.stack || error}`);
    process.exit(1);
  });
