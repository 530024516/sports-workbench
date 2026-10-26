/**
 * 健身助手（个人工具）
 * 左侧：生成今日训练计划并保存到今日记录
 * 右侧：本周训练看板（localStorage 持久化，Markdown 详情弹窗）
 * AI 生成走统一入口 /api/ai（type: 'fitness'，SSE 流式）；环境变量由服务端读取
 */

'use strict';

Layout.init('fitness-assistant', '健身助手', '个人工具 / 健身助手');

const FITNESS_EQUIPMENT = ['无器械', '哑铃', '弹力带', '杠铃', '瑜伽垫', '单杠'];
const FITNESS_WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const FITNESS_LOG_KEY = 'pe_fitness_weekly_log_v1';
const FITNESS_SOURCE_LABEL = { ai: 'AI 生成', manual: '手动创建' };
const FITNESS_AI_TIMEOUT_MS = 120000;

const fitnessContent = document.getElementById('page-content');
let fitnessCurrentPlan = null;

fitnessContent.innerHTML = `
  <div class="page-header">
    <div>
      <h1>健身助手</h1>
      <p>填写今日训练部位与可用器械，生成计划并沉淀到一周训练看板</p>
    </div>
  </div>
  <div class="fitness-assistant-layout">
    <div class="fitness-column fitness-column-main">
      <section class="card">
        <div class="card-header">
          <div class="card-title"><span>🏋️</span> 今日训练需求</div>
        </div>
        <div class="card-body">
          <form id="fitnessAssistantForm" onsubmit="return false;">
            <div class="form-group">
              <label for="fitnessTarget">今日想练什么部位 <span class="required">*</span></label>
              <input id="fitnessTarget" class="form-control" type="text" autocomplete="off"
                placeholder="例如：胸、背、腿、肩、核心、全身">
              <p class="fitness-field-hint">多个部位可用「+」或逗号分隔，如：胸 + 三头</p>
            </div>
            <div class="form-group">
              <label for="fitnessEquipmentOther">可用器械</label>
              <div class="fitness-equipment-options" id="fitnessEquipmentOptions" role="group" aria-label="可用器械">
                ${FITNESS_EQUIPMENT.map((item, index) => `
                  <label class="fitness-equipment-chip">
                    <input type="checkbox" value="${escapeFitnessHTML(item)}" ${index === 0 ? 'checked' : ''}
                      onchange="syncFitnessEquipmentChip(this)">
                    <span>${escapeFitnessHTML(item)}</span>
                  </label>`).join('')}
              </div>
              <input id="fitnessEquipmentOther" class="form-control" type="text" autocomplete="off"
                placeholder="其他器械（选填），多个请用逗号分隔，如：壶铃、跳绳">
              <p class="fitness-field-hint">默认勾选「无器械」，可多选。</p>
            </div>
            <div class="fitness-form-actions">
              <button id="fitnessGenerateBtn" class="btn btn-primary btn-lg" type="button" onclick="generateFitnessPlan()">生成今日训练计划</button>
              <button id="fitnessManualBtn" class="btn btn-secondary btn-lg" type="button" onclick="openManualFitnessPlanModal()">+ 手动创建计划</button>
              <button class="btn btn-ghost" type="button" onclick="resetFitnessForm()">重置</button>
            </div>
          </form>
        </div>
      </section>
      <section class="card">
        <div class="card-header">
          <div class="card-title"><span>📋</span> 今日训练计划</div>
          <span class="tag" id="fitnessPlanSourceTag">待生成</span>
        </div>
        <div class="card-body">
          <div class="result-container" id="fitnessResult" role="region" aria-live="polite" aria-label="训练计划生成结果"></div>
          <div class="fitness-plan-actions" id="fitnessPlanActions" hidden></div>
        </div>
      </section>
    </div>
    <aside class="fitness-column fitness-column-board">
      <section class="card">
        <div class="card-header">
          <div class="card-title"><span>📅</span> 本周训练看板</div>
          <button class="btn btn-ghost btn-sm" type="button" onclick="requestClearFitnessWeek()">清空本周记录</button>
        </div>
        <div class="card-body">
          <p class="fitness-week-range" id="fitnessWeekRange"></p>
          <div class="fitness-week-grid" id="fitnessWeekGrid"></div>
          <p class="fitness-board-hint">点击任意一天查看完整训练计划。</p>
        </div>
      </section>
    </aside>
  </div>
`;

function escapeFitnessHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderFitnessMarkdown(value) {
  const markdown = String(value || '');
  if (!markdown.trim()) return '<p class="markdown-empty">暂无训练计划内容。</p>';
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return `<p>${escapeFitnessHTML(markdown).replace(/\r?\n/g, '<br>')}</p>`;
  }
  return DOMPurify.sanitize(marked.parse(markdown, { breaks: true, gfm: true }));
}

function syncFitnessEquipmentChip(input) {
  const chip = input.closest('.fitness-equipment-chip');
  if (chip) chip.classList.toggle('is-checked', input.checked);
}

function getFitnessFormData() {
  const target = String(document.getElementById('fitnessTarget')?.value || '').trim();
  const equipment = Array.from(document.querySelectorAll('#fitnessEquipmentOptions input:checked'))
    .map(input => input.value);
  const otherText = String(document.getElementById('fitnessEquipmentOther')?.value || '');
  otherText.split(/[,，、;；]/).forEach(item => {
    const value = item.trim();
    if (value && !equipment.includes(value)) equipment.push(value);
  });
  return { target, equipment };
}

function renderFitnessNotice(message, type = 'info') {
  const result = document.getElementById('fitnessResult');
  if (!result) return;
  result.innerHTML = `
    <div class="result-placeholder ${escapeFitnessHTML(type)}">
      <span class="result-icon">${type === 'error' ? '⚠️' : '🤖'}</span>
      <p>${escapeFitnessHTML(message)}</p>
    </div>`;
}

/* ---------- 日期工具：本周（周一 ~ 周日） ---------- */

function toFitnessDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getFitnessWeekStart(reference = new Date()) {
  const date = new Date(reference);
  const weekday = date.getDay(); // 0 = 周日
  date.setDate(date.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  date.setHours(0, 0, 0, 0);
  return date;
}

function getFitnessWeekKeys(reference = new Date()) {
  const monday = getFitnessWeekStart(reference);
  return FITNESS_WEEKDAYS.map((_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return toFitnessDateKey(date);
  });
}

function formatFitnessShortDate(dateKey) {
  const [, month, day] = String(dateKey).split('-');
  return `${Number(month)}月${Number(day)}日`;
}

function formatFitnessFullDate(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const weekday = FITNESS_WEEKDAYS[(new Date(year, month - 1, day).getDay() + 6) % 7];
  return `${year}年${month}月${day}日 ${weekday}`;
}

/* ---------- 训练记录存储 ---------- */

function loadFitnessLogs() {
  const saved = Store.read(FITNESS_LOG_KEY, {});
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}

function persistFitnessLogs(logs) {
  Store.write(FITNESS_LOG_KEY, logs);
  return true;
}

function saveFitnessRecord(dateKey, plan) {
  const logs = loadFitnessLogs();
  logs[dateKey] = {
    date: dateKey,
    target: plan.target,
    equipment: plan.equipment,
    markdown: plan.markdown,
    source: plan.source === 'manual' ? 'manual' : 'ai',
    savedAt: new Date().toISOString(),
  };
  if (!persistFitnessLogs(logs)) return false;
  renderFitnessWeekBoard();
  showToast(`已保存到 ${formatFitnessShortDate(dateKey)} 的训练记录。`);
  return true;
}

function deleteFitnessRecord(dateKey, options = {}) {
  const logs = loadFitnessLogs();
  if (!logs[dateKey]) return;
  closeFitnessTopModal();
  delete logs[dateKey];
  if (!persistFitnessLogs(logs)) return;
  renderFitnessWeekBoard();
  if (!options.silent) showToast(`已删除 ${formatFitnessShortDate(dateKey)} 的训练记录。`);
}

/* ---------- AI 生成计划 ---------- */

function setFitnessGenerating(generating) {
  const generateBtn = document.getElementById('fitnessGenerateBtn');
  const manualBtn = document.getElementById('fitnessManualBtn');
  if (generateBtn) {
    generateBtn.disabled = generating;
    generateBtn.textContent = generating ? 'AI 教练正在排课中...' : '生成今日训练计划';
  }
  if (manualBtn) manualBtn.disabled = generating;
}

/** 去掉模型可能包裹的代码围栏 */
function normalizeFitnessMarkdown(value) {
  return String(value || '')
    .replace(/^```(?:markdown|md)?\s*|\s*```$/gi, '')
    .trim();
}

/** 读取 /api/ai 的 SSE 流式响应，拼接为完整正文 */
async function readFitnessStream(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('浏览器不支持读取 AI 流式响应，请更新浏览器后重试。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let truncated = false;
  let warning = '';

  const consumeFrame = frame => {
    let eventName = 'message';
    const dataLines = [];
    frame.split(/\r?\n/).forEach(line => {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    });
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;

    let frameData;
    try {
      frameData = JSON.parse(data);
    } catch {
      return;
    }
    if (eventName === 'truncated' || eventName === 'error') {
      truncated = true;
      warning = frameData.warning || frameData.error || '';
      return;
    }
    const delta = frameData.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') content += delta;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    frames.forEach(consumeFrame);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeFrame(buffer);

  return { content: content.trim(), truncated, warning };
}

async function requestFitnessPlan(payload) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FITNESS_AI_TIMEOUT_MS) : null;

  let response;
  try {
    response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'fitness', ...payload }),
      signal: controller ? controller.signal : undefined,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('AI 响应超时，请稍后重试。');
    throw new Error('无法连接 AI 服务，请确认已运行 node server.js（本地）或已正确部署（线上）。');
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`AI 服务响应异常（HTTP ${response.status}），请稍后重试。`);
    }
    if (response.status === 404) {
      throw new Error('未找到 /api/ai 接口，请通过正确的服务访问本页面（本地运行 node server.js，或部署到 Vercel）。');
    }
    throw new Error(result?.error || `AI 服务请求失败（HTTP ${response.status}）`);
  }

  const { content, truncated, warning } = await readFitnessStream(response);
  const markdown = normalizeFitnessMarkdown(content);
  if (!markdown) throw new Error(warning || 'AI 没有返回训练计划内容，请稍后重试。');
  if (truncated && warning) showToast(warning, 'error');
  return markdown;
}

