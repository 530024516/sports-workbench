'use strict';

/**
 * 大单元「离线模板」双向转换 —— 离线方案的核心。
 *
 * 老师不想再被 AI 的不确定性折腾时，走这条纯离线路径：
 *   ① 【下载大单元模板】拿到一份 .md（11 个模块标题 + 18 课时表格全部写死）
 *   ② 用本地编辑器填好后【上传】，这里把它解析成系统里的大单元结构
 *   ③ 或者用【全屏工作台】逐模块填写 —— 工作台每个模块用的就是同一份文本格式
 *
 * 为什么「生成」和「解析」必须放在同一个文件里：
 *   老师按 A 模板写、系统按 B 规则解析，就会出现"明明填了却没进去"的玄学问题。
 *   这里让两边共用同一套：模块标题 / 别名 / 字段名 / 表格列定义（见 unitFieldToText 与 applyFieldText）。
 *
 * 依赖（都是全局，加载顺序见 offline-resources.html）：
 *   js/unit-model.js（UNIT_MODULES / createEmptyUnit / normalizeUnit / structureBranchOfDimension）
 *   js/unit-catalog.js（UNIT_CATALOG / UNIT_LEVELS / UNIT_DIMENSIONS，用于把标签反查成 id）
 */

const UNIT_TEMPLATE_VERSION = 'v1';
/** 基本信息段的标识（不属于 11 个模块） */
const UNIT_TEMPLATE_META = '__meta__';

const UNIT_CN_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];

/**
 * 模板里的 11 个模块 —— 顺序与 UNIT_MODULES 一致，aliases 是老师可能自己写的标题。
 * 匹配规则：先精确相等，再看"长别名是否被包含"，同样命中时取别名更长的那个
 * （所以「主要教学内容」会赢过「教学内容」）。
 */
const UNIT_TEMPLATE_MODULES = [
  { id: 'objectives', title: '教学目标', aliases: ['教学目标', '单元教学目标', '单元目标'] },
  { id: 'textbookAnalysis', title: '教材分析', aliases: ['教材分析'] },
  { id: 'studentAnalysis', title: '学情分析', aliases: ['学情分析'] },
  { id: 'teachingContent', title: '主要教学内容', aliases: ['主要教学内容', '教学内容', '本单元主要教学内容'] },
  { id: 'keyDifficulties', title: '教学重难点', aliases: ['教学重难点', '重难点', '教学的重点与难点'] },
  { id: 'structure', title: '大单元设计结构图', aliases: ['大单元设计结构图', '结构图', '大单元结构图', '结构设计'] },
  {
    id: 'lessons',
    title: '18 课时计划表',
    aliases: ['18 课时计划表', '18课时计划表', '18课时表', '课时计划表', '课时计划', '课时表', '18课时', '18 课时'],
  },
  { id: 'assessment', title: '考核与作业', aliases: ['考核与作业', '考核', '作业'] },
  { id: 'evaluation', title: '学习评价', aliases: ['学习评价', '评价'] },
  { id: 'reflection', title: '教学反思', aliases: ['教学反思', '反思', '课后反思'] },
  { id: 'resources', title: '教学资源', aliases: ['教学资源', '资源'] },
];

/** 基本信息字段（不属于 11 模块，所以单独一段） */
const UNIT_META_FIELDS = [
  { label: '单元名称', key: 'unitTitle' },
  { label: '教材大类', key: 'category' },
  { label: '教材细项', key: 'item' },
  { label: '水平', key: 'level' },
  { label: '教学内容', key: 'topic' },
];

/** 七大维度的写法别名（填表时写中文标签或英文键都认） */
const UNIT_DIMENSION_ALIASES = [
  { id: 'basic', names: ['基础知识', '基础知识与技能', '知识', 'basic'] },
  { id: 'technique', names: ['基本技术', '基本技术与技能', '技术', 'technique'] },
  { id: 'tactic', names: ['技战术运用', '战术', 'tactic', 'tactics'] },
  { id: 'fitness', names: ['专项体能', '体能', 'fitness'] },
  { id: 'match', names: ['比赛与展示', '比赛', '展示', 'match'] },
  { id: 'rule', names: ['规则与裁判', '规则', '裁判', 'rule'] },
  { id: 'watch', names: ['观赏与评价', '观赏', 'watch'] },
];

/** 结构图分支的写法别名（分支 id + 维度 id + 中文标签都认） */
const UNIT_BRANCH_ALIASES = (typeof UNIT_STRUCTURE_BRANCHES !== 'undefined' ? UNIT_STRUCTURE_BRANCHES : [])
  .map(branch => ({
    id: branch.id,
    dim: branch.dim,
    names: [branch.label, branch.id, branch.dim, ...(branch.label || '').split('与')].filter(Boolean),
  }));

/** 课时表格的列：表头写什么都列出了别名，解析时按表头内容决定每一列是什么 */
const UNIT_LESSON_COLUMNS = [
  { key: 'no', names: ['课时', '课次', '序号', '第几课', 'no', '#'] },
  { key: 'dimension', names: ['维度', '所属维度', '教学维度', '内容类别', 'dimension'] },
  { key: 'ability', names: ['运动能力', '能力目标', '能力', '技能目标', 'ability'] },
  { key: 'health', names: ['健康行为', '健康目标', '健康', 'health'] },
  { key: 'character', names: ['体育品德', '品德目标', '品德', 'character'] },
  { key: 'target', names: ['学习目标', '三维目标', '课时目标', '目标', '学习目标（三维）'] },
  { key: 'content', names: ['教学内容', '内容', '主要教学内容', '本课内容', 'content'] },
  { key: 'method', names: ['组织教学与方法', '教学组织与方法', '组织教法', '教学方法', '教法', '组织与方法', 'method'] },
];
/** 表格没有表头（或表头被改坏）时，按模板自带的列顺序兜底 */
const UNIT_LESSON_DEFAULT_ORDER = ['no', 'dimension', 'ability', 'health', 'character', 'content', 'method'];

