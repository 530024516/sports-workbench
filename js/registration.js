'use strict';

Layout.init('registration', '运动会报名管理', '报名管理');

const STORAGE_KEY = 'pe_sports_meet_v1';
const PAGE_SIZE = 20;
const GRADE_NAMES = {
  '一年级': 1, '二年级': 2, '三年级': 3,
  '四年级': 4, '五年级': 5, '六年级': 6,
};
const HEADER_ALIASES = {
  name: ['姓名', '学生姓名', 'name'],
  className: ['班级', '班级名称', 'class', 'classname'],
  grade: ['年级', 'grade'],
  gender: ['性别', 'gender'],
  events: ['报名项目', '比赛项目', '参赛项目', '项目', 'events', 'event'],
};

// 可选跑道数（小学有 4 道的小场地，也有 8 道的标准场）与默认跑道数
const LANE_COUNT_OPTIONS = [4, 5, 6, 7, 8];
const DEFAULT_LANE_COUNT = 4;

let storageError = '';
let pageData = loadMeetData();
let pendingImport = null;
let pendingImportRows = null;   // 等老师选班级时暂存的表格行
let currentPage = 1;
let searchQuery = '';
let globalSearchQuery = '';   // 看板上的全局搜索（按姓名反查班级与项目）
let laneCount = DEFAULT_LANE_COUNT;
const selectedAthleteIds = new Set();
if (LANE_COUNT_OPTIONS.includes(pageData.laneCount)) laneCount = pageData.laneCount;

const pageContent = document.getElementById('page-content');
pageContent.innerHTML = `
  <div class="card" style="margin-bottom:20px;">
    <div class="card-header meet-toolbar">
      <div>
        <div class="card-title"><span>📊</span> 全校报名总览</div>
        <div class="card-subtitle">各班级提交状态、报名人数，以及按姓名反查项目</div>
      </div>
      <input class="meet-search" id="globalStudentSearch" type="search"
             placeholder="全局搜索学生姓名，反查班级与项目" aria-label="全局搜索学生姓名">
    </div>
    <div class="card-body">
      <div class="meet-overview-stats" id="overviewStats"></div>
      <div class="meet-search-result" id="globalSearchResult"></div>
      <div class="meet-class-grid" id="classBoard"></div>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px;">
    <div class="card-header">
      <div>
        <div class="card-title"><span>🏅</span> 报名管理</div>
        <div class="card-subtitle">批量导入报名表，校验资格并生成径赛预赛分组</div>
      </div>
      <div class="meet-toolbar-actions">
        <button class="btn btn-primary" onclick="exportRegistrationTemplateExcel()">导出报名模板（Excel）</button>
        <button class="btn btn-secondary" onclick="openMeetEventManager()">项目管理</button>
        <button class="btn btn-secondary" onclick="downloadRegistrationTemplate()">下载 CSV 模板</button>
      </div>
    </div>
    <div class="card-body">
      <div class="meet-upload">
        <input id="registrationFile" type="file" accept=".csv,.xlsx,.xls" aria-label="选择 Excel 或 CSV 报名文件">
        <span class="meet-upload-hint">推荐用「导出报名模板（Excel）」生成的扁平模板：每行 = 班级 + 项目 + 组别 + 选手，项目已按男/女预填，填好直接导入即可；也兼容旧格式（姓名、班级、年级、性别、报名项目）。</span>
      </div>
      <div class="meet-alert" id="storageAlert" role="alert"></div>
      <div class="meet-alert" id="validationAlert" role="alert"></div>
      <div class="meet-preview" id="importPreview"></div>
    </div>
  </div>

  <div class="grid grid-3" style="margin-bottom:20px;">
    <div class="stat-card">
      <div class="stat-icon" style="background:var(--primary-100);color:var(--primary);">👥</div>
      <div class="stat-content"><h3 id="athleteCount">0</h3><p>参赛运动员</p></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:var(--info-light);color:#0288D1;">📝</div>
      <div class="stat-content"><h3 id="registrationCount">0</h3><p>单项报名人次</p></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:var(--warning-light);color:#B8860B;">🏃</div>
      <div class="stat-content"><h3 id="heatCount">0</h3><p>径赛预赛组数</p></div>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px;">
    <div class="card-header meet-toolbar">
      <div class="card-title"><span>📋</span> 运动员与报名项目</div>
      <input class="meet-search" id="athleteSearch" type="search" placeholder="搜索姓名、班级、参赛号码或项目" aria-label="搜索报名记录">
    </div>
    <div class="card-body">
      <div class="meet-bulk-actions">
        <div class="meet-toolbar-actions">
          <button class="btn btn-danger" id="deleteSelectedButton" onclick="deleteSelectedAthletes()" disabled>删除选中</button>
          <button class="btn btn-danger" id="clearAllButton" onclick="clearAllRegistrations()" disabled>清空全部报名</button>
        </div>
        <span class="meet-muted" id="selectionSummary">已选 0 条</span>
      </div>
      <div class="meet-table-wrap" id="athleteTable"></div>
      <div class="meet-pagination" id="athletePagination"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header meet-toolbar">
      <div>
        <div class="card-title"><span>🏁</span> 径赛预赛分组</div>
        <div class="card-subtitle">同班运动员尽量分散；道次随机分配</div>
      </div>
      <div class="meet-toolbar-actions">
        <label class="meet-lane-control">跑道数
          <select id="laneCount">
            ${LANE_COUNT_OPTIONS.map(count => `<option value="${count}"${count === laneCount ? ' selected' : ''}>${count} 道</option>`).join('')}
          </select>
        </label>
        <button class="btn btn-secondary" onclick="regenerateHeats()">重新随机分组</button>
      </div>
    </div>
    <div class="card-body">
      <div id="heatGuidance" class="meet-guidance"></div>
      <div class="meet-heats" id="heatList"></div>
    </div>
  </div>
`;

function emptyMeetData() {
  return { athletes: [], registrations: [], heats: [], laneCount: DEFAULT_LANE_COUNT };
}

function loadMeetData() {
  try {
    const data = Store.read(STORAGE_KEY, null);
    if (!data) return emptyMeetData();
    if (typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.athletes) || !Array.isArray(data.registrations) || !Array.isArray(data.heats)) {
      throw new Error('运动会数据格式不正确');
    }
    return {
      ...emptyMeetData(),
      ...data,
      registrations: data.registrations.map(registration => ({
        ...registration,
        isTeamEvent: registrationIsTeamEvent(registration),
      })),
    };
  } catch (error) {
    storageError = `无法读取本地报名数据：${error.message}。请先导出或清理浏览器中损坏的运动会数据后再继续。`;
    return emptyMeetData();
  }
}

/**
 * 保存报名数据（重要表单，强一致）：
 * ① 本地立即生效（页面马上能看到新数据）
 * ② await 云端写入确认 —— 只有云端返回成功才算"保存成功"，
 *    否则数据虽然完整留在本地，也必须弹窗报错，绝不能提示"已保存"让用户以为落库了。
 *    否则用户一刷新，云端旧数据回来就把刚导入的数据冲掉了。
 * ③ 成功后派发 store:sync，赛程编排等模块立刻重取，不用等轮询
 *
 * @returns {Promise<boolean>} 云端是否确认成功
 */
/**
 * @param {object} data
 * @param {{force?: boolean}} options
 *        force=true：用户在界面上亲手点了删除 / 清空，才允许把报名数据写空。
 *        Store 默认会【抛异常终止写入】，任何后台同步 / 页面跳转带来的空数据都不准覆盖。
 */
async function saveMeetData(data, options = {}) {
  pageData = data;
  storageError = '';
  try {
    // 版本兜底：浏览器缓存了旧版 store.js 时没有 writeCritical，退回同步写，
    // 数据照样落本地（旧行为），并提示老师强制刷新，绝不让保存按钮失灵
    if (typeof Store.writeCritical !== 'function') {
      Store.write(STORAGE_KEY, data);
      renderPage();
      renderStorageAlert();
      showToast('已保存到本机（存储组件需更新，请强制刷新页面以确保同步到云端）', 'error');
      return true;
    }
    const result = await Store.writeCritical(STORAGE_KEY, data, {
      label: '运动会报名数据',
      force: options.force === true || options.allowEmpty === true,
    });
    renderPage();
    renderStorageAlert();
    if (!result.ok) {
      const message = `报名数据已保存在本机，但同步到云端失败：${result.error || '未知错误'}。\n\n`
        + '数据不会丢失，系统会在后台继续重试上传；请不要清理浏览器数据。';
      showValidationErrors([message]);
      window.alert(message);
      return false;
    }
    return true;
  } catch (error) {
    const message = `保存失败：${error?.message || error}`;
    showValidationErrors([message]);
    renderPage();
    renderStorageAlert();
    return false;
  }
}



