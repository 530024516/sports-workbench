'use strict';

Layout.init('unit-design', '大单元设计', '大单元设计');

const UNIT_STORAGE_KEY = 'pe_big_unit_design_v1';
const UNIT_LESSON_COUNT = 18;
const UNIT_SECTIONS = [
  { id: 'analysis', label: '前置分析' },
  { id: 'questions', label: '问题链与结构图' },
  { id: 'lessons', label: '18课次计划表' },
  { id: 'assessment', label: '考核与反思' },
];

function createEmptyUnit() {
  return {
    theme: '',
    textbookAnalysis: '',
    studentAnalysis: '',
    objectives: { ability: '', health: '', character: '' },
    keyPoints: '',
    difficulties: '',
    coreQuestion: '',
    lessons: Array.from({ length: UNIT_LESSON_COUNT }, (_, index) => ({
      number: index + 1,
      question: '',
      objective: '',
      content: '',
      method: '',
      application: '',
      evaluation: '',
    })),
    assessment: '',
    homework: '',
    evaluationSummary: '',
    reflection: '',
  };
}

function loadUnitData() {
  try {
    const saved = Store.read(UNIT_STORAGE_KEY, null);
    const empty = createEmptyUnit();
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return empty;
    const lessons = Array.isArray(saved.lessons) ? saved.lessons : [];
    return {
      ...empty,
      ...saved,
      objectives: { ...empty.objectives, ...(saved.objectives || {}) },
      lessons: empty.lessons.map((lesson, index) => ({
        ...lesson,
        ...(lessons[index] || {}),
        number: index + 1,
      })),
    };
  } catch (error) {
    console.error('读取大单元数据失败', error);
    return createEmptyUnit();
  }
}

// 数据在 Store 就绪后载入（云端为空时为空模板，避免用空数据覆盖云端）
let unitData = createEmptyUnit();
let activeUnitSection = 'analysis';
let selectedUnitLesson = 0;