async function generateFitnessPlan() {
  const { target, equipment } = getFitnessFormData();
  const targetInput = document.getElementById('fitnessTarget');

  if (!target) {
    renderFitnessNotice('请先填写今日想练的部位，再生成训练计划。', 'error');
    showToast('请先填写今日想练的部位。', 'error');
    targetInput?.focus();
    return;
  }

  const equipmentList = equipment.length ? equipment : ['无器械'];
  setFitnessGenerating(true);
  renderFitnessNotice('AI 教练正在为你编排今日训练计划，请稍候…');

  try {
    const markdown = await requestFitnessPlan({ bodyPart: target, equipment: equipmentList });
    fitnessCurrentPlan = { target, equipment: equipmentList, markdown, source: 'ai' };
    renderFitnessPlanResult(fitnessCurrentPlan, FITNESS_SOURCE_LABEL.ai);
    showToast('AI 已生成今日训练计划，确认后可保存到今日记录。');
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误，请稍后重试。';
    renderFitnessNotice(`生成失败：${message}`, 'error');
    showToast(`生成失败：${message}`, 'error');
  } finally {
    setFitnessGenerating(false);
  }
}

/* ---------- 手动创建计划 ---------- */

function openManualFitnessPlanModal() {
  const currentTarget = String(document.getElementById('fitnessTarget')?.value || '').trim();
  const overlay = showModal('手动创建训练计划', `
    <form id="fitnessManualForm" onsubmit="return false;">
      <div class="form-group">
        <label for="fitnessManualTarget">目标部位 <span class="required">*</span></label>
        <input id="fitnessManualTarget" class="form-control" type="text" autocomplete="off"
          value="${escapeFitnessHTML(currentTarget)}" placeholder="例如：胸部">
      </div>
      <div class="form-group">
        <label for="fitnessManualContent">训练内容 <span class="required">*</span></label>
        <textarea id="fitnessManualContent" class="form-control fitness-manual-editor" rows="12"
          placeholder="支持 Markdown 语法，例如：&#10;## 胸部训练&#10;- 平板卧推 4×10&#10;- 上斜哑铃推举 3×12"></textarea>
        <p class="fitness-field-hint">可用 ## 标题、- 列表、**粗体** 与 | 表格 | 排版，保存后按 Markdown 渲染。</p>
      </div>
    </form>`, `
    <button class="btn btn-secondary btn-lg" type="button" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary btn-lg" type="button" onclick="saveManualFitnessPlan()">保存</button>`);
  overlay?.querySelector('.modal')?.classList.add('modal-lg');
  document.getElementById('fitnessManualTarget')?.focus();
}