function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function makeId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_*（）()[\]【】：:]/g, '');
}

function parseCSV(text) {
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
      if (row.some(value => String(value).trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some(value => String(value).trim() !== '')) rows.push(row);
  if (quoted) throw new Error('CSV 文件包含未闭合的双引号');
  return rows;
}

async function readFileRows(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'csv') return parseCSV(await file.text());
  if (!['xls', 'xlsx'].includes(extension)) throw new Error('请选择 CSV、XLS 或 XLSX 文件');
  if (!globalThis.XLSX) throw new Error('Excel 解析库未加载，请检查网络连接或改用 CSV 文件');

  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) throw new Error('Excel 文件中没有可读取的工作表');
  return XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
}

/** 0-based 列号 → Excel 列字母（A/B/C…），错误报告里直接告诉老师第几列 */
function importColumnLetter(index) {
  if (!Number.isInteger(index) || index < 0) return '';
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/** 结构化问题（模板模块加载时用它；未加载时退化成纯文本，绝不因此报错） */
function importIssue(detail) {
  return typeof makeImportIssue === 'function'
    ? makeImportIssue(detail)
    : { line: detail.line || 0, rows: [], column: detail.column || '', field: detail.field || '', message: detail.message || '', value: '', text: detail.message || '' };
}

/** 把「字符串问题 / 结构化问题」混合的数组统一成结构化数组 */
function toImportIssues(list) {
  return (list || []).map(item => (typeof item === 'string' ? importIssue({ message: item }) : item));
}

function getHeaderIndexes(headerRow, optionalFields = []) {
  const normalized = headerRow.map(normalizeHeader);
  const indexes = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    indexes[field] = normalized.findIndex(header => aliases.some(alias => normalizeHeader(alias) === header));
  }
  const missing = Object.entries(indexes)
    .filter(([field, index]) => index < 0 && !optionalFields.includes(field))
    .map(([field]) => ({
      name: '姓名', className: '班级', grade: '年级', gender: '性别', events: '报名项目',
    })[field]);
  if (missing.length) throw new Error(`缺少必需列：${missing.join('、')}`);
  return indexes;
}

function parseGrade(value) {
  const text = String(value ?? '').trim();
  const numeric = Number(text.match(/\d+/)?.[0]);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 6) return numeric;
  return GRADE_NAMES[text] || null;
}

function parseGender(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['男', '男生', '男子', 'male', 'm'].includes(text)) return 'male';
  if (['女', '女生', '女子', 'female', 'f'].includes(text)) return 'female';
  return null;
}

function splitEventNames(value) {
  return [...new Set(String(value ?? '').split(/[,，、;；|/\n]+/).map(event => event.trim()).filter(Boolean))];
}

function athleteKey(athlete) {
  return [athlete.name, athlete.className, athlete.grade].map(value => String(value).trim().toLowerCase()).join('|');
}

function identityKey(athlete) {
  return `${athleteKey(athlete)}|${athlete.gender}`;
}

function eventIsTeam(name) {
  return /(团体|接力|4\s*[x×]\s*100\s*(?:米|m)?)/i.test(name);
}

/**
 * 是否团队/接力项目：名字里带“接力/团体”的，或在「项目管理」里显式标记为接力的自定义项目
 * （例如“拔河”名字里没有接力二字，但管理里勾了接力，就按接力规则处理）
 */
function isTeamEventName(name) {
  if (eventIsTeam(name)) return true;
  return typeof isManagedRelayEvent === 'function' && isManagedRelayEvent(name);
}

function registrationIsTeamEvent(registration) {
  return registration.isTeamEvent === true ||
    registration.isTeam === true ||
    isTeamEventName(registration.eventName);
}

function eventIsTrack(name) {
  return /(?:\d+\s*(?:米|m)\s*(?:跑)?|接力|跨栏|跑步)/i.test(name);
}

function eventKey(name, gender) {
  return `${name.trim().toLowerCase()}|${gender}`;
}

function parseRegistrationRows(rows, options = {}) {
  if (rows.length < 2) throw new Error('文件中没有报名数据行');
  // 整张表都没填班级时，用上传老师选择的班级补全
  const defaultClassName = String(options?.defaultClassName ?? '').trim();
  const indexes = getHeaderIndexes(rows[0], defaultClassName ? ['className'] : []);
  const imported = new Map();
  const genderByStudent = new Map();
  const issues = [];
  // 交给班级级严格校验做全局扫描（接力不计入单项限制）
  const scanRecords = [];
  const letterOf = index => importColumnLetter(index);

  rows.slice(1).forEach((row, rowIndex) => {
    const lineNumber = rowIndex + 2;
    const athlete = {
      name: String(row[indexes.name] ?? '').trim(),
      className: String(indexes.className >= 0 ? row[indexes.className] ?? '' : '').trim() || defaultClassName,
      grade: parseGrade(row[indexes.grade]),
      gender: parseGender(row[indexes.gender]),
    };
    const events = splitEventNames(row[indexes.events]);
    if (!athlete.name || !athlete.className || !athlete.grade || !athlete.gender || events.length === 0) {
      // 精确定位到第几行第几列，方便老师直接改
      const missing = !athlete.name ? { field: '姓名', index: indexes.name }
        : !athlete.className ? { field: '班级', index: indexes.className }
          : !athlete.grade ? { field: '年级', index: indexes.grade }
            : !athlete.gender ? { field: '性别', index: indexes.gender }
              : { field: '报名项目', index: indexes.events };
      issues.push(importIssue({
        line: lineNumber,
        column: letterOf(missing.index),
        field: missing.field,
        message: `${missing.field}缺失或无效（姓名、班级、1-6年级、有效性别、报名项目均为必填）`,
        value: String(row[missing.index] ?? ''),
      }));
      return;
    }

    const baseKey = athleteKey(athlete);
    const oldGender = genderByStudent.get(baseKey);
    if (oldGender && oldGender !== athlete.gender) {
      issues.push(importIssue({
        line: lineNumber,
        column: letterOf(indexes.gender),
        field: '性别',
        message: `${athlete.name} 的性别与同名同班记录不一致`,
      }));
      return;
    }
    genderByStudent.set(baseKey, athlete.gender);

    const key = identityKey(athlete);
    let entry = imported.get(key);
    if (!entry) {
      entry = { ...athlete, events: new Set() };
      imported.set(key, entry);
    }
    events.forEach(event => entry.events.add(event));
    // 接力不计入“单项超额 / 单人超项”
    events.filter(eventName => !isTeamEventName(eventName)).forEach(eventName => {
      scanRecords.push({
        className: athlete.className,
        name: athlete.name,
        gender: athlete.gender,
        eventName,
        relay: false,
        line: lineNumber,
      });
    });
  });

  // 严格规则：按班级全局扫描（单项每班最多 3 人 / 每人单项最多 2 项）
  if (typeof scanClassLevelViolations === 'function') {
    scanClassLevelViolations(scanRecords).forEach(issue => issues.push(issue));
  }

  return { athletes: [...imported.values()], errors: issues.map(issue => issue.text), issues };
}

function validateAthleteEligibility(athletes, registrations) {
  const athleteById = new Map(athletes.map(athlete => [athlete.id, athlete]));
  const eventsByAthlete = new Map();
  registrations.forEach(registration => {
    const athlete = athleteById.get(registration.athleteId);
    if (!athlete) return;
    const counts = eventsByAthlete.get(athlete.id) || { individual: new Set(), team: new Set() };
    const events = registrationIsTeamEvent(registration) ? counts.team : counts.individual;
    events.add(eventKey(registration.eventName, registration.genderGroup));
    eventsByAthlete.set(athlete.id, counts);
  });

  return [...eventsByAthlete.entries()]
    .filter(([, counts]) => counts.individual.size > 2 || counts.team.size > 1)
    .map(([athleteId, counts]) => {
      const athlete = athleteById.get(athleteId);
      const prefix = athlete?.className ? `${athlete.className} ` : '';
      if (counts.individual.size > 2) {
        return `${prefix}${athlete.name} 单项超过2项（当前${counts.individual.size}项）`;
      }
      return `${prefix}${athlete.name} 团队项目超过1项（当前${counts.team.size}项）`;
    });
}

