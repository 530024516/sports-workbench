/**
 * 体测 · 个人成绩诊断报告
 * ─────────────────────────────────────────────────────────────
 * 点击成绩册里的学生姓名 → 弹出一份"体检报告"式的个人诊断单：
 *   ① 头部信息区：头像 / 姓名 / 性别 / 年级班级 / 总分 / BMI / 全项平均分 / 等级
 *   ② 弱项与提分优先级：未达标 + 拖后腿，标出"练到达标线能提多少分"
 *   ③ 体型风险：BMI 异常（长期项，不计入短期提分）
 *   ④ 提分预测：把弱项练到达标线 → 预计总分与等级
 *   ⑤ 训练处方：内置【弱项处方库】，不依赖 AI
 * 底部：📋 复制发家长（剪贴板）/ 🖨️ 打印这张诊断单（A4，走 iframe 打印）
 *
 * 弱项判定口径与成绩册上方的「弱项分布图」完全一致（同一套阈值）：
 *   未达标：单项得分 < 60
 *   拖后腿：60~79 分，且比本人全项平均分低 8 分以上
 * BMI 是长期项：只进「体型风险」，不计入短期弱项与提分预测。
 */
'use strict';

/* ==========================================================================
 * 一、弱项处方库（内置规则，不联网、不调用 AI）
 * ========================================================================== */

const FITNESS_DIAGNOSIS_PRESCRIPTIONS = {
  run50: {
    title: '50米跑（速度素质）',
    summary: '短跑 = 起跑反应 + 步频 + 摆臂 + 加速，先把技术练顺，再上强度。',
    drills: [
      { name: '起跑', detail: '听哨音快速起跑 10m × 6 次，重心前压' },
      { name: '步频', detail: '原地高抬腿 15 秒 × 4 组' },
      { name: '摆臂', detail: '原地前后摆臂 20 秒 × 4 组' },
      { name: '加速', detail: '30 米全速跑 4 组（组间休息 2 分钟）' },
    ],
  },
  jumpRope: {
    title: '1分钟跳绳（协调与耐力）',
    summary: '跳绳靠"手腕摇 + 前脚掌弹"，动作对了成绩自然就上去了。',
    drills: [
      { name: '手腕摇绳', detail: '两手腕发力摇绳、肘部固定，每组 1 分钟' },
      { name: '前脚掌着地', detail: '只用前脚掌落地，膝盖微屈缓冲' },
      { name: '计时练习', detail: '每天 2 组 1 分钟计时跳，记录最好成绩' },
    ],
  },
  vitalCapacity: {
    title: '肺活量（心肺功能）',
    summary: '肺活量要"慢而久"地练，别一口气猛吹、憋到脸发红。',
    drills: [
      { name: '吹气球', detail: '每天 3 组，每组连续吹气球 1 分钟' },
      { name: '腹式呼吸', detail: '吸气 4 秒 - 屏息 2 秒 - 呼气 6 秒，循环 5 分钟' },
      { name: '水中憋气', detail: '浅水区练水下吐气与憋气，每次 3 分钟' },
    ],
  },
  sitReach: {
    title: '坐位体前屈（柔韧素质）',
    summary: '柔韧靠每天拉一点点，练前先热身，切忌猛压。',
    drills: [
      { name: '静态拉伸', detail: '坐位体前屈保持 20 秒 × 3 组（拉到轻微酸胀即可）' },
      { name: '压腿', detail: '正压腿 + 侧压腿各 1 分钟 × 2 组' },
      { name: '同伴辅助拉伸', detail: '同学配合缓慢下压，不猛压到位' },
    ],
  },
  sitUps: {
    title: '1分钟仰卧起坐（腰腹力量）',
    summary: '仰卧起坐练的是"卷腹发力"，别用手拽脖子。',
    drills: [
      { name: '卷腹', detail: '仰卧起坐 30 个 × 3 组（不手拽脖子）' },
      { name: '仰卧举腿', detail: '仰卧举腿 15 次 × 3 组' },
      { name: '核心支撑', detail: '平板支撑 30 秒 × 3 组' },
    ],
  },
  run50x8: {
    title: '50米×8往返跑（耐力）',
    summary: '折返跑比的是"节奏"，掉速了再冲回来才有效。',
    drills: [
      { name: '折返跑', detail: '50米×8 往返跑 2 组（按 8 秒一趟的节奏）' },
      { name: '间歇跑', detail: '30 米冲刺 + 慢走 30 秒，循环 8 次' },
      { name: '摆臂强化', detail: '跑步摆臂 20 秒 × 4 组' },
    ],
  },
  standingJump: {
    title: '立定跳远（爆发力）',
    summary: '立定跳远靠"蹬地 + 摆臂 + 收腹"，先练动作再练远度。',
    drills: [
      { name: '深蹲跳', detail: '深蹲起跳 15 次 × 3 组' },
      { name: '提踵', detail: '提踵（踮脚尖）20 次 × 3 组' },
      { name: '摆臂练习', detail: '原地摆臂 + 蹬地起跳 10 次 × 2 组' },
    ],
  },
};

