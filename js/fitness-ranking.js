'use strict';

/**
 * 体测成绩排名（体测数据模块的第三个视图）
 * ─────────────────────────────────────────────────────────────
 * 筛选器：年级 / 班级 / 性别 / 项目（互相联动）
 *   · 选年级 → 班级下拉只剩该年级的班级
 *   · 选性别 → 项目下拉只剩该性别有成绩、且该年级适用的项目
 *
 * 正逆序（核心）：不同项目的优劣方向不一样，排错方向整个榜单就废了。
 *   逆向（成绩越小越好）：50 米跑、50×8 往返跑等竞速项目
 *   正向（成绩越大越好）：跳绳、坐位体前屈、肺活量、仰卧起坐、立定跳远等
 *   判定优先级：内置项目清单 → 项目名称关键词 → 单位（单位是"秒"= 竞速 = 逆向）
 *
 * 两个排行榜：
 *   视图 A：所选班级在该项目上的学生个人排名（前三名奖牌 + 相对第一名的进度条）
 *   视图 B：所选年级各班在该项目上的平均分 / 优秀率排行（高亮当前班级及其名次）
 */

/* ======================= 状态 ======================= */

const RANKING_STATE = {
  grade: 'all',
  className: 'all',
  gender: 'all',
  testType: 'all',
};

const RANKING_GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];

/* ======================= 正逆序识别 ======================= */

/** 内置项目里"越小越好"的（竞速类） */
const FITNESS_REVERSE_TEST_KEYS = new Set(['run50', 'run50x8']);
/** 内置项目里"越大越好"的 */
const FITNESS_FORWARD_TEST_KEYS = new Set([
  'height', 'weight', 'BMI', 'sitReach', 'jumpRope', 'vitalCapacity', 'sitUps', 'standingJump',
]);
/** 名称兜底：出现这些词 = 竞速 = 逆向 */
const FITNESS_REVERSE_NAME_PATTERN = /(往返跑|米跑|冲刺|计时|赛跑|跑$)/;
/** 名称兜底：出现这些词 = 计数 / 距离类 = 正向 */
const FITNESS_FORWARD_NAME_PATTERN = /(跳绳|体前屈|肺活量|仰卧起坐|立定跳远|跳远|跳高|引体向上|卷腹|一分钟|1分钟)/;

/**
 * 判断某个体测项目的优劣方向
 * @returns {'reverse'|'forward'} reverse = 越小越好；forward = 越大越好
 */
function fitnessTestDirection(testType, testName = '', unit = '') {
  const key = String(testType || '').trim();
  if (FITNESS_REVERSE_TEST_KEYS.has(key)) return 'reverse';
  if (FITNESS_FORWARD_TEST_KEYS.has(key)) return 'forward';
  const name = String(testName || '').trim();
  if (FITNESS_REVERSE_NAME_PATTERN.test(name)) return 'reverse';
  if (FITNESS_FORWARD_NAME_PATTERN.test(name)) return 'forward';
  if (String(unit || '').trim() === '秒') return 'reverse';
  return 'forward';
}

function fitnessDirectionText(direction) {
  return direction === 'reverse' ? '↘ 越小越好' : '↗ 越大越好';
}

function rankingItemByKey(key) {
  return DB.FITNESS_ITEMS.find(item => item.key === key) || null;
}

/* ======================= 数据读取 ======================= */

/** 当前筛选范围内的学生（不含班级） */
function rankingStudentsByGrade() {
  return DB.getStudents().filter(student =>
    (RANKING_STATE.grade === 'all' || student.grade === RANKING_STATE.grade) &&
    (RANKING_STATE.gender === 'all' || student.gender === RANKING_STATE.gender));
}

/** 当前筛选范围内的学生（含班级） */
function rankingScopeStudents() {
  return rankingStudentsByGrade().filter(student =>
    RANKING_STATE.className === 'all' || student.class === RANKING_STATE.className);
}

