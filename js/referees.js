'use strict';

/**
 * 裁判员管理
 * ─────────────────────────────────────────────────────────────
 * 作用：按【项目】指派一组裁判（主裁判 / 发令员 / 计时员……可以有多个人）。
 *   同一个项目（如 50 米）不论哪个年级、男/女组，用的都是同一组裁判，
 *   所以不再按「年级|组别|项目」逐条绑定，改成按项目名绑定。
 *
 * 数据落在运动会主数据里：pe_sports_meet_v1.referees
 *   {
 *     "50米": [{ name: "张老师", phone: "138xxxx" }, { name: "李老师", phone: "" }],
 *     "跳远": [{ name: "王老师", phone: "139xxxx" }]
 *   }
 *   键 = 项目名小写（见 js/referee-utils.js）；旧格式会自动迁移，不会丢数据。
 *
 * ⚠️ 保存时只改 referees 一个字段，报名数据 / 赛程 / 赛制一律原样带回，
 *    绝不用页面里的旧快照整体覆盖（会冲掉报名数据）。
 */

Layout.init('sports-meet', '裁判员管理', '运动会编排');

const MEET_STORAGE_KEY = 'pe_sports_meet_v1';
const DEFAULT_LANE_COUNT = 4;
const GRADE_TEXT = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };

let pageData = null;              // 运动会主数据快照
let projectList = [];             // 本页要指派裁判的项目
let refereeModel = new Map();     // key → [{name, phone}]（页面上正在编辑的名单）
let dirty = false;                // 是否有未保存的修改
let legacyDetected = false;       // 是否读到旧版（按年级绑定）的数据

/* ------------------------------ 工具 ------------------------------ */

function escapeRefereeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function gradeText(grade) {
  const num = Number(grade);
  return GRADE_TEXT[num] ? `${GRADE_TEXT[num]}年级` : `${num || '?'}年级`;
}

function isTeamEvent(registration) {
  if (registration.isTeamEvent === true || registration.isTeam === true) return true;
  return /(团体|接力|4\s*[x×]\s*100\s*(?:米|m)?)/i.test(String(registration.eventName || ''));
}

/* ------------------------------ 数据读取 ------------------------------ */

function blankMeetData() {
  return { athletes: [], registrations: [], heats: [], laneCount: DEFAULT_LANE_COUNT, referees: {} };
}

function readMeetData() {
  try {
    const data = Store.read(MEET_STORAGE_KEY, null);
    if (!data) return blankMeetData();
    if (typeof data !== 'object' || Array.isArray(data)) return blankMeetData();
    return { ...blankMeetData(), ...data };
  } catch (error) {
    console.error('读取运动会数据失败', error);
    return blankMeetData();
  }
}

/**
 * 从报名数据里解析出所有【项目名】（去重）。
 * 同一个项目名只出现一次 —— 这正是"按项目绑定"的语义：
 * 三年级男子 50 米和五年级女子 50 米共用同一组裁判。
 */
function collectProjects(data) {
  const athleteById = new Map((data.athletes || []).map(athlete => [athlete.id, athlete]));
  const projects = new Map();
  (data.registrations || []).forEach(registration => {
    const eventName = String(registration.eventName || '').trim();
    if (!eventName) return;
    const key = RefereeUtils.projectKey(eventName);
    if (!key) return;
    const athlete = athleteById.get(registration.athleteId);
    const grade = athlete?.grade ?? registration.grade;
    let item = projects.get(key);
    if (!item) {
      item = {
        key,
        eventName,
        count: 0,
        grades: new Set(),
        eventType: registration.eventType || '',
        team: isTeamEvent(registration),
      };
      projects.set(key, item);
    }
    item.count += 1;
    if (grade) item.grades.add(Number(grade));
    if (registration.eventType === 'track') item.eventType = 'track';
    if (registration.eventType === 'field') item.eventType = 'field';
  });
  return [...projects.values()]
    .map(item => ({ ...item, grades: [...item.grades].sort((a, b) => a - b) }))
    .sort((a, b) =>
      (a.team === b.team ? 0 : a.team ? 1 : -1) ||
      (a.eventType === b.eventType ? 0 : a.eventType === 'track' ? -1 : 1) ||
      a.eventName.localeCompare(b.eventName, 'zh-CN'));
}

