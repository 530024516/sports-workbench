'use strict';

/**
 * 大单元数据模型 —— 大单元设计页 与 离线资源库页 共用的唯一真相源。
 *
 * 为什么不放在 unit-design.js 里：
 *   离线资源库要把「完整的 11 个模块」存进 localStorage / Supabase 再取出来渲染，
 *   如果两边各写一份数据结构，加第 12 个模块时必然有一边漏改。
 *   所以：模型（形状 + 归一化 + 导出）放这里，两个页面都只读这一份。
 *
 * 结构：11 个模块 + 18 课时计划表 + 结构图四分支（详见 UNIT_MODULES）。
 * 所有写 AI 结果 / 读资源库数据的地方，都必须先过 normalizeUnit() 兜底整形。
 */

const UNIT_LESSON_COUNT = 18;

/** 11 个模块（顺序与 AI 输出要求严格一致） */
const UNIT_MODULES = [
  { id: 'objectives', title: '教学目标', hint: '运动能力 / 健康行为 / 体育品德' },
  { id: 'textbookAnalysis', title: '教材分析', hint: '主要内容、核心素养、锻炼与育人价值' },
  { id: 'studentAnalysis', title: '学情分析', hint: '结合所选水平的认知与身体发展特点' },
  { id: 'teachingContent', title: '主要教学内容', hint: '知识、技术、战术、体能、比赛' },
  { id: 'keyDifficulties', title: '教学重难点', hint: '学生学习 / 学习内容 / 教学组织 / 教学方法' },
  { id: 'structure', title: '大单元设计结构图', hint: '四主干分支挂载 18 个课时' },
  { id: 'lessons', title: '18 课时计划表', hint: '每行含三维目标、内容、组织教法' },
  { id: 'assessment', title: '考核与作业', hint: '依据课标学业质量要求' },
  { id: 'evaluation', title: '学习评价', hint: '过程性 + 终结性 + 学练赛评一体化' },
  { id: 'reflection', title: '教学反思', hint: '课后填写框架模板' },
  { id: 'resources', title: '教学资源', hint: '图文 / 视频 / 器材清单' },
];

/** 模块 6 的四个主干分支 */
const UNIT_STRUCTURE_BRANCHES = [
  { id: 'basic', label: '基础知识' },
  { id: 'technique', label: '基本技术' },
  { id: 'tactics', label: '技战术运用' },
  { id: 'fitness', label: '专项体能' },
];

function escapeUnitHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function createEmptyUnit() {
  return {
    meta: {
      unitTitle: '', category: '', categoryId: '', item: '', itemId: '',
      level: '', levelId: '', topic: '', topicPending: false, generatedAt: '',
    },
    unitTitle: '',
    objectives: { ability: '', health: '', character: '' },
    textbookAnalysis: '',
    studentAnalysis: '',
    teachingContent: '',
    keyDifficulties: { learning: '', content: '', organization: '', method: '' },
    structure: { basic: [], technique: [], tactics: [], fitness: [] },
    lessons: Array.from({ length: UNIT_LESSON_COUNT }, (_, index) => ({
      no: index + 1,
      objectives: { ability: '', health: '', character: '' },
      content: '',
      method: '',
    })),
    assessment: '',
    evaluation: { process: '', summative: '', integration: '' },
    reflection: '',
    resources: '',
  };
}

/** 兜底补齐：保证 lessons 恰好 18 条、structure 四个分支都是数组、objectives/evaluation 是对象 */
function normalizeUnit(data) {
  const base = createEmptyUnit();
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const lessons = Array.isArray(source.lessons) ? source.lessons : [];
  return {
    ...base,
    ...source,
    unitTitle: typeof source.unitTitle === 'string'
      ? source.unitTitle : (typeof source.meta?.unitTitle === 'string' ? source.meta.unitTitle : ''),
    meta: { ...base.meta, ...(source.meta || {}) },
    objectives: { ...base.objectives, ...(source.objectives || {}) },
    keyDifficulties: { ...base.keyDifficulties, ...(source.keyDifficulties || {}) },
    evaluation: { ...base.evaluation, ...(source.evaluation || {}) },
    structure: {
      basic: normalizeStructureBranch(source.structure?.basic),
      technique: normalizeStructureBranch(source.structure?.technique),
      tactics: normalizeStructureBranch(source.structure?.tactics),
      fitness: normalizeStructureBranch(source.structure?.fitness),
    },
    lessons: base.lessons.map((lesson, index) => {
      const item = lessons[index] || {};
      return {
        no: index + 1,
        objectives: { ...lesson.objectives, ...(item.objectives || {}) },
        content: typeof item.content === 'string' ? item.content : '',
        method: typeof item.method === 'string' ? item.method : '',
      };
    }),
  };
}

