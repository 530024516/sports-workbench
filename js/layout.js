/**
 * 公共布局 - 侧边栏 + 顶部栏
 * 所有页面共享
 */

const Layout = {
  DISPLAY_SETTINGS_KEY: 'pe_workbench_display_settings_v1',
  /** 侧边栏折叠状态（只存本地，不上云） */
  SIDEBAR_COLLAPSED_KEY: 'pe_sidebar_collapsed',
  defaultDisplaySettings: {
    workspaceName: '体育老师工作台',
    teacherName: '体育老师',
  },
  documentTitleSuffix: '',
  navigation: [
    { id: 'dashboard', label: '工作台首页', icon: '📊', href: 'index.html' },
    {
      id: 'teaching',
      label: '教学管理',
      icon: '📁',
      children: [
        { id: 'fitness', label: '体测数据', icon: '💪', href: 'fitness.html' },
        { id: 'lessons', label: '教案与资源', icon: '📋', href: 'lessons.html' },
        { id: 'unit-design', label: '大单元设计', icon: '🧩', href: 'unit-design.html' },
        { id: 'offline-resources', label: '离线资源库', icon: '📦', href: 'offline-resources.html' },
      ],
    },
    {
      id: 'events',
      label: '赛事管理',
      icon: '📁',
      children: [
        { id: 'sports-meet', label: '运动会编排', icon: '🏟️', href: 'sports-meet.html' },
      ],
    },
    {
      id: 'personal',
      label: '个人工具',
      icon: '🧰',
      children: [
        { id: 'fitness-assistant', label: '健身助手', icon: '🏋️', href: 'fitness-assistant.html' },
      ],
    },
  ],

  getDisplaySettings() {
    try {
      const saved = Store.read(this.DISPLAY_SETTINGS_KEY, {}) || {};
      return {
        workspaceName: typeof saved.workspaceName === 'string' && saved.workspaceName.trim()
          ? saved.workspaceName.trim() : this.defaultDisplaySettings.workspaceName,
        teacherName: typeof saved.teacherName === 'string' && saved.teacherName.trim()
          ? saved.teacherName.trim() : this.defaultDisplaySettings.teacherName,
      };
    } catch (error) {
      console.error('读取工作台显示设置失败', error);
      return { ...this.defaultDisplaySettings };
    }
  },

  escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  },

  sidebarHTML() {
    const settings = this.getDisplaySettings();
    return `
    <aside class="sidebar" id="appSidebar">
      <div class="sidebar-brand">
        <div class="logo">🏃</div>
        <span class="brand-text" title="${this.escapeHTML(settings.workspaceName)}">${this.escapeHTML(settings.workspaceName)}</span>
      </div>
      <nav class="sidebar-nav">
        ${this.navigation.map(item => item.children
          ? `<div class="nav-group" data-nav-group="${item.id}">
              <button class="nav-group-toggle" type="button" aria-expanded="false"
                aria-controls="navGroup-${item.id}" data-tip="${this.escapeHTML(item.label)}"
                onclick="Layout.toggleNavigationGroup('${item.id}')">
                <span class="nav-icon">${item.icon}</span>
                <span class="nav-text">${item.label}</span>
                <span class="nav-group-chevron" aria-hidden="true">▾</span>
              </button>
              <div class="nav-submenu" id="navGroup-${item.id}" hidden>
                ${item.children.map(child => `<a class="nav-item nav-subitem" data-page="${child.id}" href="${child.href}" data-tip="${this.escapeHTML(child.label)}">
                  <span class="nav-icon">${child.icon}</span><span class="nav-text">${child.label}</span>
                </a>`).join('')}
              </div>
            </div>`
          : `<a class="nav-item nav-root-item" data-page="${item.id}" href="${item.href}" data-tip="${this.escapeHTML(item.label)}">
              <span class="nav-icon">${item.icon}</span><span class="nav-text">${item.label}</span>
            </a>`
        ).join('')}
      </nav>
      <div class="sidebar-footer">
        <div class="user-mini">
          <div class="avatar">体</div>
          <div class="user-info">
            <div class="user-name">${this.escapeHTML(settings.teacherName)}</div>
            <div class="user-role">教师</div>
          </div>
        </div>
      </div>
    </aside>
    `;
  },

  topbarHTML(title, breadcrumb) {
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekStr = `星期${weekdays[now.getDay()]}`;
    return `
      <header class="topbar">
        <div class="topbar-left">
          <button class="topbar-hamburger" type="button" id="mobileNavToggle"
                  aria-label="打开导航菜单" aria-expanded="false" aria-controls="appSidebar">☰</button>
          <button class="topbar-btn sidebar-collapse-toggle" type="button" id="sidebarCollapseToggle"
                  aria-label="收起侧边栏" aria-expanded="true"
                  title="收起侧边栏（给内容更多空间）"
                  onclick="Layout.toggleSidebar()">☰</button>
          <div>
            <div class="topbar-title">${title}</div>
            <div class="topbar-breadcrumb">
              <span>工作台</span>
              <span>${breadcrumb}</span>
            </div>
          </div>
        </div>
        <div class="topbar-right">
          <span class="tag topbar-offline-badge" id="offlineBadge" hidden
                title="网络不可用：所有数据仍完整保存在本机，联网后自动同步">🌐 离线模式（数据保存在本机）</span>
          <button class="topbar-btn" type="button" aria-label="工作台显示设置" title="工作台显示设置" onclick="Layout.openDisplaySettings()">⚙️</button>
          <button class="topbar-btn admin-topbar-btn" type="button" id="adminToggleBtn"
                  aria-label="管理员登录" title="登录后可新增 / 编辑 / 删除数据"
                  onclick="Auth.toggle()">🔒 管理员登录</button>
          <div class="topbar-date">
            <span>📅</span>
            <span>${dateStr} ${weekStr}</span>
          </div>
        </div>
      </header>
    `;
  },

  /** 🌐 离线状态标签：连续超时后由 Store 点亮，网络恢复后自动隐藏 */
  syncOfflineBadge() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const badge = document.getElementById('offlineBadge');
    if (!badge) return;
    /* 跨 iframe：父页自己的 Store 没记录过网络失败，但子页会把 store:network 转发上来，
       所以优先用事件带来的真实网络状态，其次才看本页 Store。 */
    const fromEvent = typeof window !== 'undefined' ? window.__offlineFromEvent : undefined;
    const offline = typeof fromEvent === 'boolean'
      ? fromEvent
      : (typeof Store !== 'undefined' && typeof Store.isOfflineMode === 'function'
        ? Store.isOfflineMode()
        : (typeof Store !== 'undefined' && Store.cloudState === 'off'));
    badge.hidden = !offline;
  },

  /** 幂等绑定：状态变化 / 同步事件 / 浏览器恢复网络 / 窗口重新聚焦都刷新标签 */
  bindOfflineBadge() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (window.__offlineBadgeBound) return;
    window.__offlineBadgeBound = true;
    const refresh = () => this.syncOfflineBadge();
    window.addEventListener('store:network', event => {
      if (event && typeof event.detail?.offline === 'boolean') {
        window.__offlineFromEvent = event.detail.offline;
      }
      refresh();
    });
    window.addEventListener('store:sync', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', () => {
      /* 优先走 Store 的网络恢复自愈：延期队列回队 + 重排续传 + 撤离线标签 */
      if (typeof Store !== 'undefined' && typeof Store.handleOnline === 'function') {
        Store.handleOnline('online 事件（Layout）');
      } else if (typeof Store !== 'undefined' && typeof Store.sync === 'function') {
        Store.sync();
      }
      refresh();
    });
    this.syncOfflineBadge();
  },

  init(pageName, title, breadcrumb) {
    const root = document.getElementById('app');
    if (!root) return;
    this.documentTitleSuffix = document.title.split(' - ').slice(1).join(' - ') || breadcrumb || title;

    if (new URLSearchParams(window.location.search).get('embed') === '1') {
      const isReportsView = new URLSearchParams(window.location.search).get('view') === 'reports';
      root.innerHTML = `<div class="embedded-page${isReportsView ? ' embedded-reports-only' : ''}"><div class="page-content" id="page-content"></div></div>`;
      return;
    }

    /* 先把折叠状态挂到 body 上，再渲染布局 —— 避免刷新时侧边栏"闪一下" */
    this.applySidebarState(this.isSidebarCollapsed());

    root.innerHTML = `
      <div class="app-layout">
        ${this.sidebarHTML()}
        <div class="mobile-nav-backdrop" id="mobileNavBackdrop"></div>
        <div class="main-area">
          ${this.topbarHTML(title, breadcrumb)}
          <div class="page-content" id="page-content">
            <!-- 页面内容注入点 -->
          </div>
        </div>
      </div>
    `;

    this.bindMobileNav(root);
    this.bindSidebarTooltip(root);
    this.bindOfflineBadge();          // 🌐 顶栏离线状态标签（断网时显示）
    this.applySidebarState(this.isSidebarCollapsed());

    this.applyDisplaySettings(root);
    window.addEventListener('storage', event => {
    if (event.key === this.DISPLAY_SETTINGS_KEY) this.applyDisplaySettings(root);
    });

    const activePage = this.resolvePage(pageName);
    const activeItem = root.querySelector(`.nav-item[data-page="${activePage}"]`);
    if (activeItem) {
      activeItem.classList.add('active');
      const group = activeItem.closest('.nav-group');
      if (group) {
        group.classList.add('has-active-page');
        this.setNavigationGroupExpanded(group.dataset.navGroup, true);
      }
    }
  },

  /* ==========================================================================
   * 侧边栏折叠
   * ========================================================================== */

  /** 读折叠状态（localStorage；Store 的本地镜像就是 localStorage） */
  isSidebarCollapsed() {
    try {
      const value = Store.read(this.SIDEBAR_COLLAPSED_KEY, false);
      return value === true || value === 'true';
    } catch (error) {
      console.error('读取侧边栏折叠状态失败', error);
      return false;
    }
  },

  /** 写折叠状态（只落本地，不上云） */
  saveSidebarCollapsed(collapsed) {
    try {
      Store.write(this.SIDEBAR_COLLAPSED_KEY, !!collapsed, { push: false });
    } catch (error) {
      console.error('保存侧边栏折叠状态失败', error);
      try { localStorage.setItem(this.SIDEBAR_COLLAPSED_KEY, JSON.stringify(!!collapsed)); } catch (ignore) { /* 忽略 */ }
    }
  },

  /** 把折叠状态应用到页面（body 上的 class 驱动全部样式） */
  applySidebarState(collapsed) {
    const isCollapsed = !!collapsed;
    document.body.classList.toggle('sidebar-collapsed', isCollapsed);
    const toggle = document.getElementById('sidebarCollapseToggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      toggle.setAttribute('aria-label', isCollapsed ? '展开侧边栏' : '收起侧边栏');
      toggle.title = isCollapsed ? '展开侧边栏' : '收起侧边栏（给内容更多空间）';
    }
    return isCollapsed;
  },

  /** 点 ☰ → 折叠 / 展开 */
  toggleSidebar() {
    const collapsed = !document.body.classList.contains('sidebar-collapsed');
    this.saveSidebarCollapsed(collapsed);
    this.applySidebarState(collapsed);
  },

  /**
   * 折叠态的悬浮提示：鼠标停在图标上，右侧弹一个黑色小框写清楚这是什么。
   * 用 fixed 定位（不放在侧边栏里），避免被 .sidebar-nav 的 overflow 裁掉。
   */
  bindSidebarTooltip(root) {
    const sidebar = root.querySelector('.sidebar');
    if (!sidebar) return;
    let tip = null;

    const hide = () => {
      if (tip) { tip.remove(); tip = null; }
    };

    root.querySelectorAll('.nav-item, .nav-group-toggle').forEach(item => {
      item.addEventListener('mouseenter', () => {
        if (!document.body.classList.contains('sidebar-collapsed')) return;
        const label = item.getAttribute('data-tip');
        if (!label) return;
        hide();
        const itemRect = item.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        tip = document.createElement('div');
        tip.className = 'sidebar-tip';
        tip.textContent = label;
        tip.style.top = `${itemRect.top + itemRect.height / 2}px`;
        tip.style.left = `${sidebarRect.right + 10}px`;
        document.body.appendChild(tip);
      });
      item.addEventListener('mouseleave', hide);
      item.addEventListener('click', hide);
    });

    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
  },

  /**
   * 手机端汉堡菜单：侧边栏在窄屏下是"抽屉"（CSS 控制滑入滑出），
   * 这里只负责开关状态与各种关闭时机。
   * 桌面端点了也没用（抽屉按钮在 >768px 时不显示）。
   */
  bindMobileNav(root) {
    const toggle = root.querySelector('#mobileNavToggle');
    const backdrop = root.querySelector('#mobileNavBackdrop');
    const sidebar = root.querySelector('.sidebar');
    if (!toggle || !sidebar) return;

    const setOpen = open => {
      document.body.classList.toggle('mobile-nav-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? '✕' : '☰';
    };

    toggle.addEventListener('click', event => {
      event.stopPropagation();
      setOpen(!document.body.classList.contains('mobile-nav-open'));
    });
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));
    // 点导航项后自动收起（手机上挡住了内容）
    sidebar.querySelectorAll('.nav-item, .nav-subitem').forEach(item => {
      item.addEventListener('click', () => setOpen(false));
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') setOpen(false);
    });
    // 转屏 / 窗口变宽 → 自动收起抽屉
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768) setOpen(false);
    });
  },

  applyDisplaySettings(root = document) {
    const settings = this.getDisplaySettings();
    const brand = root.querySelector('.brand-text');
    const teacher = root.querySelector('.sidebar-footer .user-name');
    const greeting = root.querySelector('#dashboardGreetingName');
    if (brand) brand.textContent = settings.workspaceName;
    if (teacher) teacher.textContent = settings.teacherName;
    if (greeting) greeting.textContent = settings.teacherName;
    if (this.documentTitleSuffix) {
      document.title = `${settings.workspaceName} - ${this.documentTitleSuffix}`;
    }
  },

  openDisplaySettings() {
    const settings = this.getDisplaySettings();
    showModal('工作台显示设置', `
      <form id="displaySettingsForm" onsubmit="return false;">
        <div class="form-group">
          <label for="displayWorkspaceName">工作台名称</label>
          <input id="displayWorkspaceName" class="form-control" name="workspaceName" maxlength="40" required value="${this.escapeHTML(settings.workspaceName)}">
        </div>
        <div class="form-group">
          <label for="displayTeacherName">老师称呼</label>
          <input id="displayTeacherName" class="form-control" name="teacherName" maxlength="30" required value="${this.escapeHTML(settings.teacherName)}">
        </div>
      </form>
    `, `
      <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
      <button class="btn btn-primary" onclick="Layout.saveDisplaySettings(this)">保存</button>
    `);
  },

  saveDisplaySettings(button) {
    const form = button.closest('.modal-overlay')?.querySelector('#displaySettingsForm');
    if (!form) return;
    const formData = new FormData(form);
    const workspaceName = String(formData.get('workspaceName') || '').trim();
    const teacherName = String(formData.get('teacherName') || '').trim();
    if (!workspaceName || !teacherName) {
      showToast('请填写工作台名称和老师称呼。', 'error');
      return;
    }
    const settings = { workspaceName, teacherName };
    try {
      Store.write(this.DISPLAY_SETTINGS_KEY, settings);
    } catch (error) {
      console.error('保存工作台显示设置失败', error);
      showToast('设置保存失败，请检查浏览器本地存储空间或权限。', 'error');
      return;
    }
    this.applyDisplaySettings();
    closeModal(button);
    showToast('工作台显示设置已保存。');
  },

  resolvePage(pageName) {
    const pageAliases = {
      registration: 'sports-meet',
      schedule: 'sports-meet',
      results: 'sports-meet',
    };
    return pageAliases[pageName] || pageName;
  },

  toggleNavigationGroup(groupId) {
    const group = document.querySelector(`.nav-group[data-nav-group="${groupId}"]`);
    if (!group) return;
    const isExpanded = group.querySelector('.nav-group-toggle')?.getAttribute('aria-expanded') === 'true';
    this.setNavigationGroupExpanded(groupId, !isExpanded);
  },

  setNavigationGroupExpanded(groupId, expanded) {
    const group = document.querySelector(`.nav-group[data-nav-group="${groupId}"]`);
    const toggle = group?.querySelector('.nav-group-toggle');
    const submenu = group?.querySelector('.nav-submenu');
    if (!toggle || !submenu) return;
    group.classList.toggle('is-expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    submenu.hidden = !expanded;
  },
};

// Toast 工具
function showToast(message, type = 'success') {
  // 移除已有 toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// 模态框工具
function showModal(title, bodyHTML, footerHTML = '', overlayClass = '') {
  const overlay = document.createElement('div');
  overlay.className = `modal-overlay${overlayClass ? ` ${overlayClass}` : ''}`;
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2 class="modal-title">${title}</h2>
        <button class="modal-close" onclick="closeModal(this)">&times;</button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
      ${footerHTML ? `<div class="modal-footer">${footerHTML}</div>` : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.querySelector('.modal-close'));
  });
  return overlay;
}

function closeModal(btn) {
  // ⚠️ 空值保护：关闭时按钮可能已经被移除 / 还没插入 DOM，
  //    直接 btn.closest() 会抛 "Cannot read properties of undefined (reading 'closest')"，
  //    一次报错就打断整条流程（关弹窗失败 → 页面状态错乱）。
  if (!btn) return;
  const overlay = typeof btn.closest === 'function' ? btn.closest('.modal-overlay') : null;
  if (overlay) {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 300);
  }
}

// 格式化日期
function formatDate(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
