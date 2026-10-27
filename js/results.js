'use strict';

Layout.init('results', '运动会成绩管理', '成绩管理');

const RESULTS_STORAGE_KEY = 'pe_sports_meet_v1';
const POINTS_BY_RANK = [9, 7, 6, 5, 4, 3, 2, 1];
const FIELD_ATTEMPT_COUNT = 6;
let resultsData;
let resultsError = '';
let selectedResultEvent = '';
let selectedFieldUnit = 'm';
let resultGradeFilter = 'all';
let resultGenderFilter = 'all';

document.getElementById('page-content').innerHTML = `
  <div class="card result-entry-card">
    <div class="card-header meet-toolbar">
      <div>
        <div class="card-title"><span>🏆</span> 成绩录入</div>
        <div class="card-subtitle">选择比赛项目，录入成绩后自动排名并计算积分</div>
      </div>
      <label class="result-event-picker">比赛项目
        <div class="result-event-filters">
          <select id="resultGradeFilter" aria-label="筛选成绩年级" onchange="updateResultFilters()">
            <option value="all">全部年级</option>
            <option value="1">一年级</option><option value="2">二年级</option>
            <option value="3">三年级</option><option value="4">四年级</option>
            <option value="5">五年级</option><option value="6">六年级</option>
          </select>
          <select id="resultGenderFilter" aria-label="筛选成绩性别" onchange="updateResultFilters()">
            <option value="all">全部性别</option><option value="male">男子组</option><option value="female">女子组</option>
          </select>
          <select id="resultEventSelect" aria-label="选择比赛项目" onchange="selectResultEvent(this.value)"></select>
        </div>
      </label>
    </div>
    <div class="card-body">
      <div class="meet-alert" id="resultsStorageAlert" role="alert"></div>
      <div class="result-guidance" id="resultGuidance"></div>
      <div id="resultEntryPanel"></div>
    </div>
  </div>

  <div class="grid grid-3 result-summary" id="resultSummary"></div>

  <div class="card result-export-card">
    <div class="card-header">
      <div>
        <div class="card-title"><span>📤</span> 报表导出</div>
        <div class="card-subtitle">导出文件为 UTF-8 CSV，可直接使用 Excel 打开；包含全部年级和性别组别</div>
      </div>
    </div>
    <div class="card-body result-export-actions">
      <button class="btn btn-secondary" onclick="exportResultsBook()">导出成绩册（各项目前 8 名）</button>
      <label class="result-export-sort">颁奖名单排序
        <select id="awardSortOrder" aria-label="颁奖名单排序方式">
          <option value="grade">按年级、班级</option>
          <option value="class">按班级、年级</option>
        </select>
      </label>
      <button class="btn btn-secondary" onclick="exportAwardList()">导出颁奖名单</button>
      <button class="btn btn-primary" onclick="exportTeamAwards()">导出团体总分奖名单</button>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <div>
        <div class="card-title"><span>🥇</span> 项目排名与得分</div>
        <div class="card-subtitle">前 8 名按 9、7、6、5、4、3、2、1 分计；接力项目分值加倍</div>
      </div>
    </div>
    <div class="card-body" id="resultRankingList"></div>
  </div>

  <div class="card result-scoreboard-card">
    <div class="card-header">
      <div>
        <div class="card-title"><span>🏫</span> 班级团体总分</div>
        <div class="card-subtitle">成绩保存后实时汇总各班所有项目得分</div>
      </div>
    </div>
    <div class="card-body" id="classScoreboard"></div>
  </div>
`;

function resultEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function resultEventIsTeam(registration) {
  return registration.isTeamEvent === true ||
    registration.isTeam === true ||
    /(团体|接力|4\s*[x×]\s*100\s*(?:米|m)?)/i.test(registration.eventName || '');
}

function resultEventKey(eventName, genderGroup, grade) {
  return `${grade}|${genderGroup}|${String(eventName).trim().toLowerCase()}`;
}

