'use strict';

Layout.init('unit-design', '大单元设计', '大单元设计');

/**
 * 大单元设计（重构版）
 *
 * 交互：三个下拉框（教材大类/细项 → 水平 → 教学内容，后者按前两项联动过滤）
 *       + 一个「一键生成完整大单元」按钮，AI 流式一次性产出 10 个模块，
 *         结果用折叠面板一次性铺开，不再分步切换。
 *
 * 依据：《义务教育体育与健康课程标准（2022年版）》
 *       核心素养＝运动能力 + 健康行为 + 体育品德；"教会、勤练、常赛"；"学、练、赛、评"一体化。
 *
 * 数据模型（10 个模块的形状 / 归一化 / 导出排版）在 js/unit-model.js，
 * 与「离线资源库」共用同一份，改结构请改那里。
 */

const UNIT_STORAGE_KEY = 'pe_big_unit_design_v1';
/** 「生成一步存一步」的物理备份键：不经过 Store，云端同步改不到它 */
const UNIT_STEP_BACKUP_KEY = 'pe_big_unit_design_v1__step_backup';
/** 判断一份大单元数据是否完整时看的核心模块（与 Store 的强锁字段保持一致） */
const UNIT_SAVE_CORE_FIELDS = [
  'objectives', 'textbookAnalysis', 'studentAnalysis', 'teachingContent',
  'keyDifficulties', 'structure_nodes', 'main_projects', 'lessons',
  'assessment', 'reflection', 'rubric',
];
/** 课时表分批：一次只写 1 个课时（批越小越不可能撞上模型的单次输出上限，与后端的分批逻辑一致） */
const UNIT_LESSON_CHUNK = 1;
/** 18 课时的固定分批：18 批，每批 1 个课时 */
const UNIT_LESSON_BATCHES = Array.from({ length: 18 }, (_, index) => [index + 1, index + 1]);
/** 课时请求【严格串行】：18 课一次只发一个，await 到底再发下一个。
 *  ⚠️ 不做任何并发、不做前端主动超时 —— 内容详实，模型慢是正常的；
 *     掐断连接 = 前面几十秒的算力全白费，还会把半截表格交给解析器。
 *     超时统一由服务端 AI_TIMEOUT_MS = 120000（120 秒）兜底。 */
/** 单个步骤失败后的重试次数：只重试失败的那一步，已经写好的模块一律保留 */
const UNIT_STAGE_RETRY = 2;