document.getElementById('page-content').innerHTML = `
  <section class="unit-design-header">
    <div>
      <p class="unit-design-eyebrow">UNIT DESIGN WORKSPACE</p>
      <h1>大单元设计</h1>
      <p>统一规划单元目标、问题链、18课次教学安排与评价反思。</p>
    </div>
    <div class="unit-design-export">
      <button class="btn btn-secondary" type="button" onclick="exportUnitWord()">导出 Word</button>
      <button class="btn btn-secondary" type="button" onclick="printUnitPlan()">打印 / 导出 PDF</button>
    </div>
  </section>
  <div id="unitSaveStatus" class="unit-save-status" role="status" aria-live="polite"></div>
  <section class="sports-meet-card unit-design-card">
    <div class="unit-section-tabs" role="tablist" aria-label="大单元设计板块">
      ${UNIT_SECTIONS.map((section, index) => `
        <button id="unitTab-${section.id}" class="unit-section-tab" type="button" role="tab"
          aria-controls="unitPanel-${section.id}" aria-selected="${index === 0}"
          tabindex="${index === 0 ? '0' : '-1'}" onclick="selectUnitSection('${section.id}')">${section.label}</button>
      `).join('')}
    </div>
    <div class="unit-section-panels">
      <section id="unitPanel-analysis" class="unit-section-panel" role="tabpanel" aria-labelledby="unitTab-analysis">
        ${unitPanelHeader('前置分析', '先明确主题、大概念、学情与单元目标。', 'analysis')}
        <div class="unit-form-grid">
          ${unitField('单元主题 / 大概念', 'theme', '例如：在多样运动情境中发展灵敏与合作能力', true)}
          ${unitField('教材分析', 'textbookAnalysis', '教材内容结构、核心知识技能与单元价值', true)}
          ${unitField('学情分析', 'studentAnalysis', '学生已有经验、能力差异、兴趣与安全注意事项', true)}
          ${unitField('学习目标：运动能力', 'objectives.ability', '单元结束时学生能够……', true)}
          ${unitField('学习目标：健康行为', 'objectives.health', '形成……运动习惯与健康意识', true)}
          ${unitField('学习目标：体育品德', 'objectives.character', '在合作、规则与挑战中……', true)}
          ${unitField('教学重点', 'keyPoints', '本单元重点发展的知识与技能', true)}
          ${unitField('教学难点', 'difficulties', '学生学习中的关键障碍及突破方式', true)}
        </div>
      </section>
      <section id="unitPanel-questions" class="unit-section-panel" role="tabpanel" aria-labelledby="unitTab-questions" hidden>
        ${unitPanelHeader('问题链与结构图', '从单元核心问题逐层拆解到各课次关键问题；点击结构图节点跳转到对应课次计划。', 'questions')}
        <div class="unit-question-entry">
          ${unitField('单元核心问题', 'coreQuestion', '例如：如何在防守压力下创造并利用空间？', false)}
          <div class="unit-question-entry-heading">
            <div><h3>18课次关键问题</h3><p>AI 将结合单元分析和核心问题生成草稿，你也可以逐项编辑。</p></div>
          </div>
          <div id="unitQuestionInputs" class="unit-question-input-grid"></div>
        </div>
        <div class="unit-question-structure-section">
          <div class="unit-question-structure-heading">
            <div><h3>可视化结构图</h3><p>18课次按教学顺序从核心问题逐级展开。</p></div>
            <span class="unit-structure-legend">点击节点可跳到对应计划行</span>
          </div>
          <div id="unitQuestionTimeline" class="unit-question-timeline" aria-label="单元核心问题与18课次树状结构图"></div>
        </div>
      </section>
      <section id="unitPanel-lessons" class="unit-section-panel" role="tabpanel" aria-labelledby="unitTab-lessons" hidden>
        ${unitPanelHeader('18课次计划表', '按课次填写目标、内容、学练活动、比赛运用与评价要点。', 'lessons')}
        <div class="unit-table-wrap">
          <table class="data-table unit-lesson-table">
            <thead><tr>
              <th>课时序号</th><th>学习目标</th><th>教学内容</th><th>组织教法与学练活动</th><th>比赛 / 运用活动</th><th>学习表现 / 评价要点</th>
            </tr></thead>
            <tbody id="unitLessonRows"></tbody>
          </table>
        </div>
      </section>
      <section id="unitPanel-assessment" class="unit-section-panel" role="tabpanel" aria-labelledby="unitTab-assessment" hidden>
        ${unitPanelHeader('考核与反思', '明确评价依据、作业安排，并汇总证据与单元实施反思。', 'assessment')}
        <div class="unit-form-grid">
          ${unitField('单元总评方式', 'assessment', '评价维度、权重、过程性与终结性评价方式', true)}
          ${unitField('作业设计', 'homework', '课内外衔接的练习任务、频次及安全要求', true)}
          ${unitField('评价数据汇总', 'evaluationSummary', '记录达成情况、数据证据与后续改进方向', true)}
          ${unitField('教学反思', 'reflection', '单元实施效果、学生差异、改进设想', true)}
        </div>
      </section>
    </div>
  </section>
`;

function unitPanelHeader(title, description, section) {
  const buttonLabel = section === 'questions' ? '✨ AI 一键拆解' : '✨ AI 辅助生成';
  return `<div class="unit-panel-heading"><div><h2>${title}</h2><p>${description}</p></div>
    <button class="btn btn-primary" type="button" onclick="generateUnitSection('${section}')">${buttonLabel}</button></div>`;
}

function unitField(label, path, placeholder, multiline) {
  const value = getUnitPath(path);
  const control = multiline
    ? `<textarea class="form-control" data-unit-path="${path}" rows="3" placeholder="${escapeUnitHTML(placeholder)}">${escapeUnitHTML(value)}</textarea>`
    : `<input class="form-control" data-unit-path="${path}" value="${escapeUnitHTML(value)}" placeholder="${escapeUnitHTML(placeholder)}">`;
  return `<label class="unit-form-field"><span>${label}</span>${control}</label>`;
}

function escapeUnitHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function getUnitPath(path) {
  return path.split('.').reduce((value, key) => value?.[key], unitData) ?? '';
}

function setUnitPath(path, value) {
  const keys = path.split('.');
  const finalKey = keys.pop();
  const parent = keys.reduce((current, key) => current[key], unitData);
  parent[finalKey] = value;
}

function saveUnitData() {
  const status = document.getElementById('unitSaveStatus');
  try {
    Store.write(UNIT_STORAGE_KEY, unitData);
    status.textContent = '✓ 已自动保存';
    status.classList.remove('error');
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
    status.classList.add('error');
    console.error('保存大单元数据失败', error);
  }
}

