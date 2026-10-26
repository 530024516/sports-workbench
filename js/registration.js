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

let storageError = '';
let pageData = loadMeetData();
let pendingImport = null;
let currentPage = 1;
let searchQuery = '';
let laneCount = 8;
const selectedAthleteIds = new Set();
if ([6, 7, 8].includes(pageData.laneCount)) laneCount = pageData.laneCount;

const pageContent = document.getElementById('page-content');
pageContent.innerHTML = `
  <div class="card" style="margin-bottom:20px;">
    <div class="card-header">
      <div>
        <div class="card-title"><span>🏅</span> 报名管理</div>
        <div class="card-subtitle">批量导入报名表，校验资格并生成径赛预赛分组</div>
      </div>
      <div class="meet-toolbar-actions">
        <button class="btn btn-secondary" onclick="downloadRegistrationTemplate()">下载 CSV 模板</button>
      </div>
    </div>
    <div class="card-body">
      <div class="meet-upload">
        <input id="registrationFile" type="file" accept=".csv,.xlsx,.xls" aria-label="选择 Excel 或 CSV 报名文件">
        <span class="meet-upload-hint">需要列：姓名、班级、年级、性别、报名项目；多个项目可用顿号或逗号分隔。保存时会合并已有名单并按年级、班级重新编号。</span>
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
            <option value="6">6 道</option>
            <option value="7">7 道</option>
            <option value="8" selected>8 道</option>
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
  return { athletes: [], registrations: [], heats: [], laneCount: 8 };
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

function saveMeetData(data) {
  try {
    Store.write(STORAGE_KEY, data);
    pageData = data;
    storageError = '';
    renderPage();
    renderStorageAlert();
    return true;
  } catch (error) {
    showValidationErrors([`保存失败：${error.message}`]);
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

function getHeaderIndexes(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const indexes = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    indexes[field] = normalized.findIndex(header => aliases.some(alias => normalizeHeader(alias) === header));
  }
  const missing = Object.entries(indexes).filter(([, index]) => index < 0).map(([field]) => ({
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

function registrationIsTeamEvent(registration) {
  return registration.isTeamEvent === true ||
    registration.isTeam === true ||
    eventIsTeam(registration.eventName);
}

function eventIsTrack(name) {
  return /(?:\d+\s*(?:米|m)\s*(?:跑)?|接力|跨栏|跑步)/i.test(name);
}

function eventKey(name, gender) {
  return `${name.trim().toLowerCase()}|${gender}`;
}

function parseRegistrationRows(rows) {
  if (rows.length < 2) throw new Error('文件中没有报名数据行');
  const indexes = getHeaderIndexes(rows[0]);
  const imported = new Map();
  const genderByStudent = new Map();
  const errors = [];

  rows.slice(1).forEach((row, rowIndex) => {
    const lineNumber = rowIndex + 2;
    const athlete = {
      name: String(row[indexes.name] ?? '').trim(),
      className: String(row[indexes.className] ?? '').trim(),
      grade: parseGrade(row[indexes.grade]),
      gender: parseGender(row[indexes.gender]),
    };
    const events = splitEventNames(row[indexes.events]);
    if (!athlete.name || !athlete.className || !athlete.grade || !athlete.gender || events.length === 0) {
      errors.push(`第 ${lineNumber} 行：姓名、班级、1-6年级、有效性别和报名项目均为必填项`);
      return;
    }

    const baseKey = athleteKey(athlete);
    const oldGender = genderByStudent.get(baseKey);
    if (oldGender && oldGender !== athlete.gender) {
      errors.push(`第 ${lineNumber} 行：${athlete.name} 的性别与同名同班记录不一致`);
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
  });

  return { athletes: [...imported.values()], errors };
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
      const exceeded = [];
      if (counts.individual.size > 2) exceeded.push(`当前单项${counts.individual.size}项`);
      if (counts.team.size > 1) exceeded.push(`当前团队项目${counts.team.size}项`);
      return `${athlete.name} 报名失败：单项最多2项，团队项目最多1项，${exceeded.join('，')}。`;
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
        isTeamEvent: eventIsTeam(eventName),
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
  const availableLanes = shuffle(Array.from({ length: laneTotal }, (_, index) => index + 1));
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

  const laneNumbers = shuffle(availableLanes).slice(0, athletes.length).sort((a, b) => a - b);
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

function renderImportPreview(parsed, errors, previewData) {
  const container = document.getElementById('importPreview');
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
    ${errors.length ? `<div class="meet-alert visible"><strong>本次导入未通过校验，不能保存：</strong><ul>${errors.map(error => `<li>${escapeHTML(error)}</li>`).join('')}</ul></div>` : ''}
    <div class="meet-preview-summary"><span>文件识别到 ${parsed.length} 名学生</span><span>${errors.length ? '请修正文件后重新导入' : '报名资格校验通过，可合并保存'}</span></div>
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

async function handleRegistrationFile(event) {
  clearValidationErrors();
  pendingImport = null;
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    if (storageError) throw new Error(storageError);
    const rows = await readFileRows(file);
    const parsedResult = parseRegistrationRows(rows);
    let errors = parsedResult.errors;
    let previewData = null;
    if (!errors.length) {
      const prepared = prepareImport(parsedResult.athletes);
      errors = prepared.errors;
      previewData = prepared.data;
    }
    renderImportPreview(parsedResult.athletes, errors, previewData);
  } catch (error) {
    pendingImport = null;
    document.getElementById('importPreview').innerHTML = '';
    showValidationErrors([error.message]);
  } finally {
    event.target.value = '';
  }
}

function commitImport() {
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
  if (!saveMeetData(pendingImport)) return;
  pendingImport = null;
  document.getElementById('importPreview').innerHTML = '';
  clearValidationErrors();
  showToast('报名数据已保存，参赛号码及径赛分组已更新');
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

function deleteSelectedAthletes() {
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

  if (!saveMeetData(updatedData)) return;
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

function confirmClearAllRegistrations() {
  const confirmation = document.getElementById('clearConfirmation')?.value;
  if (confirmation !== 'DELETE') {
    showToast('请输入 DELETE 确认清空', 'error');
    document.getElementById('clearConfirmation')?.focus();
    return;
  }

  const count = pageData.athletes.length;
  const updatedData = { ...emptyMeetData(), laneCount, schedule: null };
  if (!saveMeetData(updatedData)) return;
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
  const undersized = pageData.heats.filter(heat => heat.entries.length < 6);
  guidance.textContent = undersized.length
    ? `提示：${undersized.length} 个预赛组不足 6 人；受报名人数和跑道数限制，已尽量均衡分组且未超过 ${laneCount} 道。`
    : '每组人数不超过跑道数；同班运动员尽量分散在不同小组和非相邻道次。';

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
  renderAthletes();
  renderHeats();
}

function regenerateHeats() {
  const nextLaneCount = Number(document.getElementById('laneCount').value);
  if (![6, 7, 8].includes(nextLaneCount)) {
    showToast('跑道数必须为 6、7 或 8 道', 'error');
    return;
  }
  laneCount = nextLaneCount;
  const data = {
    ...pageData,
    laneCount,
    schedule: null,
    heats: generatePreliminaryHeats(pageData.athletes, pageData.registrations, laneCount),
  };
  if (saveMeetData(data)) showToast('径赛预赛分组已重新随机生成');
}

function handleSearchChange(event) {
  searchQuery = event.target.value;
  currentPage = 1;
  renderAthletes();
}

function initializePage() {
  document.getElementById('registrationFile').addEventListener('change', handleRegistrationFile);
  document.getElementById('athleteSearch').addEventListener('input', handleSearchChange);
  document.getElementById('laneCount').addEventListener('change', event => {
    laneCount = Number(event.target.value);
  });
  document.getElementById('laneCount').value = String(laneCount);
  renderPage();
  renderStorageAlert();
}

Store.ready.then(() => {
  initializePage();
});
