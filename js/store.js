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

// 冷启动时等待云端的上限：超时就先用空白界面，避免网络异常时一直卡在加载动画
const COLD_START_TIMEOUT = 8000;

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
  _pendingWrites: new Map(),
  _loadingNode: null,
  _backedUp: false,

  async start() {
    const hasCache = this._loadLocal();
    try {
      if (hasCache) {
        // ① 有缓存：先让页面用本地数据立即渲染
        this._finishStart();
        // ② 渲染之后再后台静默同步（不 await，避免阻塞首屏）
        this._syncPromise = this.sync();
      } else {
        // ③ 冷启动：没有任何本地缓存，才等云端
        this._showLoading();
        this._syncPromise = this._syncOnce({ timeout: COLD_START_TIMEOUT });
        await this._syncPromise;
        this._hideLoading();
        this._finishStart();
      }
    } catch (error) {
      console.error('[Store] 初始化失败，已回退到本地存储', error);
      this.lastError = error;
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

  /** 后台静默同步（对外：手动刷新数据用） */
  async sync() {
    if (this.syncing) return { ok: false, changed: [], reason: 'syncing' };
    this.syncing = true;
    try {
      return await this._syncOnce({ silent: true });
    } finally {
      this.syncing = false;
    }
  },

  async _syncOnce({ timeout = 0, silent = false } = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    if (timeout > 0 && controller) timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch('/api/data', {
        headers: { Accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) throw new Error(`/api/data 返回 HTTP ${response.status}`);
      const payload = await response.json();
      this.schema = payload.keys || null;

      if (payload.mode === 'supabase' && payload.data) {
        this.cloudState = 'on';
        this.mode = 'supabase';
        const changed = this._applyCloud(payload.data);
        this._mirrorLocal(changed);
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

        if (changed.length) this._dispatchSync(changed);
        await this._flushPending();
        return { ok: true, changed };
      }

      this.cloudState = 'off';
      this.mode = 'local';
      return { ok: true, changed: [] };
    } catch (error) {
      if (!silent) throw error;
      console.warn('[Store] 后台同步失败，继续使用本地缓存', error);
      this.lastError = error;
      return { ok: false, changed: [] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  /**
   * 以云端为准更新缓存，返回发生变化的键
   * 冲突处理：云端优先；但如果该键有"未推送成功"的本地写入，保留本地值（下次补推）
   */
  _applyCloud(data) {
    const changed = [];
    STORE_KEYS.forEach(key => {
      if (this._pendingWrites.has(key)) return;
      const next = data[key] === undefined ? null : data[key];
      const current = this.cache.get(key);
      if (JSON.stringify(current === undefined ? null : current) === JSON.stringify(next)) return;
      this.cache.set(key, next);
      changed.push(key);
    });
    return changed;
  },

  /** 把云端结果回写 localStorage，保证本地始终有镜像 */
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

  _dispatchSync(changed) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('store:sync', {
      detail: { mode: this.mode, changed, at: Date.now() },
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
      this._pendingWrites.set(key, value);
      this._onPersistError(key, error);
    }
  },

  async _persist(key, value) {
    const response = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    if (response.ok) return;
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  },

  /** 补推之前失败的写入 */
  async _flushPending() {
    if (!this._pendingWrites.size) return;
    for (const [key, value] of [...this._pendingWrites]) {
      try {
        await this._persist(key, value);
        this._pendingWrites.delete(key);
      } catch (error) {
        console.warn(`[Store] 补推 ${key} 仍未成功`, error);
      }
    }
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

    const response = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch {}
      throw new Error(message);
    }

    const payload = await response.json();
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
}
