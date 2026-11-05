/**
 * 管理员 / 游客 权限控制（前端）
 *
 * 设计原则：前端只做【体验】，不做【安全】—— 真正的安全底线在服务端
 * （lib/admin-auth.js：写请求必须带 X-Admin-Password，否则 403）。
 * 前端三件事：
 *   ① 状态：localStorage 记住是不是管理员（刷新后保持）
 *   ② 拦截：写请求没登录就直接不发，并提示"请先登录管理员"
 *   ③ 隐藏：游客看不到"保存 / 删除 / 导入 / 一键生成"等按钮
 *
 * 用法（页面里直接写）：
 *   Auth.isAdmin()                 → true / false
 *   Auth.guard('保存学生')          → 不是管理员就弹登录框并返回 false
 *   <button data-admin-only ...>   → 游客模式下自动隐藏
 */
'use strict';

const Auth = {
  FLAG_KEY: 'isAdmin',
  PASSWORD_KEY: 'pe_admin_password',
  _observer: null,
  _toastAt: 0,
  _modalOpen: false,

  /* ------------------------------ 状态 ------------------------------ */

  isAdmin() {
    try { return localStorage.getItem(this.FLAG_KEY) === 'true'; } catch (error) { return false; }
  },

  getPassword() {
    try { return localStorage.getItem(this.PASSWORD_KEY) || ''; } catch (error) { return ''; }
  },

  setAdmin(password) {
    try {
      localStorage.setItem(this.FLAG_KEY, 'true');
      localStorage.setItem(this.PASSWORD_KEY, String(password || ''));
    } catch (error) { /* 无痕模式等写不进去，忽略 */ }
  },

  clearAdmin() {
    try {
      localStorage.removeItem(this.FLAG_KEY);
      localStorage.removeItem(this.PASSWORD_KEY);
    } catch (error) { /* 忽略 */ }
  },

  /* ------------------------------ 登录 / 退出 ------------------------------ */

  /**
   * 校验密码（请求后端 /api/admin，密码只在服务端比对）
   * @returns {Promise<boolean>}
   */
  async login(password) {
    const value = String(password || '').trim();
    if (!value) {
      this.toast('请输入管理员密码', 'error');
      return false;
    }
    try {
      const response = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: value }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        this.setAdmin(value);
        this.toast('已进入管理员模式', 'success');
        this.closeLoginModal();
        this.refresh();
        return true;
      }
      if (data.adminConfigured === false) {
        this.toast(data.error || '服务端未配置管理员密码（ADMIN_PASSWORD）', 'error');
      } else {
        this.toast(data.error || '密码错误，无法进入管理员模式', 'error');
      }
      return false;
    } catch (error) {
      this.toast(`登录失败：${error?.message || error}`, 'error');
      return false;
    }
  },

  logout() {
    this.clearAdmin();
    this.toast('已退出管理员模式（游客只读）', 'success');
    this.refresh();
  },

  /** 顶栏按钮点击入口（唯一允许弹登录框的地方） */
  toggle() {
    if (this.isAdmin()) {
      this.logout();
      return;
    }
    this.openLoginModal(true);
  },

  /**
   * 写操作前的守卫：不是管理员就发不出请求
   * ⚠️ 绝不弹登录框 —— 只给一条 3 秒轻提示，绝不打断浏览。
   *    登录框只有顶栏那个 🔒 按钮点开时才允许出现。
   * @param {string} action 动作名（提示语用，比如"保存学生"）
   * @returns {boolean} true = 放行
   */
  guard(action = '这个操作') {
    if (this.isAdmin()) return true;
    this.notifyGuest();
    console.warn(`[Auth] 游客模式下拦截了「${action}」`);
    return false;
  },

  /**
   * 游客轻提示：3 秒后自动消失，绝不打断浏览。
   * 带节流（默认 8 秒一条）：后台同步可能连续触发多次，不能刷屏。
   */
  notifyGuest(message = '游客只能查看数据，修改请先点击右上角登录') {
    /* ⚠️ 只有【用户刚刚动过手】（3 秒内有点击 / 输入）才提示；
       页面初始化、数据迁移、同步补推这类后台写入一律静默（只记日志）——
       否则每切一个页面就冒一条提示，等于换了个形式继续烦人。 */
    if (!this.isUserInitiated()) {
      console.warn(`[Auth] ${message}（后台触发，静默处理）`);
      return;
    }
    const now = Date.now();
    if (now - this._toastAt < 3000) return;      // 3 秒内不重复刷屏
    this._toastAt = now;
    this.toast(message, 'error');
  },

  /** 记住"用户刚刚动过手"（用于区分主动操作与后台自动流程） */
  _markUserAction() {
    this._lastUserAction = Date.now();
  },

  /** 这次是不是用户主动触发的？ */
  isUserInitiated() {
    return Date.now() - (this._lastUserAction || 0) < 3000;
  },

  /* ------------------------------ 登录弹窗 ------------------------------ */

  /**
   * 打开登录弹窗。
   * ⚠️【只有顶栏那个 🔒 按钮点开时才允许调用】——
   *    任何"被拦截 / 403 / 后台同步"之类的被动触发，都只能给 3 秒轻提示，
   *    绝不能把登录框怼到用户脸上（那会打断浏览，是最招人烦的体验）。
   * @param {boolean} manual true = 用户主动点击顶栏按钮
   */
  openLoginModal(manual = false) {
    if (!manual) {
      this.notifyGuest();
      return;
    }
    if (this._modalOpen) return;
    if (typeof showModal !== 'function') {
      const password = window.prompt('请输入管理员密码：');
      if (password !== null) this.login(password);
      return;
    }
    this._modalOpen = true;
    showModal(
      '🔒 管理员登录',
      `<div class="admin-login">
         <p class="admin-login-tip">游客只能查看数据；登录后才能新增、编辑、删除和调用 AI 生成。</p>
         <label class="admin-login-label" for="adminPasswordInput">管理员密码</label>
         <input id="adminPasswordInput" class="admin-login-input" type="password"
           autocomplete="current-password" placeholder="输入管理员密码"
           onkeydown="if(event.key==='Enter')Auth.submitLogin()">
       </div>`,
      `<button class="btn btn-secondary" type="button" onclick="Auth.closeLoginModal()">取消</button>
       <button class="btn btn-primary" type="button" id="adminLoginSubmit" onclick="Auth.submitLogin()">登录</button>`,
    );
    try { document.getElementById('adminPasswordInput')?.focus(); } catch (error) { /* 忽略 */ }
  },

  async submitLogin() {
    const input = document.getElementById('adminPasswordInput');
    const button = document.getElementById('adminLoginSubmit');
    const password = input?.value || '';
    if (button) {
      button.disabled = true;
      button.textContent = '验证中…';
    }
    const ok = await this.login(password);
    if (button) {
      button.disabled = false;
      button.textContent = '登录';
    }
    if (!ok && input) {
      input.value = '';
      input.focus();
    }
  },

  closeLoginModal() {
    this._modalOpen = false;
    const overlay = document.querySelector('.modal-overlay');
    if (overlay) {
      const closeBtn = overlay.querySelector('.modal-close');
      if (closeBtn && typeof closeModal === 'function') closeModal(closeBtn);
      else overlay.remove();
    }
  },

  /* ------------------------------ 请求拦截 ------------------------------ */

  isWriteMethod(method) {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || 'GET').toUpperCase());
  },

  /**
   * 给请求加上管理员凭据（写请求才加）
   * @returns {{headers:Object}|null} null = 游客，不能发这个请求
   */
  withAdminHeader(options = {}, url = '') {
    if (!this.isWriteMethod(options.method)) return { headers: options.headers || {} };
    // 登录接口本身是"门"，不能要求先登录
    if (String(url).includes('/api/admin')) return { headers: options.headers || {} };
    if (!this.isAdmin() || !this.getPassword()) {
      const error = new Error('请先登录管理员');
      error.adminRequired = true;
      throw error;
    }
    return {
      ...options,
      headers: { ...(options.headers || {}), 'X-Admin-Password': this.getPassword() },
    };
  },

  /**
   * 全局 fetch 守卫：把不走 Store 的写请求（AI 生成 / 迁移工具）也拦住。
   * Store 自己在 _fetchJSON 里也有一道，这里是兜底（同一个逻辑，重复加头无害）。
   */
  installFetchGuard() {
    if (this._fetchPatched || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    this._fetchPatched = true;
    const original = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const method = init?.method || (typeof input === 'object' ? input?.method : 'GET') || 'GET';
      if (this.isWriteMethod(method) && url.includes('/api/') && !url.includes('/api/admin')) {
        if (!this.isAdmin() || !this.getPassword()) {
          // ⚠️ 只给 3 秒轻提示，绝不自动弹登录框（自动弹窗会打断浏览）
          this.notifyGuest();
          return Promise.reject(new Error('请先登录管理员'));
        }
        init = {
          ...init,
          headers: { ...(init.headers || {}), 'X-Admin-Password': this.getPassword() },
        };
      }
      return original(input, init);
    };
  },

  /* ------------------------------ UI 隐藏 ------------------------------ */

  /**
   * 游客隐藏的写操作动作（onclick 里的函数名）。
   * 写法：显式清单 + 关键词前缀。显式清单保证今天的代码 100% 覆盖，
   * 前缀保证以后新加的按钮也不会漏。
   */
  ADMIN_ACTIONS: new Set([
    'setAllEventFormats', 'setScheduleDay', 'startSportsMeetTitleEdit', 'reuseLessonTemplate',
    'triggerUpload', 'continueLessonWithAI', 'autoFixStructure', 'openLessonModal',
    'openMeetEventManager', 'openBulkClassChange', 'requestFitnessPurge', 'requestClearFitnessWeek',
    'requestMeetPurge', 'resetFitnessForm', 'handleToggleTodo', 'toggleLessonFavorite',
    'OfflineResources.wbSave', 'OfflineResources.dismissImport', 'OfflineResources.openWorkbench',
    'Layout.saveDisplaySettings', 'saveDisplaySettings', 'commitImport', 'deleteSelectedAthletes',
    'clearAllRegistrations', 'removeManagedMeetEvent', 'removeLocalKey',
  ]),

  /** 这些动作用来"读"，任何情况下都不隐藏（万一被关键词误伤，以这条为准） */
  PUBLIC_ACTIONS: new Set([
    'viewLesson', 'closeModal', 'switchView', 'switchWeekMode', 'changePage',
    'downloadTemplate', 'downloadStudentImportTemplate', 'downloadRegistrationTemplate',
    'exportUnitWord', 'exportScheduleWord', 'exportResultsBook', 'exportTeamAwards',
    'exportAwardList', 'exportSelectedStudents', 'exportRegistrationTemplateExcel',
    'exportRankingCsv', 'exportRankingExcel', 'printUnitPlan', 'printSchedule',
    'printFilteredScoreSheets', 'printAllScoreSheets', 'reloadRefereePage', 'renderPage',
    'toggleUnitModule', 'toggleAllUnitModules', 'showUnitLessonDetail', 'lessonView',
    'favoritesOnly', 'selectedResourceTag', 'selectSportsMeetTab', 'openFitnessDayDetail',
    'openClassDetail', 'openUnitResourcePicker', 'backToStep1', 'OfflineResources.view',
    'OfflineResources.printUnit', 'OfflineResources.exportWord', 'OfflineResources.wbExport',
    'OfflineResources.wbGo', 'OfflineResources.wbCancel', 'OfflineResources.pick',
    'OfflineResources.downloadResourceMarkdown', 'OfflineResources.downloadTemplate',
    'OfflineResources.renderPage', 'OfflineResources.closeModals', 'Layout.toggleNavigationGroup',
    'Layout.openDisplaySettings', 'continueLessonWithAI_READONLY',
  ]),

  /** 从元素的 onclick 里取出动作名 */
  readActionName(node) {
    const raw = node?.getAttribute?.('onclick') || '';
    const match = raw.match(/([A-Za-z_$][\w$.]*)\s*\(/);
    return match ? match[1] : '';
  },

  /** 这个动作是不是写操作 */
  isWriteAction(name) {
    const full = String(name || '').trim();
    if (!full) return false;
    if (this.PUBLIC_ACTIONS.has(full)) return false;
    if (this.ADMIN_ACTIONS.has(full)) return true;
    const base = full.split('.').pop() || '';
    // ① 写动词开头
    if (/^(save|delete|remove|clear|purge|generate|regenerate|revoke|commit|submit|create|import|upload|add|edit|reset|sync|restore|confirm|handleAdd|handleDelete|handleSave|handleToggle|toggleLessonFavorite)/i.test(base)) {
      return true;
    }
    // ② open* 里带写意图的（openAddRecord / openEditRecord / openBatchImport …）
    if (/^open/i.test(base) && /(add|edit|batch|quick|import|upload|manual|ai|generation|workbench|create)/i.test(base)) {
      return true;
    }
    return false;
  },

  /**
   * 按权限刷新界面：游客隐藏所有写操作按钮，管理员恢复显示。
   * @param {ParentNode} root 默认整个页面
   */
  applyAdminUI(root = document.body) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const admin = this.isAdmin();
    // 权限状态标记：状态没变 + 这个节点处理过 → 跳过（课表那种上千个节点的页面才不会卡）
    const stamp = admin ? 'admin' : 'guest';
    let nodes = [];
    try {
      nodes = [...root.querySelectorAll('[data-admin-only], [onclick]')];
    } catch (error) {
      return;
    }
    nodes.forEach(node => {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      if (node.getAttribute?.('data-admin-checked') === stamp) return;
      const forced = node.hasAttribute('data-admin-only');
      const write = forced || this.isWriteAction(this.readActionName(node));
      if (!admin && write) {
        node.classList.add('admin-only-hidden');
        node.style.setProperty('display', 'none', 'important');
      } else if (node.classList.contains('admin-only-hidden')) {
        node.classList.remove('admin-only-hidden');
        node.style.removeProperty('display');
      }
      try { node.setAttribute('data-admin-checked', stamp); } catch (error) { /* 忽略 */ }
    });
  },

  /** 顶栏按钮：🔒 管理员登录 / 🔓 退出管理 */
  refreshTopbar() {
    const button = document.getElementById('adminToggleBtn');
    if (!button) return;
    const admin = this.isAdmin();
    button.textContent = admin ? '🔓 退出管理' : '🔒 管理员登录';
    button.title = admin ? '退出管理员模式（回到游客只读）' : '登录后可新增 / 编辑 / 删除数据';
    button.classList.toggle('is-admin', admin);
  },

  /** 一次刷新到位：按钮 + 界面 */
  refresh() {
    this.refreshTopbar();
    this.applyAdminUI();
  },

  toast(message, type = 'error') {
    if (typeof showToast === 'function') {
      showToast(message, type);
      return;
    }
    console.warn(`[Auth] ${message}`);
  },

  /* ------------------------------ 启动 ------------------------------ */

  init() {
    this.installFetchGuard();          // 必须最先装：越早拦截越好
    this.refreshTopbar();
    this.applyAdminUI();
    /* 记住"用户刚刚动过手"：
       用来区分【用户主动点的写操作】（该给提示）和【后台自动流程】（该静默）。
       否则页面初始化时的数据迁移也会冒提示，等于每切一页就烦一次。 */
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      ['click', 'keydown', 'submit', 'change'].forEach(type => {
        document.addEventListener(type, () => this._markUserAction(), true);
      });
    }
    // 页面内容是动态渲染的（表格行、弹窗按钮都是后插进来的），
    // 所以挂一个 MutationObserver：DOM 一变就按权限重新刷一遍
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && !this._observer) {
      let timer = null;
      this._observer = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => this.applyAdminUI(), 60);
      });
      this._observer.observe(document.body, { childList: true, subtree: true });
    }
  },
};

/* 其它标签页登录/退出时，本页跟着变（多个 Tab 同时开着） */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === Auth.FLAG_KEY) Auth.refresh();
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Auth.init());
  } else {
    Auth.init();
  }
}

window.Auth = Auth;
