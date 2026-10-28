/**
 * 运动会报名模板：扁平化 Excel 生成 + 解析
 *
 * 设计目标（对应班主任的实际填写习惯）：
 *   1. 表头扁平：第 1 行就是字段，无合并单元格，一行 = 「某班 + 某项目 + 某组别」的一条报名记录
 *   2. 项目预填：所有比赛项目按男子组 / 女子组预先列好，老师只在选手列填姓名
 *   3. 内置校验：用 Excel 原生「数据验证」做下拉，用「条件格式」把违规单元格标红
 *   4. 系统可 100% 解析：解析端按固定列读取，不需要猜格式（见 parseFlatRegistrationRows）
 *
 * Excel 生成：不依赖任何第三方库，直接拼 OOXML 并用 ZIP(store) 打包成 .xlsx。
 * 之所以不用 SheetJS：社区版只能写单元格值，写不了数据验证与条件格式。
 */
'use strict';

/* ---------------- 项目库 ---------------- */

// 小学田径运动会常用项目。
// ⚠️ grades 只是「年级限制」配置里的默认建议值，**默认不生效**：
// 只有在报名页「项目管理 → 按年级限制项目」里主动勾选后，导出模板才会按年级过滤。
// 未开启时一律全量输出（14 个内置项目 + 自定义项目），不做任何年级过滤。
const MEET_EVENT_LIBRARY = [
  { name: '50米', type: 'track', relay: false, grades: [1, 2, 3, 4, 5, 6] },
  { name: '100米', type: 'track', relay: false, grades: [3, 4, 5, 6] },
  { name: '200米', type: 'track', relay: false, grades: [4, 5, 6] },
  { name: '400米', type: 'track', relay: false, grades: [4, 5, 6] },
  { name: '800米', type: 'track', relay: false, grades: [5, 6] },
  { name: '立定跳远', type: 'field', relay: false, grades: [1, 2, 3, 4, 5, 6] },
  { name: '跳远', type: 'field', relay: false, grades: [3, 4, 5, 6] },
  { name: '跳高', type: 'field', relay: false, grades: [3, 4, 5, 6] },
  { name: '一分钟跳绳', type: 'field', relay: false, grades: [1, 2, 3, 4, 5, 6] },
  { name: '沙包掷远', type: 'field', relay: false, grades: [1, 2, 3] },
  { name: '垒球掷远', type: 'field', relay: false, grades: [3, 4, 5, 6] },
  { name: '实心球', type: 'field', relay: false, grades: [4, 5, 6] },
  { name: '4×100米接力', type: 'track', relay: true, grades: [3, 4, 5, 6] },
  { name: '50米迎面接力', type: 'track', relay: true, grades: [1, 2, 3, 4, 5, 6] },
];

// 表头（第 1 行，顺序即列序，解析端按此读取，不要随意改名）
const TEMPLATE_HEADER = ['班级', '教练/班主任', '项目', '组别',
  '选手1', '选手2', '选手3', '选手4（仅接力）', '选手5（替补）', '选手6（替补）'];

const GENDER_GROUPS = { male: '男子', female: '女子' };
// 组别列的填写值 → 内部性别
const GROUP_ALIASES = {
  男子: 'male', 男: 'male', 男生: 'male', 男子组: 'male', male: 'male', m: 'male',
  女子: 'female', 女: 'female', 女生: 'female', 女子组: 'female', female: 'female', f: 'female',
};

const MAX_INDIVIDUAL_PER_EVENT = 3;   // 单项：每项每班最多 3 人
const MAX_INDIVIDUAL_PER_STUDENT = 2; // 单项：每班每名学生最多 2 项（接力不计入）
const RELAY_TEAM_SIZE = 4;            // 接力：正式队员 4 人（最少人数）
const RELAY_MAX_TEAM_SIZE = 6;        // 接力：最多 6 人（多出的是替补）
const EXTRA_ROWS = 100;               // 预填行之外额外留出的空白行（校验范围）
// 自定义比赛项目的存储键（服务端映射到 app_settings 表，与单双周设置同表，无需新建表）
const CUSTOM_EVENTS_KEY = 'pe_sports_meet_events_v1';
// 模板导出配置（年级限制开关等），同样存在 app_settings 表
const TEMPLATE_CONFIG_KEY = 'pe_meet_template_config_v1';
const GRADE_OPTIONS = [1, 2, 3, 4, 5, 6];

/* ---------------- 数据来源 ---------------- */

/** 班级选项：从学生库拼出「五年级1班」这样的全称（系统据此识别年级） */
function getTemplateClassOptions() {
  const students = Store.read('pe_students', []) || [];
  if (!Array.isArray(students)) return [];
  const map = new Map();
  students.forEach(student => {
    if (!student || !student.class) return;
    const grade = normalizeGradeText(student.grade);
    const full = grade ? `${grade}${String(student.class).trim()}` : String(student.class).trim();
    if (!map.has(full)) map.set(full, { full, grade: grade || '', gradeNumber: gradeNumber(grade) });
  });
  return [...map.values()].sort((a, b) =>
    (a.gradeNumber - b.gradeNumber) ||
    String(a.full).localeCompare(String(b.full), 'zh-CN', { numeric: true }));
}

function gradeNumber(gradeText) {
  return { 一年级: 1, 二年级: 2, 三年级: 3, 四年级: 4, 五年级: 5, 六年级: 6 }[gradeText] || 99;
}

