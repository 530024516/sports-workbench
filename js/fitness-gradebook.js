/**
 * 体测成绩册（紧凑版）
 * ─────────────────────────────────────────────────────────────
 * ① 一行一个学生、一格一个项目：格子里【上面是原始成绩、下面是国标折算分】，
 *    不再拆成"成绩列 + 得分列"两列 —— 列数少一半，表格极其紧凑。
 * ② 自动算分：单项分走 DB.getFitnessScore（2014 年修订版国标），
 *    总分走国标加权公式（各年级权重不同）+ 1 分钟跳绳加分，再换算等级。
 * ③ 总成绩排序：默认按总分从高到低，点表头可切换升 / 降序。
 * ④ 弱项分列：弱项列直接写清楚是哪几项不及格，全及格就显示"—"。
 * ⑤ 弱项分布图：成绩册上方那张横向堆叠条形图（未达标 / 拖后腿 / 正常）。
 *
 * 本文件独立于 fitness.js（fitness.js 已经很长了）；
 * 页面里引在 fitness.js 之前 —— 因为 fitness.js 首次渲染成绩列表时就要用到这里的函数。
 */
'use strict';

/* ==========================================================================
 * 一、状态与列定义
 * ========================================================================== */

/** 成绩列表的状态：筛选条件 + 排序 */
const FITNESS_GRADEBOOK_STATE = {
  grade: 'all',
  className: 'all',
  search: '',
  sort: 'desc',   // 总成绩排序：desc = 高的排前面（默认）；asc = 低的排前面
};

/**
 * 成绩册的项目列。
 * 前 7 个是固定列（老师最常看的），后面 3 个标了 extra —— 只在【当前范围真的有数据】
 * 时才追加显示（低年级不测仰卧起坐 / 50×8，就不会凭空多出两列）。
 */
const FITNESS_GRADEBOOK_COLUMNS = [
  { key: 'height', name: '身高', unit: 'cm', scored: false },
  { key: 'weight', name: '体重', unit: 'kg', scored: false },
  { key: 'BMI', name: 'BMI', unit: '', scored: true },
  { key: 'vitalCapacity', name: '肺活量', unit: 'ml', scored: true },
  { key: 'run50', name: '50米跑', unit: '秒', scored: true },
  { key: 'sitReach', name: '坐位体前屈', unit: 'cm', scored: true },
  { key: 'jumpRope', name: '一分钟跳绳', unit: '个', scored: true },
  { key: 'sitUps', name: '1分钟仰卧起坐', unit: '个', scored: true, extra: true },
  { key: 'run50x8', name: '50米×8往返跑', unit: '秒', scored: true, extra: true },
  { key: 'standingJump', name: '立定跳远', unit: 'cm', scored: true, extra: true },
];

/** 总分等级对应的徽章样式 */
const FITNESS_GRADEBOOK_LEVEL_CLASS = {
  优秀: 'badge-success',
  良好: 'badge-info',
  及格: 'badge-warning',
  不及格: 'badge-danger',
};

/* ==========================================================================
 * 二、工具函数
 * ========================================================================== */

