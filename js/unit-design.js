'use strict';

Layout.init('unit-design', '大单元设计', '大单元设计');

/**
 * 大单元设计（重构版）
 *
 * 交互：三个下拉框（教材大类/细项 → 水平 → 教学内容，后者按前两项联动过滤）
 *       + 一个「一键生成完整大单元」按钮，AI 流式一次性产出 11 个模块，
 *         结果用折叠面板一次性铺开，不再分步切换。
 *
 * 依据：《义务教育体育与健康课程标准（2022年版）》
 *       核心素养＝运动能力 + 健康行为 + 体育品德；"教会、勤练、常赛"；"学、练、赛、评"一体化。
 *
 * 数据模型（11 个模块的形状 / 归一化 / 导出排版）在 js/unit-model.js，
 * 与「离线资源库」共用同一份，改结构请改那里。
 */

const UNIT_STORAGE_KEY = 'pe_big_unit_design_v1';
/** 单独生成课时表时每批几个课时（批越小越不容易撞上模型的输出上限，与后端的分批逻辑一致） */
const UNIT_LESSON_CHUNK = 6;

/** 旧版数据（分步生成那套）迁移到新结构，避免老师以前的内容白丢 */
function migrateLegacyUnit(saved) {
  const empty = createEmptyUnit();
  return {
    ...empty,
    unitTitle: typeof saved.theme === 'string' ? saved.theme : '',
    objectives: {
      ability: saved.objectives?.ability || '',
      health: saved.objectives?.health || '',
      character: saved.objectives?.character || '',
    },
    textbookAnalysis: saved.textbookAnalysis || '',
    studentAnalysis: saved.studentAnalysis || '',
    teachingContent: '',
    keyDifficulties: {
      learning: '',
      content: saved.keyPoints || '',
      organization: '',
      method: saved.difficulties || '',
    },
    assessment: saved.assessment || '',
    evaluation: { process: saved.evaluationSummary || '', summative: '', integration: '' },
    reflection: saved.reflection || '',
    lessons: empty.lessons.map((lesson, index) => {
      const old = Array.isArray(saved.lessons) ? saved.lessons[index] : null;
      if (!old) return lesson;
      return {
        ...lesson,
        content: old.content || '',
        method: [old.method, old.application].filter(Boolean).join('\n'),
      };
    }),
    coreQuestionLegacy: saved.coreQuestion || '',
  };
}

function loadUnitData() {
  try {
    const saved = Store.read(UNIT_STORAGE_KEY, null);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return createEmptyUnit();
    if (!saved.structure && saved.objectives) return migrateLegacyUnit(saved);   // 旧版数据
    return normalizeUnit(saved);
  } catch (error) {
    console.error('读取大单元数据失败', error);
    return createEmptyUnit();
  }
}

let unitData = createEmptyUnit();
let unitGenerating = false;
const unitExpanded = new Set(['lessons', 'structure']);

/* ---------------- 工具 ---------------- */

function unitTextarea(path, placeholder, rows = 4) {
  return `<textarea class="form-control" data-unit-path="${path}" rows="${rows}" placeholder="${escapeUnitHTML(placeholder)}">${escapeUnitHTML(unitGetPath(unitData, path))}</textarea>`;
}

/* ---------------- 页面骨架 ---------------- */

document.getElementById('page-content').innerHTML = `
  <section class="ud2-header">
    <div>
      <p class="ud2-eyebrow">UNIT DESIGN WORKSPACE</p>
      <h1>大单元设计</h1>
      <p>三步选题 → 一键生成 → 依据《义务教育体育与健康课程标准（2022年版）》输出 11 个模块 + 18 课时计划表。</p>
    </div>
  </section>

  <section class="sports-meet-card ud2-card">
    <div class="ud2-selector">
      <label class="ud2-field">
        <span class="ud2-field-label">① 教材大类 / 细项</span>
        <div class="ud2-field-row">
          <select id="ud2Category" class="form-control" aria-label="教材大类" onchange="onUnitCategoryChange()"></select>
          <select id="ud2Item" class="form-control" aria-label="教材细项" onchange="onUnitItemChange()"></select>
        </div>
        <p id="ud2CategoryNote" class="ud2-note"></p>
      </label>
      <label class="ud2-field">
        <span class="ud2-field-label">② 水平</span>
        <select id="ud2Level" class="form-control" aria-label="水平" onchange="onUnitLevelChange()"></select>
        <p id="ud2LevelNote" class="ud2-note"></p>
      </label>
      <label class="ud2-field">
        <span class="ud2-field-label">③ 教学内容</span>
        <select id="ud2Topic" class="form-control" aria-label="教学内容" onchange="onUnitTopicChange()"></select>
        <p id="ud2TopicNote" class="ud2-note"></p>
      </label>
      <div class="ud2-field ud2-actions">
        <span class="ud2-field-label">&nbsp;</span>
        <div class="ud2-field-row">
          <button id="ud2GenerateBtn" class="btn btn-primary" type="button" onclick="generateWholeUnit()">✨ 一键生成完整大单元</button>
          <button class="btn btn-secondary" type="button" onclick="openUnitResourcePicker()">📦 从离线资源库加载</button>
          <button class="btn btn-ghost" type="button" onclick="toggleAllUnitModules()">展开 / 收起全部</button>
          <button class="btn btn-ghost" type="button" onclick="clearUnitDesign()">清空重来</button>
        </div>
      </div>
    </div>
    <p class="ud2-disclaimer">
      ⚠️ 下拉框内的教学内容条目是【按课标六大类目整理的常用教材内容】，并非课标逐字原文；
      标有 <span class="ud2-pending-tag">[待确认]</span> 的条目缺少确切依据或依赖本校场馆条件，请教研组长核对后再使用。
    </p>
    <div id="ud2Status" class="ud2-status" role="status" aria-live="polite"></div>
    <div id="ud2Progress" class="ud2-progress" hidden>
      <div class="ud2-progress-bar"><i id="ud2ProgressBar" style="width:2%"></i></div>
      <p id="ud2ProgressText">正在连接 AI 服务…</p>
    </div>
  </section>

  <section id="ud2Modules" class="ud2-modules"></section>
`;