function saveManualFitnessPlan() {
  const targetInput = document.getElementById('fitnessManualTarget');
  const contentInput = document.getElementById('fitnessManualContent');
  const target = String(targetInput?.value || '').trim();
  const markdown = String(contentInput?.value || '').trim();

  if (!target) {
    showToast('请填写目标部位。', 'error');
    targetInput?.focus();
    return;
  }
  if (!markdown) {
    showToast('请填写训练内容。', 'error');
    contentInput?.focus();
    return;
  }

  const equipment = getFitnessFormData().equipment;
  fitnessCurrentPlan = {
    target,
    equipment: equipment.length ? equipment : ['无器械'],
    markdown,
    source: 'manual',
  };
  const mainTarget = document.getElementById('fitnessTarget');
  if (mainTarget) mainTarget.value = target;

  closeFitnessTopModal();
  renderFitnessPlanResult(fitnessCurrentPlan, FITNESS_SOURCE_LABEL.manual);
  showToast('已创建手动计划，确认后可保存到今日记录。');
}

/* ---------- 统一的结果展示 ---------- */

function renderFitnessPlanResult(plan, sourceLabel) {
  const result = document.getElementById('fitnessResult');
  const actions = document.getElementById('fitnessPlanActions');
  const sourceTag = document.getElementById('fitnessPlanSourceTag');
  if (!result) return;

  const equipmentList = Array.isArray(plan.equipment) && plan.equipment.length ? plan.equipment : ['无器械'];
  result.innerHTML = `
    <div class="result-summary">
      <span class="badge badge-primary">训练部位：${escapeFitnessHTML(plan.target)}</span>
      ${equipmentList.map(item => `<span class="badge badge-info">${escapeFitnessHTML(item)}</span>`).join('')}
      <span class="badge badge-warning">${escapeFitnessHTML(sourceLabel)}</span>
    </div>
    <article class="markdown-body fitness-full-markdown">${renderFitnessMarkdown(plan.markdown)}</article>`;

  if (sourceTag) sourceTag.textContent = sourceLabel;
  if (actions) {
    actions.hidden = false;
    actions.innerHTML = `
      <button class="btn btn-primary" type="button" onclick="saveFitnessPlanToToday()">💾 保存到今日记录</button>
      <span class="fitness-plan-actions-hint">将保存到 ${escapeFitnessHTML(formatFitnessFullDate(toFitnessDateKey(new Date())))}</span>`;
  }
}

function saveFitnessPlanToToday() {
  if (!fitnessCurrentPlan) {
    showToast('请先生成今日训练计划。', 'error');
    return;
  }
  const dateKey = toFitnessDateKey(new Date());
  const existing = loadFitnessLogs()[dateKey];
  if (existing) {
    showModal('覆盖今日记录', `
      <p>${escapeFitnessHTML(formatFitnessFullDate(dateKey))}已有一条训练记录（部位：${escapeFitnessHTML(existing.target || '未填写')}）。</p>
      <p>用当前计划覆盖后会替换原有内容，是否继续？</p>`, `
      <button class="btn btn-ghost" type="button" onclick="closeModal(this)">取消</button>
      <button class="btn btn-danger" type="button" onclick="confirmOverwriteFitnessToday()">覆盖保存</button>`);
    return;
  }
  saveFitnessRecord(dateKey, fitnessCurrentPlan);
}

function confirmOverwriteFitnessToday() {
  closeFitnessTopModal();
  saveFitnessRecord(toFitnessDateKey(new Date()), fitnessCurrentPlan);
}

function resetFitnessForm() {
  const targetInput = document.getElementById('fitnessTarget');
  const otherInput = document.getElementById('fitnessEquipmentOther');
  const actions = document.getElementById('fitnessPlanActions');
  const sourceTag = document.getElementById('fitnessPlanSourceTag');
  if (targetInput) targetInput.value = '';
  if (otherInput) otherInput.value = '';
  if (sourceTag) sourceTag.textContent = '待生成';
  document.querySelectorAll('#fitnessEquipmentOptions input').forEach((input, index) => {
    input.checked = index === 0;
    syncFitnessEquipmentChip(input);
  });
  fitnessCurrentPlan = null;
  if (actions) {
    actions.hidden = true;
    actions.innerHTML = '';
  }
  renderFitnessNotice('填写上方表单并点击「生成今日训练计划」，结果将显示在这里。');
}

/* ---------- 一周训练看板 ---------- */

