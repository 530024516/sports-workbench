/**
 * 体测数据 · 统计分析看板（BI 报表版）
 * ─────────────────────────────────────────────────────────────
 * 六个区块，全部数据前端算好再喂给 ECharts / HTML：
 *   ① 核心 KPI 指标卡（4 张）：名单人数、平均总分、及格率、优良率
 *   ② 占比进度条：及格率（绿）/ 优良率（蓝），带达标判断与"还差几人"
 *   ③ 分布图（左右分栏）：总分等级分布、BMI 体型分布（均为横向条形图）
 *   ④ 男女对比 + 本年级概览（自动生成的文字总结）
 *   ⑤ 各项目得分率排行（横向条形图，右侧一列"不及格 / 偏弱"说明）
 *   ⑥ 班级对比表格（人数 / 平均分 / 及格率 / 优良率 / 名次）
 *
 * 全局控制区：年级 Tab → 班级 Tab（联动）+【导出完整结果 CSV】。
 *
 * 计分口径与【成绩册】完全一致（总分 = 国标加权分 + 跳绳加分）：
 * 直接复用 fitness-gradebook.js 的 fitnessGradebookBuild()，不另写一套算法。
 */
'use strict';

/* ======================= 状态与常量 ======================= */

const FITNESS_DASHBOARD_STATE = {
  grade: 'all',
  className: 'all',
  watchType: 'edge',        // edge | weak | bmi | absent
  gradeMetric: 'goodExcellent', // goodExcellent | pass | obese
};
const fitnessDashboardCharts = { level: null, bmi: null, item: null, gradeCompare: null };

const FITNESS_DASHBOARD_GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];
const FITNESS_DASHBOARD_LEVELS = ['优秀', '良好', '及格', '不及格'];
/** 展示用 BMI 体型（系统里的"偏瘦/偏胖"在这里叫"低体重/超重"） */
const FITNESS_DASHBOARD_BMI_CATEGORIES = ['正常', '低体重', '超重', '肥胖'];
/** 有国标分的项目（身高/体重本身没有折算分；立定跳远在国标表里没有分数，会自动被过滤掉） */
const FITNESS_DASHBOARD_ITEM_KEYS = [
  'BMI', 'vitalCapacity', 'run50', 'sitReach', 'jumpRope', 'sitUps', 'run50x8', 'standingJump',
];
/** 目标线：及格 60 分、优良 80 分（国标等级线） */
const FITNESS_DASHBOARD_PASS_TARGET = 60;
const FITNESS_DASHBOARD_GOOD_TARGET = 80;
/** 边缘生：离及格线不到 5 分 */
const FITNESS_DASHBOARD_EDGE_RANGE = 5;
/** 关注名单的四个分组 */
const FITNESS_DASHBOARD_WATCH_TYPES = [
  { key: 'edge', label: '边缘生（距及格）' },
  { key: 'weak', label: '薄弱项不及格' },
  { key: 'bmi', label: '肥胖超重' },
  { key: 'absent', label: '缺考名单' },
];
/** 全校年级对比：折线指标 */
const FITNESS_DASHBOARD_GRADE_METRICS = [
  { key: 'goodExcellent', label: '优良率' },
  { key: 'pass', label: '及格率' },
  { key: 'obese', label: '肥胖率' },
];

const FITNESS_DASHBOARD_COLORS = {
  优秀: ['#06A77D', '#34D399'],
  良好: ['#2563EB', '#60A5FA'],
  及格: ['#F59E0B', '#FBBF24'],
  不及格: ['#DC2626', '#F87171'],
  正常: ['#06A77D', '#34D399'],
  低体重: ['#F59E0B', '#FCD34D'],
  超重: ['#F97316', '#FB923C'],
  肥胖: ['#DC2626', '#F87171'],
};

/* ======================= 工具 ======================= */