/* ---------------- 三个下拉框联动 ---------------- */

function unitSelect(id) {
  return document.getElementById(id);
}

function populateUnitSelectors() {
  const categorySelect = unitSelect('ud2Category');
  categorySelect.innerHTML = '<option value="">请选择教材大类</option>'
    + UNIT_CATALOG.map(category => `<option value="${category.id}">${escapeUnitHTML(category.label)}</option>`).join('');
  const levelSelect = unitSelect('ud2Level');
  levelSelect.innerHTML = '<option value="">请选择水平</option>'
    + UNIT_LEVELS.map(level => `<option value="${level.id}">${escapeUnitHTML(level.label)}</option>`).join('');

  // 回填上次的选择（含从已生成内容里恢复的场景）
  const meta = unitData.meta || {};
  if (meta.categoryId) {
    categorySelect.value = meta.categoryId;
    onUnitCategoryChange({ silent: true });
  }
  if (meta.itemId) {
    unitSelect('ud2Item').value = meta.itemId;
    onUnitItemChange({ silent: true });
  }
  if (meta.levelId) {
    levelSelect.value = meta.levelId;
    onUnitLevelChange({ silent: true });
  }
  if (meta.topic) {
    unitSelect('ud2Topic').value = meta.topic;
    onUnitTopicChange({ silent: true });
  }
}

function onUnitCategoryChange(options = {}) {
  const categoryId = unitSelect('ud2Category').value;
  const category = UNIT_CATALOG.find(item => item.id === categoryId);
  const itemSelect = unitSelect('ud2Item');
  itemSelect.innerHTML = '<option value="">请选择细项</option>'
    + (category ? category.items.map(item => `<option value="${item.id}">${escapeUnitHTML(item.label)}</option>`).join('') : '');
  itemSelect.disabled = !category;
  unitSelect('ud2CategoryNote').textContent = category ? category.note : '';
  onUnitItemChange(options);
}

function onUnitItemChange(options = {}) {
  refreshUnitTopics(options);
}

function onUnitLevelChange(options = {}) {
  const level = UNIT_LEVELS.find(item => item.id === unitSelect('ud2Level').value);
  unitSelect('ud2LevelNote').textContent = level ? level.stage : '';
  refreshUnitTopics(options);
}

/** 教学内容 = f(细项, 水平)：两个都选了才出条目 */
function refreshUnitTopics(options = {}) {
  const itemId = unitSelect('ud2Item').value;
  const levelId = unitSelect('ud2Level').value;
  const topicSelect = unitSelect('ud2Topic');
  const topics = itemId && levelId ? listUnitTopics(itemId, levelId) : [];
  const previous = options.silent ? (unitData.meta.topic || '') : topicSelect.value;
  topicSelect.innerHTML = topics.length
    ? topics.map(topic => `<option value="${escapeUnitHTML(topic)}">${escapeUnitHTML(topic)}</option>`).join('')
    : '<option value="">请先选择「教材细项」与「水平」</option>';
  topicSelect.disabled = !topics.length;
  if (topics.length) {
    topicSelect.value = topics.includes(previous) ? previous : topics[0];
  }
  onUnitTopicChange({ silent: true });
}

function onUnitTopicChange(options = {}) {
  const topic = unitSelect('ud2Topic').value;
  const noteNode = unitSelect('ud2TopicNote');
  if (isUnitTopicPending(topic)) {
    noteNode.innerHTML = '<span class="ud2-pending-tag">[待确认]</span> 该条目缺少确切依据或依赖本校条件，生成结果请结合实际核对。';
  } else {
    noteNode.textContent = topic ? `将围绕「${topic}」生成 18 课时大单元。` : '';
  }
  if (!options.silent) persistUnitSelection();
}

function currentUnitSelection() {
  const categoryId = unitSelect('ud2Category').value;
  const itemId = unitSelect('ud2Item').value;
  const levelId = unitSelect('ud2Level').value;
  const topic = unitSelect('ud2Topic').value;
  const category = UNIT_CATALOG.find(item => item.id === categoryId);
  const item = category?.items.find(entry => entry.id === itemId);
  const level = UNIT_LEVELS.find(entry => entry.id === levelId);
  return {
    categoryId, itemId, levelId, topic,
    categoryLabel: category?.label || '', itemLabel: item?.label || '', levelLabel: level?.label || '',
    valid: Boolean(category && item && level && topic),
  };
}

function persistUnitSelection() {
  const selection = currentUnitSelection();
  unitData.meta = {
    ...unitData.meta,
    categoryId: selection.categoryId, category: selection.categoryLabel,
    itemId: selection.itemId, item: selection.itemLabel,
    levelId: selection.levelId, level: selection.levelLabel,
    topic: selection.topic, topicPending: isUnitTopicPending(selection.topic),
  };
  saveUnitData({ silent: true });
}

/* ---------------- 11 个模块的渲染 ---------------- */