function prepareImport(importedAthletes) {
  const athletes = pageData.athletes.map(athlete => ({ ...athlete }));
  const registrations = pageData.registrations.map(registration => ({ ...registration }));
  const identities = new Map(athletes.map(athlete => [identityKey(athlete), athlete]));
  const eventRegistrations = new Map(
    registrations.map(registration => [`${registration.athleteId}|${eventKey(registration.eventName, registration.genderGroup)}`, registration]),
  );

  importedAthletes.forEach(imported => {
    const identity = identityKey(imported);
    let athlete = identities.get(identity);
    if (!athlete) {
      athlete = {
        id: makeId(),
        studentNo: '',
        name: imported.name,
        className: imported.className,
        grade: imported.grade,
        gender: imported.gender,
        bibNumber: '',
      };
      identities.set(identity, athlete);
      athletes.push(athlete);
    }

    imported.events.forEach(eventName => {
      const genderGroup = athlete.gender;
      const key = `${athlete.id}|${eventKey(eventName, genderGroup)}`;
      if (eventRegistrations.has(key)) return;
      const registration = {
        id: makeId(),
        athleteId: athlete.id,
        eventName,
        eventType: eventIsTrack(eventName) ? 'track' : 'field',
        genderGroup,
        isTeamEvent: isTeamEventName(eventName),
      };
      registrations.push(registration);
      eventRegistrations.set(key, registration);
    });
  });

  const eligibilityErrors = validateAthleteEligibility(athletes, registrations);
  if (eligibilityErrors.length) {
    return { data: null, errors: eligibilityErrors };
  }

  assignBibNumbers(athletes);
  const heats = generatePreliminaryHeats(athletes, registrations, laneCount);
  return { data: { ...pageData, athletes, registrations, heats, laneCount, schedule: null, results: [] }, errors: [] };
}