function loadResultsData() {
  try {
    const parsed = Store.read(RESULTS_STORAGE_KEY, null);
    if (!parsed) return { athletes: [], registrations: [], results: [] };
    if (typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.athletes) || !Array.isArray(parsed.registrations)) {
      throw new Error('运动会报名数据格式不正确');
    }
    if (parsed.results !== undefined && !Array.isArray(parsed.results)) {
      throw new Error('运动会成绩数据格式不正确');
    }
    return migrateLegacyResultKeys({ ...parsed, results: parsed.results || [] });
  } catch (error) {
    resultsError = `无法读取运动会数据：${error.message}`;
    return { athletes: [], registrations: [], results: [] };
  }
}

function getResultEvents() {
  const athleteById = new Map(resultsData.athletes.map(athlete => [athlete.id, athlete]));
  const events = new Map();
  resultsData.registrations.forEach(registration => {
    const athlete = athleteById.get(registration.athleteId);
    if (!athlete || !registration.eventName) return;
    const genderGroup = athlete.gender || registration.genderGroup;
    const key = resultEventKey(registration.eventName, genderGroup, athlete.grade);
    const item = events.get(key) || {
      key,
      eventName: registration.eventName,
      genderGroup,
      grade: athlete.grade,
      eventType: registration.eventType === 'field' ? 'field' : 'track',
      isTeamEvent: resultEventIsTeam(registration),
      athleteIds: [],
    };
    item.isTeamEvent ||= resultEventIsTeam(registration);
    if (registration.eventType === 'field') item.eventType = 'field';
    if (!item.athleteIds.includes(athlete.id)) item.athleteIds.push(athlete.id);
    events.set(key, item);
  });
  return [...events.values()].sort((a, b) =>
    (a.eventType === b.eventType ? 0 : a.eventType === 'track' ? -1 : 1) ||
    a.grade - b.grade ||
    a.genderGroup.localeCompare(b.genderGroup) ||
    a.eventName.localeCompare(b.eventName, 'zh-CN')
  );
}

function migrateLegacyResultKeys(data) {
  const athleteById = new Map(data.athletes.map(athlete => [athlete.id, athlete]));
  const eventKeys = new Map();
  data.registrations.forEach(registration => {
    const athlete = athleteById.get(registration.athleteId);
    if (!athlete) return;
    const gender = athlete.gender || registration.genderGroup;
    const key = resultEventKey(registration.eventName, gender, athlete.grade);
    eventKeys.set(`${String(registration.eventName).trim().toLowerCase()}|${gender}|${athlete.grade}`, key);
  });

  return {
    ...data,
    results: data.results.map(result => {
      if (result.eventKey && /^\d+\|(?:male|female)\|/.test(result.eventKey)) {
        return [...eventKeys.values()].includes(result.eventKey)
          ? result
          : { ...result, rank: null, points: 0 };
      }
      const athlete = athleteById.get(result.athleteId);
      const grade = athlete?.grade || Number(/^(\d+)年级/.exec(result.classLabel || '')?.[1]);
      if (!grade || !result.eventName || !result.genderGroup) return { ...result, rank: null, points: 0 };
      const lookup = `${String(result.eventName).trim().toLowerCase()}|${result.genderGroup}|${grade}`;
      const eventKey = eventKeys.get(lookup);
      if (!eventKey) return { ...result, rank: null, points: 0 };
      const className = athlete?.className || String(result.classLabel || '').replace(/^\d+年级\s*/, '');
      return {
        ...result,
        eventKey,
        entryKey: result.isTeamEvent
          ? `team:${eventKey}:${grade}|${className}`
          : `athlete:${eventKey}:${result.athleteId}`,
        classLabel: result.isTeamEvent ? `${grade}年级 ${className}` : result.classLabel,
      };
    }),
  };
}