function normalizeGradeText(value) {
  const text = String(value ?? '').trim();
  if (['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'].includes(text)) return text;
  const numeric = Number(text.match(/[1-6]/)?.[0]);
  if (Number.isInteger(numeric)) return ['', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级'][numeric] || '';
  return '';
}

/** 自定义项目库（报名页「项目管理」维护）：从 Store 读取，云端优先、未连接时读本地镜像 */
function getCustomMeetEvents() {
  const list = Store.read(CUSTOM_EVENTS_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.map(normalizeCustomMeetEvent).filter(event => event.name);
}

/** 规范化一条自定义项目，缺字段一律补默认值，保证脏数据也不会让模板崩掉 */
function normalizeCustomMeetEvent(raw = {}) {
  // 云端/本地镜像可能被写脏（null、字符串、缺字段），一律先兜底再取字段
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = String(source.name ?? '').trim();
  if (!name) return { id: '', name: '', gender: 'both', relay: false, type: 'field', grades: [] };
  const gender = source.gender === 'male' || source.gender === 'female' ? source.gender : 'both';
  const relay = source.relay === true;
  const safeId = String(source.id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return {
    id: safeId || `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    gender,                       // 'both' | 'male' | 'female'
    relay,
    type: relay || templateEventIsTrack(name) ? 'track' : 'field',
    grades: Array.isArray(source.grades) ? source.grades.filter(grade => Number.isInteger(grade)) : [],
    createdAt: String(source.createdAt ?? ''),
  };
}

/** 项目 → 模板里实际要生成的分组行（只设男子组就只出男子行） */
function customEventGenderGroups(event) {
  const gender = String(event?.gender ?? 'both');
  if (gender === 'male') return [GENDER_GROUPS.male];
  if (gender === 'female') return [GENDER_GROUPS.female];
  return [GENDER_GROUPS.male, GENDER_GROUPS.female];
}

function saveCustomMeetEvents(events) {
  const list = (events || []).map(normalizeCustomMeetEvent).filter(event => event.name);
  Store.write(CUSTOM_EVENTS_KEY, list);
  return list;
}

/**
 * 新增自定义项目（重名按大小写不敏感拦截，避免模板里出现同名两行）
 * @returns {{ok:boolean, event?:object, events?:Array, reason?:string}}
 */
function addCustomMeetEvent({ name = '', gender = 'both', relay = false, grades = [] } = {}) {
  const event = normalizeCustomMeetEvent({
    name, gender, relay, grades, createdAt: new Date().toISOString(),
  });
  if (!event.name) return { ok: false, reason: '项目名称不能为空' };
  if (event.name.length > 30) return { ok: false, reason: '项目名称不要超过 30 个字' };
  const exists = getCustomMeetEvents();
  if (exists.some(item => item.name.toLowerCase() === event.name.toLowerCase())) {
    return { ok: false, reason: `项目「${event.name}」已存在` };
  }
  const events = saveCustomMeetEvents([...exists, event]);
  return { ok: true, event, events };
}

function removeCustomMeetEvent(id) {
  return saveCustomMeetEvents(getCustomMeetEvents().filter(event => event.id !== id));
}

/** 该项目是否在「项目管理」里被标记为接力（名字里没有“接力”二字也算） */
function isManagedRelayEvent(name) {
  const target = String(name ?? '').trim().toLowerCase();
  if (!target) return false;
  return getCustomMeetEvents().some(event => event.name.toLowerCase() === target && event.relay === true);
}

/** 项目选项：内置项目库 + 自定义项目 + 本次运动会已经出现过的项目（避免老师自建项目丢失） */
function getTemplateEventOptions(extraEventNames = []) {
  const events = MEET_EVENT_LIBRARY.map(event => ({
    ...event,
    genders: [GENDER_GROUPS.male, GENDER_GROUPS.female],
    custom: false,
  }));
  const known = new Set(events.map(event => String(event.name).toLowerCase()));

  // ① 项目管理里保存的自定义项目：自动合并，调用方无需额外传参
  getCustomMeetEvents().forEach(event => {
    const key = event.name.toLowerCase();
    if (known.has(key)) return; // 与内置项目重名：内置项目已覆盖男女两组
    known.add(key);
    events.push({ ...event, genders: customEventGenderGroups(event), custom: true });
  });

  // ② 本次运动会已出现过的项目名（兼容历史数据）
  (extraEventNames || []).forEach(name => {
    const eventName = String(name ?? '').trim();
    if (!eventName || known.has(eventName.toLowerCase())) return;
    known.add(eventName.toLowerCase());
    events.push({
      name: eventName,
      type: templateEventIsTrack(eventName),
      relay: templateEventIsRelay(eventName),
      grades: [],
      genders: [GENDER_GROUPS.male, GENDER_GROUPS.female],
      custom: false,
    });
  });
  return events;
}

function templateEventIsRelay(name) {
  const text = String(name ?? '');
  return /(接力|团体|4\s*[x×*]\s*100)/i.test(text);
}

function templateEventIsTrack(name) {
  const text = String(name ?? '');
  if (templateEventIsRelay(text)) return true;
  return /(?:\d+\s*(?:米|m)|跨栏|跑步|竞走)/i.test(text);
}

/* ---------------- 模板导出配置（年级限制：默认关闭） ---------------- */

function emptyTemplateConfig() {
  return { restrictByGrade: false, eventGrades: {} };
}

/** 读取导出配置：脏数据一律退回「不限制」 */
function getMeetTemplateConfig() {
  const raw = Store.read(TEMPLATE_CONFIG_KEY, null);
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const eventGrades = {};
  const sourceGrades = source.eventGrades;
  if (sourceGrades && typeof sourceGrades === 'object' && !Array.isArray(sourceGrades)) {
    Object.entries(sourceGrades).forEach(([name, list]) => {
      const eventName = String(name ?? '').trim();
      if (!eventName || !Array.isArray(list)) return;
      const grades = [...new Set(list.map(Number).filter(grade => GRADE_OPTIONS.includes(grade)))]
        .sort((a, b) => a - b);
      eventGrades[eventName] = grades;
    });
  }
  return { restrictByGrade: source.restrictByGrade === true, eventGrades };
}

function saveMeetTemplateConfig(patch = {}) {
  const next = { ...getMeetTemplateConfig(), ...patch };
  Store.write(TEMPLATE_CONFIG_KEY, next);
  return next;
}

/**
 * 某项目在某年级是否可报。
 * 默认（restrictByGrade = false）一律返回 true —— 不按年级过滤，全量输出。
 * 只有老师在报名页「项目管理」里主动勾选「按年级限制项目」后，才开始按配置过滤。
 */
function meetEventAllowedForGrade(event, gradeNumberValue, config = null) {
  const setting = config || (typeof getMeetTemplateConfig === 'function' ? getMeetTemplateConfig() : emptyTemplateConfig());
  if (!setting || setting.restrictByGrade !== true) return true;
  const eventName = String(event?.name ?? '').trim();
  const allowed = setting.eventGrades[eventName];
  if (!allowed || !allowed.length) return true;      // 该项目没配限制 → 放开
  if (!Number.isInteger(gradeNumberValue)) return true; // 班级年级未知 → 放开，避免误删
  return allowed.includes(gradeNumberValue);
}

/* ---------------- 模板内容 ---------------- */

function buildTemplateRows({ classes = [], events = [] } = {}) {
  const rows = [TEMPLATE_HEADER.slice()];
  const config = getMeetTemplateConfig();
  // 每个班级 × 每个项目 × 每个组别 都预填一行（班级、项目、组别三列已填好）
  // 老师下载后不用碰任何下拉框，只在对应行的选手列填姓名即可
  const classList = classes.length ? classes : [{ full: '', gradeNumber: null }];
  classList.forEach(item => {
    events.forEach(event => {
      // 年级限制默认关闭 → 全部年级输出全部项目
      if (!meetEventAllowedForGrade(event, item.gradeNumber, config)) return;
      // 自定义项目可以只设男子组或只设女子组
      const groups = Array.isArray(event.genders) && event.genders.length
        ? event.genders
        : [GENDER_GROUPS.male, GENDER_GROUPS.female];
      groups.forEach(group => {
        rows.push([item.full, '', event.name, group, '', '', '', '', '', '']);
      });
    });
  });
  return rows;
}

function buildInstructionRows({ classCount = 0, eventCount = 0, rowCount = 0 } = {}) {
  return [
    ['运动会报名表 · 填写说明'],
    [''],
    ['一、这张表怎么用'],
    ['班级、项目、组别三列已经全部填好：每个班级的每个项目都各有「男子」「女子」两行。'],
    [classCount ? `本次已按 ${classCount} 个班级 × ${eventCount} 个项目预填了 ${rowCount} 行。` : '本次未读到班级，请在 A 列填班级（或从下拉里选）。'],
    ['老师只需要做一件事：在对应行后面的“选手1、选手2…”里填学生姓名，不需要碰任何下拉框。'],
    ['找自己班的办法：点 A 列的筛选按钮，只勾选自己的班级。'],
    ['没有报名的行整行留空即可，导入时会自动忽略。'],
    [''],
    ['二、表头（第 1 行，请勿改名、不要合并单元格）'],
    ['班级 ｜ 教练/班主任 ｜ 项目 ｜ 组别 ｜ 选手1 ｜ 选手2 ｜ 选手3 ｜ 选手4（仅接力） ｜ 选手5（替补） ｜ 选手6（替补）'],
    [''],
    ['三、填写规则'],
    [`1. 一行 = 一条报名记录（某班 + 某项目 + 某组别）。项目与组别已预填好，请不要改动这两列。`],
    [`2. 单项（非接力）：每项每班最多 ${MAX_INDIVIDUAL_PER_EVENT} 人，填在“选手1～选手${MAX_INDIVIDUAL_PER_EVENT}”。`],
    [`3. 接力项目（4×100米接力 / 50米迎面接力）：每班每组别限 1 队，需 ${RELAY_TEAM_SIZE}～${RELAY_MAX_TEAM_SIZE} 人：` +
      `选手1～选手${RELAY_TEAM_SIZE} 为正式队员（必须填满），选手${RELAY_TEAM_SIZE + 1}、选手${RELAY_MAX_TEAM_SIZE} 可留作替补。`],
    [`4. 每人最多报 ${MAX_INDIVIDUAL_PER_STUDENT} 个单项，另可报 1 个接力项目（接力不计入单项数量）。`],
    ['5. 同一班级、同一项目、同一组别只能出现一次，重复行会变红。'],
    ['6. 项目下拉 = 系统内置 14 个项目 + 老师在报名页「项目管理」里新增的自定义项目；全部年级都能报全部项目。'],
    ['7. 需要按年级限制项目时，到报名页「项目管理 → 按年级限制项目」里勾选开启，默认不限制。'],
    [''],
    ['四、颜色提示'],
    ['单元格变红 = 填写违规（超项、超员、重复、项目名不在列表中）。导入时系统会再校验一次并给出具体行号。'],
    [''],
    ['五、导入'],
    ['填好后保存本文件，回到「运动会报名」页选择该文件即可导入。'],
  ];
}

/** 组装整个工作簿（3 个表：报名表 / 填写说明 / 选项(隐藏)） */
function buildRegistrationWorkbook({ classes = [], events = [] } = {}) {
  const rows = buildTemplateRows({ classes, events });
  const lastRow = Math.max(rows.length + EXTRA_ROWS, 200);
  const instructionRows = buildInstructionRows({
    classCount: classes.length,
    eventCount: events.length,
    rowCount: rows.length - 1,
  });

  const eventNames = events.map(event => event.name);
  const relayNames = events.filter(event => event.relay).map(event => event.name);
  const classNames = classes.map(item => item.full);
  const optionRows = [
    ['项目列表', '接力项目', '班级列表'],
  ];
  const optionHeight = Math.max(eventNames.length, relayNames.length, classNames.length, 1);
  for (let index = 0; index < optionHeight; index++) {
    optionRows.push([
      eventNames[index] ?? '',
      relayNames[index] ?? '（无接力项目）',
      classNames[index] ?? '（请填写班级）',
    ]);
  }

  const definedNames = {
    EventList: `选项!$A$2:$A${Math.max(eventNames.length, 1) + 1}`,
    RelayList: `选项!$B$2:$B${Math.max(relayNames.length, 1) + 1}`,
    ClassList: `选项!$C$2:$C${Math.max(classNames.length, 1) + 1}`,
  };

  const validations = [
    {
      sqref: `A2:A${lastRow}`,
      type: 'list',
      formula1: 'ClassList',
      promptTitle: '班级',
      prompt: '从下拉里选择班级（如“五年级1班”），系统据此识别年级',
      errorTitle: '班级不在名单中',
      error: '请从下拉列表中选择班级；若名单里没有，说明学生库尚未录入该班，可直接手填“年级+班级”全称。',
    },
    {
      sqref: `C2:C${lastRow}`,
      type: 'list',
      formula1: 'EventList',
      promptTitle: '比赛项目',
      prompt: '从下拉里选择项目，不要手打，避免系统无法识别',
      errorTitle: '项目不在列表中',
      error: '请从下拉列表中选择比赛项目。',
    },
    {
      sqref: `D2:D${lastRow}`,
      type: 'list',
      formula1: '"男子,女子"',
      promptTitle: '组别',
      prompt: '男子组 / 女子组',
      errorTitle: '组别无效',
      error: '组别只能填“男子”或“女子”。',
    },
  ].map(validation => ({
    allowBlank: true,
    showInputMessage: true,
    showErrorMessage: true,
    errorStyle: 'warning', // 手填特殊情况仍可放行，红色条件格式负责提醒
    ...validation,
  }));

  // 条件格式：命中即整格变红（dxfId=0 → 红底深红字）
  const relayGuard = `COUNTIF(RelayList,$C2)=0`;
  const individualRows = `COUNTIF(RelayList,$C$2:$C$${lastRow})=0`;
  const sameClass = `$A$2:$A$${lastRow}=$A2`;
  const nameHits = ['E', 'F', 'G', 'H']
    .map(column => `($${column}$2:$${column}$${lastRow}=E2)`)
    .join('+');

  const conditionalFormattings = [
    {
      // 单项每项每班超过 3 人（单项却填了“选手4”及以后）
      sqref: `E2:J${lastRow}`,
      formula: `AND($A2<>"",COUNTA($H2:$J2)>0,${relayGuard})`,
    },
    {
      // 同一名选手在本班单项中出现超过 2 次
      sqref: `E2:J${lastRow}`,
      formula: `AND($A2<>"",E2<>"",${relayGuard},SUMPRODUCT((${individualRows})*(${sameClass})*(${nameHits}))>2)`,
    },
    {
      // 同班 + 同项目 + 同组别重复行
      sqref: `A2:D${lastRow}`,
      formula: `AND($A2<>"",$C2<>"",COUNTIFS($A$2:$A$${lastRow},$A2,$C$2:$C$${lastRow},$C2,$D$2:$D$${lastRow},$D2)>1)`,
    },
    {
      // 项目名不在列表里（老师手打错字）
      sqref: `C2:C${lastRow}`,
      formula: `AND($C2<>"",COUNTIF(EventList,$C2)=0)`,
    },
    {
      // 接力队人数不足 4 人（选手5/6 是替补，可不填）
      sqref: `E2:J${lastRow}`,
      formula: `AND($A2<>"",COUNTIF(RelayList,$C2)>0,$E2<>"",COUNTBLANK($E2:$H2)>0)`,
    },
  ];

  return {
    sheets: [
      {
        name: '报名表',
        rows,
        colWidths: [16, 12, 18, 8, 12, 12, 12, 16, 14, 14],
        freezeRow: 1,
        autoFilter: true,   // 老师可按班级/项目/组别筛选填写
        validations,
        conditionalFormattings,
      },
      {
        name: '填写说明',
        rows: instructionRows,
        colWidths: [110],
      },
      {
        name: '选项',
        rows: optionRows,
        colWidths: [22, 22, 22],
        hidden: true,
      },
    ],
    definedNames,
  };
}

/* ---------------- 极简 XLSX 写入器 ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** 打包为 ZIP（store 方式，不压缩） */
function createZip(files) {
  const encoder = new TextEncoder();
  const entries = files.map(file => {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    return { nameBytes, data, crc: crc32(data), offset: 0 };
  });

  let offset = 0;
  const localParts = [];
  const centralParts = [];
  entries.forEach(entry => {
    entry.offset = offset;
    const local = new Uint8Array(30 + entry.nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x2821, true);
    localView.setUint32(14, entry.crc, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, entry.nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(entry.nameBytes, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x2821, true);
    centralView.setUint32(16, entry.crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, entry.nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, entry.offset, true);
    central.set(entry.nameBytes, 46);
    centralParts.push(central);

    offset += local.length + entry.data.length;
  });

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const parts = [...localParts, ...centralParts, end];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  parts.forEach(part => { output.set(part, cursor); cursor += part.length; });
  return output;
}

function escapeXML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function columnName(index) {
  let name = '';
  let value = index;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function buildSheetXML(sheet) {
  const rowCount = sheet.rows.length;
  const columnCount = sheet.rows.reduce((max, row) => Math.max(max, row.length), 1);
  const dimension = `A1:${columnName(columnCount)}${Math.max(rowCount, 1)}`;

  const cols = (sheet.colWidths || []).map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');

  const body = sheet.rows.map((row, rowIndex) => {
    const style = rowIndex === 0 ? 1 : 2;
    const cells = row.map((value, columnIndex) => {
      const text = String(value ?? '');
      if (text === '') {
        return `<c r="${columnName(columnIndex + 1)}${rowIndex + 1}" s="${style}"/>`;
      }
      return `<c r="${columnName(columnIndex + 1)}${rowIndex + 1}" s="${style}" t="inlineStr">`
        + `<is><t xml:space="preserve">${escapeXML(text)}</t></is></c>`;
    }).join('');
    const height = rowIndex === 0 ? ' ht="30" customHeight="1"' : '';
    return `<row r="${rowIndex + 1}"${height} spans="1:${columnCount}">${cells}</row>`;
  }).join('');

  const conditionalFormattings = (sheet.conditionalFormattings || []).map((rule, index) =>
    `<conditionalFormatting sqref="${escapeXML(rule.sqref)}">`
    + `<cfRule type="expression" dxfId="0" priority="${index + 1}">`
    + `<formula>${escapeXML(rule.formula)}</formula></cfRule></conditionalFormatting>`).join('');

  const validations = (sheet.validations || []).length
    ? `<dataValidations count="${sheet.validations.length}">` + sheet.validations.map(validation =>
      `<dataValidation type="${validation.type}" allowBlank="${validation.allowBlank ? 1 : 0}" `
      + `showInputMessage="${validation.showInputMessage ? 1 : 0}" `
      + `showErrorMessage="${validation.showErrorMessage ? 1 : 0}" `
      + `errorStyle="${validation.errorStyle}" errorTitle="${escapeXML(validation.errorTitle || '')}" `
      + `error="${escapeXML(validation.error || '')}" promptTitle="${escapeXML(validation.promptTitle || '')}" `
      + `prompt="${escapeXML(validation.prompt || '')}" sqref="${escapeXML(validation.sqref)}">`
      + `<formula1>${escapeXML(validation.formula1)}</formula1></dataValidation>`).join('')
      + '</dataValidations>'
    : '';

  const pane = sheet.freezeRow
    ? `<pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/>`
    : '';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="${dimension}"/>`
    + `<sheetViews><sheetView${sheet.freezeRow ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>`
    + '<sheetFormatPr defaultRowHeight="18"/>'
    + (cols ? `<cols>${cols}</cols>` : '')
    + `<sheetData>${body}</sheetData>`
    + (sheet.autoFilter ? `<autoFilter ref="A1:${columnName(columnCount)}${Math.max(rowCount, 1)}"/>` : '')
    + conditionalFormattings
    + validations
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    + '</worksheet>';
}

function buildStylesXML() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2">'
    + '<font><sz val="11"/><color theme="1"/><name val="宋体"/></font>'
    + '<font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="宋体"/></font>'
    + '</fonts>'
    + '<fills count="3">'
    + '<fill><patternFill patternType="none"/></fill>'
    + '<fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>'
    + '</fills>'
    + '<borders count="2">'
    + '<border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border>'
    + '<left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>'
    + '<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/>'
    + '</border>'
    + '</borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
    + '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">'
    + '<alignment vertical="center"/></xf>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>'
    + '<dxfs count="1"><dxf><font><color rgb="FF9C0006"/></font>'
    + '<fill><patternFill><bgColor rgb="FFC7CE"/></patternFill></fill></dxf></dxfs>'
    + '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>'
    + '</styleSheet>';
}

function buildWorkbookXML(workbook) {
  const sheets = workbook.sheets.map((sheet, index) =>
    `<sheet name="${escapeXML(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"`
    + `${sheet.hidden ? ' state="hidden"' : ''}/>`).join('');
  const definedNames = Object.entries(workbook.definedNames || {}).map(([name, reference]) =>
    `<definedName name="${escapeXML(name)}">${escapeXML(reference)}</definedName>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets>${sheets}</sheets>`
    + (definedNames ? `<definedNames>${definedNames}</definedNames>` : '')
    + '</workbook>';
}

function buildWorkbookRelsXML(workbook) {
  const rels = workbook.sheets.map((sheet, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" `
    + `Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const stylesId = workbook.sheets.length + 1;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + rels
    + `<Relationship Id="rId${stylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>';
}

/** 工作簿 → .xlsx 二进制 */
function workbookToXlsx(workbook) {
  const encoder = new TextEncoder();
  const part = xml => encoder.encode(xml);
  const contentTypes ='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + workbook.sheets.map((sheet, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" `
      + 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')
    + '</Types>';

  const files = [
    { name: '[Content_Types].xml', data: part(contentTypes) },
    {
      name: '_rels/.rels',
      data: part('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>'),
    },
    { name: 'xl/workbook.xml', data: part(buildWorkbookXML(workbook)) },
    { name: 'xl/_rels/workbook.xml.rels', data: part(buildWorkbookRelsXML(workbook)) },
    { name: 'xl/styles.xml', data: part(buildStylesXML()) },
  ];
  workbook.sheets.forEach((sheet, index) => {
    files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: part(buildSheetXML(sheet)) });
  });
  return createZip(files);
}

/* ---------------- 对外：导出 ---------------- */

function buildRegistrationTemplateWorkbook(extraEventNames = []) {
  const classes = getTemplateClassOptions();
  const events = getTemplateEventOptions(extraEventNames);
  return buildRegistrationWorkbook({ classes, events });
}

function templateFileName() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `运动会报名模板_${stamp}.xlsx`;
}

/**
 * 导出报名模板（点按钮 / 控制台直接调用均可）
 * 全程同步执行（不 await），保证下载发生在用户点击的同一个事件循环里，浏览器不会拦截
 * @param {string[]} extraEventNames 追加的自定义项目名
 * @returns {{ok:boolean, rows?:number, fileName?:string, size?:number, stage?:string, reason?:string}}
 */
function downloadRegistrationTemplateExcel(extraEventNames = []) {
  // 阶段标记：出错时能一眼看出卡在哪一步
  let stage = '准备数据';
  try {
    console.log('[报名模板] ① 组装工作簿（班级选项 + 项目库）…');
    const workbook = buildRegistrationTemplateWorkbook(extraEventNames);
    const rows = workbook.sheets[0].rows.length - 1;
    console.log(`[报名模板]    预填 ${rows} 行，项目 ${workbook.sheets[2].rows.length - 1} 项`);

    stage = '打包 XLSX';
    console.log('[报名模板] ② 打包为 xlsx…');
    const bytes = workbookToXlsx(workbook);

    stage = '创建 Blob';
    if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('当前浏览器不支持 Blob / URL.createObjectURL，无法生成文件');
    }
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    stage = '触发下载';
    const fileName = templateFileName();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    if (!document.body) throw new Error('document.body 不存在，无法触发下载');
    document.body.appendChild(link);
    link.click();
    // 关键：不要立刻 revoke。Safari / 部分 Chrome 会在 click 后异步读取 blob，
    // 立即回收会导致「点了没反应、也没有文件」。延迟 10 秒再释放。
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (link.parentNode) link.parentNode.removeChild(link);
    };
    if (typeof setTimeout === 'function') setTimeout(cleanup, 10000);
    else cleanup();

    console.log(`[报名模板] ✅ 已触发下载：${fileName}（${(blob.size / 1024).toFixed(1)} KB，${rows} 行预填）`);
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(`报名模板已导出：${rows} 行预填（项目按男子/女子分组）`);
    }
    return { ok: true, rows, fileName, size: blob.size };
  } catch (error) {
    console.error(`[报名模板] ❌ 导出失败（阶段：${stage}）`, error);
    console.error(`[报名模板] 失败详情：${error && error.stack ? error.stack : error}`);
    const message = `报名模板导出失败（${stage}）：${error && error.message ? error.message : error}`;
    if (typeof window !== 'undefined') {
      if (typeof window.showToast === 'function') window.showToast(message, 'error');
      if (typeof window.alert === 'function') window.alert(message);
    }
    return { ok: false, stage, reason: error && error.message ? error.message : String(error) };
  }
}