/* ---------------- 小工具 ---------------- */

function unitTemplatePaired(field, fallback = '') {
  return String((typeof UNIT_MODULES !== 'undefined' ? UNIT_MODULES : []).find(entry => entry.id === field)?.title || fallback);
}

/** 模块标题（优先取 unit-model.js 的 UNIT_MODULES，保证两处说法一致） */
function unitModuleTitle(moduleId) {
  if (moduleId === UNIT_TEMPLATE_META) return '基本信息';
  const own = UNIT_TEMPLATE_MODULES.find(entry => entry.id === moduleId);
  if (!own) return moduleId;
  return unitTemplatePaired(moduleId, own.title);
}

/** 模块填写提示（写在模板里当作注释，解析器会忽略） */
function unitModuleHint(moduleId) {
  const hint = (typeof UNIT_MODULES !== 'undefined' ? UNIT_MODULES : []).find(entry => entry.id === moduleId)?.hint;
  return hint || '';
}

/** 例如 index=2 → 「三、学情分析」 */
function unitTemplateHeading(index) {
  const module = UNIT_TEMPLATE_MODULES[index];
  if (!module) return '';
  const numeral = UNIT_CN_NUMERALS[index] || String(index + 1);
  return `${numeral}、${unitModuleTitle(module.id)}`;
}

/** 单元格里的竖线会撑破表格，换行也一并拍平 */
function unitTableCell(value) {
  return String(value ?? '')
    .replace(/\r?\n+/g, '　')
    .replace(/\|/g, '／')
    .trim();
}

function unitDimensionLabelOf(dimensionId) {
  const own = UNIT_DIMENSION_ALIASES.find(entry => entry.id === dimensionId);
  if (own) return own.names[0];
  const shared = (typeof UNIT_DIMENSIONS !== 'undefined' ? UNIT_DIMENSIONS : [])
    .find(entry => entry.id === dimensionId);
  return shared ? shared.label : '';
}

/** 维度写法 → 维度 id（中文标签 / 英文键 / 含糊写法都尽量认） */
function unitDimensionIdOf(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw) return '';
  const exact = UNIT_DIMENSION_ALIASES.find(entry => entry.names.some(name => name.toLowerCase() === raw));
  if (exact) return exact.id;
  const loose = UNIT_DIMENSION_ALIASES.find(entry => entry.names.some(name => raw.includes(name.toLowerCase())));
  return loose ? loose.id : '';
}

function unitBranchIdOf(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw) return '';
  const exact = UNIT_BRANCH_ALIASES.find(entry => entry.names.some(name => name.toLowerCase() === raw));
  if (exact) return exact.id;
  const loose = UNIT_BRANCH_ALIASES.find(entry => entry.names.some(name => raw.includes(name.toLowerCase())));
  return loose ? loose.id : '';
}

/** 剥掉列表符号与序号，得到干净的正文 */
function unitCleanLine(line) {
  return String(line ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*[-*+•]\s*/, '')
    .replace(/^\s*(?:\(?\d{1,2}\)?|[一二三四五六七八九十]{1,3})[、\.．:：]\s*/, '')
    .trim();
}

/** 「- 运动能力：xxx」这类一行一个字段的写法 */
function unitLabeledLine(label, value) {
  return `- ${label}：${String(value ?? '').trim()}`;
}

/**
 * 解析「标签：值」列表。
 * @returns {Map<string, string>} 标签 → 值（没有标签的自由行会进 '' 这个键）
 */
function unitParseLabeledBlock(text) {
  const map = new Map();
  const loose = [];
  String(text ?? '').split('\n').forEach(rawLine => {
    const line = unitCleanLine(rawLine);
    if (!line) return;
    const matched = line.match(/^([^：:]{1,16})\s*[：:]\s*([\s\S]*)$/);
    if (matched) {
      const label = matched[1].trim();
      const value = matched[2].trim();
      if (map.has(label)) map.set(label, `${map.get(label)}\n${value}`);
      else map.set(label, value);
      return;
    }
    loose.push(line);
  });
  if (loose.length) map.set('', loose.join('\n'));
  return map;
}

/** 在一堆候选标签里找值（候选标签顺序即优先级） */
function unitPickLabel(map, candidates) {
  const keys = [...map.keys()];
  for (const candidate of candidates) {
    const exact = keys.find(key => key === candidate);
    if (exact !== undefined && String(map.get(exact) || '').trim()) return map.get(exact).trim();
  }
  for (const candidate of candidates) {
    const loose = keys.find(key => key && (key.includes(candidate) || candidate.includes(key)));
    if (loose !== undefined && String(map.get(loose) || '').trim()) return map.get(loose).trim();
  }
  return '';
}