function renderUnitModules() {
  const container = document.getElementById('ud2Modules');
  if (!container) return;
  const hasAnything = unitData.meta.generatedAt
    || unitModuleCompleted(unitData, 'lessons') || unitModuleCompleted(unitData, 'objectives');
  if (!hasAnything) {
    container.innerHTML = `
      <div class="ud2-empty">
        <h2>还没有大单元内容</h2>
        <p>在上面选好「教材大类 / 细项」「水平」「教学内容」，然后点 <strong>✨ 一键生成完整大单元</strong>。</p>
        <p>AI 会一次性写出全部 11 个模块与 18 课时计划表，生成过程中这里是流式进度。</p>
      </div>`;
    return;
  }
  const boundResource = unitResourceRecord();
  container.innerHTML = `<div class="ud2-modules-head">
      <div class="ud2-modules-title">
        <h2>${escapeUnitHTML(unitData.unitTitle || `${unitData.meta.itemLabel || ''} ${unitData.meta.topic || ''}`.trim() || '大单元设计')}</h2>
        <p>${escapeUnitHTML([unitData.meta.categoryLabel, unitData.meta.itemLabel, unitData.meta.levelLabel, unitData.meta.topic]
          .filter(Boolean).join(' · ')) || '未记录选题'}
          ${boundResource
            ? `　<span class="ud2-bound-tag">📦 已绑定离线资源${boundResource.created_at
              ? `（${new Date(boundResource.created_at).toLocaleString('zh-CN')} 保存）` : ''}</span>`
            : ''}</p>
      </div>
      <div class="ud2-modules-actions">
        <button class="btn btn-primary" type="button" onclick="saveUnitToResources()">${boundResource ? '更新到离线资源库' : '保存到离线资源库'}</button>
        <button class="btn btn-secondary" type="button" onclick="exportUnitWord()">导出 Word</button>
        <button class="btn btn-secondary" type="button" onclick="printUnitPlan()">打印 / 导出 PDF</button>
        <a class="btn btn-ghost" href="offline-resources.html">资源库管理</a>
      </div>
    </div>` + UNIT_MODULES.map((module, index) => {
    const expanded = unitExpanded.has(module.id);
    const done = unitModuleCompleted(unitData, module.id);
    return `
      <section class="ud2-module${expanded ? ' is-open' : ''}" data-module="${module.id}">
        <button class="ud2-module-head" type="button" aria-expanded="${expanded}" onclick="toggleUnitModule('${module.id}')">
          <span class="ud2-module-no">模块 ${index + 1}</span>
          <span class="ud2-module-title">${escapeUnitHTML(module.title)}</span>
          <span class="ud2-module-hint">${escapeUnitHTML(module.hint)}</span>
          <span class="ud2-module-state ${done ? 'is-done' : 'is-todo'}">${done ? '已完成' : '待生成'}</span>
          <span class="ud2-module-caret" aria-hidden="true">▾</span>
        </button>
        <div class="ud2-module-body"${expanded ? '' : ' hidden'}>${renderUnitModuleBody(module.id)}</div>
      </section>`;
  }).join('');
}

function renderUnitModuleBody(id) {
  switch (id) {
    case 'objectives': return `
      <div class="ud2-grid">
        ${unitField('运动能力', 'objectives.ability', '例如：能说出并做出……在对抗条件下……')}
        ${unitField('健康行为', 'objectives.health', '例如：能坚持每周……懂得运动前后的……')}
        ${unitField('体育品德', 'objectives.character', '例如：在比赛中遵守规则、接纳同伴、正视胜负')}
      </div>`;
    case 'textbookAnalysis': return unitField('教材分析', 'textbookAnalysis',
      '本单元主要内容、承载的核心素养、锻炼价值与育人价值。', 6);
    case 'studentAnalysis': return unitField('学情分析', 'studentAnalysis',
      '结合所选水平学生的认知特点、身体发育特点、已有经验与个体差异。', 6);
    case 'teachingContent': return unitField('主要教学内容', 'teachingContent',
      '1. 知识：……\n2. 技术：……\n3. 战术：……\n4. 体能：……\n5. 比赛活动：……', 8);
    case 'keyDifficulties': return `
      <div class="ud2-grid">
        ${unitField('学生学习的重难点', 'keyDifficulties.learning', '学生理解、掌握与应用上的主要障碍')}
        ${unitField('学习内容的重难点', 'keyDifficulties.content', '本项目技术/战术本身的关键与难点')}
        ${unitField('教学组织的重难点', 'keyDifficulties.organization', '分组、轮换、场地器材与安全组织上的难点')}
        ${unitField('教学方法的重难点', 'keyDifficulties.method', '示范讲解、练习阶梯、纠错与评价方法上的难点')}
      </div>`;
    case 'structure': return renderUnitStructure();
    case 'lessons': return renderUnitLessons();
    case 'assessment': return unitField('考核与作业', 'assessment',
      '依据课标学业质量要求：考核内容、评分标准，以及课内外作业安排。', 8);
    case 'evaluation': return `
      <div class="ud2-grid">
        ${unitField('过程性评价', 'evaluation.process', '课堂观察点、评价工具、自评互评安排')}
        ${unitField('终结性评价', 'evaluation.summative', '单元末的技能达标、比赛表现与知识测验')}
        ${unitField('「学、练、赛、评」一体化', 'evaluation.integration', '四环节如何贯通，评价如何嵌入学练与比赛')}
      </div>`;
    case 'reflection': return unitField('教学反思（课后填写模板）', 'reflection',
      '目标达成情况：……\n学生典型表现：……\n教学组织与方法的得失：……\n改进设想：……', 8);
    case 'resources': return unitField('教学资源', 'resources',
      '图文资料 / 视频资源 / 器材清单（含数量与安全检查要点）。', 6);
    default: return '<p class="ud2-note">该模块暂未支持。</p>';
  }
}

function unitField(label, path, placeholder, rows = 4) {
  return `<label class="ud2-form-field"><span>${label}</span>${unitTextarea(path, placeholder, rows)}</label>`;
}

function toggleUnitModule(id) {
  const section = document.querySelector(`.ud2-module[data-module="${id}"]`);
  if (!section) return;
  const expanded = unitExpanded.has(id);
  if (expanded) unitExpanded.delete(id); else unitExpanded.add(id);
  section.classList.toggle('is-open', !expanded);
  const body = section.querySelector('.ud2-module-body');
  if (body) body.hidden = expanded;
  section.querySelector('.ud2-module-head').setAttribute('aria-expanded', String(!expanded));
}

function toggleAllUnitModules() {
  const shouldExpand = unitExpanded.size < UNIT_MODULES.length;
  unitExpanded.clear();
  if (shouldExpand) UNIT_MODULES.forEach(module => unitExpanded.add(module.id));
  renderUnitModules();
}

/* ---------------- 模块 6：结构图 ---------------- */

