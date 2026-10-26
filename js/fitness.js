/**
 * 学生体测数据模块
 * 成绩录入、统计分析、可视化看板
 */

let fitnessView = 'records'; // records | stats
let fitnessCharts = {};
let statsGradeFilter = 'all';
let statsGenderFilter = 'all';
let statsClassFilter = 'all';

Layout.init('fitness', '体测数据', '体测数据');

const content = document.getElementById('page-content');

const records = DB.getFitnessRecords();
const students = DB.getStudents();

// 统计摘要
const totalRecords = records.length;
const excellentCount = records.filter(r => {
  const s = students.find(st => st.id === r.studentId);
  if (!s) return false;
  return DB.getGrade(r.value, r.testType, s.gender, s.grade).level === '优秀';
}).length;
const needAttention = records.filter(r => {
  const s = students.find(st => st.id === r.studentId);
  if (!s) return false;
  return ['不及格', '偏胖'].includes(DB.getGrade(r.value, r.testType, s.gender, s.grade).level);
}).length;

content.innerHTML = `
  <div class="page-header">
    <div>
      <h1>学生体测数据</h1>
      <p>成绩录入、统计分析与可视化看板</p>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-secondary" onclick="openBatchImport()">
        <span>📥</span> 批量录入
      </button>
      <button class="btn btn-secondary" onclick="openQuickEntry()">
        <span>⌨️</span> 快捷录入
      </button>
      <button class="btn btn-primary" onclick="openAddRecord()">
        <span>📝</span> 录入成绩
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
        <button class="${fitnessView === 'records' ? 'active' : ''}" onclick="switchView('records')">成绩列表</button>
        <button class="${fitnessView === 'stats' ? 'active' : ''}" onclick="switchView('stats')">统计分析</button>
      </div>
    </div>
    <div class="toolbar-right" id="filterArea"></div>
  </div>

  <!-- 内容区 -->
  <div id="fitnessContent"></div>
`;

Store.ready.then(() => {
  renderView();
  updateFitnessSummaryCards();
});

function updateFitnessSummaryCards() {
  const latestRecords = DB.getFitnessRecords();
  const studentsById = new Map(DB.getStudents().map(student => [student.id, student]));
  const excellent = latestRecords.filter(record => {
    const student = studentsById.get(record.studentId);
    return student && DB.getGrade(record.value, record.testType, student.gender, student.grade).level === '优秀';
  }).length;
  const attention = latestRecords.filter(record => {
    const student = studentsById.get(record.studentId);
    return student && ['不及格', '偏胖', '肥胖'].includes(DB.getGrade(record.value, record.testType, student.gender, student.grade).level);
  }).length;
  document.getElementById('fitnessTotalRecords').textContent = latestRecords.length;
  document.getElementById('fitnessExcellentCount').textContent = excellent;
  document.getElementById('fitnessAttentionCount').textContent = attention;
}

function refreshFitnessDataViews() {
  updateFitnessSummaryCards();
  renderView();
}

function switchView(view) {
  fitnessView = view;
  // 更新按钮
  document.querySelectorAll('#viewSwitch button').forEach((btn, i) => {
    btn.classList.toggle('active', (i === 0 && view === 'records') || (i === 1 && view === 'stats'));
  });
  renderView();
}

function renderView() {
  if (fitnessView === 'records') {
    renderRecordsView();
  } else {
    renderStatsView();
  }
}

