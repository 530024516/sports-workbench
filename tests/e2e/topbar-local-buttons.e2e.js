/**
 * 真实 Puppeteer E2E：纯本地版顶栏按钮不换行 / 不溢出 / 手机端折叠成图标
 *
 *   node tests/e2e/topbar-local-buttons.e2e.js
 *
 * 全程真实：真 server.js + 真 Chrome + 真登录接口（PUBLIC_PASSWORD_LOCAL）
 * + 真 CSS 布局 + 真视口切换。没有假 DOM / 假样式对象。
 *
 * 断言：
 *   桌面 1440×900：
 *     · 按钮文案精简为「🗑️ 清空」「📥 导出」，title / aria-label 为完整说明
 *     · .topbar-right 下所有按钮与徽章：white-space:nowrap、flex-shrink:0
 *     · .topbar-right：align-items:center、gap:8px
 *     · 所有元素在视口内、彼此不重叠、顶栏无横向滚动、文案不换行
 *   手机 375×812：
 *     · 两个按钮自动折叠成纯图标（40×40），title 保留完整说明
 *     · 徽章只显示 emoji（textContent 仍是「纯本地版（无AI）」）
 *     · 同样不溢出、不重叠
 *
 * 产物：tests/e2e/topbar-desktop-pass.png / topbar-mobile-pass.png / topbar-run.log
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const OUT = __dirname;
const SHOT_DESKTOP = path.join(OUT, 'topbar-desktop-pass.png');
const SHOT_MOBILE = path.join(OUT, 'topbar-mobile-pass.png');
const LOG = path.join(OUT, 'topbar-run.log');
const PORT = Number(process.env.E2E_PORT) || 5277;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENV_LOCAL = path.join(ROOT, '.env.local');
const ENV_BACKUP = `${ENV_LOCAL}.topbar-e2e-backup`;

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
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}
async function waitServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await get(`${BASE}/lessons.html`) === 200) return; } catch (error) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error(`server.js 在 ${timeoutMs}ms 内没有就绪`);
}
function readEnvValue(key) {
  if (!fs.existsSync(ENV_LOCAL)) return '';
  for (const line of fs.readFileSync(ENV_LOCAL, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && match[1] === key) return match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}
function swapEnvWithoutSupabase() {
  if (!fs.existsSync(ENV_LOCAL)) return false;
  const original = fs.readFileSync(ENV_LOCAL, 'utf8');
  const stripped = original.split(/\r?\n/)
    .filter(line => !/^\s*(?:export\s+)?SUPABASE_(?:URL|ANON_KEY|SERVICE_ROLE_KEY)\s*=/.test(line))
    .join('\n');
  if (stripped === original) return false;
  if (fs.existsSync(ENV_BACKUP)) fs.unlinkSync(ENV_BACKUP);
  fs.copyFileSync(ENV_LOCAL, ENV_BACKUP);
  fs.writeFileSync(ENV_LOCAL, stripped, 'utf8');
  return true;
}
function restoreEnv() {
  if (!fs.existsSync(ENV_BACKUP)) return;
  try {
    fs.copyFileSync(ENV_BACKUP, ENV_LOCAL);
    fs.unlinkSync(ENV_BACKUP);
    log('.env.local 已原样恢复');
  } catch (error) {
    log(`⚠️ .env.local 恢复失败，请手动从 ${ENV_BACKUP} 还原：${error.message}`);
  }
}

/** 在页面里量顶栏的真实布局（全部来自真实 DOM + getComputedStyle） */
function inspectTopbar() {
  const right = document.querySelector('.topbar-right');
  const topbar = document.querySelector('.topbar');
  const left = document.querySelector('.topbar-left');
  const visible = [...right.children].filter(node => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && node.getClientRects().length > 0;
  });
  const rectOf = node => {
    const r = node.getBoundingClientRect();
    return {
      id: node.id || node.className,
      left: Math.round(r.left * 10) / 10,
      right: Math.round(r.right * 10) / 10,
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
    };
  };
  const buttons = ['clearLocalDataBtn', 'exportLocalDataBtn'].map(id => {
    const node = document.getElementById(id);
    const style = getComputedStyle(node);
    const label = node.querySelector('.local-data-btn-label');
    return {
      id,
      text: node.textContent.trim(),
      title: node.title,
      ariaLabel: node.getAttribute('aria-label'),
      whiteSpace: style.whiteSpace,
      flexShrink: style.flexShrink,
      labelDisplay: label ? getComputedStyle(label).display : 'none',
      labelRects: label ? label.getClientRects().length : 0,
      rect: rectOf(node),
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    };
  });
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    rightStyle: {
      alignItems: getComputedStyle(right).alignItems,
      gap: getComputedStyle(right).gap,
      flexShrink: getComputedStyle(right).flexShrink,
    },
    rightChildren: getComputedStyle(right).whiteSpace,
    allChildren: visible.map(node => ({
      ...rectOf(node),
      whiteSpace: getComputedStyle(node).whiteSpace,
      flexShrink: getComputedStyle(node).flexShrink,
    })),
    leftRect: rectOf(left),
    topbar: {
      scrollWidth: topbar.scrollWidth,
      clientWidth: topbar.clientWidth,
      height: Math.round(topbar.getBoundingClientRect().height),
    },
    badge: (() => {
      const node = document.getElementById('publicModeBadge');
      return {
        text: node?.textContent || '',
        hidden: Boolean(node?.hidden),
        fontSize: node ? getComputedStyle(node).fontSize : '',
      };
    })(),
    buttons,
  };
}

