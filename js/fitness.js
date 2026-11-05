/**
 * 体测数据模块
 * 成绩录入、成绩册、可视化看板、成绩排名
 *
 * ⚠️ 本模块【不再依赖任何学生名单表】：
 *    每一条体测记录自带 姓名 / 性别 / 年级 / 班级，
 *    学生名册由记录派生（DB.getFitnessStudents()），
 *    导入 Excel 时直接读表里的信息，不存在"找不到学生"的错误。
 */

let fitnessView = 'records'; // records | dashboard | ranking
let fitnessCharts = {};

Layout.init('fitness', '体测数据', '体测数据');

const content = document.getElementById('page-content');

const records = DB.getFitnessRecords();

// 统计摘要（性别 / 年级都从记录自带字段取，不再反查任何名单）
const totalRecords = records.length;
const excellentCount = records.filter(r =>
  DB.getGrade(r.value, r.testType, r.gender, r.grade).level === '优秀').length;
const needAttention = records.filter(r =>
  ['不及格', '偏胖', '肥胖'].includes(DB.getGrade(r.value, r.testType, r.gender, r.grade).level)).length;

content.innerHTML = `
  <div class="page-header">
    <div>
      <h1>学生体测数据</h1>
      <p>成绩录入、成绩册、可视化看板与成绩排名</p>
    </div>
    <div style="display:flex;gap:8px;">
      <button data-admin-only class="btn btn-secondary" onclick="openBatchImport()">
        <span>📥</span> 批量录入
      </button>
      <button data-admin-only class="btn btn-secondary" onclick="openQuickEntry()">
        <span>⌨️</span> 快捷录入
      </button>
      <button data-admin-only class="btn btn-primary" onclick="openAddRecord()">
        <span>📝</span> 录入成绩
      </button>
      <button data-admin-only class="btn btn-danger fitness-purge-btn" onclick="requestFitnessPurge()"
        title="清空全部体测成绩记录（本地 + 云端），不影响教案、课表等其它数据">
        <span>🗑️</span> 清空体测数据
      </button>
    </div>
  </div>

  <!-- 统计卡片 -->
  <div class="grid grid-3" style="margin-bottom:24px;">
    <div class="stat-card fade-in fade-in-delay-1">
      <div class="stat-icon" style="background:var(--primary-100);color:var(--primary);">📋</div>
      <div class="stat-content">
        <h3 id="fitnessTotalRecords">${totalRecords}</h3>
        <p>总记录数</p>
      </div>
    </div>
    <div class="stat-card fade-in fade-in-delay-2">
      <div class="stat-icon" style="background:var(--success-light);color:var(--success);">🏆</div>
      <div class="stat-content">
        <h3 id="fitnessExcellentCount">${excellentCount}</h3>
        <p>优秀成绩</p>
      </div>
    </div>
    <div class="stat-card fade-in fade-in-delay-3">
      <div class="stat-icon" style="background:var(--danger-light);color:var(--danger);">⚠️</div>
      <div class="stat-content">
        <h3 id="fitnessAttentionCount">${needAttention}</h3>
        <p>需关注</p>
      </div>
    </div>
  </div>

  <!-- 视图切换 -->
  <div class="toolbar">
    <div class="toolbar-left">
      <div class="segmented" id="viewSwitch">
        <button data-view="records" class="${fitnessView === 'records' ? 'active' : ''}" onclick="switchView('records')">成绩列表</button>
        <button data-view="dashboard" class="${fitnessView === 'dashboard' ? 'active' : ''}" onclick="switchView('dashboard')">统计分析看板</button>
        <button data-view="ranking" class="${fitnessView === 'ranking' ? 'active' : ''}" onclick="switchView('ranking')">成绩排名</button>
      </div>
    </div>
    <div class="toolbar-right" id="filterArea"></div>
  </div>

  <!-- 内容区 -->
  <div id="fitnessContent"></div>
`;

Store.onReady(() => {
  renderView();
  updateFitnessSummaryCards();
});