/** 旧版数据（分步生成那套）迁移到新结构，避免老师以前的内容白丢 */
function migrateLegacyUnit(saved) {
  const empty = createEmptyUnit();
  return {
    ...empty,
    unitTitle: typeof saved.theme === 'string' ? saved.theme : '',
    // 旧版是三个小字段 → 合成一段文本（unitObjectivesToText 会自动处理对象/字符串两种形态）
    objectives: unitObjectivesToText(saved.objectives),
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
    // 旧版的 evaluationSummary（学习评价）已随模块 9 删除 —— 不再迁移，交给量规表（模块 10）承担
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
  /* 🛑 幽灵覆盖总闸门：只要当前 unitData 非空且已载入离线资源，
     【任何形式】的 loadUnitData() 自动执行都直接返回内存里的这份视图，
     绝不重新读取 pe_big_unit_design_v1 主键（主键可能还是旧的半截数据）。
     清空重来时 unitData 已被清空，这里自然放行。 */
  if (typeof unitViewIsProtected === 'function' && unitViewIsProtected()) {
    console.warn('[大单元] ⚠️ 试图在切换Tab时重载数据，已阻止。'
      + '（loadUnitData() 被自动调用）当前视图非空且已载入离线资源，直接返回内存中的 unitData');
    return unitData;
  }
  try {
    const saved = Store.read(UNIT_STORAGE_KEY, null);
    /* 🔒 视图优先级锁生效时，主键是唯一可信副本：分步物理备份可能来自更早的旧数据，
       绝不允许用它把旧模块补回刚载入 / 刚保存的当前视图（切页诈尸的最后一条缝）。 */
    const viewPinned = (typeof isUnitViewPinned === 'function' && isUnitViewPinned())
      || (typeof unitHasPersistedViewPin === 'function' && unitHasPersistedViewPin());
    const backup = viewPinned ? null : readUnitStepBackup();
    /* 🛟 物理备份兜底：主数据比备份少了核心模块（同步把旧快照盖回来了），
       就用备份里那些模块补齐。只补【缺的】，绝不整份替换 —— 用户后来的手工修改要保留。 */
    if (backup) {
      const mainFilled = new Set(unitFilledModules(saved));
      const backupFilled = unitFilledModules(backup);
      const lost = backupFilled.filter(field => !mainFilled.has(field));
      if (lost.length) {
        const repaired = { ...(saved && typeof saved === 'object' ? saved : {}) };
        lost.forEach(field => { repaired[field] = backup[field]; });   // 只补缺的，保留后来手工改过的
        console.warn(`[大单元] ⏳ 主数据缺少模块 ${lost.join('、')}，已从分步物理备份补回`);
        if (typeof Store !== 'undefined' && typeof Store.write === 'function') {
          Store.write(UNIT_STORAGE_KEY, repaired, { push: false });
        }
        return normalizeUnit(repaired);
      }
    }
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
/**
 * 🔒 当前视图的「最高优先级」标记：用户主动从离线资源库载入后，
 * 任何 store:sync / 后台同步 / 本地旧缓存都不许重读覆盖 unitData。
 * ⚠️ 判定只认 Store 里【持久化】的视图优先级锁（pe_store_view_pin_v1）。
 *    以前这里还要求页内变量 unitViewPriority，切到资源库页再切回来时页面重建、
 *    页内变量归零，锁判定就失效了 —— 这正是「切页诈尸」的根因。
 *    unitViewPriority 现在只作为「本页确实主动载入过」的辅助信息保留。
 */
let unitViewPriority = null;
let unitReadyHandled = false;      // 本页是否已经载入过视图（载入后禁止任何自动重赋值）
let unitExplicitReset = false;     // 用户亲手点【清空重来】：唯一允许重新载入的例外

function isUnitViewPinned() {
  return typeof Store !== 'undefined'
    && typeof Store.isViewPinned === 'function'
    && Store.isViewPinned(UNIT_STORAGE_KEY);
}

/**
 * 盘上是否已有持久化视图锁。
 * 切回页面时 Store 实例可能还没跑完 _restoreViewPins()，只问 Store 会漏判，
 * 于是又掉进 loadUnitData() 那条旧路。这里直接看 localStorage 摘要兜底。
 */
function unitHasPersistedViewPin() {
  try { return Boolean(localStorage.getItem('pe_store_view_pin_v1')); }
  catch (error) { return false; }
}

/** 当前 unitData 是否已经有真实内容（空模板 / 默认量规 / 空结构图一律不算） */
function unitViewHasContent() {
  if (!unitData || typeof unitData !== 'object') return false;
  if (String(unitData.unitTitle || unitData.meta?.unitTitle || '').trim()) return true;
  const textFields = ['objectives', 'textbookAnalysis', 'studentAnalysis',
    'teachingContent', 'assessment', 'reflection'];
  if (textFields.some(field => String(unitData[field] ?? '').trim().length > 0)) return true;
  if (Array.isArray(unitData.lessons) && unitData.lessons.some(lesson => lesson
    && [lesson.content, lesson.method, lesson.objectives]
      .some(value => String(value ?? '').trim().length > 0))) return true;
  const difficulties = unitData.keyDifficulties;
  if (difficulties && typeof difficulties === 'object'
    && Object.values(difficulties).some(value => String(value ?? '').trim().length > 0)) return true;
  return false;
}

/** 当前视图「已载入离线资源 + 非空」：这是禁止任何自动重载的最高条件 */
function unitViewIsProtected() {
  if (typeof unitViewHasContent !== 'function' || !unitViewHasContent()) return false;
  if (typeof isUnitViewPinned === 'function' && isUnitViewPinned()) return true;
  return typeof unitViewPriority !== 'undefined' && Boolean(unitViewPriority);
}

/**
 * 🛑 Tab 切换 / 页面重新可见的统一拦截口。
 * 只要当前视图已经载入过且非空，就绝不调用 loadUnitData()、绝不重新赋值 unitData。
 * 只有用户亲手点【清空重来】（unitExplicitReset）才放行 —— 载入统一交给 Store.onReady。
 */
function guardTabSwitchReload(reason) {
  if (!unitReadyHandled || !unitViewHasContent() || unitExplicitReset) return false;
  console.warn('[大单元] ⚠️ 试图在切换Tab时重载数据，已阻止。'
    + `（${reason}）当前视图「${unitData.unitTitle || unitData.meta?.unitTitle || '未命名'}」非空`
    + `${isUnitViewPinned() ? '，且视图优先级锁仍锁定' : ''}`
    + '；不调用 loadUnitData()，也不重新赋值 unitData。');
  return true;
}

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
      <p>三步选题 → 一键生成 → 依据《义务教育体育与健康课程标准（2022年版）》输出 10 个模块 + 18 课时计划表。</p>
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
          <button data-admin-only id="ud2GenerateBtn" class="btn btn-primary" type="button" onclick="generateWholeUnit()">✨ 一键生成完整大单元</button>
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
  const groups = itemId && levelId ? unitTopicGroups(itemId, levelId) : [];
  const previous = options.silent ? (unitData.meta.topic || '') : topicSelect.value;
  const optionOf = topic => `<option value="${escapeUnitHTML(topic)}">${escapeUnitHTML(topic)}</option>`;
  topicSelect.innerHTML = topics.length
    ? (groups.length                      // 球类水平二至四按「七大维度」分组显示
      ? groups.map(group => `<optgroup label="${escapeUnitHTML(group.label)}">`
        + group.topics.map(optionOf).join('') + '</optgroup>').join('')
      : topics.map(optionOf).join(''))
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

/* ---------------- 10 个模块的渲染 ---------------- */

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
        <p>AI 会按模块分步生成（前置分析 → 结构图 → 18 课时逐批 → 收尾 → 评价量规表），生成过程中这里会逐块出现，边等边看。</p>
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
  queueUnitMatrixRedraw();     // 结构图的连线要等排版稳定后再画
  unitNextFrame(() => autoSizeUnitLessonTextareas(container));  // 课时表输入框按内容定高
}

/**
 * 局部渲染：只重画指定的那几个模块。
 * 流水线每完成一步就调用一次 —— 老师可以边等边看，前面生成的模块不会因为后面还没跑完而看不见。
 * （整页 renderUnitModules() 会把用户正在编辑的输入框内容冲掉，所以生成过程中一律用局部渲染。）
 */
function renderUnitModuleBlocks(ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return;
  const container = document.getElementById('ud2Modules');
  if (!container) return;
  // 一次内容都还没有时，容器里是空状态 —— 先整体渲染一次，把 10 个模块的骨架铺出来
  if (!container.querySelector('.ud2-module')) {
    renderUnitModules();
    return;
  }
  list.forEach(id => {
    const section = container.querySelector(`.ud2-module[data-module="${id}"]`);
    if (!section) return;
    const body = section.querySelector('.ud2-module-body');
    if (body) body.innerHTML = renderUnitModuleBody(id);
    const state = section.querySelector('.ud2-module-state');
    const done = unitModuleCompleted(unitData, id);
    if (state) {
      state.textContent = done ? '已完成' : '待生成';
      state.className = `ud2-module-state ${done ? 'is-done' : 'is-todo'}`;
    }
  });
  if (list.includes('structure')) queueUnitMatrixRedraw();   // 结构图重画后要重算连线
  if (list.includes('lessons')) {
    // 内容变长了：等浏览器排版完再按实际高度给输入框定高
    unitNextFrame(() => autoSizeUnitLessonTextareas(container));
  }
}

function renderUnitModuleBody(id) {
  switch (id) {
    case 'objectives': return `
      <div class="ud2-objectives-box">
        <p class="ud2-note ud2-objectives-tip">按省级教研教案的写法：<b>运动能力</b>、<b>健康行为</b>、<b>体育品德</b>各一段，段内用分号连接，可观察、可评价。</p>
        <textarea class="form-control ud2-objectives-input" rows="10" data-unit-path="objectives"
          aria-label="教学目标（运动能力 / 健康行为 / 体育品德）"
          placeholder="运动能力：学生积极参加……知道（项目的起源、价值与安全常识）……能够说出……在降低要求的游戏中学练……发展（速度/灵敏/协调）等体能，达到《国家学生体质健康标准》合格水平。&#10;&#10;健康行为：学生了解……养成（热身/放松）习惯；列举安全注意事项……每周 3 次课外锻炼……&#10;&#10;体育品德：能够按要求参与……克服恐惧心理……自觉遵守规则，公平竞争……文明礼貌。">${escapeUnitHTML(unitGetPath(unitData, 'objectives'))}</textarea>
      </div>`;
    case 'textbookAnalysis': return unitField('教材分析', 'textbookAnalysis',
      '第一段：基础知识和基本技能、技战术运用、体能、展示与比赛、规则与裁判方法、观赏与评价。\n第二段：教材的价值与核心素养关联。', 10);
    case 'studentAnalysis': return unitField('学情分析', 'studentAnalysis',
      '结合所选水平学生的认知特点、身体发育特点、已有经验与个体差异。', 6);
    case 'teachingContent': return unitField('主要教学内容', 'teachingContent',
      '1. 知识：……\n2. 技术：……\n3. 战术：……\n4. 体能：……\n5. 比赛活动：……', 8);
    case 'keyDifficulties': return `
      <div class="ud2-grid">
        ${unitField('学生学习重难点（重点 / 难点）', 'keyDifficulties.learning', '重点：……\n难点：……')}
        ${unitField('学习内容重难点（重点 / 难点）', 'keyDifficulties.content', '重点：……\n难点：……')}
        ${unitField('教学组织重难点（重点 / 难点）', 'keyDifficulties.organization', '重点：……\n难点：……')}
        ${unitField('教学方法重难点（重点 / 难点）', 'keyDifficulties.method', '重点：……\n难点：……')}
      </div>`;
    case 'structure': return renderUnitStructure();
    case 'lessons': return renderUnitLessons();
    case 'assessment': return unitField('考核与作业', 'assessment',
      '依据课标学业质量要求：考核内容、评分标准，以及课内外作业安排。', 8);
    case 'reflection': return unitField('教学反思（课后填写模板）', 'reflection',
      '目标达成情况：……\n学生典型表现：……\n教学组织与方法的得失：……\n改进设想：……', 8);
    case 'rubric': return renderUnitRubric();
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
  queueUnitMatrixRedraw();     // 展开结构图后要按新尺寸重画连线
}

function toggleAllUnitModules() {
  const shouldExpand = unitExpanded.size < UNIT_MODULES.length;
  unitExpanded.clear();
  if (shouldExpand) UNIT_MODULES.forEach(module => unitExpanded.add(module.id));
  renderUnitModules();
}

/* ---------------- 模块 6：结构图（维度 × 课次 矩阵泳道图） ---------------- */

/**
 * 结构图骨架：4 条维度泳道（Y 轴）× 18 个课次（X 轴），底部再并一行「主要项目」。
 * 用最朴素的 <table> 画 —— 不引任何图形库，浏览器排版就是最稳的那一套，
 * 老师横向滚动就能看全 18 个课次。
 */
function renderUnitStructure() {
  const missing = missingStructureNumbers(unitData);
  const total = structureNodeCount(unitData);
  const projects = normalizeUnit(unitData).main_projects;
  return `
    <div class="ud2-structure">
      <div class="ud2-structure-head">
        <span>共挂载 ${total} / ${UNIT_LESSON_COUNT} 个课次</span>
        ${missing.length
          ? `<span class="ud2-warn-tag">缺第 ${missing.join('、')} 课次</span>
             <button class="btn btn-ghost" type="button" onclick="autoFixStructure()">按课时表补全</button>`
          : '<span class="ud2-ok-tag">✓ 18 个课次全部就位</span>'}
        ${projects.length
          ? `<span class="ud2-project-tag">主要项目：${escapeUnitHTML(projects.join(' · '))}</span>`
          : '<span class="ud2-project-tag is-empty">主要项目：待补充</span>'}
      </div>
      <div class="ud2-mx">
        <div class="ud2-mx-scroll">
          <div class="ud2-mx-inner">
            <svg class="ud2-mx-links" aria-hidden="true" focusable="false"></svg>
            ${buildUnitStructureMatrixHTML(unitData, { editable: true })}
          </div>
        </div>
        <p class="ud2-mx-tip">横向滚动查看第 1–18 课次；节点按课次顺序用箭头串联，跨维度处为直线连接。</p>
      </div>
    </div>`;
}

/** 节点标题是 textarea：按内容自动撑高，长标题不会被裁掉 */
function unitMatrixAutoSize(field) {
  if (!field || !field.style) return;
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

/**
 * 基础连线：按课次顺序（1→18）把相邻节点用一条带箭头的直线连起来。
 * 同一泳道内是横线，跨泳道画一条最简单的斜线 —— 不做任何跨行绕线，
 * 宁可朴素也不要叠成一团。线画在节点下层（卡片背景不透明），所以压不住任何文字。
 */
function unitMatrixDrawLinks() {
  const inner = document.querySelector('.ud2-mx-inner');
  const svg = document.querySelector('.ud2-mx-links');
  if (!inner || !svg) return;
  inner.querySelectorAll('.ud2-mx-node-title').forEach(unitMatrixAutoSize);
  const nodes = [...inner.querySelectorAll('.ud2-mx-node')]
    .sort((a, b) => Number(a.dataset.no) - Number(b.dataset.no));
  svg.innerHTML = '';
  if (nodes.length < 2) return;
  const box = inner.getBoundingClientRect();
  if (!box.width) return;                    // 模块折叠时量不到尺寸，等展开后再画
  const width = Math.max(inner.scrollWidth, Math.ceil(box.width));
  const height = Math.max(inner.scrollHeight, Math.ceil(box.height));
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const parts = ['<defs><marker id="ud2-mx-arrow" viewBox="0 0 10 10" refX="9" refY="5"'
    + ' markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
    + '<path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker></defs>'];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index].getBoundingClientRect();
    const to = nodes[index + 1].getBoundingClientRect();
    const x1 = from.right - box.left;
    const y1 = from.top + from.height / 2 - box.top;
    const x2 = to.left - box.left;
    const y2 = to.top + to.height / 2 - box.top;
    const cross = nodes[index].dataset.row !== nodes[index + 1].dataset.row;
    parts.push(`<path class="ud2-mx-link${cross ? ' is-cross' : ''}" d="M ${x1} ${y1} L ${x2} ${y2}"`
      + ' marker-end="url(#ud2-mx-arrow)"/>');
  }
  svg.innerHTML = parts.join('');
}

/** 合并多次请求：只在下一帧画一次连线（没有 rAF 的环境退回 setTimeout） */
const unitMatrixRaf = typeof requestAnimationFrame === 'function'
  ? callback => requestAnimationFrame(callback)
  : callback => setTimeout(callback, 16);
const unitMatrixCancel = typeof cancelAnimationFrame === 'function'
  ? handle => cancelAnimationFrame(handle)
  : handle => clearTimeout(handle);

let unitMatrixFrame = null;
function queueUnitMatrixRedraw() {
  if (unitMatrixFrame) unitMatrixCancel(unitMatrixFrame);
  unitMatrixFrame = unitMatrixRaf(() => {
    unitMatrixFrame = null;
    unitMatrixDrawLinks();
  });
}

/** 课时表已生成但结构图不完整时，按序号把缺的课次补进对应泳道（补齐规则在 unit-model.js） */
function autoFixStructure() {
  const missing = missingStructureNumbers(unitData);
  if (!missing.length) return;
  unitData = autoFillStructure(unitData);
  saveUnitData();
  renderUnitModules();
  showUnitStatus(`已按课时表补全 ${missing.length} 个缺失课次，请按教学实际调整归属泳道。`, 'warning');
}

/* ---------------- 模块 7：18 课时计划表 ---------------- */

/**
 * 18 课时的维度分布提示：一眼看出是否真的按多维结构生成、还缺哪个维度的课时。
 * 例如：维度分布：基本技术 8 · 战术 3 · 体能 2 · 比赛 2 · 规则 1 · 基础知识 1（缺 观赏）
 */
function unitDimensionCoverageHint() {
  if (typeof unitDimensionCoverage !== 'function') return '';
  const coverage = unitDimensionCoverage(unitData);
  const labelOf = id => (window.UNIT_DIMENSIONS || []).find(dimension => dimension.id === id)?.label || id;
  const parts = Object.keys(coverage)
    .filter(id => id && id !== '未标注')
    .sort((a, b) => coverage[b].length - coverage[a].length)
    .map(id => `${labelOf(id)} ${coverage[id].length}`);
  if (coverage['未标注']) parts.push(`未标注 ${coverage['未标注'].length}`);
  if (!parts.length) return '';
  const expected = Array.isArray(unitData.meta?.dimensions) ? unitData.meta.dimensions : [];
  const missing = expected.filter(id => !coverage[id]?.length).map(labelOf);
  return `<span class="ud2-toolbar-hint">维度分布：${escapeUnitHTML(parts.join(' · '))}`
    + `${missing.length ? `（缺 ${escapeUnitHTML(missing.join('、'))} 的课时）` : ''}</span>`;
}

/**
 * 课时表（模块 7）—— 精简成 4 列：
 *   课次 | 学习目标（三维段落） | 主要学习内容（结构化） | 教学策略 / 学练活动
 *
 * ⚠️ 这里【不再展示「维度」列】—— 对老师没有操作价值，又白占一列宽度。
 *    但底层 lesson.dimension 一行没动：它仍由 AI 写进数据模型，
 *    顶部的「维度分布」统计、模块 6 的结构图泳道、维度覆盖校验全靠它。
 */

/** 输入框的初始高度：按内容行数给一个估值（真正的自适应在渲染后由 autoSizeUnitLessonTextareas 校正） */
function unitLessonTextareaRows(text) {
  const value = String(text || '');
  const lines = value.split('\n').filter(line => line.trim()).length;
  // 12px 字号、列宽约 26 个中文字一行 —— 折行数也算进去
  const wrapped = Math.ceil(value.replace(/\n/g, '').length / 26);
  return Math.max(6, Math.min(20, Math.max(lines, wrapped) + 1));
}

/**
 * 下一帧再执行（等浏览器排版完再量高度）。
 * 测试用的假 DOM 里没有 requestAnimationFrame，这里降级成 setTimeout。
 */
function unitNextFrame(fn) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else if (typeof setTimeout === 'function') setTimeout(fn, 0);
  else fn();
}

/**
 * 课时表的三格现在内容很长：按实际内容给输入框定高。
 *   · 下限 170px：短内容也不至于太扁
 *   · 上限 340px：超出的部分在框内滚动，页面不会被撑成无限长
 */
function autoSizeUnitLessonTextareas(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('.ud2-lesson-table textarea').forEach(box => {
    box.style.height = 'auto';
    const need = Math.min(340, Math.max(170, box.scrollHeight + 4));
    box.style.height = `${need}px`;
  });
}

function renderUnitLessons() {
  const missing = unitMissingLessonNumbers();
  return `
    <div class="ud2-lesson-toolbar">
      <span class="${missing.length ? 'ud2-warn-tag' : 'ud2-ok-tag'}">
        ${missing.length ? `第 ${missing.join('、')} 课时还没内容` : '✓ 18 个课时都已填写'}
      </span>
      <span class="ud2-toolbar-hint">课时多、容易被 AI 输出上限截断；缺课时时按批次单独生成即可。</span>
      ${unitDimensionCoverageHint()}
      <button class="btn btn-secondary" type="button" onclick="generateLessonTableOnly()">单独生成课时表</button>
    </div>
    <div class="ud2-table-wrap">
      <table class="data-table ud2-lesson-table">
        <thead><tr>
          <th style="width:64px">课次</th>
          <th style="width:31%">学习目标（三维段落）</th>
          <th style="width:34%">主要学习内容（结构化）</th>
          <th style="width:31%">教学策略 / 学练活动</th>
        </tr></thead>
        <tbody>
          ${unitData.lessons.map((lesson, index) => `
            <tr>
              <th scope="row">第 ${index + 1} 课</th>
              <td><textarea class="form-control" rows="${unitLessonTextareaRows(lesson.objectives)}" data-unit-path="lessons.${index}.objectives"
                aria-label="第 ${index + 1} 课学习目标">${escapeUnitHTML(lesson.objectives)}</textarea></td>
              <td><textarea class="form-control" rows="${unitLessonTextareaRows(lesson.content)}" data-unit-path="lessons.${index}.content"
                aria-label="第 ${index + 1} 课主要学习内容">${escapeUnitHTML(lesson.content)}</textarea></td>
              <td><textarea class="form-control" rows="${unitLessonTextareaRows(lesson.method)}" data-unit-path="lessons.${index}.method"
                aria-label="第 ${index + 1} 课教学策略与学练活动">${escapeUnitHTML(lesson.method)}</textarea></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/** 模块 10：单元学习评价表（四等级量规 + 素养占比 + 细分得分点） */
function renderUnitRubric() {
  const rubric = unitData.rubric || unitRubricTemplate();
  return `
    <div class="ud2-rubric-editor">
      ${buildUnitRubricHTML(unitData)}
      <label class="ud2-form-field ud2-rubric-note"><span>评价说明（权重微调、评价主体与时间安排等）</span>
        <textarea class="form-control" rows="3" data-unit-path="rubric.note"
          placeholder="例如：运动能力占比 60%，其中运动技能 36 分按本单元技战术达标评定；采用师评 60%+自评 20%+组内互评 20%。">${escapeUnitHTML(rubric.note || '')}</textarea></label>
    </div>`;
}

/** 课时详情：占位弹窗（后续接入流式生成详细教案） */
function showUnitLessonDetail(no) {
  const lesson = unitData.lessons[no - 1];
  if (!lesson) return;
  // 维度不再占用表格的一列，但老师仍能在详情里看到它（底层字段一直都在）
  const dimensionText = (typeof unitMatrixDimensionLabel === 'function' ? unitMatrixDimensionLabel(lesson.dimension) : '')
    || (window.UNIT_DIMENSIONS || []).find(dimension => dimension.id === lesson.dimension)?.label || '';
  const summary = `
    <dl class="ud2-summary">
      <dt>课时</dt><dd>第 ${no} 课 / 共 ${UNIT_LESSON_COUNT} 课</dd>
      <dt>所属维度</dt><dd>${escapeUnitHTML(dimensionText) || '—'}</dd>
      <dt>学习目标（三维段落）</dt><dd>${escapeUnitHTML(lesson.objectives) || '（未生成）'}</dd>
      <dt>主要学习内容</dt><dd>${escapeUnitHTML(lesson.content) || '（未生成）'}</dd>
      <dt>教学策略 / 学练活动</dt><dd>${escapeUnitHTML(lesson.method) || '（未生成）'}</dd>
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

/** 单个文本字段的入库上限（超了就是模型跑飞了，截掉反而更安全） */
const UNIT_SAVE_FIELD_LIMIT = 4000;
/** 单课时的三格各自上限 */
const UNIT_SAVE_LESSON_LIMIT = 2000;

/**
 * 落盘前的裁剪：只留【纯文本的成品数据】，剔掉一切中间状态与冗余。
 *
 * 为什么必须裁：
 *   · 大单元正文有上万字，直接整份 POST 到 /api/data 容易撞上服务端超时（502）；
 *   · 一课一存的话，一轮生成就是 18 次整份上传 —— 必然触发限流/超时。
 * 裁剪后存的是"老师真正要的那份数据"，体积可控、语义不变。
 */
function unitSavePayload() {
  const data = unitData || {};
  const clip = (text, limit = UNIT_SAVE_FIELD_LIMIT) => {
    const value = String(text ?? '').trim();
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  };
  const difficulties = {};
  Object.entries(data.keyDifficulties || {}).forEach(([key, value]) => {
    const text = clip(value);
    if (text) difficulties[key] = text;
  });
  return {
    meta: {
      unitTitle: clip(data.meta?.unitTitle, 80),
      category: data.meta?.category || '',
      categoryId: data.meta?.categoryId || '',
      item: data.meta?.item || '',
      itemId: data.meta?.itemId || '',
      level: data.meta?.level || '',
      levelId: data.meta?.levelId || '',
      topic: clip(data.meta?.topic, 120),
      topicPending: !!data.meta?.topicPending,
      dimensions: Array.isArray(data.meta?.dimensions) ? data.meta.dimensions.slice(0, 12) : [],
      generatedAt: data.meta?.generatedAt || '',
    },
    unitTitle: clip(data.unitTitle, 80),
    objectives: clip(data.objectives),
    textbookAnalysis: clip(data.textbookAnalysis),
    studentAnalysis: clip(data.studentAnalysis),
    teachingContent: clip(data.teachingContent),
    keyDifficulties: difficulties,
    // 结构图：只留 id / dimension / title
    structure_nodes: (Array.isArray(data.structure_nodes) ? data.structure_nodes : [])
      .map(node => ({ id: node.id, dimension: node.dimension || '', title: clip(node.title, 40) })),
    main_projects: (Array.isArray(data.main_projects) ? data.main_projects : [])
      .map(item => clip(item, 40)).filter(Boolean).slice(0, 6),
    // 18 个课时：只留 no / dimension / 三格文本
    lessons: (Array.isArray(data.lessons) ? data.lessons : []).map(lesson => ({
      no: lesson.no,
      dimension: lesson.dimension || '',
      objectives: clip(lesson.objectives, UNIT_SAVE_LESSON_LIMIT),
      content: clip(lesson.content, UNIT_SAVE_LESSON_LIMIT),
      method: clip(lesson.method, UNIT_SAVE_LESSON_LIMIT),
    })),
    assessment: clip(data.assessment),
    reflection: clip(data.reflection),
    rubric: data.rubric && typeof data.rubric === 'object' ? {
      levels: (data.rubric.levels || []).map(level => ({
        name: level.name, range: level.range,
        ability: clip(level.ability, 600), health: clip(level.health, 600), character: clip(level.character, 600),
      })),
      literacyWeights: (data.rubric.literacyWeights || []).map(weight => ({
        literacy: weight.literacy, percent: weight.percent,
      })),
      scoreItems: (data.rubric.scoreItems || []).map(item => ({
        name: clip(item.name, 60), literacy: item.literacy, points: item.points, desc: clip(item.desc, 600),
      })),
      note: clip(data.rubric.note),
    } : data.rubric,
  };
}

/**
 * 保存大单元数据。
 * @param {{silent?: boolean, cloud?: boolean}} options
 *   cloud=false → 只落本地（push:false），生成过程中的高频保存走这条，
 *                 避免一轮生成往云端 POST 十几遍整份数据（那是 502 的真正来源）。
 *   cloud=true（默认）→ 本地 + 云端各写一次。
 */
function saveUnitData({ silent = false, cloud = true, step = '' } = {}) {
  const payload = unitSavePayload();
  /* ① 生成一步存一步：先写一份【物理备份】，不经过 Store、不受任何云端同步影响。
        主数据哪怕被别的地方覆盖，这份也一直在盘上，loadUnitData 会自动拿它补回来。
        同步写（localStorage.setItem），绝不 await —— 拿到模块那一刻就已经落盘。 */
  writeUnitStepBackup(payload, step);
  /* ② 主数据照常写：生成中只落本地（cloud:false），避免每步都推云端把 /api/data 打爆 */
  try {
    if (cloud) {
      Store.write(UNIT_STORAGE_KEY, payload);
    } else {
      Store.write(UNIT_STORAGE_KEY, payload, { push: false });
    }
    if (!silent && !unitGenerating) showUnitStatus('✓ 已自动保存', 'success');
    /* ✅ 保存成功：立刻把这份最新 payload 硬写进 Store 内存缓存与 localStorage 主键，
       并保持 / 补回视图优先级锁。切回页面时 read() 读到的绝对是这一版。 */
    if (typeof Store !== 'undefined' && typeof Store.commitView === 'function') {
      const committed = Store.commitView(UNIT_STORAGE_KEY, payload, {
        reason: '大单元保存成功',
        userModified: Boolean(unitViewPriority) || isUnitViewPinned(),
      });
      if (!silent && !unitGenerating) {
        console.log('[大单元] ✅ 保存成功：已强制刷新 Store 内存缓存与 localStorage 主键'
          + `${committed?.userModified ? '，视图优先级锁保持锁定（切页也不会重读旧数据）' : ''}`);
      }
    }
  } catch (error) {
    console.error('保存大单元数据失败', error);
    showUnitStatus(`保存失败：${error.message}`, 'error');
  }
  // ③ 长生成的心跳：刷新冻结信号时间戳，避免 60 分钟 TTL 到期后同步提前解冻
  if (unitGenerating && typeof Store !== 'undefined' && typeof Store.setGenerating === 'function') {
    try { Store.setGenerating(true, step || '生成中（心跳）'); } catch (error) { /* 忽略 */ }
  }
}

/** 每一步的物理备份（带时间戳与步骤名，供 loadUnitData 兜底恢复） */
function writeUnitStepBackup(payload, step = '') {
  try {
    localStorage.setItem(UNIT_STEP_BACKUP_KEY, JSON.stringify({
      savedAt: Date.now(), step, data: payload,
    }));
  } catch (error) {
    console.warn('[大单元] 写入分步物理备份失败（主数据不受影响）', error);
  }
}

/** 读取分步物理备份（主数据缺模块时兜底） */
function readUnitStepBackup() {
  try {
    const raw = localStorage.getItem(UNIT_STEP_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data && typeof parsed.data === 'object' ? parsed.data : null;
  } catch (error) {
    return null;
  }
}

/** 模块里是否真的有内容（空课次 / 空节点不算） */
function unitModuleHasContent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(unitModuleHasContent);
  if (typeof value === 'object') {
    return Object.entries(value).some(([key, item]) =>
      !['no', 'id', 'dimension'].includes(key) && unitModuleHasContent(item));
  }
  return Boolean(value);
}

/** 统计一份大单元数据里有哪些核心模块是有内容的 */
function unitFilledModules(data) {
  return UNIT_SAVE_CORE_FIELDS.filter(field => unitModuleHasContent(data?.[field]));
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
  /* ⏸ 生成期间全局冻结云端同步：后台 SWR / 重连 / 兄弟 iframe 一律不许拉云端覆盖本地。
     挂在 finally 里，哪怕中途抛错也一定解冻，绝不把 Store 永久冻住。 */
  try {
    if (typeof Store !== 'undefined' && typeof Store.setGenerating === 'function') {
      Store.setGenerating(active, active ? '一键生成完整大单元' : '流水线结束');
    }
  } catch (error) {
    console.warn('设置生成冻结状态失败：', error);
  }
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
  analysis: '前置分析（模块 1–5）',
  analysis_part1: '前置分析上（模块 1–3）',
  analysis_part2: '前置分析下（模块 4–5）',
  structure: '结构图（模块 6）',
  lessons: '课时表',
  lesson_single: '单课时',
  closing: '收尾（模块 8–9）',
  rubric: '单元学习评价表（模块 10）',
};

/**
 * 【一键生成】的流水线：每一步 = 一次请求 = 一小块内容。
 * 顺序有讲究：先出前置分析与结构图，课时表才知道每个课次落在哪条泳道、练哪个具体项目；
 * 收尾（考核/反思）与评价量规表各自独立，互不影响。
 *
 * 全部 22 步【串行】执行 —— 串行的好处：
 *   ① 每一步的上下文都能带上前面已经生成的内容，整体连贯；
 *   ② 任一步失败只影响那一步（可单独重试），绝不推翻前面已经写好的模块；
 *   ③ 每完成一步就合并 + 局部渲染，老师可以边等边看。
 */
const UNIT_PIPELINE = [
  // 前置分析拆两段（各 ≤ 800 字）—— 一次写 6 个模块会被模型的输出上限截断
  { id: 'analysis-part1', stage: 'analysis_part1', label: '前置分析（模块 1–3）', modules: ['objectives', 'textbookAnalysis', 'studentAnalysis'] },
  { id: 'analysis-part2', stage: 'analysis_part2', label: '前置分析（模块 4–5）', modules: ['teachingContent', 'keyDifficulties'] },
  { id: 'structure', stage: 'structure', label: '结构图（模块 6）', modules: ['structure'] },
  ...UNIT_LESSON_BATCHES.map(([from, to]) => ({
    id: `lessons-${from}-${to}`,
    stage: 'lesson_single',
    group: 'lessons',
    from,
    to,
    no: from,
    label: `第 ${from} 课时`,
    modules: ['lessons'],
  })),
  { id: 'closing', stage: 'closing', label: '收尾（模块 8–9）', modules: ['assessment', 'reflection'] },
  { id: 'rubric', stage: 'rubric', label: '单元学习评价表（模块 10）', modules: ['rubric'] },
];

function updateUnitProgress(charCount, phaseLabel, hint = '请稍候，不要刷新页面', basePercent = 0) {
  const bar = document.getElementById('ud2ProgressBar');
  const text = document.getElementById('ud2ProgressText');
  // 整体进度由【步骤数】决定（basePercent），当前这一步内部再按已接收字数微调（最多 +8%）
  const percent = Math.max(2, Math.min(99, basePercent + Math.min(8, Math.round((charCount / 300) * 8))));
  if (bar) bar.style.width = `${percent}%`;
  if (text) text.textContent = `${phaseLabel}：已接收 ${charCount.toLocaleString('zh-CN')} 字…（${hint}）`;
}

/** 各阶段在进度条里的权重（课时占大头：18 次请求；前置分析拆两段，各占一半） */
const UNIT_STEP_WEIGHTS = {
  analysis: 10, analysis_part1: 5, analysis_part2: 5,
  structure: 10, lessons: 65, closing: 8, rubric: 7,
};
const UNIT_STEP_ORDER = ['analysis_part1', 'analysis_part2', 'structure', 'lessons', 'closing', 'rubric'];

/** 某个阶段内的进度（0~1）换算成整条流水线的百分比 */
function unitPhasePercent(phase, ratio) {
  let base = 0;
  for (const key of UNIT_STEP_ORDER) {
    if (key === phase) return base + UNIT_STEP_WEIGHTS[key] * Math.max(0, Math.min(1, ratio));
    base += UNIT_STEP_WEIGHTS[key];
  }
  return base;
}

/** 设置进度条（百分比 + 文案） */
function setUnitProgress(percent, message) {
  const bar = document.getElementById('ud2ProgressBar');
  const text = document.getElementById('ud2ProgressText');
  if (bar) bar.style.width = `${Math.max(2, Math.min(99, Math.round(percent)))}%`;
  if (text) text.textContent = message;
}

/** 切到流水线的第 n 步（n 从 1 开始）：进度条直接按步骤推进，不再靠字数猜 */
function setUnitProgressStep(index, total, label) {
  const percent = Math.round(((index - 1) / total) * 100);
  setUnitProgress(percent, `正在生成${label}…（${index}/${total}）`);
}

/** 课时阶段的进度：「正在生成第 X/18 课时（第 N 课次）…」 */
function setUnitLessonProgress(done, total, no) {
  const percent = unitPhasePercent('lessons', done / total);
  setUnitProgress(percent, `正在生成第 ${done}/${total} 课时（第 ${no} 课次）…`);
}

/**
 * 每个阶段负责哪些字段（少严格的 phasesMap）。
 * 拆字段的目的：一次请求只让 AI 写一小块内容，避免撞上它的单次输出上限。
 */
const UNIT_PHASE_FIELDS = {
  // 前置分析拆成两段请求：任一段被截断，另一段照样能落地
  analysis: ['unitTitle', 'objectives', 'textbookAnalysis', 'studentAnalysis', 'teachingContent', 'keyDifficulties'],
  analysis_part1: ['unitTitle', 'objectives', 'textbookAnalysis', 'studentAnalysis'],
  analysis_part2: ['teachingContent', 'keyDifficulties'],
  structure: ['structure_nodes', 'main_projects'],
  lessons: ['lessons'],
  lesson_single: ['lessons'],
  closing: ['assessment', 'reflection'],
  rubric: ['rubric'],
};

/** 模块 8–9（考核 / 反思）里还没内容的那些 */
function unitClosingMissing() {
  return ['assessment', 'reflection']
    .filter(id => !unitModuleCompleted(unitData, id));
}

/** 模块 1–5（前置分析）里还没内容的那些 —— 纯文本里没匹配到分隔符就会缺 */
function unitAnalysisMissing() {
  return ['objectives', 'textbookAnalysis', 'studentAnalysis', 'teachingContent', 'keyDifficulties']
    .filter(id => !unitModuleCompleted(unitData, id));
}

/** 模块 10（单元学习评价表）还没内容 —— 只有课标模板不算"有内容" */
function unitRubricMissing() {
  const rubric = normalizeUnit(unitData).rubric;
  const template = unitRubricTemplate();
  const sameLevels = JSON.stringify(rubric.levels) === JSON.stringify(template.levels);
  const sameItems = JSON.stringify(rubric.scoreItems) === JSON.stringify(template.scoreItems);
  return sameLevels && sameItems ? ['rubric'] : [];
}

/** 收尾模块（8–10）里还没内容的那些 */
function unitTailMissing() {
  return [...unitClosingMissing(), ...unitRubricMissing()];
}

/**
 * 课时表里还没写完整的课次号。
 * 判据是"内容"与"三维目标"都得有 —— 被截断的半截课时常常只剩目标没有内容，
 * 那种课时对老师没用，必须算缺失、重新生成（否则模块 7 里会留一行空的教学内容）。
 */
function unitMissingLessonNumbers() {
  return unitData.lessons
    .filter(lesson => !(
      unitHasContent(lesson.content)
      && unitHasContent(lesson.objectives)
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
  const lessonTitles = (unitData.structure_nodes || [])
    .map(node => ({ no: node.id, title: node.title }))
    .sort((a, b) => a.no - b.no);
  return {
    unitTitle: unitData.unitTitle,
    objectives: unitData.objectives,
    teachingContent: unitData.teachingContent,
    keyDifficulties: unitData.keyDifficulties,
    // 「细项 + 水平」对应的具体教学内容清单：让 18 课时落到具体项目，而不是泛泛写"田径""球类"
    topicList: unitSelectionTopicList(),
    // 本选题涉及的维度：后端据此确认课时表要覆盖哪些维度（旧客户端没带时用得上）
    dimensions: unitSelectionDimensions(),
    lessonTitles,
  };
}

/* ---------------- 课次 → 维度 计划表（与后端 lib/ai-core.js 的同名逻辑保持一致） ----------------
 *
 * 为什么前端也要算一遍：
 *   课时内容由 AI 写，但【每一课属于哪个维度】是系统排定的，不该指望 AI 写对 ——
 *   结构图泳道、维度覆盖统计、每课内容归属全靠它。
 *   前后端各算一份，所以测试里有一条断言盯着两边必须一致。
 */

const UNIT_DIMENSION_WEIGHT = { basic: 2, technique: 8, tactic: 3, fitness: 2.5, match: 2.5, rule: 1, watch: 1 };

/** 清单条目形如「【基本技术】原地运球」—— 取出维度名 */
function unitDimensionLabelOfEntry(entry) {
  const matched = String(entry || '').match(/^【([^】]+)】/);
  return matched ? matched[1] : '';
}

/** 统计清单里出现了哪些维度、各有多少条 */
function unitDimensionStatsFor(topicList) {
  const known = (typeof UNIT_DIMENSIONS !== 'undefined' ? UNIT_DIMENSIONS : []);
  const stats = [];
  (topicList || []).forEach(entry => {
    const label = unitDimensionLabelOfEntry(entry);
    if (!label) return;
    let stat = stats.find(item => item.label === label);
    if (!stat) {
      const dimension = known.find(item => item.label === label);
      stat = { id: dimension ? dimension.id : '', label, count: 0 };
      stats.push(stat);
    }
    stat.count += 1;
  });
  const rankOf = label => {
    const index = known.findIndex(item => item.label === label);
    return index < 0 ? 99 : index;
  };
  return stats.sort((a, b) => rankOf(a.label) - rankOf(b.label));
}

/** 18 课时在各维度上的课标配比（与后端 unitDimensionQuota 完全一致） */
function unitDimensionQuotaFor(stats, total = 18) {
  const items = (Array.isArray(stats) ? stats : [])
    .filter(stat => stat && stat.count > 0)
    .map(stat => ({ id: stat.id, label: stat.label, count: stat.count, lessons: 1 }));
  if (!items.length) return [];
  let left = total - items.length;
  if (left <= 0) return items;

  const weightOf = item => UNIT_DIMENSION_WEIGHT[item.id] ?? 2;
  const totalWeight = items.reduce((sum, item) => sum + weightOf(item), 0) || 1;
  items.forEach(item => { item.lessons += Math.floor((left * weightOf(item)) / totalWeight); });

  let freed = 0;
  items.forEach(item => {
    const cap = Math.max(1, item.count * 2);
    if (item.lessons > cap) {
      freed += item.lessons - cap;
      item.lessons = cap;
    }
  });
  const capOf = item => Math.max(1, item.count * 2);
  const byWeight = items.slice().sort((a, b) => weightOf(b) - weightOf(a));
  let index = 0;
  while (freed > 0 && index < total * 4) {
    const target = byWeight[index % byWeight.length];
    if (target.lessons < capOf(target)) {
      target.lessons += 1;
      freed -= 1;
    }
    index += 1;
  }
  while (freed > 0) {
    byWeight[0].lessons += 1;
    freed -= 1;
  }
  const sum = () => items.reduce((acc, item) => acc + item.lessons, 0);
  while (sum() < total) {
    const target = byWeight.find(item => item.lessons < capOf(item)) || byWeight[0];
    target.lessons += 1;
  }
  while (sum() > total) {
    const target = byWeight.slice().reverse().find(item => item.lessons > 1);
    if (!target) break;
    target.lessons -= 1;
  }
  return items;
}

/** 课次号 → 维度 → 具体项目（与后端 unitLessonPlan 完全一致） */
function unitLessonPlanFor(topicList, total = 18) {
  const stats = unitDimensionStatsFor(topicList);
  if (!stats.length) return [];
  const known = (typeof UNIT_DIMENSIONS !== 'undefined' ? UNIT_DIMENSIONS : []);
  const byDimension = new Map();
  (topicList || []).forEach(entry => {
    const label = unitDimensionLabelOfEntry(entry);
    if (!label) return;
    const dimension = known.find(item => item.label === label);
    if (!dimension) return;
    const list = byDimension.get(dimension.id) || [];
    list.push(entry.replace(/^【[^】]+】/, '').replace(/^\[待确认\]\s*/, '').trim());
    byDimension.set(dimension.id, list);
  });
  const plan = [];
  let no = 1;
  unitDimensionQuotaFor(stats, total).forEach(item => {
    const entries = byDimension.get(item.id) || [item.label];
    for (let index = 0; index < item.lessons; index += 1) {
      const base = entries[index % entries.length] || item.label;
      const round = Math.floor(index / entries.length);
      const suffix = round === 0 ? '' : round === 1 ? '（进阶提高）' : '（综合运用与比赛检验）';
      plan.push({ no, dimension: item.id, dimensionLabel: item.label, topic: `${base}${suffix}` });
      no += 1;
    }
  });
  return plan.slice(0, total);
}

/** 当前选题对应的 18 课次计划表（带缓存，避免每次请求都重算） */
let unitPlanCache = null;
function unitCurrentLessonPlan() {
  const key = JSON.stringify(unitSelectionTopicList());
  if (unitPlanCache && unitPlanCache.key === key) return unitPlanCache.plan;
  const plan = unitLessonPlanFor(unitSelectionTopicList());
  unitPlanCache = { key, plan };
  return plan;
}

/** 当前选题（细项 + 水平）对应的具体教学内容清单（带维度前缀，喂给 AI 时维度也要告诉它） */
function unitSelectionTopicList() {
  const meta = unitData.meta || {};
  if (typeof listUnitTopics !== 'function') return [];
  const found = typeof findUnitCatalogItem === 'function'
    ? findUnitCatalogItem(meta.itemId || unitSelect('ud2Item').value)
    : null;
  const itemId = (found?.item?.id) || meta.itemId || unitSelect('ud2Item').value;
  const levelId = meta.levelId || unitSelect('ud2Level').value;
  return typeof unitTopicListWithDimension === 'function'
    ? unitTopicListWithDimension(itemId, levelId)
    : listUnitTopics(itemId, levelId);
}

function unitSelectionMeta(selection) {
  return selection ? {
    categoryId: selection.categoryId, category: selection.categoryLabel,
    itemId: selection.itemId, item: selection.itemLabel,
    levelId: selection.levelId, level: selection.levelLabel,
    topic: selection.topic, topicPending: isUnitTopicPending(selection.topic),
    // 本选题涉及哪些维度 —— 结构图据此显示分支，也便于事后核对 18 课时是否覆盖了各维度
    dimensions: unitSelectionDimensions(selection),
  } : {};
}

/** 当前选题（细项 + 水平）实际涉及的维度 id 列表（七大维度的子集） */
function unitSelectionDimensions(selection = currentUnitSelection()) {
  if (typeof unitTopicGroups !== 'function') return [];
  const groups = unitTopicGroups(selection.itemId || unitSelect('ud2Item').value,
    selection.levelId || unitSelect('ud2Level').value);
  return groups.map(group => group.id);
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
        // dimension：本课次属于哪个维度（七大维度键），用于校验 18 课时是否覆盖各维度
        if (typeof item.dimension === 'string' && item.dimension) target.dimension = item.dimension.trim();
        // ⚠️ AI 现在不再输出维度（prompt 已删掉这个要求）→ 由系统排定的计划表回填。
        //    结构图泳道、维度覆盖统计都靠它，缺了就必须补上，绝不能留空。
        if (!target.dimension) {
          const planRow = unitCurrentLessonPlan().find(row => row.no === no);
          if (planRow?.dimension) target.dimension = planRow.dimension;
        }
        // 学习目标：新版是一段文本，旧版是三个小字段 —— 两种都能收
        const objectiveText = unitObjectivesToText(item.objectives);
        if (objectiveText) target.objectives = objectiveText;
        if (typeof item.content === 'string' && item.content) target.content = item.content;
        if (typeof item.method === 'string' && item.method) target.method = item.method;
      });
      return;
    }
    if (field === 'structure_nodes') {
      // 结构图节点按【课次号】落位（AI 可能只回一部分，不能按下标错位）
      if (!Array.isArray(value)) return;
      const byId = new Map(next.structure_nodes.map(node => [node.id, { ...node }]));
      value.forEach(item => {
        const id = Number(item?.id ?? item?.no);
        if (!Number.isInteger(id) || id < 1 || id > UNIT_LESSON_COUNT) return;
        const current = byId.get(id) || { id, dimension: '', title: '' };
        const dimension = unitMatrixDimensionLabel(item?.dimension);
        const title = typeof item?.title === 'string' ? item.title : '';
        byId.set(id, {
          id,
          dimension: dimension || current.dimension || '基础知识',
          title: title || current.title,
        });
      });
      next.structure_nodes = normalizeStructureNodes([...byId.values()]);
      return;
    }
    if (field === 'main_projects') {
      const list = Array.isArray(value) ? value : String(value || '').split(/[、,，;；]/);
      next.main_projects = normalizeMainProjects(list);
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

/** 走纯文本的阶段（长文本用 JSON 包裹必被截断，改用分隔符 + 纯文本） */
const UNIT_TEXT_STAGES = ['analysis', 'analysis_part1', 'analysis_part2', 'lessons', 'lesson_single', 'rubric'];

/**
 * 前端期望的后端版本号 —— 必须与 lib/ai-core.js 的 UNIT_BACKEND_VERSION 一致。
 * 后端会在响应头回传它自己的版本号；两者不一致 = 后端还没重新部署，
 * 这时前端会明确警告，而不是让用户对着"未知的生成阶段：xxx"猜谜。
 */
const UNIT_CLIENT_VERSION = '2026-11-06-split-v3';

/** 比对后端版本；不一致就在控制台点名道姓地喊出来 */
function unitCheckBackendVersion(response) {
  try {
    const server = response?.headers?.get?.('X-Unit-Backend-Version');
    if (!server) return;                       // 老后端根本不回这个头 → 交给 400 报错兜底
    if (server === UNIT_CLIENT_VERSION) return;
    console.warn(
      `[大单元] ⚠️ 后端版本 ${server} 与前端 ${UNIT_CLIENT_VERSION} 不一致 —— `
      + '前端已更新但服务器上的后端代码还没部署，请重新部署后再生成！',
    );
  } catch { /* 取不到头就当没这回事 */ }
}

/** 请求某一个阶段，并读取它的流式结果（options.label 用于区分进度条文案，options.basePercent 是这一步的起始进度） */
async function requestUnitStage(stage, selection, context = null, extra = {}, options = {}) {
  let response;
  /* ⚠️ 前端绝不主动断开：不设 AbortController 定时器、不设 signal。
     单个课时几百字，模型思考 + 吐字本来就慢，主动 abort 只会把好内容变成半截表格，
     还会抛出 "signal is aborted" 让整课作废。
     超时统一由服务端 AI_TIMEOUT_MS = 120000（120 秒）兜底，本地 server.js / Vercel api/ai.js 都已配好。 */
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
        // 让后端按「细项 + 水平」拿到具体教学内容清单，18 课时才有抓手
        itemId: selection.itemId,
        levelId: selection.levelId,
        topicList: unitSelectionTopicList(),
        ...(context ? { context } : {}),
        ...extra,
      }),
    });
  } catch {
    throw new Error('无法连接本地 AI 服务，请确认已运行 node server.js。');
  }
  unitCheckBackendVersion(response);
  if (!response.ok) {
    let result = null;
    try { result = await response.json(); } catch { /* 非 JSON 错误体 */ }
    throw new Error(result?.error || `AI 服务请求失败（HTTP ${response.status}）`);
  }
  const label = options.label || UNIT_STAGE_LABELS[stage] || '生成中';
  const base = Number(options.basePercent) || 0;

  // 纯文本阶段：读原文 → 按分隔符切分 → 得到各模块
  if (options.format === 'text' || UNIT_TEXT_STAGES.includes(stage)) {
    const raw = await readUnitTextStream(response, charCount => updateUnitProgress(charCount, label, '请稍候，不要刷新页面', base));
    let parsed = null;
    if (stage === 'rubric') {
      parsed = parseUnitRubricText(raw.content);
    } else if (stage === 'lessons' || stage === 'lesson_single') {
      parsed = parseUnitLessonText(raw.content, {
        no: extra.lessonNo ?? extra.startLesson ?? extra.from,
        dimension: extra.dimension ?? '',
      });
      // 维度是结构图泳道与维度覆盖统计的依据：AI 不再吐 dimension（prompt 已删），
      // 一律由系统排定的计划表回填 —— 既不丢归属，也不会被模型写错。
      parsed.lessons.forEach(lesson => {
        if (!lesson.dimension && parsed.dimension) lesson.dimension = parsed.dimension;
        if (!lesson.dimension) {
          const planRow = unitCurrentLessonPlan().find(row => row.no === lesson.no);
          if (planRow?.dimension) lesson.dimension = planRow.dimension;
        }
      });
    } else {
      // analysis / analysis_part1 / analysis_part2 —— 同一套切段逻辑，缺哪段就少哪段
      parsed = parseUnitAnalysisText(raw.content);
    }
    // 解析不出东西时把 AI 的原始返回打到控制台，方便现场排查"它到底写了什么鬼"
    if (unitStagePayloadEmpty(parsed, stage)) {
      console.log('AI原始返回:', String(raw.content || '').slice(0, 500));
    }
    return { data: parsed, content: raw.content, truncated: raw.truncated, warning: raw.warning };
  }

  return readUnitJsonStream(response, charCount => updateUnitProgress(charCount, label, '请稍候，不要刷新页面', base));
}

/** 这一步要发给后端的额外参数（单课时要带 lessonNo） */
function unitStepPayload(step) {
  if (step.stage === 'lesson_single') {
    // 维度由系统排定（不是 AI 写的）—— 带上它，后端与前端两边都有兜底
    const planRow = unitCurrentLessonPlan().find(row => row.no === step.from);
    return { lessonNo: step.from, dimension: planRow ? planRow.dimension : '' };
  }
  if (step.stage === 'lessons') {
    // 同样带上维度：AI 不用再吐 ===DIMENSION===，这一课的归属由系统给
    const planRow = unitCurrentLessonPlan().find(row => row.no === step.from);
    return { startLesson: step.from, endLesson: step.to, dimension: planRow ? planRow.dimension : '' };
  }
  return {};
}

/**
 * 阶段返回的内容是不是「什么都没有」。
 * 纯文本阶段尤其要用它兜底：分隔符一个都没匹配上 = 这批内容全丢，
 * 得当作失败重试；而只丢了几段（其余都在）则不算失败 —— 那几段直接跳过即可。
 */
function unitStagePayloadEmpty(parsed, stage) {
  if (!parsed || typeof parsed !== 'object') return true;
  if (stage === 'lessons' || stage === 'lesson_single') {
    const lessons = Array.isArray(parsed.lessons) ? parsed.lessons : [];
    return !lessons.some(lesson => unitHasContent(lesson.content, lesson.method, lesson.objectives));
  }
  if (stage === 'rubric') {
    const rubric = parsed.rubric || {};
    const levels = Array.isArray(rubric.levels) ? rubric.levels.length : 0;
    const items = Array.isArray(rubric.scoreItems) ? rubric.scoreItems.length : 0;
    return !levels && !items && !String(rubric.note || '').trim();
  }
  const anyText = Object.entries(parsed)
    .filter(([key]) => key !== 'keyDifficulties')
    .some(([, value]) => String(value ?? '').trim());
  const difficulties = parsed.keyDifficulties || {};
  const anyDifficulty = Object.values(difficulties).some(value => String(value ?? '').trim());
  return !anyText && !anyDifficulty;
}

/**
 * 执行流水线中的一步（自带重试）。
 * 关键约定：只有【这一步】会被重试，前面已经成功合并的模块一律不动 —— 绝不推翻已有成果。
 *
 * 截断的响应会被算作"这一步没完成"：能抢救出半截内容时，先留着当兜底，
 * 重试成功就用完整内容覆盖；重试仍失败，就把抢救到的半截内容合并进去（总比丢掉强）。
 */
async function runUnitStep(step, selection, index, total) {
  const basePercent = Number.isFinite(step.basePercent)
    ? step.basePercent
    : Math.round(((index - 1) / total) * 100);
  const isText = step.format === 'text' || UNIT_TEXT_STAGES.includes(step.stage);
  let lastError = '';
  let salvaged = null;
  for (let attempt = 1; attempt <= UNIT_STAGE_RETRY; attempt += 1) {
    try {
      const result = await requestUnitStage(step.stage, selection, unitStageContext(), unitStepPayload(step), {
        label: step.progressLabel || `第 ${index}/${total} 步 · ${step.label}`,
        basePercent,
        format: isText ? 'text' : 'json',
      });
      const parsed = isText ? result.data : (result.data || recoverPartialUnitJSON(result.content));
      const empty = unitStagePayloadEmpty(parsed, step.stage);
      if (result.truncated) {
        // 半截输出：抢救出来的那部分先留着当兜底
        if (!empty) salvaged = parsed;
        lastError = '输出被截断';
      } else if (!empty) {
        return { ok: true, data: parsed };
      } else {
        lastError = isText ? '没匹配到任何分隔符（内容为空）' : '返回内容不是有效 JSON';
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < UNIT_STAGE_RETRY) {
      showUnitStatus(`${step.label} 失败（${lastError}），正在重试（第 ${attempt + 1} 次）…`, 'warning');
      await new Promise(resolve => setTimeout(resolve, 800 * attempt));
    }
  }
  // 重试仍失败：把抢救到的半截内容交出去，至少保住已经写好的部分
  if (salvaged) return { ok: true, data: salvaged, partial: true };
  return { ok: false, error: lastError };
}

/**
 * 18 个课时【严格串行】：for 循环 + await，一个请求彻底结束才发下一个。
 * ⚠️ 绝不用 Promise.all / worker 池 / 并发控制器 ——
 *    并发时多个响应的日志交错打印，本地服务与上游网关也容易成片 502 / "signal is aborted"。
 * 每一课拿到就立刻合并 + 落盘 + 局部渲染，课时表是一行一行填出来的。
 */
async function runUnitLessonGroup(lessons, selection) {
  const failures = [];
  let done = 0;
  for (let index = 0; index < lessons.length; index += 1) {
    const step = lessons[index];
    // eslint-disable-next-line no-await-in-loop  —— 这里要的就是严格串行，一个一个来
    const result = await runUnitStep(
      {
        ...step,
        progressLabel: `正在生成第 ${done + 1}/${lessons.length} 课时（第 ${step.no} 课次）`,
        basePercent: unitPhasePercent('lessons', done / lessons.length),
      },
      selection,
      done + 1,
      lessons.length,
    );
    if (result.ok) {
      mergeUnitStage(result.data, selection, 'lesson_single');
      // 生成一步存一步：只写本地，流水线结束再整份推云端
      saveUnitData({ silent: true, cloud: false, step: `第 ${step.no} 课时` });
      renderUnitModuleBlocks(['lessons']);       // 这一课立刻上屏
    } else {
      failures.push(`第 ${step.no} 课时：${result.error}`);
    }
    done += 1;
    setUnitLessonProgress(done, lessons.length, step.no);
  }
  return failures;
}

function closeUnitModals() {
  document.querySelectorAll('.modal-overlay').forEach(node => node.remove());
}

/**
 * 一键生成 —— 「按模块分步生成 + 前端自动拼装」的流水线（22 步）。
 *
 *   ① 前置分析（模块 1–5） ② 结构图（模块 6） ③ 18 课时严格串行（一次一课，await 完成再发下一个）
 *   ④ 收尾（模块 8–9） ⑤ 单元学习评价表（模块 10）
 *
 * 每次请求只吐一小块内容，输出量始终在模型的单次输出上限之内 —— 所以不会再出现 JSON 截断。
 * 每完成一步立刻合并 + 局部渲染 + 落盘：老师可以边等边看；
 * 某一步失败只重试那一步（UNIT_STAGE_RETRY 次），前面成功的模块一律保留。
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

  const steps = UNIT_PIPELINE;
  const failures = [];

  try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];

      // 课时阶段：18 个课时严格串行，一次一课，await 完成再发下一课
      if (step.group === 'lessons') {
        const lessonSteps = steps.filter(item => item.group === 'lessons');
        showUnitStatus('正在生成 18 课时计划表（模块 7）：严格串行，一次一课，完成一课再发下一课…', 'info');
        const lessonFailures = await runUnitLessonGroup(lessonSteps, selection);
        failures.push(...lessonFailures);
        index += lessonSteps.length - 1;
        continue;
      }

      setUnitProgress(unitPhasePercent(step.stage, 0), `正在生成${step.label}…`);
      showUnitStatus(`正在生成${step.label}…`, 'info');

      const result = await runUnitStep(step, selection, index + 1, steps.length);
      if (!result.ok) {
        // 只跳过这一步 —— 前面成功的模块保留，继续往下跑
        failures.push(`${step.label}：${result.error}`);
        continue;
      }
      mergeUnitStage(result.data, selection, step.stage);
      // ⚠️ 生成过程中【只写本地】：一轮生成有 20+ 步，每步都整份推云端必然把 /api/data 打爆（502）
      saveUnitData({ silent: true, cloud: false, step: step.label });
      renderUnitModuleBlocks(step.modules);      // 局部渲染：这一步的内容立刻可见
    }

    // 结构图节点没写全时，按课时表标题兜底补齐（不动老师的 canvas，只给默认归属）
    if (missingStructureNumbers(unitData).length) unitData = autoFillStructure(unitData);
    // 全部生成完毕 —— 这时才把成品一次性推上云端
    saveUnitData({ silent: true });
    renderUnitModules();

    const missingLessons = unitMissingLessonNumbers();
    const missingTail = unitTailMissing();
    const missingAnalysis = unitAnalysisMissing();
    if (missingLessons.length) {
      showUnitStatus(
        `第 ${missingLessons.join('、')} 课次缺失${failures.length ? `（${failures.join('；')}）` : ''}：`
        + '请点击模块 7 的【单独生成课时表】补全 —— 已生成的课时都在，不会被覆盖。',
        'warning',
      );
      showUnitTruncatedDialog(missingLessons, missingTail);
      showToast('课时表未生成完整，需单独补全', 'error');
    } else if (failures.length) {
      showUnitStatus(`✓ 10 个模块与 18 课时已全部生成并保存，但${failures.join('；')} —— 可在对应模块手工补写，或再点一次【一键生成】补齐。`, 'warning');
      showToast('生成完成，但有部分内容需要人工检查', 'error');
    } else if (missingAnalysis.length || missingTail.length) {
      const missing = [...missingAnalysis, ...missingTail];
      showUnitStatus(`✓ 18 课时齐全，但模块 ${missingTailLabel(missing)} 还缺内容（纯文本里没匹配到对应分隔符），可在相应面板手工补写。`, 'warning');
      showToast('生成完成，但有部分内容需要人工检查', 'error');
    } else {
      showUnitStatus('✓ 流水线完成：10 个模块 + 18 课时已全部生成并保存，请按教学实际复核。', 'success');
      showToast('大单元设计已生成', 'success');
    }
    syncUnitStore();     // 收尾：完整落盘 + 触发一次云端同步
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showUnitStatus(`生成失败：${message}`, 'error');
    showToast('生成失败，请查看上方提示', 'error');
  } finally {
    setUnitGeneratingState(false);
  }
}

/**
 * 流水线跑完：把最终结果完整落盘，并触发一次云端同步。
 * ⚠️ 成品写入由调用方的 saveUnitData({silent:true})（cloud=true）完成 ——
 *    这里【不再重复写一次】，否则收尾会连发两次一模一样的 POST /api/data。
 */
function syncUnitStore() {
  try {
    if (typeof Store !== 'undefined' && typeof Store.sync === 'function') Store.sync();
  } catch (error) {
    console.warn('大单元同步失败：', error);
  }
}

function missingTailLabel(missingTail) {
  const titles = {
    objectives: '1 教学目标', textbookAnalysis: '2 教材分析', studentAnalysis: '3 学情分析',
    teachingContent: '4 主要教学内容', keyDifficulties: '5 教学重难点',
    assessment: '8 考核与作业',
    reflection: '9 教学反思', rubric: '10 单元学习评价表',
  };
  return missingTail.map(id => titles[id] || id).join('、');
}

/** 仍有课次缺失时的弹窗：明确告诉老师缺哪几课次，并给出【补全】按钮 */
function showUnitTruncatedDialog(missingLessons, missingTail) {
  const batches = unitMissingRanges(missingLessons);
  const missingLabel = missingTail.length ? `，以及模块 ${missingTailLabel(missingTail)}` : '';
  const body = `
    <div class="ud2-placeholder">
      <div class="ud2-placeholder-icon">✂️</div>
      <h3>第 ${missingLessons.join('、')} 课次缺失</h3>
      <p>${missingLessons.map(no => `第 ${no} 课次`).join('、')}没有生成出来${missingLabel}。</p>
      <p>模型的<b>单次输出有上限</b>：18 个课时按严格串行、一次一课生成，个别课次仍可能失败 —— 这是模型侧限制，不是网络问题。</p>
      <p>已经生成的课时<b>都还在</b>，点【补全】只会补缺失的那几个，不会覆盖。</p>
      <hr style="margin:14px 0;border:none;border-top:1px solid var(--border, #e2e8f0)">
      <p>请点击【补全】：系统会按 <b>${batches.length} 小批</b>${batches.length
        ? `（${batches.map(batch => (batch.length === 1 ? `第${batch[0]}课` : `第${batch[0]}–${batch[batch.length - 1]}课`)).join('、')}）` : ''}
         逐课重新请求（严格串行，一次一课），不会再被截断${missingTail.length ? '，顺带补齐收尾模块' : ''}。</p>
    </div>`;
  showModal('第 ' + missingLessons.join('、') + ' 课次缺失，请点击【补全】按钮单独生成该课次', body, `
    <button class="btn btn-primary" type="button" onclick="generateLessonTableOnly()">补全</button>
    <button class="btn btn-ghost" type="button" onclick="closeModal()">稍后自己补</button>`);
}

/**
 * 【单独生成课时表】：只对"还缺内容的课时"发请求（严格串行，一次一课），
 * 最后再分别补齐模块 8–9 与模块 10。
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
  const failures = [];

  try {
    // 严格串行：一次只发 1 个请求；每个缺失课次各发一次
    const missingLessons = batches.flatMap(batch => batch);
    const lessonSteps = missingLessons.map(no => ({
      id: `lessons-${no}`, stage: 'lessons', group: 'lessons', from: no, to: no, no,
      label: `第 ${no} 课时`, modules: ['lessons'],
    }));
    showUnitStatus(`正在补生成 ${missingLessons.length} 个课次（严格串行，一次一课）…`, 'info');
    const lessonFailures = await runUnitLessonGroup(lessonSteps, selection);
    failures.push(...lessonFailures);
    if (unitClosingMissing().length) {
      setUnitProgress(unitPhasePercent('closing', 0), '正在生成收尾（模块 8–9）…');
      showUnitStatus('课时表已补齐，正在生成模块 8–9（考核与作业、教学反思）…', 'info');
      const closing = await requestUnitStage('closing', selection, unitStageContext(), {}, { label: '模块 8–9' });
      mergeUnitStage(closing.data || recoverPartialUnitJSON(closing.content) || {}, selection, 'closing');
      saveUnitData({ silent: true });
      renderUnitModuleBlocks(['assessment', 'reflection']);
    }
    if (unitRubricMissing().length) {
      setUnitProgress(unitPhasePercent('rubric', 0), '正在生成单元学习评价表（模块 10）…');
      showUnitStatus('正在生成模块 10（单元学习评价表）…', 'info');
      const rubric = await requestUnitStage('rubric', selection, unitStageContext(), {}, { label: '模块 10' });
      mergeUnitStage(rubric.data || recoverPartialUnitJSON(rubric.content) || {}, selection, 'rubric');
      saveUnitData({ silent: true });
      renderUnitModuleBlocks(['rubric']);
    }
    if (missingStructureNumbers(unitData).length) unitData = autoFillStructure(unitData);
    // 全部生成完毕 —— 这时才把成品一次性推上云端
    saveUnitData({ silent: true });
    renderUnitModules();
    syncUnitStore();

    const remain = unitMissingLessonNumbers();
    if (failures.length) {
      showUnitStatus(`部分课次没补上：${failures.join('；')} —— 请再点一次【补全】，或直接在模块 7 手工补写。`, 'warning');
    }
    if (remain.length) {
      showUnitStatus(`第 ${remain.join('、')} 课次缺失，请再次点击模块 7 的【单独生成课时表】补全（每批只剩一两个课时）；仍不行就在模块 7 手工补写。`, 'warning');
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
    // 被截断的半截 JSON：回退到最后一个安全截断点强制闭合，能救回多少算多少
    const repaired = recoverPartialUnitJSON(content);
    if (repaired && typeof repaired === 'object') {
      return {
        data: repaired,
        content,
        truncated: true,
        warning: warning || '输出被模型截断，已自动修复 JSON 并保留已生成的部分。',
      };
    }
    return { data: null, content, truncated: true, warning: warning || '内容解析失败或已被截断。' };
  }
}

/**
 * 读取【纯文本】阶段（analysis / rubric）的流式结果。
 *
 * 这两个阶段不再要求 JSON —— 模型直接按 ===分隔符=== 输出纯文本，
 * 所以这里只累计原文，交给上层用正则切分（切不出来的段落当作缺失，绝不抛异常）。
 */
async function readUnitTextStream(response, onDelta) {
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
  return { data: null, content, truncated, warning };
}

/**
 * JSON 被截断时尽力抢救（实现在 js/json-repair.js）：
 * 回退到最后一个"安全截断点"丢掉那半截字段，再按括号栈补闭合符 —— 比单纯补括号强得多。
 * 脚本没加载时退回最朴素的补括号写法，保证页面不白屏。
 */
function recoverPartialUnitJSON(content) {
  if (typeof repairTruncatedJSON === 'function') {
    try {
      return repairTruncatedJSON(content);
    } catch {
      return null;
    }
  }
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

/** 把一份「完整 10 模块」的 AI 结果一次性合并进来（分步生成以外的场景，如测试数据） */
function applyGeneratedUnit(generated, selection) {
  ['analysis', 'structure', 'lessons', 'closing', 'rubric'].forEach(stage => {
    mergeUnitStage(generated, selection, stage);
  });
}

function clearUnitDesign() {
  if (!window.confirm('确定要清空当前大单元内容吗？此操作会清掉已生成的 10 个模块与 18 课时。')) return;
  /* 🧹 唯一允许重新载入的例外：用户亲手点【清空重来】 */
  unitExplicitReset = true;
  unitReadyHandled = false;
  unitViewPriority = null;
  const selection = unitData.meta;
  unitData = createEmptyUnit();
  // 清空 = 与本页脱钩：不再写回之前绑定的离线资源（那条资源本身还留在库里，不会被删）
  unitData.meta = { ...selection, generatedAt: '', resourceId: '' };
  unitExpanded.clear();
  // 分步物理备份也要清掉，否则下次加载会把刚清空的内容"补"回来
  try { localStorage.removeItem(UNIT_STEP_BACKUP_KEY); } catch (error) { /* 忽略 */ }
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

/**
 * 熔断自愈：之前 502 连续失败 3 次会把 pe_offline_resources_v1 锁死（_failedWrites），
 * 刷新后也不再自动补推。这里在【保存成功】与【页面初始化】各试一次：
 * 只在确实存在熔断键时调 Store.retryFailedKeys()，避免每次同步都重推，且只做一次。
 */
let unitStoreRecovered = false;
function autoRecoverStoreCircuit(reason = '') {
  if (unitStoreRecovered) return;
  if (typeof Store === 'undefined' || typeof Store.retryFailedKeys !== 'function') return;
  const failed = typeof Store.getFailedWrites === 'function' ? Store.getFailedWrites() : [];
  if (!Array.isArray(failed) || !failed.length) return;
  unitStoreRecovered = true;
  console.warn(`[大单元] 🔄 检测到 ${failed.length} 个被熔断的键（${failed.map(item => item.key).join('、')}），`
    + `自动重推（${reason}）。也可以在控制台手动执行 Store.retryFailedKeys()。`);
  Promise.resolve(Store.retryFailedKeys())
    .then(report => console.log('[大单元] ✅ 熔断恢复完成', report))
    .catch(error => console.warn('[大单元] ⚠️ 熔断重推未成功，可稍后在控制台执行 Store.retryFailedKeys()', error));
}

/**
 * ✅ 保存到离线资源库成功后：把【资源库里那份完全相同的数据】强制同步进 pe_big_unit_design_v1。
 * 以前这里走 saveUnitData() → unitSavePayload() 的裁剪版，长模块会被 clip 成半截，
 * 主键与资源库从此不一致；切回 Tab 时读到半截主键，完整视图就"消失"了。
 * 现在：
 *   ① OfflineResources.unitFromRecord(record) 还原出与【载入】一模一样的完整 unit；
 *   ② Store.write 立刻写内存缓存 + localStorage 主键，并发起云端 POST；
 *   ③ Store.commitView 再硬写一次缓存 / 主键（绕过任何合并），保持 userModified 视图锁；
 *   ④ 同步刷新分步物理备份，绝不留下旧半截备份。
 */
function syncUnitKeyWithResource(record, reason = '保存到离线资源库') {
  const payload = (typeof OfflineResources !== 'undefined'
    && typeof OfflineResources.unitFromRecord === 'function'
    ? OfflineResources.unitFromRecord(record) : null) || unitData;
  if (typeof Store !== 'undefined') {
    /* 用户主动点保存 = 明确的云端写入指令：先退出【加载离线资源】留下的静默本地模式，
       否则这次 POST 会被静默态 / cloudState=off 短路，云端仍停在旧半截数据上。 */
    if (typeof Store.exitQuietLocalMode === 'function') Store.exitQuietLocalMode();
    /* 强制云端写入：writeCritical 不受 cloudState=off 影响，直接 await /api/data 确认；
       失败不弹红框，数据完整留在本机，由保护锁在网络恢复后自动续传。 */
    if (typeof Store.writeCritical === 'function') {
      Promise.resolve(Store.writeCritical(UNIT_STORAGE_KEY, payload, { label: reason }))
        .then(result => console.log(`[大单元] ✅ ${reason}：云端写入${result?.ok ? '已确认' : '未完成（完整数据已留本机）'}`))
        .catch(error => console.warn(`[大单元] ⚠️ ${reason}：云端写入失败，完整数据保留在本机`, error));
    } else if (typeof Store.write === 'function') {
      Store.write(UNIT_STORAGE_KEY, payload);
    }
    if (typeof Store.commitView === 'function') {
      Store.commitView(UNIT_STORAGE_KEY, payload, { userModified: true, reason });
    }
  }
  writeUnitStepBackup(payload, reason);
  console.log(`[大单元] ✅ ${reason}：已强制同步 pe_big_unit_design_v1`
    + '（Store 内存缓存 + localStorage 主键 + 云端写入 + 分步备份），与离线资源库数据绝对一致');
  return payload;
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

  /* ② 极限裁剪：深拷贝一份纯成品数据再交给 Store / 资源库，
        剔除 id、createdAt、rawFallback 等中间状态、空模块、结构图长文本。
        真正推给 pe_offline_resources_v1 的是整份列表，OfflineResources.writeList 还会再裁一次。 */
  const cleanUnit = typeof unitCompactForStorage === 'function'
    ? unitCompactForStorage(unitData)
    : JSON.parse(JSON.stringify(unitData));

  /* ④ 诊断日志 + 4MB 主动拦截（Vercel 平台自身约 4.5MB 硬限制，代码绕不过去） */
  const bytes = typeof unitPayloadBytes === 'function'
    ? unitPayloadBytes(cleanUnit) : JSON.stringify(cleanUnit).length;
  const limit = typeof UNIT_RESOURCE_PAYLOAD_LIMIT === 'number'
    ? UNIT_RESOURCE_PAYLOAD_LIMIT : 4 * 1024 * 1024;
  const rawBytes = typeof unitPayloadBytes === 'function'
    ? unitPayloadBytes(unitData) : JSON.stringify(unitData).length;
  console.log('[大单元] Payload 大小:', (bytes / 1024).toFixed(1), 'KB',
    `（裁剪前 ${(rawBytes / 1024).toFixed(1)} KB，阈值 ${(limit / 1024 / 1024).toFixed(0)}MB）`);
  if (bytes > limit) {
    console.warn('[大单元] ⛔ Payload 超过 4MB，已主动拦截本次保存，避免网关 502 与 Store 熔断。');
    showUnitStatus('这份大单元超过 4MB，已阻止保存；请先精简过长的课时文本再试。', 'error');
    showToast('数据超过 4MB，已阻止保存以免同步失败', 'error');
    return;
  }

  const source = unitData.meta.generatedAt ? 'ai' : 'manual';
  const result = OfflineResources.saveUnit(cleanUnit, { source });
  if (!result.ok) {
    showUnitStatus(`保存失败：${result.reason || '未知原因'}`, 'error');
    return;
  }
  unitData.meta.resourceId = result.record.id;
  unitData.meta.source = result.record.source;
  /* ✅ 关键修复：把【资源库那份完整数据】强制同步进主键（缓存 + 本地 + 云端），
     不再用 unitSavePayload() 的裁剪版，保证主键与资源库绝对一致。 */
  syncUnitKeyWithResource(result.record);
  renderUnitModules();
  showUnitStatus(
    `✓ 已${result.created ? '新建' : '更新'}离线资源：${result.record.content || result.record.id}`
    + '。数据已存在本机，断网也能查看；联网后会自动同步到 Supabase。',
    'success',
  );
  // ③ 保存成功 → 顺手把之前 502 熔断的键解锁重推
  autoRecoverStoreCircuit('保存成功后');
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
  /* 🛑 先撤掉上一轮编辑的 800ms 防抖：它拿着编辑前的 unitData，
     800ms 后会用旧视图把刚选中的资源写回资源库 —— 最隐蔽的一条覆盖链。 */
  if (unitResourceSyncTimer) { clearTimeout(unitResourceSyncTimer); unitResourceSyncTimer = null; }
  /* 🤫 绝对隔离：点击选中的那一刻就进入静默本地模式。
     ① 立刻 abort 所有在飞的 GET /api/data，不等 20 秒超时弹错误；
     ② 期间不发云端请求、不重连、不弹超时，云端拉取失败也安静回退本地缓存；
     ③ 本函数全程只读 localStorage + 写 DOM，没有任何网络请求，到期自动恢复。 */
  if (typeof Store !== 'undefined' && typeof Store.enterQuietLocalMode === 'function') {
    try { Store.enterQuietLocalMode('加载离线资源', 10000); } catch (error) { /* 不影响本地载入 */ }
  }
  /* 🌐 把历史积压（旧 502 留下的过期脏数据）延期隔离：
     只移出「自动重推队列」，业务数据与保护锁完整保留，连定时器一起停掉。
     网络恢复触发 online 事件时 Store.handleOnline() 会自动放回队列续传。 */
  if (typeof Store !== 'undefined' && typeof Store.deferPendingQueue === 'function') {
    try { Store.deferPendingQueue('加载离线资源', 30 * 1000); } catch (error) { /* 不影响本地载入 */ }
  }
  const unit = OfflineResources.unitFromRecord(record);
  if (!unit) {
    showUnitStatus('这条离线资源的数据已损坏，无法载入。', 'error');
    return;
  }
  /* ⏸ 载入期间暂停所有后台上传重试：旧队列的补推 POST 不能和这次填充抢同一个请求闸门。
     release 放在 finally 里，哪怕渲染抛错也一定恢复，绝不把 Store 永久冻住。 */
  const release = typeof Store !== 'undefined' && typeof Store.pauseBackgroundSync === 'function'
    ? Store.pauseBackgroundSync('加载离线资源')
    : null;
  try {
    unitData = unit;
    unitReadyHandled = true;      // 载入即锁定当前视图，之后任何 store:sync 都不许重赋值
    unitExplicitReset = false;
    /* 🔒 视图最高优先级：把刚载入的资源钉在 Store 主键上。
       之后云端旧快照、后台同步、未确认锁、其它 iframe 的旧缓存都盖不掉它；
       store:sync 触发的 onReady 重绘也会跳过（见文件末尾）。 */
    unitViewPriority = { at: Date.now(), reason: '从离线资源库加载', id: record?.id || '' };
    if (typeof Store !== 'undefined' && typeof Store.pinLocalView === 'function') {
      try {
        /* userModified:true = 最高级别标记：刷新后任何时光机备份 / 云端旧快照都不许覆盖这份数据 */
        const pinned = Store.pinLocalView(UNIT_STORAGE_KEY, unit, '从离线资源库加载', { userModified: true });
        unitViewPriority.epoch = pinned?.epoch || 0;
      } catch (error) {
        console.warn('[大单元] 视图优先级锁写入失败（不影响本机载入）', error);
      }
    }
    unitExpanded.clear();
    unitExpanded.add('structure');
    unitExpanded.add('lessons');
    /* 只更新本地视图：cloud:false 仅写 localStorage 与物理备份，绝不推 /api/data。
       以前这里用默认的 cloud:true，一载入就往云端写整份大单元 —— 加载动作不该写云端，
       更不该覆盖当前正在编辑的数据。要同步由用户手动点保存。 */
    saveUnitData({ silent: true, cloud: false });
    populateUnitSelectors();          // 把选题回填到三个下拉框
    renderUnitModules();
    showUnitStatus(
      `✓ 已从离线资源库载入「${unit.unitTitle || record.content || record.id}」（未调用 AI）。`
      + '仅载入到本机视图，已锁定为最高优先级（后台旧数据不会覆盖）；确认无误后手动保存即可。',
      'success',
    );
    showToast('已从离线资源库载入（未写云端）', 'success');
  } finally {
    if (release) release();
  }
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
  if (path.startsWith('structure_nodes.')) {
    unitMatrixAutoSize(event.target);
    queueUnitMatrixRedraw();
  }
});

/** 节点换维度 → 节点要挪到别的泳道去，必须整体重画 */
document.addEventListener('change', event => {
  const target = event.target;
  if (!target?.classList?.contains('ud2-mx-node-dim')) return;
  saveUnitData({ silent: true });
  queueResourceSync();
  renderUnitModules();
});

/** 窗口尺寸变了 → 结构图的连线要跟着重画 */
let unitMatrixResizeTimer = null;
window.addEventListener('resize', () => {
  if (unitMatrixResizeTimer) clearTimeout(unitMatrixResizeTimer);
  unitMatrixResizeTimer = setTimeout(unitMatrixDrawLinks, 150);
});

/** 生成途中直接关标签页 → 立刻解冻，别让其它页面白等 60 分钟的 TTL */
window.addEventListener('beforeunload', () => {
  if (unitGenerating && typeof Store !== 'undefined' && typeof Store.setGenerating === 'function') {
    try { Store.setGenerating(false, '页面关闭'); } catch (error) { /* 忽略 */ }
  }
});

/* ---------------- 🛑 切页 / Tab 切换：绝不重载当前视图 ---------------- */
/**
 * 切到「离线资源库」再切回来时，页面可能重新可见（bfcache / iframe 聚焦），
 * 也可能整个文档重建。无论哪种，只要当前 unitData 已有内容，
 * 就不许再从本地 / 云端 loadUnitData() 覆盖它。
 * 下面三个事件只做拦截与日志，真正的载入统一交给 Store.onReady 的首次回调。
 */
window.addEventListener('visibilitychange', () => {
  if (typeof document !== 'undefined' && document.hidden) return;
  guardTabSwitchReload('visibilitychange → 页面重新可见');
});
window.addEventListener('pageshow', () => guardTabSwitchReload('pageshow → 切回页面'));
window.addEventListener('focus', () => guardTabSwitchReload('focus → 窗口重新聚焦'));

Store.onReady(() => {
  /* 🔒 切页诈尸的总闸门：本页已经载入过视图、且 unitData 非空时，
     任何 store:sync（云端同步 / 后台补推 / 兄弟 iframe 旧缓存）都不许重新赋值 unitData。
     判定不依赖页内变量，持久化视图锁（Store.isViewPinned）跨页面重建仍生效。 */
  if (unitReadyHandled && unitViewHasContent() && !unitExplicitReset) {
    console.log(`[大单元] 🔒 当前视图已有数据${isUnitViewPinned() ? '，且视图优先级锁仍锁定' : ''}`
      + '：忽略 store:sync 重绘，不重新 loadUnitData()、不重新赋值 unitData');
    return;
  }
  if (unitExplicitReset) unitExplicitReset = false;
  unitReadyHandled = true;
  /* 切回 Tab（页面重建）：只要持久化视图锁还在，就【绝不调用 loadUnitData()】，
     直接从已被 syncUnitKeyWithResource() 写完整的主键恢复完整视图。 */
  if (unitHasPersistedViewPin() || isUnitViewPinned()) {
    unitData = normalizeUnit(Store.read(UNIT_STORAGE_KEY, null) || createEmptyUnit());
    console.log('[大单元] 🔒 切回页面：直接从受保护主键恢复完整视图，'
      + '不调用 loadUnitData()；视图优先级锁保持锁定');
  } else {
    unitData = loadUnitData();
  }
  populateUnitSelectors();
  // 幂等性：资源库页点【编辑】会带上 ?resource=xx，这里直接把那份资源载进来
  if (!loadUnitFromUrl()) renderUnitModules();
  // ③ 页面初始化也自愈一次：之前 502 熔断锁死的键在这里自动解锁重推
  autoRecoverStoreCircuit('页面初始化');
});