/* ---------------- 对外：解析 ---------------- */

const FLAT_HEADER_ALIASES = {
  className: ['班级', '班级名称', '班别', 'class'],
  coach: ['教练/班主任', '班主任', '教练', '指导教师'],
  event: ['项目', '比赛项目', '项目名称', '参赛项目'],
  group: ['组别', '男女组别', '性别', '组'],
  athlete1: ['选手1', '运动员1', '姓名1', '选手一', '第一棒'],
  athlete2: ['选手2', '运动员2', '姓名2', '选手二', '第二棒'],
  athlete3: ['选手3', '运动员3', '姓名3', '选手三', '第三棒'],
  athlete4: ['选手4（仅接力）', '选手4', '运动员4', '姓名4', '第四棒'],
  athlete5: ['选手5（替补）', '选手5', '替补1', '运动员5', '姓名5'],
  athlete6: ['选手6（替补）', '选手6', '替补2', '运动员6', '姓名6'],
};

function normalizeTemplateHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_*（）()[\]【】：:]/g, '');
}

function findFlatHeaderIndex(rows) {
  const limit = Math.min(rows.length, 5);
  for (let index = 0; index < limit; index++) {
    const normalized = (rows[index] || []).map(normalizeTemplateHeader);
    const has = field => FLAT_HEADER_ALIASES[field].some(alias => normalized.includes(normalizeTemplateHeader(alias)));
    if (has('className') && has('event') && has('group') && has('athlete1')) return index;
  }
  return -1;
}

