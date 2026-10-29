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
 * 冲突处理：后台同步回来的云端数据为准（本地「已写入但云端未确认」的键除外），覆盖缓存并触发重绘。
 *
 * ⚠️ 数据丢失防线（SWR 云端优先 + 用户保存完立刻刷新 = 新数据被云端旧数据冲掉）：
 *   1. write() 在推送【前】就给该键打上"未确认"标记，云端确认成功才清除；
 *   2. 标记持久化到 localStorage，刷新后自动恢复 —— 新页面同步时这些键受保护，云端不许覆盖；
 *   3. 重要表单用 Store.writeCritical()：await 云端确认，只有 ok=true 才提示"保存成功"；
 *      失败则数据完整保留在本地（critical 标记永不过期、不会被丢弃），后台持续续传。
 *
 * 用法：
 *   Store.read(key, fallback) / Store.write(key, value)
 *   await Store.writeCritical(key, value)   —— 报名保存等重要表单，强一致
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
  'pe_sports_meet_events_v1',
  'pe_meet_template_config_v1',
  'pe_week_mode',
  'pe_workbench_display_settings_v1',
  'sportsMeetTitle',
];

/**
 * 「本次运动会」全部存储键：报名 / 预分组 / 赛程 / 成绩排名 都在 pe_sports_meet_v1 里，
 * 另外三个是项目库、报名模板配置、运动会标题。一键清空时连根拔起。
 */
const MEET_DATA_KEYS = [
  'pe_sports_meet_v1',
  'pe_sports_meet_events_v1',
  'pe_meet_template_config_v1',
  'sportsMeetTitle',
];

/**
 * 版本标记：排障第一步就是在控制台确认浏览器跑的是不是这一版。
 * ⚠️ 老版本（没有时光机备份 / 云端 0 条防污染 / forceRecover）会把云端返回的 null 直接写回
 *    localStorage，表现就是"刷新一下主键立刻变 0 条"，日志还会打"本次无差异"。
 *    如果你的控制台里看不到下面这行，说明浏览器还在用缓存里的旧 store.js —— 先硬刷（Cmd+Shift+R）。
 */
const STORE_BUILD = 'v3-数据丢失防线（时光机备份 + 云端0条防污染 + forceRecover）2026-10-29';

// 所有接口请求的统一超时上限
// 20 秒：Vercel（尤其免费版）冷启动 + Supabase 首次连接经常超过 5 秒，
// 5 秒会在 Network 面板表现为 (canceled)、传输 0 kB，数据永远拉不下来
const REQUEST_TIMEOUT = 20000;
// 冷启动等待云端的上限：到点就先出界面，绝不让页面无限期卡在加载动画
const COLD_START_TIMEOUT = REQUEST_TIMEOUT;
// 冷启动等待超过这个时间就提示"服务端在冷启动"，避免用户以为卡死
const SLOW_HINT_DELAY = 6000;
// 迁移导入数据量大，单独放宽到 30 秒
const IMPORT_TIMEOUT = 30000;
// 同步失败后的自动重试：首次 + 1 次重试，隔 RETRY_DELAY 再试（应对偶发网络波动/超时）
const MAX_SYNC_ATTEMPTS = 2;
const RETRY_DELAY = 1200;
// 判定待写队列是否"新鲜"的时间窗。超过这个时间的失败写入很可能来自本地旧缓存，
// 再补推就会把本地旧数据反向覆盖云端（数据污染的根源），因此直接丢弃、以云端为准
const PENDING_FRESH_MS = 30000;
// 「本地已改、云端还没确认」的保护窗：这段时间内云端数据一律不许覆盖本地，
// 否则用户刚保存完一刷新，云端旧数据回来就把新数据冲掉了（数据丢失的根源）
const UNCONFIRMED_TTL_MS = 5 * 60 * 1000;
// 重要表单（报名保存等）的写入：云端确认前的重试次数
const CRITICAL_WRITE_ATTEMPTS = 2;
// 重要表单云端确认失败后的后台续传节奏（毫秒）
const CRITICAL_RETRY_DELAYS = [1500, 5000, 15000, 30000];
/**
 * 「本地已写入、云端未确认」保护锁的前缀：刷新后靠它挡住云端旧数据覆盖。
 * ⚠️ 每个存储键一条独立记录（前缀 + 键名），不是整体一个 JSON ——
 *    多个 iframe / 标签页共享同一份 localStorage，整体覆盖会让别人的锁被空队列抹掉。
 */
const UNCONFIRMED_LOCK_PREFIX = 'pe_store_unconfirmed_v1::';
// 运动会数据里"写空 = 可能把别人的数据冲掉"的关键数组（合并时保留本地已有值）
const MEET_ARRAY_FIELDS = ['athletes', 'registrations', 'heats'];
// ⛔ 绝对防御字段：从"有"写成"无"直接抛异常终止写入，除非调用方显式 force: true
const MEET_CRITICAL_FIELDS = ['athletes', 'registrations'];
// 「本地时光机」备份键：每次成功保存非空数据时另存一份，主数据被清空时可一键恢复
// ⚠️ 实际落盘时按存储键分槽（pe_sports_meet_backup_v1::<key>），互不顶掉；
//    没有后缀的裸键只用于「主数据（报名/赛程/成绩）」这份，同时兼容老版本写过的备份。
const MEET_BACKUP_KEY = 'pe_sports_meet_backup_v1';
// 主数据键：报名 / 预分组 / 赛程 / 成绩排名 全在这一个键里，判断"有没有数据"只看报名条数
const MEET_MAIN_KEY = 'pe_sports_meet_v1';
/**
 * 「一键清空」意图的跨文档通道。
 * 兄弟 iframe 收到"主数据被清空"的消息时，必须能区分两件事：
 *   ① 用户在别的页面亲手点了「一键清空」→ 必须跟着清空（否则清空了又被老数据复活）；
 *   ② 兄弟页面自己也在启动中、手上恰好是空快照 → 必须无视（否则就是"刷新一下数据没了"）。
 * 世代号落地到 localStorage 就是为了做这个区分，它本身不是业务数据键。
 */