function fitnessGradebookEscape(value) {
  if (typeof escapeFitnessHTML === 'function') return escapeFitnessHTML(value);
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

/** 项目 key → 中文名 */
function fitnessGradebookItemName(key) {
  const column = FITNESS_GRADEBOOK_COLUMNS.find(entry => entry.key === key);
  if (column) return column.name;
  const item = (DB.FITNESS_ITEMS || []).find(entry => entry.key === key);
  return item?.name || key;
}

/** 总分 → 等级（国标：≥90 优秀 / ≥80 良好 / ≥60 及格 / 其余不及格） */
function fitnessGradebookLevel(total) {
  if (total >= 90) return '优秀';
  if (total >= 80) return '良好';
  if (total >= 60) return '及格';
  return '不及格';
}

/**
 * 取每个学生每个项目的【最新一条】成绩。
 * @returns {Map<string, object>} key = `学生 id|项目`
 */
function fitnessGradebookLatestRecords(studentIds) {
  const ids = new Set(studentIds);
  const latest = new Map();
  DB.getFitnessRecords().forEach(record => {
    if (!ids.has(record.studentId)) return;
    const key = `${record.studentId}|${record.testType}`;
    const existing = latest.get(key);
    const stamp = `${record.testDate || ''}|${record.createdAt || ''}`;
    const oldStamp = existing ? `${existing.testDate || ''}|${existing.createdAt || ''}` : '';
    if (!existing || stamp > oldStamp) latest.set(key, record);
  });
  return latest;
}

/* ==========================================================================
 * 三、算分（核心）
 * ========================================================================== */

/**
 * 算一个学生的总分 / 等级。
 *
 * 口径（2014 年修订版国标）：
 *   总分 = Σ(单项国标分 × 该项权重) + 1分钟跳绳加分，上限 120 分；
 *   必测项目齐全 → 这是正式"国标总分"；
 *   缺项 → 按已有项目的权重归一化算出"参考分"，并在备注列写明缺哪几项。
 */
function fitnessGradebookTotal(student, cells) {
  const weights = typeof DB.getAnnualFitnessWeights === 'function'
    ? DB.getAnnualFitnessWeights(student.grade)
    : null;

  if (!weights) {
    // 年级不在国标范围内（年级字段异常）→ 退化成"已有项目分的简单平均"
    const scores = [...cells.values()]
      .filter(cell => cell && !cell.empty && cell.score !== null && cell.score !== undefined)
      .map(cell => cell.score);
    if (!scores.length) return { total: null, level: '', complete: false, missing: [], reference: true };
    const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const total = Number(average.toFixed(1));
    return { total, level: fitnessGradebookLevel(total), complete: false, missing: [], reference: true };
  }

  let weightedSum = 0;
  let availableWeight = 0;
  let bonus = 0;
  const missing = [];

  Object.entries(weights).forEach(([key, weight]) => {
    const cell = cells.get(key);
    if (cell && !cell.empty && cell.score !== null && cell.score !== undefined) {
      weightedSum += cell.score * weight;
      availableWeight += weight;
      if (key === 'jumpRope') bonus += cell.bonus || 0;
    } else {
      missing.push(key);
    }
  });

  if (availableWeight <= 0) {
    return { total: null, level: '', complete: false, missing, reference: false };
  }

  // 权重齐全时 availableWeight = 1，除以它等于不除；缺项时按已有权重归一化成"参考分"
  const total = Number(Math.min(120, weightedSum / availableWeight + bonus).toFixed(1));
  return {
    total,
    level: fitnessGradebookLevel(total),
    complete: missing.length === 0,
    missing,
    reference: missing.length > 0,
    availableWeight: Number(availableWeight.toFixed(2)),
  };
}

/**
 * 组装一个学生的整行数据（含每一格的成绩 / 得分 / 等级 / 弱项标记）。
 */
function fitnessGradebookBuildRow(student, latest, index) {
  const cells = new Map();

  FITNESS_GRADEBOOK_COLUMNS.forEach(column => {
    if (column.key === 'BMI') return;      // BMI 由身高体重自动算，下面单独处理
    const record = latest.get(`${student.id}|${column.key}`);
    const cell = {
      key: column.key,
      name: column.name,
      value: null,
      unit: column.unit,
      score: null,
      bonus: 0,
      level: '',
      levelClass: '',
      weak: false,
      empty: true,
      record: null,
    };
    if (record) {
      const value = Number(record.value);
      if (Number.isFinite(value)) {
        cell.value = value;
        cell.unit = record.unit || column.unit || '';
        cell.empty = false;
        cell.record = record;
        if (column.scored) {
          const scored = DB.getFitnessScore(value, column.key, student.gender, student.grade);
          const grade = DB.getGrade(value, column.key, student.gender, student.grade);
          cell.score = scored?.score ?? null;
          cell.bonus = scored?.bonus ?? 0;
          cell.level = grade.level;
          cell.levelClass = grade.class;
          // 弱项：国标分不到 60（不及格）或等级直接判"不及格"
          cell.weak = (scored && scored.score < 60) || grade.level === '不及格';
          // 有分项目：得分列已经写清楚了；没有国标分的项目（立定跳远）只在成绩旁标一下等级
          cell.tag = (column.key === 'BMI' || cell.score === null) ? grade.level : '';
        }
      }
    }
    cells.set(column.key, cell);
  });

  // BMI：身高 + 体重自动算（国标里 BMI 是必测项，但系统是分开录身高体重的）
  const height = cells.get('height');
  const weight = cells.get('weight');
  const bmiCell = {
    key: 'BMI', name: 'BMI', value: null, unit: '', score: null, bonus: 0,
    level: '', levelClass: '', weak: false, empty: true, record: null,
  };
  if (height && weight && !height.empty && !weight.empty && height.value > 0 && weight.value > 0) {
    const bmi = weight.value / ((height.value / 100) ** 2);
    const scored = DB.getFitnessScore(bmi, 'BMI', student.gender, student.grade);
    const grade = DB.getGrade(bmi, 'BMI', student.gender, student.grade);
    bmiCell.value = Number(bmi.toFixed(1));
    bmiCell.score = scored?.score ?? null;
    bmiCell.level = grade.level;           // 偏瘦 / 正常 / 偏胖 / 肥胖
    bmiCell.levelClass = grade.class;
    bmiCell.category = scored?.category || '';
    bmiCell.tag = grade.level;
    bmiCell.weak = scored?.category === '肥胖';   // 肥胖是重点关注项，一样标红
    bmiCell.empty = false;
  }
  cells.set('BMI', bmiCell);

  const total = fitnessGradebookTotal(student, cells);
  const weakItems = FITNESS_GRADEBOOK_COLUMNS
    .map(column => cells.get(column.key))
    .filter(cell => cell && cell.weak);

  // 本人全部项的平均得分（弱项分布图判断"拖后腿"要用）
  const scoredValues = [...cells.values()]
    .filter(cell => cell && !cell.empty && cell.score !== null && cell.score !== undefined)
    .map(cell => cell.score);
  const averageScore = scoredValues.length
    ? Number((scoredValues.reduce((sum, score) => sum + score, 0) / scoredValues.length).toFixed(1))
    : null;

  return { index, student, cells, total, weakItems, hasWeak: weakItems.length > 0, averageScore };
}

/**
 * 当前范围要显示哪些项目列：固定 7 列 + 【范围内真有数据】的附加列。
 */
function fitnessGradebookVisibleColumns(rows) {
  const used = new Set();
  (rows || []).forEach(row => {
    row.cells.forEach((cell, key) => {
      if (cell && !cell.empty) used.add(key);
    });
  });
  return FITNESS_GRADEBOOK_COLUMNS.filter(column => !column.extra || used.has(column.key));
}

/**
 * 按当前筛选条件组装成绩册数据。
 * @param {{grade?:string, className?:string, search?:string, sort?:string}} options
 */
function fitnessGradebookBuild(options = {}) {
  const state = { ...FITNESS_GRADEBOOK_STATE, ...options };
  const search = String(state.search || '').trim().toLowerCase();

  const students = DB.getFitnessStudents().filter(student => {
    if (state.grade !== 'all' && student.grade !== state.grade) return false;
    if (state.className !== 'all' && student.class !== state.className) return false;
    if (search) {
      const haystack = `${student.name || ''} ${student.class || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const latest = fitnessGradebookLatestRecords(students.map(student => student.id));
  const rows = students.map((student, index) => fitnessGradebookBuildRow(student, latest, index));

  // 总成绩排序：默认高分在前；没有总分的排在最后
  const ascending = state.sort === 'asc';
  rows.sort((a, b) => {
    const totalA = a.total.total;
    const totalB = b.total.total;
    const emptyA = totalA === null || totalA === undefined;
    const emptyB = totalB === null || totalB === undefined;
    if (emptyA && emptyB) return a.index - b.index;
    if (emptyA) return 1;
    if (emptyB) return -1;
    return ascending ? totalA - totalB : totalB - totalA;
  });
  rows.forEach((row, position) => { row.index = position; });   // 序号 = 显示顺序

  const columns = fitnessGradebookVisibleColumns(rows);
  return { state, students, rows, columns, sort: ascending ? 'asc' : 'desc' };
}

/** 点总成绩表头 → 切换升 / 降序 */
function toggleFitnessGradebookSort() {
  FITNESS_GRADEBOOK_STATE.sort = FITNESS_GRADEBOOK_STATE.sort === 'desc' ? 'asc' : 'desc';
  if (typeof renderRecordsTable === 'function') renderRecordsTable();
}

/* ==========================================================================
 * 四、表格渲染（紧凑版）
 * ========================================================================== */

/** 成绩册表头（一行；总成绩可点，按钮带排序箭头） */
function fitnessGradebookHeadHTML(columns, sort) {
  const items = columns.map(column => {
    const label = `${column.name}${column.unit ? `(${column.unit})` : ''}`;
    return `<th class="fitness-gb-item">${fitnessGradebookEscape(label)}</th>`;
  }).join('');

  const arrow = sort === 'asc' ? '▲' : '▼';
  const arrowHint = sort === 'asc' ? '（当前：低分在前，点击改为高分在前）' : '（当前：高分在前，点击改为低分在前）';

  return `<tr>
    <th class="fitness-gb-basic">姓名</th>
    <th class="fitness-gb-basic">性别</th>
    <th class="fitness-gb-basic">班级</th>
    ${items}
    <th class="fitness-gb-total-head" onclick="toggleFitnessGradebookSort()" title="${arrowHint}">总成绩 <span class="fitness-gb-sort">${arrow}</span></th>
    <th class="fitness-gb-basic">等级</th>
    <th class="fitness-gb-basic fitness-gb-note-col">备注</th>
    <th class="fitness-gb-basic fitness-gb-weak-col">弱项</th>
  </tr>`;
}

/** 一格项目：上面原始成绩、下面国标折算分（同一个格子，不拆列） */
function fitnessGradebookCellHTML(cell) {
  if (!cell || cell.empty) return '<td class="fitness-gb-cell fitness-gb-empty">—</td>';

  const weakClass = cell.weak ? ' fitness-gb-weak' : '';
  const tag = cell.tag ? `<span class="fitness-gb-tag">${fitnessGradebookEscape(cell.tag)}</span>` : '';

  let points = '';
  if (cell.score !== null && cell.score !== undefined) {
    const tone = cell.score < 60 ? 'is-danger' : (cell.score < 80 ? 'is-warn' : 'is-good');
    const bonus = cell.bonus ? `<span class="fitness-gb-bonus">+${cell.bonus}</span>` : '';
    points = `<span class="fitness-gb-pts ${tone}">${cell.score}${bonus}</span>`;
  }

  return `<td class="fitness-gb-cell${weakClass}">
    <span class="fitness-gb-val">${fitnessGradebookEscape(cell.value)}<span class="fitness-gb-unit">${fitnessGradebookEscape(cell.unit || '')}</span>${tag}</span>
    ${points}
  </td>`;
}

/** 一个学生的一整行 */
function fitnessGradebookRowHTML(row, columns) {
  const cells = columns.map(column => fitnessGradebookCellHTML(row.cells.get(column.key))).join('');

  const total = row.total;
  const totalText = total.total === null ? '—' : total.total;
  const alertClass = row.hasWeak ? ' fitness-gb-alert' : '';
  const totalNote = total.total === null ? '' : (total.reference ? '参考' : '国标');

  const levelCell = total.level
    ? `<span class="badge ${FITNESS_GRADEBOOK_LEVEL_CLASS[total.level] || 'badge-info'}">${total.level}</span>`
    : '<span class="fitness-gb-empty">—</span>';

  // 备注：只写"缺测项目 / 参考分"，弱项另有专门一列
  // ⚠️ 备注可能很长 → 单行显示 + 省略号，完整内容挂在 title 上（鼠标悬停可见）
  const noteParts = [];
  if (total.missing && total.missing.length) {
    noteParts.push(`缺 ${total.missing.map(key => fitnessGradebookEscape(fitnessGradebookItemName(key))).join('、')}`);
  }
  const noteText = noteParts.join('；');
  const noteCell = noteText
    ? `<td class="fitness-gb-basic fitness-gb-note-col" title="${fitnessGradebookEscape(noteText)}"><span class="fitness-gb-note">${noteText}</span></td>`
    : '<td class="fitness-gb-basic fitness-gb-note-col"><span class="fitness-gb-empty">—</span></td>';

  // 弱项：全及格显示"—"，不及格就写清楚是哪几项（同样单行 + title）
  const weakText = row.hasWeak
    ? row.weakItems.map(cell => fitnessGradebookEscape(cell.name)).join('、')
    : '';
  const weakCell = weakText
    ? `<td class="fitness-gb-basic fitness-gb-weak-col" title="${fitnessGradebookEscape(weakText)}"><span class="fitness-gb-weak-list">${weakText}</span></td>`
    : '<td class="fitness-gb-basic fitness-gb-weak-col"><span class="fitness-gb-empty">—</span></td>';

  return `<tr class="${row.hasWeak ? 'fitness-gb-row-alert' : ''}">
    <td class="fitness-gb-basic">
      <span class="fitness-gb-no">${row.index + 1}</span>
      <button type="button" class="fitness-gb-name-link" title="点击查看个人成绩诊断报告"
        onclick="openFitnessDiagnosis(${row.index})">${fitnessGradebookEscape(row.student.name)}</button>
    </td>
    <td class="fitness-gb-basic">${fitnessGradebookEscape(row.student.gender || '')}</td>
    <td class="fitness-gb-basic">${fitnessGradebookEscape(row.student.class || '')}</td>
    ${cells}
    <td class="fitness-gb-total${alertClass}">${totalText}<span class="fitness-gb-sub">${totalNote}</span></td>
    <td class="fitness-gb-basic">${levelCell}</td>
    ${noteCell}
    ${weakCell}
  </tr>`;
}

/** 成绩册整表（成绩列表的默认视图） */
function renderFitnessGradebookTable() {
  const data = fitnessGradebookBuild();
  if (!data.rows.length) {
    return `<div class="empty-state"><div class="empty-icon">📭</div><p>当前筛选范围没有学生</p></div>`;
  }
  const body = data.rows.map(row => fitnessGradebookRowHTML(row, data.columns)).join('');
  return `
    <div class="table-wrapper">
      <table class="data-table fitness-gradebook-table">
        <thead>${fitnessGradebookHeadHTML(data.columns, data.sort)}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="fitness-gradebook-note">
      计分口径：《国家学生体质健康标准》（2014 年修订版）——
      单项得分按各年级、性别对应的国标表换算；总分为各项得分按国标权重加权（并加 1 分钟跳绳加分，上限 120 分）；
      等级：≥90 优秀、≥80 良好、≥60 及格、其余不及格。
      必测项目齐全时总分标「国标」，缺项时按已有项目折算为「参考」分，并在备注里写明缺哪几项。
      每格上方是原始成绩、下方是国标折算分；浅红格 = 该项不及格（或 BMI 肥胖），弱项列写清是哪几项。
    </p>`;
}

/* ==========================================================================
 * 五、各项目弱项分布（横向堆叠条形图）
 * ========================================================================== */

/** 判定口径 */
const FITNESS_WEAK_FAIL_SCORE = 60;   // 得分 < 60 → 未达标
const FITNESS_WEAK_LAG_SCORE = 80;    // 60~79 分才可能算"拖后腿"
const FITNESS_WEAK_LAG_GAP = 8;       // 比本人全部项平均分低 8 分以上

/**
 * 各项目弱项分布（数据）。
 *   未达标：该项得分 < 60
 *   拖后腿：该项得分 60~79，且比"本人全部项平均分"低 8 分以上
 *   正常  ：其余有成绩的人
 */
function computeFitnessWeakDistribution(data) {
  const rows = data?.rows || [];
  const columns = (data?.columns || FITNESS_GRADEBOOK_COLUMNS).filter(column => column.scored);
  return columns.map(column => {
    let fail = 0;
    let lag = 0;
    let normal = 0;
    rows.forEach(row => {
      const cell = row.cells.get(column.key);
      if (!cell || cell.empty || cell.score === null || cell.score === undefined) return;
      const score = cell.score;
      if (score < FITNESS_WEAK_FAIL_SCORE) {
        fail += 1;
        return;
      }
      const average = row.averageScore;
      if (score < FITNESS_WEAK_LAG_SCORE && average !== null && average !== undefined
        && score < average - FITNESS_WEAK_LAG_GAP) {
        lag += 1;
        return;
      }
      normal += 1;
    });
    return { key: column.key, name: column.name, fail, lag, normal, total: fail + lag + normal };
  });
}

/** 图表实例（切走成绩册时释放） */
let fitnessWeakChart = null;

/** 弱项分布图配置 */
function fitnessWeakDistributionOption(rows, scopeTotal) {
  const max = Math.max(Number(scopeTotal) || 0, ...rows.map(row => row.total), 1);
  return {
    tooltip: {
      backgroundColor: 'rgba(17, 24, 39, 0.92)',
      borderWidth: 0,
      padding: [10, 14],
      textStyle: { color: '#fff', fontSize: 13 },
      extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);',
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(3, 83, 164, 0.06)' } },
      formatter: params => {
        const row = rows[params[0]?.dataIndex];
        if (!row) return '';
        return `<b>${row.name}</b><br/>未达标 ${row.fail} 人 · 拖后腿 ${row.lag} 人 · 正常 ${row.normal} 人<br/>`
          + `有成绩 ${row.total} 人`;
      },
    },
    legend: {
      top: 0, right: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, itemGap: 14,
      data: ['未达标', '拖后腿', '正常'],
      textStyle: { color: '#6B7280', fontSize: 12 },
    },
    grid: { left: 8, right: 138, top: 34, bottom: 4, containLabel: true },
    xAxis: [{
      type: 'value',
      max,
      minInterval: 1,
      name: '人数',
      nameTextStyle: { color: '#6B7280', fontSize: 11 },
      axisLabel: { color: '#6B7280', fontSize: 11 },
      splitLine: { lineStyle: { color: '#F3F4F6' } },
      axisLine: { show: false },
      axisTick: { show: false },
    }],
    yAxis: [{
      type: 'category',
      inverse: true,
      data: rows.map(row => row.name),
      axisLabel: { color: '#374151', fontSize: 12 },
      axisLine: { lineStyle: { color: '#E5E7EB' } },
      axisTick: { show: false },
    }],
    series: [
      {
        name: '未达标',
        type: 'bar',
        stack: 'fitness-weak',
        barWidth: 14,
        itemStyle: { color: '#F472B6' },
        data: rows.map(row => row.fail),
      },
      {
        name: '拖后腿',
        type: 'bar',
        stack: 'fitness-weak',
        itemStyle: { color: '#FBBF24' },
        data: rows.map(row => row.lag),
      },
      {
        name: '正常',
        type: 'bar',
        stack: 'fitness-weak',
        itemStyle: { color: '#E5E7EB', borderRadius: [0, 4, 4, 0] },
        data: rows.map(row => row.normal),
        label: {
          show: true,
          position: 'right',
          distance: 8,
          color: '#6B7280',
          fontSize: 11,
          formatter: params => {
            const row = rows[params.dataIndex];
            return row ? `未达标 ${row.fail} 人 · 拖后腿 ${row.lag} 人` : '';
          },
        },
      },
    ],
  };
}

/** 渲染 / 刷新弱项分布图（随年级、班级、搜索联动） */
function updateFitnessWeakChart() {
  const element = document.getElementById('fitnessWeakChart');
  if (!element) return;
  if (typeof echarts === 'undefined') return;

  const data = fitnessGradebookBuild();
  const rows = computeFitnessWeakDistribution(data);

  if (!fitnessWeakChart || (typeof fitnessWeakChart.getDom === 'function' && fitnessWeakChart.getDom() !== element)) {
    try { fitnessWeakChart?.dispose(); } catch (error) { /* 忽略 */ }
    fitnessWeakChart = echarts.init(element);
  }
  fitnessWeakChart.setOption(fitnessWeakDistributionOption(rows, data.rows.length), true);

  const note = document.getElementById('fitnessWeakNote');
  if (note) {
    note.textContent = `未达标 = 得分不到 60 分；拖后腿 = 60~79 分且比本人平均分低 8 分以上 · 当前范围 ${data.rows.length} 人`;
  }
}

/** 释放图表实例（切走成绩册时调用） */
function destroyFitnessWeakChart() {
  try { fitnessWeakChart?.dispose(); } catch (error) { /* 忽略 */ }
  fitnessWeakChart = null;
}

/* ==========================================================================
 * 六、导出（Excel / CSV）
 * ========================================================================== */

/** 导出用的列结构（扁平：一格 = 一个 slot） */
function fitnessGradebookExportSlots(columns) {
  const slots = [];
  ['序号', '姓名', '性别', '班级'].forEach(header => {
    slots.push({ type: 'basic', header });
  });
  columns.forEach(column => {
    const label = `${column.name}${column.unit ? `(${column.unit})` : ''}`;
    slots.push({ type: 'item', header: label, column });
    if (column.scored) slots.push({ type: 'score', header: `${column.name}得分`, column });
  });
  slots.push({ type: 'basic', header: '总成绩' });
  slots.push({ type: 'basic', header: '等级' });
  slots.push({ type: 'basic', header: '备注' });
  slots.push({ type: 'basic', header: '弱项' });
  return slots;
}

/** 成绩册导出：两行表头 + 数据行 + 合并单元格信息 */
function fitnessGradebookExportMatrix(options = {}) {
  const data = fitnessGradebookBuild(options);
  if (!data.rows.length) return null;

  const slots = fitnessGradebookExportSlots(data.columns);
  const header1 = [];
  const header2 = [];
  const merges = [];

  slots.forEach((slot, index) => {
    if (slot.type === 'item') {
      header1.push(slot.header);
      const hasScore = slots[index + 1]?.type === 'score';
      header2.push(hasScore ? '成绩' : '');
      if (hasScore) {
        // 项目组标题横跨"成绩 + 得分"两列
        merges.push({ s: { r: 0, c: index }, e: { r: 0, c: index + 1 } });
      } else {
        // 没有得分的列（身高 / 体重）纵向占两行
        merges.push({ s: { r: 0, c: index }, e: { r: 1, c: index } });
      }
    } else if (slot.type === 'score') {
      header1.push('');
      header2.push(slot.header);
    } else {
      header1.push(slot.header);
      header2.push('');
      merges.push({ s: { r: 0, c: index }, e: { r: 1, c: index } });
    }
  });

  const body = data.rows.map(row => {
    const values = [];
    slots.forEach(slot => {
      if (slot.type === 'basic') {
        switch (slot.header) {
          case '序号': values.push(row.index + 1); break;
          case '姓名': values.push(row.student.name || ''); break;
          case '性别': values.push(row.student.gender || ''); break;
          case '班级': values.push(row.student.class || ''); break;
          case '总成绩': values.push(row.total.total === null ? '' : row.total.total); break;
          case '等级': values.push(row.total.level || ''); break;
          case '备注': values.push(fitnessGradebookExportNote(row)); break;
          case '弱项': values.push(row.hasWeak ? row.weakItems.map(cell => cell.name).join('、') : ''); break;
          default: values.push('');
        }
        return;
      }
      const cell = row.cells.get(slot.column.key);
      if (slot.type === 'item') {
        values.push(cell && !cell.empty ? cell.value : '');
        return;
      }
      // 得分列
      if (!cell || cell.empty || cell.score === null || cell.score === undefined) {
        values.push('');
        return;
      }
      values.push(cell.bonus ? `${cell.score}+${cell.bonus}` : cell.score);
    });
    return values;
  });

  const cols = slots.map(slot => {
    if (slot.type === 'basic') {
      if (slot.header === '备注' || slot.header === '弱项') return { wch: 22 };
      if (slot.header === '序号') return { wch: 6 };
      if (slot.header === '姓名') return { wch: 10 };
      if (slot.header === '性别') return { wch: 6 };
      return { wch: 10 };
    }
    return { wch: slot.type === 'score' ? 12 : 11 };
  });

  return { header1, header2, body, merges, cols, rows: data.rows, columns: data.columns, state: data.state };
}

/** 备注列文字（导出用纯文本） */
function fitnessGradebookExportNote(row) {
  const parts = [];
  if (row.total.missing && row.total.missing.length) {
    parts.push(`缺 ${row.total.missing.map(key => fitnessGradebookItemName(key)).join('、')}`);
  }
  if (row.total.reference && !parts.length) parts.push('参考分');
  return parts.join('；');
}

/** 导出文件名 */
function fitnessGradebookExportFilename(extension) {
  const state = FITNESS_GRADEBOOK_STATE;
  const parts = ['体测成绩册'];
  if (state.grade !== 'all') parts.push(state.grade);
  if (state.className !== 'all') parts.push(state.className);
  parts.push(new Date().toISOString().slice(0, 10));
  return `${parts.join('_')}.${extension}`;
}

/** CSV 单元格转义（防公式注入） */
function fitnessGradebookCsvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** 导出 Excel */
function exportFitnessRecordsExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('Excel 组件未加载，请改用 CSV 导出', 'error');
    return;
  }
  const matrix = fitnessGradebookExportMatrix();
  if (!matrix) {
    showToast('当前范围没有可导出的成绩', 'error');
    return;
  }
  const ws = XLSX.utils.aoa_to_sheet([matrix.header1, matrix.header2, ...matrix.body]);
  ws['!merges'] = matrix.merges;
  ws['!cols'] = matrix.cols;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '成绩册');
  XLSX.utils.book_append_sheet(wb, fitnessGradebookGuideSheet(), '计分说明');
  XLSX.writeFile(wb, fitnessGradebookExportFilename('xlsx'));
  showToast(`已导出成绩册（${matrix.body.length} 名学生）`, 'success');
}

/** 导出 CSV（Excel / WPS 直接打开） */
function exportFitnessRecordsCsv() {
  const matrix = fitnessGradebookExportMatrix();
  if (!matrix) {
    showToast('当前范围没有可导出的成绩', 'error');
    return;
  }
  const content = [matrix.header1, matrix.header2, ...matrix.body]
    .map(row => row.map(fitnessGradebookCsvCell).join(',')).join('\r\n');
  fitnessGradebookDownloadCsv(content);
  showToast(`已导出成绩册（${matrix.body.length} 名学生）`, 'success');
}

/** 触发 CSV 下载（带 BOM，Excel / WPS 打开不乱码） */
function fitnessGradebookDownloadCsv(content) {
  const blob = new Blob(['\ufeff', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fitnessGradebookExportFilename('csv');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 计分说明表（跟着成绩册一起导出，方便老师核对口径） */
function fitnessGradebookGuideSheet() {
  const guide = [
    ['体测成绩册 · 计分说明'],
    [''],
    ['项目', '内容'],
    ['计分标准', '《国家学生体质健康标准》（2014 年修订版）'],
    ['单项得分', '按性别 + 年级对应的国标表换算（成绩越小越好的项目：50米跑、50米×8往返跑）'],
    ['BMI', '由身高(cm)、体重(kg)自动计算：体重 ÷ (身高÷100)²，再按国标判定偏瘦/正常/偏胖/肥胖'],
    ['总分', 'Σ(单项得分 × 国标权重) + 1分钟跳绳加分，上限 120 分'],
    ['等级', '≥90 优秀；≥80 良好；≥60 及格；其余 不及格'],
    ['缺项', '必测项目没录全时，总分按已有项目折算为「参考」分，备注列会写明缺哪几项'],
    ['弱项列', '单项不及格或 BMI 肥胖 → 弱项列写清是哪几项；全部及格则为空'],
    [''],
    ['各年级总分权重'],
    ['年级', 'BMI / 肺活量 / 50米跑 / 体前屈 / 跳绳 / 仰卧起坐 / 50米×8'],
    ...['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'].map(grade => {
      const weights = DB.getAnnualFitnessWeights(grade) || {};
      const order = ['BMI', 'vitalCapacity', 'run50', 'sitReach', 'jumpRope', 'sitUps', 'run50x8'];
      return [grade, order
        .filter(key => weights[key] !== undefined)
        .map(key => `${fitnessGradebookItemName(key)} ${Math.round(weights[key] * 100)}%`)
        .join(' / ')];
    }),
  ];
  const ws = XLSX.utils.aoa_to_sheet(guide);
  ws['!cols'] = [{ wch: 18 }, { wch: 78 }];
  return ws;
}
