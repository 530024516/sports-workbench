'use strict';

Layout.init('sports-meet', '运动会编排', '运动会编排');

const sportsMeetTabs = [
  { id: 'registration', label: '1. 报名管理', title: '报名管理', src: 'registration.html?embed=1' },
  { id: 'schedule', label: '2. 赛程编排', title: '赛程编排', src: 'schedule.html?embed=1' },
  { id: 'results', label: '3. 成绩与排名', title: '成绩与排名', src: 'results.html?embed=1' },
  { id: 'export', label: '4. 导出与颁奖', title: '导出与颁奖', src: 'results.html?embed=1&view=reports' },
];
const SPORTS_MEET_TITLE_KEY = 'sportsMeetTitle';

function getDefaultSportsMeetTitle() {
  return `${new Date().getFullYear()}年秋季田径运动会工作台`;
}

function loadSportsMeetTitle() {
  try {
    const savedTitle = String(Store.read(SPORTS_MEET_TITLE_KEY, '') || '').trim();
    return savedTitle || getDefaultSportsMeetTitle();
  } catch (error) {
    console.error('无法读取运动会工作台标题', error);
    return getDefaultSportsMeetTitle();
  }
}

document.getElementById('page-content').innerHTML = `
  <section class="sports-meet-hero">
    <div>
      <p class="sports-meet-eyebrow">SPORTS MEET WORKSPACE</p>
      <div class="sports-meet-title-row">
        <h1 id="sportsMeetTitle">${escapeSportsMeetTitle(loadSportsMeetTitle())}</h1>
        <button class="sports-meet-title-edit" type="button" aria-label="编辑运动会标题"
          title="编辑标题" onclick="startSportsMeetTitleEdit()">✏️</button>
      </div>
      <p>报名、赛程、成绩与颁奖报表集中管理，数据在各模块间实时共享。</p>
    </div>
    <span class="sports-meet-hero-icon" aria-hidden="true">🏟️</span>
  </section>
  <section class="sports-meet-card">
    <div class="sports-meet-tabs" role="tablist" aria-label="运动会管理模块">
      ${sportsMeetTabs.map((tab, index) => `
        <button id="sportsMeetTab-${tab.id}" class="sports-meet-tab" type="button"
          role="tab" aria-controls="sportsMeetPanel-${tab.id}" aria-selected="${index === 0}"
          tabindex="${index === 0 ? '0' : '-1'}" onclick="selectSportsMeetTab('${tab.id}')">
          ${tab.label}
        </button>`).join('')}
    </div>
    <div class="sports-meet-panels">
      ${sportsMeetTabs.map((tab, index) => `
        <section id="sportsMeetPanel-${tab.id}" class="sports-meet-panel"
          role="tabpanel" aria-labelledby="sportsMeetTab-${tab.id}" ${index === 0 ? '' : 'hidden'}>
          <iframe class="sports-meet-frame" title="${tab.title}" src="${tab.src}"
            loading="${index === 0 ? 'eager' : 'lazy'}"></iframe>
        </section>`).join('')}
    </div>
  </section>
`;

// 标记为「首页外壳」：让 hero + 卡片撑满可视高度、iframe 填满剩余空间，父页不再出现第二条滚动条
document.getElementById('page-content').classList.add('sports-meet-shell');

function escapeSportsMeetTitle(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function startSportsMeetTitleEdit() {
  const title = document.getElementById('sportsMeetTitle');
  if (!title || document.getElementById('sportsMeetTitleInput')) return;
  const input = document.createElement('input');
  input.id = 'sportsMeetTitleInput';
  input.className = 'sports-meet-title-input';
  input.type = 'text';
  input.maxLength = 100;
  input.value = title.textContent;
  input.setAttribute('aria-label', '编辑运动会工作台标题');
  title.replaceWith(input);
  input.addEventListener('keydown', handleSportsMeetTitleKeydown);
  input.addEventListener('blur', saveSportsMeetTitle);
  input.focus();
  input.select();
}

function renderSportsMeetTitle(value) {
  const title = document.createElement('h1');
  title.id = 'sportsMeetTitle';
  title.textContent = value;
  const input = document.getElementById('sportsMeetTitleInput');
  if (input?.parentNode) input.replaceWith(title);
}

function saveSportsMeetTitle() {
  const input = document.getElementById('sportsMeetTitleInput');
  if (!input) return;
  const title = input.value.trim() || getDefaultSportsMeetTitle();
  try {
    Store.write(SPORTS_MEET_TITLE_KEY, title);
    renderSportsMeetTitle(title);
  } catch (error) {
    console.error('无法保存运动会工作台标题', error);
    input.setCustomValidity('标题保存失败，请检查浏览器本地存储设置。');
    input.reportValidity();
    input.focus();
  }
}

function cancelSportsMeetTitleEdit() {
  const input = document.getElementById('sportsMeetTitleInput');
  if (!input) return;
  input.removeEventListener('blur', saveSportsMeetTitle);
  const savedTitle = loadSportsMeetTitle();
  renderSportsMeetTitle(savedTitle);
}

function handleSportsMeetTitleKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.currentTarget.blur();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelSportsMeetTitleEdit();
  }
}