function renderUnitStructure() {
  const missing = missingStructureNumbers(unitData);
  const total = structureNodeCount(unitData);
  return `
    <div class="ud2-structure">
      <div class="ud2-structure-head">
        <span>共挂载 ${total} / ${UNIT_LESSON_COUNT} 个课时</span>
        ${missing.length
          ? `<span class="ud2-warn-tag">缺第 ${missing.join('、')} 课次</span>
             <button class="btn btn-ghost" type="button" onclick="autoFixStructure()">按课时表补全</button>`
          : '<span class="ud2-ok-tag">✓ 18 个课时全部挂载</span>'}
      </div>
      <div class="ud2-tree">
        <div class="ud2-tree-root">${escapeUnitHTML(unitData.unitTitle || '大单元')}</div>
        <div class="ud2-tree-branches">
          ${UNIT_STRUCTURE_BRANCHES.map(branch => `
            <div class="ud2-tree-branch">
              <div class="ud2-tree-branch-title">${escapeUnitHTML(branch.label)}</div>
              <div class="ud2-tree-nodes">
                ${unitData.structure[branch.id].length
                  ? unitData.structure[branch.id].map((node, index) => `
                    <div class="ud2-tree-node">
                      <span class="ud2-tree-node-no">${node.no}</span>
                      <input class="form-control" data-unit-path="structure.${branch.id}.${index}.title"
                        value="${escapeUnitHTML(node.title)}" aria-label="第 ${node.no} 课次名称">
                    </div>`).join('')
                  : '<p class="ud2-note">暂无课时挂载</p>'}
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

/** 课时表已生成但结构图不完整时，按序号把缺的课时补进四个分支（补齐规则在 unit-model.js） */
function autoFixStructure() {
  const missing = missingStructureNumbers(unitData);
  if (!missing.length) return;
  unitData = autoFillStructure(unitData);
  saveUnitData();
  renderUnitModules();
  showUnitStatus(`已按课时表补全 ${missing.length} 个缺失节点，请按教学实际调整归属分支。`, 'warning');
}

/* ---------------- 模块 7：18 课时计划表 ---------------- */

function renderUnitLessons() {
  const missing = unitMissingLessonNumbers();
  return `
    <div class="ud2-lesson-toolbar">
      <span class="${missing.length ? 'ud2-warn-tag' : 'ud2-ok-tag'}">
        ${missing.length ? `第 ${missing.join('、')} 课时还没内容` : '✓ 18 个课时都已填写'}
      </span>
      <span class="ud2-toolbar-hint">课时多、容易被 AI 输出上限截断；缺课时时按批次单独生成即可。</span>
      <button class="btn btn-secondary" type="button" onclick="generateLessonTableOnly()">单独生成课时表</button>
    </div>
    <div class="ud2-table-wrap">
      <table class="data-table ud2-lesson-table">
        <thead><tr>
          <th style="width:64px">课时</th>
          <th style="width:26%">学习目标（三维）</th>
          <th style="width:32%">教学内容</th>
          <th>组织教学与方法</th>
          <th style="width:110px">操作</th>
        </tr></thead>
        <tbody>
          ${unitData.lessons.map((lesson, index) => `
            <tr>
              <th scope="row">第 ${index + 1} 课</th>
              <td>
                <label class="ud2-mini-field"><span>运动能力</span>
                  <textarea class="form-control" rows="2" data-unit-path="lessons.${index}.objectives.ability"
                    aria-label="第 ${index + 1} 课运动能力目标">${escapeUnitHTML(lesson.objectives.ability)}</textarea></label>
                <label class="ud2-mini-field"><span>健康行为</span>
                  <textarea class="form-control" rows="2" data-unit-path="lessons.${index}.objectives.health"
                    aria-label="第 ${index + 1} 课健康行为目标">${escapeUnitHTML(lesson.objectives.health)}</textarea></label>
                <label class="ud2-mini-field"><span>体育品德</span>
                  <textarea class="form-control" rows="2" data-unit-path="lessons.${index}.objectives.character"
                    aria-label="第 ${index + 1} 课体育品德目标">${escapeUnitHTML(lesson.objectives.character)}</textarea></label>
              </td>
              <td><textarea class="form-control" rows="6" data-unit-path="lessons.${index}.content"
                aria-label="第 ${index + 1} 课教学内容">${escapeUnitHTML(lesson.content)}</textarea></td>
              <td><textarea class="form-control" rows="6" data-unit-path="lessons.${index}.method"
                aria-label="第 ${index + 1} 课组织教学与方法">${escapeUnitHTML(lesson.method)}</textarea></td>
              <td><button class="btn btn-secondary ud2-detail-btn" type="button"
                onclick="showUnitLessonDetail(${index + 1})">查看详细教案</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/** 课时详情：占位弹窗（后续接入流式生成详细教案） */
function showUnitLessonDetail(no) {
  const lesson = unitData.lessons[no - 1];
  if (!lesson) return;
  const summary = `
    <dl class="ud2-summary">
      <dt>课时</dt><dd>第 ${no} 课 / 共 ${UNIT_LESSON_COUNT} 课</dd>
      <dt>教学内容</dt><dd>${escapeUnitHTML(lesson.content) || '（未生成）'}</dd>
      <dt>三维目标</dt><dd>
        运动能力：${escapeUnitHTML(lesson.objectives.ability) || '—'}<br>
        健康行为：${escapeUnitHTML(lesson.objectives.health) || '—'}<br>
        体育品德：${escapeUnitHTML(lesson.objectives.character) || '—'}</dd>
      <dt>组织教学与方法</dt><dd>${escapeUnitHTML(lesson.method) || '（未生成）'}</dd>
    </dl>`;
  showModal(`第 ${no} 课次 · 详细教案`, `
    <div class="ud2-placeholder">
      <div class="ud2-placeholder-icon">🚧</div>
      <h3>详细教案生成功能即将上线</h3>
      <p>上线后将按本课次的三维目标、教学内容与组织教法，流式生成完整课时教案：
        准备部分 / 基本部分 / 结束部分的时间分配、教师口令、分组轮换、场地器材、预计练习密度与心率、易犯错误与纠正、安全提示。</p>
      ${summary}
    </div>`, '<button class="btn btn-secondary" type="button" onclick="closeModal(this)">关闭</button>');
}

/* ---------------- 保存 / 状态 ---------------- */

function saveUnitData({ silent = false } = {}) {
  try {
    Store.write(UNIT_STORAGE_KEY, unitData);
    if (!silent && !unitGenerating) showUnitStatus('✓ 已自动保存', 'success');
  } catch (error) {
    console.error('保存大单元数据失败', error);
    showUnitStatus(`保存失败：${error.message}`, 'error');
  }
}

function showUnitStatus(message, type = 'info') {
  const node = document.getElementById('ud2Status');
  if (!node) return;
  node.textContent = message;
  node.className = `ud2-status is-${type}`;
}

/* ---------------- 一键生成（流式） ---------------- */

function setUnitGeneratingState(active) {
  unitGenerating = active;
  const button = document.getElementById('ud2GenerateBtn');
  if (button) {
    button.disabled = active;
    button.textContent = active ? '正在分步生成…' : '✨ 一键生成完整大单元';
  }
  const progress = document.getElementById('ud2Progress');
  if (progress) progress.hidden = !active;
}

/** 阶段的显示名（进度条文案用） */
const UNIT_STAGE_LABELS = {
  analysis: '第 1/2 步 · 模块 1–6（分析与结构图）',
  tail: '第 2/2 步 · 模块 7–11（课时表与评价）',
  lessons: '课时表分批生成',
  closing: '收尾 · 模块 8–11',
};

function updateUnitProgress(charCount, phaseLabel, hint = '请稍候，不要刷新页面') {
  const bar = document.getElementById('ud2ProgressBar');
  const text = document.getElementById('ud2ProgressText');
  // 没有总长度，用"已接收字数"做无限趋近动画：每 400 字前进一点，最多 96%
  const percent = Math.min(96, Math.round((charCount / 400) * 8) + 2);
  if (bar) bar.style.width = `${percent}%`;
  if (text) text.textContent = `${phaseLabel}：已接收 ${charCount.toLocaleString('zh-CN')} 字…（${hint}）`;
}

/**
 * 每个阶段负责哪些字段（少严格的 phasesMap）。
 * 拆字段的目的：一次请求只让 AI 写一半内容，避免撞上它的单次输出上限。
 */
const UNIT_PHASE_FIELDS = {
  analysis: ['unitTitle', 'objectives', 'textbookAnalysis', 'studentAnalysis', 'teachingContent', 'keyDifficulties', 'structure'],
  tail: ['lessons', 'assessment', 'evaluation', 'reflection', 'resources'],
  lessons: ['lessons'],
  closing: ['assessment', 'evaluation', 'reflection', 'resources'],
};

/** 收尾四模块（8–11）里还没有内容的那些 */
function unitTailMissing() {
  return ['assessment', 'evaluation', 'reflection', 'resources']
    .filter(id => !unitModuleCompleted(unitData, id));
}

/** 课时表里还没有内容的课次号 */
function unitMissingLessonNumbers() {
  return unitData.lessons
    .filter(lesson => !unitHasContent(
      lesson.content, lesson.method,
      lesson.objectives.ability, lesson.objectives.health, lesson.objectives.character,
    ))
    .map(lesson => lesson.no);
}

/** 把 [8,9,10,12] 压成连续区间 [[8,10],[12,12]]，分批请求时不会把已写好的课时重生成一遍 */
function unitMissingRanges(numbers) {
  return numbers.reduce((runs, no) => {
    const current = runs[runs.length - 1];
    if (current && no === current[current.length - 1] + 1) current.push(no);
    else runs.push([no]);
    return runs;
  }, []).flatMap(run => {
    const chunks = [];
    for (let index = 0; index < run.length; index += UNIT_LESSON_CHUNK) {
      chunks.push(run.slice(index, index + UNIT_LESSON_CHUNK));
    }
    return chunks;
  });
}

/** 给下一阶段的 Prompt 当上下文用（只带必要信息，避免把输出预算吃在输入上） */
function unitStageContext() {
  const lessonTitles = UNIT_STRUCTURE_BRANCHES
    .flatMap(branch => (unitData.structure[branch.id] || []).map(node => ({ no: node.no, title: node.title })))
    .sort((a, b) => a.no - b.no);
  return {
    unitTitle: unitData.unitTitle,
    objectives: unitData.objectives,
    teachingContent: unitData.teachingContent,
    keyDifficulties: unitData.keyDifficulties,
    lessonTitles,
  };
}

function unitSelectionMeta(selection) {
  return selection ? {
    categoryId: selection.categoryId, category: selection.categoryLabel,
    itemId: selection.itemId, item: selection.itemLabel,
    levelId: selection.levelId, level: selection.levelLabel,
    topic: selection.topic, topicPending: isUnitTopicPending(selection.topic),
  } : {};
}

/**
 * 把某一阶段 AI 返回的内容合并进当前大单元。
 * 要点：① 没返回的字段保持原样；② lessons 按 no 落位（分批返回时不能按下标错位）；
 *      ③ 对象字段做浅合并（AI 只返回一半 objectives 时不会把另一半冲掉）。
 */
function mergeUnitStage(parsed, selection, stage) {
  const next = normalizeUnit(unitData);
  (UNIT_PHASE_FIELDS[stage] || []).forEach(field => {
    const value = parsed?.[field];
    if (value === undefined || value === null) return;
    if (field === 'lessons') {
      if (!Array.isArray(value)) return;
      value.forEach(item => {
        const no = Number.isInteger(item?.no) ? item.no : 0;
        const target = no >= 1 && no <= UNIT_LESSON_COUNT ? next.lessons[no - 1] : null;
        if (!target) return;
        if (item.objectives && typeof item.objectives === 'object') {
          target.objectives = { ...target.objectives, ...item.objectives };
        }
        if (typeof item.content === 'string' && item.content) target.content = item.content;
        if (typeof item.method === 'string' && item.method) target.method = item.method;
      });
      return;
    }
    const current = next[field];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current)) {
      next[field] = { ...current, ...value };
      return;
    }
    next[field] = value;
  });
  unitData = normalizeUnit({
    ...next,
    meta: { ...next.meta, ...unitSelectionMeta(selection), generatedAt: new Date().toISOString() },
  });
  unitExpanded.add('lessons');
  unitExpanded.add('structure');
}