function renderFitnessWeekBoard() {
  const grid = document.getElementById('fitnessWeekGrid');
  const range = document.getElementById('fitnessWeekRange');
  if (!grid) return;

  const logs = loadFitnessLogs();
  const weekKeys = getFitnessWeekKeys();
  const todayKey = toFitnessDateKey(new Date());

  grid.innerHTML = weekKeys.map((dateKey, index) => {
    const record = logs[dateKey];
    const [, month, day] = dateKey.split('-');
    const classes = ['fitness-day-card'];
    if (record) classes.push('is-recorded');
    if (dateKey === todayKey) classes.push('is-today');
    return `
      <button class="${classes.join(' ')}" type="button" onclick="openFitnessDayDetail('${dateKey}')"
        aria-label="${FITNESS_WEEKDAYS[index]} ${formatFitnessShortDate(dateKey)} ${record ? `已记录：${escapeFitnessHTML(record.target || '训练')}` : '休息日'}">
        <span class="fitness-day-weekday">${FITNESS_WEEKDAYS[index]}</span>
        <span class="fitness-day-date">${Number(month)}/${Number(day)}</span>
        <span class="fitness-day-icon" aria-hidden="true">${record ? '🏋️' : '😴'}</span>
        <span class="fitness-day-status">${record ? escapeFitnessHTML(record.target || '训练') : '休息日'}</span>
      </button>`;
  }).join('');

  if (range) {
    range.textContent = `${formatFitnessShortDate(weekKeys[0])} - ${formatFitnessShortDate(weekKeys[6])}`
      + ` · 本周已记录 ${weekKeys.filter(key => logs[key]).length} 天`;
  }
}

function openFitnessDayDetail(dateKey) {
  const record = loadFitnessLogs()[dateKey];
  const title = `${formatFitnessFullDate(dateKey)} 训练记录`;

  if (!record) {
    showModal(title, `
      <div class="fitness-detail-empty">
        <span class="fitness-detail-empty-icon" aria-hidden="true">😴</span>
        <p>这一天是休息日，还没有训练记录。</p>
        <p class="fitness-detail-empty-tip">在左侧生成计划后点击「保存到今日记录」，即可写入当天。</p>
      </div>`, `
      <button class="btn btn-ghost" type="button" onclick="closeModal(this)">关闭</button>`);
    return;
  }

  const equipment = Array.isArray(record.equipment) ? record.equipment : [];
  showModal(title, `
    <div class="fitness-detail-meta">
      <span class="badge badge-primary">训练部位：${escapeFitnessHTML(record.target || '未填写')}</span>
      <span class="badge badge-warning">${escapeFitnessHTML(FITNESS_SOURCE_LABEL[record.source] || FITNESS_SOURCE_LABEL.ai)}</span>
      ${equipment.map(item => `<span class="badge badge-info">${escapeFitnessHTML(item)}</span>`).join('')}
    </div>
    <article class="markdown-body fitness-full-markdown">${renderFitnessMarkdown(record.markdown)}</article>`, `
    <button class="btn btn-danger" type="button" onclick="deleteFitnessRecord('${dateKey}')">删除当天记录</button>
    <button class="btn btn-ghost" type="button" onclick="closeModal(this)">关闭</button>`);
}

function requestClearFitnessWeek() {
  const logs = loadFitnessLogs();
  const weekKeys = getFitnessWeekKeys();
  const recorded = weekKeys.filter(key => logs[key]);
  if (!recorded.length) {
    showToast('本周还没有训练记录。', 'info');
    return;
  }
  showModal('清空本周记录', `
    <p>将删除本周 ${recorded.length} 条训练记录（${escapeFitnessHTML(formatFitnessShortDate(weekKeys[0]))} - ${escapeFitnessHTML(formatFitnessShortDate(weekKeys[6]))}）。</p>
    <p>删除后无法恢复，是否继续？</p>`, `
    <button class="btn btn-ghost" type="button" onclick="closeModal(this)">取消</button>
    <button class="btn btn-danger" type="button" onclick="confirmClearFitnessWeek()">确认清空</button>`);
}

function confirmClearFitnessWeek() {
  closeFitnessTopModal();
  const logs = loadFitnessLogs();
  getFitnessWeekKeys().forEach(key => delete logs[key]);
  if (!persistFitnessLogs(logs)) return;
  renderFitnessWeekBoard();
  showToast('已清空本周训练记录。');
}

function closeFitnessTopModal() {
  const overlay = document.querySelector('.modal-overlay');
  if (overlay) closeModal(overlay);
}

document.querySelectorAll('#fitnessEquipmentOptions input').forEach(syncFitnessEquipmentChip);
renderFitnessNotice('填写上方表单并点击「生成今日训练计划」，结果将显示在这里。');
Store.ready.then(() => {
  renderFitnessWeekBoard();
});
