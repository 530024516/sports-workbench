/**
 * 公共布局 - 侧边栏 + 顶部栏
 * 所有页面共享
 */

const Layout = {
  DISPLAY_SETTINGS_KEY: 'pe_workbench_display_settings_v1',
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
        { id: 'students', label: '学生信息', icon: '👥', href: 'students.html' },
        { id: 'fitness', label: '体测数据', icon: '💪', href: 'fitness.html' },
        { id: 'lessons', label: '教案与资源', icon: '📋', href: 'lessons.html' },
        { id: 'unit-design', label: '大单元设计', icon: '🧩', href: 'unit-design.html' },
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
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="logo">🏃</div>
        <span class="brand-text">${this.escapeHTML(settings.workspaceName)}</span>
      </div>
      <nav class="sidebar-nav">
        ${this.navigation.map(item => item.children
          ? `<div class="nav-group" data-nav-group="${item.id}">
              <button class="nav-group-toggle" type="button" aria-expanded="false"
                aria-controls="navGroup-${item.id}" onclick="Layout.toggleNavigationGroup('${item.id}')">
                <span class="nav-icon">${item.icon}</span>
                <span class="nav-text">${item.label}</span>
                <span class="nav-group-chevron" aria-hidden="true">▾</span>
              </button>
              <div class="nav-submenu" id="navGroup-${item.id}" hidden>
                ${item.children.map(child => `<a class="nav-item nav-subitem" data-page="${child.id}" href="${child.href}">
                  <span class="nav-icon">${child.icon}</span><span class="nav-text">${child.label}</span>
                </a>`).join('')}
              </div>
            </div>`
          : `<a class="nav-item nav-root-item" data-page="${item.id}" href="${item.href}">
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
          <div>
            <div class="topbar-title">${title}</div>
            <div class="topbar-breadcrumb">
              <span>工作台</span>
              <span>${breadcrumb}</span>
            </div>
          </div>
        </div>
        <div class="topbar-right">
          <button class="topbar-btn" type="button" aria-label="工作台显示设置" title="工作台显示设置" onclick="Layout.openDisplaySettings()">⚙️</button>
          <div class="topbar-date">
            <span>📅</span>
            <span>${dateStr} ${weekStr}</span>
          </div>
        </div>
      </header>
    `;
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

    root.innerHTML = `
      <div class="app-layout">
        ${this.sidebarHTML()}
        <div class="main-area">
          ${this.topbarHTML(title, breadcrumb)}
          <div class="page-content" id="page-content">
            <!-- 页面内容注入点 -->
          </div>
        </div>
      </div>
    `;

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
function showModal(title, bodyHTML, footerHTML = '') {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
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
  const overlay = btn.closest('.modal-overlay');
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
