/**
 * 统一存储层：localStorage → Supabase
 *
 * 业务代码只调用 Store.read(key) / Store.write(key, value)：
 *   - 未配置 Supabase（或连接失败）：自动使用 localStorage，行为与改造前完全一致
 *   - 已配置 Supabase：读 select()、写 upsert()/insert()，由云端作为唯一数据源
 *
 * 写入策略：
 *   - 集合型（学生、体测、教案……）：整表替换（delete + insert），保证顺序与删除都正确
 *   - 单例型（课表、大单元、运动会、设置）：按 id=存储键 做 upsert
 *
 * 连接信息不写在前端：由 /api/config 从服务端环境变量 SUPABASE_URL / SUPABASE_ANON_KEY 读取。
 */
'use strict';

const STORE_KEY_MAP = {
  pe_students: { table: 'students' },
  pe_fitness_records: { table: 'fitness_records' },
  pe_attendance: { table: 'attendance' },
  pe_lesson_plans: { table: 'lesson_plans' },
  pe_resources: { table: 'resources' },
  pe_courses: { table: 'courses' },
  pe_todos_v1: { table: 'todos' },
  // 一周训练记录：localStorage 里是「日期 → 记录」的对象，云端按天一行存
  pe_fitness_weekly_log_v1: { table: 'fitness_logs', objectMap: true },
  pe_schedule_v1: { table: 'course_schedule', singleton: true },
  pe_big_unit_design_v1: { table: 'unit_designs', singleton: true },
  pe_sports_meet_v1: { table: 'sports_meet', singleton: true },
  pe_week_mode: { table: 'app_settings', singleton: true },
  pe_workbench_display_settings_v1: { table: 'app_settings', singleton: true },
  sportsMeetTitle: { table: 'app_settings', singleton: true },
};

const SUPABASE_CDN = 'https://esm.sh/@supabase/supabase-js@2';

let resolveReady;
const readyPromise = new Promise(resolve => { resolveReady = resolve; });

const Store = {
  mode: 'local',          // 'local' | 'supabase'
  client: null,
  cache: new Map(),
  seeds: new Map(),
  ready: readyPromise,
  lastError: null,

  /** 注册种子数据：对应集合为空时写入（只会在初始化时用一次） */
  registerSeed(key, factory) {
    this.seeds.set(key, factory);
  },

  /** 初始化：连接 Supabase 并拉取数据，失败则回退 localStorage */
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
    // 1. 本地数据先入缓存：保证无网络 / 未配置云端时首屏就有数据
    Object.keys(STORE_KEY_MAP).forEach(key => {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      try {
        this.cache.set(key, JSON.parse(raw));
      } catch {
        localStorage.removeItem(key);
      }
    });

    // 2. 尝试连接 Supabase
    const config = await this._loadConfig();
    if (config) {
      const { createClient } = await import(SUPABASE_CDN);
      this.client = createClient(config.url, config.key);
      this.mode = 'supabase';
      await this._pullAll();
    } else {
      this.mode = 'local';
    }

    // 3. 空集合播种
    await this._seedEmpty();

    // 4. 云端模式下清掉已迁移的本地副本（保留一份备份键，便于回滚）
    if (this.mode === 'supabase') this._backupLocal();
  },

  async _loadConfig() {
    try {
      const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const data = await response.json();
      const url = String(data.supabaseUrl || '').trim();
      const key = String(data.supabaseAnonKey || '').trim();
      return url && key ? { url, key } : null;
    } catch {
      return null;
    }
  },

  async _pullAll() {
    const keys = Object.keys(STORE_KEY_MAP);
    for (const key of keys) {
      const config = STORE_KEY_MAP[key];
      const { data, error } = config.singleton
        ? await this.client.from(config.table).select('data').eq('id', key).maybeSingle()
        : await this.client.from(config.table).select('data').order('ord', { ascending: true });

      if (error) {
        console.error(`[Store] 读取 ${config.table} 失败`, error);
        continue;
      }
      if (config.singleton) {
        if (data?.data !== undefined) this.cache.set(key, data.data);
      } else if (config.objectMap) {
        const mapped = {};
        (data || []).forEach(row => { mapped[row.data?.date || row.id] = row.data; });
        this.cache.set(key, mapped);
      } else {
        this.cache.set(key, (data || []).map(row => row.data));
      }
    }
  },

  async _seedEmpty() {
    for (const [key, factory] of this.seeds) {
      const current = this.cache.get(key);
      const isEmpty = current === undefined || current === null
        || (Array.isArray(current) && current.length === 0);
      if (!isEmpty) continue;
      const seeded = factory();
      this.cache.set(key, seeded);
      if (this.mode === 'supabase' && this.client) {
        await this._persist(key, seeded).catch(error => this._onPersistError(key, error));
      } else {
        try {
          localStorage.setItem(key, JSON.stringify(seeded));
        } catch (error) {
          this._onPersistError(key, error);
        }
      }
    }
  },

  // 迁移后把本地数据改名备份，避免误读旧数据，同时保留回滚能力
  _backupLocal() {
    Object.keys(STORE_KEY_MAP).forEach(key => {
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

  /** 同步写入缓存 + 异步持久化到云端/本地 */
  write(key, value) {
    this.cache.set(key, value);
    if (this.mode === 'supabase' && this.client) {
      this._persist(key, value).catch(error => this._onPersistError(key, error));
      return value;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      this._onPersistError(key, error);
    }
    return value;
  },

  async _persist(key, value) {
    const config = STORE_KEY_MAP[key];
    if (!config || !this.client) return;

    if (config.singleton) {
      const { error } = await this.client
        .from(config.table)
        .upsert({ id: key, data: value, ord: 0, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw error;
      return;
    }

    // 集合型：整表替换，保证顺序一致且删除生效
    const source = config.objectMap
      ? Object.entries(value || {}).map(([mapKey, item]) => ({
        id: String(item?.date || mapKey),
        data: { ...(item || {}), date: item?.date || mapKey },
      }))
      : (Array.isArray(value) ? value : []).map(item => ({ id: String(item?.id ?? ''), data: item }));
    const rows = source
      .map((row, ord) => ({ ...row, ord, updated_at: new Date().toISOString() }))
      .filter(row => row.id);

    const table = this.client.from(config.table);
    const { error: deleteError } = await table.delete().neq('id', '__keep_none__');
    if (deleteError) throw deleteError;
    if (!rows.length) return;
    const { error: insertError } = await table.insert(rows);
    if (insertError) throw insertError;
  },

  _onPersistError(key, error) {
    console.error(`[Store] 保存 ${key} 失败`, error);
    const message = error?.message ? String(error.message) : '';
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(`云端保存失败：${message || '请检查 Supabase 配置'}`, 'error');
    }
  },

  /** 迁移用：把 localStorage 里的旧数据一次性写入云端 */
  async importFromLocalStorage(keys = Object.keys(STORE_KEY_MAP)) {
    const report = [];
    if (this.mode !== 'supabase' || !this.client) {
      return keys.map(key => ({ key, status: 'error', count: 0, message: '未连接 Supabase' }));
    }
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (raw === null) {
        report.push({ key, status: 'skipped', count: 0 });
        continue;
      }
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        report.push({ key, status: 'invalid', count: 0 });
        continue;
      }
      try {
        this.cache.set(key, value);
        await this._persist(key, value);
        report.push({ key, status: 'ok', count: Array.isArray(value) ? value.length : 1 });
      } catch (error) {
        report.push({ key, status: 'error', count: 0, message: error?.message || '' });
      }
    }
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