function renderQuestionStructure() {
  document.getElementById('unitQuestionTimeline').innerHTML = `
    <div class="unit-tree-root">${escapeUnitHTML(unitData.coreQuestion || '单元核心问题（待填写）')}</div>
    <div class="unit-tree-connector" aria-hidden="true"></div>
    <div class="unit-tree-branches">${unitData.lessons.map((lesson, index) => `
      <button class="unit-tree-node ${selectedUnitLesson === index + 1 ? 'is-selected' : ''}" type="button"
        onclick="jumpToUnitLesson(${index + 1})" title="第 ${index + 1} 课次：${escapeUnitHTML(lesson.question || '待填写关键问题')}">
        <span class="unit-tree-node-number">第 ${index + 1} 课</span><strong>${escapeUnitHTML(lesson.question || '待填写关键问题')}</strong>
        <span class="unit-tree-tooltip" role="tooltip">${escapeUnitHTML(lesson.question || '关键问题尚未填写')}</span>
      </button>`).join('')}
    </div>`;
  document.getElementById('unitQuestionInputs').innerHTML = unitData.lessons.map((lesson, index) => `
    <label class="unit-question-row"><span>第 ${index + 1} 课</span>
      <input class="form-control" data-unit-question="${index}" value="${escapeUnitHTML(lesson.question)}"
        aria-label="第 ${index + 1} 课关键问题" placeholder="填写本课关键问题"></label>`).join('');
}

function renderUnitLessons() {
  document.getElementById('unitLessonRows').innerHTML = unitData.lessons.map((lesson, index) => `
    <tr id="unitLesson-${index + 1}">
      <th scope="row"><button class="unit-lesson-jump" type="button" onclick="selectUnitSection('questions')">第 ${index + 1} 课</button></th>
      ${[
        ['objective', '学习目标'], ['content', '教学内容'], ['method', '组织教法与学练活动'],
        ['application', '比赛 / 运用活动'], ['evaluation', '学习表现 / 评价要点'],
      ].map(([key, label]) => `<td><textarea class="form-control unit-lesson-input" data-unit-lesson="${index}" data-unit-field="${key}"
        aria-label="第 ${index + 1} 课：${label}" placeholder="${label}">${escapeUnitHTML(lesson[key])}</textarea></td>`).join('')}
    </tr>`).join('');
}

function selectUnitSection(sectionId) {
  const active = UNIT_SECTIONS.find(section => section.id === sectionId) || UNIT_SECTIONS[0];
  activeUnitSection = active.id;
  UNIT_SECTIONS.forEach(section => {
    const selected = section.id === active.id;
    const tab = document.getElementById(`unitTab-${section.id}`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(`unitPanel-${section.id}`).hidden = !selected;
  });
  if (active.id === 'questions') renderQuestionStructure();
  if (active.id === 'lessons') renderUnitLessons();
}

function jumpToUnitLesson(number) {
  selectedUnitLesson = number;
  selectUnitSection('lessons');
  const row = document.getElementById(`unitLesson-${number}`);
  if (row) {
    document.querySelector('.unit-lesson-table tr.is-highlighted')?.classList.remove('is-highlighted');
    row.classList.add('is-highlighted');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => row.classList.remove('is-highlighted'), 2600);
  }
  row?.querySelector('textarea')?.focus({ preventScroll: true });
}

