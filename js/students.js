/**
 * 学生信息管理模块
 */

let selectedStudentIds = new Set();

Layout.init('students', '学生信息管理', '学生信息');

const content = document.getElementById('page-content');

content.innerHTML = `
  <div class="page-header">
    <div>
      <h1>学生信息管理</h1>
      <p>管理学生名册、基本信息与健康备注</p>
    </div>
    <div class="student-header-actions">
      <button class="btn btn-secondary" onclick="downloadStudentImportTemplate()">下载导入模板</button>
      <label class="btn btn-secondary" for="studentImportFile">导入 CSV</label>
      <input id="studentImportFile" class="student-file-input" type="file" accept=".csv,text/csv" onchange="importStudentsCSV(this.files[0])">
      <button class="btn btn-primary" onclick="openAddStudent()"><span>➕</span> 添加学生</button>
    </div>
  </div>

  <!-- 工具栏 -->
  <div class="toolbar">
    <div class="toolbar-left">
      <div class="search-box">
        <span>🔍</span>
        <input type="text" placeholder="搜索姓名或学号..." id="searchInput" oninput="renderTable()">
      </div>
      <select class="form-control" style="width:auto;" id="gradeFilter" onchange="renderTable()">
        <option value="all">全部年级</option>
        <option value="一年级">一年级</option>
        <option value="二年级">二年级</option>
        <option value="三年级">三年级</option>
        <option value="四年级">四年级</option>
        <option value="五年级">五年级</option>
        <option value="六年级">六年级</option>
      </select>
      <select class="form-control student-filter" id="classFilter" aria-label="按班级筛选" onchange="renderTable()">
        <option value="all">全部班级</option>
      </select>
      <select class="form-control student-filter" id="genderFilter" aria-label="按性别筛选" onchange="renderTable()">
        <option value="all">全部性别</option>
        <option value="男">男</option><option value="女">女</option>
      </select>
    </div>
    <div class="toolbar-right">
      <span class="badge badge-primary" id="totalCount"></span>
    </div>
  </div>

  <div class="student-bulk-toolbar">
    <label class="student-select-all"><input type="checkbox" id="selectAllStudents" onchange="toggleVisibleStudents(this.checked)"> 全选当前筛选</label>
    <span id="selectedStudentCount">已选 0 人</span>
    <div class="student-bulk-actions">
      <button class="btn btn-secondary btn-sm" id="changeStudentClassButton" onclick="openBulkClassChange()" disabled>批量修改班级</button>
      <button class="btn btn-secondary btn-sm" id="exportStudentsButton" onclick="exportSelectedStudents()" disabled>导出 Excel</button>
      <button class="btn btn-danger btn-sm" id="deleteStudentsButton" onclick="deleteSelectedStudents()" disabled>批量删除</button>
    </div>
  </div>

  <!-- 学生表格 -->
  <div class="card fade-in">
    <div class="card-body" style="padding:0;">
      <div class="table-wrapper">
        <table class="data-table" id="studentTable">
          <thead>
            <tr>
              <th class="student-checkbox-cell">选择</th>
              <th>学号</th>
              <th>姓名</th>
              <th>性别</th>
              <th>年级</th>
              <th>班级</th>
              <th>身高/cm</th>
              <th>体重/kg</th>
              <th>监护人</th>
              <th>健康备注</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="studentTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>
`;

populateStudentClassFilter();
Store.ready.then(() => {
  renderTable();
});

function escapeStudentHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function inlineStudentArg(value) {
  return encodeURIComponent(String(value)).replace(/'/g, '%27');
}

function populateStudentClassFilter() {
  const select = document.getElementById('classFilter');
  const selected = select.value;
  const classes = [...new Set(DB.getStudents().map(student => student.class).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  select.innerHTML = '<option value="all">全部班级</option>' +
    classes.map(className => `<option value="${escapeStudentHTML(className)}">${escapeStudentHTML(className)}</option>`).join('');
  if (classes.includes(selected)) select.value = selected;
}

function getFilteredStudents() {
  let list = DB.getStudents();
  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  const grade = document.getElementById('gradeFilter').value;
  const className = document.getElementById('classFilter').value;
  const gender = document.getElementById('genderFilter').value;

  if (search) {
    list = list.filter(s =>
      String(s.name || '').toLowerCase().includes(search) ||
      String(s.id || '').toLowerCase().includes(search)
    );
  }
  if (grade !== 'all') {
    list = list.filter(s => s.grade === grade);
  }
  if (className !== 'all') list = list.filter(student => student.class === className);
  if (gender !== 'all') list = list.filter(student => student.gender === gender);
  return list;
}

function renderTable() {
  const list = getFilteredStudents();
  const tbody = document.getElementById('studentTableBody');
  const countEl = document.getElementById('totalCount');
  countEl.textContent = `共 ${list.length} 名学生`;
  document.getElementById('selectedStudentCount').textContent = `已选 ${selectedStudentIds.size} 人`;
  ['changeStudentClassButton', 'exportStudentsButton', 'deleteStudentsButton'].forEach(id => {
    document.getElementById(id).disabled = selectedStudentIds.size === 0;
  });
  const visibleIds = list.map(student => student.id);
  const selectedVisibleCount = visibleIds.filter(id => selectedStudentIds.has(id)).length;
  const selectAll = document.getElementById('selectAllStudents');
  selectAll.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="12">
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <p>暂无学生数据，点击"添加学生"开始录入</p>
        </div>
      </td></tr>
    `;
    return;
  }

  tbody.innerHTML = list.map(s => `
    <tr>
      <td class="student-checkbox-cell"><input class="student-row-checkbox" type="checkbox" aria-label="选择${escapeStudentHTML(s.name)}" value="${escapeStudentHTML(s.id)}" ${selectedStudentIds.has(s.id) ? 'checked' : ''} onchange="toggleStudentSelection(this.value,this.checked)"></td>
      <td>${escapeStudentHTML(s.id)}</td>
      <td><strong>${escapeStudentHTML(s.name)}</strong></td>
      <td>${s.gender === '男' ? '👦 男' : '👧 女'}</td>
      <td>${escapeStudentHTML(s.grade)}</td>
      <td>${escapeStudentHTML(s.class)}</td>
      <td>${escapeStudentHTML(s.height || '-')}</td>
      <td>${escapeStudentHTML(s.weight || '-')}</td>
      <td>${escapeStudentHTML(s.guardian || '-')} ${s.phone ? '<span class="tag">' + escapeStudentHTML(s.phone) + '</span>' : ''}</td>
      <td>${s.healthNote ? `<span class="badge badge-danger student-health-tag">${escapeStudentHTML(s.healthNote)}</span>` : '<span class="student-no-health-note">—</span>'}</td>
      <td><span class="badge ${s.status === '正常' ? 'badge-success' : 'badge-warning'}">${escapeStudentHTML(s.status || '正常')}</span></td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="viewStudent(decodeURIComponent('${inlineStudentArg(s.id)}'))" title="查看">👁️</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditStudent(decodeURIComponent('${inlineStudentArg(s.id)}'))" title="编辑">✏️</button>
        <button class="btn btn-ghost btn-sm" onclick="confirmDelete(decodeURIComponent('${inlineStudentArg(s.id)}'))" title="删除">🗑️</button>
      </td>
    </tr>
  `).join('');
}

function toggleStudentSelection(id, checked) {
  if (checked) selectedStudentIds.add(id);
  else selectedStudentIds.delete(id);
  renderTable();
}

function toggleVisibleStudents(checked) {
  getFilteredStudents().forEach(student => {
    if (checked) selectedStudentIds.add(student.id);
    else selectedStudentIds.delete(student.id);
  });
  renderTable();
}

function openBulkClassChange() {
  if (!selectedStudentIds.size) return;
  const classes = [...new Set([...DB.getStudents().map(student => student.class), '1班', '2班', '3班'])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  const bodyHTML = `
    <p>将所选 ${selectedStudentIds.size} 名学生统一调整到以下班级：</p>
    <div class="form-group" style="margin-top:16px;">
      <label for="bulkStudentClass">目标班级</label>
      <select class="form-control" id="bulkStudentClass">
        ${classes.map(className => `<option value="${escapeStudentHTML(className)}">${escapeStudentHTML(className)}</option>`).join('')}
      </select>
    </div>
  `;
  showModal('批量修改班级', bodyHTML, `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="saveBulkClassChange()">确认修改</button>
  `);
}

function saveBulkClassChange() {
  const className = document.getElementById('bulkStudentClass')?.value;
  if (!className) {
    showToast('请选择目标班级', 'error');
    return;
  }
  try {
    const students = DB.getStudents();
    const selected = new Set(selectedStudentIds);
    let changed = 0;
    const updated = students.map(student => {
      if (!selected.has(student.id)) return student;
      changed++;
      return { ...student, class: className };
    });
    DB.saveStudents(updated);
    closeModal(document.querySelector('.modal-close'));
    populateStudentClassFilter();
    renderTable();
    showToast(`已将 ${changed} 名学生调整到${className}`);
  } catch (error) {
    showToast(`批量修改失败：${error.message}`, 'error');
  }
}

function csvEscape(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadStudentImportTemplate() {
  const headers = ['学号', '姓名', '性别', '年级', '班级', '健康备注', '身高/cm', '体重/kg', '监护人', '联系电话', '状态'];
  const csv = `\uFEFF${headers.map(csvEscape).join(',')}\r\n`;
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.href = url;
  link.download = '学生信息导入模板.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSelectedStudents() {
  const selected = new Set(selectedStudentIds);
  const students = DB.getStudents().filter(student => selected.has(student.id));
  if (!students.length) {
    showToast('请先选择要导出的学生', 'info');
    return;
  }
  const headers = ['学号', '姓名', '性别', '年级', '班级', '健康备注', '身高/cm', '体重/kg', '监护人', '联系电话', '状态'];
  const rows = students.map(student => [
    student.id, student.name, student.gender, student.grade, student.class,
    student.healthNote || '', student.height || '', student.weight || '',
    student.guardian || '', student.phone || '', student.status || '正常',
  ]);
  if (typeof XLSX !== 'undefined') {
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    worksheet['!cols'] = headers.map((header, index) => ({
      wch: rows.reduce((width, row) => Math.max(width, String(row[index] ?? '').length + 2), String(header).length + 4),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '学生信息');
    XLSX.writeFile(workbook, '学生信息导出.xlsx');
    showToast(`已导出 ${students.length} 名学生（Excel）`);
    return;
  }
  const csv = `\uFEFF${[headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n')}`;
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.href = url;
  link.download = '学生信息导出.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Excel 导出组件未加载，已导出 ${students.length} 名学生为 CSV`, 'info');
}

function parseStudentCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index++;
      row.push(cell);
      if (row.some(value => String(value).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some(value => String(value).trim())) rows.push(row);
  if (quoted) throw new Error('CSV 文件包含未闭合的双引号');
  return rows;
}

function normalizeStudentHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_*（）()[\]【】：:]/g, '');
}

async function importStudentsCSV(file) {
  if (!file) return;
  const fileInput = document.getElementById('studentImportFile');
  try {
    const rows = parseStudentCSV(await file.text());
    if (rows.length < 2) throw new Error('文件中没有可导入的学生数据');
    const headers = rows[0].map(normalizeStudentHeader);
    const column = aliases => headers.findIndex(header => aliases.includes(header));
    const columns = {
      id: column(['学号', 'studentid', 'studentno', 'id']),
      name: column(['姓名', 'name']),
      gender: column(['性别', 'gender']),
      grade: column(['年级', 'grade']),
      class: column(['班级', 'class', 'classname']),
      healthNote: column(['健康备注', '健康情况', '体质备注', 'healthnote', 'healthremark']),
      height: column(['身高', '身高cm', 'height']),
      weight: column(['体重', '体重kg', 'weight']),
      guardian: column(['监护人', 'guardian']),
      phone: column(['联系电话', '电话', 'phone']),
      status: column(['状态', 'status']),
    };
    const requiredFields = ['id', 'name', 'gender', 'grade', 'class'];
    const missing = requiredFields.filter(field => columns[field] < 0);
    if (missing.length) throw new Error(`缺少必需列：${missing.map(field => ({ id: '学号', name: '姓名', gender: '性别', grade: '年级', class: '班级' })[field]).join('、')}`);

    const candidates = rows.slice(1).map((values, index) => ({
      rowNumber: index + 2,
      student: Object.fromEntries(Object.entries(columns)
        .filter(([, position]) => position >= 0)
        .map(([field, position]) => [field, String(values[position] ?? '').trim()])),
    }));
    const duplicateCounts = new Map();
    candidates.forEach(({ student }) => {
      if (student.id) duplicateCounts.set(student.id, (duplicateCounts.get(student.id) || 0) + 1);
    });
    const existingIds = new Set(DB.getStudents().map(student => String(student.id)));
    const errors = [];
    const valid = [];
    candidates.forEach(({ rowNumber, student }) => {
      const problems = [];
      if (!student.id) problems.push('学号不能为空');
      else if (existingIds.has(student.id)) problems.push(`学号 ${student.id} 已存在`);
      else if (duplicateCounts.get(student.id) > 1) problems.push(`学号 ${student.id} 在导入文件中重复`);
      if (!student.name) problems.push('姓名不能为空');
      if (!['男', '女'].includes(student.gender)) problems.push(`性别“${student.gender}”无效`);
      if (!['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'].includes(student.grade)) problems.push(`年级“${student.grade}”无效`);
      if (!student.class) problems.push('班级不能为空');
      if (problems.length) errors.push(`第 ${rowNumber} 行：${problems.join('；')}`);
      else valid.push({ ...student, status: student.status || '正常', createdAt: new Date().toISOString() });
    });

    if (valid.length) {
      DB.saveStudents([...DB.getStudents(), ...valid]);
      populateStudentClassFilter();
      renderTable();
    }
    if (errors.length) {
      window.alert(`导入完成：成功 ${valid.length} 名，跳过 ${errors.length} 行。\n${errors.slice(0, 12).join('\n')}${errors.length > 12 ? `\n另有 ${errors.length - 12} 行错误未显示。` : ''}`);
    }
    if (valid.length) showToast(`已导入 ${valid.length} 名学生${errors.length ? `，${errors.length} 行需检查` : ''}`, errors.length ? 'info' : 'success');
    else if (!errors.length) showToast('没有可导入的学生数据', 'info');
  } catch (error) {
    showToast(`学生导入失败：${error.message}`, 'error');
  } finally {
    fileInput.value = '';
  }
}

function deleteSelectedStudents() {
  const selected = new Set(selectedStudentIds);
  const students = DB.getStudents().filter(student => selected.has(student.id));
  if (!students.length) {
    showToast('请先选择要删除的学生', 'info');
    return;
  }
  const confirmed = window.confirm(`确定要删除选中的 ${students.length} 名学生吗？其体测记录也会一并删除，此操作不可恢复。`);
  if (!confirmed) return;
  try {
    const selectedIds = new Set(students.map(student => student.id));
    DB.saveStudents(DB.getStudents().filter(student => !selectedIds.has(student.id)));
    DB.saveFitnessRecords(DB.getFitnessRecords().filter(record => !selectedIds.has(record.studentId)));
    selectedStudentIds.clear();
    populateStudentClassFilter();
    renderTable();
    showToast(`已删除 ${students.length} 名学生`);
  } catch (error) {
    showToast(`批量删除失败：${error.message}`, 'error');
  }
}

// 添加学生
function openAddStudent() {
  const bodyHTML = `
    <form id="studentForm" onsubmit="return false;">
      <div class="form-row">
        <div class="form-group">
          <label>学号 <span class="required">*</span></label>
          <input class="form-control" name="id" required placeholder="请输入唯一学号">
        </div>
        <div class="form-group">
          <label>姓名 <span class="required">*</span></label>
          <input class="form-control" name="name" required placeholder="请输入学生姓名">
        </div>
        <div class="form-group">
          <label>性别 <span class="required">*</span></label>
          <select class="form-control" name="gender">
            <option value="男">男</option>
            <option value="女">女</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>年级 <span class="required">*</span></label>
          <select class="form-control" name="grade">
            <option value="一年级">一年级</option>
            <option value="二年级">二年级</option>
            <option value="三年级">三年级</option>
            <option value="四年级">四年级</option>
            <option value="五年级">五年级</option>
            <option value="六年级">六年级</option>
          </select>
        </div>
        <div class="form-group">
          <label>班级 <span class="required">*</span></label>
          <select class="form-control" name="class">
            <option value="1班">1班</option>
            <option value="2班">2班</option>
            <option value="3班">3班</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>出生日期</label>
          <input class="form-control" type="date" name="birthDate">
        </div>
        <div class="form-group">
          <label>身高(cm)</label>
          <input class="form-control" type="number" name="height" placeholder="如: 130">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>体重(kg)</label>
          <input class="form-control" type="number" name="weight" placeholder="如: 28">
        </div>
        <div class="form-group">
          <label>状态</label>
          <select class="form-control" name="status">
            <option value="正常">正常</option>
            <option value="请假">请假</option>
            <option value="特殊">特殊</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>监护人</label>
        <input class="form-control" name="guardian" placeholder="家长姓名">
      </div>
      <div class="form-group">
        <label>联系电话</label>
        <input class="form-control" name="phone" placeholder="如: 138xxxxxxxx">
      </div>
      <div class="form-group">
        <label>健康备注</label>
        <input class="form-control" name="healthNote" maxlength="100" placeholder="如：免体、特异体质、哮喘">
      </div>
    </form>
  `;
  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="saveNewStudent()">保存</button>
  `;
  showModal('添加学生', bodyHTML, footerHTML);
}

function saveNewStudent() {
  const form = document.getElementById('studentForm');
  const data = Object.fromEntries(new FormData(form));
  data.id = String(data.id || '').trim();
  if (!data.id || !data.name) {
    showToast('请填写学号和姓名', 'error');
    return;
  }
  if (DB.getStudentById(data.id)) {
    showToast(`学号 ${data.id} 已存在，请检查后重试`, 'error');
    return;
  }
  try {
    DB.addStudent(data);
  } catch (error) {
    showToast(`学生保存失败：${error.message}`, 'error');
    return;
  }
  closeModal(document.querySelector('.modal-close'));
  populateStudentClassFilter();
  renderTable();
  showToast('学生添加成功');
}

// 编辑学生
function openEditStudent(id) {
  const s = DB.getStudentById(id);
  if (!s) return;
  const bodyHTML = `
    <form id="studentForm" onsubmit="return false;">
      <input type="hidden" name="id" value="${escapeStudentHTML(s.id)}">
      <div class="form-row">
        <div class="form-group">
          <label>姓名 <span class="required">*</span></label>
          <input class="form-control" name="name" value="${escapeStudentHTML(s.name)}" required>
        </div>
        <div class="form-group">
          <label>性别</label>
          <select class="form-control" name="gender">
            <option value="男" ${s.gender === '男' ? 'selected' : ''}>男</option>
            <option value="女" ${s.gender === '女' ? 'selected' : ''}>女</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>年级</label>
          <select class="form-control" name="grade">
            ${['一年级','二年级','三年级','四年级','五年级','六年级'].map(g =>
              `<option value="${g}" ${s.grade === g ? 'selected' : ''}>${g}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>班级</label>
          <select class="form-control" name="class">
            ${['1班','2班','3班'].map(c =>
              `<option value="${c}" ${s.class === c ? 'selected' : ''}>${c}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>出生日期</label>
          <input class="form-control" type="date" name="birthDate" value="${escapeStudentHTML(s.birthDate || '')}">
        </div>
        <div class="form-group">
          <label>身高(cm)</label>
          <input class="form-control" type="number" name="height" value="${escapeStudentHTML(s.height || '')}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>体重(kg)</label>
          <input class="form-control" type="number" name="weight" value="${escapeStudentHTML(s.weight || '')}">
        </div>
        <div class="form-group">
          <label>状态</label>
          <select class="form-control" name="status">
            ${['正常','请假','特殊'].map(st =>
              `<option value="${st}" ${s.status === st ? 'selected' : ''}>${st}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>监护人</label>
        <input class="form-control" name="guardian" value="${escapeStudentHTML(s.guardian || '')}">
      </div>
      <div class="form-group">
        <label>联系电话</label>
        <input class="form-control" name="phone" value="${escapeStudentHTML(s.phone || '')}">
      </div>
      <div class="form-group">
        <label>健康备注</label>
        <input class="form-control" name="healthNote" maxlength="100" value="${escapeStudentHTML(s.healthNote || '')}" placeholder="如：免体、特异体质、哮喘">
      </div>
    </form>
  `;
  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="saveEditStudent(decodeURIComponent('${inlineStudentArg(id)}'))">保存</button>
  `;
  showModal('编辑学生', bodyHTML, footerHTML);
}

function saveEditStudent(id) {
  const form = document.getElementById('studentForm');
  const data = Object.fromEntries(new FormData(form));
  if (!data.name) {
    showToast('请填写姓名', 'error');
    return;
  }
  try {
    DB.updateStudent(id, data);
  } catch (error) {
    showToast(`学生信息更新失败：${error.message}`, 'error');
    return;
  }
  closeModal(document.querySelector('.modal-close'));
  populateStudentClassFilter();
  renderTable();
  showToast('学生信息已更新');
}

// 查看学生详情
function viewStudent(id) {
  const s = DB.getStudentById(id);
  if (!s) return;
  const records = DB.getRecordsByStudent(id);
  const trendCharts = renderStudentFitnessTrends(records);
  const annualSummary = DB.getAnnualFitnessSummary(records, s.grade, s.gender);
  const bodyHTML = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;">
      <div class="avatar" style="width:64px;height:64px;font-size:24px;background:var(--primary);color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;">
        ${escapeStudentHTML(s.name[0])}
      </div>
      <div>
        <h2 style="font-size:22px;">${escapeStudentHTML(s.name)}</h2>
        <p style="color:var(--text-secondary);font-size:14px;">
          ${escapeStudentHTML(s.gender)} · ${escapeStudentHTML(s.grade)}${escapeStudentHTML(s.class)} · 学号: ${escapeStudentHTML(s.id)}
        </p>
      </div>
    </div>
    <div class="grid grid-3" style="margin-bottom:20px;">
      <div style="text-align:center;padding:16px;background:var(--bg-hover);border-radius:var(--radius-md);">
        <div style="font-size:24px;font-weight:800;">${escapeStudentHTML(s.height || '-')}</div>
        <div style="font-size:12px;color:var(--text-secondary);">身高(cm)</div>
      </div>
      <div style="text-align:center;padding:16px;background:var(--bg-hover);border-radius:var(--radius-md);">
        <div style="font-size:24px;font-weight:800;">${escapeStudentHTML(s.weight || '-')}</div>
        <div style="font-size:12px;color:var(--text-secondary);">体重(kg)</div>
      </div>
      <div style="text-align:center;padding:16px;background:var(--bg-hover);border-radius:var(--radius-md);">
        <div style="font-size:24px;font-weight:800;">${records.length}</div>
        <div style="font-size:12px;color:var(--text-secondary);">体测次数</div>
      </div>
    </div>
      ${s.healthNote ? `<div class="student-detail-health"><strong>健康备注：</strong><span class="badge badge-danger">${escapeStudentHTML(s.healthNote)}</span></div>` : ''}
      ${renderStudentAnnualFitnessSummary(annualSummary)}
      ${trendCharts ? `<section class="student-growth-section"><h3>体测成长趋势</h3><p>按测试时间排序；50米跑和50米×8成绩越低越好，其余项目成绩越高通常代表表现越好。</p>${trendCharts}</section>` : ''}
      ${records.length > 0 ? `
      <h3 style="margin-bottom:12px;font-size:15px;">体测成绩记录</h3>
      <table class="data-table">
        <thead><tr><th>项目</th><th>成绩</th><th>单项分 / 等级</th><th>日期</th></tr></thead>
        <tbody>
          ${records.map(r => {
            const g = DB.getGrade(r.value, r.testType, s.gender, s.grade);
            const score = DB.getFitnessScore(r.value, r.testType, s.gender, s.grade);
            return `<tr>
              <td>${escapeStudentHTML(r.testName)}</td>
              <td><strong>${escapeStudentHTML(r.value)}</strong> ${escapeStudentHTML(r.unit)}</td>
              <td>${score ? `${score.score}${score.bonus ? ` + ${score.bonus} 加分` : ''} 分 · ` : ''}<span class="badge ${escapeStudentHTML(g.class)}">${escapeStudentHTML(g.level)}</span></td>
              <td>${escapeStudentHTML(r.testDate)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    ` : '<p style="color:var(--text-tertiary);">暂无体测记录</p>'}
    ${s.guardian ? `<div style="margin-top:16px;padding:12px;background:var(--bg-hover);border-radius:var(--radius-sm);">
      <strong>监护人：</strong>${escapeStudentHTML(s.guardian)} ${s.phone ? ' · ' + escapeStudentHTML(s.phone) : ''}
    </div>` : ''}
  `;
  showModal(`${escapeStudentHTML(s.name)} - 学生档案`, bodyHTML);
}

function renderStudentAnnualFitnessSummary(summary) {
  if (!summary) return '';
  if (!summary.complete) {
    const missing = summary.missingItems.map(testType =>
      DB.FITNESS_ITEMS.find(item => item.key === testType)?.name || testType).join('、');
    return `<section class="student-annual-fitness-summary">
      <h3>国标年度总评</h3>
      <p>${summary.period ? `周期：${escapeStudentHTML(summary.period)} · ` : ''}待补测${missing ? `：${escapeStudentHTML(missing)}` : '：请补充年级或性别信息'}</p>
    </section>`;
  }
  const levelClass = summary.level === '优秀' ? 'badge-success' : summary.level === '良好' ? 'badge-info' : summary.level === '及格' ? 'badge-warning' : 'badge-danger';
  return `<section class="student-annual-fitness-summary">
    <div><h3>国标年度总评</h3><p>${escapeStudentHTML(summary.period)} · 标准分 ${summary.standardScore} 分${summary.bonus ? ` + 跳绳附加分 ${summary.bonus} 分` : ''}</p></div>
    <div class="student-annual-fitness-score"><strong>${summary.totalScore}</strong><span>分</span><span class="badge ${levelClass}">${escapeStudentHTML(summary.level)}</span></div>
  </section>`;
}

function renderStudentFitnessTrends(records) {
  return DB.FITNESS_ITEMS.map(item => {
    const points = records.filter(record =>
      record.testType === item.key && Number.isFinite(Number(record.value)))
      .sort((a, b) => (a.testDate || '').localeCompare(b.testDate || ''))
      .slice(-6);
    if (points.length < 2) return '';

    const width = 520;
    const height = 170;
    const padding = { left: 42, right: 18, top: 24, bottom: 42 };
    const values = points.map(point => Number(point.value));
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = maxValue - minValue || 1;
    const isLowerBetter = item.key === 'run50' || item.key === 'run50x8';
    const coordinates = points.map((point, index) => {
      const x = padding.left + (index * (width - padding.left - padding.right)) / (points.length - 1);
      const normalized = (Number(point.value) - minValue) / range;
      const y = isLowerBetter
        ? padding.top + normalized * (height - padding.top - padding.bottom)
        : height - padding.bottom - normalized * (height - padding.top - padding.bottom);
      return { x, y, value: point.value, label: point.semester || point.testDate || `第${index + 1}次` };
    });
    const polyline = coordinates.map(point => `${point.x},${point.y}`).join(' ');
    const circles = coordinates.map(point =>
      `<circle cx="${point.x}" cy="${point.y}" r="4" fill="#E85D04"><title>${escapeStudentHTML(point.label)}：${escapeStudentHTML(point.value)}${escapeStudentHTML(item.unit)}</title></circle>`,
    ).join('');
    const labels = coordinates.map(point =>
      `<text x="${point.x}" y="${height - 12}" text-anchor="middle">${escapeStudentHTML(point.label)}</text>`,
    ).join('');
    const first = Number(points[0].value);
    const latest = Number(points[points.length - 1].value);
    const improved = isLowerBetter ? latest < first : latest > first;
    const trendLabel = latest === first ? '与首次记录持平' : improved ? '较首次记录提升' : '较首次记录下降';
    return `
      <article class="student-growth-chart">
        <header><strong>${escapeStudentHTML(item.name)}</strong><span>${escapeStudentHTML(trendLabel)}</span></header>
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeStudentHTML(item.name)}历次体测趋势：${points.map(point => `${point.semester || point.testDate} ${point.value}${item.unit}`).map(escapeStudentHTML).join('，')}">
          <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="#D1D5DB"/>
          <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="#D1D5DB"/>
          <polyline points="${polyline}" fill="none" stroke="#E85D04" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          ${circles}${labels}
          <text x="6" y="${padding.top + 4}">${escapeStudentHTML(maxValue)}</text>
          <text x="6" y="${height - padding.bottom}">${escapeStudentHTML(minValue)}</text>
        </svg>
      </article>`;
  }).filter(Boolean).join('');
}

// 删除确认
function confirmDelete(id) {
  const s = DB.getStudentById(id);
  if (!s) return;
  const bodyHTML = `
    <p style="font-size:15px;margin-bottom:8px;">
      确定要删除学生 <strong style="color:var(--danger);">${escapeStudentHTML(s.name)}</strong>（学号: ${escapeStudentHTML(s.id)}）吗？
    </p>
    <p style="color:var(--text-secondary);font-size:13px;">
      该学生的所有体测记录也将一并删除，此操作不可撤销。
    </p>
  `;
  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-danger" onclick="deleteStudent(decodeURIComponent('${inlineStudentArg(id)}'))">确认删除</button>
  `;
  showModal('删除确认', bodyHTML, footerHTML);
}

function deleteStudent(id) {
  try {
    DB.deleteStudent(id);
    selectedStudentIds.delete(id);
    closeModal(document.querySelector('.modal-close'));
    populateStudentClassFilter();
    renderTable();
    showToast('学生已删除');
  } catch (error) {
    showToast(`学生删除失败：${error.message}`, 'error');
  }
}
