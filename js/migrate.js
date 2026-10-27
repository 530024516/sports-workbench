/**
 * 数据迁移工具：localStorage → Supabase
 *
 * 覆盖：所有 STORE_KEYS + 本机 localStorage 里任何 pe_* / sportsMeet* 键（含历史遗留键）
 * 支持：一键导入、强制覆盖（本地没有的键也把云端清空）、清空云端、清空本地
 * 打开方式：node server.js → http://localhost:5123/migrate.html
 */
'use strict';

const MIGRATE_KEY_LABELS = {
  pe_students: '学生信息',
  pe_fitness_records: '体测数据',
  pe_attendance: '考勤记录',
  pe_lesson_plans: '教案',
  pe_resources: '教学资源',
  pe_courses: '课程',
  pe_schedule_v1: '周课表',
  pe_todos_v1: '待办清单',
  pe_todo_v1: '待办清单（旧版键）',
  pe_fitness_weekly_log_v1: '健身训练记录',
  pe_big_unit_design_v1: '大单元设计',
  pe_sports_meet_v1: '运动会数据',
  pe_week_mode: '单双周设置',
  pe_workbench_display_settings_v1: '工作台显示设置',
  sportsMeetTitle: '运动会标题',
};

const migrateRows = document.getElementById('migrateRows');
const migrateMode = document.getElementById('migrateMode');
const migrateLog = document.getElementById('migrateLog');
const migrateButton = document.getElementById('migrateImportBtn');
const forceCheckbox = document.getElementById('migrateForce');

// 服务端下发的键 → 表映射（lib/store-schema.js）
function schemaOf(key) {
  return (Store.schema || []).find(item => item.key === key) || null;
}

/** 本机所有相关键：内置键 + localStorage 里任何 pe_* / sportsMeet*（排除备份副本） */
function collectLocalKeys() {
  const keys = new Set(STORE_KEYS);
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key.includes('__local_backup')) continue;
    if (/^pe_/.test(key) || /^sportsMeet/i.test(key)) keys.add(key);
  }
  return [...keys];
}

/** 该键为空时的取值：单例 null、对象型 {}、集合 [] */
function emptyValueOf(key) {
  const config = schemaOf(key);
  if (config?.singleton) return null;
  if (config?.objectMap) return {};
  return [];
}

function isKnown(key) {
  return Boolean(schemaOf(key));
}

function tableOf(key) {
  return schemaOf(key)?.table || '—（云端无对应表）';
}

function labelOf(key) {
  return schemaOf(key)?.label || MIGRATE_KEY_LABELS[key] || key;
}

function rawOf(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return undefined;
  }
}

function localCount(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  const value = rawOf(key);
  if (value === undefined) return null;
  return Array.isArray(value) ? value.length : (value && typeof value === 'object' ? Object.keys(value).length : 1);
}

function renderRows() {
  const keys = collectLocalKeys();
  migrateRows.innerHTML = keys.map(key => {
    const count = localCount(key);
    const known = isKnown(key);
    return `<tr data-key="${key}">
      <td>${labelOf(key)}<br><span style="color:var(--text-tertiary);font-size:12px;">${key}</span></td>
      <td><code class="inline">${tableOf(key)}</code></td>
      <td>${count === null ? '—' : (rawOf(key) === undefined ? 'JSON 损坏' : count)}</td>
      <td class="migrate-status-cell">${!known ? '云端无对应表，将跳过' : (count === null ? '无本地数据' : '待导入')}</td>
      <td>${count === null ? '' : `<button class="btn btn-ghost" type="button" onclick="removeLocalKey('${key}')">删除本机</button>`}</td>
    </tr>`;
  }).join('');
  return keys;
}

function appendLog(text) {
  migrateLog.hidden = false;
  migrateLog.textContent += `${text}\n`;
}

function setRowStatus(key, text, isError = false) {
  const cell = migrateRows.querySelector(`tr[data-key="${key}"] .migrate-status-cell`);
  if (!cell) return;
  cell.textContent = text;
  cell.style.color = isError ? 'var(--danger)' : 'var(--success, #2e7d32)';
}

/** 构造提交内容：force=true 时，本地没有的键也提交空值（把云端清掉） */
function buildPayload(keys, { force = false } = {}) {
  const values = {};
  const skipped = [];
  keys.forEach(key => {
    if (!isKnown(key)) { skipped.push(key); return; }
    const raw = localStorage.getItem(key);
    if (raw === null) {
      if (force) values[key] = emptyValueOf(key);
      else skipped.push(key);
      return;
    }
    const parsed = rawOf(key);
    if (parsed === undefined) { skipped.push(key); return; }
    values[key] = parsed;
  });
  return { values, skipped };
}

