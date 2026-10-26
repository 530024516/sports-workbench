'use strict';

Layout.init('schedule', '运动会赛程编排', '赛程编排');

const MEET_STORAGE_KEY = 'pe_sports_meet_v1';
const DEFAULT_TRACK_LANES = 8;
const DEFAULT_CHECKIN_MINUTES = 15;
let meetData;
let currentSchedule = [];
let fieldOrderMode = 'class';
let scheduleStorageError = '';
let scheduleGradeFilter = 'all';
let scheduleGenderFilter = 'all';

const pageContent = document.getElementById('page-content');
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
        <label>首项比赛时间 <input id="scheduleStart" type="time" value="09:00"></label>
        <label>径赛时段（分钟） <input id="trackDuration" type="number" min="5" max="240" step="5" value="20"></label>
        <label>田赛项目时长（分钟） <input id="fieldDuration" type="number" min="5" max="480" step="5" value="60"></label>
        <label>径赛跑道数
          <select id="scheduleLaneCount">
            <option value="6">6 道</option>
            <option value="7">7 道</option>
            <option value="8" selected>8 道</option>
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
      <p class="meet-guidance">按年级 + 性别 + 项目独立编排；径赛区与田赛区从同一时间并行开始，各自按赛区串行推进。检录时间默认为开赛前 15 分钟。跨赛区运动员会自动错开至少 15 分钟；生成后可编辑项目时间，冲突检测会即时更新。径赛晋级名单须待预赛成绩录入后确认。</p>
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
        <div class="schedule-lanes">
          <section class="schedule-lane">
            <header class="schedule-lane-header track-lane-header">
              <h2>🏃 径赛区</h2>
              <span>跑道 · 同场串行</span>
            </header>
            <div class="schedule-lane-body" id="trackScheduleBook"></div>
          </section>
          <section class="schedule-lane">
            <header class="schedule-lane-header field-lane-header">
              <h2>🏅 田赛区</h2>
              <span>田赛场地 · 同场串行</span>
            </header>
            <div class="schedule-lane-body" id="fieldScheduleBook"></div>
          </section>
        </div>
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