/** 从一段话里抠出三维（「运动能力：…；健康行为：…；体育品德：…」） */
function unitSplitThreeFields(text, markers) {
  const source = String(text ?? '').replace(/<br\s*\/?>/gi, '\n').trim();
  if (!source) return null;
  const hits = [];
  markers.forEach(({ key, pattern }) => {
    const found = new RegExp(`(?:^|[\\n;；。、,，])[^\\n]{0,4}?(${pattern})\\s*[:：]?\\s*`).exec(source);
    if (found) hits.push({ key, start: found.index, end: found.index + found[0].length, marker: found[1] });
  });
  if (!hits.length) return null;
  hits.sort((a, b) => a.start - b.start);
  const result = {};
  hits.forEach((hit, index) => {
    const stop = index + 1 < hits.length ? hits[index + 1].start : source.length;
    const value = source.slice(hit.end, stop).replace(/^[:：\s]+/, '').replace(/[\s;；，,。]+$/, '').trim();
    if (value) result[hit.key] = value;
  });
  return Object.keys(result).length ? result : null;
}

const UNIT_OBJECTIVE_MARKERS = [
  { key: 'ability', pattern: '运动能力|能力目标|技能目标|能力' },
  { key: 'health', pattern: '健康行为|健康目标|健康' },
  { key: 'character', pattern: '体育品德|品德目标|品德' },
];

/* ---------------- ① 单元 → 文本 / 模板 ---------------- */

/** 某个模块在工作台 / 模板里的文本形态 */
function unitFieldToText(unit, moduleId) {
  const data = normalizeUnit(unit);
  switch (moduleId) {
    case UNIT_TEMPLATE_META:
      return UNIT_META_FIELDS
        .map(field => unitLabeledLine(field.label, field.key === 'unitTitle'
          ? (data.unitTitle || data.meta.unitTitle || '')
          : (data.meta[field.key] || '')))
        .join('\n');
    case 'objectives':
      return [
        unitLabeledLine('运动能力', data.objectives.ability),
        unitLabeledLine('健康行为', data.objectives.health),
        unitLabeledLine('体育品德', data.objectives.character),
      ].join('\n');
    case 'keyDifficulties':
      return [
        unitLabeledLine('学生学习的重难点', data.keyDifficulties.learning),
        unitLabeledLine('学习内容的重难点', data.keyDifficulties.content),
        unitLabeledLine('教学组织的重难点', data.keyDifficulties.organization),
        unitLabeledLine('教学方法的重难点', data.keyDifficulties.method),
      ].join('\n');
    case 'evaluation':
      return [
        unitLabeledLine('过程性评价', data.evaluation.process),
        unitLabeledLine('终结性评价', data.evaluation.summative),
        unitLabeledLine('学练赛评一体化', data.evaluation.integration),
      ].join('\n');
    case 'structure':
      return (typeof UNIT_STRUCTURE_BRANCHES !== 'undefined' ? UNIT_STRUCTURE_BRANCHES : [])
        .map(branch => unitLabeledLine(branch.label,
          (data.structure[branch.id] || []).map(node => node.title).join('；')))
        .join('\n');
    case 'lessons':
      return unitLessonsTableText(data);
    default:
      return String(data[moduleId] ?? '');
  }
}

/** 18 课时表格（表头 + 分隔行 + 18 行） */
function unitLessonsTableText(data) {
  const header = ['课时', '维度', '运动能力', '健康行为', '体育品德', '教学内容', '组织教学与方法'];
  const rows = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  data.lessons.forEach(lesson => {
    const cells = [
      lesson.no,
      unitDimensionLabelOf(lesson.dimension),
      lesson.objectives.ability,
      lesson.objectives.health,
      lesson.objectives.character,
      lesson.content,
      lesson.method,
    ].map(unitTableCell);
    rows.push(`| ${cells.join(' | ')} |`);
  });
  return rows.join('\n');
}