/* ------------------------------ 渲染 ------------------------------ */

function renderShell() {
  const container = document.getElementById('page-content');
  if (!container) return;
  container.innerHTML = `
    <section class="card">
      <div class="card-header">
        <div>
          <div class="card-title">👨‍⚖️ 裁判员安排（按项目）</div>
          <div class="card-subtitle">同一项目的所有年级、男/女组共用这一组裁判，可安排多位（主裁判 / 发令员 / 计时员…）</div>
        </div>
        <div class="meet-toolbar-actions">
          <button class="btn btn-secondary" type="button" onclick="reloadRefereePage()">重新读取</button>
          <button data-admin-only class="btn btn-primary" type="button" id="refereeSaveBtn" onclick="saveReferees()">保存裁判员安排</button>
        </div>
      </div>
      <div class="card-body">
        <div class="meet-alert info" id="refereeLegacyTip" role="status"></div>
        <p class="meet-guidance" id="refereeSummary">正在读取报名数据…</p>
        <div id="refereeList"></div>
      </div>
    </section>
  `;
}

function renderRefereeList() {
  const listBox = document.getElementById('refereeList');
  const summary = document.getElementById('refereeSummary');
  const legacyTip = document.getElementById('refereeLegacyTip');
  if (!listBox) return;

  const assignedProjects = projectList.filter(project => {
    const members = refereeModel.get(project.key) || [];
    return members.some(member => member.name || member.phone);
  }).length;
  const assignedPeople = [...refereeModel.values()]
    .reduce((sum, members) => sum + members.filter(member => member.name || member.phone).length, 0);

  if (summary) {
    summary.textContent = projectList.length
      ? `共 ${projectList.length} 个项目，已指派 ${assignedProjects} 个（${assignedPeople} 位裁判），`
        + `${projectList.length - assignedProjects} 个待指派。保存后自动同步到云端，赛程编排的甘特图与明细列表会显示裁判名单。`
      : '还没有报名数据：先到「报名管理」导入学生名单与报名项目，这里会自动列出所有比赛项目。';
  }
  if (legacyTip) {
    legacyTip.textContent = legacyDetected
      ? '检测到旧版裁判员数据（原先按「年级|组别|项目」逐条绑定），已自动折算为【按项目绑定】，以前的裁判员安排不会丢失。'
      : '';
    legacyTip.classList.toggle('visible', Boolean(legacyDetected));
  }

  if (!projectList.length) {
    listBox.innerHTML = '<div class="meet-empty">暂无可指派的项目。</div>';
    return;
  }

  listBox.innerHTML = `<div class="referee-groups">${projectList.map(project => renderRefereeGroup(project)).join('')}</div>`;
}

/** 一个项目 = 一张卡片，里面是可动态增删的裁判行 */
function renderRefereeGroup(project) {
  const members = refereeModel.get(project.key) || [];
  const assigned = members.filter(member => member.name || member.phone).length;
  const rows = members.length
    ? members.map((member, index) => renderRefereeMember(project.key, index, member)).join('')
    : '<div class="referee-empty">还没有裁判，点上面的【+ 添加裁判】添加。</div>';
  const gradeLabel = project.grades.length
    ? project.grades.map(grade => gradeTextOf(grade)).join('、')
    : '—';
  return `
    <section class="referee-group${assigned ? ' is-assigned' : ''}" data-key="${escapeRefereeHTML(project.key)}">
      <header class="referee-group-head">
        <div class="referee-group-title">
          <span class="referee-group-name">${escapeRefereeHTML(project.eventName)}</span>
          <span class="referee-group-tag">${project.team ? '团体项目' : project.eventType === 'field' ? '田赛' : '径赛'}</span>
          <span class="meet-muted">${escapeRefereeHTML(gradeLabel)} · ${project.count} 人报名</span>
          ${project.orphan ? '<span class="referee-group-tag orphan">当前无报名</span>' : ''}
        </div>
        <div class="referee-group-actions">
          <span class="referee-status">${assigned ? `✅ ${assigned} 位裁判` : '⏳ 待指派'}</span>
          <button class="btn btn-sm btn-secondary" type="button" data-action="add" data-key="${escapeRefereeHTML(project.key)}">+ 添加裁判</button>
        </div>
      </header>
      <div class="referee-members">${rows}</div>
    </section>`;
}