function normalizeStructureBranch(branch) {
  if (!Array.isArray(branch)) return [];
  return branch
    .map((node, index) => ({
      no: Number.isInteger(node?.no) ? node.no : index + 1,
      title: typeof node?.title === 'string' ? node.title : String(node?.title ?? ''),
    }))
    .filter(node => Number.isFinite(node.no))
    .sort((a, b) => a.no - b.no);
}

function unitHasContent(...values) {
  return values.some(value => String(value ?? '').trim());
}

/** 某个模块是否已有内容（结果页 / 资源库详情页的状态标记都用它） */
function unitModuleCompleted(unit, id) {
  const data = normalizeUnit(unit);
  switch (id) {
    case 'objectives': return unitHasContent(data.objectives.ability, data.objectives.health, data.objectives.character);
    case 'keyDifficulties': return unitHasContent(data.keyDifficulties.learning, data.keyDifficulties.content,
      data.keyDifficulties.organization, data.keyDifficulties.method);
    case 'evaluation': return unitHasContent(data.evaluation.process, data.evaluation.summative, data.evaluation.integration);
    case 'structure': return UNIT_STRUCTURE_BRANCHES.some(branch => data.structure[branch.id].length);
    case 'lessons': return data.lessons.some(lesson => unitHasContent(lesson.content, lesson.method,
      lesson.objectives.ability, lesson.objectives.health, lesson.objectives.character));
    default: return unitHasContent(data[id]);
  }
}

function structureNodeCount(unit) {
  const data = normalizeUnit(unit);
  return UNIT_STRUCTURE_BRANCHES.reduce((total, branch) => total + data.structure[branch.id].length, 0);
}

/** 结构图里缺了哪些课次（1–18 没被挂载的） */
function missingStructureNumbers(unit) {
  const data = normalizeUnit(unit);
  const seen = new Set();
  UNIT_STRUCTURE_BRANCHES.forEach(branch => data.structure[branch.id].forEach(node => seen.add(node.no)));
  const missing = [];
  for (let no = 1; no <= UNIT_LESSON_COUNT; no += 1) if (!seen.has(no)) missing.push(no);
  return missing;
}

/**
 * 结构图缺课时时按序号兜底补齐（按课时表的标题）。
 * 纯函数：返回新对象，不改动传入的 unit。
 * 归属分支规则：1–2 基础知识，3–9 基本技术，10–15 技战术运用，16–18 专项体能。
 */
function autoFillStructure(unit) {
  const data = normalizeUnit(unit);
  const missing = missingStructureNumbers(data);
  if (!missing.length) return data;
  const structure = {
    basic: [...data.structure.basic],
    technique: [...data.structure.technique],
    tactics: [...data.structure.tactics],
    fitness: [...data.structure.fitness],
  };
  missing.forEach(no => {
    const lesson = data.lessons[no - 1];
    const title = `第${no}课次：${String(lesson?.content || '').split(/[\n，,。;；]/)[0].slice(0, 18) || '待补充'}`.trim();
    const branch = no <= 2 ? 'basic' : no <= 9 ? 'technique' : no <= 15 ? 'tactics' : 'fitness';
    structure[branch].push({ no, title });
  });
  return { ...data, structure };
}

function unitGetPath(unit, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], unit) ?? '';
}

function unitSetPath(unit, path, value) {
  const keys = String(path).split('.');
  const finalKey = keys.pop();
  const parent = keys.reduce((current, key) => current[key], unit);
  if (parent && typeof parent === 'object') parent[finalKey] = value;
  return unit;
}

/** 一句话摘要：球类 · 篮球 · 水平三（5–6 年级） · 教学内容（卡片 / 弹窗标题用） */
function unitSummaryLine(unit) {
  const meta = normalizeUnit(unit).meta;
  return [meta.category, meta.item, meta.level, meta.topic].filter(Boolean).join(' · ');
}

function unitExportSection(title, bodyHTML) {
  return `<h2>${escapeUnitHTML(title)}</h2><section>${bodyHTML}</section>`;
}