/** 请求某一个阶段，并读取它的流式结果 */
async function requestUnitStage(stage, selection, context = null, extra = {}) {
  let response;
  try {
    response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'unit',
        stage,
        category: selection.categoryLabel,
        item: selection.itemLabel,
        level: selection.levelLabel,
        topic: selection.topic,
        topicPending: isUnitTopicPending(selection.topic),
        ...(context ? { context } : {}),
        ...extra,
      }),
    });
  } catch {
    throw new Error('无法连接本地 AI 服务，请确认已运行 node server.js。');
  }
  if (!response.ok) {
    let result = null;
    try { result = await response.json(); } catch { /* 非 JSON 错误体 */ }
    throw new Error(result?.error || `AI 服务请求失败（HTTP ${response.status}）`);
  }
  return readUnitJsonStream(response, charCount => updateUnitProgress(charCount, UNIT_STAGE_LABELS[stage] || '生成中'));
}

function closeUnitModals() {
  document.querySelectorAll('.modal-overlay').forEach(node => node.remove());
}

/**
 * 一键生成 —— 分步拼接：
 *   阶段① 模块 1–6（分析 + 重难点 + 结构图）→ 立即渲染给老师看
 *   阶段② 带上阶段① 的精简上下文，只写模块 7–11（18 课时极度精简 + 收尾四模块）
 *   若阶段② 仍被截断（说明课时表本身就超标），弹窗引导点【单独生成课时表】分批补齐
 */