/** 一位裁判：姓名 + 电话 + 删除 */
function renderRefereeMember(key, index, member) {
  return `
    <div class="referee-member" data-key="${escapeRefereeHTML(key)}" data-index="${index}">
      <span class="referee-member-index">${index + 1}</span>
      <input class="form-control" type="text" maxlength="20" placeholder="裁判员姓名，如：张老师"
        data-field="name" value="${escapeRefereeHTML(member.name)}" aria-label="裁判员姓名">
      <input class="form-control referee-phone" type="tel" inputmode="tel" maxlength="20" placeholder="联系电话（选填）"
        data-field="phone" value="${escapeRefereeHTML(member.phone)}" aria-label="联系电话">
      <button class="referee-member-remove" type="button" data-action="remove" data-key="${escapeRefereeHTML(key)}"
        data-index="${index}" title="删除这一位裁判" aria-label="删除这一位裁判">✕</button>
    </div>`;
}

function gradeTextOf(grade) {
  const num = Number(grade);
  return GRADE_TEXT[num] ? `${GRADE_TEXT[num]}年级` : '';
}

/** 只更新一个项目的状态徽标（输入时用，不整页重绘，避免焦点丢失） */
function updateGroupStatus(key) {
  const group = document.querySelector(`.referee-group[data-key="${cssEscape(key)}"]`);
  if (!group) return;
  const members = refereeModel.get(key) || [];
  const assigned = members.filter(member => member.name || member.phone).length;
  const badge = group.querySelector('.referee-status');
  if (badge) badge.textContent = assigned ? `✅ ${assigned} 位裁判` : '⏳ 待指派';
  group.classList.toggle('is-assigned', assigned > 0);
}

/** 极简 CSS.escape 兜底（老浏览器没有 CSS.escape） */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/* ------------------------------ 交互 ------------------------------ */

/** 添加一位裁判 */
function addRefereeMember(key) {
  const members = refereeModel.get(key) || [];
  members.push({ name: '', phone: '' });
  refereeModel.set(key, members);
  markDirty();
  renderRefereeList();
  const group = document.querySelector(`.referee-group[data-key="${cssEscape(key)}"]`);
  const inputs = group?.querySelectorAll('.referee-member input');
  const last = inputs?.[inputs.length - 1];
  if (last) last.focus();
}

/** 删除一位裁判 */
function removeRefereeMember(key, index) {
  const members = refereeModel.get(key) || [];
  if (index < 0 || index >= members.length) return;
  members.splice(index, 1);
  refereeModel.set(key, members);
  markDirty();
  renderRefereeList();
}

/** 输入联动：只改内存模型，不重绘（避免光标跳走） */
function updateRefereeMember(key, index, field, value) {
  const members = refereeModel.get(key);
  if (!members || !members[index]) return;
  members[index][field] = String(value ?? '');
  markDirty();
  updateGroupStatus(key);
}

function markDirty() {
  dirty = true;
  const button = document.getElementById('refereeSaveBtn');
  if (button) button.textContent = '保存裁判员安排 *';
}

/** 事件委托：一次绑定，管所有项目的新增/删除按钮 */
function bindRefereeEvents() {
  const listBox = document.getElementById('refereeList');
  if (!listBox) return;
  listBox.addEventListener('input', event => {
    const field = event.target.dataset?.field;
    if (!field) return;
    const row = event.target.closest('.referee-member');
    if (!row) return;
    updateRefereeMember(row.dataset.key, Number(row.dataset.index), field, event.target.value);
  });
  listBox.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const key = button.dataset.key || '';
    if (button.dataset.action === 'add') addRefereeMember(key);
    if (button.dataset.action === 'remove') removeRefereeMember(key, Number(button.dataset.index));
  });
}

