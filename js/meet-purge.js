/**
 * 一键清空本次运动会所有数据
 * 覆盖：运动员报名、参赛项目、预赛分组（heats）、生成的赛程、已录入的成绩与排名缓存、
 *       运动会项目库、报名模板配置、运动会标题。
 * 本地：localStorage 全键 removeItem（含备份键）
 * 云端：/api/data { op:'purge', scope:'meet' } → Supabase 按表 DELETE（sports_meet / app_settings）
 */
'use strict';

const MEET_PURGE_KEYS = [
  { key: 'pe_sports_meet_v1', label: '报名 / 预分组 / 赛程 / 成绩排名' },
  { key: 'pe_sports_meet_events_v1', label: '运动会项目库' },
  { key: 'pe_meet_template_config_v1', label: '报名模板配置' },
  { key: 'sportsMeetTitle', label: '运动会标题' },
];
const MEET_PURGE_CONFIRM_TEXT = '清空运动会';
const MEET_PURGE_NOTICE_KEY = 'meetPurgeNotice';

/** 当前这几个键里到底有多少数据（弹窗里给用户看清楚要删什么） */
function meetPurgeSummary() {
  return MEET_PURGE_KEYS.map(({ key, label }) => {
    let count = 0;
    try {
      const raw = localStorage.getItem(key);
      const value = raw ? JSON.parse(raw) : null;
      if (Array.isArray(value)) count = value.length;
      else if (value && typeof value === 'object') {
        count = (value.athletes?.length || 0) + (value.registrations?.length || 0)
          + (value.heats?.length || 0) + (value.results?.length || 0)
          + (value.schedule?.entries?.length || 0);
        if (!count) count = Object.keys(value).length ? 1 : 0;
      } else if (typeof value === 'string' && value.trim()) count = 1;
    } catch (error) {
      count = 0;
    }
    return { key, label, count };
  });
}

/** 把「危险区」横条插到页面顶部（页面 JS 渲染完再插，用 MutationObserver 兜一次） */
function mountMeetPurgeZone() {
  const host = document.getElementById('page-content');
  if (!host || document.getElementById('meetPurgeZone')) return;
  const zone = document.createElement('div');
  zone.id = 'meetPurgeZone';
  zone.className = 'meet-purge-zone';
  zone.innerHTML = `
    <div class="meet-purge-text">
      <strong>🧨 数据管理</strong>
      <span>换一届运动会前请先清空上一届：报名、预分组、赛程、成绩排名会一起删除，不可恢复。</span>
    </div>
    <button class="meet-purge-btn" type="button" onclick="requestMeetPurge()">一键清空本次运动会所有数据</button>
  `;
  host.prepend(zone);
}

function watchMeetPurgeZone() {
  mountMeetPurgeZone();
  const host = document.getElementById('page-content');
  if (!host || typeof MutationObserver === 'undefined') return;
  const observer = new MutationObserver(() => {
    mountMeetPurgeZone();
    if (document.getElementById('meetPurgeZone')) observer.disconnect();
  });
  observer.observe(host, { childList: true, subtree: false });
}

/** 第一次确认：列出要删什么，要求手动输入「清空运动会」 */
function requestMeetPurge() {
  const rows = meetPurgeSummary()
    .map(row => `<li><b>${row.label}</b><span>${row.count ? `${row.count} 条` : '（空）'}</span></li>`)
    .join('');
  showModal(
    '⚠️ 清空本次运动会所有数据',
    `<div class="meet-purge-modal">
       <p class="meet-purge-warn">此操作不可恢复，会同时删除：</p>
       <ul class="meet-purge-list">${rows}</ul>
       <p>确定请手动输入 <code>清空运动会</code> 后再点红色按钮：</p>
       <input id="meetPurgeConfirm" class="meet-purge-input" type="text" autocomplete="off"
         placeholder="输入 清空运动会" aria-label="输入清空运动会以确认">
     </div>`,
    `<button class="btn btn-secondary" onclick="closeModal(this)">取消</button>
     <button class="btn meet-purge-danger" onclick="confirmMeetPurge(this)">我确认，彻底清空</button>`,
    'meet-purge-overlay',
  );
  document.getElementById('meetPurgeConfirm')?.focus();
}

/** 第二次确认（真的执行） */
async function confirmMeetPurge(button) {
  const input = document.getElementById('meetPurgeConfirm');
  if (input?.value.trim() !== MEET_PURGE_CONFIRM_TEXT) {
    showToast(`请输入「${MEET_PURGE_CONFIRM_TEXT}」以确认清空`, 'error');
    input?.focus();
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = '正在清空…';
  }
  try {
    const result = await Store.purgeMeetData();
    const cloudRows = Array.isArray(result.cloud) ? result.cloud : [];
    const cloudFailed = cloudRows.filter(row => row.status === 'error');
    const cloudDeleted = cloudRows.filter(row => row.status === 'ok').length;
    let notice = `已清空本次运动会所有数据（本地 ${result.clearedKeys.length} 个键`
      + (cloudDeleted ? `，云端删除 ${cloudDeleted} 项` : '') + '）';
    if (cloudFailed.length || result.ok === false) {
      // 本地已洗地，但云端还留着：下次同步会把旧数据拉回来，必须让用户知道并重试
      notice = `本地数据已清空，但云端删除失败（${cloudFailed[0]?.message || result.error || '未知原因'}），请联网后重试一次`;
    }
    try {
      sessionStorage.setItem(MEET_PURGE_NOTICE_KEY, notice);
    } catch (error) { /* 无痕模式等不支持 sessionStorage，忽略 */ }
    closeModal(document.querySelector('.modal-close'));
    // 报名 / 赛程 / 成绩是同一份数据的不同页面，整体重载才能保证每个 iframe 都是干净的
    if (window.parent !== window) window.parent.location.reload();
    else window.location.reload();
  } catch (error) {
    console.error('清空运动会数据失败', error);
    if (button) {
      button.disabled = false;
      button.textContent = '我确认，彻底清空';
    }
    showToast(`清空失败：${error?.message || error}`, 'error');
  }
}

/** 清空后重载完成，补一条提示 */
function showMeetPurgeNotice() {
  let message = '';
  try {
    message = sessionStorage.getItem(MEET_PURGE_NOTICE_KEY) || '';
    sessionStorage.removeItem(MEET_PURGE_NOTICE_KEY);
  } catch (error) {
    return;
  }
  if (message) showToast(message);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    watchMeetPurgeZone();
    showMeetPurgeNotice();
  });
} else {
  watchMeetPurgeZone();
  showMeetPurgeNotice();
}
