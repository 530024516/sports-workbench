/**
 * 统一存储层：所有业务数据经 /api/data 读写（服务端 Supabase）
 *
 * 架构：
 *   浏览器 → /api/data → lib/supabase.js（process.env.SUPABASE_URL / SUPABASE_ANON_KEY）→ Supabase
 * 浏览器拿不到 process.env，因此密钥只存在于服务端；前端只认「存储键名」，
 * 键名 → 数据表的映射由服务端 lib/store-schema.js 统一维护。
 *
 * 读取策略：Stale-While-Revalidate（缓存优先 + 后台静默同步）
 *   1. 有本地缓存：立即用缓存就绪并渲染，不同步等待网络；
 *   2. 渲染完成后后台请求云端，拿到数据后刷新缓存、回写 localStorage，并派发 store:sync 让视图重绘；
 *   3. 无本地缓存（冷启动）：显示加载动画并等待云端（带超时兜底）。
 *
 * 写入策略：先落 localStorage（本地永远有一份最新镜像）＋ 内存缓存，再异步推送云端；
 * 推送失败进入待写队列，下次同步后补推。
 * 冲突处理：后台同步回来的云端数据为准（本地未推送成功的写除外），覆盖缓存并触发重绘。
 *
 * 用法：
 *   Store.read(key, fallback) / Store.write(key, value)
 *   Store.ready           首次就绪（缓存就绪或冷启动同步完成）
 *   Store.onReady(cb)     cb 会在就绪时执行一次，之后每次云端同步带回变更时再执行（页面重绘用）
 */
'use strict';

// 仅需知道键名；表结构与落库方式由服务端决定
const STORE_KEYS = [
  'pe_students',
  'pe_fitness_records',
  'pe_attendance',
  'pe_lesson_plans',
  'pe_resources',
  'pe_courses',
  'pe_todos_v1',
  'pe_fitness_weekly_log_v1',
  'pe_schedule_v1',
  'pe_big_unit_design_v1',
  'pe_sports_meet_v1',
  'pe_week_mode',
  'pe_workbench_display_settings_v1',
  'sportsMeetTitle',
];

// 所有接口请求的统一超时上限：超时或异常一律判定为「未连接」并回退 localStorage
const REQUEST_TIMEOUT = 5000;
// 冷启动等待云端的上限：到点就先出界面，绝不让页面无限期卡在加载动画
const COLD_START_TIMEOUT = REQUEST_TIMEOUT;
// 迁移导入数据量大，单独放宽到 30 秒
const IMPORT_TIMEOUT = 30000;
// 同步失败后的自动重试：首次 + 1 次重试，隔 RETRY_DELAY 再试（应对偶发网络波动/超时）
const MAX_SYNC_ATTEMPTS = 2;
const RETRY_DELAY = 1200;
// 判定待写队列是否"新鲜"的时间窗。超过这个时间的失败写入很可能来自本地旧缓存，
// 再补推就会把本地旧数据反向覆盖云端（数据污染的根源），因此直接丢弃、以云端为准
const PENDING_FRESH_MS = 30000;
// 整体判定为"未连接"后的定时重连（有上限，不会无限重试）
const MAX_RECONNECT = 3;
const RECONNECT_DELAY = 8000;

let resolveReady;
const readyPromise = new Promise(resolve => { resolveReady = resolve; });