async function generateUnitSection(section) {
  if (!UNIT_SECTIONS.some(item => item.id === section)) return;
  if (section === 'questions' && !(typeof unitData.coreQuestion === 'string' && unitData.coreQuestion.trim())) {
    showUnitNotice('请先填写单元核心问题，再使用 AI 一键拆解。', true);
    document.querySelector('[data-unit-path="coreQuestion"]')?.focus();
    return;
  }
  const button = document.querySelector(`#unitPanel-${section} .unit-panel-heading button`);
  const defaultButtonLabel = section === 'questions' ? '✨ AI 一键拆解' : '✨ AI 辅助生成';
  button.disabled = true;
  button.textContent = '正在生成…';
  try {
    let response;
    try {
      response = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'unit', section, unit: unitData }),
      });
    } catch {
      throw new Error('无法连接本地 AI 服务，请确认已运行 node server.js。');
    }
    if (!response.ok) {
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error(`AI 服务请求失败（HTTP ${response.status}），请稍后重试。`);
      }
      throw new Error(result.error || `AI 服务请求失败（HTTP ${response.status}）`);
    }
    const generated = await readUnitDesignStream(response);
    const truncatedSuffix = '（内容因网络原因可能被截断，请重试或分块生成）';
    if (generated.truncated && !generated.data) {
      showUnitPartialDraft(section, generated.content);
      showUnitNotice(`AI 连接中断，已将收到的部分内容显示在当前板块下方。${truncatedSuffix}`, false, true);
      return;
    }
    validateGeneratedUnit(section, generated.data, generated.truncated);
    mergeGeneratedUnit(section, generated.data);
    saveUnitData();
    renderUnitInputs();
    showUnitNotice(generated.truncated
      ? `已显示并保存可解析的部分结果。${truncatedSuffix}`
      : 'AI 已补全内容，请检查并按教学实际调整。', false, generated.truncated);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误，请稍后重试。';
    showUnitNotice(`AI 辅助生成失败：${message}`, true);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = defaultButtonLabel;
    }
  }
}

async function readUnitDesignStream(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('浏览器不支持读取 AI 流式响应，请更新浏览器后重试。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let streamFinished = false;
  let truncated = false;
  let truncationWarning = '';

  function consumeFrame(frame) {
    let eventName = 'message';
    const dataLines = [];
    frame.split(/\r?\n/).forEach(line => {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    });
    if (!dataLines.length) return;

    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      streamFinished = true;
      return;
    }

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error('AI 流式响应格式异常，请重试。');
    }
    if (eventName === 'truncated') {
      truncated = true;
      truncationWarning = payload.warning || 'AI 连接中断，已收到的内容可能不完整。';
      streamFinished = true;
      return;
    }
    if (eventName === 'error' || payload.error) {
      const message = typeof payload.error === 'string' ? payload.error : payload.error?.message;
      truncated = content.trim().length > 0;
      truncationWarning = message || 'AI 生成过程中连接中断。';
      streamFinished = true;
      return;
    }

    const delta = payload.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') {
      content += delta;
    } else if (Array.isArray(delta)) {
      content += delta.map(part => typeof part?.text === 'string' ? part.text : '').join('');
    }
  }

  try {
    while (!streamFinished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      frames.forEach(consumeFrame);
    }
    buffer += decoder.decode();
    if (!streamFinished && buffer.trim()) consumeFrame(buffer);
  } catch (error) {
    truncated = content.trim().length > 0;
    truncationWarning = error instanceof Error ? error.message : 'AI 连接中断。';
    await reader.cancel().catch(() => {});
    if (!truncated) throw error;
  }

  if (!content.trim()) {
    if (truncated) return { data: null, content, truncated, warning: truncationWarning };
    throw new Error('AI 没有返回生成内容，请稍后重试。');
  }
  if (!streamFinished) {
    truncated = true;
    truncationWarning ||= 'AI 流未正常结束，已收到的内容可能不完整。';
  }
  try {
    return { data: JSON.parse(content), content, truncated, warning: truncationWarning };
  } catch (error) {
    if (truncated) {
      const recovered = recoverPartialJSON(content);
      return { data: recovered, content, truncated: true, warning: truncationWarning };
    }
    throw new Error(`AI 返回内容不是有效 JSON，请重试。（${error.message}）`);
  }
}