async function generateWholeUnit() {
  if (unitGenerating) return;
  const selection = currentUnitSelection();
  if (!selection.valid) {
    showUnitStatus('请先把「教材大类 / 细项」「水平」「教学内容」三项都选好。', 'error');
    showToast('请完成三个下拉框的选择', 'error');
    return;
  }
  persistUnitSelection();
  setUnitGeneratingState(true);

  try {
    /* ---- 阶段 ①：模块 1–6 ---- */
    updateUnitProgress(0, UNIT_STAGE_LABELS.analysis, '只写前半部分，不会被截断');
    showUnitStatus('第 1/2 步：正在生成模块 1–6（教学目标、教材分析、学情分析、主要教学内容、教学重难点、结构图）…', 'info');
    const stage1 = await requestUnitStage('analysis', selection);
    const parsed1 = stage1.data || recoverPartialUnitJSON(stage1.content);
    if (!parsed1 || typeof parsed1 !== 'object') {
      throw new Error(stage1.truncated
        ? 'AI 输出被截断且无法恢复成完整 JSON，请重试（可改用内容更短的教学内容）。'
        : 'AI 返回内容不是有效 JSON，请重试。');
    }
    mergeUnitStage(parsed1, selection, 'analysis');
    saveUnitData({ silent: true });
    renderUnitModules();                       // 先显示第一阶段内容（老师可以先看着改）

    /* ---- 阶段 ②：模块 7–11 ---- */
    updateUnitProgress(0, UNIT_STAGE_LABELS.tail, '18 课时已强制精简');
    showUnitStatus('✓ 第 1/2 步完成。第 2/2 步：正在生成模块 7–11（18 课时计划表、考核与作业、学习评价、教学反思、教学资源）…', 'info');
    const stage2 = await requestUnitStage('tail', selection, unitStageContext());
    mergeUnitStage(stage2.data || recoverPartialUnitJSON(stage2.content) || {}, selection, 'tail');

    // 结构图节点没写全时，按课时表标题兜底补齐（不动老师的 canvas，只给默认归属）
    const missingStructure = missingStructureNumbers(unitData);
    if (missingStructure.length) unitData = autoFillStructure(unitData);

    saveUnitData({ silent: true });
    renderUnitModules();

    const missingLessons = unitMissingLessonNumbers();
    const missingTail = unitTailMissing();
    if (missingLessons.length) {
      const received = stage2.content ? stage2.content.length : 0;
      showUnitStatus(
        `第 2 阶段在第 ${missingLessons[0]} 课时附近被截断${received ? `（已抢救 ${received} 字）` : ''}：`
        + `还缺第 ${missingLessons.join('、')} 课时${missingTail.length ? `，以及模块 ${missingTailLabel(missingTail)}` : ''}。`
        + '请点【单独生成课时表】分批补齐 —— 已生成的内容都在，不会被覆盖。',
        'warning',
      );
      showUnitTruncatedDialog(missingLessons, missingTail);
      showToast('课时表未生成完整，需分批补齐', 'error');
    } else if (missingTail.length) {
      showUnitStatus(`✓ 18 课时齐全，但模块 ${missingTailLabel(missingTail)} 还缺内容，可在相应面板手工补写。`, 'warning');
      showToast('生成完成，但有部分内容需要人工检查', 'error');
    } else {
      showUnitStatus('✓ 两阶段拼接完成：11 个模块 + 18 课时已全部生成并保存，请按教学实际复核。', 'success');
      showToast('大单元设计已生成', 'success');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showUnitStatus(`生成失败：${message}`, 'error');
    showToast('生成失败，请查看上方提示', 'error');
  } finally {
    setUnitGeneratingState(false);
  }
}

function missingTailLabel(missingTail) {
  const titles = { assessment: '8 考核与作业', evaluation: '9 学习评价', reflection: '10 教学反思', resources: '11 教学资源' };
  return missingTail.map(id => titles[id] || id).join('、');
}

/** 阶段② 被截断时的引导弹窗：给出【单独生成课时表】出口 */
function showUnitTruncatedDialog(missingLessons, missingTail) {
  const batches = unitMissingRanges(missingLessons);
  const missingLabel = missingTail.length ? `，以及模块 ${missingTailLabel(missingTail)}` : '';
  const body = `
    <div class="ud2-placeholder">
      <div class="ud2-placeholder-icon">✂️</div>
      <h3>18课时表过长导致截断</h3>
      <p>模型的<b>单次输出有上限</b>：一次写完 18 个课时会被截断，这是模型侧限制，不是网络问题。</p>
      <p>当前还缺 <b>${missingLessons.length}</b> 个课时${missingLabel}；已经生成的内容<b>都还在</b>，不会被覆盖。</p>
      <hr style="margin:14px 0;border:none;border-top:1px solid var(--border, #e2e8f0)">
      <p>请点击【单独生成课时表】：系统会按 <b>${batches.length} 小批</b>${batches.length
        ? `（${batches.map(batch => batch.length === 1 ? `第${batch[0]}课` : `第${batch[0]}–${batch[batch.length - 1]}课`).join('、')}）` : ''}
         重新请求，每批改少量就不会被截断${missingTail.length ? '，顺带补齐收尾模块' : ''}。</p>
    </div>`;
  showModal('需要分批生成课时表', body, `
    <button class="btn btn-primary" type="button" onclick="generateLessonTableOnly()">单独生成课时表</button>
    <button class="btn btn-ghost" type="button" onclick="closeModal()">稍后自己补</button>`);
}

/**
 * 【单独生成课时表】：只对"还缺内容的课时"按批次请求，最后顺带补齐收尾模块 8–11。
 * 老师也可以在任何时候手工点这个按钮补漏（模块 7 面板顶部就有一枚）。
 */
async function generateLessonTableOnly() {
  if (unitGenerating) {
    showToast('正在生成中，请稍候', 'error');
    return;
  }
  const selection = currentUnitSelection();
  if (!selection.valid) {
    showUnitStatus('请先把「教材大类 / 细项」「水平」「教学内容」三项都选好。', 'error');
    showToast('请完成三个下拉框的选择', 'error');
    return;
  }
  const batches = unitMissingRanges(unitMissingLessonNumbers());
  const tailMissing = unitTailMissing();
  if (!batches.length && !tailMissing.length) {
    showToast('18 课时内容已齐全，无需补生成', 'success');
    return;
  }
  closeUnitModals();
  persistUnitSelection();
  setUnitGeneratingState(true);

  try {
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const from = batch[0];
      const to = batch[batch.length - 1];
      updateUnitProgress(0, `课时表第 ${index + 1}/${batches.length} 批（第 ${from}–${to} 课次）`, '每批 6 个课时，不会截断');
      showUnitStatus(`正在生成第 ${from}–${to} 课次（第 ${index + 1}/${batches.length} 批）…`, 'info');
      const result = await requestUnitStage('lessons', selection, unitStageContext(), { from, to });
      mergeUnitStage(result.data || recoverPartialUnitJSON(result.content) || {}, selection, 'lessons');
      saveUnitData({ silent: true });
      renderUnitModules();
    }
    if (unitTailMissing().length) {
      updateUnitProgress(0, UNIT_STAGE_LABELS.closing, '四个收尾模块');
      showUnitStatus('课时表已补齐，正在生成模块 8–11（考核与作业、学习评价、教学反思、教学资源）…', 'info');
      const closing = await requestUnitStage('closing', selection, unitStageContext());
      mergeUnitStage(closing.data || recoverPartialUnitJSON(closing.content) || {}, selection, 'closing');
    }
    if (missingStructureNumbers(unitData).length) unitData = autoFillStructure(unitData);
    saveUnitData({ silent: true });
    renderUnitModules();

    const remain = unitMissingLessonNumbers();
    if (remain.length) {
      showUnitStatus(`仍然缺第 ${remain.join('、')} 课时（每批都很小了仍被截断），建议在模块 7 手工补写这几个课时。`, 'warning');
      showToast('仍有课时未生成完整', 'error');
    } else {
      showUnitStatus('✓ 课时表已分批补齐并保存，请按教学实际微调每节课的内容与组织教法。', 'success');
      showToast('课时表已补齐', 'success');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showUnitStatus(`补生成失败：${message}`, 'error');
    showToast('补生成失败，请查看上方提示', 'error');
  } finally {
    setUnitGeneratingState(false);
  }
}

/** 读取 SSE 流，累计 content，并回调已接收字数 */
async function readUnitJsonStream(response, onDelta) {
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
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (eventName === 'truncated') {
      truncated = true;
      warning = payload.warning || 'AI 输出被截断。';
      return;
    }
    if (payload.error) {
      truncated = content.trim().length > 0;
      warning = payload.error?.message || String(payload.error);
      return;
    }
    const delta = payload.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') {
      content += delta;
      if (typeof onDelta === 'function') onDelta(content.length);
    } else if (Array.isArray(delta)) {
      content += delta.map(part => (typeof part?.text === 'string' ? part.text : '')).join('');
      if (typeof onDelta === 'function') onDelta(content.length);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      frames.forEach(consumeFrame);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeFrame(buffer);
  } catch (error) {
    truncated = content.trim().length > 0;
    warning = error instanceof Error ? error.message : 'AI 连接中断。';
    await reader.cancel().catch(() => {});
    if (!truncated) throw error;
  }

  if (!content.trim()) {
    if (truncated) return { data: null, content, truncated, warning };
    throw new Error('AI 没有返回生成内容，请稍后重试。');
  }
  try {
    return { data: JSON.parse(content), content, truncated, warning };
  } catch {
    return { data: null, content, truncated: true, warning: warning || '内容解析失败或已被截断。' };
  }
}