/** 导出 / 打印用的完整 HTML（两个页面共用同一份排版） */
function buildUnitExportHTML(unit) {
  const d = normalizeUnit(unit);
  const lessonRows = d.lessons.map(lesson => `<tr>
    <td>第 ${lesson.no} 课</td>
    <td>运动能力：${escapeUnitHTML(lesson.objectives.ability)}<br>健康行为：${escapeUnitHTML(lesson.objectives.health)}<br>体育品德：${escapeUnitHTML(lesson.objectives.character)}</td>
    <td>${escapeUnitHTML(lesson.content)}</td>
    <td>${escapeUnitHTML(lesson.method)}</td></tr>`).join('');
  const branchList = UNIT_STRUCTURE_BRANCHES.map(branch => `<p><b>${branch.label}：</b>`
    + (d.structure[branch.id].map(node => `${node.no}. ${escapeUnitHTML(node.title)}`).join('；') || '—') + '</p>').join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>${escapeUnitHTML(d.unitTitle || '大单元设计')}</title>
    <style>body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#222;line-height:1.6;margin:28px}
    h1{text-align:center}h2{margin-top:24px;border-bottom:1px solid #bbb;padding-bottom:6px;font-size:16px}
    h3{font-size:14px;margin:12px 0 4px}
    table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #888;padding:6px;vertical-align:top;text-align:left}
    th{background:#eee}section{white-space:pre-wrap;margin-bottom:10px}
    .meta{text-align:center;color:#555;margin-bottom:18px}
    .page-break{page-break-before:always}
    @media print{body{margin:12mm}table{page-break-inside:auto}tr{page-break-inside:avoid}}</style></head><body>
    <h1>${escapeUnitHTML(d.unitTitle || '大单元设计')}</h1>
    <p class="meta">${escapeUnitHTML(unitSummaryLine(d))}</p>
    ${unitExportSection('一、教学目标', `<b>运动能力：</b>${escapeUnitHTML(d.objectives.ability)}<br><b>健康行为：</b>${escapeUnitHTML(d.objectives.health)}<br><b>体育品德：</b>${escapeUnitHTML(d.objectives.character)}`)}
    ${unitExportSection('二、教材分析', escapeUnitHTML(d.textbookAnalysis))}
    ${unitExportSection('三、学情分析', escapeUnitHTML(d.studentAnalysis))}
    ${unitExportSection('四、主要教学内容', escapeUnitHTML(d.teachingContent))}
    ${unitExportSection('五、教学重难点', `<b>学生学习的重难点：</b>${escapeUnitHTML(d.keyDifficulties.learning)}<br><b>学习内容的重难点：</b>${escapeUnitHTML(d.keyDifficulties.content)}<br><b>教学组织的重难点：</b>${escapeUnitHTML(d.keyDifficulties.organization)}<br><b>教学方法的重难点：</b>${escapeUnitHTML(d.keyDifficulties.method)}`)}
    ${unitExportSection('六、大单元设计结构图', branchList)}
    ${'<h2 class="page-break">七、18 课时计划表</h2><table><thead><tr><th>课时</th><th>学习目标（三维）</th><th>教学内容</th><th>组织教学与方法</th></tr></thead><tbody>' + lessonRows + '</tbody></table>'}
    ${unitExportSection('八、考核与作业', escapeUnitHTML(d.assessment))}
    ${unitExportSection('九、学习评价', `<b>过程性评价：</b>${escapeUnitHTML(d.evaluation.process)}<br><b>终结性评价：</b>${escapeUnitHTML(d.evaluation.summative)}<br><b>学练赛评一体化：</b>${escapeUnitHTML(d.evaluation.integration)}`)}
    ${unitExportSection('十、教学反思', escapeUnitHTML(d.reflection))}
    ${unitExportSection('十一、教学资源', escapeUnitHTML(d.resources))}
    </body></html>`;
}

if (typeof window !== 'undefined') {
  window.UNIT_LESSON_COUNT = UNIT_LESSON_COUNT;
  window.UNIT_MODULES = UNIT_MODULES;
  window.UNIT_STRUCTURE_BRANCHES = UNIT_STRUCTURE_BRANCHES;
  window.escapeUnitHTML = escapeUnitHTML;
  window.createEmptyUnit = createEmptyUnit;
  window.normalizeUnit = normalizeUnit;
  window.normalizeStructureBranch = normalizeStructureBranch;
  window.unitHasContent = unitHasContent;
  window.unitModuleCompleted = unitModuleCompleted;
  window.missingStructureNumbers = missingStructureNumbers;
  window.structureNodeCount = structureNodeCount;
  window.autoFillStructure = autoFillStructure;
  window.unitGetPath = unitGetPath;
  window.unitSetPath = unitSetPath;
  window.unitSummaryLine = unitSummaryLine;
  window.buildUnitExportHTML = buildUnitExportHTML;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    UNIT_LESSON_COUNT, UNIT_MODULES, UNIT_STRUCTURE_BRANCHES, escapeUnitHTML,
    createEmptyUnit, normalizeUnit, normalizeStructureBranch, unitHasContent,
    unitModuleCompleted, missingStructureNumbers, structureNodeCount, autoFillStructure,
    unitGetPath, unitSetPath, unitSummaryLine, buildUnitExportHTML,
  };
}
