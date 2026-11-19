/**
 * 真实接口回归（Node.js 直连 /api/ai + 真实智谱 GLM）：
 *   选「羽毛球 / 击高远球」，逐课次真实生成 18 课时，
 *   断言输出里连「杀球」「吊球」都没有，也没有「搓球」和综合/战术组合赛。
 *
 *   node tests/unit-focus-badminton-real.mjs
 *
 * 不做浏览器：直接用 Node.js fetch 打本地 server.js 的真实 /api/ai 接口。
 * 全程真实上游请求，会消耗智谱额度；产物写到 tests/e2e/unit-focus-badminton-output.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENV_LOCAL = path.join(ROOT, '.env.local');
const ENV_BACKUP = `${ENV_LOCAL}.badminton-real-backup`;
const OUTPUT = path.join(ROOT, 'tests/e2e/unit-focus-badminton-output.json');
const PORT = Number(process.env.E2E_PORT) || 5244;
const BASE = `http://127.0.0.1:${PORT}`;
const TOPIC = '击高远球';
const BANNED = /杀球|吊球|搓球/;
const BAD_MATCH = /综合对抗赛|战术组合赛|技术组合赛|实战综合赛|攻防对抗赛/;

const catalog = require(path.join(ROOT, 'js/unit-catalog.js'));
const lines = [];
function log(message) {
  const line = `[REAL ${new Date().toISOString().slice(11, 23)}] ${message}`;
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
  throw new Error(`server.js 在 ${timeoutMs}ms 内没有就绪`);
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

async function readSSEContent(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      frame.split('\n').forEach(line => {
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') return;
        try {
          const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') content += delta;
        } catch (error) { /* 非 JSON 帧（如 event: truncated）忽略 */ }
      });
      index = buffer.indexOf('\n\n');
    }
  }
  return content;
}

let server = null;

async function main() {
  const adminPassword = readEnvValue('ADMIN_PASSWORD');
  const apiKey = readEnvValue('VITE_ZHIPUAI_API_KEY');
  check('.env.local 配了真实管理员密码', Boolean(adminPassword));
  check('.env.local 配了真实智谱 API Key', Boolean(apiKey) && apiKey.length > 20);

  const swapped = swapEnvWithoutSupabase();
  log(swapped ? '已临时摘掉 Supabase：本机模式，不污染云端' : '.env.local 无需改动');
  process.on('exit', restoreEnv);

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AI_TIMEOUT_MS: '180000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => log(`[server] ${String(chunk).trim()}`));
  server.stderr.on('data', chunk => log(`[server:err] ${String(chunk).trim()}`));
  await waitServer();
  log(`server.js 已启动：${BASE}（真实智谱接口）`);

  const fullList = catalog.unitTopicListWithDimension('badminton', 'L2');
  const topicList = catalog.unitFocusTopicList(fullList, TOPIC);
  const forbidden = catalog.unitForbiddenTechniques(fullList, TOPIC);
  check('击高远球识别为单一技术', catalog.unitCoreTechniqueOf(TOPIC) === '高远球');
  check('违禁词含杀球 / 吊球 / 搓球', ['杀球', '吊球', '搓球'].every(word => forbidden.includes(word)),
    forbidden.join('、'));
  const lessonTitles = catalog.unitFocusProgressionTitles(TOPIC);
  const context = {
    unitTitle: '羽毛球高远球大单元',
    objectives: '运动能力：学生能连续完成正手击高远球，知道击球点与发力顺序；健康行为：主动热身放松并遵守场地安全；体育品德：遵守规则、轮流等待、互相纠错。',
    teachingContent: topicList.join('；'),
    lessonTitles: lessonTitles.map((title, index) => ({ no: index + 1, title })),
  };

  const outputs = [];
  const violations = [];
  for (let no = 1; no <= 18; no += 1) {
    const body = {
      type: 'unit', stage: 'lesson_single', lessonNo: no,
      category: '球类', item: '羽毛球', level: '水平二（3–4 年级）', topic: TOPIC,
      topicPending: false, itemId: 'badminton', levelId: 'L2', topicList, context,
    };
    const response = await fetch(`${BASE}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': adminPassword },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(200000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`第 ${no} 课真实接口失败 HTTP ${response.status}：${text.slice(0, 300)}`);
    }
    const content = await readSSEContent(response);
    check(`第 ${no} 课真实生成有内容`, content.length > 40, `${content.length} 字`);
    const hit = content.match(BANNED);
    const badMatch = content.match(BAD_MATCH);
    if (hit) {
      const index = content.indexOf(hit[0]);
      const contextText = content.slice(Math.max(0, index - 160), index + 200);
      log(`⚠️ 第 ${no} 课命中违禁词「${hit[0]}」上下文：${contextText.replace(/\s+/g, ' ')}`);
      violations.push(`第${no}课：${hit[0]}`);
    }
    if (badMatch) violations.push(`第${no}课比赛：${badMatch[0]}`);
    outputs.push({ no, content, violation: hit?.[0] || badMatch?.[0] || '' });
    log(`第 ${no} 课摘要：${content.slice(0, 90).replace(/\s+/g, ' ')}`);
  }

  fs.writeFileSync(OUTPUT, JSON.stringify({ topic: TOPIC, forbidden, violations, outputs }, null, 2));
  log(`18 课时原文已保存：${OUTPUT}`);
  check('18 课时零违禁技术 / 零综合对抗赛', violations.length === 0, violations.join('；'));
  log('🎉 真实接口验收通过：羽毛球「击高远球」18 课时零杀球 / 零吊球 / 零搓球，零综合对抗赛');
}

main()
  .catch(error => {
    log(`❌ 真实接口测试失败：${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    try { if (server) server.kill('SIGTERM'); } catch (error) { /* 忽略 */ }
    restoreEnv();
    const logFile = path.join(ROOT, 'tests/e2e/unit-focus-badminton-real.log');
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`);
    log(`完整日志已保存：${logFile}`);
  });
