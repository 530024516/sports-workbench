'use strict';

Layout.init('schedule', '运动会赛程编排', '赛程编排');

const MEET_STORAGE_KEY = 'pe_sports_meet_v1';
// 可选跑道数与默认跑道数（与报名页「竞赛预分组」保持一致；4 道的小场地也支持）
const TRACK_LANE_OPTIONS = [4, 5, 6, 7, 8];
const DEFAULT_TRACK_LANES = 4;
const DEFAULT_CHECKIN_MINUTES = 15;

/* 长距离径赛的体能恢复保护：跑完 400 米及以上（400 / 800 / 1500…），
   这名学生至少休息这么久才允许排下一场（径赛或田赛都算）。老师可在编排设置里改。 */
const DEFAULT_LONG_RUN_RECOVERY_MINUTES = 60;
const LONG_RUN_MIN_METERS = 400;        // ≥400 米算长距离
const RECOVERY_MINUTES_MIN = 0;         // 0 = 关闭这项保护
const RECOVERY_MINUTES_MAX = 180;

/* 场地资源：200 米操场的真实家底 —— 跑道 1 条（4 道）、沙坑 1 个、立定跳远区（平地/垫子）1 块、
   投掷区 1 个、跳高区 1 个。每个场地各有一条独立时间轴 → 五块场地可以并行开赛；同一场地内串行。
   ⚠️ 沙坑 ≠ 立定跳远区：急行跳远要助跑+起跳板+沙坑，立定跳远只要一块平地/垫子，两者可以同时开。 */
const VENUE_RESOURCES = [
  { key: 'track', name: '跑道', icon: '🏃', tone: 'track', note: `${DEFAULT_TRACK_LANES} 条跑道` },
  { key: 'sandpit', name: '沙坑', icon: '🏖️', tone: 'sandpit', note: '急行跳远专用，串行' },
  { key: 'standingjump', name: '立定跳远区/平地', icon: '📏', tone: 'standingjump', note: '平地/垫子，与沙坑并行' },
  { key: 'throwing', name: '投掷区', icon: '🎯', tone: 'throwing', note: '全校仅 1 个，串行' },
  { key: 'highjump', name: '跳高区', icon: '🤸', tone: 'highjump', note: '全校仅 1 个，串行' },
];

// 比赛时段：所有赛程都锁在上午 / 下午里，绝不排到晚上
const DEFAULT_SESSIONS = [
  { key: 'morning', label: '上午', start: '08:30', end: '12:00' },
  { key: 'afternoon', label: '下午', start: '13:30', end: '17:00' },
];
/* 比赛总天数：整数 = 整天（上午+下午）；.5 = 最后一天只比半天（上午）。
   1 天 = 上午+下午；1.5 天 = 第一天全天 + 第二天上午；4 天 = 四天全天。
   项目多的时候可以一路加到 4 天，算法与甘特图 Tab 都按这个档位自动生成。 */
const DAY_TOTAL_OPTIONS = [1, 1.5, 2, 2.5, 3, 3.5, 4];
const DEFAULT_DAY_TOTAL = 2;
const DEFAULT_TRACK_DURATION = 12;   // 径赛每组约 10~15 分钟
const DEFAULT_FIELD_DURATION = 45;   // 田赛每项约 40~60 分钟

/* 项目赛制：小学运动会大多「一枪定胜负」，默认全部仅一次决赛；需要预决赛的再单独打开 */
const EVENT_FORMAT_OPTIONS = [
  { value: 'one-shot', label: '仅一次决赛（一枪制）' },
  { value: 'two-round', label: '预赛 + 决赛（两枪制）' },
];
const DEFAULT_EVENT_FORMAT = 'one-shot';

/**
 * 甘特图排版：严格「固定比例映射」
 *   top    = (开始时间 − 时间轴零点) 的分钟数 × GANTT_PX_PER_MINUTE
 *   height = 时长分钟数 × GANTT_PX_PER_MINUTE
 * 坐标只由真实时间换算，绝不为「文字好看」下推或拉伸卡片。
 */
const GANTT_PX_PER_MINUTE = 3;       // 比例尺：1 分钟 = 3px（08:30→17:00 共 510 分钟 = 1530px）
const GANTT_TICK_MINUTES = 30;       // 时间刻度间隔
const GANTT_MIN_BLOCK_HEIGHT = 4;    // 极短区块的可见性兜底（不参与排版，只保证还能看见/点得到）
const GANTT_FULL_BLOCK_HEIGHT = 62;  // ≥62px 才显示「时间 / 项目名 / 年级·组别·轮次」三行
/* 高度硬边界：一天最多按 16 小时（960 分钟 = 2880px）画，超出一律钳住，绝不无限撑高 */
const GANTT_MAX_MINUTES = 960;
const GANTT_MAX_HEIGHT = GANTT_MAX_MINUTES * GANTT_PX_PER_MINUTE;   // 2880px
const GANTT_MIN_HEIGHT = GANTT_TICK_MINUTES * GANTT_PX_PER_MINUTE;  // 90px
const GANTT_MAX_TICKS = Math.floor(GANTT_MAX_MINUTES / GANTT_TICK_MINUTES) + 1;  // 33 条

/** 数值兜底：NaN / Infinity 一律退回 fallback，并夹在 [min, max] 之间 */
function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;      // NaN（算错了）→ 兜底值
  if (num === Infinity) return max;            // 上溢 → 顶到上限
  if (num === -Infinity) return min;           // 下溢 → 顶到下限
  return Math.min(max, Math.max(min, num));
}

/** 只对合法时间做计算：非法 / NaN 的时间戳一律丢弃 */
function validTimes(list) {
  return list.filter(value => Number.isFinite(Number(value)));
}
let meetData;
let currentSchedule = [];
let unscheduledEvents = [];   // 设定时段内排不下的项目（宁可不排，也不排到晚上）
let fieldOrderMode = 'class';
let scheduleStorageError = '';
let scheduleGradeFilter = 'all';
let scheduleGenderFilter = 'all';
let scheduleDayFilter = 'all';   // 'all' 或某一天的日期键（如 2026-05-21）

/* 多日渲染缓存：最多 4 天 × 上百个时段，切 Tab / 切筛选时复用已拼好的甘特图 HTML，
   不必每次都把每一天重新拼一遍（赛程一改、筛选一变就失效，绝不显示旧内容）。 */
const GANTT_DAY_CACHE = new Map();
let scheduleRenderToken = 0;   // 赛程数据版本：改一次 +1，缓存随之清空
function bumpScheduleRenderToken() {
  scheduleRenderToken += 1;
  GANTT_DAY_CACHE.clear();
}

const pageContent = document.getElementById('page-content');
// 赛程页撑满整屏宽度，时间轴不再缩在中间一小块
pageContent.classList.add('schedule-page-shell');
pageContent.innerHTML = `
  <div class="card schedule-config-card" style="margin-bottom:20px;">
    <div class="card-header">
      <div>
        <div class="card-title"><span>🗓️</span> 赛程编排引擎</div>
        <div class="card-subtitle">根据报名和预赛分组生成轮次、田赛顺序及秩序册</div>
      </div>
      <div class="meet-toolbar-actions">
        <button class="btn btn-secondary" onclick="printSchedule()">打印 / 导出 PDF</button>
        <button class="btn btn-secondary" onclick="exportScheduleWord()">导出 Word</button>
      </div>
    </div>
    <div class="card-body">
      <div class="schedule-settings">
        <label>比赛日期 <input id="scheduleDate" type="date"></label>
        <label>比赛天数
          <select id="scheduleDayTotal" aria-label="比赛总天数">
            ${DAY_TOTAL_OPTIONS.map(days => `<option value="${days}"${days === DEFAULT_DAY_TOTAL ? ' selected' : ''}>${days} 天</option>`).join('')}
          </select>
        </label>
        <label class="schedule-time-range-field">上午时段
          <span class="schedule-time-pair">
            <input id="morningStart" type="time" value="08:30" aria-label="上午开始时间">
            <span class="schedule-time-dash">–</span>
            <input id="morningEnd" type="time" value="12:00" aria-label="上午结束时间">
          </span>
        </label>
        <label class="schedule-time-range-field">下午时段
          <span class="schedule-time-pair">
            <input id="afternoonStart" type="time" value="13:30" aria-label="下午开始时间">
            <span class="schedule-time-dash">–</span>
            <input id="afternoonEnd" type="time" value="17:00" aria-label="下午结束时间">
          </span>
        </label>
        <label>径赛每组（分钟） <input id="trackDuration" type="number" min="5" max="120" step="1" value="12"></label>
        <label>田赛每项（分钟） <input id="fieldDuration" type="number" min="5" max="480" step="5" value="45"></label>
        <label class="schedule-recovery-field" title="跑完 400 米及以上（400 / 800 / 1500）的学生，至少休息这么多分钟才会被排下一场；0 = 不限制">长跑后休息（分钟）
          <input id="scheduleRecoveryMinutes" type="number" min="${RECOVERY_MINUTES_MIN}" max="${RECOVERY_MINUTES_MAX}" step="5" value="${DEFAULT_LONG_RUN_RECOVERY_MINUTES}"
            aria-label="长距离径赛后体能恢复时间" onchange="renderSchedule()">
        </label>
        <label>径赛跑道数
          <select id="scheduleLaneCount">
            ${TRACK_LANE_OPTIONS.map(count => `<option value="${count}"${count === DEFAULT_TRACK_LANES ? ' selected' : ''}>${count} 道</option>`).join('')}
          </select>
        </label>
        <label>田赛顺序
          <select id="fieldOrderMode">
            <option value="class">按班级轮流</option>
            <option value="random">随机打乱</option>
          </select>
        </label>
        <button class="btn btn-primary" onclick="generateSchedule()">生成 / 重新编排</button>
      </div>
      <details class="schedule-format-panel">
        <summary>🏁 赛制设置（一枪制 / 两枪制，按项目自己定）</summary>
        <div class="schedule-format-body">
          <div class="schedule-format-actions">
            <button class="btn btn-secondary" onclick="setAllEventFormats('one-shot')">全部设为一枪制</button>
            <button class="btn btn-secondary" onclick="setAllEventFormats('two-round')">全部设为两枪制</button>
          </div>
          <div class="schedule-format-list" id="scheduleFormatList"></div>
          <p class="meet-guidance">默认全部「仅一次决赛」：跑（跳、投）一次就按成绩排名，小学运动会最常用。人数超过跑道数时会自动分成几个小组同时比，仍是一枪定胜负。选「预赛 + 决赛」才会先排预赛、再预留决赛时间（决赛名单待成绩录入后确认）。田赛（跳远、跳高、投掷）本来就只有一轮，不受此设置影响。改完点【生成 / 重新编排】生效。</p>
        </div>
      </details>
      <p class="meet-guidance">五块场地并行开赛：跑道、沙坑、立定跳远区（平地）、投掷区、跳高区各一条时间轴，同一时间可以各比各的；同一场地内串行。沙坑只跑急行跳远，立定跳远走平地/垫子区，两者互不占用。径赛严格按距离连排：50 → 100 → 200 → 400 → 800 → 1500，同一距离（男/女、各年级）全部比完再进下一个距离，裁判不用来回跑。所有项目只排在上午 / 下午时段内，不会排到晚上；当天排满后，剩下的项目自动顺延到第二天，不会再出现「排不下」。比赛天数可选 1 ~ 4 天（.5 天 = 最后一天只比上午半天），项目多就往上加，日期 Tab 会跟着多出第 3、第 4 天。田赛遇到兼项学生会自动避让，避不开的标「需插空进行」。检录时间为开赛前 15 分钟。<strong>体能恢复保护</strong>：跑完 400 米及以上（400 / 800 / 1500）的学生，至少休息「长跑后休息」设定的分钟数（默认 60 分钟）才会被排下一场；排不开就自动顺延，实在顺延不开就在甘特图 / 名单里标橙色「💤 体能恢复不足」。</p>
      <div id="scheduleError" class="meet-alert" role="alert"></div>
    </div>
  </div>

  <div id="scheduleConflictSummary" class="schedule-conflicts" role="status" aria-live="polite"></div>

  <div class="card schedule-print-area">
    <div class="card-header">
      <div>
        <div class="card-title"><span>📖</span> 运动会双赛区秩序册</div>
        <div class="card-subtitle" id="scheduleSummary">尚未生成赛程</div>
      </div>
      <div class="meet-toolbar-actions schedule-filters">
        <label>年级
          <select id="scheduleGradeFilter" aria-label="筛选赛程年级" onchange="updateScheduleFilters()">
            <option value="all">全部年级</option>
            <option value="1">一年级</option><option value="2">二年级</option>
            <option value="3">三年级</option><option value="4">四年级</option>
            <option value="5">五年级</option><option value="6">六年级</option>
          </select>
        </label>
        <label>性别
          <select id="scheduleGenderFilter" aria-label="筛选赛程性别" onchange="updateScheduleFilters()">
            <option value="all">全部性别</option><option value="male">男子组</option><option value="female">女子组</option>
          </select>
        </label>
      </div>
    </div>
    <div class="card-body">
      <div class="schedule-day-tabs" id="scheduleDayTabs" role="tablist" aria-label="按比赛日查看赛程"></div>
      <div class="schedule-gantt-scroll">
        <div class="schedule-gantt" id="scheduleGantt"></div>
      </div>
      <details class="schedule-detail-panel" open>
        <summary>按场地查看明细（可改时间 / 场地，展开看名单）</summary>
        <div class="schedule-venue-books" id="scheduleVenueBooks"></div>
      </details>
    </div>
  </div>
`;

