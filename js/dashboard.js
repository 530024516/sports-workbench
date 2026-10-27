/**
 * 工作台首页 - 仪表盘
 * 包含：统计卡片、可编辑周课表、待办清单、数据看板
 */

Layout.init('dashboard', '工作台首页', '首页');

const content = document.getElementById('page-content');

// ===== 常量 =====
const SCHEDULE_DAYS = ['周一', '周二', '周三', '周四', '周五'];
const SCHEDULE_PERIODS = ['第1节', '第2节', '第3节', '第4节', '第5节', '第6节', '第7节', '第8节'];
const LESSON_TYPES = {
  basketball: '篮球', track: '田径', rope: '跳绳',
  fitness: '体适能', ball: '球类', default: '其他',
};
const LESSON_COLORS = {
  basketball: 'basketball', track: 'track', rope: 'rope',
  fitness: 'fitness', ball: 'ball', default: 'default',
};
const WEEK_MODES = { odd: '单周', even: '双周' };

// key 格式: 周次::星期::节次
function lessonKey(mode, day, period) { return mode + '::' + day + '::' + period; }

function getWeekDates() {
  const today = new Date();
  const dow = today.getDay(); // 0=周日
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  const dates = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(`${d.getMonth() + 1}/${d.getDate()}`);
  }
  return dates;
}

// ===== 数据（云端数据就绪后会重新拉取并重绘，见文件末尾）=====
let students = DB.getStudents();
let fitnessRecords = DB.getFitnessRecords();
let lessonPlans = DB.getLessonPlans();
const weekDates = getWeekDates();
const todayDow = new Date().getDay();
const todayDayName = todayDow >= 1 && todayDow <= 5 ? SCHEDULE_DAYS[todayDow - 1] : '';

let pendingLessons = lessonPlans.filter(p => p.status === '待上课');

let scheduleData = DB.getSchedule();
let todos = DB.getTodos();
let currentWeekMode = DB.getWeekMode();

/** 重新从 DB 取数（Store 就绪 / 云端同步完成后调用） */
function refreshDashboardData() {
  students = DB.getStudents();
  fitnessRecords = DB.getFitnessRecords();
  lessonPlans = DB.getLessonPlans();
  pendingLessons = lessonPlans.filter(p => p.status === '待上课');
  scheduleData = DB.getSchedule();
  todos = DB.getTodos();
  currentWeekMode = DB.getWeekMode();
}

/** 只刷新统计数字与欢迎语里的数字，不重建 DOM（避免打断用户操作） */
function renderDashboardStats() {
  const setText = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = String(value);
  };
  setText('statStudents', students.length);
  setText('statFitnessRecords', fitnessRecords.length);
  setText('statLessonPlans', lessonPlans.length);
  setText('statPendingLessons', pendingLessons.length);
  setText('statTodayLessons', Object.keys(scheduleData)
    .filter(k => k.startsWith(currentWeekMode + '::' + todayDayName + '::')).length);
  setText('statPendingTodos', todos.filter(t => !t.done).length);
}