/** BMI 异常时的长期建议（长期项，不进短期弱项） */
const FITNESS_DIAGNOSIS_BMI_ADVICE = {
  肥胖: '长期建议：控制精制糖与油炸食品，每周 3 次跳绳 20 分钟 + 每天快走 30 分钟。',
  偏胖: '长期建议：每周 3 次 20 分钟有氧运动（跳绳 / 快走 / 球类），少吃含糖饮料。',
  偏瘦: '长期建议：保证一日三餐与蛋白质摄入，配合力量练习（深蹲、俯卧撑）增肌。',
};

/* ==========================================================================
 * 二、报告数据计算
 * ========================================================================== */

/** 总分 → 等级（与成绩册同一套线） */
function fitnessDiagnosisLevelOf(total) {
  if (total === null || total === undefined) return '';
  if (typeof fitnessGradebookLevel === 'function') return fitnessGradebookLevel(total);
  if (total >= 90) return '优秀';
  if (total >= 80) return '良好';
  if (total >= 60) return '及格';
  return '不及格';
}

/** 等级 → 徽章样式 */
function fitnessDiagnosisLevelClass(level) {
  if (typeof FITNESS_GRADEBOOK_LEVEL_CLASS !== 'undefined' && FITNESS_GRADEBOOK_LEVEL_CLASS[level]) {
    return FITNESS_GRADEBOOK_LEVEL_CLASS[level];
  }
  if (level === '优秀') return 'badge-success';
  if (level === '良好') return 'badge-info';
  if (level === '及格') return 'badge-warning';
  return 'badge-danger';
}