function reloadRefereePage() {
  pageData = readMeetData();
  const { dict, migrated } = RefereeUtils.normalize(pageData.referees);
  legacyDetected = migrated;
  refereeModel = new Map();
  Object.keys(dict).forEach(key => {
    refereeModel.set(key, dict[key].map(member => ({ ...member })));
  });

  projectList = collectProjects(pageData);
  // 已经保存过、但当前没有报名的项目：保留下来（别把老师填好的裁判员弄丢）
  const known = new Set(projectList.map(project => project.key));
  [...refereeModel.keys()].forEach(key => {
    if (known.has(key)) return;
    projectList.push({ key, eventName: key, count: 0, grades: [], eventType: '', team: false, orphan: true });
  });
  projectList.sort((a, b) => (a.orphan === b.orphan ? 0 : a.orphan ? 1 : -1)
    || a.eventName.localeCompare(b.eventName, 'zh-CN'));

  dirty = false;
  const button = document.getElementById('refereeSaveBtn');
  if (button) button.textContent = '保存裁判员安排';
  renderRefereeList();

  // 旧格式顺手升级成新格式（写云端失败也不影响页面使用）
  if (migrated) migrateLegacyReferees(dict);
}

/** 把旧格式的裁判员数据升级成新格式并落盘（只改 referees 一个字段） */
async function migrateLegacyReferees(dict) {
  try {
    const latest = readMeetData();
    await Store.write(MEET_STORAGE_KEY, { ...latest, referees: dict });
  } catch (error) {
    console.warn('裁判员数据格式升级失败（不影响使用，保存时会一起升级）', error);
  }
}

/* ------------------------------ 保存 ------------------------------ */

async function saveReferees() {
  const button = document.getElementById('refereeSaveBtn');
  const next = {};
  refereeModel.forEach((members, key) => {
    const cleaned = members
      .map(member => ({ name: String(member.name || '').trim(), phone: String(member.phone || '').trim() }))
      .filter(member => member.name || member.phone);
    if (cleaned.length) next[key] = cleaned;
  });

  // ⚠️ 以 Store 里的最新数据为底，只盖 referees 一个字段
  //    （页面里的快照可能是旧的，整体写回会冲掉报名数据与赛程）
  const latest = readMeetData();
  const updated = { ...latest, referees: next };

  if (button) {
    button.disabled = true;
    button.textContent = '保存中…';
  }
  try {
    let result = null;
    if (typeof Store.writeCritical === 'function') {
      result = await Store.writeCritical(MEET_STORAGE_KEY, updated, { label: '裁判员安排' });
    } else {
      Store.write(MEET_STORAGE_KEY, updated);
    }
    if (result && result.ok === false) {
      showToast(`裁判员安排已存在本机，但同步到云端失败：${result.error || '未知错误'}`, 'error');
      return;
    }
    dirty = false;
    legacyDetected = false;
    if (button) button.textContent = '保存裁判员安排';
    showToast('裁判员安排已保存并同步到云端', 'success');
    reloadRefereePage();
  } catch (error) {
    console.error('保存裁判员安排失败', error);
    showToast(`保存失败：${error?.message || error}`, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

/* ------------------------------ 启动 ------------------------------ */

renderShell();
bindRefereeEvents();
reloadRefereePage();

// 云端数据到达 / 其他模块改动 → 重新渲染（但绝不覆盖用户正在填的内容）
Store.onReady(() => {
  if (dirty) return;                 // 用户正在填：等他保存，不打断
  const latest = readMeetData();
  const current = RefereeUtils.normalize(pageData?.referees).dict;
  const incoming = RefereeUtils.normalize(latest.referees).dict;
  if (JSON.stringify(current) === JSON.stringify(incoming)) return;
  pageData = latest;
  reloadRefereePage();
});