// ===== 渲染首页 =====
content.innerHTML = `
  <!-- 欢迎区 -->
  <div class="fade-in" style="margin-bottom: 24px;">
    <div style="display:flex;align-items:center;gap:16px;">
      <div style="font-size:48px;">🏃</div>
      <div>
        <h1 style="font-size:26px;font-weight:800;">欢迎回来，<span id="dashboardGreetingName">${escapeHtml(Layout.getDisplaySettings().teacherName)}</span>！</h1>
        <p style="color:var(--text-secondary);font-size:14px;margin-top:4px;">
          今天有 <strong id="statTodayLessons" style="color:var(--primary);">${Object.keys(scheduleData).filter(k => k.startsWith(currentWeekMode + '::' + todayDayName + '::')).length}</strong> 节课，
          待办事项 <strong id="statPendingTodos" style="color:var(--primary);">${todos.filter(t => !t.done).length}</strong> 项待处理
        </p>
      </div>
    </div>
  </div>

  <!-- 统计卡片 -->
  <div class="grid grid-4" style="margin-bottom:24px;">
    <div class="stat-card fade-in fade-in-delay-1" style="cursor:pointer;" onclick="location.href='students.html'">
      <div class="stat-icon" style="background:var(--primary-100);color:var(--primary);">👥</div>
      <div class="stat-content">
        <h3 id="statStudents">${students.length}</h3>
        <p>在校学生总数</p>
      </div>
    </div>
    <div class="stat-card fade-in fade-in-delay-2" style="cursor:pointer;" onclick="location.href='fitness.html'">
      <div class="stat-icon" style="background:var(--info-light);color:#0288D1;">💪</div>
      <div class="stat-content">
        <h3 id="statFitnessRecords">${fitnessRecords.length}</h3>
        <p>体测记录条数</p>
      </div>
    </div>
    <div class="stat-card fade-in fade-in-delay-3" style="cursor:pointer;" onclick="location.href='lessons.html'">
      <div class="stat-icon" style="background:var(--success-light);color:var(--success);">📋</div>
      <div class="stat-content">
        <h3 id="statLessonPlans">${lessonPlans.length}</h3>
        <p>教案总数</p>
      </div>
    </div>
    <div class="stat-card fade-in fade-in-delay-4" style="cursor:pointer;" onclick="location.href='lessons.html'">
      <div class="stat-icon" style="background:var(--warning-light);color:#B8860B;">⏰</div>
      <div class="stat-content">
        <h3 id="statPendingLessons">${pendingLessons.length}</h3>
        <p>待上课教案</p>
      </div>
    </div>
  </div>

  <!-- 主体：周课表 + 待办清单 -->
  <div class="grid" style="grid-template-columns:1.7fr 1fr;margin-bottom:24px;">
    <!-- 可编辑周课表 -->
    <div class="card fade-in fade-in-delay-2">
      <div class="card-header">
        <div class="card-title"><span>📅</span> 本周课表</div>
        <div class="schedule-week-switch">
          <button class="week-btn ${currentWeekMode === 'odd' ? 'active' : ''}" onclick="switchWeekMode('odd')">单周</button>
          <button class="week-btn ${currentWeekMode === 'even' ? 'active' : ''}" onclick="switchWeekMode('even')">双周</button>
        </div>
      </div>
      <div class="card-body">
        <div class="schedule-grid" id="scheduleGrid"></div>
      </div>
    </div>

    <!-- 待办清单 -->
    <div class="card fade-in fade-in-delay-3">
      <div class="card-header">
        <div class="card-title"><span>✅</span> 待办清单</div>
      </div>
      <div class="card-body">
        <!-- 输入区 -->
        <div class="todo-input-row">
          <input type="text" id="todoInput" placeholder="输入待办事项，如：明天收体测表" onkeydown="if(event.key==='Enter')handleAddTodo()">
          <select id="todoPriority" aria-label="待办优先级">
            <option value="high">高优先级</option>
            <option value="medium" selected>中优先级</option>
            <option value="low">低优先级</option>
          </select>
          <button onclick="handleAddTodo()">添加</button>
        </div>
        <!-- 统计 -->
        <div class="todo-stats" id="todoStats"></div>
        <!-- 列表 -->
        <ul class="todo-list" id="todoList"></ul>
      </div>
    </div>
  </div>

  <!-- 数据看板 -->
  <div class="grid" style="grid-template-columns:1fr 1fr;">
    <div class="card fade-in fade-in-delay-3">
      <div class="card-header">
        <div class="card-title"><span>📊</span> 体测成绩等级分布</div>
      </div>
      <div class="card-body">
        <canvas id="chartGrade" height="200"></canvas>
      </div>
    </div>
    <div class="card fade-in fade-in-delay-4">
      <div class="card-header">
        <div class="card-title"><span>🏫</span> 各年级学生分布</div>
      </div>
      <div class="card-body">
        <canvas id="chartGradeStudents" height="200"></canvas>
      </div>
    </div>
  </div>
`;