/** 数字保留 1 位小数（去掉多余的 .0） */
function fitnessDiagnosisNum(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** HTML 转义（优先用全局的 escapeFitnessHTML） */
function fitnessDiagnosisEscape(value) {
  if (typeof escapeFitnessHTML === 'function') return escapeFitnessHTML(value);
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

/**
 * 生成一个学生的诊断报告数据。
 * @param {object} row 成绩册的一行（fitnessGradebookBuildRow 的产物）
 */
function fitnessDiagnosisBuildReport(row) {
  const student = row?.student || {};
  const weights = (typeof DB.getAnnualFitnessWeights === 'function'
    ? DB.getAnnualFitnessWeights(student.grade)
    : null) || {};
  const total = row?.total?.total ?? null;
  const level = row?.total?.level || fitnessDiagnosisLevelOf(total);
  const averageScore = row?.averageScore ?? null;
  // 缺项时总分按已有权重归一化算出，增分也要跟着归一化
  const rawAvailable = Number(row?.total?.availableWeight);
  const availableWeight = Number.isFinite(rawAvailable) && rawAvailable > 0 ? rawAvailable : 1;

  const items = [];
  const weakItems = [];
  let bmi = null;

  (typeof FITNESS_GRADEBOOK_COLUMNS !== 'undefined' ? FITNESS_GRADEBOOK_COLUMNS : []).forEach(column => {
    const cell = row?.cells?.get?.(column.key);
    if (!cell || cell.empty || cell.score === null || cell.score === undefined) return;

    const weight = Number(weights[column.key]) || 0;
    const item = {
      key: column.key,
      name: column.name,
      unit: cell.unit || column.unit || '',
      value: cell.value,
      score: cell.score,
      level: cell.level || '',
      weight,
      weightText: `${Math.round(weight * 100)}%`,
    };
    items.push(item);

    if (column.key === 'BMI') {
      bmi = { ...item, category: cell.category || cell.level || '' };
      return;                       // BMI 是长期项：不进短期弱项
    }

    // ── 弱项判定（与「弱项分布图」同一口径）──
    const failLine = typeof FITNESS_WEAK_FAIL_SCORE !== 'undefined' ? FITNESS_WEAK_FAIL_SCORE : 60;
    const lagLine = typeof FITNESS_WEAK_LAG_SCORE !== 'undefined' ? FITNESS_WEAK_LAG_SCORE : 80;
    const lagGap = typeof FITNESS_WEAK_LAG_GAP !== 'undefined' ? FITNESS_WEAK_LAG_GAP : 8;

    let target = null;
    let type = null;
    if (item.score < failLine) {
      target = failLine; type = 'fail';
    } else if (item.score < lagLine && averageScore !== null && item.score < averageScore - lagGap) {
      target = lagLine; type = 'lag';
    }
    if (target === null) return;

    const gain = (target - item.score) * weight / availableWeight;
    weakItems.push({
      ...item,
      target,
      type,
      typeText: type === 'fail' ? '未达标' : '拖后腿',
      gain,
      gainText: `+${fitnessDiagnosisNum(gain)}`,
    });
  });

  // 提分收益大的排前面（同样时间，先补最划算的那项）
  weakItems.sort((a, b) => b.gain - a.gain);

  // ── 体型风险（BMI 异常，长期项）──
  let bmiRisk = null;
  if (bmi && bmi.score < 100) {
    const gain = (100 - bmi.score) * bmi.weight / availableWeight;
    bmiRisk = {
      ...bmi,
      gain,
      gainText: `+${fitnessDiagnosisNum(gain)}`,
      advice: FITNESS_DIAGNOSIS_BMI_ADVICE[bmi.category] || '',
    };
  }

  // ── 提分预测（只算短期弱项，BMI 不计）──
  const totalGain = weakItems.reduce((sum, item) => sum + item.gain, 0);
  let prediction = null;
  if (total !== null) {
    const predicted = Math.min(120, total + totalGain);
    const toLevel = fitnessDiagnosisLevelOf(predicted);
    prediction = {
      count: weakItems.length,
      gain: totalGain,
      gainText: `+${fitnessDiagnosisNum(totalGain)}`,
      predicted,
      predictedText: fitnessDiagnosisNum(predicted),
      fromLevel: level,
      toLevel,
      changed: level !== toLevel,
    };
  }

  // ── 训练处方：取最弱的 1~2 项 ──
  const prescriptions = weakItems.slice(0, 2)
    .map(item => ({ key: item.key, score: item.score, ...(FITNESS_DIAGNOSIS_PRESCRIPTIONS[item.key] || null) }))
    .filter(item => item && item.title);

  const classText = `${student.grade || ''}${student.class || ''}`.trim();
  return {
    student: {
      name: student.name || '',
      gender: student.gender || '',
      grade: student.grade || '',
      className: student.class || '',
      classText,
    },
    avatar: String(student.name || '?').trim().charAt(0) || '?',
    total,
    totalText: total === null ? '—' : fitnessDiagnosisNum(total),
    level,
    levelClass: fitnessDiagnosisLevelClass(level),
    averageScore,
    averageScoreText: averageScore === null ? '—' : fitnessDiagnosisNum(averageScore),
    bmi,
    bmiText: bmi ? fitnessDiagnosisNum(bmi.value) : '—',
    items,
    weakItems,
    bmiRisk,
    prediction,
    prescriptions,
    hasWeak: weakItems.length > 0,
  };
}

/* ==========================================================================
 * 三、弹窗 UI
 * ========================================================================== */

/** 当前打开的报告（复制 / 打印时要用） */
let fitnessDiagnosisCurrent = null;

/** 打开某个学生的诊断报告（index = 成绩册里的行号） */
function openFitnessDiagnosis(index) {
  const data = typeof fitnessGradebookBuild === 'function' ? fitnessGradebookBuild() : null;
  const row = data?.rows?.[Number(index)];
  if (!row) {
    showToast('没有找到该学生的成绩数据', 'error');
    return;
  }
  const report = fitnessDiagnosisBuildReport(row);
  fitnessDiagnosisCurrent = report;
  fitnessDiagnosisShowModal(report);
}

/** 渲染并弹出报告弹窗 */
function fitnessDiagnosisShowModal(report) {
  const existing = document.getElementById('fitnessDiagnosisOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'fitness-dx-overlay';
  overlay.id = 'fitnessDiagnosisOverlay';
  overlay.innerHTML = `
    <div class="fitness-dx-modal" role="dialog" aria-modal="true" aria-label="个人成绩诊断报告">
      <header class="fitness-dx-modal-head">
        <div class="fitness-dx-modal-title">
          <span class="fitness-dx-modal-icon">🏥</span>
          <div>
            <h2>个人成绩诊断报告</h2>
            <p>《国家学生体质健康标准》(2014年修订版) 口径</p>
          </div>
        </div>
        <button class="fitness-dx-close" type="button" aria-label="关闭"
          onclick="closeFitnessDiagnosis()">&times;</button>
      </header>
      <div class="fitness-dx-modal-body">${fitnessDiagnosisReportHTML(report)}</div>
      <footer class="fitness-dx-actions">
        <button class="btn btn-primary" type="button" onclick="copyFitnessDiagnosisReport()">📋 复制发家长</button>
        <button class="btn btn-secondary" type="button" onclick="printFitnessDiagnosisReport()">🖨️ 打印这张诊断单</button>
        <button class="btn btn-ghost" type="button" onclick="closeFitnessDiagnosis()">关闭</button>
      </footer>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  overlay.addEventListener('click', event => {
    if (event.target === overlay) closeFitnessDiagnosis();
  });
  document.addEventListener('keydown', fitnessDiagnosisOnKeydown);
}

/** Esc 关闭 */
function fitnessDiagnosisOnKeydown(event) {
  if (event.key === 'Escape') closeFitnessDiagnosis();
}

/** 关闭弹窗 */
function closeFitnessDiagnosis() {
  const overlay = document.getElementById('fitnessDiagnosisOverlay');
  if (overlay) {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 260);
  }
  document.removeEventListener('keydown', fitnessDiagnosisOnKeydown);
  fitnessDiagnosisCurrent = null;
}

/** 一条弱项卡片 */
function fitnessDiagnosisWeakCardHTML(item) {
  const valueText = item.unit ? `${fitnessDiagnosisNum(item.value)}${item.unit}` : fitnessDiagnosisNum(item.value);
  return `
    <div class="fitness-dx-weak is-${item.type}">
      <div class="fitness-dx-weak-top">
        <span class="fitness-dx-weak-name">${fitnessDiagnosisEscape(item.name)}</span>
        <span class="fitness-dx-weak-tag">${item.typeText}</span>
      </div>
      <div class="fitness-dx-weak-score">
        ${fitnessDiagnosisEscape(valueText)} → <b>${item.score}</b> 分 → 目标 <b>${item.target}</b> 分
      </div>
      <div class="fitness-dx-weak-meta">
        权重 <b>${item.weightText}</b> ｜ 提分 <b class="is-gain">${item.gainText}</b> 分
      </div>
    </div>`;
}

/** 报告正文（弹窗与打印共用同一份结构） */
function fitnessDiagnosisReportHTML(report) {
  const student = report.student;

  /* ① 头部信息区 */
  const head = `
    <div class="fitness-dx-head">
      <div class="fitness-dx-avatar">${fitnessDiagnosisEscape(report.avatar)}</div>
      <div class="fitness-dx-head-main">
        <div class="fitness-dx-name-row">
          <strong class="fitness-dx-name">${fitnessDiagnosisEscape(student.name)}</strong>
          <span class="badge ${report.levelClass}">${fitnessDiagnosisEscape(report.level || '—')}</span>
        </div>
        <div class="fitness-dx-meta">
          ${fitnessDiagnosisEscape(student.gender || '—')} ｜ ${fitnessDiagnosisEscape(student.classText || '—')}
        </div>
      </div>
      <div class="fitness-dx-head-metrics">
        <div class="fitness-dx-metric">
          <span>总分</span><b>${fitnessDiagnosisEscape(report.totalText)}</b>
        </div>
        <div class="fitness-dx-metric">
          <span>全项平均分</span><b>${fitnessDiagnosisEscape(report.averageScoreText)}</b>
        </div>
        <div class="fitness-dx-metric">
          <span>BMI</span>
          <b>${fitnessDiagnosisEscape(report.bmiText)}
            <i class="fitness-dx-bmi-tag ${report.bmiRisk ? 'is-risk' : 'is-ok'}">${fitnessDiagnosisEscape(report.bmi?.category || '—')}</i>
          </b>
        </div>
      </div>
    </div>`;

  /* ② 弱项与提分优先级 */
  const weakSection = report.hasWeak
    ? `<div class="fitness-dx-weak-list">${report.weakItems.map(fitnessDiagnosisWeakCardHTML).join('')}</div>`
    : '<p class="fitness-dx-empty">🌟 暂无弱项，各项均已达到良好水平，保持现有训练强度即可。</p>';

  /* ③ 体型风险 */
  let riskSection = '';
  if (report.bmiRisk) {
    riskSection = `
      <section class="fitness-dx-section is-risk">
        <h3>⚠️ 体型风险</h3>
        <div class="fitness-dx-risk-box">
          体型风险：BMI <b>${fitnessDiagnosisEscape(report.bmiText)}</b>（${fitnessDiagnosisEscape(report.bmiRisk.category)}）。
          该项权重 <b>${report.bmiRisk.weightText}</b>，回到“正常”档可加约 <b>${report.bmiRisk.gainText}</b> 分
          （属长期项，不计入短期弱项）。
          ${report.bmiRisk.advice ? `<span class="fitness-dx-risk-advice">${fitnessDiagnosisEscape(report.bmiRisk.advice)}</span>` : ''}
        </div>
      </section>`;
  }

  /* ④ 提分预测 */
  let predictSection = '';
  if (report.prediction) {
    const p = report.prediction;
    predictSection = `
      <section class="fitness-dx-section is-predict">
        <h3>💡 提分预测</h3>
        <div class="fitness-dx-predict-box">
          ${p.count > 0
            ? `把上面 <b>${p.count}</b> 项练到达标线 → 预计总分 <b class="is-gain">${p.predictedText}</b> 分`
              + `（${p.gainText} 分），等级 ${fitnessDiagnosisEscape(p.fromLevel || '—')} → <b>${fitnessDiagnosisEscape(p.toLevel || '—')}</b>`
            : `各项已达标，短期没有提分空间；维持现状，总分保持 <b>${fitnessDiagnosisEscape(report.totalText)}</b> 分。`}
        </div>
      </section>`;
  }

  /* ⑤ 训练处方 */
  const prescriptionSection = report.prescriptions.length
    ? report.prescriptions.map(item => `
        <div class="fitness-dx-rx">
          <div class="fitness-dx-rx-head">
            <strong>${fitnessDiagnosisEscape(item.title)}</strong>
            <span class="fitness-dx-rx-score">当前 ${item.score} 分</span>
          </div>
          <p class="fitness-dx-rx-summary">${fitnessDiagnosisEscape(item.summary)}</p>
          <ul class="fitness-dx-rx-list">
            ${item.drills.map(drill => `
              <li><b>${fitnessDiagnosisEscape(drill.name)}</b><span>${fitnessDiagnosisEscape(drill.detail)}</span></li>
            `).join('')}
          </ul>
        </div>`).join('')
    : '<p class="fitness-dx-empty">🌟 保持现有训练强度，继续巩固优势项目即可。</p>';

  return `
    <div class="fitness-dx-report">
      ${head}
      <section class="fitness-dx-section">
        <h3>⚠️ 弱项与提分优先级</h3>
        ${weakSection}
      </section>
      ${riskSection}
      ${predictSection}
      <section class="fitness-dx-section">
        <h3>🏃 训练处方</h3>
        ${prescriptionSection}
      </section>
    </div>`;
}

/* ==========================================================================
 * 四、复制发家长
 * ========================================================================== */

/** 生成带 Emoji 的纯文本报告（方便直接粘到微信群） */
function fitnessDiagnosisPlainText(report) {
  const lines = [];
  const student = report.student;
  lines.push(`🏥 ${student.name} · 个人成绩诊断报告`);
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`👤 ${student.gender || '—'} ｜ ${student.classText || '—'}`);
  lines.push(`📊 总分：${report.totalText} 分（${report.level || '—'}）｜ 全项平均分：${report.averageScoreText} 分`);
  lines.push(`⚖️ BMI：${report.bmiText}（${report.bmi?.category || '—'}）`);

  lines.push('');
  lines.push('⚠️ 弱项与提分优先级');
  if (report.hasWeak) {
    report.weakItems.forEach((item, index) => {
      const valueText = item.unit ? `${fitnessDiagnosisNum(item.value)}${item.unit}` : fitnessDiagnosisNum(item.value);
      lines.push(`${index + 1}. ${item.name}：${valueText} → ${item.score}分 → 目标${item.target}分`
        + `｜权重${item.weightText}｜提分：${item.gainText}分（${item.typeText}）`);
    });
  } else {
    lines.push('🌟 暂无弱项，各项均达到良好水平。');
  }

  if (report.bmiRisk) {
    lines.push('');
    lines.push('⚠️ 体型风险');
    lines.push(`BMI ${report.bmiText}（${report.bmiRisk.category}），该项权重${report.bmiRisk.weightText}，`
      + `回到“正常”档可加约 ${report.bmiRisk.gainText} 分（长期项，不计入短期弱项）。`);
  }

  if (report.prediction) {
    lines.push('');
    lines.push('💡 提分预测');
    lines.push(report.prediction.count > 0
      ? `把上面 ${report.prediction.count} 项练到达标线 → 预计总分 ${report.prediction.predictedText} 分`
        + `（${report.prediction.gainText} 分），等级 ${report.prediction.fromLevel || '—'} → ${report.prediction.toLevel || '—'}。`
      : '各项已达标，短期没有提分空间，维持现状即可。');
  }

  lines.push('');
  lines.push('🏃 训练处方');
  if (report.prescriptions.length) {
    report.prescriptions.forEach(item => {
      lines.push(`【${item.title}】${item.summary}`);
      item.drills.forEach(drill => lines.push(`  · ${drill.name}：${drill.detail}`));
    });
  } else {
    lines.push('保持现有训练强度，继续巩固优势项目。');
  }

  lines.push('');
  lines.push('—— 《国家学生体质健康标准》(2014年修订版) 口径 ｜ 体育教师工作台');
  return lines.join('\n');
}

/** 复制报告到剪贴板 */
async function copyFitnessDiagnosisReport() {
  const report = fitnessDiagnosisCurrent;
  if (!report) {
    showToast('没有可复制的报告', 'error');
    return;
  }
  const text = fitnessDiagnosisPlainText(report);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      showToast('诊断报告已复制，可直接粘贴发家长群', 'success');
      return;
    }
    throw new Error('clipboard 不可用');
  } catch (error) {
    // 兜底：老浏览器 / 非安全上下文（http 页面）拿不到 clipboard API
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    area.remove();
    showToast(ok ? '诊断报告已复制，可直接粘贴发家长群' : '复制失败，请手动选中文本复制', ok ? 'success' : 'error');
  }
}

/* ==========================================================================
 * 五、打印（A4）
 * ========================================================================== */

/** 打印用的独立 HTML（自带 @page A4 规则） */
function fitnessDiagnosisPrintHTML(report) {
  // 用绝对地址引样式表：iframe 是 about:blank，相对路径可能解析不到
  let cssHref = 'css/fitness-diagnosis.css';
  try {
    const base = (typeof document !== 'undefined' && document.baseURI)
      || (typeof location !== 'undefined' && location.href)
      || '';
    if (base) cssHref = new URL('css/fitness-diagnosis.css', base).href;
  } catch (error) { /* 解析不了就用相对路径 */ }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${fitnessDiagnosisEscape(report.student.name)} · 个人成绩诊断报告</title>
<link rel="stylesheet" href="${cssHref}">
<style>
  @page { size: A4 portrait; margin: 12mm; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body.fitness-dx-print { padding: 0; }
  .fitness-dx-print .fitness-dx-report { border: 0; box-shadow: none; padding: 0; }
</style>
</head>
<body class="fitness-dx-print">${fitnessDiagnosisReportHTML(report)}</body>
</html>`;
}

/**
 * 打印诊断单：把报告写进一个藏在屏幕外的 iframe，再调它的 print()。
 * 好处：① 打印出来的只有诊断单本身；② iframe 有独立样式，@page 可以单独设成 A4 纵向；
 *       ③ 不弹新窗口 → 不会被浏览器的弹窗拦截器挡住。
 */
function printFitnessDiagnosisReport() {
  const report = fitnessDiagnosisCurrent;
  if (!report) {
    showToast('没有可打印的报告', 'error');
    return;
  }
  const frame = document.getElementById('fitnessDiagnosisPrintFrame');
  if (!frame) {
    showToast('打印区缺失，请刷新页面后重试', 'error');
    return;
  }
  const frameWindow = frame.contentWindow;
  const doc = frameWindow?.document;
  if (!doc) {
    showToast('打印区初始化失败，请刷新页面后重试', 'error');
    return;
  }
  doc.open();
  doc.write(fitnessDiagnosisPrintHTML(report));
  doc.close();
  try { frameWindow.focus(); } catch (error) { /* 忽略：部分浏览器会拒绝聚焦 */ }
  showToast('正在打开打印预览，请确认纸张为 A4 纵向…', 'info');
  // 等一帧让排版稳定，再调打印
  setTimeout(() => {
    try {
      frameWindow.print();
    } catch (error) {
      console.error('诊断单打印失败', error);
      showToast('打印失败，请检查浏览器的打印权限设置', 'error');
    }
  }, 320);
}