/** JSON 被截断时尽力抢救：补齐未闭合的括号 / 引号 */
function recoverPartialUnitJSON(content) {
  const source = String(content || '').trim();
  if (!source) return null;
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') stack.pop();
  }
  let candidate = source.replace(/[,，]\s*$/, '');
  if (inString) {
    if (escaped) candidate = candidate.slice(0, -1);
    candidate += '"';
  }
  while (stack.length) candidate += stack.pop() === '{' ? '}' : ']';
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** 把一份「完整 11 模块」的 AI 结果一次性合并进来（分步生成以外的场景，如测试数据） */
function applyGeneratedUnit(generated, selection) {
  mergeUnitStage(generated, selection, 'analysis');
  mergeUnitStage(generated, selection, 'tail');
}

function clearUnitDesign() {
  if (!window.confirm('确定要清空当前大单元内容吗？此操作会清掉已生成的 11 个模块与 18 课时。')) return;
  const selection = unitData.meta;
  unitData = createEmptyUnit();
  // 清空 = 与本页脱钩：不再写回之前绑定的离线资源（那条资源本身还留在库里，不会被删）
  unitData.meta = { ...selection, generatedAt: '', resourceId: '' };
  unitExpanded.clear();
  saveUnitData({ silent: true });
  renderUnitModules();
  showUnitStatus('已清空，可重新选择题目后生成。', 'info');
}