// ==================== 周课表 ====================
function renderSchedule() {
  const grid = document.getElementById('scheduleGrid');
  let html = '';

  SCHEDULE_DAYS.forEach((day, di) => {
    const isToday = day === todayDayName;
    html += `<div class="day-column">`;
    html += `<div class="day-header ${isToday ? 'today' : ''}">
      <div>${day}</div>
      <div class="day-date">${weekDates[di]}</div>
    </div>`;

    SCHEDULE_PERIODS.forEach(period => {
      const key = lessonKey(currentWeekMode, day, period);
      const lesson = scheduleData[key];
      if (lesson) {
        const colorClass = 'lesson-color-' + (LESSON_COLORS[lesson.type] || 'default');
        const typeLabel = LESSON_TYPES[lesson.type] || '其他';
        html += `
          <div class="lesson-card ${colorClass}" onclick="openLessonModal('${key}')">
            <div class="lesson-period">${period}</div>
            <div class="lesson-class">${lesson.class}</div>
            <div class="lesson-content">${lesson.content}</div>
            <div class="lesson-location">📍 ${lesson.location} · ${typeLabel}</div>
          </div>
        `;
      } else {
        html += `
          <div class="lesson-empty" onclick="openLessonModal('${key}')">
            ${period}<br>— —
          </div>
        `;
      }
    });

    html += `</div>`;
  });

  grid.innerHTML = html;
}

// 单双周切换
function switchWeekMode(mode) {
  currentWeekMode = mode;
  DB.setWeekMode(mode);
  // 更新按钮状态
  document.querySelectorAll('.week-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === WEEK_MODES[mode]);
  });
  renderSchedule();
}