function fitnessDashboardEscape(value) {
  if (typeof escapeFitnessHTML === 'function') return escapeFitnessHTML(value);
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function fitnessDashboardRound1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function fitnessDashboardMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 线性渐变 */
function fitnessDashboardGradient(colors, horizontal = false) {
  if (typeof echarts === 'undefined') return colors[0];
  return new echarts.graphic.LinearGradient(
    horizontal ? 0 : 0, horizontal ? 0 : 0, horizontal ? 1 : 0, horizontal ? 0 : 1,
    [{ offset: 0, color: colors[0] }, { offset: 1, color: colors[1] }],
  );
}

/** BMI 分类 → 展示用名称 */
function fitnessDashboardBmiLabel(category) {
  if (category === '偏瘦') return '低体重';
  if (category === '偏胖') return '超重';
  return category || '正常';
}

/** 得分率配色：>80% 强项（绿）、<60% 薄弱（红）、中间中性（蓝） */
function fitnessDashboardRateColors(rate) {
  if (rate > 80) return ['#06A77D', '#34D399'];
  if (rate < 60) return ['#DC2626', '#F87171'];
  return ['#2563EB', '#60A5FA'];
}

/* ======================= 数据计算 ======================= */

/**
 * 看板的全部数据。
 * 数据来源：成绩册的同一套算法（fitnessGradebookBuild），
 * 保证"看板里的总分"和"成绩册里的总分"永远是同一个数。
 */
function computeFitnessDashboardData() {
  const state = FITNESS_DASHBOARD_STATE;
  const gradebook = typeof fitnessGradebookBuild === 'function'
    ? fitnessGradebookBuild({ grade: state.grade, className: state.className, search: '' })
    : { rows: [], students: [] };

  const rows = gradebook.rows || [];
  const scopeCount = rows.length;
  // 缺考的人（本次没来 / 没有计分成绩）不计入参测人数，口径才自洽
  const absentList = computeFitnessDashboardAbsent({ rows });
  const absentIds = new Set(absentList.map(item => String(item.student.id)));
  const participants = rows.filter(row =>
    !absentIds.has(String(row.student.id))
    && row.total && row.total.total !== null && row.total.total !== undefined);
  const total = participants.length;
  const scores = participants.map(row => row.total.total);

  /* ① 等级分布 + KPI */
  const levelCounts = {};
  FITNESS_DASHBOARD_LEVELS.forEach(level => { levelCounts[level] = 0; });
  participants.forEach(row => {
    const level = row.total.level;
    if (levelCounts[level] === undefined) levelCounts[level] = 0;
    levelCounts[level] += 1;
  });

  const excellent = levelCounts.优秀 || 0;
  const good = levelCounts.良好 || 0;
  const pass = levelCounts.及格 || 0;
  const fail = levelCounts.不及格 || 0;
  const average = total ? fitnessDashboardRound1(scores.reduce((sum, score) => sum + score, 0) / total) : 0;
  const median = total ? fitnessDashboardRound1(fitnessDashboardMedian(scores)) : 0;
  const excellentRate = total ? fitnessDashboardRound1((excellent / total) * 100) : 0;
  const goodExcellentRate = total ? fitnessDashboardRound1(((excellent + good) / total) * 100) : 0;
  const passRate = total ? fitnessDashboardRound1(((total - fail) / total) * 100) : 0;
  const failRate = total ? fitnessDashboardRound1((fail / total) * 100) : 0;

  /* ② BMI 体型分布 */
  const bmiCounts = {};
  FITNESS_DASHBOARD_BMI_CATEGORIES.forEach(category => { bmiCounts[category] = 0; });
  let bmiCount = 0;
  participants.forEach(row => {
    const cell = row.cells.get('BMI');
    if (!cell || cell.empty) return;
    const label = fitnessDashboardBmiLabel(cell.category || cell.level);
    if (bmiCounts[label] === undefined) bmiCounts[label] = 0;
    bmiCounts[label] += 1;
    bmiCount += 1;
  });

  /* ③ 男女对比 */
  const genderStats = ['男', '女'].map(gender => {
    const list = participants.filter(row => row.student.gender === gender);
    const genderScores = list.map(row => row.total.total);
    const genderFail = list.filter(row => row.total.level === '不及格').length;
    const genderGood = list.filter(row => row.total.level === '优秀' || row.total.level === '良好').length;
    return {
      gender,
      count: list.length,
      average: list.length ? fitnessDashboardRound1(genderScores.reduce((sum, score) => sum + score, 0) / list.length) : 0,
      goodExcellentRate: list.length ? fitnessDashboardRound1((genderGood / list.length) * 100) : 0,
      passRate: list.length ? fitnessDashboardRound1(((list.length - genderFail) / list.length) * 100) : 0,
      failCount: genderFail,
    };
  });

  /* ④ 边缘生 / 优先帮扶 */
  const edgeCount = participants.filter(row =>
    row.total.total < FITNESS_DASHBOARD_PASS_TARGET
    && row.total.total >= FITNESS_DASHBOARD_PASS_TARGET - FITNESS_DASHBOARD_EDGE_RANGE).length;
  const overweightCount = (bmiCounts.肥胖 || 0) + (bmiCounts.超重 || 0);
  const boostRate = total ? fitnessDashboardRound1((edgeCount / total) * 100) : 0;

  /* ⑤ 各项目得分率排行 */
  const itemRates = FITNESS_DASHBOARD_ITEM_KEYS.map(key => {
    const item = (DB.FITNESS_ITEMS || []).find(entry => entry.key === key);
    const scored = participants
      .map(row => row.cells.get(key))
      .filter(cell => cell && !cell.empty && cell.score !== null && cell.score !== undefined);
    const passCount = scored.filter(cell => cell.score >= 60).length;
    const failCount = scored.filter(cell => cell.score < 60).length;
    const weakCount = scored.filter(cell => cell.score >= 60 && cell.score < 80).length;
    return {
      key,
      name: item?.name || key,
      count: scored.length,
      passCount,
      failCount,
      weakCount,
      rate: scored.length ? fitnessDashboardRound1((passCount / scored.length) * 100) : 0,
      average: scored.length
        ? fitnessDashboardRound1(scored.reduce((sum, cell) => sum + cell.score, 0) / scored.length)
        : 0,
    };
  }).filter(row => row.count > 0).sort((a, b) => b.rate - a.rate);

  /* ⑥ 班级对比（同名班跨年级不混：分组键 = 年级|班号） */
  const classBuckets = new Map();
  participants.forEach(row => {
    const key = `${row.student.grade || ''}|${row.student.class || '未分班'}`;
    const bucket = classBuckets.get(key) || {
      name: row.student.class || '未分班',
      grade: row.student.grade || '',
      scores: [],
      failCount: 0,
      goodCount: 0,
    };
    bucket.scores.push(row.total.total);
    if (row.total.level === '不及格') bucket.failCount += 1;
    if (row.total.level === '优秀' || row.total.level === '良好') bucket.goodCount += 1;
    classBuckets.set(key, bucket);
  });
  const nameCount = new Map();
  classBuckets.forEach(bucket => nameCount.set(bucket.name, (nameCount.get(bucket.name) || 0) + 1));
  const classRows = [...classBuckets.values()].map(bucket => {
    const count = bucket.scores.length;
    return {
      name: (nameCount.get(bucket.name) || 1) > 1 ? `${bucket.grade}${bucket.name}` : bucket.name,
      grade: bucket.grade,
      count,
      average: count ? fitnessDashboardRound1(bucket.scores.reduce((sum, score) => sum + score, 0) / count) : 0,
      passRate: count ? fitnessDashboardRound1(((count - bucket.failCount) / count) * 100) : 0,
      goodExcellentRate: count ? fitnessDashboardRound1((bucket.goodCount / count) * 100) : 0,
      failCount: bucket.failCount,
    };
  }).sort((a, b) => b.average - a.average);
  classRows.forEach((row, index) => { row.rank = index + 1; });

  const data = {
    state,
    rows,             // 成绩册的每一行（关注名单要用）
    scopeCount,
    total,
    absentCount: 0,
    average,
    median,
    excellent,
    good,
    pass,
    fail,
    excellentRate,
    goodExcellentRate,
    passRate,
    failRate,
    levelCounts,
    bmiCounts,
    bmiCount,
    genderStats,
    edgeCount,
    overweightCount,
    boostRate,
    itemRates,
    classRows,
  };

  // 缺考人数：本次测试没成绩 / 算不出总分（口径与关注名单的"缺考名单"一致）
  data.absentCount = absentList.length;
  return data;
}

/* ======================= 重点学生关注名单 ======================= */

/**
 * 四张关注名单：
 *   edge   边缘生 —— 总分 55~59 分（差几分就及格，最值得帮）
 *   weak   薄弱项不及格 —— 任意一个单项不及格
 *   bmi    肥胖超重 —— BMI 判为肥胖或超重
 *   absent 缺考 —— 有历史记录，但【本次测试】没成绩（或只录了参考项，算不出总分）
 *
 * 名册来自体测记录派生（DB.getFitnessStudents），系统里没有独立的学生名单，
 * 所以"缺考"只能按"最近一次测试日期有没有成绩"来判定。
 */
function computeFitnessDashboardAbsent(data) {
  const rows = data.rows || [];
  const scopeIds = new Set(rows.map(row => String(row.student.id)));

  const latestByClass = new Map();    // '年级|班级' → 最近一次测试日期
  const datesByStudent = new Map();   // 学生 id → 考过的日期集合
  const classByStudent = new Map();   // 学生 id → '年级|班级'

  DB.getFitnessRecords().forEach(record => {
    const id = String(record.studentId || '');
    if (!id) return;
    const date = String(record.testDate || '').trim();
    const classKey = `${String(record.grade || '').trim()}|${String(record.class || '').trim()}`;
    if (!classByStudent.has(id)) classByStudent.set(id, classKey);
    if (!datesByStudent.has(id)) datesByStudent.set(id, new Set());
    if (!date) return;
    datesByStudent.get(id).add(date);
    if (!scopeIds.has(id)) return;
    if (!latestByClass.has(classKey) || date > latestByClass.get(classKey)) latestByClass.set(classKey, date);
  });

  const list = [];
  rows.forEach(row => {
    const total = row.total.total;
    const noScore = total === null || total === undefined;
    const id = String(row.student.id);
    const classKey = classByStudent.get(id) || `${row.student.grade || ''}|${row.student.class || ''}`;
    const latest = latestByClass.get(classKey) || '';
    const dates = datesByStudent.get(id);
    const tookLatest = !latest || !!(dates && dates.has(latest));
    if (tookLatest && !noScore) return;

    list.push({
      student: row.student,
      total: noScore ? null : total,
      scoreText: noScore ? '—' : `${total} 分`,
      scoreNote: noScore ? '未计分' : '总分',
      reason: !tookLatest
        ? (latest ? `本次测试（${latest}）未录入成绩` : '未录入任何体测成绩')
        : '只录了参考项，没有计分项目',
      sortValue: noScore ? -1 : total,
    });
  });

  list.sort((a, b) => String(a.student.grade).localeCompare(String(b.student.grade), 'zh-CN', { numeric: true })
    || String(a.student.class).localeCompare(String(b.student.class), 'zh-CN', { numeric: true })
    || String(a.student.name).localeCompare(String(b.student.name), 'zh-CN'));
  return list;
}

function computeFitnessDashboardWatchlist(data) {
  const list = { edge: [], weak: [], bmi: [], absent: [] };

  (data.rows || []).forEach(row => {
    const total = row.total.total;
    const student = row.student;

    /* ① 边缘生：55~59 分 */
    if (total !== null && total !== undefined
      && total >= FITNESS_DASHBOARD_PASS_TARGET - FITNESS_DASHBOARD_EDGE_RANGE
      && total < FITNESS_DASHBOARD_PASS_TARGET) {
      list.edge.push({
        student,
        total,
        scoreText: `${total} 分`,
        scoreNote: '总分',
        reason: `差 ${fitnessDashboardRound1(FITNESS_DASHBOARD_PASS_TARGET - total)} 分及格`,
      });
    }

    /* ② 薄弱项不及格 */
    if (row.hasWeak && row.weakItems.length) {
      const weakest = [...row.weakItems].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];
      const reasons = row.weakItems.map(cell => (
        cell.key === 'BMI' ? `BMI${cell.category || cell.level || '异常'}` : `${cell.name}不及格`
      ));
      list.weak.push({
        student,
        total,
        weakCount: row.weakItems.length,
        scoreText: `${weakest.score} 分`,
        scoreNote: `最弱项 ${weakest.name}`,
        reason: reasons.join('、'),
      });
    }

    /* ③ 肥胖超重 */
    const bmiCell = row.cells.get('BMI');
    if (bmiCell && !bmiCell.empty && (bmiCell.category === '肥胖' || bmiCell.category === '偏胖')) {
      const label = bmiCell.category === '肥胖' ? '肥胖' : '超重';
      list.bmi.push({
        student,
        total,
        scoreText: `${bmiCell.value}`,
        scoreNote: `BMI${total !== null && total !== undefined ? `（总分 ${total}）` : ''}`,
        reason: `BMI ${label}`,
        sortValue: bmiCell.value,
      });
    }
  });

  /* ④ 缺考：本次没成绩 / 算不出总分 */
  list.absent = computeFitnessDashboardAbsent(data);

  // 排序：边缘生按"最接近及格"排前面；薄弱项按弱项个数多、排前面；BMI 按数值高排前面
  list.edge.sort((a, b) => b.total - a.total);
  list.weak.sort((a, b) => (b.weakCount || 0) - (a.weakCount || 0) || (a.total ?? 0) - (b.total ?? 0));
  list.bmi.sort((a, b) => (b.sortValue ?? 0) - (a.sortValue ?? 0));
  return list;
}