/** 判断上传的文件是不是新的扁平模板 */
function isFlatRegistrationTemplate(rows) {
  return Array.isArray(rows) && findFlatHeaderIndex(rows) >= 0;
}

function mapFlatColumns(headerRow) {
  const normalized = headerRow.map(normalizeTemplateHeader);
  const pick = field => normalized.findIndex(header =>
    FLAT_HEADER_ALIASES[field].some(alias => normalizeTemplateHeader(alias) === header));
  return {
    className: pick('className'),
    coach: pick('coach'),
    event: pick('event'),
    group: pick('group'),
    athletes: [
      pick('athlete1'), pick('athlete2'), pick('athlete3'),
      pick('athlete4'), pick('athlete5'), pick('athlete6'),
    ].filter(index => index >= 0),
  };
}

function parseGroupValue(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return GROUP_ALIASES[text] || GROUP_ALIASES[String(value ?? '').trim()] || null;
}

/** 从班级名推断年级：优先“五年级1班”这种全称，再查学生库 */
function resolveGradeByClassName(className) {
  const text = String(className ?? '').trim();
  const match = text.match(/(一年级|二年级|三年级|四年级|五年级|六年级)/);
  if (match) return gradeNumber(match[1]);
  const students = Store.read('pe_students', []) || [];
  if (Array.isArray(students)) {
    const grades = new Set();
    students.forEach(student => {
      if (!student) return;
      const raw = String(student.class ?? '').trim();
      if (raw && (raw === text || text.endsWith(raw))) grades.add(gradeNumber(normalizeGradeText(student.grade)));
    });
    if (grades.size === 1) return [...grades][0];
  }
  return null;
}