/**
 * 取每个学生在该项目上的【最新一条】成绩
 * （同一学生可能测过多次，只用最近的一次排名）
 */
function rankingLatestRecords(students, testType) {
  const studentIds = new Set(students.map(student => student.id));
  const latest = new Map();
  DB.getFitnessRecords().forEach(record => {
    if (!studentIds.has(record.studentId)) return;
    if (testType !== 'all' && record.testType !== testType) return;
    const key = `${record.studentId}|${record.testType}`;
    const existing = latest.get(key);
    const stamp = `${record.testDate || ''}|${record.createdAt || ''}`;
    const oldStamp = existing ? `${existing.testDate || ''}|${existing.createdAt || ''}` : '';
    if (!existing || stamp > oldStamp) latest.set(key, record);
  });
  return [...latest.values()];
}

/** 把记录变成可排名的行（含等级、国标分、进度比例、名次） */
function rankingBuildRows(records) {
  const studentById = new Map(DB.getStudents().map(student => [student.id, student]));
  const rows = records.map(record => {
    const student = studentById.get(record.studentId);
    if (!student) return null;
    const value = Number(record.value);
    if (!Number.isFinite(value)) return null;
    const item = rankingItemByKey(record.testType);
    const direction = fitnessTestDirection(
      record.testType,
      record.testName || item?.name || '',
      record.unit || item?.unit || '',
    );
    const grade = DB.getGrade(value, record.testType, student.gender, student.grade);
    const score = DB.getFitnessScore(value, record.testType, student.gender, student.grade);
    return {
      record,
      student,
      value,
      unit: record.unit || item?.unit || '',
      testName: record.testName || item?.name || record.testType,
      direction,
      grade,
      score: score?.score ?? null,
      bonus: score?.bonus ?? 0,
    };
  }).filter(Boolean);

  // 排序：逆向升序（小的在前）、正向降序（大的在前）
  rows.sort((a, b) => (a.direction === 'reverse' ? a.value - b.value : b.value - a.value)
    || a.student.name.localeCompare(b.student.name, 'zh-CN'));

  // 名次：同成绩同名次，下一名跳号（1,2,2,4）
  rows.forEach((row, index) => {
    if (index > 0 && row.value === rows[index - 1].value) row.rank = rows[index - 1].rank;
    else row.rank = index + 1;
  });

  // 进度条：相对第一名的比例（逆向指标用 第一名/本人，第一名 100%）
  const best = rows.length ? rows[0].value : 0;
  rows.forEach(row => {
    let ratio = 0;
    if (row.direction === 'reverse') {
      ratio = best > 0 && row.value > 0 ? best / row.value : 0;
    } else {
      ratio = best > 0 ? row.value / best : 0;
    }
    row.ratio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  });
  return rows;
}

/* ======================= 筛选器联动 ======================= */

/** 该项目在所选年级是否适用（国标起测年级未到的项目直接过滤掉） */
function rankingItemAppliesToGrade(item, grade) {
  if (grade === 'all') return true;
  if (DB.isNationalFitnessTest(item.key, grade)) return true;
  // 国标里不适用的项目：只有"校内扩展项目"（国标表里根本没有的项目）才保留
  const isNational = ['BMI', 'run50', 'sitReach', 'jumpRope', 'vitalCapacity', 'sitUps', 'run50x8'].includes(item.key);
  return !isNational;
}

/**
 * 项目下拉的候选项：
 *   ① 年级适用（仰卧起坐三年级起、50×8 五年级起）
 *   ② 选了性别后，只留该性别确实有成绩的项目
 * 若过滤后一个都不剩，就保留全部（并标注"无数据"），保证空状态也能被看到
 */
function rankingAvailableItems() {
  const grade = RANKING_STATE.grade;
  const gender = RANKING_STATE.gender;
  const students = rankingStudentsByGrade();
  const studentIds = new Set(students.map(student => student.id));
  const recordedTypes = new Set(
    DB.getFitnessRecords().filter(record => studentIds.has(record.studentId)).map(record => record.testType),
  );

  let items = DB.FITNESS_ITEMS.filter(item => rankingItemAppliesToGrade(item, grade));
  if (gender !== 'all') {
    const withData = items.filter(item => recordedTypes.has(item.key));
    if (withData.length) items = withData;
  }
  return items;
}