function recoverPartialJSON(content) {
  const source = content.trim();
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') stack.pop();
  }

  let candidate = source.replace(/,\s*$/, '');
  if (inString) {
    if (escaped) candidate = candidate.slice(0, -1);
    candidate += '"';
  }
  while (stack.length) {
    candidate += stack.pop() === '{' ? '}' : ']';
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function showUnitPartialDraft(section, content) {
  const panel = document.getElementById(`unitPanel-${section}`);
  if (!panel) return;
  let container = panel.querySelector('.unit-partial-output');
  if (!container) {
    container = document.createElement('section');
    container.className = 'unit-partial-output';
    container.innerHTML = '<h3>AI 已接收的部分内容</h3><p>内容因网络原因可能被截断，请复制需要保留的部分后重试或分块生成。</p><textarea class="form-control" rows="10" readonly aria-label="AI 已接收的部分内容"></textarea>';
    panel.appendChild(container);
  }
  container.querySelector('textarea').value = content;
}

function validateGeneratedUnit(section, generated, allowPartial = false) {
  if (!generated || typeof generated !== 'object' || Array.isArray(generated)) {
    throw new Error('AI 返回的数据格式无效。');
  }
  if (section === 'questions' || section === 'lessons') {
    if (!Array.isArray(generated.lessons)
      || (allowPartial
        ? generated.lessons.length < 1 || generated.lessons.length > UNIT_LESSON_COUNT
        : generated.lessons.length !== UNIT_LESSON_COUNT)) {
      throw new Error('AI 返回的课次数量不是18课，请重试。');
    }
    const fields = section === 'questions'
      ? ['question']
      : ['objective', 'content', 'method', 'application', 'evaluation'];
    if (generated.lessons.some(lesson =>
      !lesson || typeof lesson !== 'object' || Array.isArray(lesson)
      || fields.some(field => allowPartial
        ? lesson[field] !== undefined && typeof lesson[field] !== 'string'
        : typeof lesson[field] !== 'string'))) {
      throw new Error('AI 返回的课次字段不完整，请重试。');
    }
  }
  if (section === 'analysis' && !allowPartial && (!generated.objectives || typeof generated.objectives !== 'object')) {
    throw new Error('AI 返回的三维学习目标不完整，请重试。');
  }
}

function mergeGeneratedUnit(section, generated) {
  if (section === 'analysis') {
    ['theme', 'textbookAnalysis', 'studentAnalysis', 'keyPoints', 'difficulties'].forEach(key => {
      if (!unitData[key] && typeof generated[key] === 'string' && generated[key].trim()) unitData[key] = generated[key];
    });
    if (generated.objectives && typeof generated.objectives === 'object') {
      ['ability', 'health', 'character'].forEach(key => {
        if (!unitData.objectives[key] && typeof generated.objectives[key] === 'string' && generated.objectives[key].trim()) {
          unitData.objectives[key] = generated.objectives[key];
        }
      });
    }
  } else if (section === 'questions') {
    if (!unitData.coreQuestion && typeof generated.coreQuestion === 'string' && generated.coreQuestion.trim()) unitData.coreQuestion = generated.coreQuestion;
    mergeLessonField(generated.lessons, 'question');
  } else if (section === 'lessons') {
    ['objective', 'content', 'method', 'application', 'evaluation'].forEach(key => mergeLessonField(generated.lessons, key));
  } else if (section === 'assessment') {
    ['assessment', 'homework', 'evaluationSummary', 'reflection'].forEach(key => {
      if (!unitData[key] && typeof generated[key] === 'string' && generated[key].trim()) unitData[key] = generated[key];
    });
  }
}

function mergeLessonField(generatedLessons, field) {
  if (!Array.isArray(generatedLessons)) return;
  generatedLessons.slice(0, UNIT_LESSON_COUNT).forEach((lesson, index) => {
    if (!unitData.lessons[index][field] && typeof lesson?.[field] === 'string' && lesson[field].trim()) {
      unitData.lessons[index][field] = lesson[field];
    }
  });
}

function renderUnitInputs() {
  document.querySelectorAll('[data-unit-path]').forEach(input => {
    input.value = getUnitPath(input.dataset.unitPath);
  });
  if (activeUnitSection === 'questions') renderQuestionStructure();
  if (activeUnitSection === 'lessons') renderUnitLessons();
}

function showUnitNotice(message, isError = false, isWarning = false) {
  const status = document.getElementById('unitSaveStatus');
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.classList.toggle('warning', isWarning);
  if (!isError && !isWarning) setTimeout(() => { if (status.textContent === message) saveUnitData(); }, 3500);
}

function buildUnitExportHTML() {
  const lessonRows = unitData.lessons.map(lesson => `<tr>
    <td>第 ${lesson.number} 课</td><td>${escapeUnitHTML(lesson.question)}</td><td>${escapeUnitHTML(lesson.objective)}</td>
    <td>${escapeUnitHTML(lesson.content)}</td><td>${escapeUnitHTML(lesson.method)}</td>
    <td>${escapeUnitHTML(lesson.application)}</td><td>${escapeUnitHTML(lesson.evaluation)}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeUnitHTML(unitData.theme || '大单元设计')}</title>
    <style>body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#222;line-height:1.6;margin:28px}
    h1{text-align:center}h2{margin-top:24px;border-bottom:1px solid #bbb;padding-bottom:6px}
    table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #888;padding:6px;vertical-align:top;text-align:left}
    th{background:#eee}section{white-space:pre-wrap}.page-break{page-break-before:always}
    @media print{body{margin:12mm}table{page-break-inside:auto}tr{page-break-inside:avoid}}</style></head><body>
    <h1>${escapeUnitHTML(unitData.theme || '大单元设计')}</h1>
    <h2>前置分析</h2><section><b>教材分析：</b>${escapeUnitHTML(unitData.textbookAnalysis)}\n<b>学情分析：</b>${escapeUnitHTML(unitData.studentAnalysis)}
    \n<b>运动能力：</b>${escapeUnitHTML(unitData.objectives.ability)}\n<b>健康行为：</b>${escapeUnitHTML(unitData.objectives.health)}
    \n<b>体育品德：</b>${escapeUnitHTML(unitData.objectives.character)}\n<b>教学重点：</b>${escapeUnitHTML(unitData.keyPoints)}
    \n<b>教学难点：</b>${escapeUnitHTML(unitData.difficulties)}</section>
    <h2>问题链与结构</h2><section><b>单元核心问题：</b>${escapeUnitHTML(unitData.coreQuestion)}
    ${unitData.lessons.map(lesson => `\n第 ${lesson.number} 课：${escapeUnitHTML(lesson.question)}`).join('')}</section>
    <h2 class="page-break">18课次计划表</h2><table><thead><tr><th>课次</th><th>主要问题</th><th>学习目标</th><th>教学内容</th><th>组织教法与学练活动</th><th>比赛 / 运用活动</th><th>学习表现 / 评价要点</th></tr></thead>
    <tbody>${lessonRows}</tbody></table>
    <h2 class="page-break">考核与反思</h2><section><b>单元总评方式：</b>${escapeUnitHTML(unitData.assessment)}
    \n<b>作业设计：</b>${escapeUnitHTML(unitData.homework)}\n<b>评价数据汇总：</b>${escapeUnitHTML(unitData.evaluationSummary)}
    \n<b>教学反思：</b>${escapeUnitHTML(unitData.reflection)}</section></body></html>`;
}

function printUnitPlan() {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showUnitNotice('浏览器阻止了打印窗口，请允许此页面打开弹出窗口后重试。', true);
    return;
  }
  printWindow.document.open();
  printWindow.document.write(buildUnitExportHTML());
  printWindow.document.close();
  printWindow.addEventListener('load', () => printWindow.print(), { once: true });
}

function exportUnitWord() {
  const content = buildUnitExportHTML();
  const blob = new Blob(['\ufeff', content], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(unitData.theme || '大单元设计').replace(/[\\/:*?"<>|]/g, '_')}.doc`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('input', event => {
  const path = event.target.dataset.unitPath;
  if (path) {
    setUnitPath(path, event.target.value);
    if (path === 'coreQuestion') {
      const root = document.querySelector('.unit-tree-root');
      if (root) root.textContent = event.target.value || '单元核心问题（待填写）';
    }
    saveUnitData();
  }
  const questionIndex = event.target.dataset.unitQuestion;
  if (questionIndex !== undefined) {
    const index = Number(questionIndex);
    const question = event.target.value;
    unitData.lessons[index].question = question;
    const node = document.querySelectorAll('.unit-tree-node')[index];
    if (node) {
      node.querySelector('strong').textContent = question || '待填写关键问题';
      node.querySelector('.unit-tree-tooltip').textContent = question || '关键问题尚未填写';
      node.title = `第 ${index + 1} 课次：${question || '待填写关键问题'}`;
    }
    saveUnitData();
  }
  const lessonIndex = event.target.dataset.unitLesson;
  const lessonField = event.target.dataset.unitField;
  if (lessonIndex !== undefined && lessonField) {
    unitData.lessons[Number(lessonIndex)][lessonField] = event.target.value;
    saveUnitData();
  }
});

document.querySelectorAll('.unit-section-tab').forEach((tab, index, tabs) => {
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    tabs[nextIndex].focus();
    selectUnitSection(UNIT_SECTIONS[nextIndex].id);
  });
});

Store.ready.then(() => {
  unitData = loadUnitData();
  renderUnitInputs();
});