const Store = {
  mode: 'local',          // 'local' | 'supabase'
  cloudState: 'unknown',  // 'unknown' | 'on' | 'off'：是否已确认云端可用
  schema: null,           // 服务端下发的键 → 表映射（迁移页展示用）
  cache: new Map(),
  ready: readyPromise,
  isReady: false,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  // 待写队列：key → { value, at }（at 用于判断这条失败写入是否还"新鲜"）
  _pendingWrites: new Map(),
  _loadingNode: null,
  _backedUp: false,
  _reconnectTimer: null,
  _reconnectAttempts: 0,

  async start() {
    const hasCache = this._loadLocal();
    try {
      if (hasCache) {
        // ① 有缓存：先让页面用本地数据立即渲染
        this._finishStart();
        // ② 渲染之后再后台静默同步（不 await，避免阻塞首屏）
        this._syncPromise = this.sync();
      } else {
        // ③ 冷启动：没有任何本地缓存，才等云端（只试 1 次，先让页面出来）
        this._showLoading();
        try {
          this._syncPromise = this._syncWithRetry({ timeout: COLD_START_TIMEOUT, silent: false, attempts: 1 });
          await this._syncPromise;
        } catch (error) {
          // 冷启动失败：先用空白界面，交给后台带重试的同步继续拉，不让用户干等
          this.lastError = error;
          this._markDisconnected(error, false);
        }
        this._hideLoading();
        this._finishStart();
        if (this.cloudState !== 'on') this._syncPromise = this.sync();
      }
    } catch (error) {
      console.error('[Store] 初始化失败，已回退到本地存储', error);
      this.lastError = error;
      this.cloudState = 'off';
      this.mode = 'local';
      this._hideLoading();
      this._finishStart();
    }
    return this.mode;
  },

  /** 从 localStorage 灌入缓存，返回是否存在本地缓存 */
  _loadLocal() {
    let hasCache = false;
    STORE_KEYS.forEach(key => {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      try {
        this.cache.set(key, JSON.parse(raw));
        hasCache = true;
      } catch {
        localStorage.removeItem(key);
      }
    });
    return hasCache;
  },

  _finishStart() {
    if (this.isReady) return;
    this.isReady = true;
    resolveReady(this.mode);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('store:ready', { detail: { mode: this.mode } }));
    }
  },

  /** 后台静默同步（对外：手动刷新数据用）。失败会自动重试一次。 */
  async sync({ attempts = MAX_SYNC_ATTEMPTS } = {}) {
    if (this.syncing) return { ok: false, changed: [], reason: 'syncing' };
    this.syncing = true;
    try {
      return await this._syncWithRetry({ silent: true, attempts });
    } finally {
      this.syncing = false;
    }
  },

  /**
   * 带自动重试的同步：超时/网络波动时隔 RETRY_DELAY 再试一次，
   * 只有全部尝试都失败，才判定为「未连接」并回退 localStorage（不会一超时就放弃）
   */
  async _syncWithRetry({ timeout = REQUEST_TIMEOUT, silent = true, attempts = MAX_SYNC_ATTEMPTS } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this._syncOnce({ timeout });
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          console.warn(`[Store] 第 ${attempt}/${attempts} 次同步失败（${error?.message || error}），${RETRY_DELAY}ms 后自动重试…`);
          await this._delay(RETRY_DELAY);
        }
      }
    }
    this.lastError = lastError;
    this._markDisconnected(lastError, silent);
    if (!silent) throw lastError;
    return { ok: false, changed: [], failed: true, reason: lastError?.message || String(lastError), attempts };
  },

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  /**
   * 带超时的请求：AbortController 中断 + Promise.race 兜底
   * 任何情况下都不会无限期挂起（没有 AbortController 的旧浏览器也靠 race 退出）
   */
  async _fetchJSON(url, options = {}, timeout = REQUEST_TIMEOUT) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    const timeoutRace = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(new Error(`请求 ${url} 超时（${timeout}ms）`));
      }, timeout);
    });
    try {
      const response = await Promise.race([
        fetch(url, { ...options, signal: controller ? controller.signal : undefined }),
        timeoutRace,
      ]);
      if (!response.ok) {
        const error = new Error(`${url} 返回 HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  /** 单次同步：失败一律 throw，由 _syncWithRetry 负责重试与降级 */
  async _syncOnce({ timeout = REQUEST_TIMEOUT } = {}) {
    let payload;
    try {
      payload = await this._fetchJSON('/api/data', { headers: { Accept: 'application/json' } }, timeout);
    } catch (error) {
      this.lastError = error;
      throw error;
    }
    this.schema = payload.keys || null;

    if (payload.mode === 'supabase' && payload.data) {
      this.cloudState = 'on';
      this.mode = 'supabase';
      this._reconnectAttempts = 0;
      const before = this._snapshot();
      // 先丢掉过期的失败写入，避免它们随后被补推、把本地旧数据反向覆盖到云端
      this._dropStalePending();
      const changed = this._applyCloud(payload.data);
      // 强制覆盖：不管有没有差异，都把云端结果整体写回 localStorage 镜像
      this._mirrorLocal();
      this._logOverwrite(changed, before);
      if (!this._backedUp) { this._backupLocal(); this._backedUp = true; }
      this.lastSyncAt = Date.now();

        // 个别表结构异常（缺列等）时明确提示，避免"以为同步了其实没有"
        if (Array.isArray(payload.errors) && payload.errors.length) {
          const tables = payload.errors.map(item => item.table).join('、');
          console.warn('[Store] 部分云端数据读取失败：', payload.errors);
          if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            window.showToast(`云端 ${payload.errors.length} 项数据读取失败（${tables}），请检查这些表的结构是否为 id/data/ord/updated_at。`, 'error');
          }
        }

        // 无论有无差异都派发，确保页面用云端数据强制重绘（旧缓存不会被留在屏幕上）
        this._dispatchSync(changed, { forced: true });
        await this._flushPending();
        return { ok: true, changed };
      }

      this.cloudState = 'off';
      this.mode = 'local';
      return { ok: true, changed: [] };
  },

  /** 缓存快照（键 → 条数），用于打印"覆盖前后"的对比 */
  _snapshot() {
    const snapshot = new Map();
    STORE_KEYS.forEach(key => snapshot.set(key, this._sizeOf(this.cache.get(key))));
    return snapshot;
  },

  _sizeOf(value) {
    if (Array.isArray(value)) return `${value.length} 条`;
    if (value === null || value === undefined) return '空';
    if (typeof value === 'object') return `${Object.keys(value).length} 项`;
    return String(value);
  },

  /** 明确的覆盖日志：控制台一眼看出哪些键被云端覆盖了、从多少变成多少 */
  _logOverwrite(changed, before) {
    if (!changed.length) {
      console.log('[Store] ✅ 云端数据已强制覆盖本地缓存与 localStorage 镜像（本次无差异）');
      return;
    }
    const detail = changed
      .map(key => `${key}：${before.get(key) ?? '空'} → ${this._sizeOf(this.cache.get(key))}`)
      .join('；');
    console.log(`[Store] ✅ 云端数据已强制覆盖本地缓存与 localStorage 镜像，${changed.length} 个键有变化 → ${detail}`);
  },

  /**
   * 丢弃过期的失败写入
   * 这些写入往往是本地旧缓存时代留下的，一旦联网就补推，会把云端新数据覆盖回旧版本
   */
  _dropStalePending() {
    if (!this._pendingWrites.size) return;
    const now = Date.now();
    [...this._pendingWrites].forEach(([key, entry]) => {
      if (now - entry.at <= PENDING_FRESH_MS) return;
      this._pendingWrites.delete(key);
      console.warn(`[Store] 已丢弃过期的失败写入 ${key}（${Math.round((now - entry.at) / 1000)} 秒前写入失败），以云端数据为准，不再补推，避免污染云端`);
    });
  },

  /** 标记为未连接：清空云端状态 + 派发事件让页面（含迁移页）立刻显示"未连接" */
  _markDisconnected(error, silent = true) {
    this.cloudState = 'off';
    this.mode = 'local';
    if (silent) console.warn('[Store] 云端不可用，已回退本地存储：', error?.message || error);
    this._dispatchSync([], { failed: true, reason: error?.message || String(error), willRetry: this._reconnectAttempts < MAX_RECONNECT });
    this._scheduleReconnect();
  },

  /** 判定未连接后定时重连（最多 MAX_RECONNECT 次），网络恢复后自动用云端数据覆盖本地 */
  _scheduleReconnect() {
    if (typeof window === 'undefined' || this._reconnectTimer) return;
    if (this._reconnectAttempts >= MAX_RECONNECT) return;
    this._reconnectAttempts += 1;
    const delay = RECONNECT_DELAY * this._reconnectAttempts;
    console.warn(`[Store] 将在 ${delay / 1000} 秒后第 ${this._reconnectAttempts}/${MAX_RECONNECT} 次尝试重连云端…`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      const result = await this.sync();
      if (result.ok && this.mode === 'supabase') {
        console.log('[Store] ✅ 重连成功，已用云端数据覆盖本地缓存');
      }
    }, delay);
  },

  /** 主动探测服务端是否配置了 Supabase（带 5 秒超时，绝不会挂死） */
  async probeConfig(timeout = REQUEST_TIMEOUT) {
    try {
      const payload = await this._fetchJSON('/api/config', { headers: { Accept: 'application/json' } }, timeout);
      const configured = Boolean(payload.configured ?? payload.supabaseConfigured);
      if (!configured) {
        this.cloudState = 'off';
        this.mode = 'local';
        this._dispatchSync([], { failed: true, reason: '服务端未配置 SUPABASE_URL / SUPABASE_ANON_KEY' });
      }
      return { ok: true, configured, keySource: payload.keySource || '' };
    } catch (error) {
      this.lastError = error;
      this._markDisconnected(error);
      return { ok: false, configured: false, reason: error?.message || String(error) };
    }
  },

  /**
   * 以云端为准更新缓存，返回发生变化的键
   * 冲突处理：云端优先；但如果该键有"未推送成功"的本地写入，保留本地值（下次补推）
   */
  _applyCloud(data) {
    const changed = [];
    STORE_KEYS.forEach(key => {
      // 只保护"刚刚写入失败"的键（用户这次会话刚改的，等补推）；
      // 过期的失败写入已在 _dropStalePending 里清掉，必须让云端覆盖，否则旧缓存永远赖着不走
      const pending = this._pendingWrites.get(key);
      if (pending && Date.now() - pending.at <= PENDING_FRESH_MS) return;
      const next = data[key] === undefined ? null : data[key];
      const current = this.cache.get(key);
      if (JSON.stringify(current === undefined ? null : current) === JSON.stringify(next)) return;
      this.cache.set(key, next);
      changed.push(key);
    });
    return changed;
  },

  /**
   * 把云端结果回写 localStorage，保证本地始终有镜像
   * 默认全量覆盖 STORE_KEYS：本地有而云端没有的键会被清掉，不留残存旧数据
   */
  _mirrorLocal(keys = STORE_KEYS) {
    keys.forEach(key => {
      try {
        const value = this.cache.get(key);
        if (value === null || value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        console.warn(`[Store] 回写本地镜像失败：${key}`, error);
      }
    });
  },

  _dispatchSync(changed, extra = {}) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('store:sync', {
      detail: { mode: this.mode, changed, at: Date.now(), ...extra },
    }));
  },

  /**
   * 注册回调：就绪时执行一次，之后每次云端同步带回变更时再执行（用于页面重绘）
   * @returns {Function} 取消注册
   */
  onReady(callback) {
    if (typeof callback !== 'function') return () => {};
    let active = true;
    const run = mode => { if (active) callback(mode); };
    if (this.isReady) run(this.mode);
    else this.ready.then(run);
    if (typeof window !== 'undefined') {
      const handler = event => run(event.detail?.mode || this.mode);
      window.addEventListener('store:sync', handler);
      return () => { active = false; window.removeEventListener('store:sync', handler); };
    }
    return () => { active = false; };
  },

  /** 页面渲染前调用一次（或直接把渲染函数交给 onReady） */
  read(key, fallback = null) {
    const value = this.cache.get(key);
    return value === undefined ? fallback : value;
  },

  /** 写入：本地镜像 + 内存缓存立即生效，云端异步推送 */
  write(key, value) {
    this.cache.set(key, value);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`[Store] 写入本地镜像失败：${key}`, error);
    }
    if (this.cloudState !== 'off') this._persistSafely(key, value);
    return value;
  },

  async _persistSafely(key, value) {
    try {
      await this._persist(key, value);
      this._pendingWrites.delete(key);
    } catch (error) {
      // 服务端没配 Supabase：安静地退回纯本地模式，不打扰用户
      if (error && error.status === 503) {
        this.cloudState = 'off';
        this.mode = 'local';
        this._pendingWrites.delete(key);
        return;
      }
      this._pendingWrites.set(key, { value, at: Date.now() });
      this._onPersistError(key, error);
    }
  },

  async _persist(key, value) {
    // 写入同样带超时：网络挂起时不会一直 pending，失败会进入待写队列
    await this._fetchJSON('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
  },

  /**
   * 补推之前失败的写入。只补推"新鲜"的那部分——
   * 过期的已经在 _dropStalePending 里丢掉，绝不会把本地旧数据推上去覆盖云端
   */
  async _flushPending() {
    if (!this._pendingWrites.size) return;
    for (const [key, entry] of [...this._pendingWrites]) {
      try {
        await this._persist(key, entry.value);
        this._pendingWrites.delete(key);
        console.log(`[Store] 已补推 ${key} 到云端`);
      } catch (error) {
        console.warn(`[Store] 补推 ${key} 仍未成功`, error);
      }
    }
  },

  /** 待写队列现状（排障用） */
  getPendingWrites() {
    return [...this._pendingWrites].map(([key, entry]) => ({
      key,
      at: entry.at,
      ageSeconds: Math.round((Date.now() - entry.at) / 1000),
      value: entry.value,
    }));
  },

  /** 清空待写队列（forceSyncCloud 会调用，避免旧数据被补推） */
  clearPendingWrites() {
    const count = this._pendingWrites.size;
    this._pendingWrites.clear();
    return count;
  },

  _onPersistError(key, error) {
    console.error(`[Store] 保存 ${key} 失败`, error);
    const message = error?.message ? String(error.message) : '';
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(`云端保存失败：${message || '请检查 Supabase 配置'}`, 'error');
    }
  },

  // 首次连上云端时把本地数据改名备份，避免误读旧数据，同时保留回滚能力
  _backupLocal() {
    STORE_KEYS.forEach(key => {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      try {
        localStorage.setItem(`${key}__local_backup`, raw);
      } catch {}
    });
  },

  /** 冷启动加载动画 */
  _showLoading() {
    if (typeof document === 'undefined' || !document.body || this._loadingNode) return;
    const node = document.createElement('div');
    node.id = 'store-loading';
    node.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;gap:14px;background:rgba(255,255,255,.94);'
      + 'color:#444;font-size:14px;font-family:inherit;';
    node.innerHTML = '<div style="width:36px;height:36px;border:3px solid #E85D04;'
      + 'border-top-color:transparent;border-radius:50%;animation:store-spin .8s linear infinite;"></div>'
      + '<div>正在从云端同步数据…</div><style>@keyframes store-spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(node);
    this._loadingNode = node;
  },

  _hideLoading() {
    if (!this._loadingNode) return;
    this._loadingNode.remove();
    this._loadingNode = null;
  },

  /**
   * 强制以云端为准重建本地（控制台直接敲 forceSyncCloud() 即可）
   * 步骤：备份本地 → 清空 localStorage 镜像与内存缓存 → 清掉待写队列 → 重拉云端 → 强制重绘
   * @returns {Promise<{ok:boolean, mode:string, changed:string[], clearedKeys:number, reason?:string}>}
   */
  async forceSyncCloud() {
    this._backupLocal(); // 先备份：万一拉取失败，还能从 *__local_backup 键找回
    const clearedKeys = this._clearLocalMirror();
    const droppedPending = this.clearPendingWrites();
    this.cache.clear();
    this.cloudState = 'unknown';
    this.mode = 'local';
    console.log(`[Store] 已清空本地缓存（${clearedKeys} 个键）与待写队列（${droppedPending} 条），开始强制拉取云端…`);

    const result = await this._syncWithRetry({ silent: true });
    if (result.ok && this.mode === 'supabase') {
      this._dispatchSync(result.changed || [], { forced: true, reason: 'forceSyncCloud' });
      console.log(`[Store] ✅ forceSyncCloud 完成：已用云端数据重建本地（${(result.changed || []).length} 个键写入）`);
    } else {
      console.error(`[Store] ❌ forceSyncCloud 失败：${result.reason}。本地缓存已清空，可从 *__local_backup 键恢复。`);
    }
    return { ...result, mode: this.mode, clearedKeys, droppedPending };
  },

  /** 清空本地镜像：内置键 + 历史遗留的 pe_* / sportsMeet* 键（保留 __local_backup） */
  _clearLocalMirror() {
    let keys = [];
    if (typeof localStorage.key === 'function' && typeof localStorage.length === 'number') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || key.includes('__local_backup')) continue;
        if (STORE_KEYS.includes(key) || key.startsWith('pe_') || key.includes('sportsMeet')) keys.push(key);
      }
    } else {
      // 极少数环境不支持枚举，退回到内置键
      keys = [...STORE_KEYS];
    }
    keys.forEach(key => localStorage.removeItem(key));
    return keys.length;
  },

  /** 迁移工具：把 localStorage 里的旧数据一次性写入云端 */
  async importFromLocalStorage(keys = STORE_KEYS) {
    const values = {};
    const invalid = [];
    keys.forEach(key => {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      try {
        values[key] = JSON.parse(raw);
      } catch {
        invalid.push(key);
      }
    });

    // 导入可能比较慢，但仍要有上限，避免按钮一直转圈
    const payload = await this._fetchJSON('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }, IMPORT_TIMEOUT);
    const report = payload.report || [];
    invalid.forEach(key => report.push({ key, status: 'invalid', count: 0 }));
    keys
      .filter(key => !(report.some(item => item.key === key)))
      .forEach(key => report.push({ key, status: 'skipped', count: 0 }));
    // 导入成功后本地缓存同步更新，避免下次打开又推一遍
    Object.entries(values).forEach(([key, value]) => this.cache.set(key, value));
    return report;
  },
};

// 所有页面脚本（含 data.js）执行完后再真正初始化
if (typeof window !== 'undefined') {
  const bootStore = () => Store.start();
  const readyState = typeof document !== 'undefined' ? document.readyState : 'complete';
  if (readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootStore);
  } else {
    setTimeout(bootStore, 0);
  }

  // 控制台排障入口：数据看起来不同步时，直接敲 forceSyncCloud()
  window.Store = Store;
  window.forceSyncCloud = () => Store.forceSyncCloud();
  window.getPendingWrites = () => Store.getPendingWrites();
}