function resultEntriesForEvent(event) {
  const athleteById = new Map(resultsData.athletes.map(athlete => [athlete.id, athlete]));
  if (!event.isTeamEvent) {
    return event.athleteIds.map(athleteId => {
      const athlete = athleteById.get(athleteId);
      return {
        key: `athlete:${event.key}:${athleteId}`,
        athleteId,
        athleteIds: [athleteId],
        title: athlete.name,
        className: athlete.className,
        grade: athlete.grade,
        bibNumber: athlete.bibNumber || '',
      };
    }).filter(entry => entry.title);
  }

  const classes = new Map();
  event.athleteIds.forEach(athleteId => {
    const athlete = athleteById.get(athleteId);
    if (!athlete) return;
    const key = `${athlete.grade}|${athlete.className}`;
    const entry = classes.get(key) || {
      key: `team:${event.key}:${key}`,
      athleteIds: [],
      title: `${athlete.grade}年级 ${athlete.className}`,
      className: athlete.className,
      grade: athlete.grade,
      bibNumber: '',
    };
    entry.athleteIds.push(athleteId);
    classes.set(key, entry);
  });
  return [...classes.values()].sort((a, b) =>
    a.grade - b.grade || a.className.localeCompare(b.className, 'zh-CN', { numeric: true }),
  );
}

function resultRecordFor(entry) {
  return resultsData.results.find(result => result.entryKey === entry.key);
}

function formatFieldAttemptInput(value) {
  if (!Number.isFinite(Number(value))) return '';
  const converted = selectedFieldUnit === 'cm' ? Number(value) * 100 : Number(value);
  return String(Number(converted.toFixed(2)));
}

