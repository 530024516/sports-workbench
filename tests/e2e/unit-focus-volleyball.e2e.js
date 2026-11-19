/**
 * 真实 Puppeteer E2E：真实页面选【排球 / 水平二 / 垫球：自垫、对垫启蒙】，
 * 一键生成完整 18 课时大单元，断言 18 课时的标题与内容里
 * 【连"发球"和"传球"两个字都找不到】。
 *
 *   node tests/e2e/unit-focus-volleyball.e2e.js
 *
 * 全程真实：真实 server.js、真实 Chrome、真实 DOM 下拉选择、真实点击、
 * 真实智谱 GLM 上游、真实 localStorage 草稿。没有假 DOM / 假 fetch / 假 AI。
 *
 * 产物：tests/e2e/unit-focus-volleyball-run.log（完整日志）
 *       tests/e2e/unit-focus-volleyball-output.json（18 课时原文，便于人工抽查）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const OUT = __dirname;
const LOG = path.join(OUT, 'unit-focus-volleyball-run.log');
const RAW = path.join(OUT, 'unit-focus-volleyball-output.json');
const PORT = Number(process.env.E2E_PORT) || 5233;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENV_LOCAL = path.join(ROOT, '.env.local');
const ENV_BACKUP = `${ENV_LOCAL}.focus-e2e-backup`;
const TOPIC = '垫球：自垫、对垫启蒙';
const BANNED = /传球|发球|扣球|拦网|吊球|轮转|传切|二传/;

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
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}
async function waitServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await get(`${BASE}/unit-design.html`) === 200) return; } catch (error) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error(`server.js 在 ${timeoutMs}ms 内没有就绪（${BASE}）`);
}
function readEnvValue(key) {
  if (!fs.existsSync(ENV_LOCAL)) return '';
  for (const line of fs.readFileSync(ENV_LOCAL, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
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
    log(`⚠️ .env.local 恢复失败，请手动还原：${error.message}`);
  }
}

let server = null;
let browser = null;

async function main() {
  const adminPassword = readEnvValue('ADMIN_PASSWORD');
  const apiKey = readEnvValue('VITE_ZHIPUAI_API_KEY');
  check('.env.local 配了真实管理员密码', Boolean(adminPassword));
  check('.env.local 配了真实智谱 API Key', Boolean(apiKey) && apiKey.length > 20);

  const swapped = swapEnvWithoutSupabase();
  log(swapped ? '已临时摘掉 Supabase 配置：本地模式，不污染云端' : '.env.local 无需改动');
  process.on('exit', restoreEnv);

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AI_TIMEOUT_MS: '180000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => log(`[server] ${String(chunk).trim()}`));
  server.stderr.on('data', chunk => log(`[server:err] ${String(chunk).trim()}`));
  await waitServer();
  log(`server.js 已启动：${BASE}（真实智谱 Key 已加载）`);

  if (!fs.existsSync(CHROME)) throw new Error(`找不到真实 Chrome：${CHROME}`);
  browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  log(`真实 Chrome 已启动：${await browser.version()}`);

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => log(`[pageerror] ${error.message}`));
  await page.goto(`${BASE}/unit-design.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(pwd => {
    localStorage.setItem('isAdmin', 'true');
    localStorage.setItem('pe_admin_password', pwd);
    localStorage.removeItem('pe_big_unit_design_v1');
  }, adminPassword);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => typeof window.generateWholeUnit === 'function'
    && document.getElementById('ud2GenerateBtn'), { timeout: 30000 });

  /* 真实三步选题：球类 → 排球 → 水平二 → 垫球：自垫、对垫启蒙 */
  await page.select('#ud2Category', 'ball');
  await page.evaluate(() => window.onUnitCategoryChange());
  await page.select('#ud2Item', 'volleyball');
  await page.evaluate(() => window.onUnitItemChange && window.onUnitItemChange());
  await page.select('#ud2Level', 'L2');
  await page.evaluate(() => window.onUnitLevelChange());
  await page.waitForFunction(
    topic => Array.from(document.querySelectorAll('#ud2Topic option')).some(option => option.value === topic),
    { timeout: 15000 }, TOPIC,
  );
  await page.select('#ud2Topic', TOPIC);
  await page.evaluate(() => window.onUnitTopicChange());
  const selection = await page.evaluate(() => ({
    category: document.getElementById('ud2Category').value,
    item: document.getElementById('ud2Item').value,
    level: document.getElementById('ud2Level').value,
    topic: document.getElementById('ud2Topic').value,
  }));
  check('真实页面选题正确', selection.item === 'volleyball' && selection.level === 'L2'
    && selection.topic === TOPIC, JSON.stringify(selection));

  /* 真实点击一键生成 */
  await page.evaluate(() => {
    const el = document.getElementById('ud2GenerateBtn');
    el.scrollIntoView({ block: 'center', inline: 'center' });
  });
  await page.click('#ud2GenerateBtn');
  log('已真实点击【✨ 一键生成完整大单元】，等待 22 步流水线（真实 API，请耐心）…');

  const started = Date.now();
  const TIMEOUT_MS = 15 * 60 * 1000;
  let done = false;
  let snapshot = null;
  while (Date.now() - started < TIMEOUT_MS) {
    snapshot = await page.evaluate(() => {
      const raw = localStorage.getItem('pe_big_unit_design_v1');
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (error) { data = null; }
      const lessons = Array.isArray(data?.lessons) ? data.lessons : [];
      const filled = lessons.filter(item => item && String(item.content || '').length > 0).length;
      return {
        generating: /正在分步生成/.test(document.getElementById('ud2GenerateBtn')?.textContent || ''),
        status: document.getElementById('ud2Status')?.textContent || '',
        filled, total: lessons.length,
        data,
      };
    });
    if (!snapshot.generating && snapshot.filled >= 18) { done = true; break; }
    if ((Date.now() - started) % 30000 < 1000) {
      log(`生成中… 已落盘 ${snapshot.filled}/18 课时；状态：${snapshot.status.slice(0, 80)}`);
    }
    await sleep(1000);
  }
  check('18 课时全部生成完毕', done,
    `filled=${snapshot?.filled} status=${snapshot?.status?.slice(0, 160)}`);

  const data = snapshot.data;
  const lessons = data.lessons.slice().sort((a, b) => Number(a.no) - Number(b.no));
  fs.writeFileSync(RAW, JSON.stringify({
    selection, lessons, structure_nodes: data.structure_nodes || [],
  }, null, 2));
  log(`18 课时原文已保存：${RAW}`);

  const titles = (data.structure_nodes || []).slice().sort((a, b) => Number(a.id) - Number(b.id))
    .map(node => String(node.title || ''));
  check('结构图 18 个节点齐全', titles.length === 18, `实际 ${titles.length}`);

  const violations = [];
  lessons.forEach(lesson => {
    const text = `${lesson.objectives || ''}\n${lesson.content || ''}\n${lesson.method || ''}`;
    const match = text.match(BANNED);
    if (match) violations.push(`第${lesson.no}课：${match[0]}`);
  });
  titles.forEach((title, index) => {
    const match = title.match(BANNED);
    if (match) violations.push(`结构图第${index + 1}节点「${title}」：${match[0]}`);
  });
  check('18 课时标题与内容零其它技术', violations.length === 0, violations.join('；') || '发球/传球等字样均未出现');

  const m7 = lessons[6];
  const m11 = lessons[10];
  log(`第 7 课时标题/内容摘要：${String(m7.content || '').slice(0, 120)}`);
  log(`第 11 课时标题/内容摘要：${String(m11.content || '').slice(0, 120)}`);
  check('第 7 课围绕垫球', /垫/.test(String(m7.content || '')), '不许是传球');
  check('第 11 课围绕垫球', /垫/.test(String(m11.content || '')), '不许是传球综合');

  log('🎉 真实页面验收通过：排球「垫球：自垫、对垫启蒙」18 课时全程零传球 / 零发球');
}

main()
  .catch(error => {
    log(`❌ E2E 失败：${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch (error) { /* 忽略 */ }
    try { if (server) server.kill('SIGTERM'); } catch (error) { /* 忽略 */ }
    restoreEnv();
    fs.writeFileSync(LOG, `${lines.join('\n')}\n`);
    log(`完整日志已保存：${LOG}`);
  });
