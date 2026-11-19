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
  /* 公开离线版：本地模式 + AI 权限 + 服务端签发的 AI 票（票不是密码，不落明文） */
  LOCAL_MODE_KEY: 'isLocalMode',
  CAN_AI_KEY: 'canUseAI',
  PUBLIC_MODE_KEY: 'pe_public_mode',
  PUBLIC_TOKEN_KEY: 'pe_public_ai_token',
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

  /* ---------------------- 公开离线版权限状态 ---------------------- */

  isLocalMode() {
    try { return localStorage.getItem(this.LOCAL_MODE_KEY) === 'true'; } catch (error) { return false; }
  },

  canUseAI() {
    try { return localStorage.getItem(this.CAN_AI_KEY) === 'true'; } catch (error) { return false; }
  },

  getPublicToken() {
    try { return localStorage.getItem(this.PUBLIC_TOKEN_KEY) || ''; } catch (error) { return ''; }
  },

  setPublicSession(mode, token = '') {
    try {
      localStorage.setItem(this.LOCAL_MODE_KEY, 'true');
      localStorage.setItem(this.CAN_AI_KEY, mode === 'ai' ? 'true' : 'false');
      localStorage.setItem(this.PUBLIC_MODE_KEY, mode === 'ai' ? 'ai' : 'local');
      if (token) localStorage.setItem(this.PUBLIC_TOKEN_KEY, String(token));
      else localStorage.removeItem(this.PUBLIC_TOKEN_KEY);
    } catch (error) { /* 无痕模式忽略 */ }
    /* ✅ 重新登录成功：解除 Store 因 401/403 挂起的后台同步熔断 */
    try { window.Store?.clearAuthBlock?.('公开版重新登录'); } catch (error) { /* 忽略 */ }
  },

  clearPublicSession() {
    try {
      [this.LOCAL_MODE_KEY, this.CAN_AI_KEY, this.PUBLIC_MODE_KEY, this.PUBLIC_TOKEN_KEY]
        .forEach(key => localStorage.removeItem(key));
    } catch (error) { /* 忽略 */ }
  },

  /**
   * ⏰ AI 体验票过期：只清「AI 权限 + 票」，保留「纯本地模式」。
   * 这样老师还在本地数据环境里，只是 AI 按钮重新置灰，重新输一次体验密码即可恢复。
   */
  expirePublicAI() {
    try {
      localStorage.removeItem(this.CAN_AI_KEY);
      localStorage.removeItem(this.PUBLIC_TOKEN_KEY);
      localStorage.setItem(this.PUBLIC_MODE_KEY, 'local');
    } catch (error) { /* 忽略 */ }
    this.refresh();
  },

  /** 收到 401 TOKEN_EXPIRED：弹窗说明 + 清掉过期票（不自动弹登录框，点按钮才弹） */
  notifyPublicTokenExpired() {
    this.expirePublicAI();
    if (this._expiryModalOpen) return;
    const message = 'AI 体验权限已过期，请重新输入体验密码登录';
    if (typeof showModal !== 'function' || typeof closeModal !== 'function') {
      if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(message);
      this.openLoginModal(true);
      return;
    }
    this._expiryModalOpen = true;
    showModal('🔑 AI 体验权限已过期', `
      <div class="admin-login">
        <p class="admin-login-tip">${message}</p>
        <p class="admin-login-tip">体验票有效期为 12 小时，过期后需要重新输入体验密码。</p>
      </div>
    `, `
      <button class="btn btn-ghost" type="button" onclick="Auth.closeExpiryModal(this)">稍后再说</button>
      <button class="btn btn-primary" type="button" onclick="Auth.reloginAfterExpiry(this)">重新输入体验密码</button>
    `);
  },

  closeExpiryModal(button) {
    this._expiryModalOpen = false;
    closeModal(button);
  },

  reloginAfterExpiry(button) {
    this._expiryModalOpen = false;
    closeModal(button);
    /* 等关闭动画走完再开登录框，避免两个弹窗叠在一起 */
    setTimeout(() => this.openLoginModal(true), 320);
  },

  setAdmin(password) {
    try {
      localStorage.setItem(this.FLAG_KEY, 'true');
      localStorage.setItem(this.PASSWORD_KEY, String(password || ''));
    } catch (error) { /* 无痕模式等写不进去，忽略 */ }
    this.clearPublicSession();
    /* ✅ 重新登录成功：解除 Store 因 401/403 挂起的后台同步熔断 */
    try { window.Store?.clearAuthBlock?.('管理员重新登录'); } catch (error) { /* 忽略 */ }
  },

  clearAdmin() {
    try {
      localStorage.removeItem(this.FLAG_KEY);
      localStorage.removeItem(this.PASSWORD_KEY);
    } catch (error) { /* 忽略 */ }
    this.clearPublicSession();
  },

  /* ------------------------------ 登录 / 退出 ------------------------------ */

  /**
   * 校验密码（请求后端 /api/admin，密码只在服务端比对）
   * @returns {Promise<boolean>}
   */
  async login(password) {
    const value = String(password || '').trim();
    if (!value) {
      this.toast('请输入密码', 'error');
      return false;
    }
    /* ① 先试公开离线版双密码：本地密码只解本机功能，AI 密码才拿到服务端票 */
    try {
      const publicResponse = await fetch('/api/public-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: value }),
      });
      const publicData = await publicResponse.json().catch(() => ({}));
      if (publicResponse.ok && publicData.ok) {
        this.setPublicSession(publicData.mode, publicData.token);
        this.toast(publicData.mode === 'ai'
          ? '已进入本地畅玩版：AI 功能已解锁'
          : '已进入纯本地模式：仅本机功能，AI 已关闭', 'success');
        this.closeLoginModal();
        this.refresh();
        return true;
      }
    } catch (error) {
      /* 老后端没有 /api/public-auth：继续回退到原管理员密码 */
    }

    /* ② 回退：原有管理员密码（本地私有部署仍可用） */
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
    if (this.isAdmin() || this.isLocalMode()) return true;
    this.notifyGuest();
    console.warn(`[Auth] 游客模式下拦截了「${action}」`);
    return false;
  },

  /** AI 专属守卫：纯本地模式一律拦下，并给指定提示 */
  guardAI(action = 'AI 生成') {
    if (this.canUseAI() || this.isAdmin()) return true;
    this.toast('当前为纯本地模式，请使用 AI 体验密码登录才能生成', 'error');
    console.warn(`[Auth] 纯本地模式下拦截了「${action}」`);
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
      '🔒 登录工作台',
      `<div class="admin-login">
         <p class="admin-login-tip">纯本地密码：仅本机功能（无 AI）；AI 体验密码：全部功能可用（含 AI）。</p>
         <label class="admin-login-label" for="adminPasswordInput">密码</label>
         <input id="adminPasswordInput" class="admin-login-input" type="password"
           autocomplete="current-password" placeholder="输入本地密码或 AI 体验密码"
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

  isAICall(url) {
    const value = String(url || '');
    return value.includes('/api/ai')
      || value.startsWith('/api/generate-')
      || value.startsWith('/api/fitness');
  },

  /**
   * 公开离线版的 AI 请求加票；非 AI 请求返回 null 交给原来的管理员逻辑。
   * 本地数据请求 (/api/data) 不管什么票都返回 null —— 前端 Store 直接不发，
   * 服务端也只认管理员密码，双保险。
   */
  withPublicAIHeader(options = {}, url = '') {
    if (!this.isLocalMode() || !this.isAICall(url)) return null;
    if (!this.canUseAI() || !this.getPublicToken()) {
      const error = new Error('当前为纯本地模式，请使用 AI 体验密码登录才能生成');
      error.publicAIRequired = true;
      this.toast(error.message, 'error');
      throw error;
    }
    return {
      ...options,
      headers: { ...(options.headers || {}), 'X-Public-AI-Token': this.getPublicToken() },
    };
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
  localFetchResponse(payload) {
    const text = JSON.stringify(payload);
    if (typeof Response === 'function') {
      return Promise.resolve(new Response(text, {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => text, json: async () => payload });
  },

  installFetchGuard() {
    if (this._fetchPatched || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    this._fetchPatched = true;
    const original = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const method = String(init?.method
        || (typeof input === 'object' ? input?.method : 'GET') || 'GET').toUpperCase();

      /* 🛑 公开离线版：/api/data 一个字节都不发，全走 localStorage */
      if (this.isLocalMode() && url.includes('/api/data')) {
        return this.localFetchResponse({
          ok: true, mode: 'local', skipped: true, data: null, report: [],
        });
      }

      /* 🛑 AI 权限闸门：纯本地模式不许调用任何 AI 路由（含旧地址） */
      if (this.isAICall(url)) {
        try {
          const publicInit = this.withPublicAIHeader(init, url);
          if (publicInit) init = publicInit;
        } catch (error) {
          return Promise.reject(error);
        }
      }

      if (this.isWriteMethod(method) && url.includes('/api/')
          && !url.includes('/api/admin') && !url.includes('/api/public-auth')) {
        if (this.isLocalMode()) {
          /* 本地模式的 AI 票已在上面加好；其余写请求不走服务端 */
          if (!this.isAICall(url)) {
            return this.localFetchResponse({ ok: true, mode: 'local', skipped: true });
          }
        } else if (!this.isAdmin() || !this.getPassword()) {
          // ⚠️ 只给 3 秒轻提示，绝不自动弹登录框（自动弹窗会打断浏览）
          this.notifyGuest();
          return Promise.reject(new Error('请先登录管理员'));
        } else {
          init = {
            ...init,
            headers: { ...(init.headers || {}), 'X-Admin-Password': this.getPassword() },
          };
        }
      }
      const response = original(input, init);
      if (!response || typeof response.then !== 'function') return response;

      /* ⚡ 性能闸门（Vercel 线上卡顿主因之一）：
         只有【/api/ 下的写请求 + 本地确实有 AI 票】才可能需要解析 TOKEN_EXPIRED。
         其余（静态资源、GET、200 成功响应、根本没票的游客）直接返回原始 Promise，
         连 .then() 都不挂、更不做 response.clone().json() —— 主线程零额外开销。 */
      const isApi = url.includes('/api/');
      const isReadOnly = method === 'GET' || method === 'HEAD';
      const mightExpire = isApi && !isReadOnly && Boolean(this.getPublicToken());
      if (!mightExpire) return response;

      /* ⏰ 无状态 JWT 过期 / 伪造：服务端回 401 TOKEN_EXPIRED。
         用 clone() 偷看错误体，绝不消费调用方要读的响应流（SSE / JSON 都不受影响）。 */
      return response.then(res => {
        if (res?.ok || res?.status !== 401 || typeof res.clone !== 'function') return res;
        res.clone().json().then(detail => {
          if (detail?.code === 'TOKEN_EXPIRED' || detail?.tokenExpired === true) {
            this.notifyPublicTokenExpired();
          }
        }).catch(() => { /* 错误体不是 JSON：忽略，不打断业务 */ });
        return res;
      }, error => {
        /* Store 等路径自己解析错误体后抛上来的 error.code 也接住 */
        if (error?.code === 'TOKEN_EXPIRED') this.notifyPublicTokenExpired();
        throw error;
      });
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
  isAIButton(node) {
    if (node?.getAttribute?.('data-ai-action') === 'true') return true;
    if (['ud2GenerateBtn', 'generateLessonButton', 'fitnessGenerateBtn'].includes(node?.id)) return true;
    const text = `${node?.textContent || ''} ${node?.title || ''}`;
    return /一键生成|AI 生成|生成教案草稿|生成今日训练计划|继续生成/.test(text);
  },

  applyAdminUI(root = document.body) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const admin = this.isAdmin();
    const local = this.isLocalMode();
    const canWrite = admin || local;                  // 公开本地版允许本机写，但不碰云端
    const aiBlocked = local && !this.canUseAI();
    // 权限状态标记：状态没变 + 这个节点处理过 → 跳过（课表那种上千个节点的页面才不会卡）
    const stamp = admin ? 'admin' : local ? (this.canUseAI() ? 'local-ai' : 'local') : 'guest';
    /* 分三次查：保留老选择器（历史测试与精简 DOM 实现都认它），再补 AI / button 选择器 */
    const nodes = [];
    const seen = new Set();
    ['[data-admin-only], [onclick]', '[data-ai-action]', 'button'].forEach(selector => {
      let found = [];
      try { found = [...root.querySelectorAll(selector)]; } catch (error) { found = []; }
      found.forEach(node => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        nodes.push(node);
      });
    });
    nodes.forEach(node => {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      if (node.getAttribute?.('data-admin-checked') === stamp) return;

      /* 🛑 纯本地模式：AI 按钮置灰 + 悬浮提示；AI 体验密码登录后自动恢复 */
      if (this.isAIButton(node)) {
        if (aiBlocked) {
          node.disabled = true;
          node.dataset.aiDisabledByAuth = 'true';
          node.title = '当前为纯本地模式，请使用 AI 体验密码登录才能生成';
          node.classList.add('ai-disabled');
          node.setAttribute('aria-disabled', 'true');
        } else if (node.dataset.aiDisabledByAuth === 'true') {
          node.disabled = false;
          delete node.dataset.aiDisabledByAuth;
          node.classList.remove('ai-disabled');
          node.removeAttribute('aria-disabled');
          node.removeAttribute('title');
        }
      }

      const forced = node.hasAttribute('data-admin-only');
      const write = forced || this.isWriteAction(this.readActionName(node));
      /* 云端同步类按钮在本地模式下一律隐藏；管理员登录入口由 refreshTopbar 隐藏 */
      const cloudSync = local && /云端同步|同步到云端|同步数据/.test(
        `${node?.textContent || ''} ${node?.title || ''}`,
      );
      if ((!canWrite && write) || cloudSync) {
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
    if (button) {
      const admin = this.isAdmin();
      // 公开版禁用管理员登录入口：本地模式下这个按钮彻底不出现
      button.hidden = this.isLocalMode();
      button.style.display = this.isLocalMode() ? 'none' : '';
      button.textContent = admin ? '🔓 退出管理' : '🔒 管理员登录';
      button.title = admin ? '退出管理员模式（回到游客只读）' : '登录后可新增 / 编辑 / 删除数据';
      button.classList.toggle('is-admin', admin);
    }
    const badge = document.getElementById('publicModeBadge');
    if (badge) {
      const local = this.isLocalMode();
      badge.hidden = !local;
      badge.textContent = local
        ? (this.canUseAI() ? '💻 本地畅玩版' : '💻 纯本地版（无AI）')
        : '';
      badge.title = local
        ? (this.canUseAI() ? '本机存储 + AI 生成已解锁（点击切换权限）' : '仅本机存储，AI 生成已关闭（点击切换权限）')
        : '';
    }
    ['clearLocalDataBtn', 'exportLocalDataBtn'].forEach(id => {
      const button = document.getElementById(id);
      if (button) button.hidden = !this.isLocalMode();
    });
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
    if ([Auth.FLAG_KEY, Auth.LOCAL_MODE_KEY, Auth.CAN_AI_KEY].includes(event.key)) Auth.refresh();
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