/** 重建四个下拉框（保留还选得上的旧值） */
function refreshRankingFilters() {
  const gradeSelect = document.getElementById('rankingGradeFilter');
  const classSelect = document.getElementById('rankingClassFilter');
  const genderSelect = document.getElementById('rankingGenderFilter');
  const itemSelect = document.getElementById('rankingItemFilter');

  if (gradeSelect) {
    gradeSelect.innerHTML = `<option value="all">全部年级</option>`
      + RANKING_GRADES.map(grade => `<option value="${grade}">${grade}</option>`).join('');
    gradeSelect.value = RANKING_GRADES.includes(RANKING_STATE.grade) ? RANKING_STATE.grade : 'all';
  }

  if (classSelect) {
    const classes = [...new Set(rankingStudentsByGrade()
      .filter(student => RANKING_STATE.grade === 'all' || student.grade === RANKING_STATE.grade)
      .map(student => student.class).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
    classSelect.innerHTML = `<option value="all">全部班级</option>`
      + classes.map(name => `<option value="${escapeFitnessHTML(name)}">${escapeFitnessHTML(name)}</option>`).join('');
    if (!classes.includes(RANKING_STATE.className)) RANKING_STATE.className = 'all';
    classSelect.value = RANKING_STATE.className;
  }

  if (genderSelect) {
    genderSelect.innerHTML = '<option value="all">全部性别</option><option value="男">男</option><option value="女">女</option>';
    genderSelect.value = RANKING_STATE.gender;
  }

  if (itemSelect) {
    const items = rankingAvailableItems();
    // "有没有数据"按【年级 + 性别】的范围判断（不跟班级走，换班级不该改项目列表）
    const scopeIds = new Set(rankingStudentsByGrade().map(student => student.id));
    const recordedTypes = new Set(
      DB.getFitnessRecords()
        .filter(record => scopeIds.has(record.studentId))
        .map(record => record.testType),
    );
    itemSelect.innerHTML = items.map(item => {
      const hasData = recordedTypes.has(item.key);
      const direction = fitnessTestDirection(item.key, item.name, item.unit);
      return `<option value="${escapeFitnessHTML(item.key)}">`
        + `${item.icon} ${escapeFitnessHTML(item.name)}${item.unit ? `（${escapeFitnessHTML(item.unit)}）` : ''}`
        + ` · ${fitnessDirectionText(direction)}${hasData ? '' : ' · 无数据'}</option>`;
    }).join('');
    if (!items.some(item => item.key === RANKING_STATE.testType)) {
      // 默认项目优先挑【真的有成绩】的那个，别一进来就选了个空项目
      const withData = items.find(item => recordedTypes.has(item.key));
      RANKING_STATE.testType = (withData || items[0])?.key || 'all';
    }
    itemSelect.value = RANKING_STATE.testType;
  }
}

/* ======================= 视图渲染 ======================= */

function renderRankingView() {
  if (typeof destroyFitnessCharts === 'function') destroyFitnessCharts();
  const filterArea = document.getElementById('filterArea');
  if (filterArea) {
    filterArea.innerHTML = `
      <div class="ranking-filters">
        <select class="form-control" id="rankingGradeFilter" aria-label="按年级筛选" onchange="onRankingGradeChange()">
          <option value="all">全部年级</option>
        </select>
        <select class="form-control" id="rankingClassFilter" aria-label="按班级筛选" onchange="onRankingClassChange()">
          <option value="all">全部班级</option>
        </select>
        <select class="form-control" id="rankingGenderFilter" aria-label="按性别筛选" onchange="onRankingGenderChange()">
          <option value="all">全部性别</option><option value="男">男</option><option value="女">女</option>
        </select>
        <select class="form-control" id="rankingItemFilter" aria-label="按项目筛选" onchange="onRankingItemChange()">
          <option value="all">全部项目</option>
        </select>
      </div>
    `;
  }

  const container = document.getElementById('fitnessContent');
  if (!container) return;
  container.innerHTML = `
    <div class="grid grid-2 ranking-grid">
      <section class="card fade-in ranking-card">
        <div class="card-header">
          <div>
            <div class="card-title"><span>🏅</span> 班级排行榜</div>
            <div class="card-subtitle" id="rankingClassScope">选择条件后显示个人排名</div>
          </div>
          <div class="ranking-export-actions">
            <button class="btn btn-secondary" type="button" onclick="exportRankingCsv()">⬇️ 导出该班成绩表</button>
            <button class="btn btn-secondary" type="button" id="rankingExcelButton" onclick="exportRankingExcel()">⬇️ Excel</button>
          </div>
        </div>
        <div class="card-body">
          <div class="ranking-direction-tip" id="rankingDirectionTip"></div>
          <div id="rankingClassBoard"></div>
        </div>
      </section>

      <section class="card fade-in fade-in-delay-1 ranking-card">
        <div class="card-header">
          <div>
            <div class="card-title"><span>🏫</span> 年级班级排行</div>
            <div class="card-subtitle" id="rankingGradeScope">各班平均分 / 优秀率</div>
          </div>
        </div>
        <div class="card-body" style="padding:0;">
          <div id="rankingGradeBoard"></div>
        </div>
      </section>
    </div>
  `;

  refreshRankingFilters();
  renderRankingBoards();
}

/** 视图 A + 视图 B 一起渲染 */
function renderRankingBoards() {
  renderRankingClassBoard();
  renderRankingGradeBoard();
}

/* -------------------- 视图 A：班级个人排名 -------------------- */

function rankingCurrentRows() {
  const students = rankingScopeStudents();
  const records = rankingLatestRecords(students, RANKING_STATE.testType);
  return rankingBuildRows(records);
}

function renderRankingClassBoard() {
  const board = document.getElementById('rankingClassBoard');
  const scope = document.getElementById('rankingClassScope');
  const tip = document.getElementById('rankingDirectionTip');
  if (!board) return;

  const item = rankingItemByKey(RANKING_STATE.testType);
  if (!item) {
    board.innerHTML = rankingEmptyState('📋', '请先选择要排名的体测项目。');
    if (scope) scope.textContent = '选择条件后显示个人排名';
    return;
  }

  const direction = fitnessTestDirection(item.key, item.name, item.unit);
  if (tip) {
    tip.innerHTML = `<strong>${escapeFitnessHTML(item.name)}</strong>：${fitnessDirectionText(direction)}`
      + `<span class="ranking-direction-note">（${direction === 'reverse'
        ? '秒数越少越好，进度条按与第一名的比值计算'
        : '数值越大越好，进度条按与第一名的比值计算'}）</span>`;
  }

  const rows = rankingCurrentRows();
  const classText = RANKING_STATE.className === 'all' ? '全部班级' : RANKING_STATE.className;
  const gradeText = RANKING_STATE.grade === 'all' ? '全部年级' : RANKING_STATE.grade;
  if (scope) {
    scope.textContent = rows.length
      ? `${gradeText} · ${classText} · ${RANKING_STATE.gender === 'all' ? '男女合计' : `${RANKING_STATE.gender}生`} · 共 ${rows.length} 人有成绩`
      : `${gradeText} · ${classText}`;
  }

  if (!rows.length) {
    board.innerHTML = rankingEmptyState('📭', rankingEmptyText());
    return;
  }

  board.innerHTML = `
    <div class="table-responsive">
      <table class="data-table ranking-table">
        <thead>
          <tr>
            <th style="width:64px;">名次</th>
            <th>姓名</th>
            <th style="width:104px;">成绩</th>
            <th style="width:96px;">等级</th>
            <th style="width:140px;">相对第一名</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => rankingRowHTML(row)).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function rankingRowHTML(row) {
  const medal = row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : '';
  const color = row.rank === 1 ? '#F5B301' : row.rank === 2 ? '#9AA5B1' : row.rank === 3 ? '#C08457' : 'var(--primary)';
  const percent = Math.round(row.ratio * 100);
  const scoreText = row.score === null ? '—' : `${row.score}${row.bonus ? `+${row.bonus}` : ''} 分`;
  return `
    <tr class="${row.rank <= 3 ? 'ranking-top-row' : ''}">
      <td class="ranking-rank"><span class="ranking-rank-medal">${medal}</span>${row.rank}</td>
      <td>
        <strong>${escapeFitnessHTML(row.student.name)}</strong>
        <span class="fitness-record-subtext">${escapeFitnessHTML(row.student.id)} · ${escapeFitnessHTML(row.student.grade)}${escapeFitnessHTML(row.student.class)}</span>
      </td>
      <td><strong style="color:var(--primary);font-size:15px;">${escapeFitnessHTML(row.value)}</strong> ${escapeFitnessHTML(row.unit)}</td>
      <td>
        <span class="badge ${escapeFitnessHTML(row.grade.class)}">${escapeFitnessHTML(row.grade.level)}</span>
        <span class="fitness-record-subtext">${escapeFitnessHTML(scoreText)}</span>
      </td>
      <td>
        <div class="ranking-bar"><span class="ranking-bar-fill" style="width:${percent}%;background:${color};"></span></div>
        <span class="fitness-record-subtext">${percent}%</span>
      </td>
    </tr>
  `;
}

/* -------------------- 视图 B：年级班级排行 -------------------- */

function renderRankingGradeBoard() {
  const board = document.getElementById('rankingGradeBoard');
  const scope = document.getElementById('rankingGradeScope');
  if (!board) return;

  const item = rankingItemByKey(RANKING_STATE.testType);
  if (!item) {
    board.innerHTML = rankingEmptyState('📋', '请先选择要排名的体测项目。');
    if (scope) scope.textContent = '各班平均分 / 优秀率';
    return;
  }

  const students = rankingStudentsByGrade();
  const records = rankingLatestRecords(students, RANKING_STATE.testType);
  const rows = rankingBuildRows(records);

  // 按 班级（年级 + 班号）分组统计
  const groups = new Map();
  rows.forEach(row => {
    const key = `${row.student.grade}|${row.student.class}`;
    if (!groups.has(key)) {
      groups.set(key, {
        grade: row.student.grade,
        className: row.student.class,
        rows: [],
        scoreTotal: 0,
        scoreCount: 0,
        valueTotal: 0,
      });
    }
    const group = groups.get(key);
    group.rows.push(row);
    group.valueTotal += row.value;
    if (row.score !== null) {
      group.scoreTotal += row.score;
      group.scoreCount += 1;
    }
  });

  const summaries = [...groups.values()].map(group => {
    const avgValue = group.rows.length ? group.valueTotal / group.rows.length : 0;
    const avgScore = group.scoreCount ? group.scoreTotal / group.scoreCount : null;
    const excellent = group.rows.filter(row => row.grade?.level === '优秀').length;
    const excellentRate = group.rows.length ? Math.round(excellent / group.rows.length * 100) : 0;
    const direction = group.rows[0]?.direction || 'forward';
    return {
      ...group,
      avgValue,
      avgScore,
      excellent,
      excellentRate,
      direction,
      label: `${group.grade}${group.className}`,
    };
  });

  // 排序：有国标分按平均国标分降序；否则按平均原始成绩（按方向）排
  const useScore = summaries.some(summary => summary.avgScore !== null);
  summaries.sort((a, b) => {
    if (useScore) return (b.avgScore ?? -1) - (a.avgScore ?? -1);
    return a.direction === 'reverse' ? a.avgValue - b.avgValue : b.avgValue - a.avgValue;
  });
  summaries.forEach((summary, index) => { summary.rank = index + 1; });

  // 进度条：与第一名的比值
  const bestValue = summaries.length ? (useScore ? summaries[0].avgScore : summaries[0].avgValue) : 0;
  summaries.forEach(summary => {
    const value = useScore ? (summary.avgScore ?? 0) : summary.avgValue;
    let ratio = 0;
    if (useScore) ratio = bestValue > 0 ? value / bestValue : 0;
    else if (summary.direction === 'reverse') ratio = bestValue > 0 && value > 0 ? bestValue / value : 0;
    else ratio = bestValue > 0 ? value / bestValue : 0;
    summary.ratio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  });

  // 只有明确选了某个班级时才高亮（"全部班级"下高亮第一行会误导）
  const current = RANKING_STATE.className === 'all' ? null : summaries.find(summary =>
    (RANKING_STATE.grade === 'all' || summary.grade === RANKING_STATE.grade)
    && summary.className === RANKING_STATE.className);

  if (scope) {
    scope.textContent = summaries.length
      ? `${RANKING_STATE.grade === 'all' ? '全部年级' : RANKING_STATE.grade} · ${item.name} · 按${useScore ? '平均国标分' : '平均成绩'}排序`
      : '各班平均分 / 优秀率';
  }

  if (!summaries.length) {
    board.innerHTML = rankingEmptyState('📭', rankingEmptyText());
    return;
  }

  board.innerHTML = `
    <div class="table-responsive">
      <table class="data-table ranking-table">
        <thead>
          <tr>
            <th style="width:56px;">名次</th>
            <th>班级</th>
            <th style="width:60px;">人数</th>
            <th style="width:96px;">平均成绩</th>
            <th style="width:88px;">平均分</th>
            <th style="width:88px;">优秀率</th>
            <th style="width:104px;">对比第一</th>
          </tr>
        </thead>
        <tbody>
          ${summaries.map(summary => {
            const isCurrent = Boolean(current
              && current.grade === summary.grade
              && current.className === summary.className);
            const medal = summary.rank === 1 ? '🥇' : summary.rank === 2 ? '🥈' : summary.rank === 3 ? '🥉' : '';
            const percent = Math.round(summary.ratio * 100);
            return `
              <tr class="${isCurrent ? 'ranking-current-row' : ''}">
                <td class="ranking-rank"><span class="ranking-rank-medal">${medal}</span>${summary.rank}</td>
                <td>
                  <strong>${escapeFitnessHTML(summary.label)}</strong>
                  ${isCurrent ? `<span class="badge badge-primary ranking-current-badge">当前班级 · 第 ${summary.rank} 名</span>` : ''}
                </td>
                <td>${summary.rows.length}</td>
                <td>${escapeFitnessHTML(summary.avgValue.toFixed(1))} ${escapeFitnessHTML(item.unit || '')}</td>
                <td>${summary.avgScore === null ? '—' : escapeFitnessHTML(summary.avgScore.toFixed(1))}</td>
                <td>${summary.excellentRate}%<span class="fitness-record-subtext">${summary.excellent}/${summary.rows.length}</span></td>
                <td>
                  <div class="ranking-bar"><span class="ranking-bar-fill" style="width:${percent}%;background:var(--primary);"></span></div>
                  <span class="fitness-record-subtext">${percent}%</span>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/* ======================= 空状态 ======================= */

function rankingEmptyText() {
  const item = rankingItemByKey(RANKING_STATE.testType);
  const itemText = item ? item.name : '该项目';
  const classText = RANKING_STATE.className === 'all' ? '当前筛选范围' : RANKING_STATE.className;
  return `${classText}暂无${itemText}的成绩记录。可先到「成绩列表」录入成绩，再回到这里看排名。`;
}

function rankingEmptyState(icon, text) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><p>${escapeFitnessHTML(text)}</p></div>`;
}

/* ======================= 筛选交互 ======================= */

function onRankingGradeChange() {
  RANKING_STATE.grade = document.getElementById('rankingGradeFilter')?.value || 'all';
  RANKING_STATE.className = 'all';     // 年级变了，班级要跟着重选
  refreshRankingFilters();
  renderRankingBoards();
}

function onRankingClassChange() {
  RANKING_STATE.className = document.getElementById('rankingClassFilter')?.value || 'all';
  renderRankingBoards();
}

function onRankingGenderChange() {
  RANKING_STATE.gender = document.getElementById('rankingGenderFilter')?.value || 'all';
  RANKING_STATE.className = 'all';     // 性别变了，原班级可能不适用
  refreshRankingFilters();
  renderRankingBoards();
}

function onRankingItemChange() {
  RANKING_STATE.testType = document.getElementById('rankingItemFilter')?.value || 'all';
  renderRankingBoards();
}

/* ======================= 导出 ======================= */

function rankingCsvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function rankingExportRows() {
  const rows = rankingCurrentRows();
  const item = rankingItemByKey(RANKING_STATE.testType);
  const header = ['名次', '学号', '姓名', '性别', '年级', '班级', '项目', '成绩', '单位', '等级', '国标分', '测试日期'];
  const body = rows.map(row => [
    row.rank,
    row.student.id,
    row.student.name,
    row.student.gender,
    row.student.grade,
    row.student.class,
    item?.name || row.testName,
    row.value,
    row.unit,
    row.grade?.level || '',
    row.score === null ? '' : `${row.score}${row.bonus ? `+${row.bonus}` : ''}`,
    row.record.testDate || '',
  ]);
  return { header, body, item, rows };
}

function rankingExportFilename(extension) {
  const item = rankingItemByKey(RANKING_STATE.testType);
  const parts = ['体测成绩排名'];
  if (RANKING_STATE.grade !== 'all') parts.push(RANKING_STATE.grade);
  if (RANKING_STATE.className !== 'all') parts.push(RANKING_STATE.className);
  if (item) parts.push(item.name);
  parts.push(new Date().toISOString().slice(0, 10));
  return `${parts.join('_')}.${extension}`;
}

/** 导出当前班级的成绩表（CSV，带 BOM，Excel / WPS 直接打开） */
function exportRankingCsv() {
  const { header, body } = rankingExportRows();
  if (!body.length) {
    showToast('当前条件下没有可导出的成绩记录', 'error');
    return;
  }
  const content = [header, ...body].map(row => row.map(rankingCsvCell).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = rankingExportFilename('csv');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`已导出 ${body.length} 条成绩记录`, 'success');
}

/** 导出 Excel（依赖页面上已加载的 xlsx 组件；没加载时提示改用 CSV） */
function exportRankingExcel() {
  const { header, body } = rankingExportRows();
  if (!body.length) {
    showToast('当前条件下没有可导出的成绩记录', 'error');
    return;
  }
  if (typeof XLSX === 'undefined') {
    showToast('Excel 组件未加载，请改用【导出该班成绩表】的 CSV 版本', 'error');
    return;
  }
  const worksheet = XLSX.utils.aoa_to_sheet([header, ...body]);
  worksheet['!cols'] = [
    { wch: 6 }, { wch: 12 }, { wch: 10 }, { wch: 6 }, { wch: 10 }, { wch: 12 },
    { wch: 16 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 14 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '成绩排名');
  XLSX.writeFile(workbook, rankingExportFilename('xlsx'));
  showToast(`已导出 ${body.length} 条成绩记录`, 'success');
}

/* ======================= 启动兜底 ======================= */

/* 本文件在 fitness.js 之后加载：万一 store 在 fitness.js 注册回调时就已经就绪，
   首次 renderView() 可能发生在本文件加载之前 —— 此时补渲染一次排名视图。 */
if (typeof fitnessView !== 'undefined' && fitnessView === 'ranking') {
  Store.onReady(() => {
    if (typeof renderRankingView === 'function') renderRankingView();
  });
}
