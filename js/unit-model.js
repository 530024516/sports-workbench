'use strict';

/**
 * 大单元数据模型 —— 大单元设计页 与 离线资源库页 共用的唯一真相源。
 *
 * 为什么不放在 unit-design.js 里：
 *   离线资源库要把「完整的 10 个模块」存进 localStorage / Supabase 再取出来渲染，
 *   如果两边各写一份数据结构，加第 11 个模块时必然有一边漏改。
 *   所以：模型（形状 + 归一化 + 导出）放这里，两个页面都只读这一份。
 *
 * 结构：10 个模块 + 18 课时计划表 + 结构图（矩阵泳道图：4 条维度泳道 × 18 个课次，
 * 详见 UNIT_MATRIX_DIMENSIONS 与 buildUnitStructureMatrixHTML）。
 * 所有写 AI 结果 / 读资源库数据的地方，都必须先过 normalizeUnit() 兜底整形。
 *
 * ⚠️ 2026-11 精简：原【模块 9：学习评价（纯文本）】与【模块 10：单元学习评价表（量规）】
 *    内容重复，已删除前者。现在：
 *      模块 9  = 教学反思        （原模块 10）
 *      模块 10 = 单元学习评价表  （原模块 11）
 *    字段名 reflection / rubric 一律不变 —— 老数据读进来自动落在新位置，不用迁移。
 *    老数据里的 evaluation 字段会被 normalizeUnit 直接忽略（不渲染、不覆盖别的内容）。
 */

const UNIT_LESSON_COUNT = 18;

/** 10 个模块（顺序与 AI 输出要求严格一致） */
const UNIT_MODULES = [
  { id: 'objectives', title: '教学目标', hint: '运动能力 / 健康行为 / 体育品德 三段式' },
  { id: 'textbookAnalysis', title: '教材分析', hint: '结构化内容 + 教材价值与核心素养关联' },
  { id: 'studentAnalysis', title: '学情分析', hint: '结合所选水平的认知与身体发展特点' },
  { id: 'teachingContent', title: '主要教学内容', hint: '知识、技术、战术、体能、比赛' },
  { id: 'keyDifficulties', title: '教学重难点', hint: '学生学习 / 学习内容 / 教学组织 / 教学方法（各含重点与难点）' },
  { id: 'structure', title: '大单元设计结构图', hint: '四条维度泳道 × 18 个课次的结构矩阵' },
  { id: 'lessons', title: '18 课时计划表', hint: '课次 / 学习目标 / 主要学习内容 / 教学策略' },
  { id: 'assessment', title: '考核与作业', hint: '依据课标学业质量要求' },
  { id: 'reflection', title: '教学反思', hint: '课后填写框架模板' },
  { id: 'rubric', title: '单元学习评价表', hint: '四等级量规 + 核心素养占比 + 细分得分点' },
];

/**
 * 结构图矩阵的 4 条泳道（Y 轴）—— 教材上常见的"维度 × 课次"矩阵排版：
 *   纵向 4 行 = 教学维度，横向 18 列 = 第 1–18 课次，底部再并一行"主要项目"。
 *
 * dimension 一律存【中文标签】（AI 就是这么返回的，存中文也能直接印到教材上），
 * 内部 id 只用于排序、样式与旧数据映射。
 */
const UNIT_MATRIX_DIMENSIONS = [
  { id: 'basic', label: '基础知识' },
  { id: 'technique', label: '基本技术' },
  { id: 'tactics', label: '技战术运用' },
  { id: 'match', label: '展示或比赛' },
];

/** 旧版「七大维度键」→ 新矩阵泳道 id（专项体能/规则裁判/观赏评价 归并进四条泳道） */
const UNIT_MATRIX_DIMENSION_ALIAS = {
  basic: 'basic',
  technique: 'technique',
  tactic: 'tactics',
  tactics: 'tactics',
  fitness: 'technique',      // 专项体能 → 基本技术（身体练习与技术学习同泳道）
  match: 'match',
  rule: 'tactics',           // 规则与裁判 → 技战术运用
  watch: 'match',            // 观赏与评价 → 展示或比赛
};

/** 旧版结构图的 7 个分支（只用于把老师以前存的数据迁成新结构，不再对外暴露） */
const UNIT_LEGACY_STRUCTURE_BRANCHES = [
  { id: 'basic', dim: 'basic' },
  { id: 'technique', dim: 'technique' },
  { id: 'tactics', dim: 'tactic' },
  { id: 'fitness', dim: 'fitness' },
  { id: 'match', dim: 'match' },
  { id: 'rule', dim: 'rule' },
  { id: 'watch', dim: 'watch' },
];

/** 维度（中文标签 / 内部 id / 旧七大维度键）→ 矩阵泳道 id */
function unitMatrixDimensionId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const exact = UNIT_MATRIX_DIMENSIONS.find(dimension => dimension.label === raw);
  if (exact) return exact.id;
  if (UNIT_MATRIX_DIMENSION_ALIAS[raw]) return UNIT_MATRIX_DIMENSION_ALIAS[raw];
  // 容错："技战术运用（战术）""基本技术 " 这类写法
  const fuzzy = UNIT_MATRIX_DIMENSIONS.find(dimension => raw.includes(dimension.label) || dimension.label.includes(raw));
  return fuzzy ? fuzzy.id : '';
}

/** 维度（任意写法）→ 矩阵泳道的中文标签；认不出来返回空串 */
function unitMatrixDimensionLabel(value) {
  const id = unitMatrixDimensionId(value);
  const found = UNIT_MATRIX_DIMENSIONS.find(dimension => dimension.id === id);
  return found ? found.label : '';
}

/** 课次号兜底归属（AI 没给维度时按"先学后练再赛"的顺序推） */
function unitMatrixFallbackDimension(no) {
  if (no <= 2) return '基础知识';
  if (no <= 9) return '基本技术';
  if (no <= 15) return '技战术运用';
  return '展示或比赛';
}

/** 归一化结构图节点：只保留 id ∈ 1–18 的节点，同一课次只留第一个，按课次号排序 */
function normalizeStructureNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  const byId = new Map();
  nodes.forEach(node => {
    if (!node || typeof node !== 'object') return;
    const id = Number(node.id ?? node.no);
    if (!Number.isInteger(id) || id < 1 || id > UNIT_LESSON_COUNT) return;
    if (byId.has(id)) return;
    byId.set(id, {
      id,
      dimension: unitMatrixDimensionLabel(node.dimension) || UNIT_MATRIX_DIMENSIONS[0].label,
      title: typeof node.title === 'string' ? node.title : String(node.title ?? ''),
    });
  });
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** 归一化「主要项目」：字符串数组（也接受 "A、B" 这种写法），最多留 3 个 */
function normalizeMainProjects(value) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[、,，;；]/) : []);
  return list
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

/** 旧版「七大维度分支」结构 → 新版矩阵节点（老师以前存的数据不能白丢） */
function legacyStructureToNodes(rawStructure) {
  const out = [];
  if (!rawStructure || typeof rawStructure !== 'object') return out;
  UNIT_LEGACY_STRUCTURE_BRANCHES.forEach(branch => {
    const list = Array.isArray(rawStructure[branch.id])
      ? rawStructure[branch.id]
      : (Array.isArray(rawStructure[branch.dim]) ? rawStructure[branch.dim] : []);
    list.forEach(node => {
      const id = Number(node?.no ?? node?.id);
      if (!Number.isInteger(id)) return;
      out.push({ id, dimension: branch.dim, title: String(node?.title ?? '') });
    });
  });
  return out;
}

function escapeUnitHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

/**
 * 学习目标统一成【一段式文本】：里面依次是「运动能力：…」「健康行为：…」「体育品德：…」三段。
 *
 * 为什么不再拆成三个字段：
 *   省级教研教案里"教学目标"就是一段一段写的，拆成三个小框反而逼老师写成短句、口语化。
 *   而且旧数据（老师以前存的拆分版）必须能自动并进来 —— 这就是下面这个函数的用途。
 */
function unitObjectivesToText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const parts = [['ability', '运动能力'], ['health', '健康行为'], ['character', '体育品德']]
    .map(([key, label]) => {
      const text = String(value[key] ?? '').trim();
      return text ? `${label}：${text}` : '';
    })
    .filter(Boolean);
  return parts.join('\n\n');
}