// 课表编辑弹窗
function openLessonModal(key) {
  const lesson = scheduleData[key];
  const parts = key.split('::');
  const mode = parts[0];
  const day = parts[1];
  const period = parts[2];

  // 检查该课在另一个周次是否也有相同数据
  const otherMode = mode === 'odd' ? 'even' : 'odd';
  const otherKey = lessonKey(otherMode, day, period);
  const otherLesson = scheduleData[otherKey];
  const bothWeeks = lesson && otherLesson &&
    otherLesson.class === lesson.class &&
    otherLesson.content === lesson.content &&
    otherLesson.location === lesson.location &&
    otherLesson.type === lesson.type;

  const bodyHTML = `
    <form id="lessonForm" onsubmit="return false;">
      <input type="hidden" id="lessonKey" value="${key}">
      <div class="form-group">
        <label>周次 <span class="required">*</span></label>
        <div class="week-checkbox-group">
          <label class="week-checkbox">
            <input type="checkbox" id="weekOdd" ${mode === 'odd' || bothWeeks ? 'checked' : ''}>
            <span>单周</span>
          </label>
          <label class="week-checkbox">
            <input type="checkbox" id="weekEven" ${mode === 'even' || bothWeeks ? 'checked' : ''}>
            <span>双周</span>
          </label>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>星期</label>
          <select class="form-control" id="lessonDay">
            ${SCHEDULE_DAYS.map(d => `<option value="${d}" ${d === day ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>节次</label>
          <select class="form-control" id="lessonPeriod">
            ${SCHEDULE_PERIODS.map(p => `<option value="${p}" ${p === period ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>班级名称 <span class="required">*</span></label>
        <input class="form-control" id="lessonClass" value="${lesson?.class || ''}" placeholder="如：四年级1班">
      </div>
      <div class="form-group">
        <label>课程内容 <span class="required">*</span></label>
        <input class="form-control" id="lessonContent" value="${lesson?.content || ''}" placeholder="如：篮球运球">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>场地</label>
          <input class="form-control" id="lessonLocation" value="${lesson?.location || ''}" placeholder="如：篮球场">
        </div>
        <div class="form-group">
          <label>类型</label>
          <select class="form-control" id="lessonType">
            ${Object.entries(LESSON_TYPES).map(([val, label]) =>
              `<option value="${val}" ${lesson?.type === val ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </div>
      </div>
    </form>
  `;

  const footerHTML = `
    ${lesson ? `<button class="btn btn-danger btn-sm" onclick="handleDeleteLesson()" style="margin-right:auto;">删除课程</button>` : ''}
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="handleSaveLesson()">保存</button>
  `;

  showModal(lesson ? '编辑课程' : '添加课程', bodyHTML, footerHTML);
}

function handleSaveLesson() {
  const oldKey = document.getElementById('lessonKey').value;
  const day = document.getElementById('lessonDay').value;
  const period = document.getElementById('lessonPeriod').value;
  const className = document.getElementById('lessonClass').value.trim();
  const contentVal = document.getElementById('lessonContent').value.trim();
  const location = document.getElementById('lessonLocation').value.trim();
  const type = document.getElementById('lessonType').value;
  const wantOdd = document.getElementById('weekOdd').checked;
  const wantEven = document.getElementById('weekEven').checked;

  if (!className || !contentVal) {
    showToast('请填写班级和课程内容', 'error');
    return;
  }
  if (!wantOdd && !wantEven) {
    showToast('请至少选择一个周次', 'error');
    return;
  }

  // 解析旧 key
  const oldParts = oldKey.split('::');
  const oldMode = oldParts[0];
  const oldDay = oldParts[1] || day;
  const oldPeriod = oldParts[2] || period;

  // 计算旧位置单/双周两个 key
  const oldOddKey = lessonKey('odd', oldDay, oldPeriod);
  const oldEvenKey = lessonKey('even', oldDay, oldPeriod);
  // 新位置单/双周两个 key
  const newOddKey = lessonKey('odd', day, period);
  const newEvenKey = lessonKey('even', day, period);

  // 编辑前旧位置是否两个周次都有
  const oldHasOdd = scheduleData[oldOddKey] !== undefined;
  const oldHasEven = scheduleData[oldEvenKey] !== undefined;
  // 如果两个周次有完全相同的课，说明是"同时排"的，需要同步删除
  const wasLinked = oldHasOdd && oldHasEven &&
    JSON.stringify(scheduleData[oldOddKey]) === JSON.stringify(scheduleData[oldEvenKey]);

  // 清理旧位置
  if (wasLinked) {
    // 两个周次是关联的（一起排的），一起删
    delete scheduleData[oldOddKey];
    delete scheduleData[oldEvenKey];
  } else {
    // 只删当前编辑的那个
    delete scheduleData[lessonKey(oldMode, oldDay, oldPeriod)];
  }

  // 写入选中的周次
  const lessonObj = { class: className, content: contentVal, location, type };
  if (wantOdd) scheduleData[newOddKey] = { ...lessonObj };
  if (wantEven) scheduleData[newEvenKey] = { ...lessonObj };

  DB.saveSchedule(scheduleData);
  renderSchedule();
  closeModal(document.querySelector('.modal-close'));
  showToast('课表已保存');
}

function handleDeleteLesson() {
  const key = document.getElementById('lessonKey').value;
  const parts = key.split('::');
  const mode = parts[0];
  const day = parts[1];
  const period = parts[2];

  const oddKey = lessonKey('odd', day, period);
  const evenKey = lessonKey('even', day, period);
  const oddLesson = scheduleData[oddKey];
  const evenLesson = scheduleData[evenKey];

  // 如果单双周完全一样（一起排的），两个都删
  if (oddLesson && evenLesson && JSON.stringify(oddLesson) === JSON.stringify(evenLesson)) {
    delete scheduleData[oddKey];
    delete scheduleData[evenKey];
    showToast('单周和双周的课程已一起删除');
  } else {
    // 只删当前这个
    delete scheduleData[key];
    showToast('课程已删除');
  }

  DB.saveSchedule(scheduleData);
  renderSchedule();
  closeModal(document.querySelector('.modal-close'));
}

// ==================== 待办清单 ====================
function renderTodos() {
  const list = document.getElementById('todoList');
  const stats = document.getElementById('todoStats');

  todos = DB.getTodos();
  const total = todos.length;
  const done = todos.filter(t => t.done).length;
  const pending = total - done;

  stats.innerHTML = `
    <span class="todo-stat total">共 ${total} 项</span>
    <span class="todo-stat done">已完成 ${done}</span>
    <span class="todo-stat pending">待处理 ${pending}</span>
  `;

  if (todos.length === 0) {
    list.innerHTML = `
      <div class="todo-empty">
        <div class="empty-icon">📝</div>
        <p>暂无待办事项，添加一个吧！</p>
      </div>
    `;
    return;
  }

  list.innerHTML = todos.map(t => `
    <li class="todo-item ${t.done ? 'done' : ''}">
      <div class="todo-checkbox" onclick="handleToggleTodo(${t.id})"></div>
      <div class="todo-text">${escapeHtml(t.text)}</div>
      <span class="todo-priority ${['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium'}">${{high: '高', medium: '中', low: '低'}[t.priority] || '中'}</span>
      <span class="todo-meta">${t.time}</span>
      <button class="todo-delete" onclick="handleDeleteTodo(${t.id})" title="删除">✕</button>
    </li>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function handleAddTodo() {
  const input = document.getElementById('todoInput');
  const priority = document.getElementById('todoPriority').value;
  const text = input.value.trim();
  if (!text) {
    showToast('请输入待办内容', 'error');
    return;
  }
  DB.addTodo(text, priority);
  input.value = '';
  document.getElementById('todoPriority').value = 'medium';
  renderTodos();
  showToast('待办已添加');
}

function handleToggleTodo(id) {
  DB.toggleTodo(id);
  renderTodos();
}

function handleDeleteTodo(id) {
  DB.deleteTodo(id);
  renderTodos();
  showToast('待办已删除');
}

// ==================== 图表 ====================
const gradeColors = {
  '优秀': '#06A77D', '良好': '#48CAE4', '及格': '#FFB703', '不及格': '#D62828',
  '正常': '#06A77D', '偏瘦': '#FFB703', '偏胖': '#D62828',
};

let gradeChart = null;
let gradeStudentsChart = null;

/** 按当前数据重绘两张图（首次和 Store 就绪后各调一次） */
function renderCharts() {
  const gradeCounts = { '优秀': 0, '良好': 0, '及格': 0, '不及格': 0, '正常': 0, '偏瘦': 0, '偏胖': 0 };
  fitnessRecords.forEach(r => {
    const student = students.find(s => s.id === r.studentId);
    if (!student) return;
    const g = DB.getGrade(r.value, r.testType, student.gender);
    if (gradeCounts[g.level] !== undefined) gradeCounts[g.level]++;
  });

  const gradeLabels = Object.keys(gradeCounts).filter(k => gradeCounts[k] > 0);
  const gradeValues = gradeLabels.map(k => gradeCounts[k]);

  const gradeOrder = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];
  const gradeStudentCounts = gradeOrder.map(g => students.filter(s => s.grade === g).length);

  const canvasGrade = document.getElementById('chartGrade');
  const canvasStudents = document.getElementById('chartGradeStudents');
  if (!canvasGrade || !canvasStudents) return;

  if (gradeChart) gradeChart.destroy();
  if (gradeStudentsChart) gradeStudentsChart.destroy();

  gradeChart = new Chart(canvasGrade, {
    type: 'doughnut',
    data: {
      labels: gradeLabels,
      datasets: [{
        data: gradeValues,
        backgroundColor: gradeLabels.map(l => gradeColors[l] || '#999'),
        borderWidth: 2,
        borderColor: '#fff',
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 12 } } },
      }
    }
  });

  gradeStudentsChart = new Chart(canvasStudents, {
    type: 'bar',
    data: {
      labels: gradeOrder,
      datasets: [{
        label: '学生人数',
        data: gradeStudentCounts,
        backgroundColor: 'rgba(232,93,4,0.7)',
        borderColor: '#E85D04',
        borderWidth: 2,
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 } },
      }
    }
  });
}

// ==================== 初始渲染 ====================
// 首屏先用已有数据画一次（可能为空），云端数据回来后整体重绘
renderDashboardStats();
renderCharts();

Store.onReady(() => {
  refreshDashboardData();
  renderDashboardStats();
  renderSchedule();
  renderTodos();
  renderCharts();
});