/** 生成可直接下载的模板文本（unit 为空时就是空白模板） */
function buildUnitTemplate(unit, options = {}) {
  const data = normalizeUnit(unit || {});
  const title = data.unitTitle || options.title || '';
  const lines = [
    `# ${title || '大单元填写模板'}`,
    '',
    '> 填写说明（可以直接删掉这一段）',
    '> 1. 只改「冒号后面」和表格里的内容；**标题行不要删**（形如 `## 三、学情分析`），序号也不要改。',
    '> 2. 「七、18 课时计划表」请保留第一行表头，18 行都要填；每行用 `|` 分格，单元格里不要再出现 `|`。',
    '> 3. 维度这一列可以写：基础知识 / 基本技术 / 战术 / 体能 / 比赛 / 规则 / 观赏（写英文键 basic、technique… 也认）。',
    '> 4. 填完存成 `.md` 或 `.txt`，回到「离线资源库 → 上传大单元文件」导入 —— 全程不调用 AI。',
    `> 模板版本：${UNIT_TEMPLATE_VERSION}　·　导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    `## ${unitModuleTitle(UNIT_TEMPLATE_META)}`,
    unitFieldToText(data, UNIT_TEMPLATE_META),
    '',
  ];
  UNIT_TEMPLATE_MODULES.forEach((module, index) => {
    const hint = unitModuleHint(module.id);
    lines.push(`## ${unitTemplateHeading(index)}`);
    if (hint) lines.push(`<!-- 提示：${hint} -->`);
    const body = unitFieldToText(data, module.id);
    lines.push(body);
    lines.push('');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function unitTemplateFileName(unit) {
  const data = normalizeUnit(unit || {});
  const name = data.unitTitle || [data.meta.category, data.meta.item, data.meta.level].filter(Boolean).join(' ')
    || '大单元填写模板';
  return `${String(name).replace(/[\\/:*?"<>|\n\r]/g, '_')}.md`;
}

/* ---------------- ② 文本 → 单元（按模块就地写入） ---------------- */

/**
 * 把某一段文本写进 unit（11 个模块 + 基本信息共用一套规则）。
 * @returns {string[]} 解析过程中的提示
 */
function applyFieldText(target, moduleId, text) {
  const warnings = [];
  const body = String(text ?? '').replace(/^\uFEFF/, '');
  switch (moduleId) {
    case UNIT_TEMPLATE_META: {
      const map = unitParseLabeledBlock(body);
      const values = {};
      UNIT_META_FIELDS.forEach(field => {
        values[field.key] = unitPickLabel(map, [field.label, field.key]);
      });
      if (values.unitTitle) target.unitTitle = values.unitTitle;
      const meta = target.meta || {};
      if (values.category) meta.category = values.category;
      if (values.item) meta.item = values.item;
      if (values.level) meta.level = values.level;
      if (values.topic) meta.topic = values.topic;
      meta.unitTitle = target.unitTitle || meta.unitTitle || '';
      unitSyncMetaIds(meta);
      target.meta = meta;
      break;
    }
    case 'objectives': {
      const map = unitParseLabeledBlock(body);
      const ability = unitPickLabel(map, ['运动能力', '能力', 'ability']);
      const health = unitPickLabel(map, ['健康行为', '健康', 'health']);
      const character = unitPickLabel(map, ['体育品德', '品德', 'character']);
      const loose = map.get('') || '';
      if (ability || health || character) {
        target.objectives = { ability, health, character };
      } else if (loose) {
        const split = unitSplitThreeFields(loose, UNIT_OBJECTIVE_MARKERS);
        target.objectives = split
          ? { ability: split.ability || '', health: split.health || '', character: split.character || '' }
          : { ability: loose, health: '', character: '' };
        warnings.push('【教学目标】没按分项写，整段放进了「运动能力」，其余两项留空，可在工作台里改。');
      }
      break;
    }
    case 'keyDifficulties': {
      const map = unitParseLabeledBlock(body);
      target.keyDifficulties = {
        learning: unitPickLabel(map, ['学生学习的重难点', '学生学习', '学习强调', 'learning']),
        content: unitPickLabel(map, ['学习内容的重难点', '学习内容', 'content']),
        organization: unitPickLabel(map, ['教学组织的重难点', '教学组织', 'organization']),
        method: unitPickLabel(map, ['教学方法的重难点', '教学方法', 'method']),
      };
      if (map.get('')) target.keyDifficulties.learning = `${target.keyDifficulties.learning}\n${map.get('')}`.trim();
      break;
    }
    case 'evaluation': {
      const map = unitParseLabeledBlock(body);
      target.evaluation = {
        process: unitPickLabel(map, ['过程性评价', '过程性', 'process']),
        summative: unitPickLabel(map, ['终结性评价', '终结性', 'summative']),
        integration: unitPickLabel(map, ['学练赛评一体化', '一体化', 'integration']),
      };
      if (map.get('')) target.evaluation.process = `${target.evaluation.process}\n${map.get('')}`.trim();
      break;
    }
    case 'structure': {
      const parsed = unitParseStructureBlock(body);
      target.structure = parsed.structure;
      warnings.push(...parsed.warnings);
      target._looseStructureNodes = parsed.loose;      // 等课时表解析完再按维度归位
      break;
    }
    case 'lessons': {
      const parsed = unitParseLessonTable(body);
      target.lessons = parsed.lessons;
      warnings.push(...parsed.warnings);
      break;
    }
    default: {
      const clean = body
        .split('\n')
        .map(line => String(line).replace(/<!--[\s\S]*?-->/g, ''))
        .join('\n')
        .replace(/^\s*\n+/, '')
        .replace(/\s+$/, '');
      target[moduleId] = clean;
    }
  }
  return warnings;
}

/** 公共包装：不动原对象 */
function unitFieldFromText(unit, moduleId, text) {
  const draft = normalizeUnit(unit);
  const warnings = applyFieldText(draft, moduleId, text);
  const loose = draft._looseStructureNodes;
  delete draft._looseStructureNodes;
  return { unit: draft, warnings, loose };
}

/** 把"大类 / 细项 / 水平"的中文标签反查成 id（能让大单元设计页的下拉回填） */
function unitSyncMetaIds(meta) {
  const catalog = (typeof UNIT_CATALOG !== 'undefined' ? UNIT_CATALOG : []);
  let item = null;
  let category = catalog.find(entry => entry.label === meta.category) || null;
  if (category) {
    item = category.items.find(entry => entry.label === meta.item) || null;
  }
  if (!item && meta.item) {
    // 老师只写了细项没写大类时，遍历所有大类找一遍
    for (const entry of catalog) {
      const hit = entry.items.find(candidate => candidate.label === meta.item);
      if (hit) { category = entry; item = hit; break; }
    }
  }
  const level = (typeof UNIT_LEVELS !== 'undefined' ? UNIT_LEVELS : []).find(entry => entry.label === meta.level);
  if (category) { meta.categoryId = category.id; meta.category = category.label; }
  if (item) { meta.itemId = item.id; meta.item = item.label; }
  if (level) { meta.levelId = level.id; meta.level = level.label; }
  if (meta.topic && typeof isUnitTopicPending === 'function') meta.topicPending = isUnitTopicPending(meta.topic);
  return meta;
}

/* ---------------- 课时表解析 ---------------- */

function unitLessonColumnKey(name) {
  const cleaned = String(name ?? '').replace(/[*_\s`]/g, '').replace(/[（(][^）)]*[）)]/g, '').toLowerCase();
  if (!cleaned) return '';
  for (const column of UNIT_LESSON_COLUMNS) {
    if (column.names.some(alias => alias.toLowerCase() === cleaned)) return column.key;
  }
  for (const column of UNIT_LESSON_COLUMNS) {
    const hit = column.names.find(alias => alias.length >= 2
      && (cleaned.includes(alias.toLowerCase()) || alias.toLowerCase().includes(cleaned)));
    if (hit) return column.key;
  }
  return '';
}

/**
 * 解析 18 课时表格。
 * 能容忍的情况：没有 # 记号、表头行的列顺序被打乱、少了三维中的某一列、
 * 单元格里写「运动能力：…；健康行为：…」、课次号写成「第 3 课次」。
 */
function unitParseLessonTable(body) {
  const warnings = [];
  const lessons = normalizeUnit({}).lessons;
  const lines = String(body ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|'));
  if (!lines.length) {
    return { lessons, warnings: [...warnings, '【18 课时计划表】没有找到表格（每行要以 | 开头）。'], rowCount: 0 };
  }

  const cellsOf = line => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const isSeparator = cells => cells.every(cell => /^:?-{2,}:?$/.test(cell) || cell === '');

  let headerMap = null;
  let sequential = 0;
  let dropped = 0;
  const seen = new Set();

  lines.forEach(line => {
    const cells = cellsOf(line);
    if (isSeparator(cells)) return;
    const keys = cells.map(cell => unitLessonColumnKey(cell));
    const recognized = keys.filter(Boolean).length;
    if (!headerMap && (recognized >= 2 || (recognized === 1 && keys[0] === 'no'))) {
      headerMap = keys;
      return;
    }
    if (headerMap && cells.length > headerMap.length + 2) {
      dropped += 1;
      return;                                  // 明显多出来的列，宁可丢掉也不要串行
    }
    const row = {
      no: 0, dimension: '', ability: '', health: '', character: '', content: '', method: '', target: '',
    };
    cells.forEach((cell, index) => {
      const key = headerMap ? headerMap[index] : UNIT_LESSON_DEFAULT_ORDER[index];
      if (!key) return;
      const text = String(cell ?? '').replace(/<br\s*\/?>/gi, ' ').trim();
      if (!text) return;
      if (key === 'no') {
        const found = text.match(/\d{1,2}/);
        if (found) row.no = Number(found[0]);
        return;
      }
      if (key === 'dimension') { row.dimension = unitDimensionIdOf(text) || row.dimension; return; }
      row[key] = row[key] ? `${row[key]}；${text}` : text;
    });

    // 「目标」列里混着三维时，尽量拆开
    if (row.target) {
      const split = unitSplitThreeFields(row.target, UNIT_OBJECTIVE_MARKERS);
      if (split) {
        row.ability = row.ability || split.ability || '';
        row.health = row.health || split.health || '';
        row.character = row.character || split.character || '';
      } else {
        row.ability = row.ability || row.target;
      }
    }
    // 「教学内容」列里带了对学生能做什么的描述时不动，保持老师原样
    if (row.no >= 1 && row.no <= 18) {
      if (seen.has(row.no)) { dropped += 1; return; }
      seen.add(row.no);
      const target = lessons[row.no - 1];
      target.dimension = row.dimension || target.dimension;
      target.objectives = {
        ability: row.ability || target.objectives.ability || '',
        health: row.health || target.objectives.health || '',
        character: row.character || target.objectives.character || '',
      };
      target.content = row.content || target.content || '';
      target.method = row.method || target.method || '';
      return;
    }
    sequential += 1;
    const slot = lessons.find(lesson => !unitHasContent(lesson.content, lesson.method,
      lesson.objectives.ability, lesson.objectives.health, lesson.objectives.character)
      && !seen.has(lesson.no));
    if (slot) {
      seen.add(slot.no);
      slot.dimension = row.dimension || slot.dimension;
      slot.objectives = {
        ability: row.ability || slot.objectives.ability || '',
        health: row.health || slot.objectives.health || '',
        character: row.character || slot.objectives.character || '',
      };
      slot.content = row.content || slot.content || '';
      slot.method = row.method || slot.method || '';
    } else {
      dropped += 1;
    }
  });

  if (!headerMap) {
    warnings.push('【18 课时计划表】没认出表头，已按模板默认列顺序（课时/维度/三维目标/内容/教法）解析。');
  }
  if (sequential) warnings.push(`【18 课时计划表】有 ${sequential} 行没写课次号，已按顺序依次落位。`);
  if (dropped) warnings.push(`【18 课时计划表】有 ${dropped} 行被丢弃（课次号超出 1–18 或重复）。`);
  return { lessons, warnings, rowCount: seen.size };
}

/* ---------------- 结构图解析 ---------------- */

/**
 * 结构图这一块的写法很自由，这里支持三种：
 *   - 基本技术：第3课次：原地运球；第4课次：行进间运球       （一行一个分支）
 *   - 基本技术：                                             （下面跟着一串 - 第N课次：xxx）
 *   - 第5课次：战术                                          （不写分支，按课时表的维度归位）
 */
function unitParseStructureBlock(body) {
  const warnings = [];
  const structure = normalizeUnit({}).structure;
  const loose = [];
  let current = null;

  String(body ?? '').split('\n').forEach(rawLine => {
    const line = unitCleanLine(rawLine);
    if (!line) return;
    const matched = line.match(/^([^：:]{1,12})\s*[：:]\s*([\s\S]*)$/);
    const branch = matched ? unitBranchIdOf(matched[1]) : '';
    if (branch && !/\d/.test(matched[1])) {
      current = branch;
      if (matched[2].trim()) unitPushNodes(structure[branch], matched[2], warnings);
      return;
    }
    const nodes = unitExtractNodes(line);
    if (nodes.length) {
      nodes.forEach(node => (current ? structure[current].push(node) : loose.push(node)));
      return;
    }
    loose.push({ no: 0, title: line });
  });

  return { structure, loose, warnings };
}

function unitExtractNodes(text) {
  const nodes = [];
  String(text ?? '').split(/[；;]|\s{2,}/).forEach(piece => {
    const cleaned = piece.replace(/^\s*[-*+]\s*/, '').trim();
    if (!cleaned) return;
    const found = cleaned.match(/第\s*(\d{1,2})\s*课(?:次)?/);
    if (!found) return;
    const no = Number(found[1]);
    const title = cleaned.replace(/^\s*[-*+]\s*/, '').trim();
    nodes.push({ no, title });
  });
  return nodes;
}

function unitPushNodes(list, text, warnings) {
  const nodes = unitExtractNodes(text);
  if (!nodes.length && String(text).trim()) {
    warnings.push('结构图里有一行看不出是第几课次，已忽略（请写成「第N课次：xxx」）。');
    return;
  }
  nodes.forEach(node => list.push(node));
}

/* ---------------- ③ 整份文本 → 单元 + 校验报告 ---------------- */

/** 标题识别：# ## ###、**加粗**、或光秃秃一行别名 */
function unitHeadingCandidate(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  if (/^#{1,6}\s*/.test(trimmed)) return { text: trimmed.replace(/^#{1,6}\s*/, ''), strong: true };
  if (/^\*\*[^*]+\*\*:?$/.test(trimmed)) return { text: trimmed.replace(/\*/g, ''), strong: true };
  if (trimmed.length <= 24 && !/^[-|>*-]/.test(trimmed)) return { text: trimmed, strong: false };
  return null;
}

/** 去掉装饰与序号前缀，留下面目 */
function unitHeadingBody(text) {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[（(][^）)]*[）)]\s*$/g, '')
    .replace(/^[（(]?\s*(?:[一二三四五六七八九十]{1,3}|\d{1,2})\s*[、\.．:：)）\-–—\s]+/, '')
    .replace(/[：:；;，,。.\-–—\s]+$/, '')
    .trim();
}

/**
 * 一行文字 → 模块 id（没命中返回 ''）。
 *
 * @param {object} [options]
 *   isolated   上一行是空行吗？"光秃秃一行标题"这种弱候选才允许成立 ——
 *              正文中出现一句恰好等于模块名的短句时，不该被当成标题把内容吃掉。
 *   allowWeak  要不要认弱候选。文档里只要出现过 `##` 这种真·标题，就按严格模式走：
 *              只认带 # / ** 的标题行。通篇一个 # 都没有（纯 .txt）才放宽。
 */
function unitMatchModuleHeading(line, options = {}) {
  const allowWeak = options && 'allowWeak' in options ? Boolean(options.allowWeak) : true;
  const isolated = options && 'isolated' in options ? Boolean(options.isolated) : true;
  const candidate = unitHeadingCandidate(line);
  if (!candidate) return '';
  if (!candidate.strong && (!allowWeak || !isolated)) return '';
  const body = unitHeadingBody(candidate.text);
  if (!body || body.length > 24) return '';
  let best = { id: '', score: 0 };
  const consider = (id, aliases) => {
    aliases.forEach(alias => {
      const target = String(alias).toLowerCase();
      const source = body.toLowerCase();
      if (source === target) { if (100 + target.length > best.score) best = { id, score: 100 + target.length }; return; }
      if (candidate.strong && target.length >= 3 && source.length <= target.length + 6
        && (source.includes(target) || target.includes(source))) {
        if (target.length > best.score) best = { id, score: target.length };
      }
    });
  };
  consider(UNIT_TEMPLATE_META, ['基本信息', '基础信息', '单元信息', '选题信息']);
  UNIT_TEMPLATE_MODULES.forEach(module => consider(module.id, module.aliases));
  return best.id;
}

/** 按标题把整篇切成 11 段（+ 基本信息段） */
function unitSplitSections(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const collect = (allowWeak) => {
    const sections = new Map();
    let current = '';
    let previousBlank = true;
    lines.forEach(line => {
      const moduleId = unitMatchModuleHeading(line, { allowWeak, isolated: previousBlank });
      previousBlank = !String(line).trim();
      if (moduleId) {
        current = moduleId;
        if (!sections.has(current)) sections.set(current, []);
        return;
      }
      if (current) sections.get(current).push(line);
    });
    const result = new Map();
    sections.forEach((chunk, key) => result.set(key, chunk.join('\n').trim()));
    return result;
  };
  // 先用严格规则（只认 ## / ** 标题）切一遍；切不出东西说明是纯文本 .txt，再放宽
  const strict = collect(false);
  if (strict.has(UNIT_TEMPLATE_META) || UNIT_TEMPLATE_MODULES.some(module => strict.has(module.id))) {
    return strict;
  }
  return collect(true);
}

/** 从 JSON 文本里取出大单元（裸 unit 或资源记录两种都能认） */
function unitFromJSONText(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? '').replace(/^\uFEFF/, '').trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const payload = parsed.modules_json || parsed.unit || parsed.data?.modules_json || parsed;
  if (!payload || typeof payload !== 'object') return null;
  const unit = normalizeUnit(payload);
  // 顺手把六列资源记录的三个字段回填进 meta，省得老师导出后再导入就丢了选题
  if (parsed.modules_json && typeof parsed === 'object') {
    const meta = unit.meta || {};
    if (parsed.category && !meta.category) meta.category = parsed.category;
    if (parsed.level && !meta.level) meta.level = parsed.level;
    if (parsed.content && !meta.topic) meta.topic = parsed.content;
    unitSyncMetaIds(meta);
    unit.meta = meta;
  }
  return unit;
}

/**
 * 解析一整份模板文本（或 JSON）。
 * @returns {{
 *   ok:boolean, blocking:boolean, format:string, unit:object, found:string[], missing:string[],
 *   empty:string[], warnings:string[], errors:string[], problems:{level:string,module:string,message:string}[],
 *   lessonRows:number, structureNodes:number
 * }}
 */
function parseUnitTemplate(input, options = {}) {
  const raw = String(input ?? '').replace(/^\uFEFF/, '');
  const report = {
    ok: false, blocking: false, format: 'md', unit: normalizeUnit({}),
    found: [], missing: [], empty: [], warnings: [], errors: [], problems: [],
    lessonRows: 0, structureNodes: 0,
  };

  if (!raw.trim()) {
    report.errors.push('文件内容是空的：请先用【下载大单元模板】拿到模板，填好后再上传。');
    report.blocking = true;
    return report;
  }

  if (/^\s*[{[]/.test(raw.trim())) {
    report.format = 'json';
    const unit = unitFromJSONText(raw);
    if (!unit) {
      report.errors.push('JSON 读不出来：这个文件不是合法的 JSON。请检查是否复制完整，或改用【下载大单元模板】导出的 .md / .txt。');
      report.blocking = true;
      return report;
    }
    report.unit = unit;
    report.found = UNIT_TEMPLATE_MODULES.map(module => module.id)
      .filter(id => unitModuleCompleted(unit, id));
    report.empty = UNIT_TEMPLATE_MODULES.map(module => module.id).filter(id => !report.found.includes(id));
    report.lessonRows = unit.lessons.filter(lesson => unitHasContent(lesson.content, lesson.method,
      lesson.objectives.ability, lesson.objectives.health, lesson.objectives.character)).length;
    unitBuildReport(report, options);
    return report;
  }

  const sections = unitSplitSections(raw);
  const draft = normalizeUnit({});
  let loose = [];

  if (sections.has(UNIT_TEMPLATE_META)) {
    applyFieldText(draft, UNIT_TEMPLATE_META, sections.get(UNIT_TEMPLATE_META));
  }

  UNIT_TEMPLATE_MODULES.forEach(module => {
    if (!sections.has(module.id)) { report.missing.push(module.id); return; }
    const body = sections.get(module.id);
    report.found.push(module.id);
    if (!body) { report.empty.push(module.id); return; }
    const warnings = applyFieldText(draft, module.id, body);
    report.warnings.push(...warnings);
    if (draft._looseStructureNodes) {
      loose = draft._looseStructureNodes;
      delete draft._looseStructureNodes;
    }
  });

  unitAttachLooseNodes(draft, loose, report.warnings);

  const unit = normalizeUnit(draft);
  report.unit = unit;
  report.lessonRows = unit.lessons.filter(lesson => unitHasContent(lesson.content, lesson.method,
    lesson.objectives.ability, lesson.objectives.health, lesson.objectives.character)).length;
  unitBuildReport(report, options);
  return report;
}

/** 结构图里没写分支的节点：按课时表的维度归位 */
function unitAttachLooseNodes(unit, loose, warnings) {
  if (!Array.isArray(loose) || !loose.length) return;
  let placed = 0;
  loose.forEach(node => {
    if (!node.no) return;
    const lesson = unit.lessons[node.no - 1];
    const dimension = lesson ? lesson.dimension : '';
    const branch = (typeof structureBranchOfDimension === 'function'
      ? structureBranchOfDimension(dimension) : '') || (node.no <= 2 ? 'basic'
      : node.no <= 9 ? 'technique' : node.no <= 15 ? 'tactics' : 'fitness');
    if (unit.structure[branch]) { unit.structure[branch].push(node); placed += 1; }
  });
  // 同一分支里按课次号排好，别乱序
  Object.keys(unit.structure).forEach(branch => {
    unit.structure[branch].sort((a, b) => a.no - b.no);
  });
  const skipped = loose.filter(node => !node.no).length;
  if (skipped) {
    warnings.push(`【大单元设计结构图】有 ${skipped} 行没写「第N课次」，无法归位，请改成「第N课次：xxx」。`);
  }
  if (placed) warnings.push(`【大单元设计结构图】有 ${placed} 个节点没写分支，已按课时表的维度自动归位。`);
}

/** 统一的报告收尾：把 found/missing/empty/课时行数翻成人话的问题清单 */
function unitBuildReport(report, options = {}) {
  const total = UNIT_TEMPLATE_MODULES.length;
  report.missing.forEach(id => report.problems.push({
    level: 'error', module: id,
    message: `未找到【${unitModuleTitle(id)}】模块，请检查模板`,
  }));
  report.empty.forEach(id => report.problems.push({
    level: 'warn', module: id,
    message: `【${unitModuleTitle(id)}】找到了但没有内容，导入后可以在工作台里补写`,
  }));
  if (report.found.length === 0) {
    report.errors.push('没有识别到任何模块标题（形如「## 三、学情分析」），请确认用的是本页下载的模板。');
  }
  if (report.lessonRows > 0 && report.lessonRows < 18) {
    const done = new Set(report.unit.lessons
      .filter(lesson => unitHasContent(lesson.content, lesson.method,
        lesson.objectives.ability, lesson.objectives.health, lesson.objectives.character))
      .map(lesson => lesson.no));
    const absent = [];
    for (let no = 1; no <= UNIT_LESSON_COUNT; no += 1) if (!done.has(no)) absent.push(no);
    report.warnings.push(`18 课时计划表只填了 ${report.lessonRows} 行，缺第 ${absent.join('、')} 课次，导入后可以单独补写。`);
    report.problems.push({
      level: 'warn', module: 'lessons',
      message: `18 课时计划表只填了 ${report.lessonRows} 行（缺第 ${absent.join('、')} 课次）`,
    });
  }
  if (typeof missingStructureNumbers === 'function' && typeof structureNodeCount === 'function'
    && structureNodeCount(report.unit) > 0) {
    const missing = missingStructureNumbers(report.unit);
    if (missing.length) {
      report.problems.push({
        level: 'warn', module: 'structure',
        message: `结构图已挂载 ${structureNodeCount(report.unit)} 个课次，还缺第 ${missing.join('、')} 课次`,
      });
    }
  }
  report.structureNodes = typeof structureNodeCount === 'function' ? structureNodeCount(report.unit) : 0;
  if (options.requireAll && report.missing.length) {
    report.errors.push(`缺少 ${report.missing.length}/${total} 个模块，已按严格模式拒绝导入。`);
  }
  report.blocking = report.errors.length > 0;
  report.ok = !report.blocking;
  return report;
}

if (typeof window !== 'undefined') {
  window.UNIT_TEMPLATE_VERSION = UNIT_TEMPLATE_VERSION;
  window.UNIT_TEMPLATE_META = UNIT_TEMPLATE_META;
  window.UNIT_TEMPLATE_MODULES = UNIT_TEMPLATE_MODULES;
  window.UNIT_META_FIELDS = UNIT_META_FIELDS;
  window.buildUnitTemplate = buildUnitTemplate;
  window.unitTemplateFileName = unitTemplateFileName;
  window.unitTemplateHeading = unitTemplateHeading;
  window.unitModuleTitle = unitModuleTitle;
  window.unitFieldToText = unitFieldToText;
  window.unitFieldFromText = unitFieldFromText;
  window.parseUnitTemplate = parseUnitTemplate;
  window.unitSplitSections = unitSplitSections;
  window.unitMatchModuleHeading = unitMatchModuleHeading;
  window.unitFromJSONText = unitFromJSONText;
  window.unitDimensionIdOf = unitDimensionIdOf;
}

if (typeof module !== 'undefined' && module.exports) {
  // 浏览器里这些模型函数都挂在 window 上；用 node 直接 require 本文件时把它们补齐，
  // 好处是回归测试可以 `require('js/unit-template.js')` 直接验证解析规则（不必造假 DOM）。
  if (typeof normalizeUnit !== 'function') {
    const path = require('path');
    const model = require(path.resolve(__dirname, 'unit-model.js'));
    const catalog = require(path.resolve(__dirname, 'unit-catalog.js'));
    const missing = {
      ...model, ...catalog,
      UNIT_STRUCTURE_BRANCHES: model.UNIT_STRUCTURE_BRANCHES,
      UNIT_MODULES: model.UNIT_MODULES,
      UNIT_DIMENSIONS: catalog.UNIT_DIMENSIONS,
      UNIT_CATALOG: catalog.UNIT_CATALOG,
      UNIT_LEVELS: catalog.UNIT_LEVELS,
    };
    Object.keys(missing).forEach(key => {
      if (typeof globalThis[key] === 'undefined') globalThis[key] = missing[key];
    });
  }
  module.exports = {
    UNIT_TEMPLATE_VERSION, UNIT_TEMPLATE_META, UNIT_TEMPLATE_MODULES, UNIT_META_FIELDS,
    UNIT_DIMENSION_ALIASES, UNIT_LESSON_COLUMNS,
    buildUnitTemplate, unitTemplateFileName, unitTemplateHeading, unitModuleTitle,
    unitFieldToText, unitFieldFromText, applyFieldText, parseUnitTemplate,
    unitSplitSections, unitMatchModuleHeading, unitFromJSONText, unitDimensionIdOf,
    unitParseLessonTable, unitParseStructureBlock, unitSyncMetaIds,
  };
}