// ===== 成绩列表视图 =====
function renderRecordsView() {
  const filterArea = document.getElementById('filterArea');
  filterArea.innerHTML = `
    <div class="search-box">
      <span>🔍</span>
      <input type="text" placeholder="搜索学生..." id="recordSearch" oninput="renderRecordsTable()">
    </div>
    <select class="form-control" style="width:auto;" id="testTypeFilter" onchange="renderRecordsTable()">
      <option value="all">全部项目</option>
      ${DB.FITNESS_ITEMS.map(t => `<option value="${t.key}">${t.icon} ${t.name}</option>`).join('')}
    </select>
  `;

  const container = document.getElementById('fitnessContent');
  container.innerHTML = `
    <div class="card fade-in">
      <div class="card-body" style="padding:0;">
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>学生</th>
                <th>年级班级</th>
                <th>测试项目</th>
                <th>成绩</th>
                <th>等级</th>
                <th>测试日期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="recordsTableBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  renderRecordsTable();
}

function renderRecordsTable() {
  let list = DB.getFitnessRecords();
  const search = document.getElementById('recordSearch')?.value.trim().toLowerCase() || '';
  const testType = document.getElementById('testTypeFilter')?.value || 'all';

  if (search) {
    list = list.filter(r => r.studentName.toLowerCase().includes(search) || r.studentId.toLowerCase().includes(search));
  }
  if (testType !== 'all') {
    list = list.filter(r => r.testType === testType);
  }

  // 按日期倒序
  list.sort((a, b) => (b.testDate || '').localeCompare(a.testDate || ''));

  const tbody = document.getElementById('recordsTableBody');
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📭</div><p>暂无体测记录</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(r => {
    const student = students.find(s => s.id === r.studentId);
    const g = DB.getGrade(r.value, r.testType, student?.gender || '男', student?.grade || r.grade);
    const score = DB.getFitnessScore(r.value, r.testType, student?.gender || '男', student?.grade || r.grade);
    return `
      <tr>
        <td><strong>${r.studentName}</strong><br><span style="font-size:12px;color:var(--text-tertiary);">${r.studentId}</span></td>
        <td>${r.grade || '-'}${r.class || ''}</td>
        <td>${r.testName}</td>
        <td><strong style="font-size:16px;color:var(--primary);">${r.value}</strong> ${r.unit}</td>
        <td>${score ? `<strong>${score.score}${score.bonus ? ` + ${score.bonus} 加分` : ''} 分</strong> · ` : ''}<span class="badge ${g.class}">${g.level}</span></td>
        <td>${r.testDate}</td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="deleteRecord('${r.id}')" title="删除">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

function deleteRecord(id) {
  DB.deleteFitnessRecord(id);
  refreshFitnessDataViews();
  showToast('记录已删除');
}

// ===== 录入成绩 =====
function openAddRecord() {
  const studentOptions = students.map(s => ({
    id: s.id, label: `${s.name} (${s.grade}${s.class})`, gender: s.gender
  }));

  const bodyHTML = `
    <form id="recordForm" onsubmit="return false;">
      <div class="form-group">
        <label>学生 <span class="required">*</span></label>
        <select class="form-control" name="studentId" id="studentSelect" required onchange="onStudentChange()">
          <option value="">请选择学生</option>
          ${studentOptions.map(s => `<option value="${s.id}">${s.label}</option>`).join('')}
        </select>
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
  const grades = [...new Set(DB.getStudents().map(student => student.grade))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN', { numeric: true }));
  const gradeOptions = grades.map(grade => `<option value="${escapeFitnessHTML(grade)}">${escapeFitnessHTML(grade)}</option>`).join('');
  const classOptions = [...new Set(DB.getStudents().map(student => student.class))]
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
    root.innerHTML = '<div class="empty-state"><p>请选择年级和班级以载入学生名单。</p></div>';
    return;
  }
  const studentsInClass = DB.getStudents().filter(student => student.grade === grade && student.class === className);
  if (!studentsInClass.length) {
    root.innerHTML = '<div class="empty-state"><p>该班级暂无学生信息。</p></div>';
    return;
  }
  root.innerHTML = `
    <div class="table-wrapper fitness-quick-entry-table-wrap">
      <table class="data-table fitness-quick-entry-table">
        <thead><tr><th>序号</th><th>学号</th><th>学生</th><th>性别</th><th>原始成绩</th><th>国标分 / 等级</th></tr></thead>
        <tbody>${studentsInClass.map((student, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${escapeFitnessHTML(student.id)}</td>
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
  const student = DB.getStudentById(input.dataset.studentId);
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
        const student = DB.getStudentById(input.dataset.studentId);
        const value = Number(input.value);
        if (!student || !isFitnessValueValid(value, testType)) {
          throw new Error(`${student?.name || input.dataset.studentId} 成绩格式不正确`);
        }
        return {
          studentId: student.id, studentName: student.name, grade: student.grade, class: student.class,
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

function onStudentChange() {
  updateGradePreview();
}

function updateGradePreview() {
  const studentId = document.getElementById('studentSelect').value;
  const testType = document.getElementById('testTypeSelect').value;
  const value = parseFloat(document.getElementById('valueInput').value);

  const preview = document.getElementById('gradePreview');
  if (!studentId || !testType || isNaN(value)) {
    preview.style.display = 'none';
    return;
  }

  const student = DB.getStudentById(studentId);
  if (!student) return;
  const g = DB.getGrade(value, testType, student.gender, student.grade);
  const score = DB.getFitnessScore(value, testType, student.gender, student.grade);
  preview.style.display = 'block';
  document.getElementById('gradeBadge').innerHTML = `${score ? `<strong>${score.score}${score.bonus ? ` + ${score.bonus} 加分` : ''} 分</strong> · ` : ''}<span class="badge ${g.class}">${g.level}</span>`;
}

// 监听输入实时预览
document.addEventListener('input', function(e) {
  if (e.target.id === 'valueInput') updateGradePreview();
});

function saveRecord() {
  const form = document.getElementById('recordForm');
  const data = Object.fromEntries(new FormData(form));

  if (!data.studentId) { showToast('请选择学生', 'error'); return; }
  if (!data.testType) { showToast('请选择测试项目', 'error'); return; }
  if (data.value === '') { showToast('请输入成绩', 'error'); return; }
  if (!data.testDate) { showToast('请选择测试日期', 'error'); return; }
  const value = Number(data.value);
  if (!isFitnessValueValid(value, data.testType)) {
    showToast(data.testType === 'sitReach' ? '成绩必须是有效数字' : '成绩必须为大于 0 的有效数字', 'error');
    return;
  }

  const student = DB.getStudentById(data.studentId);
  if (!student) { showToast('学生不存在', 'error'); return; }

  const item = DB.FITNESS_ITEMS.find(t => t.key === data.testType);

  DB.addFitnessRecord({
    studentId: data.studentId,
    studentName: student.name,
    grade: student.grade,
    class: student.class,
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

// ===== 批量录入成绩 =====
function openBatchImport() {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  const bodyHTML = `
    <div class="batch-step" id="batchStep1">
      <div class="form-row">
        <div class="form-group">
          <label>测试项目 <span class="required">*</span></label>
          <select class="form-control" id="batchTestType">
            ${DB.FITNESS_ITEMS.map(t => `<option value="${t.key}">${t.icon} ${t.name}${t.unit ? ' (' + t.unit + ')' : ''}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>测试日期 <span class="required">*</span></label>
          <input class="form-control" type="date" id="batchTestDate" value="${todayStr}">
        </div>
      </div>
      <div class="form-group">
        <label>学期</label>
        <select class="form-control" id="batchSemester">
          <option value="2026秋">2026秋</option>
          <option value="2027春">2027春</option>
        </select>
      </div>
      <div style="display:flex;gap:10px;margin-top:20px;">
        <button class="btn btn-secondary" onclick="downloadTemplate()" style="flex:1;">
          <span>📥</span> 下载成绩模板
        </button>
        <button class="btn btn-primary" onclick="triggerUpload()" style="flex:1;">
          <span>📤</span> 上传填好的模板
        </button>
      </div>
      <input type="file" id="batchFileInput" accept=".xlsx,.xls" style="display:none;" onchange="handleFileUpload(event)">
      <div style="margin-top:16px;padding:12px;background:var(--bg-hover);border-radius:var(--radius-sm);font-size:13px;color:var(--text-secondary);line-height:1.7;">
        <strong>使用步骤：</strong><br>
        1. 先选择测试项目和日期<br>
        2. 点击"下载成绩模板"获取 Excel 文件<br>
        3. 用 Excel 打开，在成绩列填入数据（不要改学号和姓名）<br>
        4. 点击"上传填好的模板"导入数据
      </div>
    </div>

    <!-- 预览区 -->
    <div class="batch-step" id="batchStep2" style="display:none;">
      <div id="batchPreviewInfo" style="margin-bottom:12px;font-size:14px;"></div>
      <div class="table-wrapper" style="max-height:300px;overflow-y:auto;">
        <table class="data-table" id="batchPreviewTable">
          <thead><tr><th>学号</th><th>姓名</th><th>成绩</th><th>等级</th></tr></thead>
          <tbody id="batchPreviewBody"></tbody>
        </table>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-ghost" onclick="backToStep1()">返回修改</button>
        <button class="btn btn-primary" onclick="confirmBatchImport()" style="flex:1;">确认导入</button>
      </div>
    </div>

    <!-- 结果区 -->
    <div class="batch-step" id="batchStep3" style="display:none;">
      <div id="batchResultInfo" style="text-align:center;padding:20px 0;"></div>
    </div>
  `;

  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">关闭</button>
  `;

  showModal('批量录入成绩', bodyHTML, footerHTML);
}

// 下载模板（XLSX 格式）
function downloadTemplate() {
  const testType = document.getElementById('batchTestType').value;
  const item = DB.FITNESS_ITEMS.find(t => t.key === testType);
  if (!item) return;

  const allStudents = DB.getStudents();

  // 构建 sheet 数据
  const header = ['学号', '姓名', '性别', `${item.name}${item.unit ? '(' + item.unit + ')' : ''}`];
  const data = [header];
  allStudents.forEach(s => {
    data.push([s.id, s.name, s.gender, '']);
  });

  // 创建 worksheet
  const ws = XLSX.utils.aoa_to_sheet(data);
  // 设置列宽
  ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 6 }, { wch: 20 }];

  // 创建 workbook
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '成绩录入');

  const fileName = `体测成绩模板_${item.name}_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, fileName);
  showToast('模板已下载，请填写后上传');
}

// 触发文件上传
function triggerUpload() {
  const testType = document.getElementById('batchTestType').value;
  const testDate = document.getElementById('batchTestDate').value;
  if (!testDate) {
    showToast('请先选择测试日期', 'error');
    return;
  }
  document.getElementById('batchFileInput').click();
}

// 处理上传文件
let batchPendingData = [];

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }); // aoa 格式

      if (rows.length < 2) {
        showToast('文件内容为空或格式不对', 'error');
        return;
      }

      // 解析
      const testType = document.getElementById('batchTestType').value;
      const item = DB.FITNESS_ITEMS.find(t => t.key === testType);
      const testDate = document.getElementById('batchTestDate').value;
      const semester = document.getElementById('batchSemester').value;

      const results = [];
      const errors = [];
      const allStudents = DB.getStudents();

      // 跳过表头，从第二行开始
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const sid = String(row[0] || '').trim();
        const sname = String(row[1] || '').trim();
        const valueStr = String(row[3] || '').trim(); // 第4列是成绩
        const value = parseFloat(valueStr);

        if (!sid || !valueStr) continue;

        const student = allStudents.find(s => s.id === sid);
        if (!student) {
          errors.push(`第${i+1}行：学号 ${sid} 未找到学生`);
          continue;
        }

        if (isNaN(value)) {
          errors.push(`第${i+1}行：成绩 "${valueStr}" 不是数字`);
          continue;
        }
        if (!isFitnessValueValid(value, testType)) {
          errors.push(`第${i+1}行：成绩 "${valueStr}" 不符合该项目的取值要求`);
          continue;
        }

        results.push({
          studentId: student.id,
          studentName: student.name,
          grade: student.grade,
          class: student.class,
          testType: testType,
          testName: item.name,
          unit: item.unit,
          value: value,
          testDate: testDate,
          semester: semester,
          ...getFitnessScoringFields(value, testType, student),
        });
      }

      if (results.length === 0) {
        let errMsg = '没有可导入的数据';
        if (errors.length > 0) errMsg += '：\n' + errors.join('\n');
        showToast(errMsg, 'error');
        return;
      }

      batchPendingData = results;

      // 显示预览
      document.getElementById('batchStep1').style.display = 'none';
      document.getElementById('batchStep2').style.display = 'block';
      document.getElementById('batchStep3').style.display = 'none';

      document.getElementById('batchPreviewInfo').innerHTML = `
        解析成功 <strong style="color:var(--primary);">${results.length}</strong> 条记录${errors.length > 0 ? '，<span style="color:var(--danger);">' + errors.length + ' 条错误被跳过</span>' : ''}，请确认后导入。
        ${errors.length > 0 ? '<details style="margin-top:8px;font-size:12px;color:var(--danger);"><summary>查看错误明细</summary>' + errors.map(e => '<div>' + e + '</div>').join('') + '</details>' : ''}
      `;

      document.getElementById('batchPreviewBody').innerHTML = results.map(r => `
        <tr>
          <td>${r.studentId}</td>
          <td><strong>${r.studentName}</strong></td>
          <td><strong style="color:var(--primary);">${r.value}</strong> ${r.unit}</td>
          <td>${r.score !== null ? `<strong>${r.score}${r.scoreBonus ? ` + ${r.scoreBonus} 加分` : ''} 分</strong> · ` : ''}<span class="badge ${r.gradeClass}">${r.gradeLevel}</span></td>
        </tr>
      `).join('');
    } catch (err) {
      showToast('文件解析失败：' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

// 返回第一步
function backToStep1() {
  document.getElementById('batchStep1').style.display = 'block';
  document.getElementById('batchStep2').style.display = 'none';
  document.getElementById('batchStep3').style.display = 'none';
  // 清空文件选择
  document.getElementById('batchFileInput').value = '';
}

// 确认导入
function confirmBatchImport() {
  let success = 0;
  batchPendingData.forEach(r => {
    DB.addFitnessRecord({
      studentId: r.studentId,
      studentName: r.studentName,
      grade: r.grade,
      class: r.class,
      testType: r.testType,
      testName: r.testName,
      unit: r.unit,
      value: r.value,
      testDate: r.testDate,
      semester: r.semester,
      score: r.score,
      scoreBonus: r.scoreBonus,
      gradeLevel: r.gradeLevel,
      gradeClass: r.gradeClass,
      standardVersion: r.standardVersion,
    });
    success++;
  });

  // 显示结果
  document.getElementById('batchStep1').style.display = 'none';
  document.getElementById('batchStep2').style.display = 'none';
  document.getElementById('batchStep3').style.display = 'block';

  document.getElementById('batchResultInfo').innerHTML = `
    <div style="font-size:48px;margin-bottom:8px;">✅</div>
    <h3 style="font-size:18px;font-weight:700;">导入完成</h3>
    <p style="color:var(--text-secondary);margin-top:4px;">成功导入 <strong style="color:var(--primary);">${success}</strong> 条成绩记录</p>
  `;

  refreshFitnessDataViews();
  batchPendingData = [];
  showToast(`成功导入 ${success} 条成绩`);
}

// ===== 统计分析视图 =====
function renderStatsView() {
  destroyFitnessCharts();
  const filterArea = document.getElementById('filterArea');
  filterArea.innerHTML = `
    <select class="form-control" style="width:auto;" id="statsGradeFilter" aria-label="筛选统计年级" onchange="updateStatsGrade()">
      <option value="all">全部年级</option>
      ${['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'].map(grade =>
    `<option value="${grade}" ${statsGradeFilter === grade ? 'selected' : ''}>${grade}</option>`).join('')}
    </select>
    <select class="form-control" style="width:auto;" id="statsGenderFilter" aria-label="筛选统计性别" onchange="updateStatsGender()">
      <option value="all" ${statsGenderFilter === 'all' ? 'selected' : ''}>全部性别</option>
      <option value="男" ${statsGenderFilter === '男' ? 'selected' : ''}>男</option>
      <option value="女" ${statsGenderFilter === '女' ? 'selected' : ''}>女</option>
    </select>
    <select class="form-control" style="width:auto;" id="statsClassFilter" aria-label="筛选统计班级" onchange="updateStatsClass()">
      <option value="all">全部班级</option>
    </select>
  `;

  const container = document.getElementById('fitnessContent');
  container.innerHTML = `
    <section class="fitness-national-overview">
      <div class="fitness-overview-heading">
        <div><h2>班级体测总览</h2><p id="fitnessOverviewScope"></p></div>
        <span class="badge badge-info">2014 年修订版国标</span>
      </div>
      <div class="grid grid-3 fitness-overview-summary" id="fitnessOverviewSummary"></div>
      <div class="grid fitness-overview-charts">
        <div class="card fade-in">
        <div class="card-header">
          <div class="card-title"><span>📊</span> 各项目及格率 / 优秀率</div>
        </div>
        <div class="card-body">
          <div class="fitness-chart-container"><canvas id="chartFitnessRates"></canvas></div>
        </div>
      </div>
      <div class="card fade-in fade-in-delay-1">
        <div class="card-header">
          <div class="card-title"><span>📈</span> 各项目平均国标分</div>
        </div>
        <div class="card-body">
          <div class="fitness-chart-container"><canvas id="chartFitnessAverage"></canvas></div>
        </div>
      </div>
      </div>
      <p class="fitness-overview-note">年度及格率和优秀率仅统计同一学年内必测项目齐全的学生（秋季与次年春季合并；未填写学期时按测试年份）；项目图表按每名学生每个项目的最新有效成绩统计。校内扩展项目不计入国标成绩。</p>
    </section>
    <div class="card fade-in" style="margin-top:24px;">
      <div class="card-header">
        <div class="card-title"><span>📋</span> 项目成绩汇总</div>
      </div>
      <div class="card-body" style="padding:0;">
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr><th>学生</th><th>年级班级</th><th>项目</th><th>原始成绩</th><th>单项得分</th><th>等级</th><th>日期</th></tr>
            </thead>
            <tbody id="statTableBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  populateStatsClassFilter();
  renderFitnessOverview();
  renderStatRecords();
}

function destroyFitnessCharts() {
  Object.values(fitnessCharts).forEach(chart => chart?.destroy());
  fitnessCharts = {};
}

function populateStatsClassFilter() {
  const select = document.getElementById('statsClassFilter');
  const classes = [...new Set(DB.getStudents()
    .filter(student => statsGradeFilter === 'all' || student.grade === statsGradeFilter)
    .map(student => student.class).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  select.innerHTML = '<option value="all">全部班级</option>' +
    classes.map(className => `<option value="${escapeFitnessHTML(className)}">${escapeFitnessHTML(className)}</option>`).join('');
  if (classes.includes(statsClassFilter)) select.value = statsClassFilter;
  else statsClassFilter = 'all';
}

function updateStatsGrade() {
  statsGradeFilter = document.getElementById('statsGradeFilter').value;
  statsClassFilter = 'all';
  populateStatsClassFilter();
  renderFitnessOverview();
  renderStatRecords();
}

function updateStatsGender() {
  statsGenderFilter = document.getElementById('statsGenderFilter').value;
  renderFitnessOverview();
  renderStatRecords();
}

function updateStatsClass() {
  statsClassFilter = document.getElementById('statsClassFilter').value;
  renderFitnessOverview();
  renderStatRecords();
}

function getStatsStudents() {
  return DB.getStudents().filter(student =>
    (statsGradeFilter === 'all' || student.grade === statsGradeFilter) &&
    (statsGenderFilter === 'all' || student.gender === statsGenderFilter) &&
    (statsClassFilter === 'all' || student.class === statsClassFilter));
}

function getLatestFitnessRecords(selectedStudents) {
  const selectedIds = new Set(selectedStudents.map(student => student.id));
  const latest = new Map();
  DB.getFitnessRecords().forEach(record => {
    if (!selectedIds.has(record.studentId)) return;
    const key = `${record.studentId}|${record.testType}`;
    const existing = latest.get(key);
    if (!existing || `${record.testDate || ''}|${record.createdAt || ''}` > `${existing.testDate || ''}|${existing.createdAt || ''}`) {
      latest.set(key, record);
    }
  });
  return [...latest.values()];
}

function renderFitnessOverview() {
  const selectedStudents = getStatsStudents();
  const latest = getLatestFitnessRecords(selectedStudents);
  const studentById = new Map(selectedStudents.map(student => [student.id, student]));
  const nationalRows = latest.map(record => {
    const student = studentById.get(record.studentId);
    const score = student && DB.getFitnessScore(record.value, record.testType, student.gender, student.grade);
    const grade = student && DB.getGrade(record.value, record.testType, student.gender, student.grade);
    return score && grade ? { record, student, score: score.score, grade: grade.level } : null;
  }).filter(Boolean);
  const annualSummaries = selectedStudents.map(student =>
    DB.getAnnualFitnessSummary(DB.getRecordsByStudent(student.id), student.grade, student.gender));
  const completeAnnualSummaries = annualSummaries.filter(summary => summary?.complete);
  const passed = completeAnnualSummaries.filter(summary => summary.totalScore >= 60).length;
  const excellent = completeAnnualSummaries.filter(summary => summary.totalScore >= 90).length;
  const passRate = completeAnnualSummaries.length ? Math.round(passed / completeAnnualSummaries.length * 100) : 0;
  const excellentRate = completeAnnualSummaries.length ? Math.round(excellent / completeAnnualSummaries.length * 100) : 0;
  const scope = `${statsGradeFilter === 'all' ? '全部年级' : statsGradeFilter}${statsGenderFilter === 'all' ? '' : ` · ${statsGenderFilter}生`}${statsClassFilter === 'all' ? '' : ` · ${statsClassFilter}`} · ${selectedStudents.length} 名学生`;
  document.getElementById('fitnessOverviewScope').textContent = `${scope}（年度总评需同一周期内必测项目齐全）`;
  document.getElementById('fitnessOverviewSummary').innerHTML = `
    <div class="stat-card"><div class="stat-icon" style="background:var(--success-light);color:var(--success);">✅</div><div class="stat-content"><h3>${passRate}%</h3><p>年度总评及格率 · ${passed}/${completeAnnualSummaries.length}</p></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--primary-100);color:var(--primary);">🏆</div><div class="stat-content"><h3>${excellentRate}%</h3><p>年度总评优秀率 · ${excellent}/${completeAnnualSummaries.length}</p></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--info-light);color:#0288D1;">📋</div><div class="stat-content"><h3>${completeAnnualSummaries.length}/${selectedStudents.length}</h3><p>年度必测项目完整学生</p></div></div>
  `;

  const byTest = new Map(DB.FITNESS_ITEMS.map(item => [item.key, { item, rows: [] }]));
  nationalRows.forEach(row => byTest.get(row.record.testType)?.rows.push(row));
  const testRows = [...byTest.values()].filter(group => group.rows.length);
  if (!testRows.length) {
    setFitnessChartEmptyState('chartFitnessRates', '所选范围暂无可用于国标统计的成绩。');
    setFitnessChartEmptyState('chartFitnessAverage', '录入国标项目成绩后，这里将显示各项目平均分。');
    destroyFitnessCharts();
    return;
  }
  if (typeof Chart === 'undefined') {
    throw new Error('体测图表组件未加载，无法展示班级统计图表');
  }
  destroyFitnessCharts();
  clearFitnessChartEmptyState('chartFitnessRates');
  clearFitnessChartEmptyState('chartFitnessAverage');
  const labels = testRows.map(group => group.item.name);
  const passRates = testRows.map(group => Math.round(group.rows.filter(row => row.score >= 60).length / group.rows.length * 100));
  const excellentRates = testRows.map(group => Math.round(group.rows.filter(row => row.score >= 90).length / group.rows.length * 100));
  const averages = testRows.map(group => Number((group.rows.reduce((sum, row) => sum + row.score, 0) / group.rows.length).toFixed(1)));
  fitnessCharts.rates = new Chart(document.getElementById('chartFitnessRates'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: '及格率', data: passRates, backgroundColor: '#06A77D' },
      { label: '优秀率', data: excellentRates, backgroundColor: '#E85D04' },
    ] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100, ticks: { callback: value => `${value}%` } } } },
  });
  fitnessCharts.average = new Chart(document.getElementById('chartFitnessAverage'), {
    type: 'bar',
    data: { labels, datasets: [{ label: '平均国标单项分', data: averages, backgroundColor: 'rgba(3,83,164,0.72)', borderColor: '#0353A4', borderWidth: 1, borderRadius: 5 }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: '分' } } } },
  });
}

function setFitnessChartEmptyState(canvasId, message) {
  const canvas = document.getElementById(canvasId);
  canvas.style.display = 'none';
  let empty = canvas.parentElement.querySelector('.fitness-chart-empty');
  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'fitness-chart-empty';
    canvas.parentElement.appendChild(empty);
  }
  empty.textContent = message;
}