const MEET_PURGE_EPOCH_KEY = 'pe_meet_purge_epoch_v1';
// 清空指令的"有效期"：世代号带时间戳，只认 10 秒内刚发生的清空。
// 否则隔天别的页面导入新数据时，一次残留的世代号前进会被误判成清空指令，把新数据抹掉
const PURGE_SIGNAL_TTL_MS = 10000;
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
  // 对外的只读常量（排障/测试用）
  requestTimeout: REQUEST_TIMEOUT,
  // 请求串行闸门：保证同一时刻只有一个 /api 请求在飞，
  // 超时也必须等这一发彻底结束（abort 生效）后才允许发下一次，避免并发堆积
  _requestChain: Promise.resolve(),
  // 待写队列：key → { value, at, critical, attempts }（at 用于判断这条写入是否还"新鲜"；
  // critical = 重要表单（报名保存等），失败后绝不丢弃，一直保留在本地并重试）
  _pendingWrites: new Map(),
  // 本会话亲手写过的键（区分"云端真的没有"和"自己刚写的还没落库"）
  _localWrites: new Set(),
  // 重要表单云端写失败后的续传定时器：key → timer
  _criticalTimers: new Map(),
  _loadingNode: null,
  _slowHintTimer: null,
  _backedUp: false,
  _reconnectTimer: null,
  _reconnectAttempts: 0,
  // 「一键清空」世代号：purge 时 +1，用于作废"清空之前发出、清空之后才回来"的同步结果，
  // 否则在飞的 GET 会把刚清掉的数据又写回本地（用户眼里就是"清空了又活过来"）
  _purgeEpoch: 0,
  // 本实例看到的世代号（含别的 iframe 写的）：storage 事件靠它识别"明确的清空指令"
  _purgeEpochSeen: 0,
  // 上一次同步的防污染报告：{ protected, refused, healed }，供 _logOverwrite 打印
  _lastSyncReport: null,
  /**
   * 云端"暂停开关"（排障 / 强行恢复用）。
   * true 时：sync() / _applyCloud() / _persist() 全部空转 —— 云端那份 0 条再也碰不到本地，
   * 只留本地读写照常工作。用 window.pauseCloud() / window.resumeCloud() 控制。
   */
  _cloudPaused: false,
  // 时光机自愈的重入保护（自愈内部会反推云端，可能绕回 read）
  _healing: false,

  async start() {
    console.log(`[Store] 载入 store.js ${STORE_BUILD}`);
    this._bindCrossDocumentSync();
    // 先认下当前世代号：之后 storage 事件里只要世代号前进了，就说明别人执行了明确的一键清空
    this._purgeEpochSeen = this._storedPurgeSignal().epoch;
    const hasCache = this._loadLocal();
    /* ① 启动第一原则：无条件检查备份。
       只要主键是空的，立刻【同步】从 pe_sports_meet_backup_v1 拉数据覆盖主键，
       不等云端、不看差异、不看有没有缓存 —— 这是备份存在的唯一意义。
       恢复成功就立刻派发 store:sync，让页面马上用 216 条重绘。 */
    const restored = this._restoreFromBackup({ reason: 'start() 启动' });
    // 刷新后接续：把上一次「已写入本地、云端未确认」的标记恢复回来，
    // 否则新页面一同步，云端旧数据就会把用户刚保存的数据冲掉
    this._restoreUnconfirmed();
    try {
      if (hasCache || restored) {
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
    if (this._cloudPaused) return { ok: false, changed: [], reason: 'paused' };
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
          // 注意：上一发请求此时已经彻底结束（_doFetch 内部等过 _settle），
          // 再等 RETRY_DELAY 才发下一发，串行且不堆积
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
   * 请求闸门：所有 /api 请求排队串行执行
   * 上一发必须彻底结束（完成或超时 abort 生效）之后，才会发起下一发，
   * 所以重试期间绝不会出现多条并发请求把浏览器连接数占满
   */
  _fetchJSON(url, options = {}, timeout = REQUEST_TIMEOUT) {
    const run = () => this._doFetch(url, options, timeout);
    const result = this._requestChain.then(run, run);
    // 链条本身不因某次失败而中断（错误交给调用方处理）
    this._requestChain = result.then(() => {}, () => {});
    return result;
  },

  /**
   * 真正的一次请求：AbortController 中断 + Promise.race 兜底超时
   * 超时后先等这一发彻底收尾再抛错，避免重试与旧请求并发
   */
  async _doFetch(url, options = {}, timeout = REQUEST_TIMEOUT) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    let request = null;
    const timeoutRace = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(new Error(`请求 ${url} 超时（${timeout}ms）`));
      }, timeout);
    });
    try {
      request = fetch(url, { ...options, signal: controller ? controller.signal : undefined });
      const response = await Promise.race([request, timeoutRace]);
      if (!response.ok) {
        const error = new Error(`${url} 返回 HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      // 等 abort 真正生效、这一发结束，再让上层重试
      await this._settle(request);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  /** 等一个请求彻底收尾（成功/失败都算），最多等 maxWait，防止极端情况卡住队列 */
  _settle(promise, maxWait = 3000) {
    if (!promise || typeof promise.then !== 'function') return Promise.resolve();
    const settled = promise.then(() => {}, () => {});
    return Promise.race([settled, this._delay(maxWait)]);
  },

  /** 单次同步：失败一律 throw，由 _syncWithRetry 负责重试与降级 */
  async _syncOnce({ timeout = REQUEST_TIMEOUT } = {}) {
    // ⏸ 排障 / 强行恢复期间：连请求都不发，云端 0 条一点机会都没有
    if (this._cloudPaused) return { ok: false, changed: [], reason: 'paused' };
    const epoch = this._purgeEpoch;      // 发出请求时记下世代号
    let payload;
    try {
      payload = await this._fetchJSON('/api/data', { headers: { Accept: 'application/json' } }, timeout);
    } catch (error) {
      this.lastError = error;
      throw error;
    }
    // 请求在飞的时候执行过「一键清空」→ 这份结果已经过期，直接作废，绝不能落盘
    if (epoch !== this._purgeEpoch) {
      console.warn('[Store] 本次同步期间执行过一键清空，同步结果已作废（不落盘、不回写）');
      return { ok: false, reason: 'purged', changed: [] };
    }
    this.schema = payload.keys || null;

    if (payload.mode === 'supabase' && payload.data) {
      this.cloudState = 'on';
      this.mode = 'supabase';
      this._reconnectAttempts = 0;
      const before = this._snapshot();
      // ① 再读一遍盘上的锁：别的 iframe 可能比本实例晚一步刚写下锁（顺序抢占防线）
      this._refreshLocksFromStorage();
      // ② 丢掉过期的失败写入，避免它们随后被补推、把本地旧数据反向覆盖到云端
      this._dropStalePending();
      // ③ 云端覆盖：有锁的键一律跳过
      const changed = this._applyCloud(payload.data);
      /* 回写本地镜像：只写「这次真正变了」的键 + 云端已删除（缓存为 null）的键。
         ⚠️ 不再全量回写：多个 iframe 共享同一份 localStorage，一个缓存还是旧值的兄弟
            iframe 全量回写，会把报名页刚落盘的新数据盖成旧数据（用户一刷新就"数据没了"）。 */
      const toMirror = [...new Set([
        ...changed,
        ...STORE_KEYS.filter(key => this.cache.get(key) === null),
      ])];
      this._mirrorLocal(toMirror);
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

  /**
   * 明确的覆盖日志：控制台一眼看出哪些键被云端覆盖了、从多少变成多少。
   * ⚠️ 被防污染拦下（refused / healed / protected）的键必须单独报警：
   *    以前只在"真的变了"时才打印，拦下的情况一律落到"本次无差异"里，
   *    于是排障时看着那句"已强制覆盖（本次无差异）"会误以为同步成功 —— 其实云端正被 0 条污染。
   */
  _logOverwrite(changed, before) {
    const report = this._lastSyncReport || { protected: [], refused: [], healed: [] };
    if (!changed.length && !report.refused.length && !report.healed.length && !report.protected.length) {
      console.log('[Store] ✅ 云端数据与本地缓存、localStorage 镜像完全一致（0 个键有变化）');
    } else if (changed.length) {
      const detail = changed
        .map(key => `${key}：${before.get(key) ?? '空'} → ${this._sizeOf(this.cache.get(key))}`)
        .join('；');
      console.log(`[Store] ✅ 云端数据已覆盖本地缓存与 localStorage 镜像，${changed.length} 个键有变化 → ${detail}`);
    }
    if (report.refused.length) {
      console.warn(`[Store] ⛔ 云端这些键是 0 条而本地有数据 → 已拒绝覆盖，并反推回云端修复：${report.refused.join('、')}`);
    }
    if (report.healed.length) {
      console.warn(`[Store] ⏳ 云端这些键是 0 条且本地也被清空 → 已从时光机备份恢复并反推回云端：${report.healed.join('、')}`);
    }
  },

  /**
   * 丢弃过期的失败写入
   * 这些写入往往是本地旧缓存时代留下的，一旦联网就补推，会把云端新数据覆盖回旧版本。
   *
   * ⚠️ 例外：critical（重要表单，如报名保存）永不自动丢弃 ——
   * 那是用户刚点保存录入的数据，宁可一直重试补推，也绝不能因为过了 30 秒就当垃圾丢掉、
   * 再被云端旧数据覆盖（这正是"保存完一刷新数据就没了"的成因）。
   */
  _dropStalePending() {
    if (!this._pendingWrites.size) return;
    const now = Date.now();
    [...this._pendingWrites].forEach(([key, entry]) => {
      if (entry.critical) return;
      // 30 秒内：新鲜，一律保留（可能只是网络抖一下）；
      // 30 秒 ~ 5 分钟：只有重试过至少一次才继续保留，给用户留出「保存完马上刷新」的窗口；
      // 超过 5 分钟：判定为本地旧缓存残留，丢弃，以云端为准
      const fresh = now - entry.at <= PENDING_FRESH_MS;
      const withinGrace = now - entry.at <= UNCONFIRMED_TTL_MS && (entry.attempts || 0) >= 1;
      if (fresh || withinGrace) return;
      this._clearUnconfirmed(key);   // 只删自己这条锁，别人的锁不受影响
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
   * 冲突处理：云端优先；但该键只要还有「本地已改、云端未确认」的写入就保留本地值。
   *
   * ⚠️ 这里只保护"写入失败"是不够的：写入还在飞（POST 还没返回）时队列里根本没有记录，
   * 用户保存完立刻刷新 → 新页面同步拿回云端旧数据 → 把刚保存的数据直接冲掉。
   * 所以 write() 在推送前就打标记，成功才清除。
   */
  _applyCloud(data) {
    const changed = [];
    const protectedKeys = [];
    const report = { protected: protectedKeys, refused: [], healed: [] };
    this._lastSyncReport = report;
    // ⏸ 暂停期间：一个键都不许改（forceRecover 恢复出来的数据谁也别碰）
    if (this._cloudPaused) {
      console.warn('[Store] ⏸ 云端同步已暂停，本次云端数据未落到本地（forceRecover 期间保护本地数据）');
      return changed;
    }
    STORE_KEYS.forEach(key => {
      // 保护未确认的本地写入（正在推送 / 推送失败待补推）：
      // critical 永久保护，普通写入在 UNCONFIRMED_TTL_MS 内保护；
      // 过期的已在 _dropStalePending 里清掉，必须让云端覆盖，否则旧缓存永远赖着不走
      // 有锁 = 本地这份数据还没被云端确认 → 直接跳过，云端说什么都不许覆盖
      const pending = this._pendingWrites.get(key);
      if (pending && (pending.critical || Date.now() - pending.at <= UNCONFIRMED_TTL_MS)) {
        protectedKeys.push(key);
        return;
      }
      const next = data[key] === undefined ? null : data[key];
      const current = this.cache.get(key);
      /* ⛔ 云端空数据防污染 —— 必须放在「无差异」早退【之前】。
         否则"云端 0 条 + 本地也 0 条"会被判定成无差异直接 return，
         备份永远没机会救场（日志里那句"本次无差异"就是这么绕过防线的）。
         两个分支都会【反向推回云端】，把被污染成 0 条的云端表修回来。 */
      if (this._isMeetKey(key) && this._countOf(next) === 0) {
        if (this._countOf(current) > 0) {
          console.warn(`[Store] ⛔ 云端 ${key} 为 0 条，本地有 ${this._countOf(current)} 条 → 拒绝覆盖并反推回云端`);
          report.refused.push(key);
          this._pushBackToCloud(key, current);
          return;
        }
        // 本地也是空的 → 无条件问备份要数据（备份恢复成功会自己反推云端）
        if (this._healMeetDataFromBackup(key, '云端返回 0 条')) {
          report.healed.push(key);
          console.warn(`[Store] ⛔ 云端 ${key} 为 0 条，已从备份恢复 `
            + `${this._countOf(this.cache.get(key))} 条并反推回云端，拒绝云端空覆盖`);
          changed.push(key);
          return;
        }
      }
      if (JSON.stringify(current === undefined ? null : current) === JSON.stringify(next)) {
        // 云端带回非空数据 → 顺手刷新备份，保证备份永远是最新那一份
        if (this._isMeetKey(key) && this._countOf(next) > 0) this._updateBackup(key, next, {});
        return;
      }
      // 云端这条是空的、本地却有数据 —— 只有「本会话亲手写过」的键才保本地：
      // 这种情况多半是自己的写入还没落库 / 云端读取打了个空，静默清空 = 用户眼里的"数据消失了"。
      // 本会话没写过的键仍以云端为准（别的设备删了就删了），不改变原有同步语义。
      if (this._isEmptyValue(next) && !this._isEmptyValue(current) && this._localWrites.has(key)) {
        console.warn(`[Store] ⚠️ 云端 ${key} 为空但本地刚写过数据，保留本地不清空（确认要以云端为准请用 forceSyncCloud()）`);
        this._pushBackToCloud(key, current);
        return;
      }
      /* ⛔ 云端空数据防冲击（运动会数据专用，无条件）：
         云端拉回来的 athletes / registrations 是 0 条，而本地（或刚恢复的备份）有数据 →
         绝对不许覆盖。这是"刷新一次数据就没了"的最后一道闸门 ——
         不管是谁把云端洗成了 0 条，本地这份都原地不动，并【反向推回云端】把 0 条盖回去。 */
      if (this._isMeetKey(key) && this._isPlainObject(current)) {
        const cloudLost = MEET_CRITICAL_FIELDS.some(field => {
          const localCount = Array.isArray(current[field]) ? current[field].length : 0;
          const cloudCount = this._isPlainObject(next) && Array.isArray(next[field]) ? next[field].length
            : (next === null || next === undefined ? 0 : -1);
          return localCount > 0 && cloudCount === 0;
        });
        if (cloudLost) {
          console.warn(`[Store] ⛔ 云端 ${key} 的报名数据是空的（0 条），本地有 `
            + `${this._countOf(current)} 条 → 拒绝覆盖，并把本地数据反推回云端`);
          this._pushBackToCloud(key, current);
          return;
        }
      }
      this._traceEmptyWrite(key, current, next, '_applyCloud()（云端覆盖）');
      this.cache.set(key, next);
      changed.push(key);
    });
    if (protectedKeys.length) {
      console.warn(`[Store] ⛔ 云端数据未覆盖这些键（本地刚写入、云端还没确认，稍后自动补推）：${protectedKeys.join('、')}`);
    }
    return changed;
  },

  /**
   * 「反杀云端」：本地有数据而云端是空的 → 把本地这份推回云端，把云端的 0 条盖掉。
   * 上锁 + 立即重试，保证推送期间云端旧（空）数据也别想再覆盖本地。
   */
  _pushBackToCloud(key, value) {
    if (this._cloudPaused) return;                 // ⏸ 暂停期间不上锁、不推送
    if (this.cloudState === 'off') return;         // 明确没配云端 / 服务端 503，不做无谓重试
    if (this._pendingWrites.has(key)) return;      // 已经有写入在飞/待推，不重复排队
    this._localWrites.add(key);
    this._markUnconfirmed(key, value);             // 同步上锁（防推进过程中被云端空数据反扑）
    this._persistSafely(key, value);               // 立即推一次，失败由 _scheduleCriticalRetry 接力
    this._scheduleCriticalRetry(key);
  },

  /** 判断一个值算不算"空"（null / 空数组 / 空对象）；字符串与数字不算空，避免误判标题等标量 */
  _isEmptyValue(value) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  },

  /**
   * 把云端结果回写 localStorage，保证本地始终有镜像
   * 云端没有的键会被清掉（传 changed 时只清这次真正变了的键），不留残存旧数据
   *
   * ⚠️ 绝不回写「带锁」的键：锁表示本地这份还没被云端确认，
   *    而各个 iframe 共享同一份 localStorage —— 一个缓存还是旧值的兄弟 iframe
   *    一旦回写，就会把报名页刚落盘的新数据盖成旧数据（锁保得住缓存，保不住 localStorage）。
   */
  _mirrorLocal(keys = STORE_KEYS) {
    keys.forEach(key => {
      if (this._pendingWrites.has(key)) return;   // 有锁：这个键的本地镜像由写入方负责
      try {
        const value = this.cache.get(key);
        // 🚨 看门狗：这里写的是 localStorage —— 兄弟 iframe 读的就是它，最容易"看见 0 条"
        let rawBefore = null;
        try { rawBefore = localStorage.getItem(key); } catch (error) { rawBefore = null; }
        if (rawBefore !== null) {
          try {
            this._traceEmptyWrite(key, JSON.parse(rawBefore), value, '_mirrorLocal()（回写 localStorage）');
          } catch (error) { /* 解析不了就算了 */ }
        }
        if (value === null || value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        console.warn(`[Store] 回写本地镜像失败：${key}`, error);
      }
    });
  },

  /**
   * 派发同步事件：本窗口 + 父窗口 / 顶层窗口。
   * ⚠️ 各模块是 iframe 隔离的（报名页改的数据，赛程页收不到本窗口的事件），
   *    所以要往 parent / top 也发一份；兄弟 iframe 之间靠下面的 storage 监听打通。
   */
  _dispatchSync(changed, extra = {}) {
    if (typeof window === 'undefined') return;
    const detail = { mode: this.mode, changed, at: Date.now(), ...extra };
    const fire = target => {
      try {
        const Ctor = typeof target.CustomEvent === 'function' ? target.CustomEvent : CustomEvent;
        target.dispatchEvent(new Ctor('store:sync', { detail }));
      } catch (error) {
        /* 跨域等情况忽略 */
      }
    };
    fire(window);
    try {
      if (window.parent && window.parent !== window) fire(window.parent);
      if (window.top && window.top !== window && window.top !== window.parent) fire(window.top);
    } catch (error) {
      /* 跨域访问 parent 会抛错，忽略 */
    }
  },

  /**
   * 跨 iframe / 跨标签页同步：同源的其它文档改了 localStorage，本页立刻收到 storage 事件。
   * 没有这条通道时，报名页保存完切到赛程页（iframe 已加载过）看到的还是旧缓存。
   */
  _bindCrossDocumentSync() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (this._crossBound) return;
    this._crossBound = true;
    window.addEventListener('storage', event => {
      const key = event.key;
      if (!key || !STORE_KEYS.includes(key)) return;
      // 本页这份键还有「云端未确认」的写入 → 保留本地，绝不让别人（或云端旧值）覆盖
      if (this._pendingWrites.has(key)) return;
      /* ✅ 唯一的例外：别的 iframe 明确执行了「一键清空」（世代号前进了）。
         用户亲自确认过的清空必须生效，否则兄弟页面"死活不清空"会被当成 Bug 再报一次。 */
      if (this._detectForeignPurge()) {
        this.cache.delete(key);
        try { localStorage.removeItem(key); } catch (error) { /* 忽略 */ }
        console.log(`[Store] 🧨 检测到其它页面执行了一键清空，${key} 已同步清空（不再从备份复活）`);
        this._dispatchSync([key], { reason: 'purgeMeetData', crossDocument: true });
        return;
      }
      let next = null;
      try {
        next = event.newValue === null || event.newValue === undefined ? null : JSON.parse(event.newValue);
      } catch (error) {
        console.warn(`[Store] 解析跨页面数据失败：${key}`, error);
        return;
      }
      const current = this.cache.get(key);
      /* ⛔ 反向清空防线：别的文档把这个键删了 / 写成空（很可能是它那边还在初始化、
         时序上先读到了空值），而本页有数据 —— 绝不接受，否则等于让它把主数据清空。 */
      if (this._isEmptyValue(next) && !this._isEmptyValue(current)) {
        console.warn(`[Store] ⛔ 忽略其它页面对 ${key} 的清空（本页有数据，${this._countOf(current)} 条）`);
        return;
      }
      // 报名数据被写成"空"而本页有数据：同样拒绝（只认整体为空的情况，上面已覆盖；这里再兜一层字段级）
      if (this._isMeetKey(key) && this._isPlainObject(next) && this._isPlainObject(current)
        && MEET_CRITICAL_FIELDS.some(field => {
          const beforeCount = Array.isArray(current[field]) ? current[field].length : 0;
          const afterCount = Array.isArray(next[field]) ? next[field].length : 0;
          return beforeCount > 0 && afterCount === 0;
        })) {
        console.warn(`[Store] ⛔ 忽略其它页面对 ${key} 报名数据的清空（本地 ${this._countOf(current)} 条）`);
        return;
      }
      /* ⛔ 兄弟页面用的是"空状态"、本页也恰好是空的 → 绝不接受这个空值：
         先问备份要数据（多半是它在初始化时把空值写回了共享的 localStorage），
         备份也没有才认这份空。（用户亲手清空时备份已一并删除，不会误复活。） */
      if (this._isMeetKey(key) && this._countOf(next) === 0 && this._countOf(current) === 0) {
        if (this._healMeetDataFromBackup(key, '兄弟页面传来空数据')) {
          console.warn(`[Store] ⛔ 兄弟页面把 ${key} 清空了，已从备份恢复 `
            + `${this._countOf(this.cache.get(key))} 条，忽略这次空值`);
          this._dispatchSync([key], { restored: true, reason: 'crossDocumentEmpty' });
          return;
        }
      }
      if (JSON.stringify(current === undefined ? null : current) === JSON.stringify(next)) return;
      this.cache.set(key, next);
      console.log(`[Store] 🔄 检测到其它页面更新了 ${key}，已同步到本页缓存`);
      this._dispatchSync([key], { crossDocument: true });
    });
  },

  /** 盘上的「一键清空」指令：{ epoch, at }（早期版本可能只存了纯数字，一并兼容） */
  _storedPurgeSignal() {
    try {
      const raw = localStorage.getItem(MEET_PURGE_EPOCH_KEY);
      if (!raw) return { epoch: 0, at: 0 };
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'number') return { epoch: parsed, at: Date.now() };
      return { epoch: Number(parsed?.epoch) || 0, at: Number(parsed?.at) || 0 };
    } catch (error) {
      return { epoch: 0, at: 0 };
    }
  },

  /**
   * 别的文档刚刚执行了「一键清空」？（世代号前进 = 用户亲手点过，属于明确的清空指令）
   * ⚠️ 只认 PURGE_SIGNAL_TTL_MS 内发生的：世代号没有过期清理机制，
   *    隔天后第一次数据变更如果不看时间戳，就会被当成"清空指令"把新导入的数据抹掉。
   */
  _detectForeignPurge() {
    const { epoch, at } = this._storedPurgeSignal();
    if (epoch <= this._purgeEpochSeen) return false;
    this._purgeEpochSeen = epoch;                 // 认下这个世代号，后续不再重复判断
    if (at && Date.now() - at > PURGE_SIGNAL_TTL_MS) return false;
    this._purgeEpoch = Math.max(this._purgeEpoch, epoch);
    return true;
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
    /* 缓存还没灌（页面脚本常在 Store.start() 之前就 read()）：
       先把 localStorage 镜像灌进缓存，绝不能因为"缓存里没有"就返回空 ——
       报名页 pageData = loadMeetData() 就是这么拿到 0 条、渲染出空页面的。 */
    if (!this.cache.has(key)) this._hydrateFromLocal(key);
    /* ⛔ 自愈底线：只要主数据是空的，就【无条件、同步】试一次时光机备份。
       不看云同步走到哪一步、不看有没有差异 —— 备份在，任何页面任何时刻读到的都必须是 216 条。
       这是"三个页面（报名 / 赛程 / 成绩）表现绝对一致"的最后保证。 */
    if (this._isMeetKey(key)) this._healMeetDataFromBackup(key);
    const value = this.cache.get(key);
    const result = value === undefined ? fallback : value;
    if (this._isMeetKey(key)) {
      console.log(`[Store] 读取键：${key}，报名数据：${this._countOf(result)}条`
        + `，赛程：${Array.isArray(result?.schedule?.entries) ? `${result.schedule.entries.length} 个时段` : '无'}`);
    }
    return result;
  },

  /**
   * 写入：本地镜像 + 内存缓存立即生效，云端异步推送
   * ⚠️ 推送【前】就打上"未确认"标记，成功后才清除 ——
   *    否则这段"写入已发出、云端还没返回"的窗口里，云端旧数据一回就会被覆盖（数据丢失）
   * @param {string} key
   * 报名数据（athletes / registrations）与赛程（schedule）共用同一个 Key，
   * 所以写整体对象时【合并而非替换】：新对象里缺失 / 被写空的字段保留本地已有数据，
   * 避免赛程页拿自己那份过期的内存快照整体写回、把报名数据冲掉。
   *
   * @param {*} value
   * @param {{push?: boolean, allowEmpty?: boolean, force?: boolean}} options
   *        push=false 时只落本地（由 writeCritical 自己 await 推送）
   *        allowEmpty / force=true 表示"用户在界面上明确要清空"，才允许把报名数据写空
   *        （否则 athletes / registrations 从有到无会【抛异常终止写入】）
   */
  write(key, value, options = {}) {
    const before = this._isMeetKey(key) ? this.cache.get(key) : undefined;
    const merged = this._mergeMeetData(key, value, options);   // ⛔ 空覆盖在这里抛异常
    this._traceEmptyWrite(key, before, merged, 'write()');      // 🚨 看门狗：谁把主数据写成 0 条
    this.cache.set(key, merged);
    this._localWrites.add(key);
    if (this._isMeetKey(key)) {
      console.log(`[Store] 写入键：${key}，写入前报名数据：${this._countOf(before)}条，写入后报名数据：${this._countOf(merged)}条`);
    }
    try {
      localStorage.setItem(key, JSON.stringify(merged));
    } catch (error) {
      console.warn(`[Store] 写入本地镜像失败：${key}`, error);
    }
    if (this._isMeetKey(key)) this._updateBackup(key, merged, options);
    if (options.push === false) return merged;
    // 云端可用才需要"未确认保护"（纯本地模式没有云端数据来覆盖）；
    // 重要表单走 writeCritical，它自己会打 critical 标记，不受这里影响
    if (this.cloudState !== 'off') {
      // 只有"调用方声明这是用户亲手要清空"时，才允许把空数据推给云端
      const allowEmpty = options.force === true || options.allowEmpty === true;
      this._markUnconfirmed(key, merged, { clear: allowEmpty && !this._hasContent(key, merged) });
      this._persistSafely(key, merged, { allowEmpty });
    }
    return merged;
  },

  /**
   * 运动会数据的合并写入（防覆盖核心）：
   * ① 缺失字段用本地已有的补上（赛程页只关心 schedule，不该动 athletes / registrations）
   * ② 除非调用方显式 allowEmpty，否则不许用空数组把本地已有的报名数据冲掉
   */
  _mergeMeetData(key, next, options = {}) {
    if (!this._isMeetKey(key)) return next;
    const current = this.cache.get(key);
    if (!this._isPlainObject(current) || !this._isPlainObject(next)) return next;
    // 缺失字段用本地已有的补上（赛程页只写 schedule，不该动 athletes）
    const merged = { ...current, ...next };
    const force = options.force === true || options.allowEmpty === true;
    // ⛔ 绝对防御：报名数据（athletes / registrations）从"有"写成"无"，
    //    一律抛异常终止写入 —— 后台自动同步、页面跳转、跨 iframe 时序错乱带来的空数据
    //    都不准覆盖。唯一例外：用户在界面上亲手点了"清空数据"，由调用方显式传 force: true。
    const blocked = [];
    MEET_CRITICAL_FIELDS.forEach(field => {
      const beforeCount = Array.isArray(current[field]) ? current[field].length : 0;
      const afterCount = Array.isArray(next[field]) ? next[field].length : 0;
      if (beforeCount === 0 || afterCount > 0) return;
      if (force) return;                       // 用户明确要清空，放行
      blocked.push(`${field}（本地 ${beforeCount} 条 → 要写入 ${afterCount} 条）`);
    });
    if (blocked.length) {
      const message = `已阻止用空数据覆盖 ${key}：${blocked.join('、')}。`
        + '若确实要清空，请在界面上点「清空数据」并传 force: true';
      console.error(`[Store] ⛔ ${message}`);
      throw new Error(`[Store] ${message}`);
    }
    // 其它数组（heats 等）：缺失 / 写空时保留本地已有数据，只合并不报错
    MEET_ARRAY_FIELDS.filter(field => !MEET_CRITICAL_FIELDS.includes(field)).forEach(field => {
      const before = current[field];
      const after = next[field];
      if (!Array.isArray(before) || before.length === 0) return;
      if (Array.isArray(after) && after.length > 0) return;
      merged[field] = before;
    });
    return merged;
  },

  _isMeetKey(key) {
    return MEET_DATA_KEYS.includes(key) && key !== 'sportsMeetTitle';
  },

  /** 主数据键：报名条数就是它的全部家当，判断"有没有数据"只看 athletes / registrations */
  _isCountableMeetKey(key) {
    return key === MEET_MAIN_KEY;
  },

  /**
   * 某个键到底"有没有内容"：
   * 主数据看报名条数（跟刷新丢数据这条战线的口径完全一致），
   * 项目库这类数组看长度，模板配置这类对象看字段数。
   */
  _hasContent(key, value) {
    if (this._isCountableMeetKey(key)) return this._countOf(value) > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (this._isPlainObject(value)) return Object.keys(value).length > 0;
    return Boolean(value) && String(value).trim() !== '';
  },

  /* ---------------- 「本地时光机」备份 ----------------
   * 每次成功保存非空数据，额外存一份（带时间戳）。
   * ⚠️ 按存储键【分槽】落盘（pe_sports_meet_backup_v1::<key>）：
   *    以前所有运动会键共用一个槽，谁最后写谁说话 —— 一旦别的功能键覆盖了这一份，
   *    报名数据唯一的备份就没了，刷新后只能显示空页面。
   *    裸键 pe_sports_meet_backup_v1 仍然写着主数据那一份，兼容老版本写过的备份。
   * 页面加载 / 读取时只要主数据为空 → 无条件从备份恢复。
   * 用户在界面上明确清空（force / allowEmpty）→ 连备份一起删掉，免得"清空后又自己长回来"。
   */
  _backupKeyOf(key) {
    return `${MEET_BACKUP_KEY}::${key}`;
  },

  _updateBackup(key, value, options = {}) {
    if (this._hasContent(key, value)) {
      const payload = JSON.stringify({
        savedAt: Date.now(), key, count: this._countOf(value), data: value,
      });
      try {
        localStorage.setItem(this._backupKeyOf(key), payload);
        if (this._isCountableMeetKey(key)) localStorage.setItem(MEET_BACKUP_KEY, payload);
      } catch (error) {
        console.warn('[Store] 写入本地备份失败', error);   // 备份失败不能影响主流程
      }
      return;
    }
    // 数据被清空：只有用户亲手操作（force / allowEmpty）才允许清掉备份
    if (options.force === true || options.allowEmpty === true) {
      try {
        localStorage.removeItem(this._backupKeyOf(key));
        if (this._isCountableMeetKey(key)) localStorage.removeItem(MEET_BACKUP_KEY);
      } catch (error) { /* 忽略 */ }
    }
  },

  /** 读某个键的备份槽：优先自己的分槽，退回老版本的裸备份（且必须是同一个键） */
  _readBackupSlot(key) {
    const parse = raw => {
      if (!raw) return null;
      try {
        const slot = JSON.parse(raw);
        if (!slot || typeof slot !== 'object') return null;
        if (slot.key && slot.key !== key) return null;      // 这份备份属于别的键，不能用
        return slot;
      } catch (error) {
        return null;
      }
    };
    return parse(localStorage.getItem(this._backupKeyOf(key)))
      || parse(localStorage.getItem(MEET_BACKUP_KEY));
  },

  /**
   * 页面启动 / 读数据时：主数据为空而备份有数据 → 无条件恢复（返回是否真的恢复过）
   * @param {{reason?:string, key?:string, dispatch?:boolean}} options
   *        key 留空 = 把运动会相关的键全部过一遍（start() 用），
   *        这样任何一个页面在初始化时，只要主数据丢了，百分百能拉起来。
   */
  _restoreFromBackup(options = {}) {
    if (this._healing) return false;                              // 防重入（_pushBackToCloud 可能绕回来）
    this._healing = true;
    const restoredKeys = [];
    try {
      MEET_DATA_KEYS.filter(key => this._isMeetKey(key)).forEach(key => {
        if (options.key && key !== options.key) return;
        const slot = this._readBackupSlot(key);
        if (!slot) return;
        if (!this._hasContent(key, slot.data)) return;            // 备份本身就是空的，没得恢复
        const current = this._readLocalValue(key);
        if (this._hasContent(key, current)) {
          // 本地盘上有内容、只是还没灌进缓存（比如 read() 早于 start()）：用盘上这份，绝不用旧备份顶
          if (current !== undefined && !this.cache.has(key)) this.cache.set(key, current);
          return;
        }
        this.cache.set(key, slot.data);
        try { localStorage.setItem(key, JSON.stringify(slot.data)); } catch (error) { /* 忽略 */ }
        console.warn(`[Store] ⏳ ${key} 为空，已从本地备份自动恢复 ${this._countOf(slot.data) || '若干'} 条数据`
          + `（备份时间：${new Date(slot.savedAt || Date.now()).toLocaleString('zh-CN')}）`
          + (options.reason ? `，触发点：${options.reason}` : ''));
        // 备份反杀云端：主数据既然被清了，云端多半也是 0 条 → 恢复后立刻把数据推回云端
        this._pushBackToCloud(key, slot.data);
        restoredKeys.push(key);
      });
    } finally {
      this._healing = false;
    }
    if (!restoredKeys.length) return false;
    if (options.dispatch !== false) {
      this._dispatchSync(restoredKeys, { restored: true, reason: options.reason || 'restoreFromBackup' });
    }
    return true;
  },

  /** 自愈入口：主数据空 → 拉备份（read / 云端空 / 兄弟页面清空 都会走这里） */
  _healMeetDataFromBackup(key, reason) {
    if (!this._isMeetKey(key)) return false;
    if (this._hasContent(key, this._readLocalValue(key))) return false;
    return this._restoreFromBackup({ key, reason: reason || '主数据为空自愈' });
  },

  _isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  },

  /** 报名数据条数（日志用）：优先 athletes，其次 registrations */
  _countOf(value) {
    if (!this._isPlainObject(value)) return 0;
    if (Array.isArray(value.athletes)) return value.athletes.length;
    if (Array.isArray(value.registrations)) return value.registrations.length;
    return 0;
  },

  /**
   * 重要表单的强一致写入（报名保存、清空报名等）：本地立即生效，然后【等云端确认】
   * @returns {Promise<{ok:boolean, mode:string, localSaved:boolean, error?:string}>}
   *   ok=true  —— 云端已确认落库（此时才应提示"保存成功"）
   *   ok=false —— 云端写入失败：数据完整保留在本地（localSaved 恒为 true）并持续重试，
   *               调用方必须弹窗报错，绝不能提示"保存成功"
   *
   * 成功后派发 store:sync，强制通知其它模块（赛程编排等）立刻重取数据，不用等轮询。
   */
  async writeCritical(key, value, {
    label = '', attempts = CRITICAL_WRITE_ATTEMPTS, allowEmpty = false, force = false,
  } = {}) {
    /* ⚠️ 时序铁律（用户可能 0.1 秒后按 F5，任何一步都不能排在 fetch 后面）：
     *   ① 先同步落 localStorage（write 内部完成）
     *   ② 再同步打锁并落盘
     *   ③ 最后才发网络请求
     * 反过来的话：请求发出后、锁还没写盘的那几毫秒里刷新，云端旧数据就会把新数据冲掉。 */
    const saved = this.write(key, value, { push: false, allowEmpty, force });   // ① 本地立即生效（含防覆盖）
    const entry = this._pendingWrites.get(key);
    // clear = 用户亲手要清空（写空就是目的）→ 允许把空数据推到云端；其它情况一律不许写空
    const clearIntent = (allowEmpty === true || force === true) && !this._hasContent(key, saved);
    const lockEntry = {
      value: saved,          // 推的是合并后的最终值，和本地镜像 / 缓存完全一致
      at: entry?.at ?? Date.now(),
      critical: true,
      clear: clearIntent,
      attempts: entry?.attempts || 0,
      label: label || entry?.label || '',
    };
    this._pendingWrites.set(key, lockEntry);
    this._writeLock(key, lockEntry);                  // ② 同步上锁（在发请求之前）

    if (this.cloudState === 'off') {
      const reason = this.lastError?.message
        || '云端存储未连接（服务端未配置 Supabase，或网络不可用）';
      console.error(`[Store] 重要数据 ${key} 未能写入云端：${reason}；已完整保留在本地`);
      this._dispatchSync([key], { localWrite: true, cloudConfirmed: false, critical: true });
      return { ok: false, mode: this.mode, localSaved: true, error: reason };
    }

    try {
      await this._persistWithRetry(key, saved, attempts, { allowEmpty: clearIntent });   // ③ 到这里才发网络请求
      this._clearUnconfirmed(key);
      console.log(`[Store] ✅ ${key} 已写入云端并确认`);
      // 通知所有模块立刻重取（赛程编排不用等下次轮询就能看到新报名）
      this._dispatchSync([key], { localWrite: true, cloudConfirmed: true, critical: true });
      return { ok: true, mode: this.mode, localSaved: true };
    } catch (error) {
      const failed = this._pendingWrites.get(key);
      if (failed) {
        failed.attempts = (failed.attempts || 0) + 1;
        failed.lastError = error?.message || String(error);
        failed.critical = true;
        this._writeLock(key, failed);            // 锁保持（重要表单永不上交云端旧数据）
      }
      this._scheduleCriticalRetry(key);          // 后台持续续传，绝不静默丢弃
      this._onPersistError(key, error);
      this._dispatchSync([key], { localWrite: true, cloudConfirmed: false, critical: true });
      return {
        ok: false, mode: this.mode, localSaved: true, error: error?.message || String(error),
      };
    }
  },

  /** 带重试的云端推送（503 = 服务端没配 Supabase，不必重试） */
  async _persistWithRetry(key, value, attempts = 1, options = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this._persist(key, value, options);
      } catch (error) {
        lastError = error;
        if (error?.status === 503) throw error;
        if (attempt < attempts) await this._delay(RETRY_DELAY);
      }
    }
    throw lastError;
  },

  /** 重要表单云端确认失败后的后台续传：按 CRITICAL_RETRY_DELAYS 逐步退避，成功即解除保护 */
  _scheduleCriticalRetry(key) {
    if (typeof window === 'undefined') return;
    if (this._criticalTimers.has(key)) return;
    let step = 0;
    const runNext = async () => {
      const entry = this._pendingWrites.get(key);
      if (!entry) { this._criticalTimers.delete(key); return; }
      try {
        const sent = await this._persist(key, entry.value, { allowEmpty: entry.clear === true });
        if (sent === false) {               // 空数据：闸门已交出锁，别再无限续传
          this._criticalTimers.delete(key);
          return;
        }
        this._clearUnconfirmed(key);
        this._criticalTimers.delete(key);
        console.log(`[Store] ✅ ${key} 已补传云端（重试第 ${step + 1} 次成功）`);
        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
          window.showToast('数据已补传到云端', 'success');
        }
        this._dispatchSync([key], { localWrite: true, cloudConfirmed: true, retried: true });
        return;
      } catch (error) {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastError = error?.message || String(error);
        this._writeLock(key, entry);
        step += 1;
        if (step >= CRITICAL_RETRY_DELAYS.length) {
          this._criticalTimers.delete(key);
          console.warn(`[Store] ${key} 仍未写入云端，数据已完整保留在本机，联网后会自动继续重试（不要再刷新或清理浏览器数据）`);
          return;
        }
        this._criticalTimers.set(key, setTimeout(runNext, CRITICAL_RETRY_DELAYS[step]));
      }
    };
    this._criticalTimers.set(key, setTimeout(runNext, CRITICAL_RETRY_DELAYS[0]));
  },

  async _persistSafely(key, value, options = {}) {
    try {
      const sent = await this._persist(key, value, options);
      if (sent === false) return;          // 空数据被闸门拦下（锁已在里面交出），无需重试
      this._clearUnconfirmed(key);
    } catch (error) {
      // 服务端没配 Supabase：安静地退回纯本地模式，不打扰用户
      if (error && error.status === 503) {
        this.cloudState = 'off';
        this.mode = 'local';
        this._clearUnconfirmed(key);
        return;
      }
      const entry = this._pendingWrites.get(key) || { value, at: Date.now(), attempts: 0 };
      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastError = error?.message || String(error);
      this._pendingWrites.set(key, entry);
      this._writeLock(key, entry);
      this._onPersistError(key, error);
    }
  },

  /**
   * 打上「本地已改、云端未确认」标记。
   * ⚠️ 同步、立即落 localStorage —— 必须在发起 fetch 【之前】完成，
   *    用户哪怕 0.1 秒后按 F5，锁也必须已经在盘上。
   *
   * ⚠️ 锁是【按存储键单独一条】localStorage 记录，不是整体一个 JSON：
   *    报名页（iframe A）写锁后，赛程页（iframe B）做自己的例行同步时，
   *    如果它是"整体覆盖一个锁文件"，就会用自己【空的】队列把 A 刚写的锁抹掉
   *    → 用户一刷新，云端旧数据长驱直入。按 key 存，谁写的锁谁才能删。
   */
  _markUnconfirmed(key, value, options = {}) {
    const prev = this._pendingWrites.get(key);
    const entry = {
      value,
      at: prev?.at ?? Date.now(),
      critical: Boolean(prev?.critical),
      clear: options.clear !== undefined ? Boolean(options.clear) : Boolean(prev?.clear),
      attempts: prev?.attempts || 0,
      label: prev?.label || '',
    };
    this._pendingWrites.set(key, entry);
    this._writeLock(key, entry);
  },

  /** 写一条锁到 localStorage（同步） */
  _writeLock(key, entry) {
    try {
      localStorage.setItem(this._lockKeyOf(key), JSON.stringify({
        at: entry.at,
        critical: Boolean(entry.critical),
        // clear = 这次写入就是"用户在界面上清空"，刷新后续传时同样允许写空到云端
        clear: Boolean(entry.clear),
        attempts: entry.attempts || 0,
        label: entry.label || '',
      }));
    } catch (error) {
      console.warn(`[Store] 写入保护锁失败：${key}`, error);
    }
  },

  /** 解除保护：只有【确认过】的实例才能删自己那条锁 */
  _clearUnconfirmed(key) {
    this._pendingWrites.delete(key);
    try {
      localStorage.removeItem(this._lockKeyOf(key));
    } catch (error) {
      console.warn(`[Store] 清除保护锁失败：${key}`, error);
    }
  },

  _lockKeyOf(key) {
    return `${UNCONFIRMED_LOCK_PREFIX}${key}`;
  },

  /** 刷新后恢复保护锁：本地镜像里就是用户刚保存的那份数据，继续保护 + 续传 */
  _restoreUnconfirmed() {
    const locks = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const raw = localStorage.key(i);
        if (raw && raw.startsWith(UNCONFIRMED_LOCK_PREFIX)) locks.push(raw);
      }
    } catch (error) {
      console.warn('[Store] 枚举保护锁失败', error);
      return;
    }
    locks.forEach(lockKey => {
      const key = lockKey.slice(UNCONFIRMED_LOCK_PREFIX.length);
      let info = null;
      try {
        info = JSON.parse(localStorage.getItem(lockKey) || '{}');
      } catch (error) {
        info = {};
      }
      const value = this._readLocalValue(key);
      if (value === undefined || value === null) {
        try { localStorage.removeItem(lockKey); } catch (error) { /* 忽略 */ }
        return;   // 本地都没这份数据，没什么可保护的
      }
      /* ⚠️ 运动会数据本身是空的就不要上锁：锁会让它之后的每次云端同步都跳过这个键，
         连"云端 0 条 → 从备份恢复"这条自愈路径都进不去 —— 这正是报名页读不出备份的成因之一。 */
      if (this._isMeetKey(key) && !this._hasContent(key, value)) {
        try { localStorage.removeItem(lockKey); } catch (error) { /* 忽略 */ }
        return;
      }
      this._pendingWrites.set(key, {
        value,
        at: info?.at || Date.now(),
        critical: Boolean(info?.critical),
        clear: Boolean(info?.clear),
        attempts: info?.attempts || 0,
        label: info?.label || '',
      });
      console.warn(`[Store] ⛔ 检测到「${key}」上次写入云端未确认（${Math.round((Date.now() - (info?.at || Date.now())) / 1000)} 秒前），本地数据已上锁保护，云端不得覆盖，将自动补推`);
      // 只有云端还连着才排续传，避免"根本没配云端"时每次开页面都空转重试
      if (this.cloudState !== 'off') this._scheduleCriticalRetry(key);
    });
  },

  /**
   * 同步前再读一遍盘上的锁：别的文档可能刚刚（比本实例启动更晚）写下锁。
   * 顺序抢占防线：不管云端请求什么时候回来，只要盘上有锁就绝不覆盖。
   */
  _refreshLocksFromStorage() {
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const lockKey = localStorage.key(i);
        if (!lockKey || !lockKey.startsWith(UNCONFIRMED_LOCK_PREFIX)) continue;
        const key = lockKey.slice(UNCONFIRMED_LOCK_PREFIX.length);
        if (this._pendingWrites.has(key)) continue;         // 本实例已知道，不重复
        let info = {};
        try { info = JSON.parse(localStorage.getItem(lockKey) || '{}'); } catch (error) { info = {}; }
        const value = this._readLocalValue(key);
        if (value === undefined || value === null) continue;
        // 同上：运动会数据为空时不上锁，别让空数据的锁挡住自愈通道
        if (this._isMeetKey(key) && !this._hasContent(key, value) && info?.clear !== true) continue;
        this._pendingWrites.set(key, {
          value,
          at: info?.at || Date.now(),
          critical: Boolean(info?.critical),
          clear: Boolean(info?.clear),
          attempts: info?.attempts || 0,
          label: info?.label || '',
        });
        console.warn(`[Store] ⛔ ${key} 检测到其它页面刚写入的保护锁，本次云端数据不覆盖本地`);
      }
    } catch (error) {
      console.warn('[Store] 读取保护锁失败', error);
    }
  },

  /** 直接读本地镜像（不依赖缓存是否已灌入，start 早期也能用） */
  _readLocalValue(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (error) {
      return undefined;
    }
  },

  /** 把 localStorage 镜像灌进缓存（缓存里还没有这个键时才用） */
  _hydrateFromLocal(key) {
    if (this.cache.has(key)) return;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      this.cache.set(key, JSON.parse(raw));
    } catch (error) {
      /* JSON 坏了就当没有，交给备份自愈 */
    }
  },

  /**
   * 🚨 排障看门狗：只要主数据（pe_sports_meet_v1）从"有"变成"0 条"，立刻打印调用栈。
   * 这条战线最难受的地方是"刷新一下就没了"却永远抓不到凶手 —— 装了它之后，
   * 控制台会把凶手所在的文件和行号（store.js / schedule.js / results.js …）直接打出来。
   */
  _traceEmptyWrite(key, before, after, phase) {
    if (!this._isCountableMeetKey(key)) return;
    const beforeCount = this._countOf(before);
    const afterCount = this._countOf(after);
    if (beforeCount === 0 || afterCount > 0) return;
    console.error(
      `[Store] 🚨🚨 ${phase} 把 ${key} 从 ${beforeCount} 条写成了 ${afterCount} 条！`
      + '（这就是"刷新后数据没了"的直接凶手，下面这行调用栈就是它）\n'
      + String(new Error('empty-write-trace').stack || '').split('\n').slice(1, 8).join('\n'),
    );
  },

  /**
   * 推送到云端的唯一出口。
   * ⛔ 云端之所以会被洗成 0 条，绝大多数是"某个页面内存里恰好是空快照，又把它整体写回去了"。
   *    所以这里设一道闸门：本机这份运动会数据是空的，一律不许推，也不许反复重试。
   *    唯一例外 options.allowEmpty —— 用户在界面上亲手点的清空 / 删除（writeCritical force）。
   */
  async _persist(key, value, options = {}) {
    // ⏸ 暂停期间不往云端推任何东西（强行恢复后想推，请先 window.resumeCloud()）
    if (this._cloudPaused) return false;
    if (this._isMeetKey(key) && !this._hasContent(key, value) && options.allowEmpty !== true) {
      const pending = this._pendingWrites.get(key);
      if (!pending || pending.clear !== true) {
        console.warn(`[Store] ⛔ 本机 ${key} 是空的，已拦下这次云端推送`
          + '（要在云端清空请走界面上的「清空数据」，否则一次误写就会把云端 216 条洗成 0 条）');
        this._clearUnconfirmed(key);      // 连同已放飞的重试一起作废，别让它无限续传
        const timer = this._criticalTimers.get(key);
        if (timer) { clearTimeout(timer); this._criticalTimers.delete(key); }
      }
      return false;
    }
    // 写入同样带超时：网络挂起时不会一直 pending，失败会进入待写队列
    await this._fetchJSON('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    return true;
  },

  /**
   * 补推之前失败的写入。只补推"新鲜"的那部分——
   * 过期的已经在 _dropStalePending 里丢掉，绝不会把本地旧数据推上去覆盖云端
   */
  async _flushPending() {
    if (!this._pendingWrites.size) return;
    for (const [key, entry] of [...this._pendingWrites]) {
      try {
        const sent = await this._persist(key, entry.value, { allowEmpty: entry.clear === true });
        if (sent === false) continue;      // 空数据被拦下，锁已在闸门里交出
        this._clearUnconfirmed(key);
        console.log(`[Store] 已补推 ${key} 到云端`);
      } catch (error) {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastError = error?.message || String(error);
        this._writeLock(key, entry);
        console.warn(`[Store] 补推 ${key} 仍未成功（第 ${entry.attempts} 次），数据保留在本地`, error);
        // 重要表单：继续排后台续传，绝不因为补推失败就丢
        if (entry.critical) this._scheduleCriticalRetry(key);
      }
    }
  },

  /**
   * 一键清空本次运动会：报名 / 预分组 / 赛程 / 成绩排名 / 项目库 / 标题 全部连根拔起。
   * 1) localStorage removeItem 洗地（含 __local_backup 备份键，避免回滚复活旧数据）
   * 2) 内存缓存 + 待写队列清空（否则断网期间的失败写入会在下次联网时把旧数据补推回云端）
   * 3) 云端按表 DELETE（/api/data { op:'purge', scope:'meet' }）；失败就退化为逐键写 null
   * @returns {Promise<{ok:boolean, mode:string, clearedKeys:string[], cloud:Array, error?:string}>}
   */
  async purgeMeetData() {
    const clearedKeys = [];
    // 世代号 +1：作废所有还在飞的同步结果，免得清空完又被旧数据复活
    this._purgeEpoch += 1;
    this._purgeEpochSeen = this._purgeEpoch;
    const purgeSignal = JSON.stringify({ epoch: this._purgeEpoch, at: Date.now() });
    /* 世代号同时落到 localStorage：这是给兄弟 iframe 看的"明确的清空指令"。
       没有它，兄弟页面会把这次清空当成"对方还在初始化、手上正好是空快照"，
       按防污染规则无视掉 —— 用户眼里就是"点了清空，隔壁 Tab 数据还在"。 */
    try { localStorage.setItem(MEET_PURGE_EPOCH_KEY, purgeSignal); } catch (error) { /* 忽略 */ }
    /* 时光机备份（含按存储键分槽的每一份）一起删，否则"一键清空"之后数据又从备份里长回来 */
    try {
      const backupKeys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(MEET_BACKUP_KEY)) backupKeys.push(key);
      }
      backupKeys.forEach(key => localStorage.removeItem(key));
    } catch (error) { /* 忽略 */ }
    MEET_DATA_KEYS.forEach(key => {
      try {
        localStorage.removeItem(key);
        localStorage.removeItem(`${key}__local_backup`);
        clearedKeys.push(key);
      } catch (error) {
        console.warn(`[Store] 清空本地键失败：${key}`, error);
      }
    });
    // 兜底：历史遗留的同前缀键也一并清掉
    try {
      /* ⚠️ 先快照键名再删：边遍历 localStorage.length 边 removeItem 会让索引错位、
         漏删一半（时光机备份就是这么"清空了又活过来"的）。 */
      const staleKeys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && /^pe_sports_meet|^pe_meet_template|^sportsMeet/i.test(key)) staleKeys.push(key);
      }
      staleKeys.forEach(key => {
        localStorage.removeItem(key);
        if (!clearedKeys.includes(key)) clearedKeys.push(key);
      });
    } catch (error) {
      console.warn('[Store] 枚举本地键失败', error);
    }

    // 内存缓存与待写队列同步清理（只动运动会相关的键，别误伤其他模块）
    MEET_DATA_KEYS.forEach(key => {
      this.cache.delete(key);
      this._clearUnconfirmed(key);
      const timer = this._criticalTimers.get(key);
      if (timer) { clearTimeout(timer); this._criticalTimers.delete(key); }
    });

    let cloud = [];
    let error = null;
    if (this.cloudState !== 'off') {
      try {
        const result = await this._fetchJSON('/api/data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'purge', scope: 'meet', keys: MEET_DATA_KEYS }),
        });
        cloud = result?.report || [];
      } catch (purgeError) {
        // 老服务端没有 purge 分支：退化为逐键写 null（单例键写 null = 删行）
        console.warn('[Store] 服务端不支持 purge，退化为逐键清空', purgeError);
        for (const key of MEET_DATA_KEYS) {
          try {
            await this._persist(key, null, { allowEmpty: true });
            cloud.push({ key, status: 'ok', fallback: true });
          } catch (singleError) {
            error = singleError?.message || String(singleError);
            cloud.push({ key, status: 'error', message: error });
          }
        }
      }
    }
    this._dispatchSync(clearedKeys, { reason: 'purgeMeetData' });
    return {
      ok: !error,
      mode: this.mode,
      clearedKeys,
      cloud,
      error: error || undefined,
    };
  },

  /** 待写队列现状（排障用） */
  getPendingWrites() {
    return [...this._pendingWrites].map(([key, entry]) => ({
      key,
      at: entry.at,
      ageSeconds: Math.round((Date.now() - entry.at) / 1000),
      critical: Boolean(entry.critical),
      attempts: entry.attempts || 0,
      value: entry.value,
    }));
  },

  /** 手动重试所有未确认写入（「重试同步」按钮用） */
  async retryPendingWrites() {
    await this._flushPending();
    return this.getPendingWrites();
  },

  /** 清空待写队列（forceSyncCloud 会调用，避免旧数据被补推） */
  clearPendingWrites() {
    const count = this._pendingWrites.size;
    // 逐键解除（只删本实例这些键的锁，其它页面/其它键的锁不动）
    [...this._pendingWrites.keys()].forEach(key => this._clearUnconfirmed(key));
    this._pendingWrites.clear();
    this._criticalTimers.forEach(timer => clearTimeout(timer));
    this._criticalTimers.clear();
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
      + '<div id="store-loading-text">正在从云端同步数据…</div>'
      + '<style>@keyframes store-spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(node);
    this._loadingNode = node;

    // 超过 6 秒还没回来，提示是服务端冷启动，避免用户以为卡死（超时上限 20 秒）
    this._slowHintTimer = setTimeout(() => {
      const text = typeof document.getElementById === 'function'
        ? document.getElementById('store-loading-text')
        : null;
      if (text) text.textContent = '云端服务正在启动（首次访问可能稍慢，最多等待 20 秒）…';
    }, SLOW_HINT_DELAY);
  },

  _hideLoading() {
    if (this._slowHintTimer) {
      clearTimeout(this._slowHintTimer);
      this._slowHintTimer = null;
    }
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

    // 占用 syncing 标记：避免同时还有一条后台 sync 在跑（请求本身也已串行）
    this.syncing = true;
    let result;
    try {
      result = await this._syncWithRetry({ silent: true });
    } finally {
      this.syncing = false;
    }
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

  /* ---------------- 排障 / 强行恢复（控制台入口） ---------------- */

  /** 删掉盘上所有「未确认」保护锁（暂停云端时用，免得残留的锁挡住恢复后的写入） */
  _clearLocksFromStorage() {
    let removed = 0;
    try {
      const lockKeys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(UNCONFIRMED_LOCK_PREFIX)) lockKeys.push(key);
      }
      lockKeys.forEach(key => { localStorage.removeItem(key); removed += 1; });
    } catch (error) { /* 忽略 */ }
    return removed;
  },

  /**
   * ⏸ 暂停一切云端同步（控制台：window.pauseCloud()）
   * 停掉重连定时器 / 续传定时器、清空待写队列与盘上的锁；此后 sync() 与 _applyCloud() 空转，
   * 云端那份 0 条再也碰不到本地。本地读写照常工作。
   */
  pauseCloud(reason = 'manual') {
    this._cloudPaused = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._criticalTimers.forEach(timer => clearTimeout(timer));
    this._criticalTimers.clear();
    this._pendingWrites.clear();
    const locks = this._clearLocksFromStorage();
    console.warn(`[Store] ⏸ 已暂停全部云端同步（原因：${reason}，清掉 ${locks} 个保护锁）。`
      + '恢复用 window.resumeCloud()');
    return { ok: true, paused: true, clearedLocks: locks };
  },

  /** ▶ 恢复云端同步（可选立刻同步一次） */
  resumeCloud({ syncNow = false } = {}) {
    this._cloudPaused = false;
    console.log('[Store] ▶ 云端同步已恢复');
    if (syncNow) return this.sync();
    return { ok: true, paused: false };
  },

  /** 遍历顶层窗口 + 所有同源 iframe 的 window（跨域的直接跳过） */
  _forEachDocumentWindow(callback) {
    const seen = new Set();
    const visit = win => {
      if (!win || seen.has(win)) return;
      seen.add(win);
      try { callback(win); } catch (error) { /* 跨域忽略 */ }
      let frames = null;
      try { frames = win.frames; } catch (error) { return; }
      if (!frames) return;
      for (let i = 0; i < frames.length; i += 1) {
        let frame = null;
        try { frame = frames[i]; } catch (error) { frame = null; }
        if (frame) visit(frame);
      }
    };
    if (typeof window === 'undefined') return;
    visit(window);
    try { if (window.parent && window.parent !== window) visit(window.parent); } catch (error) { /* 忽略 */ }
    try { if (window.top && window.top !== window) visit(window.top); } catch (error) { /* 忽略 */ }
  },

  /**
   * 🚨 终极强行恢复（控制台：window.forceRecover()）
   * ① 先暂停所有云端同步 —— 云端那份 0 条再也碰不到本地；
   * ② 强行把「时光机备份」写进主键（内存缓存 + localStorage 一起写）；
   * ③ 立刻在【本窗口 + 每一个 iframe + 父/顶层窗口】派发 store:sync，
   *    让所有页面当场重绘（报名页 / 赛程页 / 成绩页 一起）。
   *
   * @param {{keys?:string[], pushCloud?:boolean, broadcast?:boolean}} options
   *        pushCloud=true  恢复后立刻把这份数据反推回云端（默认 false：先保住本地，云端单独修）
   *        broadcast=true  把恢复动作广播到每一个同源 iframe（默认 true）
   * @returns {{ok:boolean, restored:Array<{key:string,count:number,savedAt:number}>, missing:string[]}}
   */
  forceRecover(options = {}) {
    const keys = options.keys || MEET_DATA_KEYS.filter(key => this._isMeetKey(key));
    if (options.pauseCloud !== false) this.pauseCloud('forceRecover');
    const restored = [];
    const missing = [];
    keys.forEach(key => {
      const slot = this._readBackupSlot(key);
      if (!slot || !this._hasContent(key, slot.data)) { missing.push(key); return; }
      const data = slot.data;
      this.cache.set(key, data);
      this._localWrites.add(key);
      try { localStorage.setItem(key, JSON.stringify(data)); } catch (error) {
        console.warn(`[Store] 恢复 ${key} 写盘失败`, error);
      }
      // 顺手刷新备份，保证时光机里存的就是刚恢复出来的这份
      this._updateBackup(key, data, {});
      restored.push({ key, count: this._countOf(data), savedAt: slot.savedAt || 0 });
    });

    const detail = { restored, missing, at: Date.now(), reason: 'forceRecover' };
    const changed = restored.map(item => item.key);
    // 本窗口（父 / 顶层由 _dispatchSync 顺带转发）
    this._dispatchSync(changed, { restored: true, forced: true, reason: 'forceRecover' });

    if (options.broadcast !== false) {
      /* iframe 之间是隔离的：往 parent / top 派发，兄弟 iframe 一个也收不到。
         所以这里逐个 iframe 上门：让它们各自恢复缓存，并在各自窗口里派发事件触发重绘。 */
      this._forEachDocumentWindow(win => {
        if (win === window) return;
        try {
          if (win.Store && typeof win.Store.forceRecover === 'function') {
            win.Store.forceRecover({ keys, broadcast: false, pauseCloud: options.pauseCloud !== false });
          }
          const Ctor = typeof win.CustomEvent === 'function' ? win.CustomEvent : CustomEvent;
          win.dispatchEvent(new Ctor('store:sync', {
            detail: { mode: this.mode, changed, at: Date.now(), restored: true, forced: true, reason: 'forceRecover' },
          }));
          win.dispatchEvent(new Ctor('store:recovered', { detail }));
        } catch (error) { /* 跨域忽略 */ }
      });
    }
    try {
      window.dispatchEvent(new CustomEvent('store:recovered', { detail }));
    } catch (error) { /* 忽略 */ }

    if (options.pushCloud && restored.length) {
      this.resumeCloud();
      restored.forEach(item => this._pushBackToCloud(item.key, this.cache.get(item.key)));
    }
    const summary = restored.map(item => `${item.key}=${item.count}条`).join('、');
    console.warn(`[Store] 🚨 forceRecover 完成：${summary || '没有任何备份可用'}`);
    if (missing.length) console.warn(`[Store] ⚠ 这些键没有可用备份：${missing.join('、')}`);
    return { ok: restored.length > 0, restored, missing };
  },

  /**
   * 排障用：把「时光机备份」的家底全列出来（控制台：window.peekBackup()）
   * 一眼看清备份里到底有没有那 216 条、是什么时候存的、主数据现在又是几条。
   */
  peekBackup() {
    const rows = MEET_DATA_KEYS.filter(key => this._isMeetKey(key)).map(key => {
      const slot = this._readBackupSlot(key);
      const current = this._readLocalValue(key);
      return {
        key,
        backupCount: slot ? this._countOf(slot.data) : 0,
        backupSavedAt: slot?.savedAt ? new Date(slot.savedAt).toLocaleString('zh-CN') : '（无备份）',
        currentCount: this._countOf(current),
        hasContent: this._hasContent(key, current),
      };
    });
    const raw = { rows, mainKey: MEET_MAIN_KEY, cloudPaused: this._cloudPaused };
    console.table ? console.table(rows) : console.log(rows);
    return raw;
  },

  /** 只把本地这份推回云端（forceRecover 之后单独修云端用：window.pushLocalToCloud()） */
  pushLocalToCloud(keys = MEET_DATA_KEYS.filter(key => this._isMeetKey(key))) {
    this.resumeCloud();
    const pushed = [];
    keys.forEach(key => {
      const value = this._readLocalValue(key);
      if (!this._hasContent(key, value)) return;      // 本地也是空的，绝不推（不污染云端）
      this._pushBackToCloud(key, value);
      pushed.push(key);
    });
    console.log(`[Store] 📤 已把本地数据推回云端：${pushed.join('、') || '（本地没有非空数据，未推送）'}`);
    return { ok: pushed.length > 0, pushed };
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
  /* 🚨 数据被洗成 0 条时的急救入口（每个 iframe 的控制台都能敲）：
       forceRecover()        暂停云端 + 用时光机备份强行恢复主数据 + 所有页面立刻重绘
       forceRecover({pushCloud: true})  恢复完顺便把这份数据推回云端，把云端 0 条修好
       pauseCloud() / resumeCloud()     手动暂停 / 恢复云端同步
       pushLocalToCloud()    只把本地这份推回云端
       peekBackup()          看看时光机里到底存了多少条 */
  window.storeBuild = STORE_BUILD;
  window.forceRecover = options => Store.forceRecover(options || {});
  window.pauseCloud = () => Store.pauseCloud('console');
  window.resumeCloud = () => Store.resumeCloud();
  window.pushLocalToCloud = () => Store.pushLocalToCloud();
  window.peekBackup = () => Store.peekBackup();
}