function assignBibNumbers(athletes) {
  const sorted = [...athletes].sort((a, b) =>
    a.grade - b.grade ||
    String(a.className).localeCompare(String(b.className), 'zh-CN', { numeric: true }) ||
    String(a.name).localeCompare(String(b.name), 'zh-CN'),
  );
  sorted.forEach((athlete, index) => {
    athlete.bibNumber = String(1001 + index);
  });
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function arrangeLanes(athletes, laneTotal) {
  // 可用道次 = 1…跑道数，绝不会出现超过跑道数的道次（选 4 道就只会有 1、2、3、4 道）
  const laneLimit = LANE_COUNT_OPTIONS.includes(laneTotal) ? laneTotal : DEFAULT_LANE_COUNT;
  let best = null;
  let bestScore = Infinity;
  const attempts = Math.min(100, Math.max(30, athletes.length * 8));

  for (let attempt = 0; attempt < attempts; attempt++) {
    const order = shuffle(athletes);
    let score = 0;
    for (let index = 1; index < order.length; index++) {
      if (order[index - 1].className === order[index].className &&
          order[index - 1].grade === order[index].grade) score++;
    }
    if (score < bestScore) {
      best = order;
      bestScore = score;
      if (score === 0) break;
    }
  }

  // 从第 1 道开始依次占用：人数不足跑道数时不空道、不漏人
  // 例：9 人 / 4 道 → 分 3 组（3+3+3），最后一组 1 人时跑 1 道
  const laneNumbers = Array.from(
    { length: athletes.length },
    (_, index) => (index % laneLimit) + 1,
  );
  return best.map((athlete, index) => ({
    athleteId: athlete.id,
    lane: laneNumbers[index],
    bibNumber: athlete.bibNumber,
  })).sort((a, b) => a.lane - b.lane);
}

function generatePreliminaryHeats(athletes, registrations, laneTotal) {
  const athleteById = new Map(athletes.map(athlete => [athlete.id, athlete]));
  const eventParticipants = new Map();
  registrations.filter(registration => registration.eventType === 'track').forEach(registration => {
    const athlete = athleteById.get(registration.athleteId);
    if (!athlete) return;
    const key = eventKey(registration.eventName, registration.genderGroup);
    const participants = eventParticipants.get(key) || { eventName: registration.eventName, genderGroup: registration.genderGroup, athletes: [] };
    participants.athletes.push(athlete);
    eventParticipants.set(key, participants);
  });

  const heats = [];
  eventParticipants.forEach(event => {
    if (event.athletes.length <= laneTotal) return;
    const heatCount = Math.ceil(event.athletes.length / laneTotal);
    const buckets = Array.from({ length: heatCount }, () => []);
    const roster = shuffle(event.athletes);

    roster.forEach(athlete => {
      const smallestSize = Math.min(...buckets.map(bucket => bucket.length));
      const candidates = buckets
        .map((bucket, index) => ({ bucket, index }))
        .filter(candidate => candidate.bucket.length === smallestSize);
      const leastSameClass = Math.min(...candidates.map(candidate =>
        candidate.bucket.filter(member => member.className === athlete.className && member.grade === athlete.grade).length,
      ));
      const bestBuckets = candidates.filter(candidate =>
        candidate.bucket.filter(member => member.className === athlete.className && member.grade === athlete.grade).length === leastSameClass,
      );
      bestBuckets[Math.floor(Math.random() * bestBuckets.length)].bucket.push(athlete);
    });

    buckets.forEach((bucket, index) => {
      heats.push({
        id: makeId(),
        eventName: event.eventName,
        genderGroup: event.genderGroup,
        round: 'preliminary',
        groupNumber: index + 1,
        entries: arrangeLanes(bucket, laneTotal),
      });
    });
  });
  return heats;
}

function showValidationErrors(errors) {
  const alertBox = document.getElementById('validationAlert');
  alertBox.classList.add('visible');
  alertBox.innerHTML = `<strong>报名资格校验未通过，拒绝保存：</strong><ul>${errors.map(error => `<li>${escapeHTML(error)}</li>`).join('')}</ul>`;
}

function clearValidationErrors() {
  const alertBox = document.getElementById('validationAlert');
  alertBox.classList.remove('visible');
  alertBox.innerHTML = '';
}

function renderStorageAlert() {
  const alertBox = document.getElementById('storageAlert');
  alertBox.classList.toggle('visible', Boolean(storageError));
  alertBox.textContent = storageError;
}

/** 错误报告：定位到第几行第几列，不白屏、不让老师猜 */
function renderImportIssueReport(issues) {
  if (!issues || !issues.length) return '';
  const rowsHTML = issues.map(issue => `
    <tr>
      <td>${escapeHTML((issue.rows && issue.rows.length ? issue.rows : [issue.line]).filter(Boolean).join('、') || '-')}</td>
      <td>${escapeHTML(issue.column || '-')}</td>
      <td>${escapeHTML(issue.field || '-')}</td>
      <td>${escapeHTML(issue.message || issue.text || '')}</td>
      <td>${escapeHTML(issue.value || '')}</td>
    </tr>`).join('');
  return `
    <div class="meet-alert visible">
      <strong>错误报告：发现 ${issues.length} 处问题，本次导入已拒绝（行号 = Excel 里的行号，列 = Excel 列标）</strong>
      <div class="meet-table-wrap" style="margin-top:10px;">
        <table class="meet-table">
          <thead><tr>
            <th style="width:90px;">行号</th><th style="width:60px;">列</th>
            <th style="width:90px;">字段</th><th>问题</th><th style="width:130px;">当前值</th>
          </tr></thead>
          <tbody>${rowsHTML}</tbody>
        </table>
      </div>
    </div>`;
}

function renderImportPreview(parsed, errors, previewData, issues = null) {
  const container = document.getElementById('importPreview');
  const issueList = toImportIssues(issues || errors);
  const importButton = `<button class="btn btn-primary" onclick="commitImport()" ${errors.length ? 'disabled' : ''}>校验并保存报名</button>`;
  const rows = parsed.slice(0, 8).map(athlete => `
    <tr>
      <td>${escapeHTML(athlete.name)}</td>
      <td>${escapeHTML(athlete.className)}</td>
      <td>${athlete.grade} 年级</td>
      <td>${athlete.gender === 'male' ? '男' : '女'}</td>
      <td class="meet-events">${[...athlete.events].map(event => `<span class="meet-event-tag ${eventIsTeam(event) ? 'team' : ''}">${escapeHTML(event)}${eventIsTeam(event) ? ' · 团体' : ''}</span>`).join('')}</td>
    </tr>
  `).join('');
  container.innerHTML = `
    ${errors.length ? renderImportIssueReport(issueList) : ''}
    <div class="meet-preview-summary"><span>文件识别到 ${parsed.length} 名学生</span><span>${errors.length ? '请按错误报告修正后重新导入' : '报名资格校验通过，可合并保存'}</span></div>
    ${parsed.length ? `<div class="meet-table-wrap"><table class="meet-table"><thead><tr><th>姓名</th><th>班级</th><th>年级</th><th>性别</th><th>报名项目</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    ${parsed.length > 8 ? `<p class="meet-guidance">当前仅预览前 8 名；保存后可在下方搜索完整报名清单。</p>` : ''}
    <div style="margin-top:14px;">${importButton}</div>
  `;
  pendingImport = errors.length ? null : previewData;
  if (errors.length) {
    showValidationErrors(errors);
    window.alert(`报名资格校验未通过，不能保存：\n${errors.slice(0, 8).join('\n')}`);
  } else {
    clearValidationErrors();
  }
}

/** 班级列在哪一列（兼容新版扁平模板与旧版名单格式） */
function findImportClassColumn(rows) {
  if (typeof isFlatRegistrationTemplate === 'function' && isFlatRegistrationTemplate(rows)) {
    const headerIndex = findFlatHeaderIndex(rows);
    return { headerIndex, column: mapFlatColumns(rows[headerIndex]).className };
  }
  try {
    return { headerIndex: 0, column: getHeaderIndexes(rows[0], ['className']).className };
  } catch (error) {
    return { headerIndex: 0, column: -1 }; // 表头本身不合格，交给后面的解析去报具体缺哪列
  }
}

/** 整张表是否填写了班级：没有就要先让上传的老师选班级 */
function sheetHasClassValues(rows) {
  const { headerIndex, column } = findImportClassColumn(rows);
  if (column < 0) return false;
  return rows.slice(headerIndex + 1).some(row => String(row?.[column] ?? '').trim() !== '');
}

/** 可选班级：学生库 + 已有报名名单 */
function listImportClassOptions() {
  const names = new Set(typeof getSchoolClassNames === 'function' ? getSchoolClassNames() : []);
  (pageData.athletes || []).forEach(athlete => {
    if (athlete?.className) names.add(String(athlete.className).trim());
  });
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

/** 表格里没有填班级时，弹窗让上传的老师选择自己所在的班级 */
function openImportClassPicker(rows) {
  pendingImportRows = rows || null;
  const options = listImportClassOptions();
  const optionHTML = options.length
    ? `<option value="">（请选择班级）</option>${options.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('')}`
    : '<option value="">（学生库里还没有班级）</option>';
  showModal(
    '这份表格没有填班级',
    `<p class="meet-upload-hint">没有识别到班级列，请选择你所在的班级，整张表会按这个班级导入。</p>
     <div class="form-group" style="margin-top:12px;">
       <label for="importClassSelect">班级</label>
       <select id="importClassSelect" class="meet-search" aria-label="选择班级">${optionHTML}</select>
     </div>
     <div class="form-group" style="margin-top:12px;">
       <label for="importClassCustom">或手动填写班级</label>
       <input id="importClassCustom" type="text" class="meet-search" autocomplete="off"
              placeholder="例如：五年级3班" aria-label="手动填写班级">
     </div>
     <p class="meet-upload-hint" style="margin-top:8px;">请写“五年级3班”这样的全称，系统据此识别年级。</p>`,
    `<button class="btn btn-secondary" onclick="closeModal(this)">取消</button>
     <button id="importClassConfirm" class="btn btn-primary" onclick="confirmImportClass()">按这个班级导入</button>`,
  );
}

async function confirmImportClass() {
  const custom = String(document.getElementById('importClassCustom')?.value ?? '').trim();
  const selected = String(document.getElementById('importClassSelect')?.value ?? '').trim();
  const className = custom || selected;
  if (!className) {
    showToast('请选择或填写班级', 'error');
    return;
  }
  const rows = pendingImportRows;
  pendingImportRows = null;
  const button = document.getElementById('importClassConfirm');
  if (button && typeof closeModal === 'function') closeModal(button);
  await runImportPipeline(rows, className);
}

/** 导入主流程：多班级识别 → 解析 → 严格规则拦截 → 错误报告 / 预览 */
async function runImportPipeline(rows, defaultClassName = '') {
  try {
    if (!Array.isArray(rows) || rows.length < 2) {
      throw new Error('文件里没有报名数据行（至少需要一行表头 + 一行数据）');
    }
    // ① 多班级识别：整张表都没填班级时先问老师
    if (!defaultClassName && !sheetHasClassValues(rows)) {
      openImportClassPicker(rows);
      return;
    }
    // 自动识别模板：新版扁平模板（班级/项目/组别/选手1…）优先，其次旧版名单格式
    const parsedResult = isFlatRegistrationTemplate(rows)
      ? parseFlatRegistrationRows(rows, {
        customEvents: typeof getCustomMeetEvents === 'function' ? getCustomMeetEvents() : [],
        defaultClassName,
      })
      : parseRegistrationRows(rows, { defaultClassName });
    let issues = toImportIssues(parsedResult.issues || parsedResult.errors);
    let previewData = null;
    if (!parsedResult.errors.length) {
      const prepared = prepareImport(parsedResult.athletes);
      previewData = prepared.data;
      if (prepared.errors.length) {
        issues = issues.concat(prepared.errors.map(message => importIssue({ field: '报名资格', message })));
      }
    }
    renderImportPreview(parsedResult.athletes, issues.map(issue => issue.text), previewData, issues);
  } catch (error) {
    console.error('[报名] 导入解析失败', error);
    pendingImport = null;
    const issues = [importIssue({ field: '文件', message: error?.message || '解析失败' })];
    renderImportPreview([], issues.map(issue => issue.text), null, issues);
    showValidationErrors([error?.message || '解析失败']);
  }
}

async function handleRegistrationFile(event) {
  clearValidationErrors();
  pendingImport = null;
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    if (storageError) throw new Error(storageError);
    const rows = await readFileRows(file);
    await runImportPipeline(rows);
  } catch (error) {
    console.error('[报名] 读取文件失败', error);
    pendingImport = null;
    // 容错：出错也渲染错误报告，绝不留白屏
    const issues = [importIssue({ field: '文件', message: error?.message || '文件读取失败' })];
    renderImportPreview([], issues.map(issue => issue.text), null, issues);
    showValidationErrors([error?.message || '文件读取失败']);
  } finally {
    event.target.value = '';
  }
}

async function commitImport() {
  if (storageError) {
    const message = '本地报名数据读取失败，未覆盖保存';
    showValidationErrors([message]);
    window.alert(message);
    return;
  }
  if (!pendingImport) {
    const errors = ['当前导入内容未通过校验，未保存'];
    showValidationErrors(errors);
    window.alert(errors[0]);
    return;
  }
  const saving = pendingImport;
  pendingImport = null;
  // 重要表单：等到云端确认落库再提示成功，否则用户一刷新就被云端旧数据冲掉
  showToast('正在保存并同步到云端…', 'info');
  const ok = await saveMeetData(saving);
  if (!ok) { pendingImport = saving; return; }   // 数据还在本地，允许用户稍后重试
  document.getElementById('importPreview').innerHTML = '';
  clearValidationErrors();
  showToast('报名数据已保存并同步到云端，参赛号码及径赛分组已更新');
}

/** 导出扁平化 Excel 报名模板：带上本次运动会已有的项目，避免老师自建项目丢失 */
function exportRegistrationTemplateExcel() {
  // 脚本没加载时（浏览器缓存了旧页面最常见）明确告知，而不是点了没反应
  if (typeof downloadRegistrationTemplateExcel !== 'function') {
    const message = '报名模板生成脚本（js/registration-template.js）未加载，请强制刷新页面后再试（Mac：Cmd+Shift+R，Windows：Ctrl+Shift+R）';
    console.error('[报名]', message);
    window.alert(message);
    return { ok: false, reason: message };
  }
  const extraEvents = [...new Set((pageData.registrations || [])
    .map(registration => registration.eventName)
    .filter(Boolean))];
  console.log(`[报名] 点击导出，追加自定义项目 ${extraEvents.length} 个`);
  return downloadRegistrationTemplateExcel(extraEvents);
}

/* ---------------- 项目管理：自定义比赛项目 ---------------- */

/** 打开【项目管理】弹窗：新增/删除自定义项目，自动并入导出模板 */
function openMeetEventManager() {
  if (typeof getCustomMeetEvents !== 'function') {
    const message = '模板模块（js/registration-template.js）未加载，请强制刷新页面后再试（Mac：Cmd+Shift+R，Windows：Ctrl+Shift+R）';
    console.error('[报名]', message);
    window.alert(message);
    return;
  }
  showModal(
    '项目管理 · 自定义比赛项目',
    `<div class="form-row">
       <div class="form-group">
         <label for="meetEventName">项目名称</label>
         <input id="meetEventName" type="text" class="meet-search" autocomplete="off"
                placeholder="例如：跳绳、踢毽子" aria-label="比赛项目名称">
       </div>
       <div class="form-group">
         <label for="meetEventGender">组别</label>
         <select id="meetEventGender" class="meet-search" aria-label="项目组别">
           <option value="both">男子组 + 女子组</option>
           <option value="male">仅男子组</option>
           <option value="female">仅女子组</option>
         </select>
       </div>
     </div>
     <label for="meetEventRelay" style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:14px;">
       <input id="meetEventRelay" type="checkbox"> 团队接力项目（每队 ${RELAY_TEAM_SIZE} 人，每班每组别限 1 队）
     </label>
     <p class="meet-upload-hint" style="margin-top:10px;">
       新增的项目会自动写进「导出报名模板（Excel）」的下拉选项与校验规则，导入时也能正常识别；系统内置的 14 个项目始终保留。
     </p>
     <div id="meetEventList" style="margin-top:16px;"></div>
     <div style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px;">
       <label for="meetGradeRestrictSwitch" style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;">
         <input id="meetGradeRestrictSwitch" type="checkbox" onchange="toggleMeetGradeRestriction(this.checked)">
         按年级限制项目（默认不勾选 = 所有年级都能报所有项目）
       </label>
       <p class="meet-upload-hint" style="margin-top:6px;">
         不勾选时，导出的模板对任何年级都输出全部项目（14 个内置 + 自定义）；勾选后才按下面的年级范围预填。
       </p>
       <div id="meetGradeMatrix"></div>
       <div class="meet-toolbar-actions" style="margin-top:10px;">
         <button class="btn btn-secondary" onclick="saveMeetGradeRestriction()">保存年级限制</button>
       </div>
     </div>`,
    `<button class="btn btn-secondary" onclick="closeModal(this)">关闭</button>
     <button class="btn btn-primary" onclick="submitMeetEvent()">添加项目</button>`,
  );
  renderMeetEventManagerList();
  renderMeetGradeRestriction();
  document.getElementById('meetEventName')?.focus();
}

/* ---------------- 年级限制（可选配置，默认关闭） ---------------- */

const MEET_GRADE_OPTIONS = [1, 2, 3, 4, 5, 6];

/** 渲染「项目 × 年级」勾选表；只有开启限制后才显示 */
function renderMeetGradeRestriction() {
  const container = document.getElementById('meetGradeMatrix');
  const switchInput = document.getElementById('meetGradeRestrictSwitch');
  if (!container || typeof getMeetTemplateConfig !== 'function') return;
  const config = getMeetTemplateConfig();
  if (switchInput) switchInput.checked = config.restrictByGrade === true;
  if (config.restrictByGrade !== true) {
    container.innerHTML = '';
    return;
  }
  const events = typeof getTemplateEventOptions === 'function' ? getTemplateEventOptions() : [];
  const savedGrades = event => config.eventGrades?.[event.name]
    || (Array.isArray(event.grades) && event.grades.length ? event.grades : MEET_GRADE_OPTIONS);
  container.innerHTML = `
    <div class="meet-class-meta" style="margin:10px 0 6px;">勾选每个项目允许的年级，未勾选的年级不会出现在导出模板里。</div>
    <div class="meet-table-wrap">
      <table class="meet-table">
        <thead><tr><th>项目</th>${MEET_GRADE_OPTIONS.map(grade => `<th style="width:56px;text-align:center;">${grade}年级</th>`).join('')}</tr></thead>
        <tbody>${events.map((event, index) => {
          const allowed = savedGrades(event);
          return `<tr>
            <td>${escapeHTML(event.name)}</td>
            ${MEET_GRADE_OPTIONS.map(grade => `<td style="text-align:center;">
              <input class="meet-checkbox" type="checkbox" id="meetGradeCell_${index}_${grade}"
                aria-label="${escapeHTML(event.name)} ${grade}年级"
                ${allowed.includes(grade) ? 'checked' : ''}>
            </td>`).join('')}
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

/** 勾选/取消「按年级限制项目」总开关 */
function toggleMeetGradeRestriction(checked) {
  if (typeof saveMeetTemplateConfig !== 'function') return;
  saveMeetTemplateConfig({ restrictByGrade: checked === true });
  renderMeetGradeRestriction();
  showToast(checked
    ? '已开启年级限制：导出模板只会输出各项目勾选的年级'
    : '已关闭年级限制：所有年级都能报全部项目');
}

/** 保存「项目 × 年级」勾选结果 */
function saveMeetGradeRestriction() {
  if (typeof saveMeetTemplateConfig !== 'function' || typeof getTemplateEventOptions !== 'function') return;
  const eventGrades = {};
  getTemplateEventOptions().forEach((event, index) => {
    eventGrades[event.name] = MEET_GRADE_OPTIONS
      .filter(grade => document.getElementById(`meetGradeCell_${index}_${grade}`)?.checked === true);
  });
  saveMeetTemplateConfig({ eventGrades });
  showToast('年级限制已保存，下次导出报名模板时生效');
}

/** 渲染弹窗里的自定义项目列表 */
function renderMeetEventManagerList() {
  const container = document.getElementById('meetEventList');
  if (!container) return;
  const events = getCustomMeetEvents();
  if (!events.length) {
    container.innerHTML = '<div class="meet-empty">还没有自定义项目，系统内置的 14 个项目始终可用。</div>';
    return;
  }
  const genderText = event => (event.gender === 'male' ? '仅男子组'
    : event.gender === 'female' ? '仅女子组' : '男子组 + 女子组');
  container.innerHTML = `
    <div style="font-size:13px;font-weight:600;margin-bottom:8px;">已添加 ${events.length} 个自定义项目</div>
    <div class="meet-table-wrap">
      <table class="meet-table">
        <thead><tr><th>项目名称</th><th>组别</th><th>类型</th><th style="width:72px;">操作</th></tr></thead>
        <tbody>${events.map(event => `
          <tr>
            <td>${escapeHTML(event.name)}</td>
            <td>${genderText(event)}</td>
            <td>${event.relay ? '团队接力' : '单项'}</td>
            <td><button class="btn btn-danger" style="padding:4px 10px;font-size:12px;"
                    onclick="removeManagedMeetEvent('${String(event.id).replace(/[^A-Za-z0-9_-]/g, '')}')">删除</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

/** 弹窗里点【添加项目】 */
function submitMeetEvent() {
  const nameInput = document.getElementById('meetEventName');
  if (!nameInput) return;
  const result = addCustomMeetEvent({
    name: nameInput.value,
    gender: document.getElementById('meetEventGender')?.value || 'both',
    relay: document.getElementById('meetEventRelay')?.checked === true,
  });
  if (!result.ok) {
    showToast(result.reason || '添加失败', 'error');
    nameInput.focus();
    return;
  }
  nameInput.value = '';
  const relayInput = document.getElementById('meetEventRelay');
  if (relayInput) relayInput.checked = false;
  renderMeetEventManagerList();
  const cloudHint = Store.cloudState === 'on'
    ? '已保存到云端'
    : '已保存（云端未连接，先存本地，恢复后自动同步）';
  showToast(`已添加项目「${result.event.name}」，${cloudHint}`);
  nameInput.focus();
}

/** 删除一条自定义项目 */
function removeManagedMeetEvent(id) {
  const events = removeCustomMeetEvent(id);
  renderMeetEventManagerList();
  showToast(`已删除项目，当前自定义项目 ${events.length} 个`);
}

// 脚本加载即自检：模板模块缺失时在控制台提前报警，避免按钮点了没反应还查不出原因
if (typeof downloadRegistrationTemplateExcel !== 'function') {
  console.error('[报名] js/registration-template.js 未加载：导出报名模板按钮将不可用，请强制刷新页面（Cmd+Shift+R）');
}

function downloadRegistrationTemplate() {
  const rows = [
    ['姓名', '班级', '年级', '性别', '报名项目'],
    ['张同学', '1班', '五年级', '男', '50米、立定跳远'],
  ];
  const csv = '\uFEFF' + rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = '运动会报名模板.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------------- 全校报名总览看板 ---------------- */

/** 学生库里的全校班级名（如“五年级1班”） */
function getSchoolClassNames() {
  const names = new Set();
  const students = Store.read('pe_students', []) || [];
  if (Array.isArray(students)) {
    students.forEach(student => {
      if (!student) return;
      const full = `${String(student.grade ?? '').trim()}${String(student.class ?? '').trim()}`;
      if (full.trim()) names.add(full);
    });
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

/** 按班级汇总：人数、单项人次、接力队数 */
function buildClassSummaries() {
  const athleteById = new Map(pageData.athletes.map(athlete => [athlete.id, athlete]));
  const byClass = new Map();
  pageData.registrations.forEach(registration => {
    const athlete = athleteById.get(registration.athleteId);
    if (!athlete) return;
    const className = String(athlete.className ?? '').trim();
    if (!className) return;
    let item = byClass.get(className);
    if (!item) {
      item = { className, grade: athlete.grade, athleteIds: new Set(), individualCount: 0, relayTeams: new Set() };
      byClass.set(className, item);
    }
    item.athleteIds.add(athlete.id);
    if (registrationIsTeamEvent(registration)) {
      item.relayTeams.add(`${registration.eventName}|${registration.genderGroup}`);
    } else {
      item.individualCount += 1;
    }
  });
  return [...byClass.values()]
    .map(item => ({
      className: item.className,
      grade: item.grade,
      athleteCount: item.athleteIds.size,
      individualCount: item.individualCount,
      relayCount: item.relayTeams.size,
    }))
    .sort((a, b) => String(a.className).localeCompare(String(b.className), 'zh-CN', { numeric: true }));
}

function countRelayTeams() {
  const athleteById = new Map(pageData.athletes.map(athlete => [athlete.id, athlete]));
  const teams = new Set();
  pageData.registrations.filter(registration => registrationIsTeamEvent(registration)).forEach(registration => {
    const athlete = athleteById.get(registration.athleteId);
    teams.add(`${athlete?.className ?? ''}|${registration.eventName}|${registration.genderGroup}`);
  });
  return teams.size;
}

function renderOverview() {
  const summaries = buildClassSummaries();
  const submitted = new Set(summaries.map(item => item.className));
  const schoolClasses = getSchoolClassNames();
  const pending = schoolClasses.filter(name => !submitted.has(name));
  const totalClasses = Math.max(schoolClasses.length, submitted.size);

  const stats = document.getElementById('overviewStats');
  if (stats) {
    stats.innerHTML = `
      <div class="meet-stat-mini"><h4>${totalClasses}</h4><p>全校班级数${schoolClasses.length ? '' : '（按已提交班级计）'}</p></div>
      <div class="meet-stat-mini"><h4>${submitted.size}</h4><p>已提交班级</p></div>
      <div class="meet-stat-mini"><h4>${pending.length}</h4><p>待提交班级</p></div>
      <div class="meet-stat-mini"><h4>${pageData.athletes.length}</h4><p>报名总人数</p></div>
      <div class="meet-stat-mini"><h4>${pageData.registrations.filter(registration => !registrationIsTeamEvent(registration)).length}</h4><p>单项人次</p></div>
      <div class="meet-stat-mini"><h4>${countRelayTeams()}</h4><p>接力队数</p></div>
    `;
  }
  renderClassBoard(summaries, pending);
  renderGlobalSearch();
}

function renderClassBoard(summaries, pending = []) {
  const board = document.getElementById('classBoard');
  if (!board) return;
  if (!summaries.length && !pending.length) {
    board.innerHTML = '<div class="meet-empty">还没有班级提交报名；导入报名表后这里会按班级展示进度。</div>';
    return;
  }
  board.innerHTML = [
    ...summaries.map(item => `
      <div class="meet-class-card">
        <div class="meet-class-title">
          <span>${escapeHTML(item.className)}</span>
          <span class="meet-badge done">已提交</span>
        </div>
        <div class="meet-class-meta">${item.athleteCount} 名学生 · 单项 ${item.individualCount} 人次 · 接力 ${item.relayCount} 队</div>
        <div class="meet-class-actions">
          <button class="btn btn-primary" onclick="openClassDetail('${escapeHTML(item.className)}')">查看详情</button>
          <button class="btn btn-danger" onclick="revokeClassRegistrations('${escapeHTML(item.className)}')">撤销该班报名</button>
        </div>
      </div>`),
    ...pending.map(name => `
      <div class="meet-class-card pending">
        <div class="meet-class-title">
          <span>${escapeHTML(name)}</span>
          <span class="meet-badge pending">未提交</span>
        </div>
        <div class="meet-class-meta">学生库里有该班，但还没有报名数据</div>
      </div>`),
  ].join('');
}

/** 项目在模板里的先后顺序（内置 + 自定义），网格行按它排序 */
function templateEventOrder() {
  const names = typeof getTemplateEventOptions === 'function'
    ? getTemplateEventOptions().map(event => String(event?.name ?? '').trim().toLowerCase())
    : [];
  return new Map(names.map((name, index) => [name, index]));
}

/** 某班的「项目 × 男子/女子」网格数据 */
function buildClassEventGrid(className) {
  const target = String(className ?? '').trim();
  const athletes = pageData.athletes.filter(athlete => String(athlete.className ?? '').trim() === target);
  if (!athletes.length) return null;
  const athleteById = new Map(athletes.map(athlete => [athlete.id, athlete]));
  const rows = new Map();

  pageData.registrations.forEach(registration => {
    const athlete = athleteById.get(registration.athleteId);
    if (!athlete) return;
    const gender = registration.genderGroup || athlete.gender;
    let row = rows.get(registration.eventName);
    if (!row) {
      row = {
        eventName: registration.eventName,
        relay: registrationIsTeamEvent(registration),
        male: [],
        female: [],
      };
      rows.set(registration.eventName, row);
    }
    row[gender === 'male' ? 'male' : 'female'].push(athlete);
  });

  const order = templateEventOrder();
  const sorted = [...rows.values()].sort((a, b) => {
    if (a.relay !== b.relay) return a.relay ? 1 : -1;
    const indexA = order.get(a.eventName.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const indexB = order.get(b.eventName.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    if (indexA !== indexB) return indexA - indexB;
    return String(a.eventName).localeCompare(String(b.eventName), 'zh-CN');
  });
  return { className: target, athletes, rows: sorted };
}

function renderGridCell(list, relay) {
  if (!list || !list.length) return '<span class="meet-grid-empty">—</span>';
  // 接力超过正式队员人数（4 人）的部分视为替补，用浅蓝色区分
  const relaySize = typeof RELAY_TEAM_SIZE === 'number' ? RELAY_TEAM_SIZE : 4;
  // 接力必须保持表格里的填报顺序（前 4 名正式、后面是替补），单项无所谓顺序，按姓名排好看
  const ordered = relay ? list.slice() : list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  return ordered
    .map((athlete, index) => {
      const isSub = relay && index >= relaySize;
      return `<span class="meet-grid-name${isSub ? ' sub' : ''}">${escapeHTML(athlete.name)}${athlete.bibNumber ? ` · ${escapeHTML(athlete.bibNumber)}` : ''}</span>`;
    }).join('');
}

/** 【查看详情】：用网格模式展示该班男女各项目的报名情况 */
function openClassDetail(className) {
  const grid = buildClassEventGrid(className);
  if (!grid) {
    showToast('该班级暂无报名数据', 'info');
    return;
  }
  const summary = buildClassSummaries().find(item => item.className === grid.className) || {};
  const rowsHTML = grid.rows.map(row => `
    <tr>
      <td class="meet-grid-event">${escapeHTML(row.eventName)}${row.relay ? ' <span class="meet-badge pending">接力</span>' : ''}</td>
      <td>${renderGridCell(row.male, row.relay)}</td>
      <td>${renderGridCell(row.female, row.relay)}</td>
    </tr>`).join('');
  showModal(
    `${grid.className} · 报名详情`,
    `<div class="meet-class-meta" style="margin-bottom:10px;">共 ${grid.athletes.length} 名学生 · 单项 ${summary.individualCount || 0} 人次 · 接力 ${summary.relayCount || 0} 队</div>
     <div class="meet-table-wrap">
       <table class="meet-grid-table">
         <thead><tr><th style="width:150px;">项目</th><th>男子组</th><th>女子组</th></tr></thead>
         <tbody>${rowsHTML}</tbody>
       </table>
     </div>
     <p class="meet-upload-hint" style="margin-top:10px;">行 = 项目，列 = 组别；接力超过 ${typeof RELAY_TEAM_SIZE === 'number' ? RELAY_TEAM_SIZE : 4} 人的部分（浅蓝）为替补。</p>`,
    `<button class="btn btn-secondary" onclick="closeModal(this)">关闭</button>
     <button class="btn btn-danger" onclick="revokeClassRegistrations('${escapeHTML(grid.className)}')">撤销该班报名</button>`,
  );
}

/** 【撤销该班级报名】：删除该班全部运动员与报名，便于重新上传 */
async function revokeClassRegistrations(className) {
  const target = String(className ?? '').trim();
  const affected = pageData.athletes.filter(athlete => String(athlete.className ?? '').trim() === target);
  if (!affected.length) {
    showToast('该班级没有报名数据', 'error');
    return;
  }
  const confirmed = window.confirm(
    `确定撤销「${target}」的全部报名吗？将删除该班 ${affected.length} 名运动员及其所有项目，之后可重新上传。`,
  );
  if (!confirmed) return;

  const ids = new Set(affected.map(athlete => athlete.id));
  const athletes = pageData.athletes.filter(athlete => !ids.has(athlete.id));
  const registrations = pageData.registrations.filter(registration => !ids.has(registration.athleteId));
  assignBibNumbers(athletes); // 号码重新连号，避免撤销后留下空号
  const updatedData = {
    ...pageData,
    athletes,
    registrations,
    heats: generatePreliminaryHeats(athletes, registrations, laneCount),
    schedule: null,
    results: [],
  };
  if (!(await saveMeetData(updatedData, { force: true }))) return;   // 撤销班级：可能删空
  const closeButton = document.querySelector?.('.modal-close');
  if (closeButton && typeof closeModal === 'function') closeModal(closeButton);
  selectedAthleteIds.clear();
  currentPage = 1;
  showToast(`已撤销「${target}」的报名（${affected.length} 人），可重新上传`);
}

/** 全局搜索：输入姓名反查班级与项目 */
function handleGlobalSearchChange(event) {
  globalSearchQuery = String(event?.target?.value ?? '');
  renderGlobalSearch();
}

function renderGlobalSearch() {
  const container = document.getElementById('globalSearchResult');
  if (!container) return;
  const keyword = globalSearchQuery.trim();
  if (!keyword) {
    container.innerHTML = '';
    return;
  }
  const query = keyword.toLowerCase();
  const registrationsByAthlete = new Map();
  pageData.registrations.forEach(registration => {
    const list = registrationsByAthlete.get(registration.athleteId) || [];
    list.push(registration);
    registrationsByAthlete.set(registration.athleteId, list);
  });

  const matches = pageData.athletes.filter(athlete => {
    const events = (registrationsByAthlete.get(athlete.id) || []).map(registration => registration.eventName);
    return [athlete.name, athlete.className, athlete.bibNumber, ...events]
      .some(value => String(value ?? '').toLowerCase().includes(query));
  }).sort((a, b) => String(a.className).localeCompare(String(b.className), 'zh-CN', { numeric: true })
    || String(a.name).localeCompare(String(b.name), 'zh-CN'));

  if (!matches.length) {
    container.innerHTML = `<div class="meet-empty">没有找到与“${escapeHTML(keyword)}”相关的学生。</div>`;
    return;
  }

  const shown = matches.slice(0, 30);
  container.innerHTML = `
    <div class="meet-class-meta" style="margin-bottom:8px;">找到 ${matches.length} 名学生${matches.length > shown.length ? `，显示前 ${shown.length} 条` : ''}</div>
    <div class="meet-table-wrap">
      <table class="meet-table">
        <thead><tr><th>姓名</th><th>班级</th><th>性别</th><th>参赛号码</th><th>报名项目</th></tr></thead>
        <tbody>${shown.map(athlete => {
          const entries = registrationsByAthlete.get(athlete.id) || [];
          return `<tr>
            <td>${escapeHTML(athlete.name)}</td>
            <td>${escapeHTML(athlete.className)}</td>
            <td>${athlete.gender === 'male' ? '男' : '女'}</td>
            <td class="meet-bib">${escapeHTML(athlete.bibNumber || '—')}</td>
            <td class="meet-events">${entries.length
              ? entries.map(registration => `<span class="meet-event-tag ${registrationIsTeamEvent(registration) ? 'team' : ''}">${escapeHTML(registration.eventName)}</span>`).join('')
              : '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

function renderAthletes() {
  const query = searchQuery.trim().toLowerCase();
  const athleteById = new Map(pageData.athletes.map(athlete => [athlete.id, athlete]));
  const registrationsByAthlete = new Map();
  pageData.registrations.forEach(registration => {
    const list = registrationsByAthlete.get(registration.athleteId) || [];
    list.push(registration);
    registrationsByAthlete.set(registration.athleteId, list);
  });

  const filtered = pageData.athletes.filter(athlete => {
    const terms = [athlete.name, athlete.className, athlete.grade, athlete.gender, athlete.bibNumber,
      ...(registrationsByAthlete.get(athlete.id) || []).map(registration => registration.eventName)];
    return terms.some(value => String(value).toLowerCase().includes(query));
  }).sort((a, b) => Number(a.bibNumber) - Number(b.bibNumber));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pageCount);
  const pageAthletes = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const visibleIds = new Set(pageAthletes.map(athlete => athlete.id));
  selectedAthleteIds.forEach(id => {
    if (!athleteById.has(id)) selectedAthleteIds.delete(id);
  });
  const table = document.getElementById('athleteTable');

  if (!pageAthletes.length) {
    table.innerHTML = `<div class="meet-empty">${query ? '没有符合条件的报名记录' : '暂无报名数据，请导入 CSV 或 Excel 报名表。'}</div>`;
  } else {
    const selectedOnPage = pageAthletes.filter(athlete => selectedAthleteIds.has(athlete.id)).length;
    table.innerHTML = `
      <table class="meet-table">
        <thead><tr>
          <th class="meet-checkbox-cell">
            <input class="meet-checkbox" id="selectCurrentPage" type="checkbox"
              aria-label="全选或取消全选本页运动员"
              ${pageAthletes.length > 0 && selectedOnPage === pageAthletes.length ? 'checked' : ''}
              onchange="toggleCurrentPageSelection(this.checked)">
          </th>
          <th>参赛号码</th><th>姓名</th><th>班级</th><th>年级</th><th>性别</th><th>报名项目</th>
        </tr></thead>
        <tbody>${pageAthletes.map(athlete => {
          const entries = registrationsByAthlete.get(athlete.id) || [];
          return `<tr>
            <td class="meet-checkbox-cell">
              <input class="meet-checkbox" type="checkbox" aria-label="选择${escapeHTML(athlete.name)}"
                data-athlete-id="${escapeHTML(athlete.id)}"
                ${selectedAthleteIds.has(athlete.id) ? 'checked' : ''}
                onchange="toggleAthleteSelection('${escapeHTML(athlete.id)}', this.checked)">
            </td>
            <td class="meet-bib">${escapeHTML(athlete.bibNumber || '—')}</td>
            <td>${escapeHTML(athlete.name)}</td>
            <td>${escapeHTML(athlete.className)}</td>
            <td>${athlete.grade} 年级</td>
            <td>${athlete.gender === 'male' ? '男' : '女'}</td>
            <td class="meet-events">${entries.length ? entries.map(registration => `<span class="meet-event-tag ${registrationIsTeamEvent(registration) ? 'team' : ''}">${escapeHTML(registration.eventName)}${registrationIsTeamEvent(registration) ? ' · 团体' : ''}</span>`).join('') : '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    `;
    const selectAll = document.getElementById('selectCurrentPage');
    selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageAthletes.length;
  }

  updateBulkSelectionControls(visibleIds);
  document.getElementById('athletePagination').innerHTML = `
    <span>共 ${filtered.length} 名 · 第 ${currentPage}/${pageCount} 页</span>
    <button class="btn btn-secondary btn-sm" onclick="changePage(-1)" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="btn btn-secondary btn-sm" onclick="changePage(1)" ${currentPage >= pageCount ? 'disabled' : ''}>下一页</button>
  `;
}

function updateBulkSelectionControls(visibleIds = new Set()) {
  const selectedCount = selectedAthleteIds.size;
  document.getElementById('selectionSummary').textContent = `已选 ${selectedCount} 条`;
  document.getElementById('deleteSelectedButton').disabled = selectedCount === 0;
  document.getElementById('clearAllButton').disabled = pageData.athletes.length === 0;

  const selectAll = document.getElementById('selectCurrentPage');
  if (selectAll && visibleIds.size === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  }
}

function toggleAthleteSelection(id, checked) {
  if (checked) selectedAthleteIds.add(id);
  else selectedAthleteIds.delete(id);
  renderAthletes();
}

function toggleCurrentPageSelection(checked) {
  const currentRows = [...document.querySelectorAll('#athleteTable tbody input.meet-checkbox')];
  currentRows.forEach(checkbox => {
    const id = checkbox.dataset.athleteId;
    if (!id) return;
    if (checked) selectedAthleteIds.add(id);
    else selectedAthleteIds.delete(id);
  });
  renderAthletes();
}

async function deleteSelectedAthletes() {
  const selectedIds = new Set([...selectedAthleteIds].filter(id =>
    pageData.athletes.some(athlete => athlete.id === id),
  ));
  const count = selectedIds.size;
  if (!count) {
    showToast('请先选择要删除的报名数据', 'error');
    return;
  }

  const confirmed = window.confirm(
    `确定要删除选中的 ${count} 条报名数据（${count} 名运动员及其全部项目）吗？此操作不可恢复。`,
  );
  if (!confirmed) return;

  const athleteIds = new Set(pageData.athletes
    .filter(athlete => selectedIds.has(athlete.id))
    .map(athlete => athlete.id));
  const updatedData = {
    ...pageData,
    athletes: pageData.athletes.filter(athlete => !athleteIds.has(athlete.id)),
    registrations: pageData.registrations.filter(registration => !athleteIds.has(registration.athleteId)),
    schedule: null,
    results: [],
    heats: pageData.heats
      .map(heat => ({ ...heat, entries: heat.entries.filter(entry => !athleteIds.has(entry.athleteId)) }))
      .filter(heat => heat.entries.length > 0),
  };

  if (!(await saveMeetData(updatedData, { force: true }))) return;   // 删除选中：可能删空
  selectedAthleteIds.clear();
  renderAthletes();
  showToast(`已删除 ${count} 条报名数据`);
}

function clearAllRegistrations() {
  if (!pageData.athletes.length && !pageData.registrations.length && !pageData.heats.length) {
    showToast('当前没有可清空的报名数据', 'info');
    return;
  }

  showModal(
    '确认清空全部报名',
    `<p>此操作将删除全部运动员报名、参赛项目及预赛分组，且不可恢复。</p>
     <label for="clearConfirmation" style="display:block;margin-top:14px;font-size:14px;font-weight:600;">请输入 DELETE 以确认</label>
     <input id="clearConfirmation" type="text" autocomplete="off" class="meet-search" style="margin-top:8px;" aria-label="输入 DELETE 确认清空">`,
    `<button class="btn btn-secondary" onclick="closeModal(this)">取消</button>
     <button class="btn btn-danger" onclick="confirmClearAllRegistrations()">确认清空</button>`,
  );
  document.getElementById('clearConfirmation').focus();
}

async function confirmClearAllRegistrations() {
  const confirmation = document.getElementById('clearConfirmation')?.value;
  if (confirmation !== 'DELETE') {
    showToast('请输入 DELETE 确认清空', 'error');
    document.getElementById('clearConfirmation')?.focus();
    return;
  }

  const count = pageData.athletes.length;
  const updatedData = { ...emptyMeetData(), laneCount, schedule: null };
  if (!(await saveMeetData(updatedData, { force: true }))) return;   // 清空全部：就是要写空
  closeModal(document.querySelector('.modal-close'));
  selectedAthleteIds.clear();
  currentPage = 1;
  renderAthletes();
  showToast(`已清空全部报名（${count} 名运动员）`);
}

function changePage(delta) {
  currentPage += delta;
  renderAthletes();
}

function renderHeats() {
  const athleteById = new Map(pageData.athletes.map(athlete => [athlete.id, athlete]));
  const list = document.getElementById('heatList');
  const guidance = document.getElementById('heatGuidance');
  // 组数 = ⌈人数 / 跑道数⌉，跑道数变化时自动重新切分（选 4 道就每 4 人一组）
  const undersized = pageData.heats.filter(heat => heat.entries.length < laneCount);
  guidance.textContent = undersized.length
    ? `提示：${undersized.length} 个预赛组不足 ${laneCount} 人；受报名人数和跑道数限制，已尽量均衡分组且未超过 ${laneCount} 道。`
    : `每组人数不超过跑道数（当前 ${laneCount} 道）；同班运动员尽量分散在不同小组和非相邻道次。`;

  if (!pageData.heats.length) {
    list.innerHTML = '<div class="meet-empty">径赛报名人数超过跑道数后，将自动生成预赛分组。</div>';
    return;
  }

  list.innerHTML = pageData.heats.map(heat => `
    <section class="meet-heat-card">
      <div class="meet-heat-title">${escapeHTML(heat.eventName)} · ${heat.genderGroup === 'male' ? '男子组' : '女子组'} · 预赛第 ${heat.groupNumber} 组</div>
      <div class="meet-table-wrap">
        <table class="meet-table">
          <thead><tr><th>道次</th><th>参赛号码</th><th>姓名</th><th>班级</th></tr></thead>
          <tbody>${heat.entries.map(entry => {
            const athlete = athleteById.get(entry.athleteId);
            if (!athlete) return '';
            return `<tr><td>${entry.lane} 道</td><td class="meet-bib">${escapeHTML(entry.bibNumber)}</td><td>${escapeHTML(athlete.name)}</td><td>${escapeHTML(athlete.className)}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </section>
  `).join('');
}

function renderPage() {
  selectedAthleteIds.forEach(id => {
    if (!pageData.athletes.some(athlete => athlete.id === id)) selectedAthleteIds.delete(id);
  });
  document.getElementById('athleteCount').textContent = pageData.athletes.length;
  document.getElementById('registrationCount').textContent = pageData.registrations.filter(registration => !registrationIsTeamEvent(registration)).length;
  document.getElementById('heatCount').textContent = pageData.heats.length;
  renderOverview();
  renderAthletes();
  renderHeats();
}

async function regenerateHeats() {
  const nextLaneCount = Number(document.getElementById('laneCount').value);
  if (!LANE_COUNT_OPTIONS.includes(nextLaneCount)) {
    showToast(`跑道数必须为 ${LANE_COUNT_OPTIONS.join('、')} 道`, 'error');
    return;
  }
  laneCount = nextLaneCount;
  const data = {
    ...pageData,
    laneCount,
    schedule: null,
    heats: generatePreliminaryHeats(pageData.athletes, pageData.registrations, laneCount),
  };
  if (await saveMeetData(data)) showToast('径赛预赛分组已重新随机生成');
}

function handleSearchChange(event) {
  searchQuery = event.target.value;
  currentPage = 1;
  renderAthletes();
}

function initializePage() {
  document.getElementById('registrationFile').addEventListener('change', handleRegistrationFile);
  document.getElementById('athleteSearch').addEventListener('input', handleSearchChange);
  document.getElementById('globalStudentSearch').addEventListener('input', handleGlobalSearchChange);
  document.getElementById('laneCount').addEventListener('change', event => {
    laneCount = Number(event.target.value);
  });
  document.getElementById('laneCount').value = String(laneCount);
  renderPage();
  renderStorageAlert();
}

Store.onReady(() => {
  initializePage();
  bindCrossModuleMeetSync();
});

/**
 * 跨模块同步：赛程页 / 其它页面改了同一个 Key（比如生成了赛程），本页内存里的
 * pageData 就过期了 —— 下次保存会拿旧快照整体写回，把别人的改动（赛程）冲掉。
 * 收到通知就重取；用户正在输入或正在确认导入时不打断，避免把人家打到一半的内容刷掉。
 */
function bindCrossModuleMeetSync() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const isBusy = () => {
    if (pendingImport) return true;
    const active = document.activeElement;
    return Boolean(active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
  };
  const applyLatest = () => {
    const latest = Store.read(STORAGE_KEY, null);
    if (!latest || !Array.isArray(latest.athletes)) return;
    /* ⛔ 反向清空防线：对方此刻读到的是空值（多半是它还在初始化），
       而本页有报名数据 —— 绝不接受，否则等于让它把数据清掉。 */
    if (!latest.athletes.length && !latest.registrations?.length
      && (pageData?.athletes?.length || pageData?.registrations?.length)) {
      console.warn('[报名管理] 忽略其它页面传来的空报名数据，保留本地现有数据');
      return;
    }
    pageData = {
      ...emptyMeetData(),
      ...latest,
      registrations: latest.registrations.map(registration => ({
        ...registration,
        isTeamEvent: registrationIsTeamEvent(registration),
      })),
    };
    renderPage();
    renderStorageAlert();
  };
  const refresh = () => {
    if (isBusy()) return;
    applyLatest();
  };
  window.addEventListener('store:sync', event => {
    if (event?.detail?.changed?.includes?.(STORAGE_KEY)) refresh();
  });
  window.addEventListener('storage', event => {
    if (event?.key === STORAGE_KEY) refresh();
  });
  /* 🚨 控制台 window.forceRecover() 的强行恢复事件：无条件重取重画，
     不走"输入中不打断"的判断 —— 老师要的是"敲完立刻看到 216 条"。 */
  window.addEventListener('store:recovered', applyLatest);
}