/* iframe 自动撑高的安全护栏：
   ① 只在高度变化超过 2px 时才回写（避免抖动式自我触发）
   ② 上限 40000px（任何异常都不可能把页面撑到无限长）
   ③ 前提：iframe 内部不允许出现 vh 相关高度——内容高度只与宽度有关，
      与 iframe 自身高度无关，因此「iframe 变高 → 内容更高」的正反馈已经不存在。
      之前的无限变长正是因为内部甘特图用了 calc(100vh - 150px)，现已全部改为自然高度。 */
const SPORTS_MEET_FRAME_MIN_HEIGHT = 480;
const SPORTS_MEET_FRAME_MAX_HEIGHT = 40000;

function setSportsMeetFrameHeight(frame) {
  // 不在文档流里（切到别的 Tab 而隐藏）时量不到真实高度，等 Tab 切回来再量
  if (!frame || !frame.isConnected || !frame.offsetParent) return;
  try {
    const frameBody = frame.contentDocument?.body;
    if (!frameBody) return;
    const measured = Math.max(
      frameBody.scrollHeight || 0,
      frameBody.firstElementChild?.scrollHeight || 0,
      frame.contentDocument.documentElement?.scrollHeight || 0,
    );
    const next = Math.round(Math.min(
      Math.max(measured, SPORTS_MEET_FRAME_MIN_HEIGHT), SPORTS_MEET_FRAME_MAX_HEIGHT,
    ));
    const current = Number(frame.dataset.frameHeight || 0);
    if (Math.abs(next - current) <= 2) return;      // ① 没有实质变化就不回写
    frame.dataset.frameHeight = String(next);
    frame.style.height = `${next}px`;
  } catch (error) {
    console.error('无法读取运动会模块页面高度', error);
  }
}

function observeSportsMeetFrame(frame) {
  frame.addEventListener('load', () => {
    setSportsMeetFrameHeight(frame);
    try {
      const frameBody = frame.contentDocument?.body;
      if (!frameBody) return;
      let pending = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => setSportsMeetFrameHeight(frame));
      });
      observer.observe(frameBody);
    } catch (error) {
      console.error('无法监测运动会模块页面高度变化', error);
    }
  });
}

/** 窗口变宽/变窄后文字换行会变，内容高度跟着变 → 重新量一次 */
function refreshSportsMeetFrameHeight() {
  document.querySelectorAll('.sports-meet-frame').forEach(setSportsMeetFrameHeight);
}

window.addEventListener('resize', () => {
  clearTimeout(window.__sportsMeetResizeTimer);
  window.__sportsMeetResizeTimer = setTimeout(refreshSportsMeetFrameHeight, 120);
});

function selectSportsMeetTab(tabId, updateHash = true) {
  const activeTab = sportsMeetTabs.find(tab => tab.id === tabId) || sportsMeetTabs[0];
  sportsMeetTabs.forEach(tab => {
    const isActive = tab.id === activeTab.id;
    const tabButton = document.getElementById(`sportsMeetTab-${tab.id}`);
    const panel = document.getElementById(`sportsMeetPanel-${tab.id}`);
    tabButton.setAttribute('aria-selected', String(isActive));
    tabButton.tabIndex = isActive ? 0 : -1;
    panel.hidden = !isActive;
    if (isActive) {
      const frame = panel.querySelector('iframe');
      setSportsMeetFrameHeight(frame);
      requestAnimationFrame(() => setSportsMeetFrameHeight(frame));   // 等一帧布局稳定再量一次
    }
  });

  if (updateHash && window.location.hash !== `#${activeTab.id}`) {
    history.replaceState(null, '', `#${activeTab.id}`);
  }
}

document.querySelectorAll('.sports-meet-frame').forEach(observeSportsMeetFrame);
document.querySelectorAll('.sports-meet-tab').forEach((tab, index, tabs) => {
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    tabs[nextIndex].focus();
    selectSportsMeetTab(sportsMeetTabs[nextIndex].id);
  });
});

const requestedTab = window.location.hash.slice(1);
if (requestedTab === 'unit-design') {
  window.location.replace('unit-design.html');
} else {
  Store.onReady(() => {
    // 云端标题就绪后再渲染，避免每次都回落到默认标题
    renderSportsMeetTitle(loadSportsMeetTitle());
    selectSportsMeetTab(sportsMeetTabs.some(tab => tab.id === requestedTab) ? requestedTab : 'registration', false);
  });
}