function persistSchedule(nextSchedule, settings) {
  if (scheduleStorageError) {
    showScheduleError(scheduleStorageError);
    return false;
  }
  try {
    const updatedData = {
      ...meetData,
      schedule: {
        version: 1,
        settings,
        entries: nextSchedule,
      },
    };
    Store.write(MEET_STORAGE_KEY, updatedData);
    meetData = updatedData;
    currentSchedule = nextSchedule;
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

function splitIntoHeats(athleteIds, laneCount) {
  const numberOfHeats = Math.ceil(athleteIds.length / laneCount);
  const heats = Array.from({ length: numberOfHeats }, () => []);
  const ordered = distributeByClass(athleteIds);
  ordered.forEach((athleteId, index) => heats[index % numberOfHeats].push(athleteId));
  return heats;
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

function makeScheduleEntry(event, round, groupNumber, participantIds, startAt, duration, venue, options = {}) {
  return {
    id: scheduleId(),
    eventKey: event.key,
    eventName: event.eventName,
    genderGroup: event.genderGroup,
    grade: event.grade,
    eventType: event.eventType,
    round,
    groupNumber,
    participantIds,
    participantLabel: options.participantLabel || '',
    qualifyingCount: options.qualifyingCount || 0,
    fieldOrderMode: options.fieldOrderMode || '',
    startAt: formatDateTimeLocal(startAt),
    durationMinutes: duration,
    checkinMinutes: DEFAULT_CHECKIN_MINUTES,
    venue,
  };
}

function hasCrossVenueConflict(athleteIds, startAt, duration, scheduledEntries, venueType) {
  const participantIds = new Set(athleteIds);
  const proposedStart = startAt.getTime();
  const proposedEnd = proposedStart + duration * 60000;
  const buffer = DEFAULT_CHECKIN_MINUTES * 60000;

  return scheduledEntries.some(entry => {
    if (entry.eventType === venueType || !entry.participantIds?.length) return false;
    const sharedAthlete = entry.participantIds.some(id => participantIds.has(id));
    if (!sharedAthlete) return false;
    const entryStart = new Date(entry.startAt).getTime();
    const entryEnd = entryStart + entry.durationMinutes * 60000;
    return proposedStart < entryEnd + buffer && entryStart < proposedEnd + buffer;
  });
}

function findNextConflictFreeStart(athleteIds, proposedStart, duration, scheduledEntries, venueType) {
  let candidate = new Date(proposedStart);
  let attempts = 0;
  while (hasCrossVenueConflict(athleteIds, candidate, duration, scheduledEntries, venueType)) {
    const overlaps = scheduledEntries.filter(entry => {
      if (entry.eventType === venueType || !entry.participantIds?.some(id => athleteIds.includes(id))) return false;
      const entryStart = new Date(entry.startAt).getTime();
      const entryEnd = entryStart + entry.durationMinutes * 60000;
      const candidateEnd = candidate.getTime() + duration * 60000;
      const buffer = DEFAULT_CHECKIN_MINUTES * 60000;
      return candidate.getTime() < entryEnd + buffer && entryStart < candidateEnd + buffer;
    });
    if (!overlaps.length) break;
    const nextBoundary = Math.max(...overlaps.map(entry =>
      new Date(entry.startAt).getTime() + entry.durationMinutes * 60000 + DEFAULT_CHECKIN_MINUTES * 60000,
    ));
    candidate = new Date(Math.max(candidate.getTime() + 60000, nextBoundary));
    attempts++;
    if (attempts > scheduledEntries.length + 1) break;
  }
  return candidate;
}

function buildSchedule(dateValue, startValue, trackDuration, fieldDuration, laneCount, orderMode) {
  const events = getUniqueEventRosters();
  const schedule = [];
  const startAt = toLocalDateTime(dateValue, startValue);
  let nextTrackStart = new Date(startAt);
  let nextFieldStart = new Date(startAt);

  events.forEach(event => {
    if (event.eventType === 'track') {
      if (event.athleteIds.length > laneCount) {
        const groups = existingPreliminaryGroups(event, laneCount);
        groups.forEach((athleteIds, index) => {
          const proposedStart = findNextConflictFreeStart(
            athleteIds, nextTrackStart, trackDuration, schedule, 'track',
          );
          schedule.push(makeScheduleEntry(
            event, 'preliminary', index + 1, athleteIds, proposedStart, trackDuration, '径赛区',
          ));
          nextTrackStart = addMinutes(proposedStart, trackDuration);
        });
        const finalStart = findNextConflictFreeStart(
          [], nextTrackStart, trackDuration, schedule, 'track',
        );
        schedule.push(makeScheduleEntry(
          event, 'final', 1, [], finalStart, trackDuration, '径赛区',
          { participantLabel: `预赛晋级选手（最多 ${laneCount} 人，待成绩确认）`, qualifyingCount: laneCount },
        ));
      } else {
        const finalStart = findNextConflictFreeStart(
          event.athleteIds, nextTrackStart, trackDuration, schedule, 'track',
        );
        schedule.push(makeScheduleEntry(event, 'final', 1, event.athleteIds, finalStart, trackDuration, '径赛区'));
      }
      nextTrackStart = addMinutes(new Date(schedule[schedule.length - 1].startAt), trackDuration);
      return;
    }

    const order = orderMode === 'random'
      ? shuffledIds(event.athleteIds)
      : distributeByClass(event.athleteIds);
    const fieldStart = findNextConflictFreeStart(
      order, nextFieldStart, fieldDuration, schedule, 'field',
    );
    schedule.push(makeScheduleEntry(
      event, 'field', 1, order, fieldStart, fieldDuration, '田赛区',
      { fieldOrderMode: orderMode },
    ));
    nextFieldStart = addMinutes(fieldStart, fieldDuration);
  });

  return schedule.sort((a, b) => new Date(a.startAt) - new Date(b.startAt) ||
    a.eventType.localeCompare(b.eventType) || a.groupNumber - b.groupNumber);
}

function validateSettings() {
  const date = document.getElementById('scheduleDate').value;
  const start = document.getElementById('scheduleStart').value;
  const trackDuration = Number(document.getElementById('trackDuration').value);
  const fieldDuration = Number(document.getElementById('fieldDuration').value);
  const lanes = Number(document.getElementById('scheduleLaneCount').value);
  const orderMode = document.getElementById('fieldOrderMode').value;
  if (!date || !start) return { error: '请先选择比赛日期和首项比赛时间。' };
  if (!Number.isInteger(trackDuration) || trackDuration < 5 || trackDuration > 240) {
    return { error: '径赛时段须为 5 至 240 分钟之间的整数。' };
  }
  if (!Number.isInteger(fieldDuration) || fieldDuration < 5 || fieldDuration > 480) {
    return { error: '田赛项目时长须为 5 至 480 分钟之间的整数。' };
  }
  if (![6, 7, 8].includes(lanes)) return { error: '径赛跑道数须为 6、7 或 8 道。' };
  return {
    settings: {
      date,
      start,
      trackDurationMinutes: trackDuration,
      fieldDurationMinutes: fieldDuration,
      laneCount: lanes,
      fieldOrderMode: orderMode,
    },
  };
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
  );
  persistSchedule(schedule, settings);
}

function formatClock(date) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function formatTimelineMoment(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(date)}`;
}

function scheduleEnd(entry) {
  return addMinutes(new Date(entry.startAt), entry.durationMinutes);
}

function findScheduleConflicts(schedule) {
  const conflicts = new Map();
  const athletes = new Map(meetData.athletes.map(athlete => [athlete.id, athlete]));
  for (let leftIndex = 0; leftIndex < schedule.length; leftIndex++) {
    const left = schedule[leftIndex];
    if (!left.participantIds?.length) continue;
    const leftStart = new Date(left.startAt).getTime();
    const leftEnd = leftStart + left.durationMinutes * 60000;
    for (let rightIndex = leftIndex + 1; rightIndex < schedule.length; rightIndex++) {
      const right = schedule[rightIndex];
      if (!right.participantIds?.length) continue;
      const rightStart = new Date(right.startAt).getTime();
      const rightEnd = rightStart + right.durationMinutes * 60000;
      const buffer = DEFAULT_CHECKIN_MINUTES * 60000;
      if (leftStart >= rightEnd + buffer || rightStart >= leftEnd + buffer) continue;
      const rightAthletes = new Set(right.participantIds);
      const shared = left.participantIds.filter(id => rightAthletes.has(id));
      shared.forEach(id => {
        const occurrences = conflicts.get(id) || [];
        occurrences.push(left.id, right.id);
        conflicts.set(id, occurrences);
      });
    }
  }
  return {
    eventIds: new Set([...conflicts.values()].flat()),
    details: [...conflicts.entries()].map(([athleteId, eventIds]) => ({
      athlete: athletes.get(athleteId),
      entries: [...new Set(eventIds)].map(id => schedule.find(entry => entry.id === id)).filter(Boolean),
    })),
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

function renderParticipantList(entry) {
  const athleteById = new Map(meetData.athletes.map(athlete => [athlete.id, athlete]));
  if (!entry.participantIds?.length) return escapeScheduleHTML(entry.participantLabel || '晋级名单待定');
  return entry.participantIds.map((id, index) => {
    const athlete = athleteById.get(id);
    if (!athlete) return '';
    const label = `${index + 1}. ${athlete.bibNumber || '—'} ${athlete.name}（${athlete.className}）`;
    return `<span class="schedule-participant">${escapeScheduleHTML(label)}</span>`;
  }).join('');
}

function renderConflictSummary(conflicts) {
  const container = document.getElementById('scheduleConflictSummary');
  if (!conflicts.details.length) {
    container.classList.remove('visible');
    container.innerHTML = '';
    return;
  }
  container.classList.add('visible');
  container.innerHTML = `
    <strong>⚠ 检测到运动员赛程冲突，以下项目需要手动调整：</strong>
    <ul>${conflicts.details.map(conflict => `
      <li>${escapeScheduleHTML(conflict.athlete?.name || '未知运动员')}（${escapeScheduleHTML(conflict.athlete?.className || '')}）：${conflict.entries.map(entry => `${escapeScheduleHTML(entry.eventName)} ${escapeScheduleHTML(roundLabel(entry))}`).join('、')}</li>
    `).join('')}</ul>
  `;
}

function roundLabel(entry) {
  if (entry.round === 'preliminary') return `预赛第${entry.groupNumber}组`;
  if (entry.round === 'final') return '决赛';
  return '田赛';
}

function renderSchedule() {
  const trackBook = document.getElementById('trackScheduleBook');
  const fieldBook = document.getElementById('fieldScheduleBook');
  const conflictInfo = findScheduleConflicts(currentSchedule);
  renderConflictSummary(conflictInfo);

  if (!currentSchedule.length) {
    const emptyMessage = '<div class="meet-empty">暂无项目。确认赛程参数并生成编排。</div>';
    trackBook.innerHTML = emptyMessage;
    fieldBook.innerHTML = emptyMessage;
    document.getElementById('scheduleSummary').textContent = meetData.registrations.length
      ? `已读取 ${meetData.registrations.length} 条单项报名`
      : '尚未生成赛程';
    return;
  }

  const sorted = [...currentSchedule]
    .filter(entry => (scheduleGradeFilter === 'all' || String(entry.grade || '') === scheduleGradeFilter) &&
      (scheduleGenderFilter === 'all' || entry.genderGroup === scheduleGenderFilter))
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const scheduleDate = meetData.schedule?.settings?.date || sorted[0]?.startAt.slice(0, 10) || '';
  if (!sorted.length) {
    const emptyMessage = '<div class="meet-empty">当前年级和性别筛选下没有赛程。</div>';
    trackBook.innerHTML = emptyMessage;
    fieldBook.innerHTML = emptyMessage;
    document.getElementById('scheduleSummary').textContent =
      `${scheduleDate} · 当前筛选无比赛 · 共 ${currentSchedule.length} 个时段`;
    return;
  }
  const trackEntries = sorted.filter(entry => entry.eventType === 'track');
  const fieldEntries = sorted.filter(entry => entry.eventType === 'field');
  const filterLabel = `${scheduleGradeFilter === 'all' ? '全部年级' : `${scheduleGradeFilter}年级`} · ${scheduleGenderFilter === 'all' ? '全部性别' : normalizeGender(scheduleGenderFilter)}`;
  document.getElementById('scheduleSummary').textContent =
    `${scheduleDate} · ${filterLabel} · 径赛 ${trackEntries.length} 个时段 · 田赛 ${fieldEntries.length} 个时段`;
  trackBook.innerHTML = renderScheduleLane(trackEntries, conflictInfo, 'track');
  fieldBook.innerHTML = renderScheduleLane(fieldEntries, conflictInfo, 'field');
}

function updateScheduleFilters() {
  scheduleGradeFilter = document.getElementById('scheduleGradeFilter').value;
  scheduleGenderFilter = document.getElementById('scheduleGenderFilter').value;
  renderSchedule();
}

function renderScheduleLane(entries, conflictInfo, laneType) {
  if (!entries.length) return '<div class="meet-empty">当前赛区暂无编排项目。</div>';
  return `
    <div class="schedule-timeline">
      ${entries.map((entry, index) => {
        const startTime = new Date(entry.startAt);
        const checkinTime = addMinutes(startTime, -entry.checkinMinutes);
        const conflicted = conflictInfo.eventIds.has(entry.id);
        const modeLabel = laneType === 'track'
          ? (entry.round === 'preliminary' ? `预赛第 ${entry.groupNumber} 组` : '决赛')
          : `出场顺序${entry.fieldOrderMode === 'random' ? '（随机）' : '（按班级轮流）'}`;
        return `<article class="schedule-event-card ${conflicted ? 'schedule-conflict-card' : ''}">
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
              <div class="schedule-participants">${renderParticipantList(entry)}</div>
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
  const conflictInfo = findScheduleConflicts(currentSchedule);
  const athleteById = new Map(meetData.athletes.map(athlete => [athlete.id, athlete]));
  const rows = [...currentSchedule].sort((a, b) => new Date(a.startAt) - new Date(b.startAt)).map((entry, index) => {
    const startTime = new Date(entry.startAt);
    const checkinTime = addMinutes(startTime, -entry.checkinMinutes);
    const roster = entry.participantIds?.length
      ? entry.participantIds.map(id => athleteById.get(id)).filter(Boolean)
        .map((athlete, rosterIndex) => `${rosterIndex + 1}. ${athlete.bibNumber || '—'} ${athlete.name}（${athlete.className}）`).join('；')
      : entry.participantLabel;
    const stage = entry.eventType === 'track'
      ? (entry.round === 'preliminary' ? `预赛第 ${entry.groupNumber} 组` : '决赛')
      : `田赛出场顺序（${entry.fieldOrderMode === 'random' ? '随机' : '按班级轮流'}）`;
    const warning = conflictInfo.eventIds.has(entry.id) ? '⚠ 需要手动调整' : '';
    const lane = entry.eventType === 'track' ? '径赛区' : '田赛区';
    return `<tr><td>${index + 1}</td><td>${escapeScheduleHTML(lane)}</td><td>${entry.grade || '—'}年级</td><td>${escapeScheduleHTML(formatTimelineMoment(startTime))} - ${escapeScheduleHTML(formatTimelineMoment(scheduleEnd(entry)))}</td><td>${escapeScheduleHTML(formatTimelineMoment(checkinTime))}</td><td>${escapeScheduleHTML(entry.eventName)} · ${escapeScheduleHTML(normalizeGender(entry.genderGroup))} · ${escapeScheduleHTML(stage)}</td><td>${escapeScheduleHTML(entry.venue)}</td><td>${escapeScheduleHTML(roster)}</td><td>${warning}</td></tr>`;
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
    <table><thead><tr><th>#</th><th>赛区</th><th>年级</th><th>比赛时间</th><th>检录时间</th><th>项目 / 性别 / 轮次</th><th>场地</th><th>运动员 / 出场顺序</th><th>冲突</th></tr></thead><tbody>${rows}</tbody></table>
  </body></html>`;
  const blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `运动会秩序册-${meetData.schedule?.settings?.date || '赛程'}.doc`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initializeSchedulePage() {
  meetData = readMeetData();
  const today = new Date();
  const pad = value => String(value).padStart(2, '0');
  document.getElementById('scheduleDate').value =
    `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  document.getElementById('scheduleLaneCount').value = String(
    [6, 7, 8].includes(meetData.laneCount) ? meetData.laneCount : DEFAULT_TRACK_LANES,
  );
  document.getElementById('scheduleGradeFilter').value = scheduleGradeFilter;
  document.getElementById('scheduleGenderFilter').value = scheduleGenderFilter;
  const savedSchedule = meetData.schedule;
  if (savedSchedule?.settings && Array.isArray(savedSchedule.entries)) {
    const {
      date,
      start,
      trackDurationMinutes,
      fieldDurationMinutes,
      durationMinutes,
      laneCount,
      fieldOrderMode: savedOrder,
    } = savedSchedule.settings;
    if (date) document.getElementById('scheduleDate').value = date;
    if (start) document.getElementById('scheduleStart').value = start;
    if (Number.isInteger(trackDurationMinutes)) document.getElementById('trackDuration').value = trackDurationMinutes;
    else if (Number.isInteger(durationMinutes)) document.getElementById('trackDuration').value = durationMinutes;
    if (Number.isInteger(fieldDurationMinutes)) document.getElementById('fieldDuration').value = fieldDurationMinutes;
    if ([6, 7, 8].includes(laneCount)) document.getElementById('scheduleLaneCount').value = String(laneCount);
    if (['class', 'random'].includes(savedOrder)) {
      fieldOrderMode = savedOrder;
      document.getElementById('fieldOrderMode').value = savedOrder;
    }
    if (savedSchedule.entries.some(entry => !Number.isInteger(entry.grade))) {
      currentSchedule = [];
      meetData = { ...meetData, schedule: null };
      try {
        Store.write(MEET_STORAGE_KEY, meetData);
        showScheduleError('检测到旧版未按年级隔离的赛程，已作废。请重新生成赛程，确保年级和性别分组正确。');
      } catch (error) {
        showScheduleError(`旧版赛程已在当前页面作废，但无法更新本地存储：${error.message}`);
      }
    } else {
      currentSchedule = savedSchedule.entries;
    }
  }
  if (scheduleStorageError) showScheduleError(scheduleStorageError);
  renderSchedule();
}

Store.ready.then(() => {
  initializeSchedulePage();
});