async function postValues(values) {
  const response = await fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function runMigration() {
  if (Store.mode !== 'supabase') {
    appendLog('未连接 Supabase，无法导入。请在服务端配置 SUPABASE_URL / SUPABASE_ANON_KEY 后重启服务。');
    return;
  }
  const force = Boolean(forceCheckbox?.checked);
  const keys = collectLocalKeys();
  if (!confirm(force
    ? '强制覆盖：将用本机数据整体替换云端同名数据（本机没有的键会把云端清空）。确认继续？'
    : '将把本机 localStorage 数据写入 Supabase（同表会被覆盖）。确认继续？')) return;

  migrateButton.disabled = true;
  migrateButton.textContent = '正在导入…';
  try {
    const { values, skipped } = buildPayload(keys, { force });
    const payload = await postValues(values);
    const report = payload.report || [];
    const byKey = Object.fromEntries(report.map(item => [item.key, item]));

    keys.forEach(key => {
      const label = labelOf(key);
      if (!isKnown(key)) {
        setRowStatus(key, '云端无对应表，已跳过', false);
        appendLog(`– ${label}（${key}）：云端无对应表，已跳过（请用「导出 JSON 备份」留档）`);
        return;
      }
      const item = byKey[key];
      if (item && item.status === 'ok') {
        setRowStatus(key, `已导入 ${item.count} 条`);
        appendLog(`✔ ${label} → ${tableOf(key)}：${item.count} 条`);
      } else if (item && item.status === 'error') {
        setRowStatus(key, `失败：${item.message}`, true);
        appendLog(`✘ ${label}：${item.message}`);
      } else if (localStorage.getItem(key) !== null && rawOf(key) === undefined) {
        setRowStatus(key, 'JSON 损坏，已跳过', true);
        appendLog(`✘ ${label}：本地数据不是合法 JSON，已跳过`);
      } else {
        setRowStatus(key, '无本地数据，已跳过');
        appendLog(`– ${label}：本地无数据，跳过${force ? '（未强制清空）' : ''}`);
      }
    });

    const failed = report.filter(item => item.status === 'error').length;
    appendLog(failed ? `导入完成，${failed} 项失败。` : '导入完成，请打开工作台核对数据。');
  } catch (error) {
    appendLog(`导入失败：${error?.message || error}`);
  } finally {
    migrateButton.disabled = false;
    migrateButton.textContent = '一键导入云端';
  }
}

/** 只删除本机的某一个键（用于清掉示例数据、保留真实数据） */
function removeLocalKey(key) {
  if (!confirm(`确认删除本机的 ${labelOf(key)}（${key}）？此操作不可恢复，建议先点「导出 JSON 备份」。`)) return;
  localStorage.removeItem(key);
  appendLog(`已删除本机 ${labelOf(key)}（${key}）。`);
  renderRows();
}

/** 清空云端：把全部已知键提交空值（整表删除） */
async function clearCloudData() {
  if (Store.mode !== 'supabase') {
    appendLog('未连接 Supabase，无法清空云端。');
    return;
  }
  if (!confirm('将清空 Supabase 中全部工作台数据（12 张表），此操作不可恢复。确认继续？')) return;
  const values = {};
  STORE_KEYS.forEach(key => { if (isKnown(key)) values[key] = emptyValueOf(key); });
  try {
    const payload = await postValues(values);
    const report = payload.report || [];
    report.forEach(item => {
      if (item.status === 'ok') {
        setRowStatus(item.key, '云端已清空');
        appendLog(`✔ ${labelOf(item.key)}：云端已清空`);
      } else {
        appendLog(`✘ ${labelOf(item.key)}：${item.message}`);
      }
    });
    appendLog('云端数据已全部清空（示例数据和残留记录一并删除）。');
  } catch (error) {
    appendLog(`清空云端失败：${error?.message || error}`);
  }
}

/** 清空本地：删除所有键及其备份副本 */
function clearLocalData() {
  if (!confirm('将删除本浏览器中所有工作台本地数据（含 __local_backup 备份）。确认继续？')) return;
  const keys = collectLocalKeys();
  keys.forEach(key => {
    localStorage.removeItem(key);
    localStorage.removeItem(`${key}__local_backup`);
  });
  appendLog(`本地已清空 ${keys.length} 个键（含备份副本）。刷新页面后不会再有示例数据。`);
  renderRows();
}

function downloadBackup() {
  const payload = {};
  collectLocalKeys().forEach(key => {
    const raw = localStorage.getItem(key);
    if (raw !== null) payload[key] = rawOf(key);
  });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pe-workbench-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// 配置探测结果：ok=请求是否成功，configured=服务端是否配置了 Supabase
let configProbe = { ok: null, configured: null, reason: '' };

/** 主动探测连接状态：带 5 秒超时，失败即判定未连接，不会一直"正在连接" */
async function refreshConnectionStatus() {
  configProbe = await Store.probeConfig();
  renderConnectionStatus();
}

function renderConnectionStatus() {
  renderRows();
  const setState = (text, state) => {
    migrateMode.textContent = text;
    migrateMode.classList.remove('is-ok', 'is-error');
    if (state) migrateMode.classList.add(state);
  };

  if (Store.mode === 'supabase') {
    setState('已连接 Supabase：可以开始导入。', 'is-ok');
    migrateButton.disabled = false;
    return;
  }
  if (configProbe.ok === false) {
    setState(`未连接 Supabase：接口请求失败（${configProbe.reason || '超时或网络异常'}）。当前使用 localStorage，页面可正常操作。`, 'is-error');
    migrateButton.disabled = true;
    return;
  }
  if (configProbe.configured === false) {
    setState('未连接 Supabase：服务端未配置 SUPABASE_URL 与 SUPABASE_ANON_KEY（本地写入 .env.local，Vercel 写在项目环境变量），重启服务后点「重新检测」。当前使用 localStorage，页面可正常操作。', 'is-error');
    migrateButton.disabled = true;
    return;
  }
  // 探测还没回来：最多再等 5 秒，超时后 Store 会自动置为未连接并再次触发本函数
  setState('正在连接 Supabase…', null);
  migrateButton.disabled = true;
}

// Store 状态变化（含同步失败降级）时立刻刷新；同时主动探测一次
Store.onReady(renderConnectionStatus);
refreshConnectionStatus();