/** 关注名单表格（当前 Tab） */
function renderFitnessDashboardWatchlist(data) {
  const list = computeFitnessDashboardWatchlist(data);
  const type = FITNESS_DASHBOARD_WATCH_TYPES.some(item => item.key === FITNESS_DASHBOARD_STATE.watchType)
    ? FITNESS_DASHBOARD_STATE.watchType
    : 'edge';
  FITNESS_DASHBOARD_STATE.watchType = type;

  const tabs = document.getElementById('fitnessDashboardWatchTabs');
  if (tabs) {
    tabs.innerHTML = FITNESS_DASHBOARD_WATCH_TYPES.map(item => `
      <button type="button" class="fitness-bi-tab${type === item.key ? ' active' : ''}"
        onclick="fitnessDashboardSetWatchType('${item.key}')">
        ${item.label}<span class="fitness-bi-count">${(list[item.key] || []).length}</span>
      </button>`).join('');
  }

  const container = document.getElementById('fitnessDashboardWatchTable');
  if (!container) return;
  const rows = list[type] || [];
  const subtitle = document.getElementById('fitnessDashboardWatchSubtitle');
  if (subtitle) {
    const label = FITNESS_DASHBOARD_WATCH_TYPES.find(item => item.key === type)?.label || '';
    subtitle.textContent = `${label} · ${rows.length} 人 · ${fitnessDashboardScopeText()}`;
  }

  if (!rows.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>当前范围内没有该类学生</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="table-wrapper">
      <table class="data-table fitness-bi-table fitness-bi-watch-table">
        <thead>
          <tr>
            <th>姓名</th><th>班级</th><th>总分 / 成绩</th><th>关注原因</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td>
                <strong>${fitnessDashboardEscape(row.student.name)}</strong>
                <span class="fitness-bi-sub">${fitnessDashboardEscape(row.student.gender || '')}</span>
              </td>
              <td>${fitnessDashboardEscape(row.student.grade || '')}${fitnessDashboardEscape(row.student.class || '')}</td>
              <td>
                <strong class="fitness-bi-average">${fitnessDashboardEscape(row.scoreText)}</strong>
                <span class="fitness-bi-sub">${fitnessDashboardEscape(row.scoreNote)}</span>
              </td>
              <td><span class="fitness-bi-reason">${fitnessDashboardEscape(row.reason)}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/** 切换关注名单分组 */
function fitnessDashboardSetWatchType(type) {
  FITNESS_DASHBOARD_STATE.watchType = type;
  updateFitnessDashboard();
}

/** 导出当前关注名单 CSV */
function exportFitnessDashboardWatchlistCsv() {
  const data = computeFitnessDashboardData();
  const list = computeFitnessDashboardWatchlist(data);
  const type = FITNESS_DASHBOARD_STATE.watchType || 'edge';
  const label = FITNESS_DASHBOARD_WATCH_TYPES.find(item => item.key === type)?.label || type;
  const rows = list[type] || [];
  if (!rows.length) {
    showToast('当前名单没有学生可导出', 'error');
    return;
  }
  const content = [
    [`重点学生关注名单 · ${label}`],
    ['导出时间', new Date().toLocaleString('zh-CN')],
    ['统计范围', fitnessDashboardScopeText()],
    [],
    ['姓名', '性别', '年级', '班级', '总分/成绩', '说明', '关注原因'],
    ...rows.map(row => [
      row.student.name || '',
      row.student.gender || '',
      row.student.grade || '',
      row.student.class || '',
      row.scoreText,
      row.scoreNote,
      row.reason,
    ]),
  ].map(row => row.map(fitnessDashboardCsvCell).join(',')).join('\r\n');

  const blob = new Blob(['\ufeff', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `体测关注名单_${label}_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`已导出「${label}」${rows.length} 人`, 'success');
}

/* ======================= 全校年级横向对比 ======================= */

/**
 * 各年级的横向对比（柱状 = 平均分，折线 = 优良率/及格率/肥胖率）。
 * 口径：全校所有年级与班级（不受顶部的班级筛选影响），只统计有成绩的学生。
 */
function computeFitnessDashboardGradeCompare() {
  const gradebook = typeof fitnessGradebookBuild === 'function'
    ? fitnessGradebookBuild({ grade: 'all', className: 'all', search: '' })
    : { rows: [] };

  const buckets = new Map();
  (gradebook.rows || []).forEach(row => {
    const grade = row.student.grade || '未分年级';
    if (!buckets.has(grade)) {
      buckets.set(grade, { grade, scores: [], good: 0, fail: 0, obese: 0, bmiCount: 0, count: 0 });
    }
    const bucket = buckets.get(grade);
    bucket.count += 1;
    const total = row.total.total;
    if (total === null || total === undefined) return;
    bucket.scores.push(total);
    if (row.total.level === '优秀' || row.total.level === '良好') bucket.good += 1;
    if (row.total.level === '不及格') bucket.fail += 1;
    const bmiCell = row.cells.get('BMI');
    if (bmiCell && !bmiCell.empty) {
      bucket.bmiCount += 1;
      if (bmiCell.category === '肥胖') bucket.obese += 1;
    }
  });

  const order = [...FITNESS_DASHBOARD_GRADES, ...[...buckets.keys()].filter(grade => !FITNESS_DASHBOARD_GRADES.includes(grade))];
  return order.filter(grade => buckets.has(grade)).map(grade => {
    const bucket = buckets.get(grade);
    const scored = bucket.scores.length;
    return {
      grade,
      count: bucket.count,
      scored,
      average: scored ? fitnessDashboardRound1(bucket.scores.reduce((sum, value) => sum + value, 0) / scored) : 0,
      goodExcellentRate: scored ? fitnessDashboardRound1((bucket.good / scored) * 100) : 0,
      passRate: scored ? fitnessDashboardRound1(((scored - bucket.fail) / scored) * 100) : 0,
      obeseRate: bucket.bmiCount ? fitnessDashboardRound1((bucket.obese / bucket.bmiCount) * 100) : null,
    };
  });
}

/** 切换折线指标（优良率 / 及格率 / 肥胖率） */
function fitnessDashboardSetGradeMetric(metric) {
  const valid = FITNESS_DASHBOARD_GRADE_METRICS.some(item => item.key === metric);
  FITNESS_DASHBOARD_STATE.gradeMetric = valid ? metric : 'goodExcellent';
  updateFitnessDashboard();
}

/** 折线指标切换按钮 */
function renderFitnessDashboardGradeMetricTabs() {
  const container = document.getElementById('fitnessDashboardGradeMetricTabs');
  if (!container) return;
  const current = FITNESS_DASHBOARD_GRADE_METRICS.some(item => item.key === FITNESS_DASHBOARD_STATE.gradeMetric)
    ? FITNESS_DASHBOARD_STATE.gradeMetric
    : 'goodExcellent';
  container.innerHTML = FITNESS_DASHBOARD_GRADE_METRICS.map(item => `
    <button type="button" class="${current === item.key ? 'active' : ''}"
      onclick="fitnessDashboardSetGradeMetric('${item.key}')">${item.label}</button>`).join('');
}

/** 全校年级对比：柱状（平均分）+ 折线（优良率/及格率/肥胖率）双 Y 轴 */
function fitnessDashboardGradeCompareOption(rows, metric) {
  const metricKey = FITNESS_DASHBOARD_GRADE_METRICS.some(item => item.key === metric) ? metric : 'goodExcellent';
  const metricLabel = FITNESS_DASHBOARD_GRADE_METRICS.find(item => item.key === metricKey)?.label || '优良率';
  const metricField = { goodExcellent: 'goodExcellentRate', pass: 'passRate', obese: 'obeseRate' }[metricKey];
  return {
    tooltip: {
      ...FITNESS_DASHBOARD_TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(3, 83, 164, 0.06)' } },
      formatter: params => {
        const row = rows[params[0].dataIndex];
        if (!row) return '';
        return `<b>${row.grade}</b><br/>有成绩 ${row.scored} 人 / 共 ${row.count} 人<br/>`
          + `平均分 ${row.average}<br/>优良率 ${row.goodExcellentRate}%<br/>`
          + `及格率 ${row.passRate}%<br/>肥胖率 ${row.obeseRate === null ? '暂无数据' : `${row.obeseRate}%`}`;
      },
    },
    legend: {
      top: 0, right: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, itemGap: 14,
      data: ['平均分', `${metricLabel}(%)`],
      textStyle: { color: '#6B7280', fontSize: 12 },
    },
    grid: { left: 8, right: 8, top: 40, bottom: 6, containLabel: true },
    xAxis: [{
      type: 'category',
      data: rows.map(row => row.grade),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#E5E7EB' } },
      axisLabel: { ...FITNESS_DASHBOARD_AXIS_LABEL, fontSize: 12, color: '#374151' },
    }],
    yAxis: [
      {
        type: 'value',
        name: '平均分',
        max: 120,
        nameTextStyle: { color: '#0353A4', fontSize: 11, padding: [0, 0, 0, 24] },
        axisLabel: { ...FITNESS_DASHBOARD_AXIS_LABEL },
        splitLine: { lineStyle: { color: '#F3F4F6' } },
      },
      {
        type: 'value',
        name: `${metricLabel}(%)`,
        max: 100,
        nameTextStyle: { color: '#F97316', fontSize: 11, padding: [0, 24, 0, 0] },
        axisLabel: { ...FITNESS_DASHBOARD_AXIS_LABEL, formatter: '{value}%' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '平均分',
        type: 'bar',
        xAxisIndex: 0,
        yAxisIndex: 0,
        barWidth: '42%',
        itemStyle: { borderRadius: [6, 6, 0, 0], color: fitnessDashboardGradient(['#0353A4', '#4AA8F0']) },
        data: rows.map(row => row.average),
      },
      {
        name: `${metricLabel}(%)`,
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'circle',
        symbolSize: 9,
        lineStyle: { width: 3, color: '#F97316' },
        itemStyle: { color: '#F97316', borderColor: '#fff', borderWidth: 2 },
        label: { show: true, position: 'top', color: '#F97316', fontSize: 11, formatter: '{c}%' },
        data: rows.map(row => row[metricField]),
      },
    ],
    graphic: rows.length ? [] : fitnessDashboardEmptyGraphic('暂无年级数据'),
  };
}

/* ======================= ECharts 配置 ======================= */

const FITNESS_DASHBOARD_TOOLTIP = {
  backgroundColor: 'rgba(17, 24, 39, 0.92)',
  borderWidth: 0,
  padding: [10, 14],
  textStyle: { color: '#fff', fontSize: 13 },
  extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);',
};

const FITNESS_DASHBOARD_AXIS_LABEL = { color: '#6B7280', fontSize: 11 };

function fitnessDashboardEmptyGraphic(text = '暂无数据') {
  return [{
    type: 'text', left: 'center', top: 'middle',
    style: { text, fill: '#9CA3AF', fontSize: 14 },
  }];
}

/** 横向条形图的通用骨架（等级分布 / BMI 分布共用） */
function fitnessDashboardBarOption(rows, colors, emptyText, tooltipFormatter) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return {
    tooltip: {
      ...FITNESS_DASHBOARD_TOOLTIP,
      trigger: 'item',
      formatter: tooltipFormatter,
    },
    grid: { left: 6, right: 104, top: 6, bottom: 6, containLabel: true },
    xAxis: [{
      type: 'value',
      max: 100,
      axisLabel: { ...FITNESS_DASHBOARD_AXIS_LABEL, formatter: '{value}%' },
      splitLine: { lineStyle: { color: '#F3F4F6' } },
      axisLine: { show: false },
      axisTick: { show: false },
    }],
    yAxis: [{
      type: 'category',
      inverse: true,
      data: rows.map(row => row.name),
      axisLabel: { ...FITNESS_DASHBOARD_AXIS_LABEL, fontSize: 12, color: '#374151' },
      axisLine: { lineStyle: { color: '#E5E7EB' } },
      axisTick: { show: false },
    }],
    series: [{
      type: 'bar',
      barWidth: 16,
      xAxisIndex: 0,
      yAxisIndex: 0,
      itemStyle: {
        borderRadius: [0, 6, 6, 0],
        color: params => fitnessDashboardGradient(colors[params.name] || ['#9CA3AF', '#D1D5DB'], true),
      },
      label: {
        show: true,
        position: 'right',
        distance: 8,
        color: '#4B5563',
        fontSize: 12,
        formatter: params => {
          const row = rows[params.dataIndex];
          return `${row.rate}% · ${row.count}人`;
        },
      },
      data: rows.map(row => row.rate),
    }],
    graphic: total ? [] : fitnessDashboardEmptyGraphic(emptyText),
  };
}

/** 区块 3 左：总分等级分布（优秀 / 良好 / 及格 / 不及格） */
function fitnessDashboardLevelOption(data) {
  const total = FITNESS_DASHBOARD_LEVELS.reduce((sum, level) => sum + (data.levelCounts[level] || 0), 0);
  const rows = FITNESS_DASHBOARD_LEVELS.map(level => {
    const count = data.levelCounts[level] || 0;
    return { name: level, count, rate: total ? fitnessDashboardRound1((count / total) * 100) : 0 };
  });
  return fitnessDashboardBarOption(
    rows,
    FITNESS_DASHBOARD_COLORS,
    '暂无等级数据',
    params => {
      const row = rows[params.dataIndex];
      return `${row.name}<br/>${row.count} 人 · 占比 ${row.rate}%`;
    },
  );
}

/** 区块 3 右：BMI 体型分布（正常 / 低体重 / 超重 / 肥胖） */
function fitnessDashboardBmiOption(data) {
  const total = FITNESS_DASHBOARD_BMI_CATEGORIES.reduce((sum, key) => sum + (data.bmiCounts[key] || 0), 0);
  const rows = FITNESS_DASHBOARD_BMI_CATEGORIES.map(name => {
    const count = data.bmiCounts[name] || 0;
    return { name, count, rate: total ? fitnessDashboardRound1((count / total) * 100) : 0 };
  });
  return fitnessDashboardBarOption(
    rows,
    FITNESS_DASHBOARD_COLORS,
    '暂无身高体重数据',
    params => {
      const row = rows[params.dataIndex];
      return `${row.name}<br/>${row.count} 人 · 占比 ${row.rate}%`;
    },
  );
}

/** 区块 5：各项目得分率排行（右侧一列"不及格 / 偏弱"说明） */
function fitnessDashboardItemOption(data) {
  const rows = data.itemRates;
  const notes = rows.map(row => `不及格 ${row.failCount} · 偏弱 ${row.weakCount}`);
  return {
    tooltip: {
      ...FITNESS_DASHBOARD_TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(37, 99, 235, 0.06)' } },
      formatter: params => {
        const row = rows[params[0].dataIndex];
        if (!row) return '';
        return `<b>${row.name}</b><br/>得分率 ${row.rate}%（${row.passCount}/${row.count}）<br/>`
          + `平均单项分 ${row.average}<br/>不及格 ${row.failCount} 人 · 偏弱 ${row.weakCount} 人`;
      },
    },
    // 两个 grid 的 top/bottom 必须完全一致（且都不用 containLabel），
    // 否则左右两列的分类带会错位，右侧说明就对不上横条了。
    // ⚠️ 右侧说明列是【右对齐】文字：文字右边缘 = grid[1].right + margin。
    //    以前 grid[1].right = 10 时右边缘 = 画布宽 + 4，末尾数字被裁掉。
    //    现在把 grid[1].right 留到 48，右边缘恒定落在画布内 34px 处。
    grid: [
      { left: 112, right: '52%', top: 10, bottom: 30 },
      { left: '56%', right: 48, top: 10, bottom: 30 },
    ],
    // ⚠️ 关键：grid 用了数组，就必须给【每一个 grid 都配一条 xAxis】。
    //    以前只写了 gridIndex:0 那一条，grid[1] 没有 x 轴，
    //    ECharts 会直接抛 "axis.getAxesOnZeroOf is not a function"，
    //    整张图一片空白（还把后面的图表一起带崩）。
    //    第二个 x 轴只是给 grid[1] 当坐标参照用的，show:false 不显示。
    xAxis: [
      {
        type: 'value',
        gridIndex: 0,
        max: 100,
        axisLabel: { ...FITNESS_DASHBOARD_AXIS_LABEL, formatter: '{value}%' },
        splitLine: { lineStyle: { color: '#F3F4F6' } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      {
        type: 'value',
        gridIndex: 1,
        show: false,
        max: 100,
      },
    ],
    yAxis: [
      {
        type: 'category',
        gridIndex: 0,
        inverse: true,
        data: rows.map(row => row.name),
        axisLabel: { ...FITNESS_DASHBOARD_AXIS_LABEL, fontSize: 12, color: '#374151', width: 96, overflow: 'break' },
        axisLine: { lineStyle: { color: '#E5E7EB' } },
        axisTick: { show: false },
      },
      {
        // 右侧说明列：与左侧一一对齐的"不及格 / 偏弱"人数
        type: 'category',
        gridIndex: 1,
        inverse: true,
        position: 'right',
        data: rows.map(row => row.name),
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          align: 'right',
          verticalAlign: 'middle',
          margin: 14,
          fontSize: 11,
          color: '#8A93A3',
          // width 给足 + overflow:'none'：绝不截断说明文案（人数可能到三位数）
          width: 130,
          overflow: 'none',
          formatter: (value, index) => notes[index] || '',
        },
      },
    ],
    series: [{
      type: 'bar',
      xAxisIndex: 0,
      yAxisIndex: 0,
      barWidth: 14,
      itemStyle: {
        borderRadius: [0, 6, 6, 0],
        color: params => fitnessDashboardGradient(fitnessDashboardRateColors(rows[params.dataIndex]?.rate ?? 0), true),
      },
      label: {
        show: true,
        position: 'right',
        distance: 6,
        color: '#4B5563',
        fontSize: 11,
        formatter: '{c}%',
      },
      data: rows.map(row => row.rate),
    }],
    graphic: rows.length ? [] : fitnessDashboardEmptyGraphic('暂无国标成绩'),
  };
}

/* ======================= 渲染：控制区 ======================= */

function fitnessDashboardScopeText() {
  const state = FITNESS_DASHBOARD_STATE;
  const gradeText = state.grade === 'all' ? '全部年级' : state.grade;
  const classText = state.className === 'all' ? '全部班级' : state.className;
  return `${gradeText} · ${classText}`;
}

/** 年级 Tab */
function renderFitnessDashboardGradeTabs() {
  const container = document.getElementById('fitnessDashboardGradeTabs');
  if (!container) return;
  container.innerHTML = ['all', ...FITNESS_DASHBOARD_GRADES].map(grade => {
    const label = grade === 'all' ? '全部年级' : grade;
    const active = FITNESS_DASHBOARD_STATE.grade === grade;
    return `<button type="button" class="fitness-bi-tab${active ? ' active' : ''}" data-grade="${fitnessDashboardEscape(grade)}" onclick="fitnessDashboardSetGrade('${fitnessDashboardEscape(grade)}')">${fitnessDashboardEscape(label)}</button>`;
  }).join('');
}

/** 班级 Tab（随年级联动） */
function renderFitnessDashboardClassTabs() {
  const container = document.getElementById('fitnessDashboardClassTabs');
  if (!container) return;
  const state = FITNESS_DASHBOARD_STATE;
  const classes = [...new Set(DB.getFitnessStudents()
    .filter(student => state.grade === 'all' || student.grade === state.grade)
    .map(student => student.class).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  container.innerHTML = ['all', ...classes].map(className => {
    const label = className === 'all' ? '全部班级' : className;
    const active = state.className === className;
    return `<button type="button" class="fitness-bi-tab${active ? ' active' : ''}" data-class="${fitnessDashboardEscape(className)}" onclick="fitnessDashboardSetClass('${fitnessDashboardEscape(className)}')">${fitnessDashboardEscape(label)}</button>`;
  }).join('');
}

/** 切年级：班级跟着重选 */
function fitnessDashboardSetGrade(grade) {
  FITNESS_DASHBOARD_STATE.grade = grade;
  const classes = [...new Set(DB.getFitnessStudents()
    .filter(student => grade === 'all' || student.grade === grade)
    .map(student => student.class).filter(Boolean))];
  if (FITNESS_DASHBOARD_STATE.className !== 'all' && !classes.includes(FITNESS_DASHBOARD_STATE.className)) {
    FITNESS_DASHBOARD_STATE.className = 'all';
  }
  renderFitnessDashboardGradeTabs();
  renderFitnessDashboardClassTabs();
  updateFitnessDashboard();
}

/** 切班级 */
function fitnessDashboardSetClass(className) {
  FITNESS_DASHBOARD_STATE.className = className;
  renderFitnessDashboardClassTabs();
  updateFitnessDashboard();
}

/* ======================= 渲染：区块 1 KPI ======================= */

function renderFitnessDashboardKpis(data) {
  const container = document.getElementById('fitnessDashboardKpis');
  if (!container) return;
  // 只留 4 张核心大卡：名单人数 / 平均总分 / 及格率 / 优良率（下面的进度条继续保留）
  const cards = [
    {
      icon: '👥', tone: 'primary', value: data.total, label: '名单人数',
      sub: data.scopeCount ? `范围内 ${data.scopeCount} 人 · 缺考 ${data.absentCount} 人` : '暂无学生',
    },
    {
      icon: '📈', tone: 'primary', value: data.total ? data.average.toFixed(1) : '—', label: '平均总分',
      sub: '国标加权总分',
    },
    {
      icon: '✅', tone: 'success', value: `${data.passRate}%`, label: '及格率',
      sub: `及格以上 ${data.total - data.fail}/${data.total} 人`,
    },
    {
      icon: '⭐', tone: 'blue', value: `${data.goodExcellentRate}%`, label: '优良率',
      sub: `优秀+良好 ${data.excellent + data.good}/${data.total} 人`,
    },
  ];
  container.innerHTML = cards.map(card => `
    <div class="fitness-bi-kpi fitness-bi-tone-${card.tone}">
      <div class="fitness-bi-kpi-head">
        <span class="fitness-bi-kpi-icon">${card.icon}</span>
        <span class="fitness-bi-kpi-label">${card.label}</span>
      </div>
      <div class="fitness-bi-kpi-value">${card.value}</div>
      <div class="fitness-bi-kpi-sub">${card.sub}</div>
    </div>`).join('');
}

/* ======================= 渲染：区块 2 进度条 ======================= */

function renderFitnessDashboardProgress(data) {
  const container = document.getElementById('fitnessDashboardProgress');
  if (!container) return;

  const passGap = Math.max(0, Math.ceil((FITNESS_DASHBOARD_PASS_TARGET / 100) * data.total) - (data.total - data.fail));
  const goodTargetCount = Math.ceil((FITNESS_DASHBOARD_GOOD_TARGET / 100) * data.total);
  const goodGap = Math.max(0, goodTargetCount - (data.excellent + data.good));
  const passOk = data.passRate >= FITNESS_DASHBOARD_PASS_TARGET;
  const goodOk = data.goodExcellentRate >= FITNESS_DASHBOARD_GOOD_TARGET;

  container.innerHTML = `
    <div class="fitness-bi-progress-row">
      <span class="fitness-bi-progress-label">及格率</span>
      <div class="fitness-bi-progress-track">
        <div class="fitness-bi-progress-fill fitness-bi-fill-green" style="width:${Math.min(100, data.passRate)}%"></div>
      </div>
      <span class="fitness-bi-progress-value">${data.passRate}% · ${passOk ? '达标' : `未达标（还差 ${passGap} 人）`}</span>
    </div>
    <div class="fitness-bi-progress-row">
      <span class="fitness-bi-progress-label">优良率</span>
      <div class="fitness-bi-progress-track">
        <div class="fitness-bi-progress-fill fitness-bi-fill-blue" style="width:${Math.min(100, data.goodExcellentRate)}%"></div>
      </div>
      <span class="fitness-bi-progress-value">${data.goodExcellentRate}% · ${goodOk ? '达标' : `未达标（距离目标差 ${goodGap} 人）`}</span>
    </div>`;
}

/* ======================= 渲染：区块 4 男女对比 + 概览 ======================= */

function renderFitnessDashboardGender(data) {
  const container = document.getElementById('fitnessDashboardGender');
  if (!container) return;
  container.innerHTML = data.genderStats.map(item => `
    <div class="fitness-bi-gender-card fitness-bi-gender-${item.gender === '男' ? 'male' : 'female'}">
      <div class="fitness-bi-gender-head">
        <span class="fitness-bi-gender-tag">${item.gender}</span>
        <span class="fitness-bi-gender-count">${item.count} 人</span>
      </div>
      <div class="fitness-bi-gender-average">${item.count ? item.average.toFixed(1) : '—'}<span>平均分</span></div>
      <div class="fitness-bi-gender-meta">
        <span>优良率 <b>${item.goodExcellentRate}%</b></span>
        <span>及格率 <b>${item.passRate}%</b></span>
        <span>不及格 <b>${item.failCount}</b> 人</span>
      </div>
    </div>`).join('');
}

function renderFitnessDashboardSummary(data) {
  const container = document.getElementById('fitnessDashboardSummary');
  if (!container) return;
  const scope = fitnessDashboardScopeText();
  if (!data.total) {
    container.innerHTML = `<p class="fitness-bi-summary-empty">当前范围（${scope}）暂无体测成绩，先去「成绩列表」录入或导入成绩。</p>`;
    return;
  }
  const overweightText = data.overweightCount ? `肥胖+超重 ${data.overweightCount} 人` : '暂无肥胖或超重学生';
  container.innerHTML = `
    <p class="fitness-bi-summary-text">
      <b>${scope}</b>：${overweightText}；不及格 <b class="is-danger">${data.fail}</b> 人；
      其中边缘生（距及格 ${FITNESS_DASHBOARD_EDGE_RANGE} 分内）<b class="is-warn">${data.edgeCount}</b> 人。
      优先帮扶这 ${data.edgeCount} 人可提升及格率 <b class="is-success">${data.boostRate}%</b>。
    </p>
    <ul class="fitness-bi-summary-list">
      <li><span>参测人数</span><b>${data.total} / ${data.scopeCount}</b></li>
      <li><span>平均总分</span><b>${data.average.toFixed(1)}</b></li>
      <li><span>中位数</span><b>${data.median.toFixed(1)}</b></li>
      <li><span>肥胖 / 超重</span><b>${data.bmiCounts.肥胖 || 0} / ${data.bmiCounts.超重 || 0}</b></li>
      <li><span>可测 BMI</span><b>${data.bmiCount} 人</b></li>
      <li><span>缺考</span><b>${data.absentCount} 人</b></li>
    </ul>`;
}

/* ======================= 渲染：区块 6 班级对比 ======================= */

function renderFitnessDashboardClassTable(data) {
  const container = document.getElementById('fitnessDashboardClassTable');
  if (!container) return;
  if (!data.classRows.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>当前范围暂无班级数据</p></div>`;
    return;
  }
  const tag = (value, ok) => `<span class="fitness-bi-tag ${ok ? 'fitness-bi-tag-good' : 'fitness-bi-tag-bad'}">${value}%</span>`;
  container.innerHTML = `
    <div class="table-wrapper">
      <table class="data-table fitness-bi-table">
        <thead>
          <tr>
            <th>班级</th><th>人数</th><th>平均分</th><th>及格率</th><th>优良率</th><th>名次</th>
          </tr>
        </thead>
        <tbody>
          ${data.classRows.map(row => `
            <tr>
              <td><strong>${fitnessDashboardEscape(row.name)}</strong></td>
              <td>${row.count}</td>
              <td><strong class="fitness-bi-average">${row.average.toFixed(1)}</strong></td>
              <td>${tag(row.passRate, row.passRate >= FITNESS_DASHBOARD_PASS_TARGET)}</td>
              <td>${tag(row.goodExcellentRate, row.goodExcellentRate >= FITNESS_DASHBOARD_GOOD_TARGET)}</td>
              <td><span class="fitness-bi-rank">${row.rank}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ======================= 导出：完整结果 CSV ======================= */

function fitnessDashboardCsvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function fitnessDashboardExportFilename() {
  const state = FITNESS_DASHBOARD_STATE;
  const parts = ['体测统计分析看板'];
  if (state.grade !== 'all') parts.push(state.grade);
  if (state.className !== 'all') parts.push(state.className);
  parts.push(new Date().toISOString().slice(0, 10));
  return `${parts.join('_')}.csv`;
}

/** 完整结果（KPI + 分布 + 男女 + 项目 + 班级 + 概览） */
function fitnessDashboardExportRows(data) {
  const rows = [];
  const push = (...cells) => rows.push(cells);

  push('体测统计分析看板 · 完整结果');
  push('导出时间', new Date().toLocaleString('zh-CN'));
  push('统计范围', fitnessDashboardScopeText());
  push('计分口径', '《国家学生体质健康标准》(2014年修订版)；总分为各单项国标分按年级权重加权 + 跳绳加分');
  push('');

  push('【核心指标】');
  push('指标', '数值', '说明');
  push('参测人数', data.total, `名单共 ${data.scopeCount} 人，缺考 ${data.absentCount} 人`);
  push('平均总分', data.average.toFixed(1), '国标加权总分平均值');
  push('中位数', data.median.toFixed(1), '总分中位数');
  push('优秀率', `${data.excellentRate}%`, `${data.excellent}/${data.total} 人`);
  push('优良率', `${data.goodExcellentRate}%`, `优秀+良好 ${data.excellent + data.good}/${data.total} 人`);
  push('及格率', `${data.passRate}%`, `及格以上 ${data.total - data.fail}/${data.total} 人`);
  push('不及格人数', data.fail, `占比 ${data.failRate}%`);
  push('');

  push('【等级分布】');
  push('等级', '人数', '占比');
  FITNESS_DASHBOARD_LEVELS.forEach(level => {
    const count = data.levelCounts[level] || 0;
    push(level, count, `${data.total ? fitnessDashboardRound1((count / data.total) * 100) : 0}%`);
  });
  push('');

  push('【BMI 体型分布】');
  push('体型', '人数', '占比');
  FITNESS_DASHBOARD_BMI_CATEGORIES.forEach(category => {
    const count = data.bmiCounts[category] || 0;
    push(category, count, `${data.bmiCount ? fitnessDashboardRound1((count / data.bmiCount) * 100) : 0}%`);
  });
  push('');

  push('【男女生对比】');
  push('性别', '人数', '平均分', '优良率', '及格率', '不及格人数');
  data.genderStats.forEach(item => {
    push(item.gender, item.count, item.average.toFixed(1), `${item.goodExcellentRate}%`, `${item.passRate}%`, item.failCount);
  });
  push('');

  push('【各项目得分率排行】');
  push('项目', '得分率', '及格人数', '不及格人数', '偏弱人数', '平均单项分', '评价');
  data.itemRates.forEach(row => {
    const label = row.rate > 80 ? '强项' : row.rate < 60 ? '薄弱' : '一般';
    push(row.name, `${row.rate}%`, row.passCount, row.failCount, row.weakCount, row.average.toFixed(1), label);
  });
  push('');

  push('【班级对比】');
  push('班级', '人数', '平均分', '及格率', '优良率', '名次');
  data.classRows.forEach(row => {
    push(row.name, row.count, row.average.toFixed(1), `${row.passRate}%`, `${row.goodExcellentRate}%`, row.rank);
  });
  push('');

  push('【本年级概览】');
  push(`肥胖+超重 ${data.overweightCount} 人；不及格 ${data.fail} 人；`
    + `其中边缘生（距及格${FITNESS_DASHBOARD_EDGE_RANGE}分内）${data.edgeCount} 人。`
    + `优先帮扶可提升及格率 ${data.boostRate}%`);

  return rows;
}

function exportFitnessDashboardCsv() {
  const data = computeFitnessDashboardData();
  if (!data.total) {
    showToast('当前范围没有体测成绩，无法导出', 'error');
    return;
  }
  const content = fitnessDashboardExportRows(data)
    .map(row => row.map(fitnessDashboardCsvCell).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fitnessDashboardExportFilename();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('已导出完整统计结果（CSV）', 'success');
}

/* ======================= 图表实例管理 ======================= */

function destroyFitnessDashboardCharts() {
  Object.values(fitnessDashboardCharts).forEach(chart => {
    try { chart?.dispose(); } catch (error) { /* 忽略 */ }
  });
  Object.keys(fitnessDashboardCharts).forEach(key => { fitnessDashboardCharts[key] = null; });
}

/** 取（必要时创建）图表实例；DOM 被换掉时重建 */
function ensureFitnessDashboardChart(key, elementId) {
  const element = document.getElementById(elementId);
  if (!element) return null;
  const current = fitnessDashboardCharts[key];
  if (current && typeof current.getDom === 'function' && current.getDom() === element) return current;
  try { current?.dispose(); } catch (error) { /* 忽略 */ }
  if (typeof echarts === 'undefined') return null;
  /* 容器是隐藏的（display:none）时初始化，画布会是 0 x 0 —— 先提醒一句，省得对着空白页猜 */
  try {
    const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
    if (rect && (!rect.width || !rect.height)) {
      console.warn(`[体测看板] 容器「${elementId}」当前尺寸为 0，图表会画不出来（检查高度与 display）`);
    }
  } catch (error) { /* 忽略 */ }
  const chart = echarts.init(element);
  fitnessDashboardCharts[key] = chart;
  return chart;
}

/**
 * 图表诊断：把【实例尺寸】和【series 数据】打到控制台。
 * 排查"图表一片空白"时先看这两行：
 *   画布 0 x 0 → 容器没高度 / 当时是隐藏的（display:none）；
 *   series.data 为空 → 数据没传进来；
 *   series.data 有值但仍空白 → option 配置有问题（ECharts 会抛错）。
 */
function fitnessDashboardChartDiagnostics(chart, name) {
  if (!chart) {
    console.warn(`[体测看板·${name}] 图表实例不存在`);
    return;
  }
  try {
    const width = typeof chart.getWidth === 'function' ? chart.getWidth() : '?';
    const height = typeof chart.getHeight === 'function' ? chart.getHeight() : '?';
    const option = typeof chart.getOption === 'function' ? chart.getOption() : null;
    const series = (option?.series || []).map(item => ({
      name: item.name,
      type: item.type,
      dataLength: Array.isArray(item.data) ? item.data.length : 0,
      data: Array.isArray(item.data) ? item.data.slice(0, 8) : item.data,
    }));
    console.log(
      `%c[体测看板·${name}]%c 画布 ${width} x ${height}`
      + `${(width === 0 || height === 0) ? ' ← ⚠️ 容器没尺寸，图表必然一片空白' : ''}`,
      'color:#0353A4;font-weight:700', 'color:inherit',
    );
    console.log('[体测看板]', name, 'series 数据：', series);
  } catch (error) {
    console.warn(`[体测看板·${name}] 诊断信息读取失败`, error);
  }
}

/** 用新数据重绘图表（setOption） */
function updateFitnessDashboardCharts(data) {
  const pairs = [
    ['level', 'fitnessChartLevel', fitnessDashboardLevelOption],
    ['bmi', 'fitnessChartBmi', fitnessDashboardBmiOption],
    ['item', 'fitnessChartItem', fitnessDashboardItemOption],
  ];
  pairs.forEach(([key, elementId, builder]) => {
    const chart = ensureFitnessDashboardChart(key, elementId);
    if (!chart) return;
    /* ⛔ 每张图各自 try/catch —— 一张图配置出错，绝不能把后面的图一起拖下水。
       （曾经"各项目得分率"的 option 少配了一条 x 轴，setOption 抛错后异常冒泡，
         导致"全校年级横向对比"压根没被创建 → 整块空白、鼠标也没反应。） */
    try {
      chart.setOption(builder(data), true);   // notMerge：彻底重画，不会残留上一次的系列
      chart.resize();                         // 容器刚从隐藏切回可见时，补一次重排
    } catch (error) {
      console.error(`[体测看板] 图表「${key}」渲染失败：`, error);
    }
    fitnessDashboardChartDiagnostics(chart, key);
  });

  // 全校年级横向对比：只有"全部年级"时才显示，隐藏时把实例释放掉（0 宽画布会画歪）
  const wrap = document.getElementById('fitnessDashboardGradeCompare');
  if (wrap && FITNESS_DASHBOARD_STATE.grade === 'all') {
    wrap.style.display = '';
    try {
      const rows = computeFitnessDashboardGradeCompare();
      const chart = ensureFitnessDashboardChart('gradeCompare', 'fitnessChartGradeCompare');
      if (chart) {
        chart.setOption(fitnessDashboardGradeCompareOption(rows, FITNESS_DASHBOARD_STATE.gradeMetric), true);
        chart.resize();
      }
    } catch (error) {
      console.error('[体测看板] 图表「gradeCompare」渲染失败：', error);
    }
    fitnessDashboardChartDiagnostics(fitnessDashboardCharts.gradeCompare, 'gradeCompare');
  } else {
    if (wrap) wrap.style.display = 'none';
    const chart = fitnessDashboardCharts.gradeCompare;
    if (chart) {
      try { chart.dispose(); } catch (error) { /* 忽略 */ }
      fitnessDashboardCharts.gradeCompare = null;
    }
  }
}

/* ======================= 入口 ======================= */

/** 看板整体刷新（筛选变化 / 数据变化都走这里） */
function updateFitnessDashboard() {
  const data = computeFitnessDashboardData();
  renderFitnessDashboardKpis(data);
  renderFitnessDashboardProgress(data);
  renderFitnessDashboardGender(data);
  renderFitnessDashboardSummary(data);
  renderFitnessDashboardClassTable(data);
  renderFitnessDashboardWatchlist(data);
  renderFitnessDashboardGradeMetricTabs();
  updateFitnessDashboardCharts(data);
  const scope = document.getElementById('fitnessDashboardScope');
  if (scope) scope.textContent = `${fitnessDashboardScopeText()} · ${data.total} 名学生参测`;
}

/** 渲染整个看板（Tab 切换进来时调用） */
function renderFitnessDashboard() {
  destroyFitnessDashboardCharts();
  // 看板自带年级 / 班级 Tab，把工具栏里上一个视图遗留的筛选器清掉，避免出现"点了没反应"的控件
  const filterArea = document.getElementById('filterArea');
  if (filterArea) filterArea.innerHTML = '';
  const container = document.getElementById('fitnessContent');
  if (!container) return;
  container.innerHTML = `
    <section class="fitness-bi">
      <!-- 全局控制区 -->
      <div class="fitness-bi-control">
        <div class="fitness-bi-control-tabs">
          <div class="fitness-bi-tab-row">
            <span class="fitness-bi-tab-label">年级</span>
            <div class="fitness-bi-tabs" id="fitnessDashboardGradeTabs"></div>
          </div>
          <div class="fitness-bi-tab-row">
            <span class="fitness-bi-tab-label">班级</span>
            <div class="fitness-bi-tabs" id="fitnessDashboardClassTabs"></div>
          </div>
        </div>
        <div class="fitness-bi-control-actions">
          <span class="fitness-bi-scope" id="fitnessDashboardScope"></span>
          <button class="btn btn-secondary btn-sm" type="button" onclick="exportFitnessDashboardCsv()">⬇️ 导出完整结果 CSV</button>
          <button class="btn btn-success btn-sm" type="button" onclick="printFitnessPage('dashboard')"
            title="把当前看板打印成 A4 纵向报表（图表会转成高清图片）">🖨️ 打印当前页面</button>
        </div>
      </div>

      <!-- 区块 1：核心 KPI -->
      <div class="fitness-bi-kpis" id="fitnessDashboardKpis"></div>

      <!-- 区块 2：占比进度条 -->
      <div class="fitness-bi-progress" id="fitnessDashboardProgress"></div>

      <!-- 区块 3：分布图 -->
      <div class="fitness-bi-grid-2">
        <div class="card fitness-bi-card">
          <div class="card-header">
            <div class="card-title"><span>🏅</span> 总分等级分布</div>
            <div class="card-subtitle">优秀 / 良好 / 及格 / 不及格 人数占比</div>
          </div>
          <div class="fitness-bi-chart" id="fitnessChartLevel"></div>
        </div>
        <div class="card fitness-bi-card">
          <div class="card-header">
            <div class="card-title"><span>⚖️</span> BMI 体型分布</div>
            <div class="card-subtitle">正常 / 低体重 / 超重 / 肥胖 人数占比</div>
          </div>
          <div class="fitness-bi-chart" id="fitnessChartBmi"></div>
        </div>
      </div>

      <!-- 区块 4：男女对比 + 概览 -->
      <div class="fitness-bi-grid-2">
        <div class="card fitness-bi-card">
          <div class="card-header">
            <div class="card-title"><span>👫</span> 男女生对比</div>
            <div class="card-subtitle">人数 · 平均分 · 优良率</div>
          </div>
          <div class="card-body">
            <div class="fitness-bi-gender" id="fitnessDashboardGender"></div>
          </div>
        </div>
        <div class="card fitness-bi-card">
          <div class="card-header">
            <div class="card-title"><span>📝</span> 本年级概览</div>
            <div class="card-subtitle">自动生成的班级体检小结</div>
          </div>
          <div class="card-body">
            <div class="fitness-bi-summary" id="fitnessDashboardSummary"></div>
          </div>
        </div>
      </div>

      <!-- 区块 5：各项目得分率排行 -->
      <div class="card fitness-bi-card">
        <div class="card-header">
          <div class="card-title"><span>📊</span> 各项目得分率排行</div>
          <div class="card-subtitle">按得分率从高到低 · 右侧为不及格 / 偏弱人数</div>
        </div>
        <div class="fitness-bi-chart-scroll">
          <div class="fitness-bi-chart fitness-bi-chart-tall" id="fitnessChartItem"></div>
        </div>
      </div>

      <!-- 区块 6：班级对比 -->
      <div class="card fitness-bi-card">
        <div class="card-header">
          <div class="card-title"><span>🏫</span> 班级对比</div>
          <div class="card-subtitle">按平均分排名</div>
        </div>
        <div id="fitnessDashboardClassTable"></div>
      </div>

      <!-- 区块 7：重点学生关注名单 -->
      <div class="card fitness-bi-card">
        <div class="card-header">
          <div>
            <div class="card-title"><span>🎯</span> 重点学生关注名单</div>
            <div class="card-subtitle" id="fitnessDashboardWatchSubtitle"></div>
          </div>
          <button class="btn btn-secondary btn-sm" type="button" onclick="exportFitnessDashboardWatchlistCsv()">⬇️ 导出当前名单 CSV</button>
        </div>
        <div class="fitness-bi-tabs fitness-bi-watch-tabs" id="fitnessDashboardWatchTabs"></div>
        <div id="fitnessDashboardWatchTable"></div>
      </div>

      <!-- 区块 8：全校年级横向对比（只有"全部年级"时显示） -->
      <div class="card fitness-bi-card" id="fitnessDashboardGradeCompare">
        <div class="card-header">
          <div>
            <div class="card-title"><span>📈</span> 全校年级横向对比</div>
            <div class="card-subtitle">柱状＝各年级平均分 · 折线＝优良率/及格率/肥胖率 · 口径：全校所有班级</div>
          </div>
          <div class="segmented fitness-bi-metric-switch" id="fitnessDashboardGradeMetricTabs"></div>
        </div>
        <div class="fitness-bi-chart-scroll">
          <div class="fitness-bi-chart fitness-bi-chart-tall" id="fitnessChartGradeCompare"></div>
        </div>
      </div>
    </section>`;

  renderFitnessDashboardGradeTabs();
  renderFitnessDashboardClassTabs();
  updateFitnessDashboard();
}

/* 窗口尺寸变化 → 让图表跟着重排 */
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    Object.values(fitnessDashboardCharts).forEach(chart => {
      try { chart?.resize(); } catch (error) { /* 忽略 */ }
    });
  });
}