function updateFitnessSummaryCards() {
  const latestRecords = DB.getFitnessRecords();
  const excellent = latestRecords.filter(record =>
    DB.getGrade(record.value, record.testType, record.gender, record.grade).level === '优秀').length;
  const attention = latestRecords.filter(record =>
    ['不及格', '偏胖', '肥胖'].includes(DB.getGrade(record.value, record.testType, record.gender, record.grade).level)).length;
  document.getElementById('fitnessTotalRecords').textContent = latestRecords.length;
  document.getElementById('fitnessExcellentCount').textContent = excellent;
  document.getElementById('fitnessAttentionCount').textContent = attention;
}

function refreshFitnessDataViews() {
  updateFitnessSummaryCards();
  // 看板：只刷新数据（setOption 重绘），不重建图表实例，切换更顺滑
  if (fitnessView === 'dashboard' && typeof updateFitnessDashboard === 'function') {
    updateFitnessDashboard();
    return;
  }
  renderView();
}

function switchView(view) {
  fitnessView = view;
  // 更新按钮
  document.querySelectorAll('#viewSwitch button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  // 离开看板时把 ECharts 实例释放掉（DOM 已经被换掉，留着只会占内存）
  if (view !== 'dashboard' && typeof destroyFitnessDashboardCharts === 'function') {
    destroyFitnessDashboardCharts();
  }
  // 成绩册上方的弱项分布图同理
  if (view !== 'records' && typeof destroyFitnessWeakChart === 'function') {
    destroyFitnessWeakChart();
  }
  renderView();
}

function renderView() {
  if (fitnessView === 'records') {
    renderRecordsView();                     // 成绩列表 / 成绩册（js/fitness-gradebook.js）
  } else if (fitnessView === 'dashboard') {
    renderFitnessDashboard();                // 统计分析看板（js/fitness-dashboard.js · ECharts）
  } else if (typeof renderRankingView === 'function') {
    renderRankingView();                     // 成绩排名（js/fitness-ranking.js）
  }
}

// ===== 清空体测数据（本地 + 云端，一次清干净）=====
const FITNESS_PURGE_CONFIRM_TEXT = 'DELETE';
const FITNESS_PURGE_KEY = 'pe_fitness_records';
let fitnessPurgePendingCount = 0;

/**
 * 打开确认弹窗：必须手动输入 DELETE 才允许执行。
 * 弹窗里写清楚"清什么、不清什么"，避免老师以为会把其它数据一起删掉。
 */
function requestFitnessPurge() {
  fitnessPurgePendingCount = DB.getFitnessRecords().length;
  showModal(
    '🗑️ 清空全部体测数据',
    `<div class="fitness-purge">
       <p class="fitness-purge-warn">此操作<b>不可恢复</b>，将删除全部 <b>${fitnessPurgePendingCount}</b> 条体测成绩记录。</p>
       <ul class="fitness-purge-list">
         <li><b>本地</b><span>内存缓存 + localStorage 镜像 + 保护锁 + 本地备份</span></li>
         <li><b>云端</b><span>Supabase 体测数据表（整表清空）</span></li>
       </ul>
       <p class="fitness-purge-safe">✔ 只清体测数据：教案、课表、考勤、运动会报名等其它数据一律不动。</p>
       <p>确定请手动输入 <code>DELETE</code> 后再点红色按钮：</p>
       <input id="fitnessPurgeConfirm" class="fitness-purge-input" type="text" autocomplete="off"
         placeholder="输入 DELETE" aria-label="输入 DELETE 以确认清空体测数据">
     </div>`,
    `<button class="btn btn-secondary" onclick="closeModal(this)">取消</button>
     <button class="btn btn-danger" onclick="confirmFitnessPurge(this)">我确认，彻底清空</button>`,
  );
  document.getElementById('fitnessPurgeConfirm')?.focus();
}

/**
 * 真正执行清空：走 Store.clearKey() 专属通道
 * （内存 → localStorage → 备份 → 防覆盖锁 → 云端，且不会触发"反推自愈"）。
 */
async function confirmFitnessPurge(button) {
  const input = document.getElementById('fitnessPurgeConfirm');
  if (input?.value.trim() !== FITNESS_PURGE_CONFIRM_TEXT) {
    showToast('请输入 DELETE 以确认清空', 'error');
    input?.focus();
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = '正在清空…';
  }
  try {
    const result = await Store.clearKey(FITNESS_PURGE_KEY, { label: '体测数据' });
    const closeBtn = document.querySelector('.modal-close');
    if (closeBtn) closeModal(closeBtn);
    if (result.cloudCleared) {
      showToast(`已清空体测数据（本地 + 云端，共 ${fitnessPurgePendingCount} 条）`, 'success');
    } else if (result.cloudSkipped) {
      showToast(`本地体测数据已清空；${result.error || '当前未连接云端，没有云端数据可清'}`, 'error');
    } else {
      showToast(`本地体测数据已清空，但云端清空失败（${result.error || '未知原因'}）；`
        + '后台会自动补清，也请联网后再点一次清空按钮', 'error');
    }
    refreshFitnessDataViews();
  } catch (error) {
    console.error('清空体测数据失败', error);
    if (button) {
      button.disabled = false;
      button.textContent = '我确认，彻底清空';
    }
    showToast(`清空失败：${error?.message || error}`, 'error');
  }
}

// ===== 成绩列表视图（紧凑成绩册）=====
/**
 * 成绩列表 = 一张紧凑的成绩册：
 *   上方是【各项目弱项分布】图（随年级 / 班级联动），
 *   下方是成绩册表格（一行一个学生，一格一个项目：上成绩、下得分）。
 */
function renderRecordsView() {
  const filterArea = document.getElementById('filterArea');
  const grades = [...new Set(DB.getFitnessStudents().map(student => student.grade).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));

  filterArea.innerHTML = `
    <div class="search-box">
      <span>🔍</span>
      <input type="text" placeholder="搜索学生..." id="recordSearch"
        value="${escapeFitnessHTML(FITNESS_GRADEBOOK_STATE.search)}"
        oninput="onFitnessRecordsSearch(this.value)">
    </div>
    <select class="form-control" style="width:auto;" id="recordsGradeFilter" aria-label="筛选年级"
      onchange="onFitnessRecordsGradeChange()">
      <option value="all">全部年级</option>
      ${grades.map(grade => `<option value="${escapeFitnessHTML(grade)}" ${FITNESS_GRADEBOOK_STATE.grade === grade ? 'selected' : ''}>${escapeFitnessHTML(grade)}</option>`).join('')}
    </select>
    <select class="form-control" style="width:auto;" id="recordsClassFilter" aria-label="筛选班级"
      onchange="onFitnessRecordsClassChange()">
      <option value="all">全部班级</option>
    </select>
    <button class="btn btn-secondary btn-sm" type="button" onclick="exportFitnessRecordsExcel()">⬇️ Excel</button>
    <button class="btn btn-secondary btn-sm" type="button" onclick="exportFitnessRecordsCsv()">⬇️ CSV</button>
    <button class="btn btn-success btn-sm" type="button" onclick="printFitnessPage('records')"
      title="把当前筛选范围的成绩册打印成 A4 横向表格">🖨️ 打印当前页面</button>
  `;

  const container = document.getElementById('fitnessContent');
  container.innerHTML = `
    <div class="card fade-in">
      <div class="card-header">
        <div>
          <div class="card-title"><span>📊</span> 各项目弱项分布</div>
          <div class="card-subtitle" id="fitnessWeakNote">未达标 = 得分不到 60 分；拖后腿 = 60~79 分且比本人平均分低 8 分以上</div>
        </div>
      </div>
      <div class="card-body">
        <div class="fitness-weak-chart" id="fitnessWeakChart"></div>
      </div>
    </div>

    <div class="card fade-in">
      <div class="card-header">
        <div>
          <div class="card-title"><span>📋</span> 体测成绩册</div>
          <div class="card-subtitle" id="recordsScopeText"></div>
        </div>
      </div>
      <div class="card-body" style="padding:0;">
        <div id="recordsTableWrap"></div>
      </div>
    </div>
  `;

  populateFitnessRecordsClassFilter();
  renderRecordsTable();
}

/** 成绩列表主体（成绩册 + 上方的弱项分布图一起刷新） */
function renderRecordsTable() {
  const wrap = document.getElementById('recordsTableWrap');
  if (wrap) {
    wrap.innerHTML = renderFitnessGradebookTable();
    updateFitnessRecordsScope();
  }
  if (typeof updateFitnessWeakChart === 'function') updateFitnessWeakChart();
}

/** 顶部说明：当前范围 + 统计小结 */
function updateFitnessRecordsScope() {
  const target = document.getElementById('recordsScopeText');
  if (!target) return;
  const state = FITNESS_GRADEBOOK_STATE;
  const gradeText = state.grade === 'all' ? '全部年级' : state.grade;
  const classText = state.className === 'all' ? '全部班级' : state.className;
  const data = fitnessGradebookBuild();
  const weakCount = data.rows.filter(row => row.hasWeak).length;
  const scored = data.rows.filter(row => row.total.total !== null && row.total.total !== undefined);
  const average = scored.length
    ? (scored.reduce((sum, row) => sum + row.total.total, 0) / scored.length).toFixed(1)
    : '—';
  target.textContent = `${gradeText} · ${classText} · ${data.rows.length} 名学生 · 平均 ${average} 分 · ${weakCount} 人有弱项`;
}

/** 年级变了 → 班级跟着重选 */
function populateFitnessRecordsClassFilter() {
  const select = document.getElementById('recordsClassFilter');
  if (!select) return;
  const state = FITNESS_GRADEBOOK_STATE;
  const classes = [...new Set(DB.getFitnessStudents()
    .filter(student => state.grade === 'all' || student.grade === state.grade)
    .map(student => student.class).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  select.innerHTML = '<option value="all">全部班级</option>'
    + classes.map(className => `<option value="${escapeFitnessHTML(className)}" ${state.className === className ? 'selected' : ''}>${escapeFitnessHTML(className)}</option>`).join('');
  if (!classes.includes(state.className)) {
    state.className = 'all';
    select.value = 'all';
  }
}

function onFitnessRecordsSearch(value) {
  FITNESS_GRADEBOOK_STATE.search = value || '';
  renderRecordsTable();
}

function onFitnessRecordsGradeChange() {
  FITNESS_GRADEBOOK_STATE.grade = document.getElementById('recordsGradeFilter')?.value || 'all';
  FITNESS_GRADEBOOK_STATE.className = 'all';
  populateFitnessRecordsClassFilter();
  renderRecordsTable();
}

function onFitnessRecordsClassChange() {
  FITNESS_GRADEBOOK_STATE.className = document.getElementById('recordsClassFilter')?.value || 'all';
  renderRecordsTable();
}

function deleteRecord(id) {
  DB.deleteFitnessRecord(id);
  refreshFitnessDataViews();
  showToast('记录已删除');
}

// ===== 录入成绩 =====

/** 可选的年级（与国标 1~6 年级一致） */
const FITNESS_GRADE_OPTIONS = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];

/**
 * 录入单条成绩。
 * 没有学生名单了 → 老师直接填姓名 / 性别 / 年级 / 班级，
 * 系统用「姓名+班级+年级」算出内部 id，同一个学生多次录入会自动归到同一个人。
 */
function openAddRecord() {
  const knownStudents = DB.getFitnessStudents();
  const knownClasses = [...new Set(knownStudents.map(student => student.class).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));

  const bodyHTML = `
    <form id="recordForm" onsubmit="return false;">
      <div class="form-row">
        <div class="form-group">
          <label>姓名 <span class="required">*</span></label>
          <input class="form-control" type="text" name="studentName" id="studentNameInput"
            list="fitnessKnownStudents" required placeholder="输入学生姓名" autocomplete="off">
          <datalist id="fitnessKnownStudents">
            ${knownStudents.map(student => `<option value="${escapeFitnessHTML(student.name)}">${escapeFitnessHTML(student.grade)}${escapeFitnessHTML(student.class)}</option>`).join('')}
          </datalist>
        </div>
        <div class="form-group">
          <label>性别 <span class="required">*</span></label>
          <select class="form-control" name="gender" id="studentGenderInput" required>
            <option value="男">男</option>
            <option value="女">女</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>年级 <span class="required">*</span></label>
          <select class="form-control" name="grade" id="studentGradeInput" required>
            ${FITNESS_GRADE_OPTIONS.map(grade => `<option value="${grade}">${grade}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>班级 <span class="required">*</span></label>
          <input class="form-control" type="text" name="className" id="studentClassInput"
            list="fitnessKnownClasses" required placeholder="如：1班" autocomplete="off">
          <datalist id="fitnessKnownClasses">
            ${knownClasses.map(className => `<option value="${escapeFitnessHTML(className)}"></option>`).join('')}
          </datalist>
        </div>
      </div>
      <div class="form-group">
        <label>测试项目 <span class="required">*</span></label>
        <select class="form-control" name="testType" id="testTypeSelect" required onchange="onTestTypeChange()">
          ${DB.FITNESS_ITEMS.map(t => `<option value="${t.key}">${t.icon} ${t.name}${t.unit ? ' (' + t.unit + ')' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>成绩 <span class="required">*</span></label>
          <input class="form-control" type="number" step="0.01" name="value" id="valueInput" required placeholder="输入成绩">
          <small id="unitHint" style="color:var(--text-tertiary);font-size:12px;"></small>
        </div>
        <div class="form-group">
          <label>测试日期 <span class="required">*</span></label>
          <input class="form-control" type="date" name="testDate" id="testDateInput" required>
        </div>
      </div>
      <div class="form-group">
        <label>学期</label>
        <select class="form-control" name="semester">
          <option value="2026秋">2026秋</option>
          <option value="2027春">2027春</option>
        </select>
      </div>
      <div id="gradePreview" style="display:none;margin-top:12px;padding:12px;border-radius:var(--radius-sm);background:var(--bg-hover);">
        <span style="font-size:14px;">预估等级：</span><span id="gradeBadge"></span>
      </div>
    </form>
  `;
  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="saveRecord()">保存</button>
  `;
  showModal('录入体测成绩', bodyHTML, footerHTML);

  // 默认今天日期
  const today = new Date();
  document.getElementById('testDateInput').value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  onTestTypeChange();
}

function openQuickEntry() {
  const knownStudents = DB.getFitnessStudents();
  const grades = [...new Set(knownStudents.map(student => student.grade).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  const gradeOptions = grades.map(grade => `<option value="${escapeFitnessHTML(grade)}">${escapeFitnessHTML(grade)}</option>`).join('');
  const classOptions = [...new Set(knownStudents.map(student => student.class))]
    .filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
    .map(className => `<option value="${escapeFitnessHTML(className)}">${escapeFitnessHTML(className)}</option>`).join('');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label for="quickEntryGrade">年级</label>
        <select class="form-control" id="quickEntryGrade" onchange="renderQuickEntryRoster()">
          <option value="">选择年级</option>${gradeOptions}
        </select>
      </div>
      <div class="form-group">
        <label for="quickEntryClass">班级</label>
        <select class="form-control" id="quickEntryClass" onchange="renderQuickEntryRoster()">
          <option value="">选择班级</option>${classOptions}
        </select>
      </div>
      <div class="form-group">
        <label for="quickEntryTestType">测试项目</label>
        <select class="form-control" id="quickEntryTestType" onchange="renderQuickEntryRoster()">
          ${DB.FITNESS_ITEMS.filter(item => !['height', 'weight'].includes(item.key))
    .map(item => `<option value="${item.key}">${item.icon} ${escapeFitnessHTML(item.name)}${item.unit ? `（${escapeFitnessHTML(item.unit)}）` : ''}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label for="quickEntryDate">测试日期</label>
        <input class="form-control" type="date" id="quickEntryDate" value="${todayStr}">
      </div>
      <div class="form-group">
        <label for="quickEntrySemester">学期</label>
        <input class="form-control" id="quickEntrySemester" placeholder="如：2026秋">
      </div>
    </div>
    <p class="fitness-quick-entry-hint">成绩框按学生顺序排列，输入成绩后按 Tab 即可进入下一位学生。</p>
    <div id="quickEntryRoster"></div>
  `;
  showModal('班级体测快捷录入', bodyHTML, `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="saveQuickEntry()">保存本班成绩</button>
  `);
}

function escapeFitnessHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function getFitnessScoringFields(value, testType, student) {
  const grade = DB.getGrade(value, testType, student.gender, student.grade);
  const score = DB.getFitnessScore(value, testType, student.gender, student.grade);
  return {
    gradeLevel: grade.level,
    gradeClass: grade.class,
    score: score?.score ?? null,
    scoreBonus: score?.bonus ?? 0,
    standardVersion: score ? '2014年修订版' : null,
  };
}

function isFitnessValueValid(value, testType) {
  return Number.isFinite(value) && (testType === 'sitReach' || value > 0);
}

function renderQuickEntryRoster() {
  const grade = document.getElementById('quickEntryGrade').value;
  const className = document.getElementById('quickEntryClass').value;
  const root = document.getElementById('quickEntryRoster');
  if (!grade || !className) {
    root.innerHTML = '<div class="empty-state"><p>请选择年级和班级以载入该班学生。</p></div>';
    return;
  }
  // 名单来源：已录入过体测成绩的学生（不再有独立的学生信息表）
  const studentsInClass = DB.getFitnessStudents()
    .filter(student => student.grade === grade && student.class === className);
  if (!studentsInClass.length) {
    root.innerHTML = `<div class="empty-state"><p>该班级还没有任何体测成绩。<br>先用「📥 批量录入」导入一次名单，就可以在这里快速录成绩了。</p></div>`;
    return;
  }
  root.innerHTML = `
    <div class="table-wrapper fitness-quick-entry-table-wrap">
      <table class="data-table fitness-quick-entry-table">
        <thead><tr><th>序号</th><th>学生</th><th>性别</th><th>原始成绩</th><th>国标分 / 等级</th></tr></thead>
        <tbody>${studentsInClass.map((student, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${escapeFitnessHTML(student.name)}</td>
            <td>${escapeFitnessHTML(student.gender)}</td>
            <td><input class="form-control quick-fitness-value" data-student-id="${escapeFitnessHTML(student.id)}"
              type="number" step="0.01" inputmode="decimal" aria-label="${escapeFitnessHTML(student.name)}成绩"
              oninput="updateQuickEntryPreview(this)" placeholder="原始成绩"></td>
            <td class="quick-fitness-preview">—</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  root.querySelector('.quick-fitness-value')?.focus();
}

function updateQuickEntryPreview(input) {
  const student = DB.getFitnessStudentById(input.dataset.studentId);
  const testType = document.getElementById('quickEntryTestType').value;
  const value = Number(input.value);
  const cell = input.closest('tr').querySelector('.quick-fitness-preview');
  if (!student || !input.value || !Number.isFinite(value)) {
    cell.textContent = '—';
    return;
  }
  const grade = DB.getGrade(value, testType, student.gender, student.grade);
  const result = DB.getFitnessScore(value, testType, student.gender, student.grade);
  cell.innerHTML = result
    ? `<strong>${result.score}${result.bonus ? ` + ${result.bonus} 加分` : ''} 分</strong> · <span class="badge ${grade.class}">${escapeFitnessHTML(grade.level)}</span>`
    : `<span class="badge ${grade.class}">${escapeFitnessHTML(grade.level)}</span>`;
}

function saveQuickEntry() {
  const grade = document.getElementById('quickEntryGrade').value;
  const className = document.getElementById('quickEntryClass').value;
  const testType = document.getElementById('quickEntryTestType').value;
  const testDate = document.getElementById('quickEntryDate').value;
  const semester = document.getElementById('quickEntrySemester').value.trim();
  if (!grade || !className || !testDate) {
    showToast('请先选择年级、班级和测试日期', 'error');
    return;
  }
  const item = DB.FITNESS_ITEMS.find(test => test.key === testType);
  let entries;
  try {
    entries = [...document.querySelectorAll('.quick-fitness-value')]
      .filter(input => input.value.trim())
      .map(input => {
        const student = DB.getFitnessStudentById(input.dataset.studentId);
        const value = Number(input.value);
        if (!student || !isFitnessValueValid(value, testType)) {
          // 兜底不能吐内部 id（那是「姓名+班级+年级」的哈希），否则报错信息又是一串乱码
          throw new Error(`${student?.name || '该学生'} 成绩格式不正确`);
        }
        return {
          studentId: student.id, studentName: student.name, gender: student.gender,
          grade: student.grade, class: student.class,
          testType, testName: item.name, unit: item.unit, value, testDate, semester,
          ...getFitnessScoringFields(value, testType, student),
        };
      });
  } catch (error) {
    showToast(`快捷录入未保存：${error.message}`, 'error');
    return;
  }
  if (!entries.length) {
    showToast('请至少录入一名学生的成绩', 'error');
    return;
  }
  try {
    entries.forEach(entry => DB.addFitnessRecord(entry));
  } catch (error) {
    showToast(`快捷录入失败：${error.message}`, 'error');
    return;
  }
  closeModal(document.querySelector('.modal-close'));
  refreshFitnessDataViews();
  showToast(`已录入 ${entries.length} 名学生的${item.name}成绩`);
}

function onTestTypeChange() {
  const testType = document.getElementById('testTypeSelect').value;
  const item = DB.FITNESS_ITEMS.find(t => t.key === testType);
  document.getElementById('unitHint').textContent = item ? `单位: ${item.unit || '无'}` : '';
  updateGradePreview();
}

function updateGradePreview() {
  const name = document.getElementById('studentNameInput')?.value.trim() || '';
  const gender = document.getElementById('studentGenderInput')?.value || '';
  const grade = document.getElementById('studentGradeInput')?.value || '';
  const testType = document.getElementById('testTypeSelect').value;
  const value = parseFloat(document.getElementById('valueInput').value);

  const preview = document.getElementById('gradePreview');
  if (!name || !gender || !grade || !testType || isNaN(value)) {
    preview.style.display = 'none';
    return;
  }

  const g = DB.getGrade(value, testType, gender, grade);
  const score = DB.getFitnessScore(value, testType, gender, grade);
  preview.style.display = 'block';
  document.getElementById('gradeBadge').innerHTML = `${score ? `<strong>${score.score}${score.bonus ? ` + ${score.bonus} 加分` : ''} 分</strong> · ` : ''}<span class="badge ${g.class}">${g.level}</span>`;
}

// 监听输入实时预览
document.addEventListener('input', function(e) {
  if (e.target.id === 'valueInput' || e.target.id === 'studentNameInput') updateGradePreview();
});

function saveRecord() {
  const form = document.getElementById('recordForm');
  const data = Object.fromEntries(new FormData(form));

  const studentName = String(data.studentName || '').trim();
  const gender = String(data.gender || '').trim();
  const grade = String(data.grade || '').trim();
  const className = String(data.className || '').trim();

  if (!studentName) { showToast('请填写学生姓名', 'error'); return; }
  if (!gender) { showToast('请选择性别', 'error'); return; }
  if (!grade) { showToast('请选择年级', 'error'); return; }
  if (!className) { showToast('请填写班级', 'error'); return; }
  if (!data.testType) { showToast('请选择测试项目', 'error'); return; }
  if (data.value === '') { showToast('请输入成绩', 'error'); return; }
  if (!data.testDate) { showToast('请选择测试日期', 'error'); return; }
  const value = Number(data.value);
  if (!isFitnessValueValid(value, data.testType)) {
    showToast(data.testType === 'sitReach' ? '成绩必须是有效数字' : '成绩必须为大于 0 的有效数字', 'error');
    return;
  }

  const item = DB.FITNESS_ITEMS.find(t => t.key === data.testType);
  // 内部 id 由「姓名 + 班级 + 年级」算出：同一个学生多次录入会自动归并
  const studentId = DB.makeFitnessStudentId({ name: studentName, grade, class: className });
  const student = { id: studentId, name: studentName, gender, grade, class: className };

  DB.addFitnessRecord({
    studentId,
    studentName,
    gender,
    grade,
    class: className,
    testType: data.testType,
    testName: item.name,
    unit: item.unit,
    value,
    testDate: data.testDate,
    semester: data.semester,
    ...getFitnessScoringFields(value, data.testType, student),
  });

  closeModal(document.querySelector('.modal-close'));
  refreshFitnessDataViews();
  showToast('体测成绩录入成功');
}

/* ===== Chart.js 实例清理（通用小工具）=====
   体测模块现在只用 ECharts（统计分析看板 / 成绩排名 / 弱项分布图），
   成绩排名视图进来时仍会调它做一次兜底清理，所以留着这个工具函数。 */
function destroyFitnessCharts() {
  Object.values(fitnessCharts).forEach(chart => chart?.destroy());
  fitnessCharts = {};
}