/* ---------------- 离线资源库联动 ---------------- */

/** 当前大单元绑定的那条离线资源（没绑定返回 null） */
function unitResourceRecord() {
  if (typeof OfflineResources === 'undefined') return null;
  const id = unitData.meta?.resourceId;
  return id ? OfflineResources.get(id) : null;
}

/** 当前大单元是否已经有内容可存 */
function unitHasAnything() {
  return UNIT_MODULES.some(module => unitModuleCompleted(unitData, module.id));
}

/** 【保存到离线资源库】：立即可用在工作副本 + 离线资源库，联网后自动同步 Supabase */
function saveUnitToResources() {
  if (typeof OfflineResources === 'undefined') {
    showUnitStatus('离线资源库模块未加载，请刷新页面重试。', 'error');
    return;
  }
  if (!unitHasAnything()) {
    showUnitStatus('当前没有可保存的内容，请先一键生成或从离线资源库加载一个大单元。', 'error');
    showToast('没有可保存的内容', 'error');
    return;
  }
  const source = unitData.meta.generatedAt ? 'ai' : 'manual';
  const result = OfflineResources.saveUnit(unitData, { source });
  if (!result.ok) {
    showUnitStatus(`保存失败：${result.reason || '未知原因'}`, 'error');
    return;
  }
  unitData.meta.resourceId = result.record.id;
  unitData.meta.source = result.record.source;
  saveUnitData({ silent: true });
  renderUnitModules();
  showUnitStatus(
    `✓ 已${result.created ? '新建' : '更新'}离线资源：${result.record.content || result.record.id}`
    + '。数据已存在本机，断网也能查看；联网后会自动同步到 Supabase。',
    'success',
  );
}

/** 【从离线资源库加载】：弹窗选一条，直接填充到结果区，不调用 AI */
function openUnitResourcePicker() {
  if (typeof OfflineResources === 'undefined') {
    showUnitStatus('离线资源库模块未加载，请刷新页面重试。', 'error');
    return;
  }
  OfflineResources.openPicker(record => {
    if (unitGenerating) {
      showToast('AI 正在生成，请等生成结束后再加载资源', 'error');
      return;
    }
    loadUnitFromResource(record);
  });
}

function loadUnitFromResource(record) {
  const unit = OfflineResources.unitFromRecord(record);
  if (!unit) {
    showUnitStatus('这条离线资源的数据已损坏，无法载入。', 'error');
    return;
  }
  unitData = unit;
  unitExpanded.clear();
  unitExpanded.add('structure');
  unitExpanded.add('lessons');
  saveUnitData({ silent: true });
  populateUnitSelectors();          // 把选题回填到三个下拉框
  renderUnitModules();
  showUnitStatus(
    `✓ 已从离线资源库载入「${unit.unitTitle || record.content || record.id}」（未调用 AI）。`
    + '继续编辑会自动更新到这条资源；想另存一份请先点【保存到离线资源库】。',
    'success',
  );
  showToast('已从离线资源库载入', 'success');
}

/** 地址栏带 ?resource=<id> 时（资源库点【编辑】）直接载入这条资源 */
function loadUnitFromUrl() {
  if (typeof OfflineResources === 'undefined') return false;
  const id = new URLSearchParams(window.location.search).get('resource');
  if (!id) return false;
  const record = OfflineResources.get(id);
  if (!record) {
    showUnitStatus('指定的离线资源不存在（可能已被删除）。可从下方的【从离线资源库加载】重新选择。', 'error');
    return false;
  }
  loadUnitFromResource(record);
  return true;
}

/* ---------------- 导出 / 打印（排版统一由 unit-model.js 提供） ---------------- */

function unitExportHTML() {
  return buildUnitExportHTML(unitData);
}

function printUnitPlan() {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showUnitStatus('浏览器阻止了打印窗口，请允许此页面打开弹出窗口后重试。', 'error');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(unitExportHTML());
  printWindow.document.close();
  printWindow.addEventListener('load', () => printWindow.print(), { once: true });
}

function exportUnitWord() {
  const blob = new Blob(['\ufeff', unitExportHTML()], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(unitData.unitTitle || unitData.meta.topic || '大单元设计').replace(/[\\/:*?"<>|]/g, '_')}.doc`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- 事件绑定 ---------------- */

/** 编辑时把改动同步进已绑定的离线资源（防抖，避免每敲一个字都写一次云端的整份列表） */
let unitResourceSyncTimer = null;
function queueResourceSync() {
  if (typeof OfflineResources === 'undefined') return;
  if (!unitData.meta?.resourceId) return;
  if (unitResourceSyncTimer) clearTimeout(unitResourceSyncTimer);
  unitResourceSyncTimer = setTimeout(() => {
    unitResourceSyncTimer = null;
    OfflineResources.syncUnit(unitData);
  }, 800);
}

document.addEventListener('input', event => {
  const path = event.target.dataset?.unitPath;
  if (!path) return;
  unitSetPath(unitData, path, event.target.value);
  saveUnitData({ silent: true });
  queueResourceSync();
});

Store.onReady(() => {
  unitData = loadUnitData();
  populateUnitSelectors();
  // 幂等性：资源库页点【编辑】会带上 ?resource=xx，这里直接把那份资源载进来
  if (!loadUnitFromUrl()) renderUnitModules();
});