function escapeSelector(value) {
  return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

function renderResultEntry() {
  const select = document.getElementById('resultEventSelect');
  const events = getResultEvents().filter(event =>
    (resultGradeFilter === 'all' || String(event.grade) === resultGradeFilter) &&
    (resultGenderFilter === 'all' || event.genderGroup === resultGenderFilter));
  document.getElementById('resultGradeFilter').value = resultGradeFilter;
  document.getElementById('resultGenderFilter').value = resultGenderFilter;
  if (!events.some(event => event.key === selectedResultEvent)) selectedResultEvent = events[0]?.key || '';
  select.innerHTML = events.length
    ? events.map(event => `<option value="${resultEscape(event.key)}" ${event.key === selectedResultEvent ? 'selected' : ''}>${event.grade}年级 · ${event.genderGroup === 'female' ? '女子组' : '男子组'} · ${resultEscape(event.eventName)} · ${event.isTeamEvent ? '团队项目' : event.eventType === 'track' ? '径赛' : '田赛'}</option>`).join('')
    : '<option value="">暂无已报名项目</option>';

  const panel = document.getElementById('resultEntryPanel');
  const guidance = document.getElementById('resultGuidance');
  const event = events.find(item => item.key === selectedResultEvent);
  if (!event) {
    guidance.textContent = '请先在运动会报名页面导入或添加报名项目，之后即可录入成绩。';
    panel.innerHTML = '<div class="meet-empty">当前没有可录入成绩的报名项目。</div>';
    return;
  }

  const unitControl = event.eventType === 'field'
    ? `<label class="result-unit-picker">录入单位
        <select id="fieldResultUnit" aria-label="选择田赛成绩单位" onchange="selectFieldResultUnit(this.value)">
          <option value="m" ${selectedFieldUnit === 'm' ? 'selected' : ''}>米（m）</option>
          <option value="cm" ${selectedFieldUnit === 'cm' ? 'selected' : ''}>厘米（cm）</option>
        </select>
      </label>`
    : '<span class="result-unit-note">支持秒（如 8.52）或分:秒（如 1:08.52）</span>';
  guidance.innerHTML = `<span>${event.eventType === 'track' ? '径赛成绩越短名次越高' : '田赛自动取多次试跳 / 试掷中的最好成绩'}</span>${unitControl}`;
  const entries = resultEntriesForEvent(event);
  if (!entries.length) {
    panel.innerHTML = '<div class="meet-empty">该项目暂无有效运动员。</div>';
    return;
  }

  panel.innerHTML = `
    <div class="result-table-wrap">
      <table class="result-entry-table">
        <thead><tr>
          <th>参赛者</th>
          <th>${event.eventType === 'track' ? '成绩（秒 / 分:秒）' : '试跳 / 试掷成绩'}</th>
          <th>当前最好成绩</th>
          <th>排名 / 积分</th>
        </tr></thead>
        <tbody>${entries.map(entry => {
          const saved = resultRecordFor(entry);
          const best = saved?.bestValue == null ? '—' : formatResultValue(saved.bestValue, event.eventType);
          const score = saved?.rank ? `第 ${saved.rank} 名 · ${saved.points || 0} 分` : '未排名';
          const name = `<strong>${resultEscape(entry.title)}</strong>${entry.bibNumber ? `<span class="result-bib">号码 ${resultEscape(entry.bibNumber)}</span>` : ''}${event.isTeamEvent ? `<span class="result-bib">${entry.athleteIds.length} 名队员</span>` : `<span class="result-bib">${entry.grade}年级 ${resultEscape(entry.className)}</span>`}`;
          const inputs = event.eventType === 'track'
            ? `<input class="result-score-input" data-entry-key="${resultEscape(entry.key)}" data-attempt="0"
                type="text" inputmode="decimal" autocomplete="off"
                aria-label="${resultEscape(entry.title)}径赛成绩"
                placeholder="如 8.52 或 1:08.52"
                value="${resultEscape(saved?.attempts?.[0] ?? '')}">`
            : `<div class="result-attempts">${Array.from({ length: FIELD_ATTEMPT_COUNT }, (_, attempt) => `
                <label>第 ${attempt + 1} 次
                  <input class="result-score-input" data-entry-key="${resultEscape(entry.key)}" data-attempt="${attempt}"
                    type="text" inputmode="decimal" autocomplete="off"
                    aria-label="${resultEscape(entry.title)}第${attempt + 1}次田赛成绩"
                    placeholder="${selectedFieldUnit === 'm' ? '如 3.25 米' : '如 325 厘米'}"
                    value="${resultEscape(formatFieldAttemptInput(saved?.attempts?.[attempt]))}">
                </label>`).join('')}</div>`;
          return `<tr>
            <td class="result-athlete-cell">${name}</td>
            <td>${inputs}</td>
            <td class="result-best-value">${best}</td>
            <td>${score}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div class="result-save-row">
      <span class="result-muted">成绩会保存在本机浏览器，可随时修改后重新计算。</span>
      <button class="btn btn-primary result-save-button" onclick="saveSelectedEventResults()">保存成绩并计算排名</button>
    </div>
  `;
}

function formatResultValue(value, eventType) {
  if (eventType === 'track') return `${Number(value).toFixed(2)} 秒`;
  return `${Number(value).toFixed(2)} 米`;
}

function parseTrackResult(raw) {
  const value = String(raw).trim();
  if (!value) return null;
  const secondsOnly = /^(\d+(?:\.\d+)?)\s*(?:秒|s|sec)?$/i.exec(value);
  if (secondsOnly) return Number(secondsOnly[1]);
  const minutesSeconds = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(value);
  if (minutesSeconds) return Number(minutesSeconds[1]) * 60 + Number(minutesSeconds[2]);
  throw new Error('请输入有效的秒数或分:秒格式（例如 8.52 或 1:08.52）');
}

function parseFieldResult(raw, defaultUnit) {
  const value = String(raw).trim();
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(米|m|厘米|cm)?$/i.exec(value);
  if (!match) throw new Error('请输入有效距离，可使用米或厘米（例如 3.25 米或 325 厘米）');
  const amount = Number(match[1]);
  const unit = (match[2] || defaultUnit).toLowerCase();
  return unit === '厘米' || unit === 'cm' ? amount / 100 : amount;
}

function calculateRankedResults(events, results) {
  const output = results.map(result => ({ ...result, rank: null, points: 0 }));
  events.forEach(event => {
    const indexed = output
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.eventKey === event.key && Number.isFinite(result.bestValue))
      .sort((a, b) => event.eventType === 'track'
        ? a.result.bestValue - b.result.bestValue
        : b.result.bestValue - a.result.bestValue);
    let previousValue = null;
    let rank = 0;
    indexed.forEach(({ result, index }, position) => {
      if (previousValue === null || result.bestValue !== previousValue) rank = position + 1;
      const basePoints = POINTS_BY_RANK[rank - 1] || 0;
      output[index].rank = rank;
      output[index].points = basePoints * (event.isTeamEvent ? 2 : 1);
      previousValue = result.bestValue;
    });
  });
  return output;
}

function getClassNameKey(athlete) {
  return `${athlete.grade}年级 ${athlete.className}`;
}

function renderResultSummary(events) {
  const eventKeys = new Set(events.map(event => event.key));
  const relevantResults = resultsData.results.filter(result => eventKeys.has(result.eventKey));
  const total = relevantResults.length;
  const scored = relevantResults.filter(result => result.rank !== null && result.rank !== undefined);
  const points = scored.reduce((sum, result) => sum + Number(result.points || 0), 0);
  document.getElementById('resultSummary').innerHTML = `
    <div class="stat-card"><div class="stat-icon" style="background:var(--primary-100);color:var(--primary);">🏅</div><div class="stat-content"><h3>${events.length}</h3><p>可录入项目</p></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--info-light);color:#0288D1;">📝</div><div class="stat-content"><h3>${total}</h3><p>已保存成绩</p></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--warning-light);color:#B8860B;">⭐</div><div class="stat-content"><h3>${points}</h3><p>已产生积分</p></div></div>
  `;
}

function renderRankingList(events) {
  const root = document.getElementById('resultRankingList');
  const rankedEvents = events.map(event => ({
    event,
    rows: resultsData.results
      .filter(result => result.eventKey === event.key && result.rank)
      .sort((a, b) => a.rank - b.rank),
  })).filter(item => item.rows.length);
  if (!rankedEvents.length) {
    root.innerHTML = '<div class="meet-empty">录入并保存成绩后，这里会显示项目排名和积分。</div>';
    return;
  }

  root.innerHTML = `<div class="result-rank-grid">${rankedEvents.map(({ event, rows }) => `
    <section class="result-rank-card">
      <header><strong>${event.grade}年级 · ${resultEscape(event.eventName)}</strong><span>${event.genderGroup === 'female' ? '女子组' : '男子组'}${event.isTeamEvent ? ' · 接力双倍分' : ''}</span></header>
      <div class="result-table-wrap"><table class="result-ranking-table">
        <thead><tr><th>名次</th><th>${event.isTeamEvent ? '班级' : '运动员'}</th><th>成绩</th><th>积分</th></tr></thead>
        <tbody>${rows.map(row => {
          const athlete = resultsData.athletes.find(item => item.id === row.athleteId);
          return `<tr><td>${row.rank}</td><td>${resultEscape(event.isTeamEvent ? row.classLabel : athlete?.name || '未知运动员')}</td><td>${formatResultValue(row.bestValue, event.eventType)}</td><td><strong>${row.points}</strong></td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>`).join('')}</div>`;
}

function renderClassScoreboard(events) {
  const rows = getClassScoreRows(events);
  if (!rows.length) {
    document.getElementById('classScoreboard').innerHTML = '<div class="meet-empty">暂无班级信息。</div>';
    return;
  }
  document.getElementById('classScoreboard').innerHTML = `
    <div class="result-table-wrap"><table class="result-scoreboard-table">
      <thead><tr><th>排名</th><th>班级</th><th>团体总分</th></tr></thead>
      <tbody>${rows.map((row, index) => `<tr><td>${index + 1}</td><td>${resultEscape(row.label)}</td><td><strong>${row.points}</strong> 分</td></tr>`).join('')}</tbody>
    </table></div>
  `;
}

function getClassScoreRows(events) {
  const scores = new Map();
  const athleteById = new Map(resultsData.athletes.map(athlete => [athlete.id, athlete]));
  resultsData.athletes.forEach(athlete => scores.set(getClassNameKey(athlete), {
    label: getClassNameKey(athlete), grade: athlete.grade, className: athlete.className, points: 0,
  }));
  resultsData.results.forEach(result => {
    if (!result.rank || !result.points) return;
    const event = events.find(item => item.key === result.eventKey);
    if (!event) return;
    if (event?.isTeamEvent) {
      const key = result.classLabel;
      const score = scores.get(key);
      if (score) score.points += Number(result.points);
    } else {
      const athlete = athleteById.get(result.athleteId);
      const score = athlete && scores.get(getClassNameKey(athlete));
      if (score) score.points += Number(result.points);
    }
  });

  const rows = [...scores.values()].sort((a, b) =>
    b.points - a.points || a.grade - b.grade || a.className.localeCompare(b.className, 'zh-CN', { numeric: true }),
  );
  return rows;
}

function compareResultsByRank(eventA, resultA, eventB, resultB) {
  return eventA.grade - eventB.grade ||
    eventA.genderGroup.localeCompare(eventB.genderGroup) ||
    eventA.eventName.localeCompare(eventB.eventName, 'zh-CN') ||
    resultA.rank - resultB.rank;
}

function getRankedExportRows() {
  const events = getResultEvents();
  const eventByKey = new Map(events.map(event => [event.key, event]));
  return resultsData.results
    .filter(result => result.rank && Number.isFinite(result.bestValue) && eventByKey.has(result.eventKey))
    .map(result => ({ result, event: eventByKey.get(result.eventKey) }))
    .sort((a, b) => compareResultsByRank(a.event, a.result, b.event, b.result));
}

function getAwardRecipient(result, event) {
  const athleteById = new Map(resultsData.athletes.map(athlete => [athlete.id, athlete]));
  if (!event.isTeamEvent) {
    const athlete = athleteById.get(result.athleteId);
    return {
      name: athlete?.name || '未知运动员',
      className: athlete ? getClassNameKey(athlete) : result.classLabel || '',
      classSortName: athlete?.className || String(result.classLabel || '').replace(/^\d+年级\s*/, ''),
    };
  }

  const teamClass = result.classLabel || '';
  const teamAthleteIds = Array.isArray(result.athleteIds)
    ? result.athleteIds
    : event.athleteIds.filter(id => {
      const athlete = athleteById.get(id);
      return athlete && getClassNameKey(athlete) === teamClass;
    });
  const names = teamAthleteIds.map(id => athleteById.get(id)?.name).filter(Boolean);
  return {
    name: names.join('、') || teamClass || '参赛队',
    className: teamClass,
    classSortName: teamClass.replace(/^\d+年级\s*/, ''),
  };
}

function escapeCSV(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCSV(filename, headers, rows) {
  const content = [headers, ...rows].map(row => row.map(escapeCSV).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFilename(suffix) {
  const date = new Date();
  const dateLabel = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `运动会-${suffix}-${dateLabel}.csv`;
}

function exportResultsBook() {
  if (resultsError) {
    showToast('本地运动会数据读取失败，无法导出成绩册', 'error');
    return;
  }
  const eventByKey = new Map(getResultEvents().map(event => [event.key, event]));
  const rows = getRankedExportRows()
    .filter(({ result }) => result.rank <= 8)
    .map(({ result, event }) => {
      const recipient = getAwardRecipient(result, event);
      return [
        `${event.grade}年级`,
        event.genderGroup === 'female' ? '女子组' : '男子组',
        event.eventName,
        result.rank,
        recipient.name,
        recipient.className,
        formatResultValue(result.bestValue, event.eventType),
        result.points,
        event.isTeamEvent ? '团队项目' : event.eventType === 'track' ? '径赛' : '田赛',
      ];
    });
  if (!eventByKey.size || !rows.length) {
    showToast('暂无已排名成绩，无法导出成绩册', 'info');
    return;
  }
  downloadCSV(exportFilename('成绩册前8名'), ['年级', '性别组', '比赛项目', '名次', '姓名/队员', '班级', '成绩', '积分', '项目类型'], rows);
  showToast(`已导出 ${rows.length} 条前 8 名成绩`);
}

function exportAwardList() {
  if (resultsError) {
    showToast('本地运动会数据读取失败，无法导出颁奖名单', 'error');
    return;
  }
  const sortOrder = document.getElementById('awardSortOrder').value;
  const rows = getRankedExportRows().map(({ result, event }) => {
    const recipient = getAwardRecipient(result, event);
    return {
      grade: event.grade,
      className: recipient.className,
      gender: event.genderGroup,
      eventName: event.eventName,
      rank: result.rank,
      name: recipient.name,
      classSortName: recipient.classSortName,
      result,
      event,
    };
  }).sort((a, b) => {
    const classComparison = a.classSortName.localeCompare(b.classSortName, 'zh-CN', { numeric: true });
    const gradeComparison = a.grade - b.grade;
    return (sortOrder === 'class' ? classComparison || gradeComparison : gradeComparison || classComparison) ||
      a.gender.localeCompare(b.gender) ||
      a.eventName.localeCompare(b.eventName, 'zh-CN') ||
      a.rank - b.rank;
  });
  if (!rows.length) {
    showToast('暂无已排名成绩，无法导出颁奖名单', 'info');
    return;
  }
  downloadCSV(exportFilename('颁奖名单'), ['年级', '班级', '姓名/队员', '比赛项目', '性别组', '名次', '成绩'], rows.map(row => [
    `${row.grade}年级`,
    row.className,
    row.name,
    row.eventName,
    row.gender === 'female' ? '女子组' : '男子组',
    `第${row.rank}名`,
    formatResultValue(row.result.bestValue, row.event.eventType),
  ]));
  showToast(`已导出 ${rows.length} 条颁奖记录`);
}

function exportTeamAwards() {
  if (resultsError) {
    showToast('本地运动会数据读取失败，无法导出团体奖名单', 'error');
    return;
  }
  const rows = getClassScoreRows(getResultEvents()).filter(row => row.points > 0);
  if (!rows.length) {
    showToast('暂无已获得积分的班级，无法导出团体奖名单', 'info');
    return;
  }
  const firstTierEnd = Math.ceil(rows.length / 3);
  const secondTierEnd = Math.ceil(rows.length * 2 / 3);
  const awardRows = rows.map((row, index) => [
    index + 1,
    row.label,
    row.points,
    index < firstTierEnd ? '一等奖' : index < secondTierEnd ? '二等奖' : '三等奖',
  ]);
  downloadCSV(exportFilename('团体总分奖'), ['全校排名', '班级', '团体总分', '奖项'], awardRows);
  showToast(`已按全校积分排名导出 ${rows.length} 个班级，奖项按班级数量分为三档`);
}

function renderResults() {
  const events = getResultEvents().filter(event =>
    (resultGradeFilter === 'all' || String(event.grade) === resultGradeFilter) &&
    (resultGenderFilter === 'all' || event.genderGroup === resultGenderFilter));
  renderResultEntry();
  renderResultSummary(events);
  renderRankingList(events);
  renderClassScoreboard(events);
  const alertBox = document.getElementById('resultsStorageAlert');
  alertBox.textContent = resultsError;
  alertBox.classList.toggle('visible', Boolean(resultsError));
}

function selectResultEvent(eventKey) {
  selectedResultEvent = eventKey;
  renderResultEntry();
}

function updateResultFilters() {
  resultGradeFilter = document.getElementById('resultGradeFilter').value;
  resultGenderFilter = document.getElementById('resultGenderFilter').value;
  selectedResultEvent = '';
  renderResults();
}

function selectFieldResultUnit(unit) {
  selectedFieldUnit = unit === 'cm' ? 'cm' : 'm';
  renderResultEntry();
}

function saveSelectedEventResults() {
  if (resultsError) {
    showToast('本地报名数据读取失败，未保存成绩', 'error');
    return;
  }
  const event = getResultEvents().find(item => item.key === selectedResultEvent);
  if (!event) return;
  const entries = resultEntriesForEvent(event);
  const nextResults = resultsData.results.filter(result => result.eventKey !== event.key);
  const errors = [];
  let reviewCancelled = false;
  const inputsByEntry = new Map();
  document.querySelectorAll('.result-score-input').forEach(input => {
    const inputs = inputsByEntry.get(input.dataset.entryKey) || [];
    inputs.push(input);
    inputsByEntry.set(input.dataset.entryKey, inputs);
  });

  entries.forEach(entry => {
    const inputs = inputsByEntry.get(entry.key) || [];
    const attempts = [];
    inputs.forEach(input => {
      try {
        const parsed = event.eventType === 'track'
          ? parseTrackResult(input.value)
          : parseFieldResult(input.value, selectedFieldUnit);
        if (parsed !== null && parsed <= 0) throw new Error('成绩必须大于 0');
        attempts[Number(input.dataset.attempt)] = parsed;
      } catch (error) {
        errors.push(`${entry.title}：${error.message}`);
      }
    });
    const validAttempts = attempts.filter(Number.isFinite);
    if (!validAttempts.length) return;
    const bestValue = event.eventType === 'track'
      ? validAttempts[0]
      : Math.max(...validAttempts);
    if (event.eventType === 'track' && /50\s*(?:米|m)/i.test(event.eventName) && bestValue > 15) {
      if (!window.confirm(`${entry.title} 的 50 米成绩为 ${bestValue} 秒，请复核后确认仍要保存。`)) {
        reviewCancelled = true;
        return;
      }
    }
    nextResults.push({
      id: entry.key,
      entryKey: entry.key,
      eventKey: event.key,
      eventName: event.eventName,
      eventType: event.eventType,
      genderGroup: event.genderGroup,
      isTeamEvent: event.isTeamEvent,
      athleteId: event.isTeamEvent ? null : entry.athleteIds[0],
      athleteIds: event.isTeamEvent ? entry.athleteIds : undefined,
      classLabel: event.isTeamEvent ? entry.title : undefined,
      attempts,
      bestValue,
      unit: event.eventType === 'track' ? '秒' : '米',
      rank: null,
      points: 0,
      updatedAt: new Date().toISOString(),
    });
  });

  if (errors.length) {
    window.alert(`成绩未保存，请检查输入：\n${errors.slice(0, 8).join('\n')}`);
    return;
  }
  if (reviewCancelled) {
    showToast('已取消保存，请复核 50 米成绩', 'info');
    return;
  }

  const computedResults = calculateRankedResults(getResultEvents(), nextResults);
  try {
    const latest = Store.read(RESULTS_STORAGE_KEY, null) || {};
    if (!Array.isArray(latest.athletes) || !Array.isArray(latest.registrations)) {
      throw new Error('报名数据格式不正确');
    }
    Store.write(RESULTS_STORAGE_KEY, { ...latest, results: computedResults });
    resultsData = { ...latest, results: computedResults };
    resultsError = '';
    renderResults();
    showToast('成绩已保存，排名与班级积分已更新');
  } catch (error) {
    resultsError = `成绩保存失败：${error.message}`;
    renderResults();
  }
}

function initializeResultsPage() {
  resultsData = loadResultsData();
  selectedResultEvent = getResultEvents()[0]?.key || '';
  renderResults();
}

Store.onReady(() => {
  initializeResultsPage();
});
