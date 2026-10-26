/**
 * 一次性迁移工具：把浏览器 localStorage 里的现有数据导入 Supabase
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

function localCount(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.length : (value && typeof value === 'object' ? Object.keys(value).length : 1);
  } catch {
    return null;
  }
}

function tableOf(key) {
  const entry = Object.entries(STORE_KEY_MAP).find(([mapKey]) => mapKey === key);
  return entry ? entry[1].table : '-';
}

function renderRows() {
  const keys = Object.keys(STORE_KEY_MAP);
  migrateRows.innerHTML = keys.map(key => {
    const count = localCount(key);
    const label = MIGRATE_KEY_LABELS[key] || key;
    return `<tr data-key="${key}">
      <td>${label}<br><span style="color:var(--text-tertiary);font-size:12px;">${key}</span></td>
      <td><code class="inline">${tableOf(key)}</code></td>
      <td>${count === null ? '—' : count}</td>
      <td class="migrate-status-cell">${count === null ? '无本地数据' : '待导入'}</td>
    </tr>`;
  }).join('');
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

async function runMigration() {
  if (Store.mode !== 'supabase') {
    appendLog('未连接 Supabase，无法导入。请先配置 SUPABASE_URL / SUPABASE_ANON_KEY 并重启服务。');
    return;
  }
  if (!confirm('将把本机 localStorage 数据写入 Supabase（同表会被覆盖）。确认继续？')) return;

  migrateButton.disabled = true;
  migrateButton.textContent = '正在导入…';
  try {
    const report = await Store.importFromLocalStorage();
    report.forEach(item => {
      const label = MIGRATE_KEY_LABELS[item.key] || item.key;
      if (item.status === 'ok') {
        setRowStatus(item.key, `已导入 ${item.count} 条`);
        appendLog(`✔ ${label} → ${tableOf(item.key)}：${item.count} 条`);
      } else if (item.status === 'skipped') {
        setRowStatus(item.key, '无本地数据');
        appendLog(`– ${label}：本地无数据，跳过`);
      } else if (item.status === 'invalid') {
        setRowStatus(item.key, 'JSON 损坏', true);
        appendLog(`✘ ${label}：本地数据不是合法 JSON，已跳过`);
      } else {
        setRowStatus(item.key, `失败：${item.message}`, true);
        appendLog(`✘ ${label}：${item.message}`);
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

function downloadBackup() {
  const payload = {};
  Object.keys(STORE_KEY_MAP).forEach(key => {
    const raw = localStorage.getItem(key);
    if (raw !== null) payload[key] = JSON.parse(raw);
  });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pe-workbench-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

Store.ready.then(mode => {
  if (mode === 'supabase') {
    migrateMode.textContent = `已连接 Supabase（${Store.mode}）：可以开始导入。`;
    migrateMode.classList.add('is-ok');
  } else {
    migrateMode.textContent = '未连接 Supabase：请先在 .env.local（本地）或 Vercel 环境变量中配置 SUPABASE_URL 与 SUPABASE_ANON_KEY，并重启服务后刷新本页。';
    migrateMode.classList.add('is-error');
    migrateButton.disabled = true;
  }
});

renderRows();