function blankMeetData() {
  return { athletes: [], registrations: [], heats: [], laneCount: DEFAULT_TRACK_LANES };
}

function readMeetData() {
  try {
    const parsed = Store.read(MEET_STORAGE_KEY, null);
    if (!parsed) return blankMeetData();
    if (typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.athletes) || !Array.isArray(parsed.registrations)) {
      throw new Error('运动会报名数据结构无效');
    }
    return { ...blankMeetData(), ...parsed };
  } catch (error) {
    scheduleStorageError = `读取报名数据失败：${error.message}`;
    return blankMeetData();
  }
}

/**
 * 取「最新」运动会数据做写入底稿。
 * ⚠️ 内存里的 meetData 只是页面初始化那一刻的快照：报名页后来导入的 athletes /
 *    registrations 它根本看不到。而报名和赛程共用同一个 Key ——
 *    直接拿旧快照整体写回，就会把报名数据整包冲掉（"排完赛程刷新，报名全没了"）。
 *    所以每次落盘前都从 Store 重取，只把赛程页自己负责的字段（赛制 / 赛程）盖上去。
 */
function freshMeetData() {
  const stored = readMeetData();                 // Store / localStorage 里的（可能刚被报名页更新过）
  const memory = meetData && typeof meetData === 'object' ? meetData : {};
  const merged = {
    ...memory,
    ...stored,
    eventFormats: memory.eventFormats || stored.eventFormats,   // 赛制归本页管
  };
  // 关键数组：谁有数据用谁的 ——
  // · Store 里有（报名页刚导入的）→ 用它，内存这份已经过期；
  // · Store 里没有（第一次用 / 数据只在内存里）→ 保留内存这份，绝不能抹成空
  ['athletes', 'registrations', 'heats'].forEach(field => {
    if (Array.isArray(stored[field]) && stored[field].length) return;
    if (Array.isArray(memory[field]) && memory[field].length) merged[field] = memory[field];
  });
  return merged;
}

function persistSchedule(nextSchedule, settings) {
  if (scheduleStorageError) {
    showScheduleError(scheduleStorageError);
    return false;
  }
  try {
    const updatedData = {
      ...freshMeetData(),          // ⚠️ 以最新报名数据为底，不用内存里的旧快照
      schedule: {
        version: 1,
        settings,
        entries: nextSchedule,
      },
    };
    Store.write(MEET_STORAGE_KEY, updatedData);
    meetData = updatedData;
    currentSchedule = nextSchedule;
    bumpScheduleRenderToken();
    renderSchedule();
    showScheduleError('');
    return true;
  } catch (error) {
    showScheduleError(`保存赛程失败：${error.message}`);
    return false;
  }
}

function escapeScheduleHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function scheduleId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function showScheduleError(message) {
  const box = document.getElementById('scheduleError');
  box.textContent = message;
  box.classList.toggle('visible', Boolean(message));
}

function normalizeGender(value) {
  return value === 'female' ? '女子组' : '男子组';
}

function eventIdentity(eventName, genderGroup, grade) {
  return `${grade}|${genderGroup}|${eventName.trim().toLowerCase()}`;
}

/** 赛制：默认一枪制，脏数据也退回一枪制 */
function normalizeEventFormat(value) {
  return value === 'two-round' ? 'two-round' : DEFAULT_EVENT_FORMAT;
}

function eventFormatOf(eventName) {
  const saved = meetData?.eventFormats;
  if (!saved || typeof saved !== 'object') return DEFAULT_EVENT_FORMAT;
  return normalizeEventFormat(saved[String(eventName ?? '').trim()]);
}

function setEventFormat(eventName, value) {
  const name = String(eventName ?? '').trim();
  if (!name) return;
  meetData = { ...meetData, eventFormats: { ...(meetData.eventFormats || {}), [name]: normalizeEventFormat(value) } };
  persistMeetData();
  renderEventFormatList();
}

function setAllEventFormats(value) {
  const format = normalizeEventFormat(value);
  const next = { ...(meetData.eventFormats || {}) };
  trackEventNames().forEach(name => { next[name] = format; });
  meetData = { ...meetData, eventFormats: next };
  persistMeetData();
  renderEventFormatList();
}