/**
 * 生成一条结构化问题（给“错误报告”用）：“第几行第几列 + 哪个字段 + 什么问题”
 * @returns {{line:number, rows:number[], column:string, field:string, message:string, value:string, text:string}}
 */
function makeImportIssue({ line = 0, rows = null, column = '', field = '', message = '', value = '' } = {}) {
  const lineList = rows && rows.length ? [...new Set(rows)] : [line];
  const lineText = `第 ${lineList.join('、')} 行`;
  const text = `${lineText}${column ? `第 ${column} 列` : ''}${field ? `（${field}）` : ''}：${message}`
    + `${value ? `，当前值“${value}”` : ''}`;
  return {
    line: lineList[0],
    rows: lineList,
    column: String(column ?? ''),
    field: String(field ?? ''),
    message: String(message ?? ''),
    value: String(value ?? ''),
    text,
  };
}

/** 只有字符串的问题（老接口）也转成结构化，保证错误报告里列对齐 */
function normalizeImportIssues(issues) {
  return (issues || []).map(issue => (typeof issue === 'string'
    ? { line: 0, rows: [], column: '', field: '', message: issue, value: '', text: issue }
    : issue));
}

/**
 * 班级级严格校验（全表全局扫描，跨行累计）：
 *   ① 同班 + 同项目 + 同组别 单项超过 3 人 → 拒绝上传
 *   ② 同班 + 同学生 单项超过 2 项 → 拒绝上传
 *   ③ 接力不计入上面两条（接力按“每班每组别 1 队、4-6 人”单独管）
 * @param {Array<{className:string, name:string, gender:string, eventName:string, relay:boolean, line:number}>} records
 * @returns {Array} 结构化问题列表
 */