/* ---------------- 纯文本输出解析（analysis / rubric 两个阶段） ---------------- */

/** 三大核心素养的固定名称 */
const UNIT_LITERACY_NAMES = ['运动能力', '健康行为', '体育品德'];

/**
 * 按 ===NAME=== 分隔符把纯文本切成若干段。
 *
 * 为什么不用 JSON：长文本一旦被模型的输出上限拦腰截断，JSON 直接作废；
 * 纯文本的分隔符很短、几乎不可能被切断 —— 缺一段只丢那一段，前面的段落照样能用。
 *
 * 容错：没匹配到的段落就是没有（返回空串），绝不抛异常、绝不让整条流水线失败。
 */
function splitUnitTextSections(text) {
  const source = unitStripCodeFence(String(text || ''));
  const map = {};
  if (!source.trim()) return map;
  // 结束条件用 (?![\\s\\S]) 而不是 $：正则带 m 标志时 $ 会匹配到每一行行尾，
  // 那样每段都会被截成第一行 —— 这是个很隐蔽的坑。
  //
  // ⚠️ 容错分两层：
  //    ① 严格版：分隔符必须独占一行（AI 正常输出就是这样）；
  //    ② 宽松版：分隔符前面还粘着别的字也算数（AI 偶尔写成"好的：===OBJECTIVES==="）。
  //    严格版一个都没匹配上时才启用宽松版 —— 否则正文里出现的 ===XXX=== 会把段落切碎。
  const strict = /^[ \t]*===\s*([A-Z][A-Z0-9_]*)\s*===\s*([\s\S]*?)(?=\n[ \t]*===\s*[A-Z][A-Z0-9_]*\s*===|(?![\s\S]))/gm;
  const loose = /===\s*([A-Z][A-Z0-9_]*)\s*===[ \t]*\n?([\s\S]*?)(?=\n?===\s*[A-Z][A-Z0-9_]*\s*===|(?![\s\S]))/g;
  let hit = strict.exec(source);
  while (hit) {
    map[hit[1]] = hit[2].trim();
    hit = strict.exec(source);
  }
  // 宽松版补充：AI 常把分隔符写成"好的：===OBJECTIVES==="（不独占一行），
  // 严格版会漏掉它 —— 这里补齐，谁的内容长用谁。
  let looseHit = loose.exec(source);
  while (looseHit) {
    const name = looseHit[1];
    const value = looseHit[2].trim();
    if (!map[name] || value.length > map[name].length) map[name] = value;
    looseHit = loose.exec(source);
  }
  return map;
}

/**
 * 剥掉 Markdown 代码块围栏（```markdown … ```）。
 * AI 经常"很贴心"地把表格包起来 —— 前端不该因为这个就解析失败。
 */
function unitStripCodeFence(text) {
  return String(text || '')
    .replace(/^[ \t]*```[a-zA-Z0-9_-]*[ \t]*$/gm, '')
    .replace(/[ \t]*```[ \t]*$/g, '');
}

/**
 * 纯文本「教学目标」→「运动能力 / 健康行为 / 体育品德」三段文本。
 * 兼容几种写法：「1.运动能力：…」「运动能力：…」以及挤在一行里的三段。
 * 一个标签都认不出来时原样返回（宁可格式不完美，也不能丢内容）。
 *
 * ⚠️ 目标现在要写 350 字以上的长段落，所以切分要稳：
 *    ① 先按【行首】标签切（Prompt 要求一行一段）—— 段落里顺带提到别的素养名不会把段落切错；
 *    ② 行首切不出来（三段被挤在一行）时，再退回全文匹配。
 */
function unitObjectivesSplit(text, re) {
  const hits = [];
  let hit = re.exec(text);
  while (hit) {
    hits.push({ label: hit[1], start: hit.index, bodyStart: re.lastIndex });
    hit = re.exec(text);
  }
  if (!hits.length) return '';
  const parts = hits.map((item, index) => {
    const end = index + 1 < hits.length ? hits[index + 1].start : text.length;
    const body = text.slice(item.bodyStart, end)
      .replace(/^\s*\n+/, '')
      .replace(/^\s*\d+[.、．)）]\s*/, '')      // 本段开头的序号（如 "1."）
      .replace(/\s*\d+[.、．)）]\s*$/, '')      // 下一段序号漏在本段末尾的残留（如 "2."）
      .replace(/[；;，,、]\s*$/, '')
      .trim();
    return body ? `${item.label}：${body}` : '';
  }).filter(Boolean);
  return parts.length ? parts.join('\n\n') : '';
}

function unitObjectivesFromPlainText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  // ① 行首标签优先（长段落里不会被别的素养名带偏）
  let out = unitObjectivesSplit(text, /(?:^|\n)[ \t]*(?:\d+[.、．)）][ \t]*)?(运动能力|健康行为|体育品德)[ \t]*[:：][ \t]*/g);
  // ② 退回全文匹配（三段挤在一行时也要认得出来）
  if (!out) out = unitObjectivesSplit(text, /(运动能力|健康行为|体育品德)[ \t]*[:：][ \t]*/g);
  return out || text;
}

/** 「XX重难点：重点：… 难点：…」→ 四个子维度里对应的那一个 */
function unitDifficultyKeyOf(line) {
  const head = String(line || '').split(/[:：]/)[0] || '';
  if (/学生/.test(head)) return 'learning';
  if (/内容/.test(head)) return 'content';
  if (/组织/.test(head)) return 'organization';
  if (/方法/.test(head)) return 'method';
  return '';
}

/**
 * 把「重点：A 难点：B」整理成两行（重点 / 难点各一行），更好读也更好编辑。
 * 兼容三种写法：「重点：A」「重点是 A」「重点在于 A」（AI 写长文时很容易写成后两种）。
 */