/** 公共断言：所有元素单行、不溢出、不重叠 */
function assertLayout(layout, stage) {
  check(`${stage}：右侧所有元素 white-space=nowrap`,
    layout.allChildren.every(node => node.whiteSpace === 'nowrap'),
    JSON.stringify(layout.allChildren.map(n => `${n.id}:${n.whiteSpace}`)));
  check(`${stage}：右侧所有元素 flex-shrink=0`,
    layout.allChildren.every(node => node.flexShrink === '0'),
    JSON.stringify(layout.allChildren.map(n => `${n.id}:${n.flexShrink}`)));
  check(`${stage}：右侧容器 align-items:center、gap:8px`,
    layout.rightStyle.alignItems === 'center' && layout.rightStyle.gap === '8px',
    JSON.stringify(layout.rightStyle));
  check(`${stage}：所有右侧元素都在视口内`,
    layout.allChildren.every(node => node.left >= -1 && node.right <= layout.viewport.w + 1),
    JSON.stringify(layout.allChildren.map(n => `${n.id}:${n.left}~${n.right}`)));
  const sorted = [...layout.allChildren].sort((a, b) => a.left - b.left);
  const overlaps = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].left < sorted[i - 1].right - 1) {
      overlaps.push(`${sorted[i - 1].id} ↔ ${sorted[i].id}`);
    }
  }
  check(`${stage}：右侧元素彼此不重叠`, overlaps.length === 0, overlaps.join('、'));
  check(`${stage}：左侧标题区域与右侧按钮不重叠`,
    layout.leftRect.right <= sorted[0].left + 1,
    `左侧右边界 ${layout.leftRect.right} / 右侧左边界 ${sorted[0].left}`);
  check(`${stage}：顶栏没有横向滚动`,
    layout.topbar.scrollWidth <= layout.topbar.clientWidth + 1,
    `scrollWidth=${layout.topbar.scrollWidth} clientWidth=${layout.topbar.clientWidth}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let server = null;
  let browser = null;
  try {
    const localPassword = readEnvValue('PUBLIC_PASSWORD_LOCAL');
    check('.env.local 配了 PUBLIC_PASSWORD_LOCAL', Boolean(localPassword));
    if (swapEnvWithoutSupabase()) {
      log('已临时摘掉 Supabase 配置（避免测试污染云端），结束自动恢复');
      process.on('exit', restoreEnv);
    }
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => log(`[server] ${String(chunk).trim()}`));
    server.stderr.on('data', chunk => log(`[server:err] ${String(chunk).trim()}`));
    await waitServer();
    log(`server.js 已启动：${BASE}`);

    if (!fs.existsSync(CHROME)) throw new Error(`找不到真实 Chrome：${CHROME}`);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROME,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    log(`真实 Chrome 已启动：${await browser.version()}`);

    const page = await browser.newPage();
    page.on('pageerror', error => log(`[pageerror] ${error.message}`));
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE}/lessons.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.Auth === 'object'
      && typeof window.Store === 'object'
      && !document.getElementById('store-loading'), { timeout: 60000 });

    /* 真登录接口 → 纯本地版（无AI） */
    await page.evaluate(() => Auth.openLoginModal(true));
    await page.waitForSelector('#adminPasswordInput', { visible: true, timeout: 10000 });
    await page.type('#adminPasswordInput', localPassword);
    await page.evaluate(() => Auth.submitLogin());
    await page.waitForFunction(() => Auth.isLocalMode() === true && Auth.canUseAI() === false,
      { timeout: 15000 });
    await sleep(400);
    log('已用 PUBLIC_PASSWORD_LOCAL 真实登录，进入「纯本地版（无AI）」');

    /* ---------------- 桌面 ---------------- */
    const desktop = await page.evaluate(inspectTopbar);
    log(`桌面顶栏：${JSON.stringify(desktop, null, 2)}`);
    check('桌面：徽章确实显示「纯本地版（无AI）」',
      desktop.badge.text.includes('纯本地版（无AI）'), desktop.badge.text);
    check('桌面：两个本机数据按钮可见',
      desktop.buttons.every(button => button.rect.w > 0 && button.rect.h > 0));
    check('桌面：按钮文案已精简为「清空」「导出」',
      desktop.buttons[0].text === '🗑️ 清空' && desktop.buttons[1].text === '📥 导出',
      desktop.buttons.map(b => b.text).join(' / '));
    check('桌面：清空按钮 title="清空本机所有数据"',
      desktop.buttons[0].title === '清空本机所有数据', desktop.buttons[0].title);
    check('桌面：导出按钮 title="导出本机数据为JSON文件"',
      desktop.buttons[1].title === '导出本机数据为JSON文件', desktop.buttons[1].title);
    check('桌面：两个按钮都有完整 aria-label',
      desktop.buttons[0].ariaLabel === '清空本机所有数据'
      && desktop.buttons[1].ariaLabel === '导出本机数据为JSON文件');
    check('桌面：按钮文案不换行（每个标签只有一个文本行盒）',
      desktop.buttons.every(button => button.labelRects === 1),
      JSON.stringify(desktop.buttons.map(b => `${b.id}:${b.labelRects}`)));
    check('桌面：按钮没有横向溢出',
      desktop.buttons.every(button => button.scrollWidth <= button.clientWidth + 1),
      JSON.stringify(desktop.buttons.map(b => `${b.id}:${b.scrollWidth}/${b.clientWidth}`)));
    check('桌面：按钮没有竖排（高度没有暴涨）',
      desktop.buttons.every(button => button.rect.h <= 40 && button.scrollHeight <= button.clientHeight + 1),
      JSON.stringify(desktop.buttons.map(b => `${b.id}:${b.rect.h}px`)));
    assertLayout(desktop, '桌面');

    await page.screenshot({ path: SHOT_DESKTOP, fullPage: false });
    log(`桌面截图已保存：${SHOT_DESKTOP}`);

    /* ---------------- 手机 ---------------- */
    await page.setViewport({ width: 375, height: 812 });
    await sleep(500);
    const mobile = await page.evaluate(inspectTopbar);
    log(`手机顶栏：${JSON.stringify(mobile, null, 2)}`);
    check('手机：两个按钮仍然可见',
      mobile.buttons.every(button => button.rect.w > 0 && button.rect.h > 0));
    check('手机：按钮自动折叠成纯图标（文字隐藏）',
      mobile.buttons.every(button => button.labelDisplay === 'none'),
      JSON.stringify(mobile.buttons.map(b => `${b.id}:${b.labelDisplay}`)));
    check('手机：按钮为 40×40 圆形图标',
      mobile.buttons.every(button => button.rect.w === 40 && button.rect.h === 40),
      JSON.stringify(mobile.buttons.map(b => `${b.id}:${b.rect.w}×${b.rect.h}`)));
    check('手机：title 悬浮说明依然保留',
      mobile.buttons[0].title === '清空本机所有数据'
      && mobile.buttons[1].title === '导出本机数据为JSON文件');
    check('手机：徽章只留 emoji（font-size:0），但文案仍在 textContent 中',
      mobile.badge.fontSize === '0px' && mobile.badge.text.includes('纯本地版（无AI）'),
      `${mobile.badge.fontSize} / ${mobile.badge.text}`);
    assertLayout(mobile, '手机');

    await page.screenshot({ path: SHOT_MOBILE, fullPage: false });
    log(`手机截图已保存：${SHOT_MOBILE}`);

    log('🎉 E2E 全部断言通过：纯本地版顶栏单行不溢出，手机端自动折叠成图标');
    return { ok: true };
  } finally {
    if (browser) { try { await browser.close(); } catch (error) { /* 忽略 */ } }
    if (server) {
      try { server.kill('SIGTERM'); } catch (error) { /* 忽略 */ }
      log('server.js 已关闭');
    }
    restoreEnv();
    fs.writeFileSync(LOG, `${lines.join('\n')}\n`, 'utf8');
    console.log(`完整日志已保存：${LOG}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    log(`❌ E2E 失败：${error?.stack || error}`);
    process.exit(1);
  });