function scanClassLevelViolations(records) {
  const eventCounter = new Map();   // 班级|项目|组别 → { rows: [], names: Set }
  const studentEvents = new Map();  // 班级|姓名 → { rows: [], events: Set }
  const issues = [];

  (records || []).forEach(record => {
    if (!record || record.relay) return;             // 接力不占单名额
    const className = String(record.className ?? '').trim();
    const name = String(record.name ?? '').trim();
    const eventName = String(record.eventName ?? '').trim();
    if (!className || !name || !eventName) return;
    const line = Number(record.line) || 0;

    const eventKey = `${className}|${eventName}|${record.gender || ''}`;
    const eventEntry = eventCounter.get(eventKey) || { rows: [], names: new Set() };
    eventEntry.rows.push(line);
    eventEntry.names.add(name.toLowerCase());
    eventCounter.set(eventKey, eventEntry);

    const studentKey = `${className}|${name}`;
    const studentEntry = studentEvents.get(studentKey) || { rows: [], events: new Set() };
    studentEntry.rows.push(line);
    studentEntry.events.add(`${eventName}|${record.gender || ''}`);
    studentEvents.set(studentKey, studentEntry);
  });

  eventCounter.forEach((entry, key) => {
    if (entry.names.size <= MAX_INDIVIDUAL_PER_EVENT) return;
    const [className, eventName, gender] = key.split('|');
    const genderText = gender === 'male' ? '男子' : gender === 'female' ? '女子' : '';
    issues.push(makeImportIssue({
      rows: entry.rows,
      column: 'E',
      field: '选手',
      message: `${className} ${genderText}${eventName} 超额，最多只能报${MAX_INDIVIDUAL_PER_EVENT}人，当前${entry.names.size}人`,
    }));
  });

  studentEvents.forEach((entry, key) => {
    if (entry.events.size <= MAX_INDIVIDUAL_PER_STUDENT) return;
    const [className, name] = key.split('|');
    issues.push(makeImportIssue({
      rows: entry.rows,
      column: 'E',
      field: '选手',
      message: `${className} ${name} 单项超过${MAX_INDIVIDUAL_PER_STUDENT}项，当前${entry.events.size}项`,
    }));
  });

  return issues;
}