function unitFocusDifficultyText(line) {
  const text = String(line || '').trim();
  if (!text) return '';
  // 先摘掉「XX重难点：」这个前缀 —— 否则 "重难点" 里的"难点"会被误当成标记
  const body = text.replace(/^[^\n：:]*重难点\s*[：:]\s*/, '');
  const focus = body.match(/重点\s*(?:[:：]|是|在于)\s*([\s\S]*?)(?=\s*难点\s*(?:[:：]|是|在于)|$)/);
  const hard = body.match(/难点\s*(?:[:：]|是|在于)\s*([\s\S]*)$/);
  const focusText = focus ? focus[1].trim() : '';
  const hardText = hard ? hard[1].trim() : '';
  if (!focusText && !hardText) return text;
  return [
    focusText ? `重点：${focusText}` : '',
    hardText ? `难点：${hardText}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 解析纯文本版的前置分析（模块 1–5）。
 * 返回值里【只放有内容的字段】—— 空字段会被前端直接跳过，不会把老师已有的内容覆盖掉。
 */
function parseUnitAnalysisText(text) {
  const map = splitUnitTextSections(text);
  const result = {};
  const put = (key, value) => {
    const text2 = String(value ?? '').trim();
    if (text2) result[key] = text2;
  };
  put('unitTitle', map.TITLE);
  put('objectives', unitObjectivesFromPlainText(map.OBJECTIVES));
  put('textbookAnalysis', map.TEXTBOOK);
  put('studentAnalysis', map.STUDENTS);
  put('teachingContent', map.CONTENT);

  const difficulties = {};
  // 重难点现在要写"原因 + 应对措施"，一行可能很长、也可能换行续写。
  // 只有【行首明确是某个子维度】才切换；其余行一律归到上一个子维度，绝不丢内容。
  let currentKey = '';
  String(map.DIFFICULTIES || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .forEach(line => {
      const strictKey = unitDifficultyKeyOf(line);
      const isNewBlock = strictKey && /重难点/.test(line.split(/[:：]/)[0] || '');
      if (isNewBlock) {
        currentKey = strictKey;
        const value = unitFocusDifficultyText(line);
        if (value) difficulties[currentKey] = value;
        return;
      }
      if (!currentKey) return;                 // 没有归属的散行：跳过（不硬塞）
      const previous = difficulties[currentKey] || '';
      difficulties[currentKey] = previous ? `${previous}\n${line}` : line;
    });
  if (Object.keys(difficulties).length) result.keyDifficulties = difficulties;
  return result;
}

/** Markdown 表格 → 二维数组（自动跳过 |---|---| 分隔行） */
function unitParseMarkdownRows(text) {
  const lines = unitStripCodeFence(String(text || '')).split('\n').map(line => line.trim()).filter(Boolean);
  const rows = [];
  lines.forEach(line => {
    if (!line.includes('|')) return;
    if (/^\|?[\s:\-|]+\|?$/.test(line)) return;          // 分隔行（|---|---| 或 | :--- |）
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
    if (!cells.length) return;
    rows.push(cells);
  });
  return rows;
}

/** 量规表：等级行 → { name, range, ability, health, character } */
function unitRubricLevelsFromText(text) {
  const rows = unitParseMarkdownRows(text);
  if (!rows.length) return [];
  const headerIndex = rows.findIndex(row => row.some(cell => cell.includes('等级')));
  const header = headerIndex >= 0 ? rows[headerIndex] : ['等级', '分值', '运动能力', '健康行为', '体育品德'];
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  const pick = (row, keyword, fallback) => {
    const index = header.findIndex(cell => cell.includes(keyword));
    const source = index >= 0 ? row[index] : row[fallback];
    return String(source ?? '').trim();
  };
  const levels = [];
  dataRows.forEach(row => {
    const name = String(row[0] ?? '').trim();
    if (!name || name.includes('等级')) return;
    levels.push({
      name,
      range: pick(row, '分值', 1),
      ability: pick(row, '运动能力', 2),
      health: pick(row, '健康行为', 3),
      character: pick(row, '体育品德', 4),
    });
  });
  return levels;
}

/** 素养占比表 → [{ name, percent }] */
function unitRubricWeightsFromText(text) {
  const rows = unitParseMarkdownRows(text);
  const weights = [];
  rows.forEach(row => {
    const name = String(row[0] ?? '').trim();
    if (!UNIT_LITERACY_NAMES.includes(name)) return;
    const percent = Number(String(row[1] ?? '').replace(/[^\d.]/g, ''));
    if (!percent) return;
    weights.push({ name, percent });
  });
  return weights;
}

/** 得分点 → [{ name, literacy, points, desc }]（表格与「- 名称：N分」列表都认） */
function unitRubricScoresFromText(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  const rows = unitParseMarkdownRows(source);
  if (rows.length) {
    const headerIndex = rows.findIndex(row => row.some(cell => cell.includes('得分点')));
    const header = headerIndex >= 0 ? rows[headerIndex] : ['得分点', '核心素养', '分值', '评价要点'];
    const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
    const literacyIndex = header.findIndex(cell => cell.includes('素养'));
    const pointsIndex = header.findIndex(cell => cell.includes('分值'));
    const descIndex = header.findIndex(cell => cell.includes('要点') || cell.includes('标准'));
    const items = [];
    dataRows.forEach(row => {
      const name = String(row[0] ?? '').trim();
      if (!name || name.includes('得分点')) return;
      const points = Number(String(pointsIndex >= 0 ? (row[pointsIndex] ?? '') : (row[2] ?? '')).replace(/[^\d.]/g, ''));
      items.push({
        name,
        literacy: String((literacyIndex >= 0 ? (row[literacyIndex] ?? '') : (row[1] ?? '')) || '运动能力').trim(),
        points: points || 0,
        desc: String((descIndex >= 0 ? (row[descIndex] ?? '') : (row[3] ?? '')) ?? '').trim(),
      });
    });
    if (items.length) return items;
  }
  // 兜底：列表写法「- 运动知识：12分」
  const items = [];
  source.split('\n').forEach(line => {
    const hit = line.match(/[-*·]\s*(.+?)\s*[:：]\s*(\d+)\s*分?/);
    if (!hit) return;
    items.push({ name: hit[1].trim(), literacy: '运动能力', points: Number(hit[2]) || 0, desc: '' });
  });
  return items;
}

/**
 * 表格单元格 → 纯文本：
 *   · <br> 换成换行（AI 用 <br> 是因为真实换行会把表格冲散）
 *   · **小标题** 的星号剥掉，只留【小标题】文本（输入框里显示星号是噪声；
 *     导出成 Markdown 时再还原成加粗）
 */
function unitCellText(cell) {
  return String(cell ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*\*\s*([^*]+?)\s*\*\*/g, '$1')
    .replace(/\s*\|\s*$/, '')
    .trim();
}

/** 「第7课次」「7.」「7」→ 课次号 7 */
function unitLessonNoFromCell(text) {
  const hit = String(text ?? '').match(/第?\s*(\d{1,2})\s*课?/);
  const no = hit ? Number(hit[1]) : 0;
  return no >= 1 && no <= 18 ? no : 0;
}

/**
 * 解析单课时的 Markdown 表格（lessons 阶段）。
 *
 * 为什么不用 JSON：一行表格被截断最多丢半行内容，前面 17 个课次照常用；
 * JSON 被截断则是整份作废。| 拆分即可，容错天然。
 *
 * 返回 { lessons: [{ no, objectives, content, method }], dimension }
 */
function parseUnitLessonText(text, options = {}) {
  const raw = String(text || '');
  /* ① 维度先用【原文】取：老客户端/老模型仍可能回 ===DIMENSION=== 段，取到就用，
        取不到就回落到系统排定的维度（options.dimension）—— 维度永远由系统兜底。 */
  const map = splitUnitTextSections(raw);
  const dimension = String(map.DIMENSION || '').trim().split('\n')[0].trim()
    || String(options.dimension || '').trim();
  /* ② 表格解析前把维度残渣洗掉：模型照抄 prompt 里的 ===DIMENSION=== 时，
        那一段会把正文切走，导致课时行解析不出来。 */
  const cleaned = unitStripLessonDimensionNoise(raw);
  const lessons = [];
  // ① 【首选】专用 Markdown 表格行解析：只按 \n 切行、按 | 切列，不找 ===、不碰 JSON。
  //    AI 返回的就是标准表格（| 第2课次 | **【学习目标】**… | … | … |），
  //    以前那套"先认表头、再取数据行"的逻辑遇到无表头单行 / 列数不齐 / 末格偏短会整行丢弃。
  unitParseLessonMarkdownRows(cleaned, options).forEach(lesson => {
    if (!unitHasContent(lesson.objectives, lesson.content, lesson.method)) return;
    lesson.dimension = dimension;
    lessons.push(lesson);
  });
  // ② 兼容老格式：===LESSON=== 段里的多行表格 / 一次返回多个课次
  if (!lessons.length) {
    unitLessonsFromRows(unitParseMarkdownRows(map.LESSON || ''), options, lessons);
    if (!lessons.length) {
      unitLessonsFromRows(unitParseMarkdownRows(unitStripCodeFence(cleaned)), options, lessons);
    }
  }
  // ③ 极度容错：正则彻底崩溃也绝不留空白 —— 只要 AI 写了字，整段原文塞进这一课的文本框
  if (!lessons.length && raw.trim()) {
    const display = unitFallbackLessonText(raw);
    if (display) {
      console.warn(`[大单元] ⚠️ 课时表格解析失败，已把 AI 原始返回整段放进第 ${options.no || '?'} 课的文本框（请手工整理）`);
      lessons.push({
        no: Number(options.no) || 1, dimension,
        objectives: display, content: '', method: '', rawFallback: true,
      });
    }
  }
  return { lessons, dimension };
}

/**
 * 单元格清洗：<br> → 换行、**加粗** → 纯文本，全角竖线统一成半角。
 */
function unitCleanLessonCell(cell) {
  return String(cell ?? '')
    .replace(/｜/g, '|')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?br>/gi, '\n')
    .replace(/\*\*\s*([^*]+?)\s*\*\*/g, '$1')
    .replace(/\*\*/g, '')
    .trim();
}

/**
 * 专用的单课时 Markdown 表格行解析。
 * 按 \n 切行 → 找「| 第X课次 … |」或「| X | … |」的行 → 按 | 切成 目标 / 内容 / 策略。
 * 不依赖表头、不依赖 === 分隔符、不解析 JSON；列数不足也不丢，能拿几格拿几格。
 */
function unitParseLessonMarkdownRows(text, options = {}) {
  const fallbackNo = Number(options.no) || 0;
  const lines = unitStripCodeFence(String(text || '')).split(/\r?\n/);
  const candidates = [];
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.includes('|') && !trimmed.includes('｜'))) return;
    if (/^[|｜\s:\-]+$/.test(trimmed)) return;                                   // |---|---| 分隔行
    const noHit = trimmed.match(/第\s*(\d{1,2})\s*课次?/)
      || trimmed.match(/^[|｜]\s*(\d{1,2})\s*[|｜]/);
    /* ⚠️ 表头只能按「第一格是纯栏目名 + 没有具体课次号 + 没有实质内容」来认。
       AI 的真实数据行 `| 第2课次 | **【学习目标】**… | … | … |` 同时含「课次」和
       「学习目标」，旧判断 /课次/ && /学习目标/ 会把它当表头丢掉 —— 那正是
       18 个课时全部解析失败、界面只剩空白的根因。带课次号的行一律是数据行，绝不跳过。 */
    if (!noHit && /^\s*[|｜]?\s*(课次|序号|课时)\s*[|｜]/i.test(trimmed)
      && !/<br|【|】|\*\*|：/i.test(trimmed)) return;                            // 表头
    const no = noHit ? Number(noHit[1]) : fallbackNo;
    if (!no || no < 1 || no > 18) return;
    const cells = trimmed
      .replace(/｜/g, '|')
      .replace(/^\s*\|/, '').replace(/\|\s*$/, '')
      .split('|').map(unitCleanLessonCell);
    while (cells.length && !cells[0]) cells.shift();
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    // 第一格是课次号（「第2课次」/「2」）→ 去掉，剩下的依次是三格内容
    if (cells.length && /^第?\s*\d{1,2}\s*课?次?$/.test(cells[0])) cells.shift();
    const filled = cells.filter(Boolean);
    if (!filled.length) return;
    candidates.push({ no, cells, score: filled.join('').length });
  });
  if (!candidates.length) return [];
  // 每个课次只留内容最全的那行；指定了本课次号时，只认这一课（防止把范文里的课次写成别的课）
  const byNo = new Map();
  candidates.forEach(candidate => {
    const previous = byNo.get(candidate.no);
    if (!previous || previous.score < candidate.score) byNo.set(candidate.no, candidate);
  });
  let picked = [...byNo.values()];
  if (fallbackNo && picked.some(candidate => candidate.no === fallbackNo)) {
    picked = picked.filter(candidate => candidate.no === fallbackNo);
  }
  return picked.sort((a, b) => a.no - b.no).map(best => {
    // 正文里若出现额外的竖线（如「比规则|比动作」），多出来的列并回第三格，一个字都不丢
    const [objectives = '', content = '', ...rest] = best.cells;
    return { no: best.no, objectives, content, method: rest.join(' | ').trim() };
  });
}

/**
 * 解析全崩时的原文兜底：抽出整个 Markdown 表格字符串，清掉代码块围栏 / 加粗 / <br>，
 * 交给调用方塞进该课时的 textarea —— 只要 AI 写了字，老师就必须看得到。
 */
function unitFallbackLessonText(text) {
  const lines = unitStripCodeFence(String(text || ''))
    .replace(/===DIMENSION===[^\n]*/gi, '')
    .split(/\r?\n/)
    .map(line => unitCleanLessonCell(line))
    .filter(Boolean);
  const tableLines = lines.filter(line => line.includes('|') && !/^[|\s:\-]+$/.test(line));
  const picked = tableLines.length ? tableLines : lines;
  return picked.join('\n').trim();
}

/**
 * 清掉课时文本里的维度残渣（模型偶尔会照抄 prompt 里的 ===DIMENSION===）。
 * 只删标记与英文维度键，表格行一个字符都不动。
 */
function unitStripLessonDimensionNoise(text) {
  const raw = String(text || '');
  if (!raw) return '';
  return raw
    .replace(/===DIMENSION===[^\n]*(\n[^\n=]*)?/gi, '')
    .replace(/^\s*(basic|technique|tactic|fitness|match|rule|watch)\s*$/gim, '')
    .replace(/[（(]\s*(basic|technique|tactic|fitness|match|rule|watch)\s*[)）]/gi, '')
    .trim();
}

/**
 * 从 Markdown 表格里取课时行。
 *
 * ⚠️ 容错要点：
 *   · 表头靠"含课次"认（AI 的表头可能是「课次 | 学习目标 | 主要学习内容 | 教学策略与学练活动」）；
 *   · 认不到表头时，第一行按表头处理、其余按数据行处理；
 *   · 列数 > 4 取前 4 列；列数 < 4 → 判定为被截断，整行丢弃（上层会重试这一课）。
 */
function unitLessonsFromRows(rows, options, out) {
  if (!Array.isArray(rows) || !rows.length) return out;
  // 表头要【精确】认：只有单元格本身是"课次"才算表头。
  // （写成 /课次/ 会把数据行"第7课次"误判成表头 —— 单课时的纯文本行就是这么写的。）
  const headerIndex = rows.findIndex(row => row.some(cell => /^\s*课次(号)?\s*$/.test(cell)));
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows.slice(1);
  const candidates = dataRows.length ? dataRows : rows;
  candidates.forEach(row => {
    const cells = row.map(cell => unitCellText(cell));
    if (cells.length < 4) return;                      // 列数不足＝被截断，整行丢弃
    const no = unitLessonNoFromCell(cells[0]) || Number(options.no) || 0;
    if (!no) return;
    const lesson = { no, objectives: cells[1] || '', content: cells[2] || '', method: cells[3] || '' };
    if (!lesson.objectives && !lesson.content && !lesson.method) return;
    // ⚠️ 单行纯文本格式（"第7课次 | 目标 | 内容 | 策略"）被截断时，列数不会变少 ——
    //    截断总是砍在末尾，所以用"末格明显偏短"来判断：前两格正常、末格却很短 = 被砍了。
    //    判定为残缺就整行丢弃，上层会重试这一课（而不是把半截内容存进去）。
    if (lesson.method.length > 0 && lesson.method.length < 40 && lesson.objectives.length > 40) return;
    out.push(lesson);
  });
  return out;
}

/**
 * 解析纯文本版的单元学习评价表（模块 10）。
 * 等级区间 / 素养占比 / 得分点合计这些硬约束，由 normalizeUnitRubric 按课标模板兜底补齐。
 */
function parseUnitRubricText(text) {
  const map = splitUnitTextSections(text);
  return {
    rubric: {
      levels: unitRubricLevelsFromText(map.RUBRIC || ''),
      literacyWeights: unitRubricWeightsFromText(map.WEIGHTS || ''),
      scoreItems: unitRubricScoresFromText(map.SCORES || ''),
      note: String(map.NOTE || '').trim(),
    },
  };
}

/**
 * 【单元学习评价表】的课标标准模板 —— 省级教研教案通用的评价量规：
 *   ① 四个等级：优秀 85-100 / 良好 75-84 / 合格 60-74 / 不合格 60以下
 *   ② 核心素养占比：运动能力 60% / 健康行为 20% / 体育品德 20%
 *   ③ 细分得分点：合计 100 分
 * AI 可以改写"评价要点"的措辞（结合本单元项目），但等级、占比、分值必须守住标准。
 */
const UNIT_RUBRIC_TEMPLATE = {
  levels: [
    {
      name: '优秀', range: '85-100',
      ability: '动作规范熟练，能理解并灵活运用技战术，体能与《国家学生体质健康标准》达到优秀水平',
      health: '主动参与锻炼并形成规律，热身与放松习惯良好，能说明并运用运动健康知识',
      character: '自觉遵守规则、公平竞争，能合作帮助同伴，具有克服困难的意志品质',
    },
    {
      name: '良好', range: '75-84',
      ability: '动作较规范，能在比赛中基本运用所技战术，体能达到良好水平',
      health: '能坚持锻炼，基本掌握热身放松方法，能说出主要安全注意事项',
      character: '能遵守规则，能正确面对比赛结果，能与同伴合作',
    },
    {
      name: '合格', range: '60-74',
      ability: '基本动作要领掌握，能完成主要练习任务，体能达到合格水平',
      health: '在提醒下能参与锻炼与热身放松，能说出常见安全注意事项',
      character: '在监督下能遵守规则，能参与比赛与展示活动',
    },
    {
      name: '不合格', range: '60以下',
      ability: '基本动作不熟练，练习任务完成困难，体能不能达到合格水平',
      health: '不愿参与锻炼，不了解热身放松与安全常识',
      character: '不能遵守规则，比赛中出现明显争执行为',
    },
  ],
  literacyWeights: [
    { name: '运动能力', percent: 60 },
    { name: '健康行为', percent: 20 },
    { name: '体育品德', percent: 20 },
  ],
  scoreItems: [
    { name: '运动知识', literacy: '运动能力', points: 12, desc: '项目规则、裁判方法、技战术原理与运动健康知识的掌握' },
    { name: '运动技能', literacy: '运动能力', points: 36, desc: '基本技术动作的规范与熟练、技战术运用能力、比赛表现' },
    { name: '专项体能', literacy: '运动能力', points: 6, desc: '速度、力量、耐力、柔韧、灵敏等体能水平（对照《国家学生体质健康标准》）' },
    { name: '学习参与', literacy: '运动能力', points: 6, desc: '练习投入度、任务完成质量与进步幅度' },
    { name: '健康知识', literacy: '健康行为', points: 6, desc: '运动健康知识的理解与运用（伤病预防、营养与作息）' },
    { name: '运动习惯', literacy: '健康行为', points: 8, desc: '课外锻炼与运动习惯的养成，热身放松的执行情况' },
    { name: '心理健康', literacy: '健康行为', points: 6, desc: '情绪调节、挫折应对与自我认知' },
    { name: '体育精神', literacy: '体育品德', points: 8, desc: '超越自我、遵守规则、公平竞争、积极进取' },
    { name: '道德品质', literacy: '体育品德', points: 6, desc: '文明礼貌、团结合作、尊重他人与爱护器材场地' },
    { name: '规则意识', literacy: '体育品德', points: 6, desc: '规则执行、裁判与观赛礼仪、器材的规范使用' },
  ],
  note: '',
};

/** 深拷贝一份标准评价量规（避免多处共享同一个对象） */
function unitRubricTemplate() {
  return JSON.parse(JSON.stringify(UNIT_RUBRIC_TEMPLATE));
}

/** 归一化评价量规：AI 没给或给残了就用标准模板补齐，绝不留空数组 */
function normalizeUnitRubric(value) {
  const base = unitRubricTemplate();
  if (!value || typeof value !== 'object') return base;
  const levels = Array.isArray(value.levels)
    ? value.levels.filter(item => item && typeof item === 'object' && String(item.name || '').trim())
      .map(item => ({
        name: String(item.name || '').trim(),
        range: String(item.range || '').trim(),
        ability: String(item.ability ?? '').trim(),
        health: String(item.health ?? '').trim(),
        character: String(item.character ?? '').trim(),
      }))
    : [];
  const weights = Array.isArray(value.literacyWeights)
    ? value.literacyWeights.filter(item => item && typeof item === 'object' && String(item.name || '').trim())
      .map(item => ({
        name: String(item.name || '').trim(),
        percent: Number(item.percent) || 0,
      }))
    : [];
  const items = Array.isArray(value.scoreItems)
    ? value.scoreItems.filter(item => item && typeof item === 'object' && String(item.name || '').trim())
      .map(item => ({
        name: String(item.name || '').trim(),
        literacy: String(item.literacy || '运动能力').trim(),
        points: Number(item.points) || 0,
        desc: String(item.desc ?? '').trim(),
      }))
    : [];
  // 等级与占比按"名字"合并：AI 改写过的用 AI 的，缺的那几项用课标标准补齐
  const mergedLevels = base.levels.map(level => {
    const hit = levels.find(item => item.name === level.name);
    return hit ? { ...level, ...hit } : level;
  });
  const mergedWeights = base.literacyWeights.map(weight => {
    const hit = weights.find(item => item.name === weight.name);
    return hit ? { ...weight, ...hit } : weight;
  });
  return {
    levels: levels.length ? mergedLevels : base.levels,
    literacyWeights: weights.length ? mergedWeights : base.literacyWeights,
    scoreItems: items.length ? items : base.scoreItems,
    note: typeof value.note === 'string' ? value.note.trim() : base.note,
  };
}

function createEmptyUnit() {
  return {
    meta: {
      unitTitle: '', category: '', categoryId: '', item: '', itemId: '',
      level: '', levelId: '', topic: '', topicPending: false, generatedAt: '',
      // 本选题（细项 + 水平）实际涉及哪些维度 —— 决定结构图显示哪些分支、AI 按哪些维度分配课时
      dimensions: [],
    },
    unitTitle: '',
    objectives: '',
    textbookAnalysis: '',
    studentAnalysis: '',
    teachingContent: '',
    keyDifficulties: { learning: '', content: '', organization: '', method: '' },
    // 结构图（矩阵泳道图）：18 个课次节点 + 1–3 个主要项目
    structure_nodes: [],
    main_projects: [],
    lessons: Array.from({ length: UNIT_LESSON_COUNT }, (_, index) => ({
      no: index + 1,
      // dimension：本课次属于七大维度中的哪一个（basic/technique/tactic/fitness/match/rule/watch），
      // 由 AI 按「细项 + 水平的教学内容清单」填写，用于校验 18 课时是否真的覆盖了各个维度
      dimension: '',
      // 学习目标（三维段落）：一段文本里依次写 运动能力 / 健康行为 / 体育品德
      objectives: '',
      // 主要学习内容（结构化）：热身小游戏 / 技术学练 / 展示与比赛 / 体能练习
      content: '',
      // 教学策略与学练活动：情境导入 / 教与学的方法 / 比赛活动 / 教学评价
      method: '',
    })),
    assessment: '',
    reflection: '',
    // 单元学习评价表（四等级量规 + 素养占比 + 细分得分点）
    rubric: unitRubricTemplate(),
    // 旧版"教学资源"模块的遗留字段（保留历史数据，不再作为模块展示）
    resources: '',
  };
}

/**
 * 兜底补齐：保证 lessons 恰好 18 条、structure_nodes 是规范数组、main_projects 最多 3 个、
 * objectives 是段落文本。
 * 旧版「七大维度分支」结构会自动迁移成新的矩阵节点（structure_nodes 为空时才迁移）。
 */
function normalizeUnit(data) {
  const base = createEmptyUnit();
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const lessons = Array.isArray(source.lessons) ? source.lessons : [];
  const rawNodes = Array.isArray(source.structure_nodes) ? source.structure_nodes : [];
  const structureNodes = normalizeStructureNodes(
    rawNodes.length ? rawNodes : legacyStructureToNodes(source.structure),
  );
  const dimensions = Array.isArray(source.meta?.dimensions)
    ? source.meta.dimensions.map(entry => String(entry || '')).filter(Boolean)
    : (Array.isArray(source.dimensions) ? source.dimensions.map(entry => String(entry || '')).filter(Boolean) : []);
  const result = {
    ...base,
    ...source,
    unitTitle: typeof source.unitTitle === 'string'
      ? source.unitTitle : (typeof source.meta?.unitTitle === 'string' ? source.meta.unitTitle : ''),
    meta: { ...base.meta, ...(source.meta || {}), dimensions },
    // 学习目标：旧的拆分版 { ability, health, character } 自动并成一段文本
    objectives: unitObjectivesToText(source.objectives),
    keyDifficulties: { ...base.keyDifficulties, ...(source.keyDifficulties || {}) },
    rubric: normalizeUnitRubric(source.rubric),
    structure_nodes: structureNodes,
    main_projects: normalizeMainProjects(source.main_projects),
    lessons: base.lessons.map((lesson, index) => {
      const item = lessons[index] || {};
      return {
        no: index + 1,
        dimension: typeof item.dimension === 'string' ? item.dimension.trim() : '',
        // 课时的三维目标同样从拆分版并成段落文本
        objectives: unitObjectivesToText(item.objectives),
        content: typeof item.content === 'string' ? item.content : '',
        method: typeof item.method === 'string' ? item.method : '',
      };
    }),
  };
  delete result.structure;   // 旧分支结构已迁移成 structure_nodes，不再保留
  // 老数据里的「学习评价」模块已删除：整个字段直接丢掉（不渲染、不覆盖任何内容）
  delete result.evaluation;
  return result;
}

function unitHasContent(...values) {
  return values.some(value => String(value ?? '').trim());
}

/** 某个模块是否已有内容（结果页 / 资源库详情页的状态标记都用它） */
function unitModuleCompleted(unit, id) {
  const data = normalizeUnit(unit);
  switch (id) {
    case 'objectives': return unitHasContent(data.objectives);
    case 'keyDifficulties': return unitHasContent(data.keyDifficulties.learning, data.keyDifficulties.content,
      data.keyDifficulties.organization, data.keyDifficulties.method);
    case 'structure': return data.structure_nodes.length > 0;
    case 'lessons': return data.lessons.some(lesson => unitHasContent(lesson.content, lesson.method, lesson.objectives));
    case 'rubric': return data.rubric.levels.length > 0 && data.rubric.scoreItems.length > 0;
    default: return unitHasContent(data[id]);
  }
}

function structureNodeCount(unit) {
  return normalizeUnit(unit).structure_nodes.length;
}

/** 结构图里缺了哪些课次（1–18 没被挂载的） */
function missingStructureNumbers(unit) {
  const data = normalizeUnit(unit);
  const seen = new Set(data.structure_nodes.map(node => node.id));
  const missing = [];
  for (let no = 1; no <= UNIT_LESSON_COUNT; no += 1) if (!seen.has(no)) missing.push(no);
  return missing;
}

/**
 * 结构图缺课时时按序号兜底补齐（标题取自课时表）。
 * 纯函数：返回新对象，不改动传入的 unit。
 * 归属泳道：优先用该课时自己标注的 dimension（七大维度键会映射到四条泳道）；
 *          没标注时退回序号规则 —— 1–2 基础知识，3–9 基本技术，10–15 技战术运用，16–18 展示或比赛。
 */
function autoFillStructure(unit) {
  const data = normalizeUnit(unit);
  const missing = missingStructureNumbers(data);
  if (!missing.length) return data;
  const nodes = [...data.structure_nodes];
  missing.forEach(no => {
    const lesson = data.lessons[no - 1];
    const title = String(lesson?.content || '').split(/[\n，,。;；]/)[0].slice(0, 18) || '待补充';
    const dimension = unitMatrixDimensionLabel(lesson?.dimension) || unitMatrixFallbackDimension(no);
    nodes.push({ id: no, dimension, title });
  });
  return { ...data, structure_nodes: normalizeStructureNodes(nodes) };
}

/**
 * 结构图矩阵的骨架 HTML（前端结构图 / 导出 / 资源库预览共用一份，保证三处长得一样）。
 *
 * 形态：4 条维度泳道（行）× 18 个课次（列）+ 底部并一行的「主要项目」。
 * @param {object} unit
 * @param {{editable?:boolean}} options editable=true 时节点标题与维度可编辑（前端用）
 */
function buildUnitStructureMatrixHTML(unit, options = {}) {
  const editable = options.editable === true;
  const data = normalizeUnit(unit);
  const cellMap = new Map();
  data.structure_nodes.forEach((node, index) => {
    const rowId = unitMatrixDimensionId(node.dimension);
    if (!rowId) return;
    const key = `${rowId}:${node.id}`;
    if (cellMap.has(key)) return;
    cellMap.set(key, { node, index });
  });

  const colHeads = Array.from({ length: UNIT_LESSON_COUNT }, (_, index) =>
    `<th class="ud2-mx-colhead" scope="col">${index + 1}</th>`).join('');

  const rows = UNIT_MATRIX_DIMENSIONS.map((dimension, rowIndex) => {
    const cells = Array.from({ length: UNIT_LESSON_COUNT }, (_, index) => {
      const id = index + 1;
      const hit = cellMap.get(`${dimension.id}:${id}`);
      if (!hit) return '<td class="ud2-mx-cell"></td>';
      const node = hit.node;
      const title = editable
        ? `<textarea class="ud2-mx-node-title" data-unit-path="structure_nodes.${hit.index}.title"
             rows="2" aria-label="第 ${node.id} 课次名称">${escapeUnitHTML(node.title)}</textarea>`
        : `<span class="ud2-mx-node-title">${escapeUnitHTML(node.title)}</span>`;
      const dimensionPicker = editable
        ? `<select class="ud2-mx-node-dim" data-unit-path="structure_nodes.${hit.index}.dimension"
             aria-label="第 ${node.id} 课次所属维度">${UNIT_MATRIX_DIMENSIONS.map(option =>
               `<option value="${option.label}"${option.label === node.dimension ? ' selected' : ''}>${option.label}</option>`).join('')}</select>`
        : '';
      return `<td class="ud2-mx-cell"><div class="ud2-mx-node" data-no="${node.id}" data-row="${dimension.id}">
        <span class="ud2-mx-node-no">${node.id}</span>${title}${dimensionPicker}</div></td>`;
    }).join('');
    return `<tr class="ud2-mx-row is-${rowIndex % 2 ? 'even' : 'odd'}">
      <th class="ud2-mx-rowhead" scope="row">${dimension.label}</th>${cells}</tr>`;
  }).join('');

  const projects = data.main_projects;
  const mainInner = editable
    ? `<div class="ud2-mx-main-items">${Array.from({ length: 3 }, (_, index) =>
        `<input class="ud2-mx-main-input" data-unit-path="main_projects.${index}"
           value="${escapeUnitHTML(projects[index] || '')}"
           placeholder="${index === 0 ? '填写 1–3 个主要项目' : ''}" aria-label="主要项目 ${index + 1}">`).join('')}</div>`
    : (projects.length
      ? `<span class="ud2-mx-main-text">${projects.map(project => escapeUnitHTML(project)).join(' · ')}</span>`
      : '<span class="ud2-mx-main-text is-empty">—</span>');

  return `<table class="ud2-mx-table">
    <thead><tr><th class="ud2-mx-corner" scope="col">维度 \\ 课次</th>${colHeads}</tr></thead>
    <tbody>${rows}
      <tr class="ud2-mx-row ud2-mx-row-main">
        <th class="ud2-mx-rowhead" scope="row">主要项目</th>
        <td class="ud2-mx-main" colspan="${UNIT_LESSON_COUNT}">${mainInner}</td>
      </tr>
    </tbody>
  </table>`;
}

/**
 * 【单元学习评价表】的 HTML（前端模块 10、导出件、离线资源库预览共用一份）。
 * 形态：① 核心素养占比条 ② 四等级评价量规表 ③ 细分得分点表（合计 100 分）。
 */
function buildUnitRubricHTML(unit) {
  const data = normalizeUnit(unit);
  const rubric = data.rubric;
  const weightOf = name => rubric.literacyWeights.find(item => item.name === name)?.percent ?? '';
  const literacies = rubric.literacyWeights.length
    ? rubric.literacyWeights
    : [{ name: '运动能力', percent: 60 }, { name: '健康行为', percent: 20 }, { name: '体育品德', percent: 20 }];
  const keyOf = literacy => (literacy === '健康行为' ? 'health' : (literacy === '体育品德' ? 'character' : 'ability'));

  const weightChips = literacies.map(item =>
    `<span class="ud2-rubric-chip"><b>${escapeUnitHTML(item.name)}</b>${item.percent}%</span>`).join('');

  const levelHead = literacies.map(item =>
    `<th scope="col">${escapeUnitHTML(item.name)}<span class="ud2-rubric-sub">${item.percent}分</span></th>`).join('');
  const levelRows = rubric.levels.map(level => `<tr>
    <th scope="row" class="ud2-rubric-level">${escapeUnitHTML(level.name)}</th>
    <td class="ud2-rubric-range">${escapeUnitHTML(level.range)}</td>
    ${literacies.map(item => `<td>${escapeUnitHTML(level[keyOf(item.name)] || '')}</td>`).join('')}
  </tr>`).join('');

  const itemRows = rubric.scoreItems.map(item => `<tr>
    <td class="ud2-rubric-lit">${escapeUnitHTML(item.literacy)}</td>
    <td>${escapeUnitHTML(item.name)}</td>
    <td class="ud2-rubric-points">${item.points}</td>
    <td>${escapeUnitHTML(item.desc)}</td>
  </tr>`).join('');
  const totalPoints = rubric.scoreItems.reduce((sum, item) => sum + (Number(item.points) || 0), 0);

  return `<div class="ud2-rubric">
    <div class="ud2-rubric-weights"><span class="ud2-rubric-weights-label">核心素养占比</span>${weightChips}</div>
    <table class="ud2-rubric-table">
      <thead><tr><th scope="col">等级</th><th scope="col">分值区间</th>${levelHead}</tr></thead>
      <tbody>${levelRows}</tbody>
    </table>
    <table class="ud2-rubric-table ud2-rubric-items">
      <thead><tr><th scope="col">核心素养</th><th scope="col">得分点</th><th scope="col">分值</th><th scope="col">评价要点</th></tr></thead>
      <tbody>${itemRows}
        <tr class="ud2-rubric-total"><td colspan="2">合计</td><td class="ud2-rubric-points">${totalPoints}</td><td></td></tr>
      </tbody>
    </table>
  </div>`;
}

/** 18 个课时各自落在哪个维度上（用于校验"是否真的覆盖了各个维度"），返回 维度 → 课次号数组 */
function unitDimensionCoverage(unit) {  const data = normalizeUnit(unit);
  const coverage = {};
  data.lessons.forEach(lesson => {
    const dimension = String(lesson.dimension || '').trim() || '未标注';
    (coverage[dimension] = coverage[dimension] || []).push(lesson.no);
  });
  return coverage;
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

/**
 * 课时表单元格 → 导出用 HTML：
 *   · 换行还原成 <br>（HTML 里裸 \n 不换行，多段落会挤成一块）
 *   · 【小标题】加粗（页面上是纯文本，导出时才还原成加粗小标题）
 */
function unitLessonCellHTML(text) {
  return escapeUnitHTML(text ?? '')
    .replace(/\n/g, '<br>')
    .replace(/【([^】]{1,20})】/g, '<b>【$1】</b>');
}

/** 导出 / 打印用的完整 HTML（两个页面共用同一份排版） */
function buildUnitExportHTML(unit) {
  const d = normalizeUnit(unit);
  const lessonRows = d.lessons.map(lesson => `<tr>
    <td>第 ${lesson.no} 课</td>
    <td>${unitLessonCellHTML(lesson.objectives)}</td>
    <td>${unitLessonCellHTML(lesson.content)}</td>
    <td>${unitLessonCellHTML(lesson.method)}</td></tr>`).join('');
  // 结构图：导出成与页面一致的"维度 × 课次"矩阵（教材式排版）
  const structureMatrix = `<div class="ud2-mx-export">${buildUnitStructureMatrixHTML(d)}</div>`;
  const rubric = buildUnitRubricHTML(d);
  const resourcesAppendix = String(d.resources || '').trim()
    ? unitExportSection('附录、教学资源（旧模块保留）', escapeUnitHTML(d.resources))
    : '';

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>${escapeUnitHTML(d.unitTitle || '大单元设计')}</title>
    <style>body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#222;line-height:1.6;margin:28px}
    h1{text-align:center}h2{margin-top:24px;border-bottom:1px solid #bbb;padding-bottom:6px;font-size:16px}
    h3{font-size:14px;margin:12px 0 4px}
    table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #888;padding:6px;vertical-align:top;text-align:left}
    th{background:#eee}section{white-space:pre-wrap;margin-bottom:10px}
    .meta{text-align:center;color:#555;margin-bottom:18px}
    .page-break{page-break-before:always}
    .ud2-mx-export{overflow-x:auto}
    .ud2-mx-table{table-layout:fixed;font-size:9px;border-collapse:collapse;margin-top:6px}
    .ud2-mx-table th,.ud2-mx-table td{border:1px solid #bbb;padding:3px 2px;text-align:center;vertical-align:middle;word-break:break-all}
    .ud2-mx-table .ud2-mx-corner,.ud2-mx-table .ud2-mx-rowhead{background:#f1f5f9;text-align:center;font-weight:700}
    .ud2-mx-table .ud2-mx-colhead{background:#f8fafc;font-weight:600}
    .ud2-mx-row.is-odd{background:#fafafa}.ud2-mx-row.is-even{background:#f2f8f4}
    .ud2-mx-row-main{background:#fdf6ec!important}
    .ud2-mx-node{border:1px solid #444;border-radius:4px;background:#fff;padding:2px;display:block}
    .ud2-mx-node-no{display:block;font-weight:700;color:#334155}
    .ud2-mx-node-title{display:block;font-size:9px;line-height:1.3}
    .ud2-mx-main{text-align:center}
    .ud2-rubric-weights{margin:6px 0;font-size:11px}.ud2-rubric-chip{display:inline-block;border:1px solid #888;border-radius:10px;padding:1px 8px;margin-right:6px}
    .ud2-rubric-table{margin-top:6px}.ud2-rubric-level{white-space:nowrap}.ud2-rubric-range{white-space:nowrap}
    .ud2-rubric-points{text-align:center;white-space:nowrap}.ud2-rubric-lit{white-space:nowrap}
    .ud2-rubric-total{font-weight:700;background:#f4f4f4}
    @media print{body{margin:12mm}table{page-break-inside:auto}tr{page-break-inside:avoid}}</style></head><body>
    <h1>${escapeUnitHTML(d.unitTitle || '大单元设计')}</h1>
    <p class="meta">${escapeUnitHTML(unitSummaryLine(d))}</p>
    ${unitExportSection('一、教学目标', escapeUnitHTML(d.objectives))}
    ${unitExportSection('二、教材分析', escapeUnitHTML(d.textbookAnalysis))}
    ${unitExportSection('三、学情分析', escapeUnitHTML(d.studentAnalysis))}
    ${unitExportSection('四、主要教学内容', escapeUnitHTML(d.teachingContent))}
    ${unitExportSection('五、教学重难点', `<b>学生学习的重难点：</b>${escapeUnitHTML(d.keyDifficulties.learning)}<br><b>学习内容的重难点：</b>${escapeUnitHTML(d.keyDifficulties.content)}<br><b>教学组织的重难点：</b>${escapeUnitHTML(d.keyDifficulties.organization)}<br><b>教学方法的重难点：</b>${escapeUnitHTML(d.keyDifficulties.method)}`)}
    ${unitExportSection('六、大单元设计结构图', structureMatrix)}
    ${'<h2 class="page-break">七、18 课时计划表</h2><table><thead><tr><th>课次</th><th>学习目标（三维段落）</th><th>主要学习内容（结构化）</th><th>教学策略 / 学练活动</th></tr></thead><tbody>' + lessonRows + '</tbody></table>'}
    ${unitExportSection('八、考核与作业', escapeUnitHTML(d.assessment))}
    ${unitExportSection('九、教学反思', escapeUnitHTML(d.reflection))}
    ${unitExportSection('十、单元学习评价表', rubric)}
    ${resourcesAppendix}
    </body></html>`;
}

/* ---------------- 入库前的「极限裁剪」（/api/data 502 防线） ---------------- */

/** 单个字段上限：超过就是模型跑飞了，截掉反而更安全 */
const UNIT_STORAGE_FIELD_LIMIT = 4000;
/** 单课时三格上限：真实 AI 单课约 700 字，2000 足够，兜底长文也不会撑爆网关 */
const UNIT_STORAGE_LESSON_LIMIT = 2000;
/** 前端主动拦截阈值：4MB（Vercel 平台自身还有约 4.5MB 硬限制，留足余量） */
const UNIT_RESOURCE_PAYLOAD_LIMIT = 4 * 1024 * 1024;

/**
 * 算一份 JSON 的真实 UTF-8 字节数。
 * 浏览器优先用 Blob.size（精确）；Node / 测试替身（Blob 没有 size）走纯 JS 手算。
 */
function unitPayloadBytes(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (typeof Blob !== 'undefined') {
    try {
      const size = new Blob([text]).size;
      if (typeof size === 'number' && size > 0) return size;
    } catch (error) { /* 测试替身 / 老环境：回退到手算 */ }
  }
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
}

/**
 * 大单元入库前的深拷贝清洗：只留老师真正需要看的成品文本。
 *
 * 为什么必须裁：
 *   · 保存到离线资源库时推给 pe_offline_resources_v1 的是【整份资源列表】，
 *     每条记录都塞了完整 10 模块 + 18 课时；存得越多 payload 越大，撞上网关上限就是 502。
 *   · 中间状态（id / createdAt / rawFallback / 生成期临时字段）完全不该进云端。
 *   · 结构图节点常被 AI 塞长描述，只保留 id / dimension / title 就够还原了。
 *
 * ⚠️ 坑：normalizeUnit 是按【数组下标】回填 18 课的，所以 lessons 必须保留 18 个槽位
 *    （空课只写 { no }），删掉空课会让后面的课次整体错位。
 * 读回来时 normalizeRecord → normalizeUnit 会自动补齐空字段与模板量规，界面一字不少。
 */
function unitCompactForStorage(unit) {
  const data = normalizeUnit(unit);
  const clip = (value, limit = UNIT_STORAGE_FIELD_LIMIT) => {
    const text = String(value ?? '').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  const hasText = value => String(value ?? '').trim().length > 0;
  const out = {};

  // ① meta：白名单，剔除 id / createdAt / updatedAt 等一切中间状态
  const meta = {};
  ['unitTitle', 'category', 'categoryId', 'item', 'itemId', 'level', 'levelId', 'topic',
    'generatedAt', 'resourceId', 'source'].forEach(key => {
    const value = clip(data.meta?.[key], key === 'unitTitle' ? 80 : 200);
    if (value) meta[key] = value;
  });
  if (data.meta?.topicPending) meta.topicPending = true;
  if (Array.isArray(data.meta?.dimensions) && data.meta.dimensions.length) {
    meta.dimensions = data.meta.dimensions.slice(0, 12);
  }
  if (Object.keys(meta).length) out.meta = meta;

  // ② 文本模块：空的一律不写（读回来自动补成空串）
  ['unitTitle', 'objectives', 'textbookAnalysis', 'studentAnalysis', 'teachingContent',
    'assessment', 'reflection'].forEach(key => {
    if (!hasText(data[key])) return;
    out[key] = clip(data[key], key === 'unitTitle' ? 80 : UNIT_STORAGE_FIELD_LIMIT);
  });

  // ③ 重难点：只留有内容的分项
  const difficulties = {};
  Object.entries(data.keyDifficulties || {}).forEach(([key, value]) => {
    if (hasText(value)) difficulties[key] = clip(value);
  });
  if (Object.keys(difficulties).length) out.keyDifficulties = difficulties;

  // ④ 结构图：只留定位字段，剔除 AI 塞进来的长描述
  const nodes = (Array.isArray(data.structure_nodes) ? data.structure_nodes : []).map(node => {
    const row = { id: node.id, dimension: String(node.dimension || '').trim() };
    if (hasText(node.title)) row.title = clip(node.title, 40);
    return row;
  });
  if (nodes.length) out.structure_nodes = nodes;
  const projects = (Array.isArray(data.main_projects) ? data.main_projects : [])
    .map(item => clip(item, 40)).filter(Boolean);
  if (projects.length) out.main_projects = projects;

  // ⑤ 18 课：槽位必须齐，只留 no / dimension / 三格文本
  out.lessons = data.lessons.map((lesson, index) => {
    const row = { no: index + 1 };
    if (hasText(lesson.dimension)) row.dimension = String(lesson.dimension).trim();
    if (hasText(lesson.objectives)) row.objectives = clip(lesson.objectives, UNIT_STORAGE_LESSON_LIMIT);
    if (hasText(lesson.content)) row.content = clip(lesson.content, UNIT_STORAGE_LESSON_LIMIT);
    if (hasText(lesson.method)) row.method = clip(lesson.method, UNIT_STORAGE_LESSON_LIMIT);
    return row;
  });

  // ⑥ 量规：完全等于默认模板（= 还没生成）就整个不写，读回来自动补
  const rubric = data.rubric;
  if (rubric && JSON.stringify(rubric) !== JSON.stringify(unitRubricTemplate())) {
    const compact = {};
    compact.levels = (rubric.levels || []).map(level => ({
      name: String(level.name || ''), range: String(level.range || ''),
      ability: clip(level.ability, 600), health: clip(level.health, 600), character: clip(level.character, 600),
    }));
    compact.literacyWeights = (rubric.literacyWeights || []).map(weight => ({
      name: String(weight.name || ''), percent: Number(weight.percent) || 0,
    }));
    compact.scoreItems = (rubric.scoreItems || []).map(item => ({
      name: clip(item.name, 60), literacy: String(item.literacy || ''),
      points: Number(item.points) || 0, desc: clip(item.desc, 600),
    }));
    if (hasText(rubric.note)) compact.note = clip(rubric.note);
    out.rubric = compact;
  }
  return out;
}

if (typeof window !== 'undefined') {
  window.unitPayloadBytes = unitPayloadBytes;
  window.unitCompactForStorage = unitCompactForStorage;
  window.UNIT_RESOURCE_PAYLOAD_LIMIT = UNIT_RESOURCE_PAYLOAD_LIMIT;
  window.UNIT_LESSON_COUNT = UNIT_LESSON_COUNT;
  window.UNIT_MODULES = UNIT_MODULES;
  window.UNIT_MATRIX_DIMENSIONS = UNIT_MATRIX_DIMENSIONS;
  window.UNIT_RUBRIC_TEMPLATE = UNIT_RUBRIC_TEMPLATE;
  window.escapeUnitHTML = escapeUnitHTML;
  window.createEmptyUnit = createEmptyUnit;
  window.normalizeUnit = normalizeUnit;
  window.normalizeStructureNodes = normalizeStructureNodes;
  window.normalizeMainProjects = normalizeMainProjects;
  window.unitObjectivesToText = unitObjectivesToText;
  window.splitUnitTextSections = splitUnitTextSections;
  window.unitStripCodeFence = unitStripCodeFence;
  window.parseUnitAnalysisText = parseUnitAnalysisText;
  window.parseUnitRubricText = parseUnitRubricText;
  window.parseUnitLessonText = parseUnitLessonText;
  window.unitLessonsFromRows = unitLessonsFromRows;
  window.unitRubricTemplate = unitRubricTemplate;
  window.normalizeUnitRubric = normalizeUnitRubric;
  window.unitMatrixDimensionId = unitMatrixDimensionId;
  window.unitMatrixDimensionLabel = unitMatrixDimensionLabel;
  window.unitMatrixFallbackDimension = unitMatrixFallbackDimension;
  window.unitHasContent = unitHasContent;
  window.unitModuleCompleted = unitModuleCompleted;
  window.missingStructureNumbers = missingStructureNumbers;
  window.structureNodeCount = structureNodeCount;
  window.autoFillStructure = autoFillStructure;
  window.buildUnitStructureMatrixHTML = buildUnitStructureMatrixHTML;
  window.buildUnitRubricHTML = buildUnitRubricHTML;
  window.unitDimensionCoverage = unitDimensionCoverage;
  window.unitGetPath = unitGetPath;
  window.unitSetPath = unitSetPath;
  window.unitSummaryLine = unitSummaryLine;
  window.buildUnitExportHTML = buildUnitExportHTML;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    UNIT_LESSON_COUNT, UNIT_MODULES, UNIT_MATRIX_DIMENSIONS, UNIT_RUBRIC_TEMPLATE, escapeUnitHTML,
    createEmptyUnit, normalizeUnit, normalizeStructureNodes, normalizeMainProjects,
    unitObjectivesToText, unitRubricTemplate, normalizeUnitRubric,
    splitUnitTextSections, parseUnitAnalysisText, parseUnitRubricText, parseUnitLessonText,
    unitMatrixDimensionId, unitMatrixDimensionLabel, unitMatrixFallbackDimension,
    unitHasContent, unitModuleCompleted, missingStructureNumbers, structureNodeCount,
    autoFillStructure, buildUnitStructureMatrixHTML, buildUnitRubricHTML, unitDimensionCoverage,
    unitGetPath, unitSetPath, unitSummaryLine, buildUnitExportHTML,
    unitPayloadBytes, unitCompactForStorage, UNIT_RESOURCE_PAYLOAD_LIMIT,
  };
}