/** 赛制列表里出现的项目：所有径赛项目（田赛只有一轮，不列） */
function trackEventNames() {
  const names = new Set();
  meetData.registrations.forEach(registration => {
    if (registration.isTeamEvent === true || registration.isTeam === true) return;
    if (/(团体|接力|4\s*[x×]\s*100\s*(?:米|m)?)/i.test(registration.eventName)) return;
    if (classifyVenue(registration.eventName, registration.eventType) !== 'track') return;
    names.add(String(registration.eventName).trim());
  });
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function renderEventFormatList() {
  const box = document.getElementById('scheduleFormatList');
  if (!box) return;
  const names = trackEventNames();
  if (!names.length) {
    box.innerHTML = '<div class="meet-empty">还没有径赛报名数据，导入报名后可在这里设置赛制。</div>';
    return;
  }
  const laneLimit = normalizeLaneCount(Number(document.getElementById('scheduleLaneCount')?.value));
  // 组数按「年级 + 性别」分别算：每个分组各自占几条跑道
  const statsOf = name => {
    const combos = new Map();
    const ids = new Set();
    meetData.registrations.filter(registration => String(registration.eventName).trim() === name)
      .forEach(registration => {
        const athlete = meetData.athletes.find(item => item.id === registration.athleteId);
        const key = `${athlete?.grade ?? '?'}|${athlete?.gender ?? registration.genderGroup}`;
        combos.set(key, (combos.get(key) || 0) + 1);
        ids.add(registration.athleteId);
      });
    const groups = [...combos.values()]
      .reduce((sum, size) => sum + Math.max(1, Math.ceil(size / laneLimit)), 0);
    return { athletes: ids.size, groups, combos: combos.size };
  };
  box.innerHTML = names.map(name => {
    const current = eventFormatOf(name);
    const { athletes, groups, combos } = statsOf(name);
    return `<div class="schedule-format-row">
        <span class="schedule-format-name">${escapeScheduleHTML(name)}</span>
        <span class="schedule-format-meta">${athletes} 人报名 · ${combos} 个组别 · 约 ${groups} 组</span>
        <select class="schedule-format-select" data-name="${escapeScheduleHTML(name)}"
          aria-label="${escapeScheduleHTML(name)}赛制"
          onchange="setEventFormat(this.dataset.name, this.value)">
          ${EVENT_FORMAT_OPTIONS.map(option => `<option value="${option.value}"${option.value === current ? ' selected' : ''}>${option.label}</option>`).join('')}
        </select>
      </div>`;
  }).join('');
}

function persistMeetData() {
  if (scheduleStorageError) {
    showScheduleError(scheduleStorageError);
    return false;
  }
  try {
    // 同样以最新数据为底：只改赛制，不动报名数据
    const updated = freshMeetData();
    Store.write(MEET_STORAGE_KEY, updated);
    meetData = updated;
    return true;
  } catch (error) {
    showScheduleError(`保存赛制设置失败：${error.message}`);
    return false;
  }
}

function formatDateTimeLocal(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toLocalDateTime(dateValue, timeValue) {
  const [year, month, day] = dateValue.split('-').map(Number);
  const [hour, minute] = timeValue.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function getUniqueEventRosters() {
  const athleteById = new Map(meetData.athletes.map(athlete => [athlete.id, athlete]));
  const events = new Map();

  meetData.registrations.forEach(registration => {
    if (registration.isTeamEvent === true || registration.isTeam === true ||
        /(团体|接力|4\s*[x×]\s*100\s*(?:米|m)?)/i.test(registration.eventName)) return;
    const athlete = athleteById.get(registration.athleteId);
    if (!athlete) return;
    const genderGroup = athlete.gender || registration.genderGroup;
    const key = eventIdentity(registration.eventName, genderGroup, athlete.grade);
    const item = events.get(key) || {
      key,
      eventName: registration.eventName,
      genderGroup,
      grade: athlete.grade,
      eventType: registration.eventType,
      athleteIds: [],
    };
    if (!item.athleteIds.includes(athlete.id)) item.athleteIds.push(athlete.id);
    if (registration.eventType === 'track') item.eventType = 'track';
    if (registration.eventType === 'field') item.eventType = 'field';
    events.set(key, item);
  });

  return [...events.values()].sort((a, b) =>
    (a.eventType === b.eventType ? 0 : a.eventType === 'track' ? -1 : 1) ||
    a.grade - b.grade ||
    a.genderGroup.localeCompare(b.genderGroup) ||
    a.eventName.localeCompare(b.eventName, 'zh-CN')
  );
}

function distributeByClass(athleteIds) {
  const athleteById = new Map(meetData.athletes.map(athlete => [athlete.id, athlete]));
  const groups = new Map();
  athleteIds.forEach(id => {
    const athlete = athleteById.get(id);
    if (!athlete) return;
    const key = `${athlete.grade}-${athlete.className}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  });

  const queues = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN', { numeric: true }))
    .map(([, ids]) => [...ids].sort((a, b) =>
      String(athleteById.get(a)?.name || '').localeCompare(String(athleteById.get(b)?.name || ''), 'zh-CN'),
    ));
  const order = [];
  while (queues.some(queue => queue.length)) {
    queues.forEach(queue => {
      const next = queue.shift();
      if (next !== undefined) order.push(next);
    });
  }
  return order;
}

function shuffledIds(ids) {
  const result = [...ids];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

/** 跑道数兜底：脏数据/旧数据一律退回默认值，避免出现 0 道或 Infinity 组 */
function normalizeLaneCount(value) {
  const lanes = Number(value);
  return TRACK_LANE_OPTIONS.includes(lanes) ? lanes : DEFAULT_TRACK_LANES;
}

function splitIntoHeats(athleteIds, laneCount) {
  // 组数 = ⌈人数 / 跑道数⌉，余数自动落在最后一组（如 9 人 4 道 → 3 组，3+3+3）
  const laneLimit = normalizeLaneCount(laneCount);
  const numberOfHeats = Math.max(1, Math.ceil((athleteIds || []).length / laneLimit));
  const heats = Array.from({ length: numberOfHeats }, () => []);
  const ordered = distributeByClass(athleteIds);
  ordered.forEach((athleteId, index) => heats[index % numberOfHeats].push(athleteId));
  return heats.filter(heat => heat.length);
}

function existingPreliminaryGroups(event, laneCount) {
  const athleteById = new Map(meetData.athletes.map(athlete => [athlete.id, athlete]));
  const eventHeats = (meetData.heats || [])
    .filter(heat => heat.round === 'preliminary' &&
      eventIdentity(heat.eventName, heat.genderGroup, event.grade) === event.key)
    .sort((a, b) => a.groupNumber - b.groupNumber);
  const hasMixedGradeOrGender = eventHeats.some(heat =>
    heat.entries.some(entry => {
      const athlete = athleteById.get(entry.athleteId);
      return athlete && (athlete.grade !== event.grade || athlete.gender !== event.genderGroup);
    }),
  );
  if (hasMixedGradeOrGender) return splitIntoHeats(event.athleteIds, laneCount);
  const allowed = new Set(event.athleteIds);
  const groups = eventHeats
    .map(heat => heat.entries.map(entry => entry.athleteId).filter(id => allowed.has(id)))
    .filter(ids => ids.length);
  const rosteredIds = new Set(groups.flat());
  if (!groups.length || event.athleteIds.some(id => !rosteredIds.has(id)) || groups.some(group => group.length > laneCount)) {
    return splitIntoHeats(event.athleteIds, laneCount);
  }
  return groups;
}

/* ---------------- 场地 / 时段 / 并行编排 ---------------- */

function venueByKey(key) {
  return VENUE_RESOURCES.find(venue => venue.key === key) || VENUE_RESOURCES[0];
}

/** 旧赛程没有 venueKey，按场地名或项目类型回推 */
function venueKeyOf(entry) {
  // 老数据把「立定跳远」也塞在沙坑里，这里按项目名迁回平地/垫子区，保证旧赛程也能和沙坑并行
  if (/立定跳远|立定三级跳/.test(String(entry?.eventName ?? ''))) return 'standingjump';
  if (entry?.venueKey && VENUE_RESOURCES.some(venue => venue.key === entry.venueKey)) return entry.venueKey;
  const byName = VENUE_RESOURCES.find(venue => venue.name === entry?.venue);
  if (byName) return byName.key;
  return classifyVenue(entry?.eventName, entry?.eventType);
}

/**
 * 项目 → 场地。场地划分按真实小学运动会的物理场地来：
 * 沙坑只收「急行跳远」（要助跑 + 起跳板 + 落沙坑），立定跳远只要一块平地/垫子，
 * 两者不是一回事，分到两个场地才能并行开赛。
 */
function classifyVenue(eventName, eventType) {
  const name = String(eventName ?? '');
  if (/跳高|撑杆/.test(name)) return 'highjump';
  if (/立定跳远|立定三级跳/.test(name)) return 'standingjump';   // 平地/垫子区
  if (/跳远|三级跳/.test(name)) return 'sandpit';                 // 沙坑：急行跳远
  if (/沙包|垒球|实心球|铅球|铁饼|标枪|投掷|掷/.test(name)) return 'throwing';
  if (eventType === 'field') return 'throwing';  // 认不出的田赛默认放投掷区（卡片上可手动改）
  return 'track';
}

/* 径赛连排顺序：按距离从短到长（起终点位置相近的项目连着比，裁判员不用满操场跑）。
   50 → 100 → 200 → 400 → 800 → 1500；列表外的距离（如 3000 米）按实际米数排在最后。 */
const TRACK_DISTANCE_ORDER = [50, 100, 150, 200, 300, 400, 600, 800, 1000, 1500];

function normalizeRecoveryMinutes(value) {
  // 留空 / 非数字一律退回默认（表单没填过就用 60 分钟，不会因为空串变成 0 而关掉保护）
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_LONG_RUN_RECOVERY_MINUTES;
  }
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_LONG_RUN_RECOVERY_MINUTES;
  return Math.min(RECOVERY_MINUTES_MAX, Math.max(RECOVERY_MINUTES_MIN, Math.round(minutes)));
}

/** 径赛项目的距离（米）；不是径赛、或项目名里认不出距离 → null */
function trackEventMeters(entry) {
  if (venueKeyOf(entry) !== 'track') return null;
  const match = String(entry?.eventName ?? '').match(/(\d+(?:\.\d+)?)\s*(?:米|m|M)/);
  return match ? Number(match[1]) : null;
}

/** 是否长距离径赛：400 米及以上（400 / 800 / 1500…）—— 跑完必须留足恢复时间 */
function isLongRunEntry(entry) {
  const meters = trackEventMeters(entry);
  return Number.isFinite(meters) && meters >= LONG_RUN_MIN_METERS;
}

/**
 * 体能恢复判定：longRunEntry 结束 → nextStartAt 开赛，间隔够不够恢复？
 * 够（或恢复保护已关闭）→ null；不够 → { gapMinutes, neededMinutes }
 */
function recoveryShortfall(longRunEntry, nextStartAt, recoveryMinutes) {
  const required = normalizeRecoveryMinutes(recoveryMinutes);
  if (required <= 0 || !isLongRunEntry(longRunEntry)) return null;
  const end = new Date(longRunEntry?.startAt).getTime();
  if (!Number.isFinite(end)) return null;
  const nextStart = new Date(nextStartAt).getTime();
  if (!Number.isFinite(nextStart)) return null;
  const gapMinutes = (nextStart - (end + (Number(longRunEntry.durationMinutes) || 0) * 60000)) / 60000;
  if (gapMinutes >= required) return null;
  return {
    gapMinutes: Math.max(0, Math.round(gapMinutes)),
    neededMinutes: Math.ceil(required - gapMinutes),
  };
}

/** 这个项目最早能接在 previousEntry 之后开赛的时间点（毫秒）：取「检录缓冲」与「体能恢复」里更晚的那个 */
function earliestStartAfter(previousEntry, bufferMinutes, recoveryMinutes) {
  const end = new Date(previousEntry?.startAt).getTime() + (Number(previousEntry?.durationMinutes) || 0) * 60000;
  if (!Number.isFinite(end)) return 0;
  const withBuffer = end + bufferMinutes * 60000;
  if (!isLongRunEntry(previousEntry)) return withBuffer;
  return Math.max(withBuffer, end + normalizeRecoveryMinutes(recoveryMinutes) * 60000);
}

/** 项目名 → 距离档位（越小越先比）；认不出距离的径赛排在最后 */
function trackDistanceRank(eventName) {
  const match = String(eventName ?? '').match(/(\d+(?:\.\d+)?)\s*(?:米|m|M)/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const meters = Number(match[1]);
  const index = TRACK_DISTANCE_ORDER.indexOf(meters);
  return index >= 0 ? index : TRACK_DISTANCE_ORDER.length + meters / 1000;
}

function normalizeDuration(value, fallback, min, max) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return fallback;
  return Math.min(max, Math.max(min, Math.round(minutes)));
}

/**
 * 天数兜底：
 * · 正好在档位里（1 / 1.5 / 2 / 2.5 / 3 / 3.5 / 4）→ 原样用
 * · 数字但超出范围（老数据里存了 5 天、手填了 6）→ 夹到最近的合法档位，
 *   绝不悄悄退回 2 天，否则老师设的天数会被无声吞掉、赛程少排一大截
 * · 完全不是数字 → 才是默认 2 天
 */
function normalizeDayTotal(value) {
  const days = Number(value);
  if (DAY_TOTAL_OPTIONS.includes(days)) return days;
  if (!Number.isFinite(days)) return DEFAULT_DAY_TOTAL;
  return DAY_TOTAL_OPTIONS.reduce((best, option) =>
    (Math.abs(option - days) < Math.abs(best - days) ? option : best), DAY_TOTAL_OPTIONS[0]);
}

function formatDateKey(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function defaultSessionTimes(overrides = {}) {
  // 只接受合法时间，undefined / 空串一律忽略（否则会把默认时段覆盖成 00:00）
  const clean = {};
  Object.entries(overrides || {}).forEach(([key, value]) => {
    const text = String(value ?? '').trim();
    if (TIME_PATTERN.test(text)) clean[key] = text;
  });
  return {
    morningStart: DEFAULT_SESSIONS[0].start,
    morningEnd: DEFAULT_SESSIONS[0].end,
    afternoonStart: DEFAULT_SESSIONS[1].start,
    afternoonEnd: DEFAULT_SESSIONS[1].end,
    ...clean,
  };
}

/**
 * 按「比赛总天数」排出每一天的上午 / 下午时段（先后顺序即排期顺序）。
 * 整天 = 上午 + 下午；.5 的最后一天只排上午（半天）。
 * 1 天 → 2 个时段；1.5 天 → 3 个；2 天 → 4 个；2.5 天 → 5 个；
 * 3 天 → 6 个；3.5 天 → 7 个（第 4 天只有上午）；4 天 → 8 个。
 */
function buildSessionPlan(days, times = {}) {
  const total = normalizeDayTotal(days);
  const dayCount = Math.ceil(total);
  const lastDayIsHalf = Math.abs(total % 1 - 0.5) < 1e-6;
  const time = defaultSessionTimes(times);
  const plan = [];
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const isLastDay = dayIndex === dayCount - 1;
    plan.push({
      key: `day${dayIndex + 1}-morning`,
      dayIndex,
      label: '上午',
      start: time.morningStart,
      end: time.morningEnd,
    });
    if (!isLastDay || !lastDayIsHalf) {
      plan.push({
        key: `day${dayIndex + 1}-afternoon`,
        dayIndex,
        label: '下午',
        start: time.afternoonStart,
        end: time.afternoonEnd,
      });
    }
  }
  return plan;
}

/** 把「时段模板」变成某一天（可按 dayIndex 顺延到第二天、第三天）的真实 Date 区间 */
function buildSessions(dateValue, sessions = DEFAULT_SESSIONS) {
  const base = new Date(`${String(dateValue).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(base.getTime())) return [];
  return (Array.isArray(sessions) ? sessions : DEFAULT_SESSIONS)
    .map(session => {
      const dayIndex = Number.isInteger(session?.dayIndex) ? session.dayIndex : 0;
      const dayDate = addDays(base, dayIndex);
      const [startHour, startMinute] = String(session?.start ?? '').split(':');
      const [endHour, endMinute] = String(session?.end ?? '').split(':');
      const start = new Date(dayDate);
      start.setHours(Number(startHour), Number(startMinute), 0, 0);
      const end = new Date(dayDate);
      end.setHours(Number(endHour), Number(endMinute), 0, 0);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
      if (end.getTime() <= start.getTime()) return null;
      return {
        key: session.key || '',
        label: session.label || '',
        dayIndex,
        dateKey: formatDateKey(dayDate),
        start,
        end,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function overlapsWithBuffer(entry, startAt, durationMinutes, bufferMinutes) {
  const entryStart = new Date(entry.startAt).getTime();
  const entryEnd = entryStart + entry.durationMinutes * 60000;
  const start = startAt.getTime();
  const end = start + durationMinutes * 60000;
  return start < entryEnd + bufferMinutes * 60000 && entryStart < end + bufferMinutes * 60000;
}

function sharesAthlete(entry, participantIds) {
  if (!participantIds?.length || !entry.participantIds?.length) return false;
  const roster = new Set(entry.participantIds);
  return participantIds.some(id => roster.has(id));
}

// 兼项避让的预算：最多挪 3 次、最多往后挪 60 分钟。
// 超过预算就不再硬挪 —— 否则一个人报得多就会把整张赛程拖回串行，田赛现场本来就能「插空」进行。
const MAX_AVOID_ATTEMPTS = 3;
const MAX_AVOID_SHIFT_MINUTES = 60;

function sessionFitting(candidate, durationMinutes, sessions) {
  return sessions.find(item =>
    candidate.getTime() >= item.start.getTime() &&
    addMinutes(candidate, durationMinutes).getTime() <= item.end.getTime());
}

/**
 * 在某块场地上找最早能排的时段：
 * 1. 同场地串行 —— 沙坑只有 1 个，所以急行跳远要一项一项来（立定跳远在平地/垫子区，不受影响）
 * 2. 严格锁在上午 / 下午时段内，绝不排到晚上
 * 3. 跨场地兼项避让（优先保住已排好的径赛），避让超预算就标「需插空进行」
 */
function findVenueSlot({ venueKey, durationMinutes, participantIds, cursor, sessions, schedule, bufferMinutes = DEFAULT_CHECKIN_MINUTES, recoveryMinutes = DEFAULT_LONG_RUN_RECOVERY_MINUTES }) {
  const recovery = normalizeRecoveryMinutes(recoveryMinutes);
  // ① 本场地的时间轴：串行 + 时段限制
  let base = new Date(Math.max(cursor.getTime(), sessions[0].start.getTime()));
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!sessionFitting(base, durationMinutes, sessions)) {
      const nextSession = sessions.find(item => item.start.getTime() > base.getTime());
      if (!nextSession) return { startAt: null, overflow: true };  // 当天装不下 → 不排，绝不排到晚上
      base = new Date(nextSession.start);
      continue;
    }
    const sameVenue = schedule.filter(entry =>
      venueKeyOf(entry) === venueKey && overlapsWithBuffer(entry, base, durationMinutes, 0));
    if (!sameVenue.length) break;
    base = new Date(Math.max(...sameVenue.map(entry =>
      new Date(entry.startAt).getTime() + entry.durationMinutes * 60000)));
  }
  const fallback = new Date(base);

  // ② 兼项避让 + 体能恢复保护：预算内挪到「不撞车、且长跑后休息够了」的时间，挪不动就插空并打标
  //   · 跨场地（跑道 vs 沙坑）、同场地连轴转（100 米刚跑完就跑 50 米）都要避让
  //   · 400 米及以上跑完，这名学生必须再歇够 recovery 分钟才能上场（下一场是径赛或田赛都一样）
  let candidate = new Date(base);
  // 「不撞车、只是恢复不够」的位置：实在挪不出恢复期时退到这里 ——
  // 宁可让学生休息得少一点并在甘特图上标橙色警告，也绝不退回「两场真撞车」的时间点
  let safeCandidate = null;
  for (let attempt = 0; attempt < MAX_AVOID_ATTEMPTS; attempt += 1) {
    if (!sessionFitting(candidate, durationMinutes, sessions)) break;   // 挪出时段了，回原位插空
    const shared = schedule.filter(entry => sharesAthlete(entry, participantIds));
    const overlaps = shared.filter(entry =>
      overlapsWithBuffer(entry, candidate, durationMinutes, bufferMinutes));
    const shortfalls = shared.filter(entry => recoveryShortfall(entry, candidate, recovery));
    if (!overlaps.length && !shortfalls.length) {
      return { startAt: new Date(candidate), needsFlex: false };
    }
    if (!overlaps.length) safeCandidate = new Date(candidate);   // 不撞车，只是恢复期不够
    const nextStart = Math.max(...[...overlaps, ...shortfalls].map(entry =>
      earliestStartAfter(entry, bufferMinutes, recovery)));
    // 为了一个兼项的学生把整项往后挪一个多小时不划算 —— 不如原地开赛，现场插空。
    // 但体能恢复是硬规则：需要恢复时预算放宽到「恢复时间 + 60 分钟」，否则永远挪不过去。
    const budget = (shortfalls.length ? recovery + MAX_AVOID_SHIFT_MINUTES : MAX_AVOID_SHIFT_MINUTES) * 60000;
    if (nextStart - base.getTime() > budget) break;
    candidate = new Date(nextStart);
  }
  if (safeCandidate) return { startAt: safeCandidate, needsFlex: false, shortRecovery: true };
  return { startAt: fallback, needsFlex: true };
}

/**
 * 并行编排：四条场地时间轴同时推进，同一场地内串行。
 * 径赛先占位，田赛再在时间轴上避让兼项学生。
 */
function getUnscheduledEvents() {
  return unscheduledEvents;
}

function buildSchedule(dateValue, startValue, trackDuration, fieldDuration, laneCount, orderMode, options = {}) {
  const events = getUniqueEventRosters();
  unscheduledEvents = [];
  const laneLimit = normalizeLaneCount(laneCount); // 统一按有效跑道数编排（选 4 道就每 4 人一组）
  const trackMinutes = normalizeDuration(trackDuration, DEFAULT_TRACK_DURATION, 5, 120);
  const fieldMinutes = normalizeDuration(fieldDuration, DEFAULT_FIELD_DURATION, 5, 480);
  // 长距离径赛（≥400 米）跑完后的体能恢复时间：排下一场时要给这名学生留够
  const recoveryMinutes = normalizeRecoveryMinutes(options.recoveryMinutes);
  // 多日赛程：先按「比赛天数」排出每一天的上午 / 下午，排满当天就顺延到第二天
  const sessionPlan = Array.isArray(options.sessions) && options.sessions.length
    ? options.sessions
    : buildSessionPlan(options.days, defaultSessionTimes({
      ...options.times,
      ...(startValue ? { morningStart: startValue } : {}),
    }));
  const sessions = buildSessions(dateValue, sessionPlan);
  if (!sessions.length) return [];

  const schedule = [];
  /**
   * 排序规则（直接决定时间轴上的先后顺序）：
   * ① 径赛优先占跑道（跑道是全场瓶颈，先在跑道上把径赛排完）
   * ② 径赛严格按距离连排：50 → 100 → 200 → 400 → 800 → 1500，
   *    同一距离内（男/女、各年级）全部排完再进下一个距离，绝不中间插长跑
   * ③ 田赛按场地分块连排（沙坑 / 立定跳远区 / 投掷区 / 跳高区各自连着比）
   */
  const ordered = [...events].sort((a, b) => {
    const venueA = classifyVenue(a.eventName, a.eventType);
    const venueB = classifyVenue(b.eventName, b.eventType);
    if ((venueA === 'track') !== (venueB === 'track')) return venueA === 'track' ? -1 : 1;
    if (venueA === 'track' && venueB === 'track') {
      const byDistance = trackDistanceRank(a.eventName) - trackDistanceRank(b.eventName);
      if (byDistance) return byDistance;
    } else if (venueA !== venueB) {
      const byVenue = VENUE_RESOURCES.findIndex(venue => venue.key === venueA)
        - VENUE_RESOURCES.findIndex(venue => venue.key === venueB);
      if (byVenue) return byVenue;
    }
    return (Number(a.grade) || 0) - (Number(b.grade) || 0)
      || String(a.genderGroup).localeCompare(String(b.genderGroup))
      || String(a.eventName).localeCompare(String(b.eventName), 'zh-CN');
  });

  const cursors = new Map(VENUE_RESOURCES.map(venue => [venue.key, new Date(sessions[0].start)]));
  const pushBlock = (event, round, groupNumber, participantIds, venueKey, durationMinutes, extra = {}, pool) => {
    const daySessions = pool || sessions;
    const cursor = cursors.get(venueKey) || new Date(daySessions[0].start);
    const slot = findVenueSlot({
      venueKey,
      durationMinutes,
      participantIds,
      cursor,
      sessions: daySessions,
      schedule,
      bufferMinutes: DEFAULT_CHECKIN_MINUTES,
      recoveryMinutes,
    });
    if (!slot.startAt) {
      // 时段内实在排不下：记下来提醒老师，而不是硬排到晚上
      unscheduledEvents.push({
        event,
        eventName: event.eventName,
        genderGroup: event.genderGroup,
        grade: event.grade,
        venue: venueByKey(venueKey).name,
        round,
        groupNumber,
        durationMinutes,
      });
      return;
    }
    const session = sessions.find(item =>
      slot.startAt.getTime() >= item.start.getTime() && slot.startAt.getTime() < item.end.getTime())
      || sessions[0];
    schedule.push({
      id: scheduleId(),
      eventKey: event.key,
      eventName: event.eventName,
      genderGroup: event.genderGroup,
      grade: event.grade,
      eventType: event.eventType,
      venueKey,
      venue: venueByKey(venueKey).name,
      dateKey: session.dateKey,
      dayIndex: session.dayIndex,
      sessionLabel: session.label,
      round,
      groupNumber,
      participantIds,
      participantLabel: extra.participantLabel || '',
      qualifyingCount: extra.qualifyingCount || 0,
      fieldOrderMode: extra.fieldOrderMode || '',
      eventFormat: extra.eventFormat || (venueKey === 'track' ? eventFormatOf(event.eventName) : ''),
      oneShotGroups: extra.oneShotGroups || 0,
      needsFlex: slot.needsFlex,
      startAt: formatDateTimeLocal(slot.startAt),
      durationMinutes,
      checkinMinutes: DEFAULT_CHECKIN_MINUTES,
    });
    cursors.set(venueKey, addMinutes(slot.startAt, durationMinutes));
  };

  // 多日时按「连排块」整体轮转：径赛以「同一距离」为一块，田赛以「同一场地」为一块。
  // 整块搬到同一天，保证「50 米男女各组连着比完」不被两天拆开；也避免某块场地整体落到同一天。
  const dayIndexes = [...new Set(sessions.map(session => session.dayIndex))].sort((a, b) => a - b);
  const eventsByDay = new Map(dayIndexes.map(dayIndex => [dayIndex, []]));
  const orderIndex = new Map(ordered.map((event, index) => [event, index]));
  const consecutiveBlocks = [];
  ordered.forEach(event => {
    const venueKey = classifyVenue(event.eventName, event.eventType);
    const blockKey = venueKey === 'track'
      ? `track:${trackDistanceRank(event.eventName)}`   // 同一距离 = 一块
      : `field:${venueKey}`;                            // 同一场地 = 一块
    const tail = consecutiveBlocks[consecutiveBlocks.length - 1];
    if (tail && tail.key === blockKey) tail.events.push(event);
    else consecutiveBlocks.push({ key: blockKey, events: [event] });
  });
  consecutiveBlocks.forEach((block, index) => {
    eventsByDay.get(dayIndexes[index % dayIndexes.length]).push(...block.events);
  });
  // 每天内部仍按「径赛（按距离）→ 田赛（按场地）→ 年级 → 项目名」排
  [...eventsByDay.values()].forEach(list => list.sort((a, b) => orderIndex.get(a) - orderIndex.get(b)));

  const placeEvent = (event, pool) => {
    const venueKey = classifyVenue(event.eventName, event.eventType);
    if (venueKey === 'track') {
      const format = eventFormatOf(event.eventName);
      // 人数超过跑道数就一定得分组（一枪制 = 分组直接决赛，按成绩总排名；两枪制 = 预赛 + 决赛）
      const groups = event.athleteIds.length > laneLimit
        ? existingPreliminaryGroups(event, laneLimit)
        : [event.athleteIds];
      if (format === 'two-round' && groups.length > 1) {
        groups.forEach((athleteIds, index) => {
          pushBlock(event, 'preliminary', index + 1, athleteIds, venueKey, trackMinutes, { eventFormat: format }, pool);
        });
        pushBlock(event, 'final', 1, [], venueKey, trackMinutes, {
          participantLabel: `预赛晋级选手（最多 ${laneLimit} 人，待成绩确认）`,
          qualifyingCount: laneLimit,
          eventFormat: format,
        }, pool);
      } else {
        // 一枪制：一次跑完按成绩排名；人数多就分成几个决赛小组，不再另排决赛
        groups.forEach((athleteIds, index) => {
          pushBlock(event, 'final', index + 1, athleteIds, venueKey, trackMinutes, {
            eventFormat: format,
            oneShotGroups: groups.length,
          }, pool);
        });
      }
      return;
    }
    const order = orderMode === 'random'
      ? shuffledIds(event.athleteIds)
      : distributeByClass(event.athleteIds);
    pushBlock(event, 'field', 1, order, venueKey, fieldMinutes, { fieldOrderMode: orderMode }, pool);
  };

  dayIndexes.forEach(dayIndex => {
    // 场地游标回到这一天的开赛时间；时段池 = 当天 + 之后所有天（排不下就顺延）
    VENUE_RESOURCES.forEach(venue => cursors.set(venue.key, new Date(sessions[0].start)));
    const firstOfDay = sessions.find(session => session.dayIndex === dayIndex);
    if (firstOfDay) VENUE_RESOURCES.forEach(venue => cursors.set(venue.key, new Date(firstOfDay.start)));
    const pool = sessions.filter(session => session.dayIndex >= dayIndex);
    (eventsByDay.get(dayIndex) || []).forEach(event => placeEvent(event, pool));
  });

  // 兜底回填：还有没排下的，拿全部时段再试一次（把各天的空档补上）
  if (unscheduledEvents.length) {
    // 同一个项目的多个分组只回填一次（否则上面 6 个分组各留一条，这里会重复排 6 遍，
    // 提示里同一个项目刷几十行，老师根本看不出到底有几个项目没排下）
    const leftovers = [...new Map(unscheduledEvents
      .filter(item => item?.event)
      .map(item => [item.event.key || `${item.eventName}|${item.grade}|${item.genderGroup}`, item.event])
    ).values()];
    unscheduledEvents = [];
    VENUE_RESOURCES.forEach(venue => cursors.set(venue.key, new Date(sessions[0].start)));
    leftovers.forEach(event => placeEvent(event, sessions));
  }
  // 最终提示也按「项目 + 场地」去重，一行一个项目
  unscheduledEvents = [...new Map(unscheduledEvents.map(item => [
    `${item.eventName}|${item.grade}|${item.genderGroup}|${item.venue}|${item.round}`, item,
  ])).values()];

  return schedule.sort((a, b) => new Date(a.startAt) - new Date(b.startAt)
    || VENUE_RESOURCES.findIndex(venue => venue.key === a.venueKey) - VENUE_RESOURCES.findIndex(venue => venue.key === b.venueKey)
    || a.groupNumber - b.groupNumber);
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function readScheduleForm() {
  const value = id => String(document.getElementById(id)?.value ?? '').trim();
  return {
    date: value('scheduleDate'),
    days: value('scheduleDayTotal'),
    morningStart: value('morningStart'),
    morningEnd: value('morningEnd'),
    afternoonStart: value('afternoonStart'),
    afternoonEnd: value('afternoonEnd'),
    trackDuration: value('trackDuration'),
    fieldDuration: value('fieldDuration'),
    recoveryMinutes: value('scheduleRecoveryMinutes'),
    lanes: value('scheduleLaneCount'),
    orderMode: value('fieldOrderMode'),
  };
}

function validateSettings() {
  const form = readScheduleForm();
  const trackDuration = Number(form.trackDuration);
  const fieldDuration = Number(form.fieldDuration);
  const lanes = Number(form.lanes);
  if (!form.date) return { error: '请先选择比赛日期。' };
  if (![form.morningStart, form.morningEnd, form.afternoonStart, form.afternoonEnd]
    .every(time => TIME_PATTERN.test(time))) {
    return { error: '请填写完整的上午 / 下午比赛时段（如 08:30 – 12:00）。' };
  }
  const times = {
    morningStart: form.morningStart,
    morningEnd: form.morningEnd,
    afternoonStart: form.afternoonStart,
    afternoonEnd: form.afternoonEnd,
  };
  const sessions = buildSessions(form.date, buildSessionPlan(form.days, times));
  if (!sessions.length) return { error: '比赛时段无效：结束时间必须晚于开始时间。' };
  // 禁止排到晚上
  if (sessions.some(session => session.end.getHours() > 20)) {
    return { error: '比赛时段不能排到晚上 20:00 之后，请调整结束时间。' };
  }
  if (!Number.isInteger(trackDuration) || trackDuration < 5 || trackDuration > 120) {
    return { error: '径赛每组时长须为 5 至 120 分钟之间的整数。' };
  }
  if (!Number.isInteger(fieldDuration) || fieldDuration < 5 || fieldDuration > 480) {
    return { error: '田赛项目时长须为 5 至 480 分钟之间的整数。' };
  }
  if (!TRACK_LANE_OPTIONS.includes(lanes)) return { error: `径赛跑道数须为 ${TRACK_LANE_OPTIONS.join('、')} 道。` };
  return {
    settings: {
      date: form.date,
      days: normalizeDayTotal(form.days),
      start: form.morningStart,
      morningStart: times.morningStart,
      morningEnd: times.morningEnd,
      afternoonStart: times.afternoonStart,
      afternoonEnd: times.afternoonEnd,
      trackDurationMinutes: trackDuration,
      fieldDurationMinutes: fieldDuration,
      longRunRecoveryMinutes: normalizeRecoveryMinutes(form.recoveryMinutes),
      laneCount: lanes,
      fieldOrderMode: form.orderMode,
    },
  };
}

/**
 * 当前生效的「长跑后体能恢复时间」：优先用表单里正在填的值
 * —— 老师改一下数字就能立刻看到告警数变化，不用先重新生成一遍赛程。
 */
function savedRecoveryMinutes() {
  const live = document.getElementById('scheduleRecoveryMinutes')?.value;
  if (live !== undefined && String(live).trim() !== '') return normalizeRecoveryMinutes(live);
  return normalizeRecoveryMinutes(meetData.schedule?.settings?.longRunRecoveryMinutes);
}

function generateSchedule() {
  if (scheduleStorageError) {
    showScheduleError(scheduleStorageError);
    return;
  }
  if (!meetData.registrations.length) {
    showScheduleError('当前没有可编排的报名记录。请先导入并保存运动员报名数据。');
    return;
  }
  const validation = validateSettings();
  if (validation.error) {
    showScheduleError(validation.error);
    return;
  }
  const { settings } = validation;
  const schedule = buildSchedule(
    settings.date,
    settings.start,
    settings.trackDurationMinutes,
    settings.fieldDurationMinutes,
    settings.laneCount,
    settings.fieldOrderMode,
    { days: settings.days, times: settings, recoveryMinutes: settings.longRunRecoveryMinutes },
  );
  persistSchedule(schedule, settings);
  scheduleDayFilter = 'all';
  const pending = getUnscheduledEvents();
  if (pending.length) {
    const preview = pending.slice(0, 3)
      .map(item => `${item.grade ? `${item.grade}年级 ` : ''}${normalizeGender(item.genderGroup)} ${item.eventName}`)
      .join('、');
    showScheduleError(`${settings.days} 天的时段仍排不下 ${pending.length} 个项目（${preview}${pending.length > 3 ? ' 等' : ''}），已保留为“未安排”。请把比赛天数加到 2.5 天、延长时段，或把田赛单项时长调短后重新生成。`);
  } else {
    const dayCount = new Set(schedule.map(entry => entry.dateKey)).size;
    showToast(`编排完成：${schedule.length} 个时段，用了 ${dayCount} 天，最晚 ${formatClock(new Date(Math.max(...schedule.map(entry => new Date(entry.startAt).getTime() + entry.durationMinutes * 60000))))} 结束`);
  }
}

function formatClock(date) {
  // 非法时间（手动改坏的数据）直接兜底成 --:--，绝不抛异常中断整页渲染
  const time = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(time)) return '--:--';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time));
}

function formatTimelineMoment(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(date)}`;
}

function scheduleEnd(entry) {
  return addMinutes(new Date(entry.startAt), entry.durationMinutes);
}

/**
 * 兼项冲突检测，两类：
 * ① overlap（时间重合）—— 同一名学生两场比赛真撞车（含 15 分钟检录缓冲），红色
 * ② recovery（体能恢复不足）—— 长距离径赛（≥400 米）跑完后，下一场开赛间隔不足恢复时间，橙色
 *    这类不一定要改时间，但老师必须知道「这孩子刚跑完 800 米就上场」
 */
function findScheduleConflicts(schedule, options = {}) {
  const recoveryMinutes = normalizeRecoveryMinutes(options.recoveryMinutes);
  const overlaps = new Map();     // athleteId → [{ pair: [entryId, entryId] }]
  const recoveries = new Map();   // athleteId → [{ pair, gapMinutes, neededMinutes }]
  const athletes = new Map(meetData.athletes.map(athlete => [athlete.id, athlete]));
  const push = (map, athleteId, payload) => {
    map.set(athleteId, [...(map.get(athleteId) || []), payload]);
  };

  for (let leftIndex = 0; leftIndex < schedule.length; leftIndex += 1) {
    const left = schedule[leftIndex];
    if (!left.participantIds?.length) continue;
    const leftStart = new Date(left.startAt).getTime();
    const leftEnd = leftStart + left.durationMinutes * 60000;
    for (let rightIndex = leftIndex + 1; rightIndex < schedule.length; rightIndex += 1) {
      const right = schedule[rightIndex];
      if (!right.participantIds?.length) continue;
      const rightStart = new Date(right.startAt).getTime();
      const rightEnd = rightStart + right.durationMinutes * 60000;
      const rightAthletes = new Set(right.participantIds);
      const shared = left.participantIds.filter(id => rightAthletes.has(id));
      if (!shared.length) continue;
      const buffer = DEFAULT_CHECKIN_MINUTES * 60000;
      if (!(leftStart >= rightEnd + buffer || rightStart >= leftEnd + buffer)) {
        shared.forEach(id => push(overlaps, id, { pair: [left.id, right.id] }));
        continue;      // 真撞车了，恢复期就不重复报
      }
      if (recoveryMinutes <= 0) continue;
      // 不撞车但挨得太近：先比的那场若是长跑，这名学生还得再歇一会儿
      const [first, second] = leftStart <= rightStart ? [left, right] : [right, left];
      const shortfall = recoveryShortfall(first, second.startAt, recoveryMinutes);
      if (!shortfall) continue;
      shared.forEach(id => push(recoveries, id, { pair: [first.id, second.id], ...shortfall }));
    }
  }

  const buildDetails = (map, type) => [...map.entries()].map(([athleteId, items]) => {
    const entryIds = [...new Set(items.flatMap(item => item.pair))];
    return {
      type,
      athleteId,
      athlete: athletes.get(athleteId),
      entries: entryIds.map(id => schedule.find(entry => entry.id === id)).filter(Boolean),
      gapMinutes: type === 'recovery' ? Math.min(...items.map(item => item.gapMinutes || 0)) : 0,
      neededMinutes: type === 'recovery' ? Math.max(...items.map(item => item.neededMinutes || 0)) : 0,
    };
  });

  const overlapDetails = buildDetails(overlaps, 'overlap');
  const recoveryDetails = buildDetails(recoveries, 'recovery');
  const idsOf = list => new Set(list.flatMap(detail => detail.entries.map(entry => entry.id)));
  return {
    eventIds: new Set([...idsOf(overlapDetails), ...idsOf(recoveryDetails)]),
    overlapEventIds: idsOf(overlapDetails),
    recoveryEventIds: idsOf(recoveryDetails),
    recoveryAthleteIds: new Set(recoveryDetails.map(detail => detail.athleteId)),
    overlapDetails,
    recoveryDetails,
    details: [...overlapDetails, ...recoveryDetails],   // 兼容「只看总数」的旧用法
    recoveryMinutes,
  };
}

function updateScheduleEntry(entryId, field, value) {
  const entry = currentSchedule.find(item => item.id === entryId);
  if (!entry) return;
  const nextSchedule = currentSchedule.map(item => ({ ...item }));
  const nextEntry = nextSchedule.find(item => item.id === entryId);
  if (field === 'startAt') {
    if (!value || Number.isNaN(new Date(value).getTime())) {
      showScheduleError('比赛时间格式无效，未保存修改。');
      renderSchedule();
      return;
    }
    nextEntry.startAt = value;
  } else if (field === 'venue') {
    const venue = value.trim();
    if (!venue) {
      showScheduleError('比赛场地不能为空，未保存修改。');
      renderSchedule();
      return;
    }
    nextEntry.venue = venue;
  }
  persistSchedule(nextSchedule, meetData.schedule?.settings || {});
}

function renderParticipantList(entry, recoveryAthleteIds) {
  const athleteById = new Map(meetData.athletes.map(athlete => [athlete.id, athlete]));
  if (!entry.participantIds?.length) return escapeScheduleHTML(entry.participantLabel || '晋级名单待定');
  return entry.participantIds.map((id, index) => {
    const athlete = athleteById.get(id);
    if (!athlete) return '';
    const label = `${index + 1}. ${athlete.bibNumber || '—'} ${athlete.name}（${athlete.className}）`;
    const risky = recoveryAthleteIds?.has(id);
    const suffix = risky ? ' 💤体能恢复不足' : '';
    return `<span class="schedule-participant${risky ? ' recovery' : ''}"${risky ? ' title="刚跑完长距离径赛，休息不够"' : ''}>` 
      + `${escapeScheduleHTML(label)}${escapeScheduleHTML(suffix)}</span>`;
  }).join('');
}

function renderConflictSummary(conflicts) {
  const container = document.getElementById('scheduleConflictSummary');
  const overlapList = conflicts.overlapDetails || [];
  const recoveryList = conflicts.recoveryDetails || [];
  const recoveryMinutes = conflicts.recoveryMinutes ?? DEFAULT_LONG_RUN_RECOVERY_MINUTES;
  if (!overlapList.length && !recoveryList.length) {
    container.classList.remove('visible');
    container.innerHTML = '';
    return;
  }
  const athleteName = conflict => `${escapeScheduleHTML(conflict.athlete?.name || '未知运动员')}`
    + `（${escapeScheduleHTML(conflict.athlete?.className || '')}）`;
  const entryLine = conflict => conflict.entries
    .slice()
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
    .map(entry => `${escapeScheduleHTML(entry.eventName)} ${escapeScheduleHTML(roundLabel(entry))}`
      + `（${formatClock(new Date(entry.startAt))}）`)
    .join(' → ');
  const groups = [
    overlapList.length ? `
      <div class="schedule-conflict-group overlap">
        <strong>⚠ 时间重合冲突（同一人两场撞车，共 ${overlapList.length} 人）</strong>
        <ul>${overlapList.map(conflict => `<li>${athleteName(conflict)}：${entryLine(conflict)}</li>`).join('')}</ul>
      </div>` : '',
    recoveryList.length ? `
      <div class="schedule-conflict-group recovery">
        <strong>💤 体能恢复不足 ${recoveryMinutes} 分钟（共 ${recoveryList.length} 人）</strong>
        <span class="schedule-conflict-hint">这些学生刚跑完 400 米及以上的长距离径赛就又要上场，请把后一场往后挪，或现场让他们多歇一会儿。</span>
        <ul>${recoveryList.map(conflict => `<li>${athleteName(conflict)}：${entryLine(conflict)}`
          + ` —— 仅间隔 ${conflict.gapMinutes} 分钟，还需再休息 ${conflict.neededMinutes} 分钟</li>`).join('')}</ul>
      </div>` : '',
  ].join('');
  container.classList.add('visible');
  container.innerHTML = groups;
}

function roundLabel(entry) {
  if (entry.round === 'preliminary') return `预赛第${entry.groupNumber}组`;
  // 一枪制分组决赛：几个组同时比，一次定胜负、按成绩总排名
  if (entry.round === 'final') return entry.groupNumber > 1 ? `决赛第${entry.groupNumber}组` : '决赛';
  return '田赛';
}

/** 当前赛程使用的比赛时段（读保存的配置；含多日） */
function currentSessions() {
  const settings = meetData.schedule?.settings;
  const date = settings?.date
    || String(currentSchedule[0]?.startAt ?? '').slice(0, 10)
    || formatDateKey(new Date());
  if (Array.isArray(settings?.sessions) && settings.sessions.length) {
    const legacy = buildSessions(date, settings.sessions);
    if (legacy.length) return legacy;
  }
  return buildSessions(date, buildSessionPlan(settings?.days, {
    morningStart: settings?.morningStart,
    morningEnd: settings?.morningEnd,
    afternoonStart: settings?.afternoonStart,
    afternoonEnd: settings?.afternoonEnd,
  }));
}

/**
 * 某一天的时段（老赛程没有分段配置时，按默认上午 / 下午补一个）。
 * 关键：返回的必须【只含这一天】的时段 —— 否则时间轴会跨到第二天，容器被撑成几千 px。
 */
function sessionsForDate(sessions, dateKey) {
  const matched = (sessions || []).filter(session => session.dateKey === dateKey);
  if (matched.length) return matched.slice().sort((a, b) => a.start - b.start);
  return buildSessions(dateKey, buildSessionPlan(DEFAULT_DAY_TOTAL, defaultSessionTimes()))
    .filter(session => session.dateKey === dateKey)   // 兜底也只留当天
    .sort((a, b) => a.start - b.start);
}

/** 条目属于哪一天（老数据没有 dateKey 就从开始时间取） */
function dayKeyOf(entry) {
  return entry?.dateKey || String(entry?.startAt ?? '').slice(0, 10);
}

/** 卡片内容的排版测量：算出来需要多高、要不要精简成两行（宁可往下推，也不截字） */
/** 卡片文案：按真实高度决定显示几行（高度由时长换算得来，绝不让文字反过来改高度） */
function blockContent(entry, height) {
  const scope = `${entry.grade ? `${entry.grade}年级 · ` : ''}${normalizeGender(entry.genderGroup)}`;
  const stage = entry.round === 'preliminary' ? `预赛${entry.groupNumber}组`
    : entry.round === 'final' ? (entry.groupNumber > 1 ? `决赛${entry.groupNumber}组` : '决赛')
      : '田赛';
  return {
    scope,
    stage,
    // 高度不够三行就精简成「时间 + 项目名(带轮次)」，超出部分用省略号，完整信息看 tooltip
    compact: height < GANTT_FULL_BLOCK_HEIGHT,
  };
}

/** 同一场地内时间真重叠的卡片并排（只动左右位置，top / height 严格不动） */
function packOverlapLanes(cluster) {
  const laneBottoms = [];
  cluster.forEach(item => {
    let lane = laneBottoms.findIndex(bottom => bottom <= item.top);
    if (lane === -1) {
      laneBottoms.push(0);
      lane = laneBottoms.length - 1;
    }
    item.lane = lane;
    laneBottoms[lane] = item.top + item.height;
  });
  return laneBottoms.length;
}

function assignOverlapLanes(items) {
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (cluster.length) {
      const laneCount = packOverlapLanes(cluster);
      cluster.forEach(item => { item.laneCount = laneCount; });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };
  items.forEach(item => {
    if (item.top >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.top + item.height);
  });
  flush();
}

/**
 * 甘特图（单天）：
 * - 四列 = 跑道 / 沙坑 / 投掷区 / 跳高区，每列一条独立时间轴
 * - 严格比例映射：top = (开始 − 零点) 分钟 × 3px，height = 时长分钟 × 3px
 * - 卡片落在哪个像素，就是几点钟；容器按总时长撑满（510 分钟 = 1530px），放不下就滚动
 * - 总高度有硬边界：只在「当天第一个时段 → 最后一个时段」之间画，最多 16 小时（2880px）
 */
function renderGanttDay(entries, sessions, conflictInfo) {
  const px = GANTT_PX_PER_MINUTE;
  const tickMs = GANTT_TICK_MINUTES * 60000;
  // ① 先过滤脏数据：开始时间非法的条目直接不参与渲染（NaN 会撑爆高度 / 让页面崩掉）
  const safeEntries = entries
    .filter(entry => Number.isFinite(new Date(entry.startAt).getTime()))
    .map(entry => ({
      ...entry,
      // 时长同样夹进 [1, 960] 分钟：NaN / 负数 / 99999 分钟都不会撑爆容器
      durationMinutes: normalizeDuration(entry.durationMinutes, 0, 1, GANTT_MAX_MINUTES),
    }))
    .filter(entry => entry.durationMinutes > 0);
  if (!safeEntries.length) return '<div class="meet-empty">这一天当前筛选下没有赛程。</div>';

  // ② 时间窗口只由「当天时段」决定，条目被夹进这个窗口，绝不越界
  const safeSessions = (sessions || [])
    .filter(session => Number.isFinite(session?.start?.getTime?.())
      && Number.isFinite(session?.end?.getTime?.()));
  // 时间窗口优先由「当天时段」界定（08:30→17:00），条目只被夹进来，绝不反过来撑大窗口
  const sessionTimes = validTimes([
    ...safeSessions.map(session => session.start.getTime()),
    ...safeSessions.map(session => session.end.getTime()),
  ]);
  const entryTimes = validTimes([
    ...safeEntries.map(entry => new Date(entry.startAt).getTime()),
    ...safeEntries.map(entry => new Date(entry.startAt).getTime() + entry.durationMinutes * 60000),
  ]);
  const windowTimes = sessionTimes.length ? sessionTimes : entryTimes;
  const gridStart = Math.floor(Math.min(...windowTimes) / tickMs) * tickMs;
  const gridEnd = Math.ceil(Math.max(...windowTimes) / tickMs) * tickMs;
  // ③ 总高度硬钳制：510 分钟 → 1530px；最多 960 分钟 → 2880px，NaN 一律兜底 1530px
  const totalMinutes = clampNumber(
    (gridEnd - gridStart) / 60000, GANTT_TICK_MINUTES, GANTT_MAX_MINUTES, 510,
  );
  const totalHeight = Math.round(clampNumber(
    totalMinutes * px, GANTT_MIN_HEIGHT, GANTT_MAX_HEIGHT, 510 * px,
  ));
  const windowEnd = gridStart + totalMinutes * 60000;   // 窗口下沿（超出的一律裁掉）

  // 每列独立排版：top / height 全部由真实时间换算，不做任何下推或拉伸
  const columns = new Map();
  VENUE_RESOURCES.forEach(venue => {
    const items = safeEntries
      .filter(entry => venueKeyOf(entry) === venue.key)
      // 落在时间窗口之外的条目（脏数据被改到 20:00 之类）直接不画，绝不产生死区
      .filter(entry => new Date(entry.startAt).getTime() < windowEnd)
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
      .map(entry => {
        const start = new Date(entry.startAt);
        const end = new Date(start.getTime() + entry.durationMinutes * 60000);
        const startMinutes = (start.getTime() - gridStart) / 60000;
        // ④ 卡片也钳进窗口：超出时段范围的部分直接裁掉，绝不画到 9999px 去
        const clippedEnd = Math.min(end.getTime(), windowEnd);
        const rawTop = Math.round(startMinutes * px);
        const rawHeight = Math.round(((clippedEnd - start.getTime()) / 60000) * px);
        return {
          entry,
          top: Math.round(clampNumber(rawTop, 0, totalHeight - 1, 0)),
          height: Math.round(clampNumber(
            Math.max(GANTT_MIN_BLOCK_HEIGHT, rawHeight), GANTT_MIN_BLOCK_HEIGHT, totalHeight,
            GANTT_MIN_BLOCK_HEIGHT,
          )),
        };
      })
      .filter(item => item.top < totalHeight);
    assignOverlapLanes(items);
    columns.set(venue.key, items);
  });

  // ⑤ 刻度：每 30 分钟一个「槽」（30 × 3px = 90px），硬上限 33 个。
  //    槽内的标签是 sticky，随唯一滚动条吸在表头正下方，滚到哪儿都看得见当前时刻。
  const slotPx = GANTT_TICK_MINUTES * px;
  const slotCount = Math.min(GANTT_MAX_TICKS, Math.max(1, Math.ceil(totalHeight / slotPx)));
  const ticks = Array.from({ length: slotCount }, (_, index) => {
    const minutes = index * GANTT_TICK_MINUTES;
    const slotHeight = Math.max(0, Math.min(slotPx, totalHeight - index * slotPx));
    const label = formatClock(new Date(gridStart + minutes * 60000));
    return `<div class="schedule-gantt-tick-slot" style="height:${slotHeight}px">`
      + `<span class="schedule-gantt-tick">${escapeScheduleHTML(label)}</span></div>`;
  }).join('');

  // 午休 / 非比赛时间画成灰带（同样严格夹在窗口内）
  const orderedSessions = [...safeSessions].sort((a, b) => a.start - b.start);
  const gaps = [];
  let previousEnd = gridStart;
  orderedSessions.forEach(session => {
    if (session.start.getTime() > previousEnd) gaps.push([previousEnd, session.start.getTime()]);
    previousEnd = Math.max(previousEnd, session.end.getTime());
  });
  if (previousEnd < windowEnd) gaps.push([previousEnd, windowEnd]);
  const offBands = gaps
    .map(([from, to]) => {
      const top = Math.round(clampNumber(((from - gridStart) / 60000) * px, 0, totalHeight, 0));
      const bottom = Math.round(clampNumber(((to - gridStart) / 60000) * px, 0, totalHeight, 0));
      return { top, height: bottom - top };
    })
    .filter(band => band.height > 0)
    .map(({ top, height }) => `<div class="schedule-gantt-offband" style="top:${top}px;height:${height}px">${height >= 46 ? '<span>午休 / 非比赛时间</span>' : ''}</div>`)
    .join('');

  const blocks = VENUE_RESOURCES.map(venue => {
    const items = columns.get(venue.key) || [];
    const inner = items.map(({ entry, top, height, lane = 0, laneCount = 1 }) => {
      const start = new Date(entry.startAt);
      const end = scheduleEnd(entry);
      const conflicted = conflictInfo?.eventIds.has(entry.id);
      const recoveryRisk = conflictInfo?.recoveryEventIds?.has(entry.id);
      const { stage, scope, compact } = blockContent(entry, height);
      const showTextFlag = height >= 78;
      const recoveryMinutes = conflictInfo?.recoveryMinutes ?? DEFAULT_LONG_RUN_RECOVERY_MINUTES;
      const flags = [
        conflicted ? `<span class="schedule-gantt-flag warn" title="兼项冲突">⚠${showTextFlag ? ' 冲突' : ''}</span>` : '',
        recoveryRisk ? `<span class="schedule-gantt-flag recovery" title="体能恢复不足 ${recoveryMinutes} 分钟（该场有学生刚跑完长距离径赛）">💤${showTextFlag ? ' 体能恢复不足' : ''}</span>` : '',
        entry.needsFlex ? `<span class="schedule-gantt-flag flex" title="需插空进行">🕒${showTextFlag ? ' 需插空' : ''}</span>` : '',
      ].join('');
      // 精简版把轮次跟在项目名后面；完整信息都在 tooltip 里，绝不因为排版失真
      const titleLine = compact
        ? `${entry.eventName} ${stage}`
        : String(entry.eventName ?? '');
      // 时间真重叠时并排显示（左右各占一份），纵向位置依旧是真实时间
      const laneStyle = laneCount > 1
        ? `left:calc(${(lane * 100 / laneCount).toFixed(3)}% + 2px);right:auto;width:calc(${(100 / laneCount).toFixed(3)}% - 5px);`
        : '';
      const tooltip = `${entry.eventName} · ${scope} · ${stage} · ${formatClock(start)}-${formatClock(end)}`;
      return `<div class="schedule-gantt-block tone-${venue.tone}${compact ? ' compact' : ''}${conflicted ? ' conflict' : ''}${recoveryRisk ? ' recovery' : ''}${entry.needsFlex ? ' flex' : ''}${laneCount > 1 ? ' narrow' : ''}"
          data-venue="${venue.key}"
          style="top:${top}px;height:${height}px;${laneStyle}"
          title="${escapeScheduleHTML(tooltip)}${recoveryRisk ? escapeScheduleHTML(` · 💤 体能恢复不足 ${recoveryMinutes} 分钟`) : ''}">
          <div class="schedule-gantt-block-head">
            <span class="schedule-gantt-block-time">${escapeScheduleHTML(`${formatClock(start)}–${formatClock(end)}`)}</span>
            ${flags}
          </div>
          <div class="schedule-gantt-block-title" title="${escapeScheduleHTML(titleLine)}">${escapeScheduleHTML(titleLine)}</div>
          ${compact ? '' : `<div class="schedule-gantt-block-meta">${escapeScheduleHTML(scope)} · ${escapeScheduleHTML(stage)}</div>`}
        </div>`;
    }).join('');
    return `<div class="schedule-gantt-track" data-venue="${venue.key}">${offBands}${inner}</div>`;
  }).join('');

  /* 列数由场地资源数决定：新增场地自动多一列，不用改 CSS。
     ⚠️ repeat() 的「次数」不能写成 var()，所以整串轨道尺寸由 JS 拼出来：
        ① 写到 --gantt-columns（CSS 里用 var() 读）
        ② 同时内联到 head / body 上 —— 万一某浏览器对 var() 整串替换解析失败，
           内联的 grid-template-columns 也能兜住，绝不会退化成单列垂直堆叠。
     列宽下限给到 120px：场地多时列可以收缩自适应，不至于把时间轴挤出屏幕。 */
  const ganttColumns = `64px repeat(${VENUE_RESOURCES.length}, minmax(120px, 1fr))`;
  return `<div class="schedule-gantt" style="--gantt-height:${totalHeight}px;--gantt-tick-px:${GANTT_TICK_MINUTES * px}px;--gantt-columns:${ganttColumns}">
      <div class="schedule-gantt-head" style="grid-template-columns:${ganttColumns}">
        <div class="schedule-gantt-axis-head">时间</div>
        ${VENUE_RESOURCES.map(venue => `<div class="schedule-gantt-venue-head tone-${venue.tone}">
            <span>${venue.icon} ${escapeScheduleHTML(venue.name)}</span>
            <small>${escapeScheduleHTML(venue.note)}</small>
          </div>`).join('')}
      </div>
      <div class="schedule-gantt-body" style="grid-template-columns:${ganttColumns}">
        <div class="schedule-gantt-axis">${ticks}</div>
        ${blocks}
      </div>
    </div>`;
}

/** 这一天是不是只排半天（.5 天的最后一天只有上午）→ 返回说明文案 */
function halfDayNote(dayKey, sessions) {
  const daySessions = sessionsForDate(sessions, dayKey);
  return daySessions.length === 1 ? ` · 半天（${daySessions[0]?.label || '上午'}）` : '';
}

/** 某一天的 Tab 文案：第 N 天 · 05/21；半天会标出来，免得老师以为漏排了下午 */
function dayTabLabel(dayKey, ordinal, sessions) {
  return `第 ${ordinal} 天 · ${String(dayKey).slice(5).replace('-', '/')}${halfDayNote(dayKey, sessions)}`;
}

/**
 * 多日 Tab：全部 / 第 1 天 … 第 4 天 —— 按实际设置的总天数动态生成，
 * 哪怕某天没排上项目（前面几天就排完了）也照样给一个 Tab，标 0 项，不偷偷藏起来。
 */
function renderDayTabs(dayKeys, entries, sessions = []) {
  if (dayKeys.length < 2) return '';
  const countOf = key => entries.filter(entry => dayKeyOf(entry) === key).length;
  const tab = (value, label, count) => `<button type="button" role="tab"
      class="schedule-day-tab${scheduleDayFilter === value ? ' active' : ''}"
      aria-selected="${scheduleDayFilter === value}"
      onclick="setScheduleDay('${escapeScheduleHTML(value)}')">${escapeScheduleHTML(label)}<span>${count} 项</span></button>`;
  return `${tab('all', '全部', entries.length)}${dayKeys.map((key, index) =>
    tab(key, dayTabLabel(key, index + 1, sessions), countOf(key))).join('')}`;
}

function setScheduleDay(value) {
  scheduleDayFilter = value;
  renderSchedule();
}

/**
 * 某一天的甘特图（带缓存）：切 Tab、切年级 / 性别时，只要这一天的项目和冲突没变，
 * 就直接复用上次的 HTML，不再重拼一遍 —— 4 天的大赛程来回切也不卡。
 */
function ganttDayHTML(dayKey, dayEntries, daySessions, conflictInfo) {
  const cacheKey = [
    scheduleRenderToken, dayKey, scheduleGradeFilter, scheduleGenderFilter,
    conflictInfo.recoveryMinutes, dayEntries.length, conflictInfo.eventIds.size,
  ].join('|');
  const cached = GANTT_DAY_CACHE.get(cacheKey);
  if (cached) return cached;
  const html = renderGanttDay(dayEntries, daySessions, conflictInfo);
  GANTT_DAY_CACHE.set(cacheKey, html);
  return html;
}

/** 排不下的项目单独提示，老师一眼看到要加时间还是砍项目 */
function renderUnscheduledNotice(pending) {
  if (!pending?.length) return '';
  return `<div class="schedule-unscheduled">
    <strong>⏳ 有 ${pending.length} 个项目在设定的时段内排不下（未排到晚上）：</strong>
    <ul>${pending.map(item => `<li>${escapeScheduleHTML(`${item.grade ? `${item.grade}年级 · ` : ''}${normalizeGender(item.genderGroup)} · ${item.eventName} · ${item.venue}`)}</li>`).join('')}</ul>
    <span>延长上午 / 下午时段，或把田赛单项时长调短后重新生成即可。</span>
  </div>`;
}

/** 明细：四块场地各一列卡片（可改时间 / 场地、展开看名单） */
function renderVenueBooks(entries, conflictInfo) {
  return `<div class="schedule-lanes">${VENUE_RESOURCES.map(venue => {
    const list = entries.filter(entry => venueKeyOf(entry) === venue.key);
    return `<section class="schedule-lane">
      <header class="schedule-lane-header">
        <h2>${venue.icon} ${escapeScheduleHTML(venue.name)}</h2>
        <span>${escapeScheduleHTML(venue.note)} · ${list.length} 个时段</span>
      </header>
      <div class="schedule-lane-body">${renderScheduleLane(list, conflictInfo, venue)}</div>
    </section>`;
  }).join('')}</div>`;
}

function renderSchedule() {
  const ganttBox = document.getElementById('scheduleGantt');
  const booksBox = document.getElementById('scheduleVenueBooks');
  const tabsBox = document.getElementById('scheduleDayTabs');
  const conflictInfo = findScheduleConflicts(currentSchedule, { recoveryMinutes: savedRecoveryMinutes() });
  renderConflictSummary(conflictInfo);

  if (!currentSchedule.length) {
    ganttBox.innerHTML = '<div class="meet-empty">暂无项目。确认赛程参数并生成编排。</div>';
    booksBox.innerHTML = '';
    if (tabsBox) tabsBox.innerHTML = '';
    document.getElementById('scheduleSummary').textContent = meetData.registrations.length
      ? `已读取 ${meetData.registrations.length} 条单项报名`
      : '尚未生成赛程';
    return;
  }

  const filtered = [...currentSchedule]
    .filter(entry => (scheduleGradeFilter === 'all' || String(entry.grade || '') === scheduleGradeFilter) &&
      (scheduleGenderFilter === 'all' || entry.genderGroup === scheduleGenderFilter))
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const scheduleDate = meetData.schedule?.settings?.date || filtered[0]?.startAt.slice(0, 10) || '';
  const filterLabel = `${scheduleGradeFilter === 'all' ? '全部年级' : `${scheduleGradeFilter}年级`} · ${scheduleGenderFilter === 'all' ? '全部性别' : normalizeGender(scheduleGenderFilter)}`;
  if (!filtered.length) {
    ganttBox.innerHTML = '<div class="meet-empty">当前年级和性别筛选下没有赛程。</div>';
    booksBox.innerHTML = '';
    if (tabsBox) tabsBox.innerHTML = '';
    document.getElementById('scheduleSummary').textContent =
      `${scheduleDate} · 当前筛选无比赛 · 共 ${currentSchedule.length} 个时段`;
    return;
  }

  // 重新渲染前彻底清空旧节点，防止 DOM 叠加把容器越撑越高
  ganttBox.innerHTML = '';
  booksBox.innerHTML = '';
  if (tabsBox) tabsBox.innerHTML = '';

  const sessions = currentSessions();
  const dayKeys = [...new Set(filtered.map(dayKeyOf))].sort();
  // Tab 按「设置的总天数」生成：把计划里的日期（哪怕还没排项目）也列出来
  const plannedDayKeys = [...new Set(sessions.map(session => session?.dateKey).filter(Boolean))].sort();
  const allDayKeys = [...new Set([...dayKeys, ...plannedDayKeys])].sort();
  if (scheduleDayFilter !== 'all' && !allDayKeys.includes(scheduleDayFilter)) scheduleDayFilter = 'all';
  const shown = scheduleDayFilter === 'all'
    ? filtered
    : filtered.filter(entry => dayKeyOf(entry) === scheduleDayFilter);

  if (tabsBox) tabsBox.innerHTML = renderDayTabs(allDayKeys, filtered, sessions);

  // 「全部」只画真正有项目的那天；单独点某一天时照样能点开（空的会给一句说明，不画空甘特图）
  const daysToRender = scheduleDayFilter === 'all' ? dayKeys : [scheduleDayFilter];
  ganttBox.innerHTML = daysToRender.map(key => {
    const dayEntries = filtered.filter(entry => dayKeyOf(entry) === key);
    const daySessions = sessionsForDate(sessions, key);
    const ordinal = allDayKeys.indexOf(key) + 1;   // 只看某一天时，序号仍按全局天数算
    if (!dayEntries.length) {
      return `<section class="schedule-day-block">
        <header class="schedule-day-head">
          <h3>第 ${ordinal} 天 · ${escapeScheduleHTML(key)}${escapeScheduleHTML(halfDayNote(key, sessions))}</h3>
          <span>0 个时段 · 前面的比赛日已排完，这天不用比</span>
        </header>
        <div class="meet-empty">该比赛日没有安排项目。</div>
      </section>`;
    }
    const firstStart = Math.min(...dayEntries.map(entry => new Date(entry.startAt).getTime()));
    const lastEnd = Math.max(...dayEntries.map(entry =>
      new Date(entry.startAt).getTime() + entry.durationMinutes * 60000));
    return `<section class="schedule-day-block">
        <header class="schedule-day-head">
          <h3>第 ${ordinal} 天 · ${escapeScheduleHTML(key)}${escapeScheduleHTML(halfDayNote(key, sessions))}</h3>
          <span>${dayEntries.length} 个时段 · ${escapeScheduleHTML(formatClock(new Date(firstStart)))} 开赛 · ${escapeScheduleHTML(formatClock(new Date(lastEnd)))} 结束</span>
        </header>
        ${ganttDayHTML(key, dayEntries, daySessions, conflictInfo)}
      </section>`;
  }).join('') + renderUnscheduledNotice(getUnscheduledEvents());
  booksBox.innerHTML = renderVenueBooks(shown, conflictInfo);

  const sessionLabel = sessionsForDate(sessions, dayKeys[0])
    .map(session => `${session.label || ''}${formatClock(session.start)}-${formatClock(session.end)}`).join(' / ');
  document.getElementById('scheduleSummary').textContent =
    `${scheduleDate} 起 ${dayKeys.length} 天 · ${sessionLabel} · ${filterLabel} · 共 ${filtered.length} 个时段`
    + (conflictInfo.details.length ? ` · ⚠ ${conflictInfo.details.length} 人兼项冲突` : '');
  requestGanttStickySync();          // 内容变了，吸顶位置要重新算
}

/* ---------- 甘特图表头吸顶（iframe 嵌套时用 JS 同步父窗口滚动） ---------- */
/**
 * 独立打开（schedule.html）时，CSS 的 position: sticky 天然跟随窗口滚动；
 * 被 sports-meet.html 用 iframe 嵌套时是「父页整页滚动、iframe 自身不滚动」，
 * 浏览器不会让 iframe 内的 sticky 跟随父窗口，所以这里用 transform 手动同步：
 * 表头吸在视口顶部，时间刻度标签只在自己那 30 分钟的槽里跟随。
 */
const GANTT_STICKY = { frame: null, pending: 0 };

function findHostFrame() {
  try {
    if (window.parent === window) return null;
    return [...window.parent.document.querySelectorAll('iframe')]
      .find(frame => frame.contentWindow === window) || null;
  } catch (error) {
    return null;      // 跨域等场景直接放弃，交给 CSS 兜底
  }
}

function syncGanttSticky() {
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (window.parent === window) return;   // 独立页：CSS sticky 原生生效
    const search = String(window.location?.search || '');
    if (new URLSearchParams(search).get('embed') !== '1') return;
    syncGanttStickyInner();
  } catch (error) {
    /* 跨域 / 拿不到父窗口时静默放弃，交给 CSS 兜底 */
  }
}

function syncGanttStickyInner() {
  const frame = GANTT_STICKY.frame || (GANTT_STICKY.frame = findHostFrame());
  if (!frame) return;
  const frameTop = frame.getBoundingClientRect().top;
  document.querySelectorAll('.schedule-gantt').forEach(gantt => {
    const head = gantt.querySelector('.schedule-gantt-head');
    if (!head) return;
    const ganttRect = gantt.getBoundingClientRect();
    const top = frameTop + ganttRect.top;              // 甘特图顶部相对父窗口视口
    const bottom = top + ganttRect.height;
    const headHeight = head.offsetHeight;
    const shift = top < 0 && bottom > headHeight + 4
      ? Math.min(-top, bottom - headHeight) : 0;
    head.style.transform = shift ? `translateY(${shift}px)` : '';

    gantt.querySelectorAll('.schedule-gantt-tick-slot').forEach(slot => {
      const label = slot.firstElementChild;
      if (!label) return;
      const slotTop = top + (slot.getBoundingClientRect().top - ganttRect.top);
      const maxShift = Math.max(0, slot.offsetHeight - label.offsetHeight);
      const labelShift = slotTop < headHeight ? Math.min(headHeight - slotTop, maxShift) : 0;
      label.style.transform = labelShift ? `translateY(${labelShift}px)` : '';
    });
  });
}

function requestGanttStickySync() {
  if (typeof requestAnimationFrame !== 'function') return;
  cancelAnimationFrame(GANTT_STICKY.pending);
  GANTT_STICKY.pending = requestAnimationFrame(syncGanttSticky);
}

/** 父页滚动 / 改变尺寸时同步一次（只在 iframe 里生效） */
function bindGanttStickySync() {
  try {
    if (window.parent === window) return;
    window.parent.addEventListener('scroll', requestGanttStickySync, { passive: true });
    window.parent.addEventListener('resize', requestGanttStickySync);
    requestGanttStickySync();
  } catch (error) { /* 跨域时忽略 */ }
}

function updateScheduleFilters() {
  scheduleGradeFilter = document.getElementById('scheduleGradeFilter').value;
  scheduleGenderFilter = document.getElementById('scheduleGenderFilter').value;
  renderSchedule();
}

function renderScheduleLane(entries, conflictInfo, venue = VENUE_RESOURCES[0]) {
  if (!entries.length) return '<div class="meet-empty">该场地暂无编排项目。</div>';
  // 体能恢复不足：按条目记「谁还没歇够」——卡片上直接写清楚，老师不用去甘特图里找
  const recoveryNotes = new Map();
  (conflictInfo?.recoveryDetails || []).forEach(detail => {
    const note = `${detail.athlete?.name || '未知运动员'} 刚跑完长距离径赛，仅间隔 ${detail.gapMinutes} 分钟，`
      + `还需再休息 ${detail.neededMinutes} 分钟`;
    detail.entries.forEach(entry => {
      recoveryNotes.set(entry.id, [...(recoveryNotes.get(entry.id) || []), note]);
    });
  });
  return `
    <div class="schedule-timeline">
      ${entries.map((entry, index) => {
        const startTime = new Date(entry.startAt);
        const checkinTime = addMinutes(startTime, -entry.checkinMinutes);
        const conflicted = conflictInfo.eventIds.has(entry.id);
        const recoveryRisk = conflictInfo.recoveryEventIds?.has(entry.id);
        const modeLabel = venue.key === 'track'
          ? roundLabel(entry)
          : `出场顺序${entry.fieldOrderMode === 'random' ? '（随机）' : '（按班级轮流）'}`;
        return `<article class="schedule-event-card ${conflicted ? 'schedule-conflict-card' : ''}${recoveryRisk ? ' schedule-recovery-card' : ''}">
          <div class="schedule-event-time">
            <span class="schedule-time-range">${escapeScheduleHTML(formatClock(startTime))}–${escapeScheduleHTML(formatClock(scheduleEnd(entry)))}</span>
            <span class="schedule-checkin">检录 ${escapeScheduleHTML(formatClock(checkinTime))}</span>
          </div>
          <div class="schedule-event-content">
            <div class="schedule-event-title">
              <strong>${escapeScheduleHTML(entry.eventName)}</strong>
              <span class="meet-muted">${entry.grade ? `${entry.grade}年级 · ` : ''}${escapeScheduleHTML(normalizeGender(entry.genderGroup))} · ${escapeScheduleHTML(modeLabel)}</span>
            </div>
            ${conflicted ? '<span class="schedule-warning">⚠ 需要手动调整</span>' : ''}
            ${(recoveryNotes.get(entry.id) || []).map(note => `<span class="schedule-warning schedule-recovery">💤 ${escapeScheduleHTML(note)}</span>`).join('')}
            ${entry.needsFlex ? '<span class="schedule-warning schedule-flex">🕒 需插空进行（兼项避让不开，请现场机动）</span>' : ''}
            <label class="schedule-inline-edit">开始时间
              <input class="schedule-datetime" aria-label="${escapeScheduleHTML(entry.eventName)}比赛时间"
                type="datetime-local" value="${escapeScheduleHTML(entry.startAt)}"
                onchange="updateScheduleEntry('${escapeScheduleHTML(entry.id)}','startAt',this.value)">
              <span class="schedule-print-value">${escapeScheduleHTML(formatTimelineMoment(startTime))} - ${escapeScheduleHTML(formatTimelineMoment(scheduleEnd(entry)))}</span>
            </label>
            <label class="schedule-inline-edit">场地
              <input class="schedule-venue" aria-label="${escapeScheduleHTML(entry.eventName)}比赛场地"
                value="${escapeScheduleHTML(entry.venue)}"
                onchange="updateScheduleEntry('${escapeScheduleHTML(entry.id)}','venue',this.value)">
              <span class="schedule-print-value">${escapeScheduleHTML(entry.venue)}</span>
            </label>
            <details class="schedule-roster-details">
              <summary>运动员 / 出场顺序（${entry.participantIds.length || '待定'}）</summary>
              <div class="schedule-participants">${renderParticipantList(entry, conflictInfo?.recoveryAthleteIds)}</div>
            </details>
          </div>
        </article>`;
      }).join('')}
    </div>
  `;
}

function printSchedule() {
  if (!currentSchedule.length) {
    showScheduleError('请先生成赛程，再打印或导出 PDF。');
    return;
  }
  window.print();
}

function exportScheduleWord() {
  if (!currentSchedule.length) {
    showScheduleError('请先生成赛程，再导出 Word 秩序册。');
    return;
  }
  const conflictInfo = findScheduleConflicts(currentSchedule, { recoveryMinutes: savedRecoveryMinutes() });
  const athleteById = new Map(meetData.athletes.map(athlete => [athlete.id, athlete]));
  const rows = [...currentSchedule].sort((a, b) => new Date(a.startAt) - new Date(b.startAt)).map((entry, index) => {
    const startTime = new Date(entry.startAt);
    const checkinTime = addMinutes(startTime, -entry.checkinMinutes);
    const roster = entry.participantIds?.length
      ? entry.participantIds.map(id => athleteById.get(id)).filter(Boolean)
        .map((athlete, rosterIndex) => `${rosterIndex + 1}. ${athlete.bibNumber || '—'} ${athlete.name}（${athlete.className}）`).join('；')
      : entry.participantLabel;
    const stage = entry.eventType === 'track'
      ? roundLabel(entry)
      : `田赛出场顺序（${entry.fieldOrderMode === 'random' ? '随机' : '按班级轮流'}）`;
    const warning = [
      conflictInfo.eventIds.has(entry.id) ? '⚠ 需要手动调整' : '',
      entry.needsFlex ? '🕒 需插空进行' : '',
    ].filter(Boolean).join(' ');
    const lane = entry.venue || venueByKey(venueKeyOf(entry)).name;
    return `<tr><td>${index + 1}</td><td>${escapeScheduleHTML(lane)}</td><td>${entry.grade || '—'}年级</td><td>${escapeScheduleHTML(formatTimelineMoment(startTime))} - ${escapeScheduleHTML(formatTimelineMoment(scheduleEnd(entry)))}</td><td>${escapeScheduleHTML(formatTimelineMoment(checkinTime))}</td><td>${escapeScheduleHTML(entry.eventName)} · ${escapeScheduleHTML(normalizeGender(entry.genderGroup))} · ${escapeScheduleHTML(stage)}</td><td>${escapeScheduleHTML(roster)}</td><td>${warning}</td></tr>`;
  }).join('');
  const conflictText = conflictInfo.details.map(conflict =>
    `${conflict.athlete?.name || '未知运动员'}：${conflict.entries.map(entry => `${entry.eventName} ${roundLabel(entry)}`).join('、')}`,
  ).join('；');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#222}h1{text-align:center}
    table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:7px;text-align:left;vertical-align:top}
    th{background:#eee}.warning{color:#b91c1c;font-weight:bold}
  </style></head><body>
    <h1>运动会秩序册</h1><p>比赛日期：${escapeScheduleHTML(meetData.schedule?.settings?.date || '')}</p>
    ${conflictText ? `<p class="warning">需要手动调整：${escapeScheduleHTML(conflictText)}</p>` : ''}
    <table><thead><tr><th>#</th><th>场地</th><th>年级</th><th>比赛时间</th><th>检录时间</th><th>项目 / 性别 / 轮次</th><th>运动员 / 出场顺序</th><th>冲突</th></tr></thead><tbody>${rows}</tbody></table>
  </body></html>`;
  const blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `运动会秩序册-${meetData.schedule?.settings?.date || '赛程'}.doc`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 把保存的配置写回表单（天数 + 上午 / 下午时段；脏数据退回默认值） */
function applySettingsToForm(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const legacy = Array.isArray(source.sessions) ? source.sessions : [];
  const legacyTime = (key, field, fallback) => {
    const hit = legacy.find(session => session?.key === key || session?.label === (key === 'morning' ? '上午' : '下午'));
    const value = String(hit?.[field] ?? '').trim();
    return TIME_PATTERN.test(value) ? value : fallback;
  };
  const time = (field, fallback) => (TIME_PATTERN.test(String(source[field] ?? '').trim())
    ? String(source[field]).trim()
    : fallback);
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.value = value;
  };
  set('morningStart', time('morningStart', legacyTime('morning', 'start', DEFAULT_SESSIONS[0].start)));
  set('morningEnd', time('morningEnd', legacyTime('morning', 'end', DEFAULT_SESSIONS[0].end)));
  set('afternoonStart', time('afternoonStart', legacyTime('afternoon', 'start', DEFAULT_SESSIONS[1].start)));
  set('afternoonEnd', time('afternoonEnd', legacyTime('afternoon', 'end', DEFAULT_SESSIONS[1].end)));
  // 老配置没有 days：按保存的时段数量反推（2 段 = 1 天，3 段 = 1.5 天…）
  const inferredDays = legacy.length ? legacy.length / 2 : DEFAULT_DAY_TOTAL;
  set('scheduleDayTotal', String(normalizeDayTotal(source.days ?? inferredDays)));
}

function initializeSchedulePage() {
  meetData = readMeetData();
  const today = new Date();
  const pad = value => String(value).padStart(2, '0');
  document.getElementById('scheduleDate').value =
    `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  document.getElementById('scheduleLaneCount').value = String(
    TRACK_LANE_OPTIONS.includes(meetData.laneCount) ? meetData.laneCount : DEFAULT_TRACK_LANES,
  );
  document.getElementById('scheduleGradeFilter').value = scheduleGradeFilter;
  document.getElementById('scheduleGenderFilter').value = scheduleGenderFilter;
  renderEventFormatList();
  const savedSchedule = meetData.schedule;
  if (savedSchedule?.settings && Array.isArray(savedSchedule.entries)) {
    const {
      date,
      trackDurationMinutes,
      fieldDurationMinutes,
      durationMinutes,
      laneCount,
      fieldOrderMode: savedOrder,
    } = savedSchedule.settings;
    if (date) document.getElementById('scheduleDate').value = date;
    applySettingsToForm(savedSchedule.settings);
    if (Number.isInteger(trackDurationMinutes)) document.getElementById('trackDuration').value = trackDurationMinutes;
    else if (Number.isInteger(durationMinutes)) document.getElementById('trackDuration').value = durationMinutes;
    if (Number.isInteger(fieldDurationMinutes)) document.getElementById('fieldDuration').value = fieldDurationMinutes;
    if (TRACK_LANE_OPTIONS.includes(laneCount)) document.getElementById('scheduleLaneCount').value = String(laneCount);
    if (['class', 'random'].includes(savedOrder)) {
      fieldOrderMode = savedOrder;
      document.getElementById('fieldOrderMode').value = savedOrder;
    }
    if (savedSchedule.entries.some(entry => !Number.isInteger(entry.grade))) {
      currentSchedule = [];
      bumpScheduleRenderToken();
      meetData = { ...freshMeetData(), schedule: null };   // 只作废赛程，报名数据原样保留
      try {
        Store.write(MEET_STORAGE_KEY, meetData);
        showScheduleError('检测到旧版未按年级隔离的赛程，已作废。请重新生成赛程，确保年级和性别分组正确。');
      } catch (error) {
        showScheduleError(`旧版赛程已在当前页面作废，但无法更新本地存储：${error.message}`);
      }
    } else {
      currentSchedule = savedSchedule.entries;
      bumpScheduleRenderToken();
    }
  }
  if (scheduleStorageError) showScheduleError(scheduleStorageError);
  renderSchedule();
}

Store.onReady(() => {
  initializeSchedulePage();
  bindGanttStickySync();     // iframe 内：让甘特图表头跟着父页滚动吸顶
  bindCrossModuleMeetSync();
});

/**
 * 跨模块同步：报名页（另一个 iframe）导入 / 改了报名数据后，本页内存里的 meetData 就过期了。
 * 不刷新的话，下一次保存赛程会拿旧快照整体写回，把报名数据冲掉。
 * 这里收到通知就重取，只更新数据；赛程本身变了才重画甘特图。
 */
function bindCrossModuleMeetSync() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const changedByOthers = event => Boolean(event?.detail?.changed?.includes?.(MEET_STORAGE_KEY));
  const refresh = () => {
    const latest = readMeetData();
    /* ⛔ 反向清空防线：对方此刻读到的是空值（多半是它还在初始化、时序上先拿到了空），
       而本页内存里有报名数据 —— 绝不接受，否则等于让它把数据清掉。 */
    if (!latest.athletes?.length && !latest.registrations?.length
      && (meetData?.athletes?.length || meetData?.registrations?.length)) {
      console.warn('[赛程编排] 忽略其它页面传来的空报名数据，保留本地现有数据');
      return;
    }
    const scheduleChanged = JSON.stringify(latest.schedule) !== JSON.stringify(meetData?.schedule);
    meetData = { ...latest, eventFormats: meetData?.eventFormats || latest.eventFormats };
    if (!scheduleChanged) return;
    currentSchedule = Array.isArray(latest.schedule?.entries) ? latest.schedule.entries : [];
    bumpScheduleRenderToken();
    if (document.getElementById('scheduleGantt')) renderSchedule();
  };
  // 同文档（Store 内部派发）+ 父 / 顶层窗口转发过来的事件
  window.addEventListener('store:sync', event => { if (changedByOthers(event)) refresh(); });
  // 同源其它文档改了 localStorage（Store 内部已更新缓存，这里只需刷内存快照）
  window.addEventListener('storage', event => {
    if (event?.key === MEET_STORAGE_KEY) refresh();
  });
  /* 🚨 控制台 window.forceRecover() 的强行恢复事件：无条件重取重画 */
  window.addEventListener('store:recovered', refresh);
}