/**
 * 解析扁平模板
 * @param {Array<Array<string>>} rows
 * @param {{customEvents?: Array, defaultClassName?: string}} [options]
 *        自定义项目一律按「已登记项目」处理，不会被判为无效项目；
 *        defaultClassName 用于整张表都没填班级时，按上传老师选择的班级补全
 * @returns {{athletes: Array, errors: string[], issues: Array}}
 */
function parseFlatRegistrationRows(rows, options = {}) {
  const headerIndex = findFlatHeaderIndex(rows);
  if (headerIndex < 0) throw new Error('不是有效的报名模板：第一行应包含 班级、项目、组别、选手1 等列');
  const columns = mapFlatColumns(rows[headerIndex]);
  // 自定义项目元数据：项目名 → { relay, gender }
  const customEvents = Array.isArray(options.customEvents)
    ? options.customEvents
    : getCustomMeetEvents();
  const eventMeta = new Map();
  customEvents.map(normalizeCustomMeetEvent).forEach(event => {
    if (event.name) eventMeta.set(event.name.toLowerCase(), event);
  });
  const defaultClassName = String(options.defaultClassName ?? '').trim();
  const issues = [];
  const imported = new Map();
  // 同名选手的组别统计：一个人不能既报男子组又报女子组
  const nameGenders = new Map();
  // 接力队校验
  const relayTeams = new Map();
  // 交给班级级严格校验做全局扫描的记录（含行号，错误报告能定位到第几行）
  const scanRecords = [];

  // 列号 → Excel 列字母（A/B/C…），错误报告里直接告诉老师第几列
  const letterOf = index => (index >= 0 ? columnName(index + 1) : '');
  const classColumn = letterOf(columns.className);
  const eventColumn = letterOf(columns.event);
  const groupColumn = letterOf(columns.group);
  const athleteColumn = letterOf(columns.athletes[0]);

  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const lineNumber = headerIndex + offset + 2;
    const cell = index => (index >= 0 ? String(row[index] ?? '').trim() : '');
    const className = cell(columns.className) || defaultClassName;
    const eventName = cell(columns.event);
    const groupText = cell(columns.group);
    const athletes = columns.athletes.map(index => cell(index)).filter(Boolean);

    if (!className && !eventName && !groupText && !athletes.length) return; // 空行忽略
    if (!className) {
      issues.push(makeImportIssue({ line: lineNumber, column: classColumn, field: '班级', message: '班级不能为空' }));
      return;
    }
    if (!eventName) {
      issues.push(makeImportIssue({ line: lineNumber, column: eventColumn, field: '项目', message: '项目不能为空' }));
      return;
    }

    const gender = parseGroupValue(groupText);
    if (!gender) {
      issues.push(makeImportIssue({
        line: lineNumber, column: groupColumn, field: '组别',
        message: '组别只能填“男子”或“女子”', value: groupText || '空',
      }));
      return;
    }
    if (!athletes.length) return; // 有项目但没填选手：视为未报名，跳过

    const grade = resolveGradeByClassName(className);
    if (!grade) {
      issues.push(makeImportIssue({
        line: lineNumber, column: classColumn, field: '班级',
        message: '无法识别年级，请写成“五年级1班”这样的全称', value: className,
      }));
      return;
    }

    // 是否接力：先查「项目管理」里的显式设置，再退回按项目名推断
    const meta = eventMeta.get(eventName.toLowerCase());
    const relay = meta ? meta.relay === true : templateEventIsRelay(eventName);
    // 只设了男子组/女子组的自定义项目，组别不符要提示（否则名单会混进错误组别）
    if (meta && meta.gender && meta.gender !== 'both' && meta.gender !== gender) {
      issues.push(makeImportIssue({
        line: lineNumber, column: groupColumn, field: '组别',
        message: `「${eventName}」在项目管理中只设置了${meta.gender === 'male' ? '男子' : '女子'}组`,
        value: groupText || '空',
      }));
      return;
    }

    if (relay) {
      const teamKey = `${className}|${eventName}|${gender}`;
      const team = relayTeams.get(teamKey) || { rows: [], count: 0 };
      team.rows.push(lineNumber);
      team.count += athletes.length;
      relayTeams.set(teamKey, team);
      // 接力允许 4~6 人（多出的是替补）
      if (athletes.length < RELAY_TEAM_SIZE || athletes.length > RELAY_MAX_TEAM_SIZE) {
        issues.push(makeImportIssue({
          line: lineNumber, column: athleteColumn, field: '选手',
          message: `${className} ${GENDER_GROUPS[gender]}${eventName} 为接力项目，需 ${RELAY_TEAM_SIZE}~${RELAY_MAX_TEAM_SIZE} 人（含替补）`,
          value: `${athletes.length} 人`,
        }));
      }
    }

    athletes.forEach(name => {
      const athlete = { name, className, grade, gender };
      const identity = `${name}|${className}|${grade}|${gender}`;
      const genderKey = `${className}|${name}`;
      const genders = nameGenders.get(genderKey) || new Set();
      genders.add(gender);
      nameGenders.set(genderKey, genders);
      let entry = imported.get(identity);
      if (!entry) {
        entry = { ...athlete, events: new Set() };
        imported.set(identity, entry);
      }
      entry.events.add(eventName);
      // 接力不计入“单项超额 / 单人超项”
      if (!relay) {
        scanRecords.push({ className, name, gender, eventName, relay: false, line: lineNumber });
      }
    });
  });

  // 严格规则（全局扫描，跨行累计）
  scanClassLevelViolations(scanRecords).forEach(issue => issues.push(issue));
  // 接力每班每组别限 1 队
  relayTeams.forEach((team, key) => {
    if (team.rows.length <= 1) return;
    const [className, eventName, gender] = key.split('|');
    issues.push(makeImportIssue({
      rows: team.rows, column: 'C', field: '项目',
      message: `${className} 的「${eventName}（${gender === 'male' ? '男子' : '女子'}组）」重复报名，接力每班每组别限 1 队`,
    }));
  });
  // 同一个人不能同时出现在男子组与女子组
  nameGenders.forEach((genders, key) => {
    if (genders.size <= 1) return;
    const [className, name] = key.split('|');
    issues.push(makeImportIssue({
      column: groupColumn || 'D', field: '组别',
      message: `${className} 的「${name}」同时出现在男子组与女子组，请核对姓名与组别`,
    }));
  });

  const uniqueIssues = [];
  const seen = new Set();
  issues.forEach(issue => {
    if (seen.has(issue.text)) return;
    seen.add(issue.text);
    uniqueIssues.push(issue);
  });
  return { athletes: [...imported.values()], errors: uniqueIssues.map(issue => issue.text), issues: uniqueIssues };
}

if (typeof window !== 'undefined') {
  // ⚠️ 千万别在这里写 window.downloadRegistrationTemplateExcel = () => downloadRegistrationTemplateExcel()：
  // 浏览器里顶层函数声明本身就是 window 的同名属性，这样赋值会用箭头函数把原函数覆盖掉，
  // 箭头函数体内再解析同名标识符 → 解析到自己 → 无限递归（Maximum call stack size exceeded）。
  // 函数声明已经自动挂在 window 上，控制台可直接调用，不需要再手动挂。
  console.log('[报名模板] 模块已加载 ✔（控制台可直接敲 downloadRegistrationTemplateExcel() 导出排查）');
}