function clearFitnessChartEmptyState(canvasId) {
  const canvas = document.getElementById(canvasId);
  canvas.style.display = '';
  canvas.parentElement.querySelector('.fitness-chart-empty')?.remove();
}

function renderStatRecords() {
  const selectedStudents = getStatsStudents();
  const studentById = new Map(selectedStudents.map(student => [student.id, student]));
  const rows = getLatestFitnessRecords(selectedStudents).map(record => {
    const student = studentById.get(record.studentId);
    if (!student) return null;
    const grade = DB.getGrade(record.value, record.testType, student.gender, student.grade);
    const score = DB.getFitnessScore(record.value, record.testType, student.gender, student.grade);
    return { record, student, grade, score };
  }).filter(Boolean).sort((a, b) =>
    a.student.grade.localeCompare(b.student.grade, 'zh-CN', { numeric: true }) ||
    a.student.class.localeCompare(b.student.class, 'zh-CN', { numeric: true }) ||
    a.student.name.localeCompare(b.student.name, 'zh-CN'));
  const tbody = document.getElementById('statTableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📭</div><p>当前筛选范围暂无体测记录</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(({ record, student, grade, score }) => `
      <tr>
        <td><strong>${escapeFitnessHTML(student.name)}</strong><br><span class="fitness-record-subtext">${escapeFitnessHTML(student.id)}</span></td>
        <td>${escapeFitnessHTML(student.grade)}${escapeFitnessHTML(student.class)}</td>
        <td>${escapeFitnessHTML(record.testName)}</td>
        <td><strong style="color:var(--primary);">${escapeFitnessHTML(record.value)}</strong> ${escapeFitnessHTML(record.unit)}</td>
        <td>${score ? `${score.score}${score.bonus ? ` + ${score.bonus} 加分` : ''} 分` : '<span class="fitness-record-subtext">校内参考</span>'}</td>
        <td><span class="badge ${grade.class}">${escapeFitnessHTML(grade.level)}</span></td>
        <td>${escapeFitnessHTML(record.testDate)}</td>
      </tr>
    `).join('');
}
