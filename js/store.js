/**
 * 统一存储层：所有业务数据经 /api/data 读写（服务端 Supabase）
 *
 * 架构：
 *   浏览器 → /api/data → lib/supabase.js（process.env.SUPABASE_URL / SUPABASE_ANON_KEY）→ Supabase
 * 浏览器拿不到 process.env，因此密钥只存在于服务端；前端只认「存储键名」，
 * 键名 → 数据表的映射由服务端 lib/store-schema.js 统一维护。
 *
 * 未配置 Supabase（或接口不可用）时自动回退 localStorage，本地开发不受影响。
 *
 * 用法（与改造前完全一致，业务代码零改动）：
 *   Store.read(key, fallback) / Store.write(key, value) / Store.ready
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

let resolveReady;
const readyPromise = new Promise(resolve => { resolveReady = resolve; });

const Store = {
  mode: 'local',          // 'local' | 'supabase'
  schema: null,           // 服务端下发的键 → 表映射（迁移页展示用）
  cache: new Map(),
  ready: readyPromise,
  lastError: null,

  async start() {
    try {
      await this._init();
    } catch (error) {
      console.error('[Store] 初始化失败，已回退到本地存储', error);
      this.lastError = error;
      this.mode = 'local';
    }
    resolveReady(this.mode);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('store:ready', { detail: { mode: this.mode } }));
    }
    return this.mode;
  },

  async _init() {
    // 1. 本地数据先入缓存：接口不可用或无网络时首屏也有数据
    STORE_KEYS.forEach(key => {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      try {
        this.cache.set(key, JSON.parse(raw));
      } catch {
        localStorage.removeItem(key);
      }
    });

    // 2. 拉取云端数据
    const response = await fetch('/api/data', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`/api/data 返回 HTTP ${response.status}`);
    const payload = await response.json();
    this.schema = payload.keys || null;

    if (payload.mode === 'supabase' && payload.data) {
      // 云端优先：连上 Supabase 后，云端数据是唯一真相，
      // 先清空本地缓存（含刚从 localStorage 读入的旧数据），再整体以云端为准
      this.mode = 'supabase';
      // 每个键都以云端为准：云端没有该键就是空（null），绝不回落到本地旧值
      STORE_KEYS.forEach(key => {
        const value = payload.data[key];
        this.cache.set(key, value === undefined ? null : value);
      });
      this._backupLocal();

      // 个别表结构异常（缺列等）时明确提示，避免"以为同步了其实没有"
      if (Array.isArray(payload.errors) && payload.errors.length) {
        const tables = payload.errors.map(item => item.table).join('、');
        console.warn('[Store] 部分云端数据读取失败：', payload.errors);
        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
          window.showToast(`云端 ${payload.errors.length} 项数据读取失败（${tables}），请检查这些表的结构是否为 id/data/ord/updated_at。`, 'error');
        }
      }
    } else {
      this.mode = 'local';
    }
  },

  // 切换到云端后把本地数据改名备份，避免误读旧数据，同时保留回滚能力
  _backupLocal() {
    STORE_KEYS.forEach(key => {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      try {
        localStorage.setItem(`${key}__local_backup`, raw);
      } catch {}
    });
  },

  /** 同步读取：命中内存缓存 */
  read(key, fallback = null) {
    const value = this.cache.get(key);
    return value === undefined ? fallback : value;
  },

  /** 同步更新缓存 + 异步写入云端（或 localStorage） */
  write(key, value) {
    this.cache.set(key, value);
    if (this.mode === 'supabase') {
      this._persistSafely(key, value);
      return value;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      this._onPersistError(key, error);
    }
    return value;
  },

  async _persistSafely(key, value) {
    try {
      await this._persist(key, value);
    } catch (error) {
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
    throw new Error(message);
  },

  _onPersistError(key, error) {
    console.error(`[Store] 保存 ${key} 失败`, error);
    const message = error?.message ? String(error.message) : '';
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(`云端保存失败：${message || '请检查 Supabase 配置'}`, 'error');
    }
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
    return report;
  },
};

// 所有页面脚本（含 data.js 注册种子数据）执行完后再真正初始化
if (typeof window !== 'undefined') {
  const bootStore = () => Store.start();
  const readyState = typeof document !== 'undefined' ? document.readyState : 'complete';
  if (readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootStore);
  } else {
    setTimeout(bootStore, 0);
  }
}
