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
  // 离线资源库：本地优先读写，联网时同步到 Supabase offline_resources 表
  'pe_offline_resources_v1',
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

/** 大单元设计主键 */
const UNIT_DESIGN_KEY = 'pe_big_unit_design_v1';
/** 大单元「核心模块」字段：云端少任何一个、本地却有内容 → 绝不允许覆盖 */
const UNIT_DESIGN_CORE_FIELDS = [
  'objectives', 'textbookAnalysis', 'studentAnalysis', 'teachingContent',
  'keyDifficulties', 'structure_nodes', 'main_projects', 'lessons',
  'assessment', 'reflection', 'rubric',
];
/** 生成期间的全局冻结信号（写进 localStorage，所有同源页面 / iframe 都认） */
const UNIT_GENERATING_KEY = 'pe_unit_generating_v1';
/** 冻结信号的有效期：生成再慢也不会超过它；页面崩溃后到点自动解冻，绝不永久卡死 */
const UNIT_GENERATING_TTL_MS = 60 * 60 * 1000;

/**
 * 版本标记：排障第一步就是在控制台确认浏览器跑的是不是这一版。
 * ⚠️ 老版本（没有时光机备份 / 云端 0 条防污染 / forceRecover）会把云端返回的 null 直接写回
 *    localStorage，表现就是"刷新一下主键立刻变 0 条"，日志还会打"本次无差异"。
 *    如果你的控制台里看不到下面这行，说明浏览器还在用缓存里的旧 store.js —— 先硬刷（Cmd+Shift+R）。
 */
const STORE_BUILD = 'v9-终极清理 hardResetAll + 视图优先级锁 2026-11-06';
/**
 * 「静默本地模式」持续时间：载入离线资源等纯本地操作期间，
 * 不发 GET、不重连、云端失败也不弹超时，时间一到自动恢复（无需定时器，惰性判断）。
 */
const QUIET_LOCAL_MS = 10000;

/**
 * 网络不通类错误：断网 / DNS / 连接被拒 / 超时 / 后端写 Supabase 的 `fetch failed`。
 * 这类不是「表结构冲突」等业务错误 —— 不弹红色弹窗、不计入熔断次数，
 * 数据只要安静留在本地待写队列，联网后自动续传即可。
 */
function isNetworkFailure(error) {
  if (!error) return false;
  if (error.networkFailure === true || error.timeout === true) return true;
  if (error.name === 'AbortError' || error.name === 'StoreRequestTimeout'
    || error.name === 'SupabaseReadTimeout') return true;
  const message = String(error.message || error || '').toLowerCase();
  return /fetch failed|failed to fetch|networkerror|network error|load failed|signal is aborted|超时|timed?\s*out|econn|enotfound|eai_again|socket hang up|连接被|放弃本次读取|不可达/.test(message);
}

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

/**
 * ⛔ 同一个键连续写云端失败多少次就熔断（停止重试）。
 * 3 次足够区分"网络抖一下"和"表结构冲突 / 主键冲突"这类硬错误 ——
 * 后者再重试一百次也一样失败，只会把请求队列刷满。
 */
const MAX_PERSIST_ATTEMPTS = 3;
/**
 * 「清空指令」的有效期（毫秒）。
 * ⛔ 为什么必须有：清空意图会被写进保护锁留在 localStorage 里。
 *    没有有效期的话，手机上几个月前的一次删除留下的"清空锁"，
 *    会在某一次刷新时突然生效 → 把云端当天的教案删光。
 *    现在超过这个时间就算过期，绝不再执行。
 */
const CLEAR_LOCK_TTL_MS = 10 * 60 * 1000;
/**
 * 「清空已确认」后的沉降期（毫秒）。
 * 云端确认删干净之后仍留一小段沉降期：万一还有一发"清空之前发出、清空之后才回来"
 * 的同步结果，它带着旧数据回来也不会被复活到本地。
 */
const CLEAR_SETTLE_MS = 10000;
// 重要表单云端确认失败后的后台续传节奏（毫秒）：仅网络正常时使用
const CRITICAL_RETRY_DELAYS = [1500, 5000, 15000, 30000];
/**
 * 🌐 断网退避：判定网络不通后，所有后台续传 / 重连统一拉长到 1 分钟一次。
 * 断网时 1.5s→5s→15s 的短节奏会在几分钟内打出几十发请求，把本地 Node 服务器卡死。
 */
const OFFLINE_RETRY_MS = 60000;
/** 连续多少次网络失败才显示「离线模式」标签（一次抖动不打扰用户） */
const OFFLINE_BADGE_THRESHOLD = 2;
/**
 * 「本地已写入、云端未确认」保护锁的前缀：刷新后靠它挡住云端旧数据覆盖。
 * ⚠️ 每个存储键一条独立记录（前缀 + 键名），不是整体一个 JSON ——
 *    多个 iframe / 标签页共享同一份 localStorage，整体覆盖会让别人的锁被空队列抹掉。
 */
const UNCONFIRMED_LOCK_PREFIX = 'pe_store_unconfirmed_v1::';
/**
 * 🔒 「视图优先级锁」：用户主动点击【从离线资源库加载】之后，刚载入的这份数据就是
 *    当前视图的唯一可信副本，优先级高于云端旧快照、后台同步队列、其它 iframe 的旧缓存。
 *    锁只存摘要（epoch / at / reason），真正的数据仍在主键里；摘要落到 localStorage，
 *    刷新后同域页面都能认得，直到 TTL 到期或用户手动解除。
 */
const VIEW_PIN_KEY = 'pe_store_view_pin_v1';
/** 视图优先级锁有效期：30 分钟后自动放行云端同步，不会把某个键永久冻住 */
const VIEW_PIN_TTL_MS = 30 * 60 * 1000;
/** 视图优先级锁生效期间挂上的后台推送暂停原因（online 事件 / 解除锁时释放） */
const VIEW_PIN_PUSH_HOLD = '视图优先级锁：等待用户确认';
/** 管理员登录凭据：hardResetAll() 默认保留，传 { includeAuth: true } 才一起清 */
const HARD_RESET_AUTH_KEYS = ['isAdmin', 'pe_admin_password'];
/** 兜底前缀（pe_ / sportsMeet*）覆盖不到的零散键 */
const HARD_RESET_MISC_KEYS = ['meetPurgeNotice'];
/**
 * localhost 开发环境：启动时盘上残留的保护锁（= 刷新后要重推的待写队列）超过这个数量，
 * 一律判定为「旧 502 反复失败留下的脏队列」，直接清空，不再自动补推。
 * 这些锁的业务数据本身仍在 localStorage 主键里，清的只是「后台重推」这件事。
 */
const LOCAL_QUEUE_DIRTY_LIMIT = 10;
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
 * 🕒 时光机备份的格式版本与有效期。
 * ⛔ 旧备份会「反噬」：清空主键后刷新，_restoreFromBackup() 不分青红皂白把几天前的
 *    181KB 旧报名数据塞回去，直接盖掉用户刚载入的新数据。
 *    现在：备份必须带合法时间戳、结构必须匹配、版本必须一致，且不超过 24 小时；
 *    不合格的一律【删掉备份键】并拒绝恢复。
 */
const BACKUP_SCHEMA_VERSION = 2;
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** __local_backup 一次性快照的元数据：没有时间戳 / 超期 → 启动时整批清掉 */
const LOCAL_BACKUP_META_KEY = 'pe_store_local_backup_meta_v1';
/** 单个 __local_backup 的体积上限：超大的资源库镜像不再复制一份 */
const LOCAL_BACKUP_MAX_BYTES = 256 * 1024;
/** 视图优先级锁摘要的格式版本 */
const VIEW_PIN_SCHEMA_VERSION = 2;
/**
 * 「一键清空」意图的跨文档通道。
 * 兄弟 iframe 收到"主数据被清空"的消息时，必须能区分两件事：
 *   ① 用户在别的页面亲手点了「一键清空」→ 必须跟着清空（否则清空了又被老数据复活）；
 *   ② 兄弟页面自己也在启动中、手上恰好是空快照 → 必须无视（否则就是"刷新一下数据没了"）。
 * 世代号落地到 localStorage 就是为了做这个区分，它本身不是业务数据键。
 *
 * ⚠️ 键名沿用旧的 pe_meet_purge_epoch_v1 —— 正在运行的旧标签页只认这个键，
 *    换名字它们就收不到清空指令了。
 * ⚠️ 载荷里多了 keys 清单：清空不再只是"某个键"，而是"明确点名要清哪些键"，
 *    兄弟页面照单全收（老版本没有这个字段时，退回到"清空触发 storage 事件的那个键"）。
 */
const PURGE_SIGNAL_KEY = 'pe_meet_purge_epoch_v1';
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
  // 被熔断的键（连续写云端失败超过 MAX_PERSIST_ATTEMPTS 次）：key → { attempts, lastError, at, value }
  // 这些键【不再重试】，但依然受保护：云端的空数据 / 旧数据都覆盖不到它们。
  _failedWrites: new Map(),
  // ⛔ 纯拉取模式（pullCloudOnly）：为 true 时【一个 POST 都不发】，
  //    只允许把云端数据拉到本地。这是手机端"只读同步"的保险丝。
  _readOnlyPull: false,
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
  /**
   * 正在清空流程中的键：key → { at, confirmedAt }
   * ⛔ 这是"用户亲手清空"必须绝对可靠的关键闸门：
   *    清空期间云端回来的旧数据一律【不复活到本地】，也不会触发"反推自愈"
   *    （把本地这份反推回云端）。否则云端清空失败或慢半拍时，
   *    旧数据会一路复活回来 —— 那正是这次要根治的毛病。
   */
  _pendingClearKeys: new Map(),
  // 清空云端失败后的后台补清定时器：key → timer
  _clearRetryTimers: new Map(),
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
  // 「大单元生成中」：本页在生成时置 true，同时往 localStorage 写信号冻结所有同源文档
  _generating: false,
  /**
   * 后台上传重试的「暂停原因」集合（支持多个原因叠加，A 恢复不会误放 B）。
   * 非空时：刷新恢复的待写队列、后台续传、_flushPending 补推一律不发 POST，
   * 只保留本地数据与保护锁。生成大单元 / 从离线资源库载入时由调用方挂上。
   */
  _backgroundSyncHolds: new Set(),
  /** 当前在飞的 GET 请求控制器：进入静默本地模式时逐个 abort，立刻掐断后台同步 */
  _inFlightReads: new Set(),
  /** 静默本地模式截止时间戳 / 原因 / 对应的暂停 hold 键 */
  _quietLocalUntil: 0,
  _quietReason: '',
  _quietHoldKey: '',
  /** 连续网络失败计数 / 是否已进入离线模式（供顶栏灰色标签读取） */
  _networkFailures: 0,
  _offlineMode: false,
  _offlineSince: 0,
  /**
   * 🌐 延期区：加载离线资源时从「自动重推队列」隔离出来的历史脏数据。
   * 业务数据与 localStorage 保护锁都完整保留，只是不参与任何后台 POST；
   * 网络恢复（online 事件 / Store.handleOnline()）后自动放回 _pendingWrites。
   */
  _deferredWrites: new Map(),
  /**
   * 🔒 视图优先级锁：key → { epoch, at, reason }。
   * 用户主动载入离线资源后用。有锁的键：内存缓存 / localStorage 主键一律以刚载入的
   * 那份为准，_applyCloud、_mirrorLocal、storage 事件、历史保护锁、后台补推全部绕开它。
   */
  _viewPins: new Map(),
  _viewPinEpoch: 0,

  async start() {
    console.log(`[Store] 载入 store.js ${STORE_BUILD}`);
    this._bindCrossDocumentSync();
    // 先认下当前世代号：之后 storage 事件里只要世代号前进了，就说明别人执行了明确的一键清空
    this._purgeEpochSeen = this._storedPurgeSignal().epoch;
    const hasCache = this._loadLocal();
    /* 🧹 启动就清掉历史遗留 / 超期的 __local_backup 镜像，别让它们无限期堆积 */
    this._clearStaleLocalBackups();
    /* ① 启动第一原则：无条件检查备份。
       只要主键是空的，立刻【同步】从 pe_sports_meet_backup_v1 拉数据覆盖主键，
       不等云端、不看差异、不看有没有缓存 —— 这是备份存在的唯一意义。
       恢复成功就立刻派发 store:sync，让页面马上用 216 条重绘。 */
    const restored = this._restoreFromBackup({ reason: 'start() 启动' });
    /* 🔒 「用户主动载入的资源」优先于一切备份 / 旧缓存：
       恢复视图优先级锁，把主键那份（就是刚载入的资源）重新压回内存缓存，
       并拔掉这些键的历史保护锁。必须排在 _restoreUnconfirmed() 前面。 */
    this._restoreViewPins();
    /* 🧹 localhost：先按【盘上锁的数量】清掉旧 502 留下的脏待写队列。
       必须在 _restoreUnconfirmed() 之前做 —— 否则刚清完内存，锁又被扫回来重新排续传。
       业务数据留在 localStorage 主键里，这里只丢「后台自动重推」这件事。 */
    this._autoClearDirtyQueue();
    // 刷新后接续：把上一次「已写入本地、云端未确认」的标记恢复回来，
    // 否则新页面一同步，云端旧数据就会把用户刚保存的数据冲掉
    this._restoreUnconfirmed();
    /* 注册 online 自愈：网络恢复后把延期隔离的历史队列放回并重新排续传 */
    this._bindOnlineRecovery();
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

  /**
   * 「生成期间全局冻结同步」开关。
   * 从点【一键生成】到流水线跑完，后台 SWR / 重连 / 兄弟 iframe 的同步都不许拉云端，
   * 否则云端那份旧的（缺模块 4/5/6 的）大单元会把刚生成的模块整份盖掉。
   * 信号写进 localStorage 是让【所有同源文档】一起冻结（不只是当前这一页）。
   */
  setGenerating(active, reason = '') {
    this._generating = active === true;
    try {
      if (this._generating) {
        localStorage.setItem(UNIT_GENERATING_KEY, JSON.stringify({
          active: true, at: Date.now(), reason, ttl: UNIT_GENERATING_TTL_MS,
        }));
      } else {
        localStorage.removeItem(UNIT_GENERATING_KEY);
      }
    } catch (error) {
      console.warn('[Store] 写入生成冻结信号失败', error);
    }
    /* ⏸ 生成期间把「后台补推 / 断点续传」也一起停：它们同样会 POST /api/data，
       和 SSE 生成抢同一个串行请求闸门，前一手卡住就会连锁超时（signal is aborted）。
       队列与保护锁原样保留，流水线结束后再重新排队续传，不丢数据。 */
    if (this._generating) this._pauseCriticalTimers();
    else this._resumeBackgroundPushes();
    console.log(`[Store] ${this._generating ? '⏸ 大单元生成中：已冻结全部云端同步与后台补推' : '▶ 生成结束：恢复云端同步与后台补推'}${reason ? `（${reason}）` : ''}`);
    return this._generating;
  },

  /** 本页或任一同源页面是否正在生成（带 TTL，页面崩溃也不会永久冻结） */
  isGenerating() {
    if (this._generating) return true;
    try {
      const raw = localStorage.getItem(UNIT_GENERATING_KEY);
      if (!raw) return false;
      const flag = JSON.parse(raw);
      if (flag?.active !== true) return false;
      const ttl = Number(flag.ttl) > 0 ? Number(flag.ttl) : UNIT_GENERATING_TTL_MS;
      if (Date.now() - Number(flag.at || 0) > ttl) {
        localStorage.removeItem(UNIT_GENERATING_KEY);       // 过期信号自动清理
        return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  },

  /* ---------------- 静默本地模式（纯本地操作的绝对隔离） ---------------- */

  /** 是否处于静默本地模式；到期自动解除（惰性判断，不留定时器） */
  isQuietLocalMode() {
    if (this._quietLocalUntil && Date.now() >= this._quietLocalUntil) this.exitQuietLocalMode();
    return this._quietLocalUntil > 0;
  },

  /**
   * 🤫 进入静默本地模式：载入离线资源等纯本地操作的「绝对隔离」。
   * ① 立刻 abort 所有在飞的 GET /api/data（不等 20 秒超时）
   * ② 停掉重连定时器与后台续传
   * ③ 期间 sync / _syncOnce / 补推一律不发请求，云端失败也安静回退本地缓存
   * ④ 到期自动恢复，无需调用方记得解锁
   */
  enterQuietLocalMode(reason = '本地操作', durationMs = QUIET_LOCAL_MS) {
    if (this._quietHoldKey) this._backgroundSyncHolds.delete(this._quietHoldKey);
    this._quietLocalUntil = Date.now() + Math.max(0, durationMs);
    this._quietReason = reason;
    this._quietHoldKey = `静默本地模式：${reason}`;
    this._backgroundSyncHolds.add(this._quietHoldKey);
    this._pauseCriticalTimers();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const aborted = this.abortInFlightReads(reason);
    console.log(`[Store] 🤫 静默本地模式（${reason}）：取消 ${aborted} 个在飞 GET，`
      + `${Math.round(durationMs / 1000)} 秒内不发云端请求、不报超时，数据全部走本地缓存`);
    return { ok: true, aborted, until: this._quietLocalUntil };
  },

  exitQuietLocalMode() {
    if (!this._quietLocalUntil && !this._quietHoldKey) return;
    if (this._quietHoldKey) this._backgroundSyncHolds.delete(this._quietHoldKey);
    this._quietHoldKey = '';
    this._quietLocalUntil = 0;
    this._quietReason = '';
    // 解冻后把暂停期间挂起的队列重新排队（延期区的数据不动，等 online 事件）
    this._resumeBackgroundPushes();
  },

  /** 立刻掐断所有在飞的 GET（POST 不动：正在写的数据不能半途打断） */
  abortInFlightReads(reason = '') {
    let count = 0;
    this._inFlightReads.forEach(controller => {
      try { controller.abort(); count += 1; } catch (error) { /* 忽略 */ }
    });
    this._inFlightReads.clear();
    return count;
  },

  /* ---------------- 🔒 视图优先级锁（用户主动载入的数据最高优先） ---------------- */

  /** 清掉过期锁；返回仍生效的锁数量 */
  _expireViewPins() {
    let expired = 0;
    for (const [key, pin] of [...this._viewPins]) {
      /* userModified 是用户亲手载入的最高级别标记：不因时间过期，
         只有 clearViewPins() / hardResetAll() / nukeAllStorage() / 亲手清空才解除。 */
      if (pin && (pin.userModified === true
        || Date.now() - Number(pin.at || 0) <= VIEW_PIN_TTL_MS)) continue;
      this._viewPins.delete(key);
      expired += 1;
    }
    if (expired) {
      this._persistViewPins();
      console.log(`[Store] 🔒 ${expired} 个视图优先级锁已到期，恢复正常云端同步`);
    }
    if (!this._viewPins.size) {
      /* 最后一个锁到期：解除后台暂停并重排被挂起的续传，别把其它表单的写入永久冻住 */
      if (expired) this._releaseViewPinHold();
      else this._backgroundSyncHolds.delete(VIEW_PIN_PUSH_HOLD);
    }
    return this._viewPins.size;
  },

  /** 这个键正被「用户主动载入」的视图优先级锁保护？ */
  isViewPinned(key) {
    if (!this._viewPins.has(key)) return false;
    this._expireViewPins();
    return this._viewPins.has(key);
  },

  /** 用户亲手载入的最高级别标记：刷新后备份 / 云端一律不许覆盖 */
  isUserModified(key) {
    return this.isViewPinned(key) && this._viewPins.get(key)?.userModified === true;
  },

  /** 排障：列出所有带 userModified 标记的键 */
  getUserModifiedKeys() {
    return [...this._viewPins.entries()]
      .filter(([, pin]) => pin?.userModified === true)
      .map(([key]) => key);
  },

  /** 当前是否存在任一视图优先级锁（供离线资源库跳过 store:sync 对账） */
  hasViewPin() {
    return this._expireViewPins() > 0;
  },

  /**
   * 🔒 把用户刚载入的数据钉成当前视图的最高优先级。
   * ① 该键的历史待写队列 / 续传定时器 / 保护锁 / 熔断 / 清空标记全部拔掉；
   * ② 内存缓存 + localStorage 主键立刻写成这份新数据（不推云端）；
   * ③ 挂上后台推送暂停，旧队列一条 POST 都发不出去；
   * ④ 摘要持久化，刷新后所有同源页面继续认这份数据。
   */
  pinLocalView(key, value, reason = '用户主动载入本地数据', options = {}) {
    if (!STORE_KEYS.includes(key)) return { ok: false, reason: `未知存储键 ${key}` };
    /* 🔒 userModified=true：用户亲手载入的数据，最高级别标记。
       刷新后不被 TTL 淘汰，任何备份 / 云端都不许覆盖（直到手动解除或终极清理）。 */
    const userModified = options.userModified === true;
    this._expireViewPins();
    const criticalTimer = this._criticalTimers.get(key);
    if (criticalTimer) { clearTimeout(criticalTimer); this._criticalTimers.delete(key); }
    const clearTimer = this._clearRetryTimers.get(key);
    if (clearTimer) { clearTimeout(clearTimer); this._clearRetryTimers.delete(key); }
    this._pendingWrites.delete(key);
    this._failedWrites.delete(key);
    this._deferredWrites.delete(key);
    this._pendingClearKeys.delete(key);
    this._localWrites.delete(key);
    try { localStorage.removeItem(this._lockKeyOf(key)); } catch (error) { /* 忽略 */ }
    this.cache.set(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) {
      console.warn(`[Store] 🔒 写入视图数据失败：${key}`, error);
    }
    const epoch = ++this._viewPinEpoch;
    this._viewPins.set(key, {
      epoch, at: Date.now(), reason, userModified, version: VIEW_PIN_SCHEMA_VERSION,
    });
    this._persistViewPins();
    this._backgroundSyncHolds.add(VIEW_PIN_PUSH_HOLD);
    this._pauseCriticalTimers();
    console.log(`[Store] 🔒 视图优先级锁 #${epoch}（${reason}）：${key} 以刚载入的数据为最高优先级`
      + `${userModified ? '，已打上 userModified:true（刷新后备份与云端都不许覆盖）' : ''}`
      + '；解除用 Store.clearViewPins()');
    return { ok: true, epoch, key, userModified };
  },

  /**
   * ✅ 保存成功后把当前视图的最新值【硬写】进内存缓存 + localStorage 主键。
   * 不走 write() 的合并 / 未确认锁 / 云端推送，也不派发 store:sync ——
   * 保证下一次 read()（尤其是切回页面重新初始化时）读到的绝对是这一版。
   * 🔒 同时让视图优先级锁继续保持锁定：保存成功绝不解锁，切页时任何后台同步都盖不掉。
   */
  commitView(key, value, options = {}) {
    if (!STORE_KEYS.includes(key)) return { ok: false, reason: `未知存储键 ${key}` };
    this.cache.set(key, value);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`[Store] ✅ 保存视图数据失败：${key}`, error);
      return { ok: false, reason: error?.message || String(error) };
    }
    this._dropLocalBackup(key);
    const pin = this._viewPins.get(key);
    if (pin) {
      pin.at = Date.now();
      pin.version = VIEW_PIN_SCHEMA_VERSION;
      if (options.userModified === true) pin.userModified = true;
      this._persistViewPins();
      this._backgroundSyncHolds.add(VIEW_PIN_PUSH_HOLD);
    } else if (options.userModified === true) {
      // 锁若因排障被解除过，只要本页确实载入过资源，保存成功就把它补回来
      this.pinLocalView(key, value, options.reason || '用户保存的当前视图', { userModified: true });
    }
    return {
      ok: true, key, pinned: Boolean(pin || this._viewPins.has(key)),
      userModified: this._viewPins.get(key)?.userModified === true,
    };
  },

  /** 解除某个键的视图优先级锁 */
  unpinLocalView(key, reason = '') {
    const removed = this._viewPins.delete(key);
    this._persistViewPins();
    if (!this._viewPins.size) this._releaseViewPinHold();
    if (removed) console.log(`[Store] 🔓 已解除 ${key} 的视图优先级锁${reason ? `（${reason}）` : ''}`);
    return removed;
  },

  /** 一次性解除全部视图优先级锁（控制台：window.clearViewPriority()） */
  clearViewPins(reason = '控制台手动解除') {
    const keys = [...this._viewPins.keys()];
    this._viewPins.clear();
    try { localStorage.removeItem(VIEW_PIN_KEY); } catch (error) { /* 忽略 */ }
    this._releaseViewPinHold();
    console.log(`[Store] 🔓 已解除 ${keys.length} 个视图优先级锁（${reason}）`);
    return { ok: true, keys };
  },

  _releaseViewPinHold() {
    const removed = this._backgroundSyncHolds.delete(VIEW_PIN_PUSH_HOLD);
    if (removed) this._resumeBackgroundPushes();
    return removed;
  },

  /** 只存摘要，不存整份大单元（避免占满 localStorage 配额） */
  _persistViewPins() {
    try {
      const pins = {};
      this._viewPins.forEach((pin, key) => { pins[key] = pin; });
      if (Object.keys(pins).length) localStorage.setItem(VIEW_PIN_KEY, JSON.stringify(pins));
      else localStorage.removeItem(VIEW_PIN_KEY);
    } catch (error) { /* 忽略 */ }
  },

  /** 刷新后恢复：主键那份就是用户刚载入的资源，强制压回缓存并清掉历史锁 */
  _restoreViewPins() {
    let pins = {};
    try { pins = JSON.parse(localStorage.getItem(VIEW_PIN_KEY) || '{}') || {}; } catch (error) { pins = {}; }
    let restored = 0;
    Object.entries(pins).forEach(([key, info]) => {
      if (!STORE_KEYS.includes(key) || !info) return;
      /* 摘要格式版本不符：丢弃，避免旧版本标记诈尸 */
      if (info.version !== undefined && Number(info.version) !== VIEW_PIN_SCHEMA_VERSION) return;
      const userModified = info.userModified === true;
      const at = Number(info.at || 0);
      // userModified 标记刷新后依然有效，不受 30 分钟 TTL 限制
      if (!at || (!userModified && Date.now() - at > VIEW_PIN_TTL_MS)) return;
      /* 主键可能已被清空：此时仍要恢复锁本身。
         否则 userModified 保护会跟着主键一起消失，旧备份立刻反噬回来。 */
      let value = null;
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) value = JSON.parse(raw);
      } catch (error) { value = null; }
      const epoch = Number(info.epoch || 0) || ++this._viewPinEpoch;
      this._viewPinEpoch = Math.max(this._viewPinEpoch, epoch);
      this._viewPins.set(key, {
        epoch, at, reason: info.reason || '刷新后续延',
        userModified, version: VIEW_PIN_SCHEMA_VERSION,
      });
      if (value !== null) this.cache.set(key, value);   // 备份 / 旧缓存一律靠边站
      try { localStorage.removeItem(this._lockKeyOf(key)); } catch (error) { /* 忽略 */ }
      this._pendingWrites.delete(key);
      this._failedWrites.delete(key);
      this._deferredWrites.delete(key);
      restored += 1;
    });
    if (this._viewPins.size) this._backgroundSyncHolds.add(VIEW_PIN_PUSH_HOLD);
    else this._backgroundSyncHolds.delete(VIEW_PIN_PUSH_HOLD);
    if (restored) {
      this._persistViewPins();       // 顺手清掉已过期的条目
      console.log(`[Store] 🔒 刷新后恢复 ${restored} 个视图优先级锁：优先使用本机刚载入的数据，`
        + '历史保护锁已作废，后台旧队列不参与补推');
    }
    return restored;
  },

  /* ---------------- 离线状态（顶栏灰色标签的数据源） ---------------- */

  isOfflineMode() { return this._offlineMode === true; },

  /** 记一次网络失败：连续达到阈值才点亮离线标签；主动静默取消不算断网 */
  _noteNetworkFailure(reason = '') {
    if (this.isQuietLocalMode()) return;
    this._networkFailures += 1;
    if (!this._offlineSince) this._offlineSince = Date.now();
    if (this._networkFailures >= OFFLINE_BADGE_THRESHOLD) this._setOfflineMode(true, reason);
  },

  /** 任意一次云端请求成功就立刻复位，标签随之消失 */
  _noteNetworkSuccess() {
    if (this._networkFailures === 0 && !this._offlineMode) return;
    this._networkFailures = 0;
    this._offlineSince = 0;
    this._setOfflineMode(false, '云端请求已恢复');
  },

  /** 状态变化才派发 store:network（同页 / iframe 父页都能收到），避免高频刷事件 */
  _setOfflineMode(on, reason = '') {
    if (this._offlineMode === on) return;
    this._offlineMode = on;
    console.log(`[Store] ${on ? '🌐 进入离线模式（数据保存在本机），后台重试降为 1 分钟一次'
      : '▶ 网络恢复，退出离线模式'}：${reason}`);
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    const fire = target => {
      try {
        const Ctor = typeof target.CustomEvent === 'function' ? target.CustomEvent : CustomEvent;
        target.dispatchEvent(new Ctor('store:network', { detail: { offline: on, reason } }));
      } catch (error) { /* 跨域 iframe 忽略 */ }
    };
    fire(window);
    try {
      if (window.parent && window.parent !== window) fire(window.parent);
      if (window.top && window.top !== window && window.top !== window.parent) fire(window.top);
    } catch (error) { /* 忽略 */ }
  },

  /* ---------------- 历史脏队列延期 / 网络恢复自愈 ---------------- */

  /**
   * 🌐 把历史积压的待写队列「延期隔离」：只移出自动重推队列，
   * 业务数据 + localStorage 保护锁一个都不动，连定时器也全部停掉。
   * olderThanMs > 0 时只延期超过该时长的旧条目（0 = 全部）。
   * 恢复方式：online 事件 / 手动执行 Store.handleOnline()。
   */
  deferPendingQueue(reason = '本地离线操作', olderThanMs = 0) {
    const cutoff = olderThanMs > 0 ? Date.now() - olderThanMs : Infinity;
    let deferred = 0;
    for (const [key, entry] of [...this._pendingWrites]) {
      if (entry?.at && entry.at > cutoff) continue;
      this._pendingWrites.delete(key);
      this._deferredWrites.set(key, { ...entry, deferredAt: Date.now(), deferredReason: reason });
      const timer = this._criticalTimers.get(key);
      if (timer) { clearTimeout(timer); this._criticalTimers.delete(key); }
      /* 盘上保护锁打 deferred 标记：刷新后 _restoreUnconfirmed 仍认得它，
         不会又放回待写队列疯狂重推；锁本身必须留着保护本地数据。 */
      try {
        const lockKey = this._lockKeyOf(key);
        const raw = localStorage.getItem(lockKey);
        const info = raw ? JSON.parse(raw) : {};
        localStorage.setItem(lockKey, JSON.stringify({ ...info, deferred: true, deferredReason: reason }));
      } catch (error) { /* 忽略 */ }
      deferred += 1;
    }
    console.log(`[Store] 🌐 ${reason}：已延期隔离 ${deferred} 条历史待写数据`
      + '（数据与保护锁完整保留，不再自动 POST；网络恢复 / online 事件后自动回到队列）');
    return deferred;
  },

  /**
   * ▶ 网络恢复自愈（window 的 online 事件 / 手动执行 Store.handleOnline()）
   * ① 解除离线模式与静默本地模式（它们会挡住补推）
   * ② 延期区的历史数据放回待写队列，并清掉盘上 deferred 标记
   * ③ 重新排队续传；请求成功后 _doFetch 会自动复位离线标签
   */
  handleOnline(reason = '浏览器 online 事件') {
    this._setOfflineMode(false, `${reason}，开始自愈`);
    this.exitQuietLocalMode();
    /* 🔒 视图优先级锁的推送暂停也要让位给「网络恢复自愈」：
       本地视图仍被 pin 保护（云端覆盖不进来），但延期队列必须能重新回队续传。 */
    this._releaseViewPinHold();
    let restored = 0;
    for (const [key, entry] of [...this._deferredWrites]) {
      const original = { ...entry };
      delete original.deferredAt;
      delete original.deferredReason;
      if (!this._pendingWrites.has(key)) {
        this._pendingWrites.set(key, original);
        restored += 1;
      }
      this._deferredWrites.delete(key);
      try {
        const lockKey = this._lockKeyOf(key);
        const raw = localStorage.getItem(lockKey);
        if (raw) {
          const info = JSON.parse(raw);
          delete info.deferred;
          delete info.deferredReason;
          localStorage.setItem(lockKey, JSON.stringify(info));
        }
      } catch (error) { /* 忽略 */ }
    }
    const scheduled = this._resumeBackgroundPushes({ force: true, all: true });
    console.log(`[Store] ▶ 网络恢复自愈（${reason}）：延期数据回队 ${restored} 条，重排续传 ${scheduled} 个`);
    return { ok: true, restored, scheduled, deferred: this._deferredWrites.size };
  },

  /** 幂等注册 online 监听：即使 Layout 没加载，Store 自己也能完成自愈 */
  _bindOnlineRecovery() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (window.__storeOnlineRecoveryBound) return;
    window.__storeOnlineRecoveryBound = true;
    window.addEventListener('online', () => {
      try { this.handleOnline('online 事件'); }
      catch (error) { console.warn('[Store] 网络恢复自愈失败', error); }
    });
  },

  /** 后台静默同步（对外：手动刷新数据用）。失败会自动重试一次。 */
  async sync({ attempts = MAX_SYNC_ATTEMPTS } = {}) {
    // 🤫 静默本地模式：一个 GET 都不发，安静用本地缓存
    if (this.isQuietLocalMode()) return { ok: false, changed: [], reason: 'quiet' };
    if (this.isGenerating()) {
      console.warn('[Store] ⏸ 大单元生成中，本次同步已跳过（绝不拉取云端覆盖本地）');
      return { ok: false, changed: [], reason: 'generating' };
    }
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
        // 🤫 静默取消：不重试、不标记未连接、不弹任何超时提示
        if (error?.quiet) return { ok: false, changed: [], reason: 'quiet', failed: false };
        lastError = error;
        if (isNetworkFailure(error)) {
          /* 断网时不做 1.2 秒后的第二次尝试：两发各等 20 秒超时纯属浪费，
             重连统一交给 1 分钟级的 _scheduleReconnect。 */
          console.warn('[Store] 🌐 网络不通，跳过本次同步的短间隔重试（避免断网时高频打后端）');
          break;
        }
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
    /* ⛔ 权限闸门（前端体验层，真正的底线在服务端 lib/admin-auth.js）：
       GET 读数据放行；POST/PUT/DELETE 写数据必须带管理员凭证 ——
       ① 没登录 → 一个字节都不发给后端，直接提示"请先登录管理员"；
       ② 已登录 → 自动带上 X-Admin-Password 请求头。 */
    let guarded = options;
    const method = String(options?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && typeof window !== 'undefined' && window.Auth) {
      if (!String(url).includes('/api/admin')) {
        if (!window.Auth.isAdmin() || !window.Auth.getPassword()) {
          // ⚠️ 只给 3 秒轻提示，绝不自动弹登录框（自动弹窗会打断浏览）
          if (typeof window.Auth.notifyGuest === 'function') window.Auth.notifyGuest();
          else window.Auth.toast('游客只能查看数据，修改请先点击右上角登录', 'error');
          const denied = new Error('请先登录管理员');
          denied.adminRequired = true;
          return Promise.reject(denied);
        }
        guarded = {
          ...options,
          headers: { ...(options.headers || {}), 'X-Admin-Password': window.Auth.getPassword() },
        };
      }
    }
    const run = () => this._doFetch(url, guarded, timeout);
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
    let timedOut = false;
    const startedAt = Date.now();
    const method = String(options?.method || 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    // 登记在飞 GET：进入静默本地模式时能立刻 abort，而不是干等 20 秒超时
    if (isRead && controller) this._inFlightReads.add(controller);
    let bodyBytes = 0;
    try {
      if (typeof options?.body === 'string') {
        bodyBytes = typeof Blob !== 'undefined'
          ? new Blob([options.body]).size
          : (typeof Buffer !== 'undefined' ? Buffer.byteLength(options.body, 'utf8') : options.body.length);
      }
    } catch (error) { /* 体积只是诊断信息，算不出来不影响请求 */ }
    const payloadKB = (bodyBytes / 1024).toFixed(1);
    const timeoutRace = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        if (controller) controller.abort();
        reject(new Error(`请求 ${url} 超时（${timeout}ms）`));
      }, timeout);
    });
    try {
      request = fetch(url, { ...options, signal: controller ? controller.signal : undefined });
      const response = await Promise.race([request, timeoutRace]);
      if (!response.ok) {
        /* 把服务端返回的错误体读出来：
           403 + code=ADMIN_REQUIRED 是"游客没登录管理员"，不是"写入失败" ——
           带上 adminRequired 标记，让上层安静处理，别报成同步失败。
           502 的响应体里带着服务端写 Supabase 的真实原因，必须挂到 error 上供 catch 打印。 */
        let detail = null;
        try { detail = await response.json(); } catch (parseError) { /* 响应体不是 JSON，忽略 */ }
        const error = new Error(detail?.error || `${url} 返回 HTTP ${response.status}`);
        error.status = response.status;
        error.code = detail?.code || '';
        error.hint = detail?.hint || '';
        error.detail = detail;
        if (detail?.adminRequired === true) error.adminRequired = true;
        throw error;
      }
      const payload = await response.json();
      this._noteNetworkSuccess();   // 任意一次云端请求成功，立刻复位离线状态与顶栏标签
      return payload;
    } catch (error) {
      // 等 abort 真正生效、这一发结束，再让上层重试
      await this._settle(request);
      const message = error?.message || String(error);
      const aborted = timedOut || error?.name === 'AbortError' || /signal is aborted/i.test(message);
      const netFail = aborted || isNetworkFailure(error);
      /* 🤫 静默本地模式：被我们主动取消 / 因云端慢而超时的 GET，一律安静回退本地缓存。
         不打印红色错误、不归一化成「超时」、不抛给 _syncWithRetry 触发 toast 和重连。 */
      if (isRead && this.isQuietLocalMode() && (aborted || !error?.status || error?.status >= 500)) {
        console.log(`[Store] 🤫 静默本地模式（${this._quietReason}）：${method} ${url} 已取消/超时，`
          + '安静回退本地缓存，不弹超时提示');
        const quietError = new Error('后台同步已静默取消');
        quietError.quiet = true;
        throw quietError;
      }
      /* 把「网络不通」标记透传给上层：POST 失败只 warn、不弹红色弹窗、不计熔断。 */
      if (error && typeof error === 'object') error.networkFailure = netFail;
      if (netFail) this._noteNetworkFailure(`${method} ${url}：${message}`);
      const requestDetail = {
        url, method, timeoutMs: timeout, elapsedMs: Date.now() - startedAt,
        payloadKB, status: error?.status || '', code: error?.code || '',
        name: error?.name || '', message,
        serverError: error?.detail?.error || '', serverHint: error?.hint || '',
        cause: error?.cause?.message || '', stack: error?.stack || '',
      };
      if (netFail) {
        /* 🌐 断网：只打一条警告，不再 console.error 制造满屏红色失败。
           数据由上层静默留在本地待写队列，联网后续传。 */
        console.warn(`[Store] 🌐 网络不可用（${method} ${url}）：${message}`
          + '；本次数据静默保留在本机，后台重试已降为 1 分钟一次', requestDetail);
      } else {
        /* 业务错误才打完整明细：服务端 error/hint/code 用于定位表结构冲突等问题。 */
        console.error('[Store] ❌ 请求失败明细（HTTP 或业务错误）', requestDetail);
      }
      /* abort 一触发，fetch 自己抛的 AbortError 会抢先赢过 Promise.race 里的超时错误，
         上层只看到 "signal is aborted"。归一化成明确的超时错误，并带上排障指引。 */
      if (aborted && !error?.status) {
        const timeoutError = new Error(
          `请求 ${method} ${url} 超时/被中断（上限 ${timeout}ms，耗时 ${Date.now() - startedAt}ms，payload ${payloadKB}KB）；`
          + '多半是服务端 /api/data 写 Supabase 卡住或进程崩溃，请看 server.js 控制台的崩溃栈',
        );
        timeoutError.timeout = true;
        timeoutError.networkFailure = true;
        timeoutError.name = 'StoreRequestTimeout';
        timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    } finally {
      if (isRead && controller) this._inFlightReads.delete(controller);
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
    // 🤫 静默本地模式：一个 GET 都不发，安静用本地缓存
    if (this.isQuietLocalMode()) return { ok: false, changed: [], reason: 'quiet' };
    // ⏸ 生成期间：连 GET 都不发 —— 云端旧数据一点机会都没有
    if (this.isGenerating()) {
      console.warn('[Store] ⏸ 大单元生成中，_syncOnce 空转（未发出任何云端请求）');
      return { ok: false, changed: [], reason: 'generating' };
    }
    // ⏸ 排障 / 强行恢复期间：连请求都不发，云端 0 条一点机会都没有
    if (this._cloudPaused) return { ok: false, changed: [], reason: 'paused' };
    const epoch = this._purgeEpoch;      // 发出请求时记下世代号
    let payload;
    try {
      payload = await this._fetchJSON('/api/data', { headers: { Accept: 'application/json' } }, timeout);
    } catch (error) {
      // 🤫 被静默取消的请求：不当成同步失败，安静回退本地缓存
      if (error?.quiet) return { ok: false, changed: [], reason: 'quiet' };
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
      // ③ 云端覆盖：有锁的键一律跳过；读取失败的键也一律跳过
      const failedKeys = Array.isArray(payload.errors)
        ? payload.errors.map(item => item?.key).filter(Boolean)
        : [];
      const changed = this._applyCloud(payload.data, { failedKeys });
      /* 回写本地镜像：只写「这次真正变了」的键 + 云端已删除（缓存为 null）的键。
         ⚠️ 不再全量回写：多个 iframe 共享同一份 localStorage，一个缓存还是旧值的兄弟
            iframe 全量回写，会把报名页刚落盘的新数据盖成旧数据（用户一刷新就"数据没了"）。 */
      const toMirror = [...new Set([
        ...changed,
        ...STORE_KEYS.filter(key => this.cache.get(key) === null),
      ])];
      this._mirrorLocal(toMirror);
      this._logOverwrite(changed, before);
      /* 🧹 不再每次会话生成 17 份 __local_backup（那正是几百 KB 冗余镜像堆积的源头）。
         正常同步成功后只清掉历史上没有时间戳 / 超过 24 小时的遗留镜像。 */
      if (!this._backedUp) { this._clearStaleLocalBackups(); this._backedUp = true; }
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
    /* 🤫 静默本地模式：云端连不上也安静用本地缓存，绝不派发 failed 事件弹超时、不排重连 */
    if (this.isQuietLocalMode()) {
      console.log(`[Store] 🤫 静默本地模式（${this._quietReason}）：云端不可用，已安静回退本地缓存`);
      return;
    }
    /* 一次完整 sync 失败 = 底层一发 + 判定未连接，合计两次网络失败 → 点亮离线标签。
       断网时不再做短重试，这里补齐阈值，用户第一屏就能看到真实网络状态。 */
    if (isNetworkFailure(error) && !this.isOfflineMode()) this._noteNetworkFailure('同步连续超时');
    this.cloudState = 'off';
    this.mode = 'local';
    if (silent) console.warn('[Store] 云端不可用，已回退本地存储：', error?.message || error);
    this._dispatchSync([], { failed: true, reason: error?.message || String(error), willRetry: this._reconnectAttempts < MAX_RECONNECT });
    this._scheduleReconnect();
  },

  /** 判定未连接后定时重连（最多 MAX_RECONNECT 次），网络恢复后自动用云端数据覆盖本地 */
  _scheduleReconnect() {
    if (this.isQuietLocalMode()) return;   // 🤫 静默期间别排重连，否则 8 秒后又来一次超时
    if (typeof window === 'undefined' || this._reconnectTimer) return;
    if (this._reconnectAttempts >= MAX_RECONNECT) return;
    this._reconnectAttempts += 1;
    /* 🌐 断网：重连从 8/16/24 秒拉长到 1/2/3 分钟，绝不把本地服务器打成筛子 */
    const offline = this.isOfflineMode();
    const delay = (offline ? OFFLINE_RETRY_MS : RECONNECT_DELAY) * this._reconnectAttempts;
    console.warn(`[Store] ${offline ? '🌐 离线模式：' : ''}将在 ${delay / 1000} 秒后`
      + `第 ${this._reconnectAttempts}/${MAX_RECONNECT} 次尝试重连云端…`);
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
  _applyCloud(data, options = {}) {
    const changed = [];
    const protectedKeys = [];
    const report = { protected: protectedKeys, refused: [], healed: [] };
    // 云端读取失败的键：那一格根本不是"云端没有"，而是"没读到" → 一律不许覆盖本地
    const failedKeys = new Set(Array.isArray(options.failedKeys) ? options.failedKeys : []);
    // force=true：强制以云端为准（手机端"手动拉取"用）—— 无视本地未确认锁
    const force = options.force === true;
    this._lastSyncReport = report;
    // ⏸ 暂停期间：一个键都不许改（forceRecover 恢复出来的数据谁也别碰）
    if (this._cloudPaused) {
      console.warn('[Store] ⏸ 云端同步已暂停，本次云端数据未落到本地（forceRecover 期间保护本地数据）');
      return changed;
    }
    /* ⏸ 生成期间：即使有请求在冻结【之前】就发出去了，回来也一律作废 ——
       这是"生成到一半被云端旧快照盖掉模块 4/5/6"的最后一道闸门。 */
    if (this.isGenerating()) {
      console.warn('[Store] ⏸ 大单元生成中，_applyCloud 空转：云端返回的旧数据一律不落本地');
      return changed;
    }
    STORE_KEYS.forEach(key => {
      /* 🔒 视图优先级锁（最高优先，连 force:true 也绕不过）：
         用户刚主动从离线资源库载入的这份数据是【当前视图的唯一可信副本】，
         云端旧快照、后台同步结果、未确认锁、反推自愈一律不许碰它。
         解除方式：Store.clearViewPins() / 锁到期 / hardResetAll()。 */
      if (this.isViewPinned(key)) {
        protectedKeys.push(key);
        return;
      }
      const current = this.cache.get(key);
      /* ⛔ 空值锁作废：
         这把锁护的是一份【空】数据（多半是页面初始化时把空快照写回了共享存储）。
         它有两大害处：
           ① 它让之后的每次同步都跳过这个键 → 手机端明明能从云端拉到教案，却一直显示空的；
           ② 它被当成"待补推的写入" → 把空数据推回云端 → 反向把云端洗成 0 条。
         现在直接作废它，让云端的有效数据落地。 */
      let pending = this._pendingWrites.get(key);
      // 用"盘上的真实镜像"来判断这份数据是不是空的（缓存没灌时也能看准）
      if (pending && this._isEmptyValue(this._readLocalValue(key)) && pending.clear !== true) {
        this._pendingWrites.delete(key);
        try { localStorage.removeItem(this._lockKeyOf(key)); } catch (error) { /* 忽略 */ }
        pending = undefined;
        console.warn(`[Store] ⛔ ${key} 的保护锁护的是一份空数据，已作废（云端有效数据可以落地了）`);
      }
      /* ⛔ 强制模式（手机端"手动拉取云端"）：云端有数据而本地是空的，
         就【必须】用云端的覆盖本地 —— 哪怕本地还挂着一把未确认锁。
         这条是"手机端刷新后必须能看到电脑端刚生成的教案"的最后保证：
         以前手机端握着一把锁（护着空数据或旧数据），云端的数据被挡在门外 → 页面一直空白，
         老师看到的现象就是"云端明明有数据，手机上却看不到"。 */
      if (force && pending) {
        this._pendingWrites.delete(key);
        try { localStorage.removeItem(this._lockKeyOf(key)); } catch (error) { /* 忽略 */ }
        pending = undefined;
        console.warn(`[Store] ⛔ ${key} 强制拉取模式：本地未确认锁已忽略，以云端为准`);
      }
      // 保护未确认的本地写入（正在推送 / 推送失败待补推）：
      // critical 永久保护，普通写入在 UNCONFIRMED_TTL_MS 内保护；
      // 过期的已在 _dropStalePending 里清掉，必须让云端覆盖，否则旧缓存永远赖着不走
      // 有锁 = 本地这份数据还没被云端确认 → 直接跳过，云端说什么都不许覆盖
      if (pending && (pending.critical || Date.now() - pending.at <= UNCONFIRMED_TTL_MS)) {
        protectedKeys.push(key);
        return;
      }
      /* ⛔ 已被熔断的键（连续写云端失败 3 次）：本地这份是【唯一可信的一份】，
         云端无论返回什么都覆盖不了它 —— 否则"云端写不进去 + 云端读出来是空"
         就会把本地仅有的数据也一起洗掉（数据彻底消失）。 */
      if (this._failedWrites.has(key) && !force) {
        protectedKeys.push(key);
        console.warn(`[Store] ⛔ ${key} 之前写云端失败已熔断，本地数据保留不动（云端不覆盖）`);
        return;
      }
      /* ⛔ 云端这一格【读取失败】（表结构异常 / 权限问题）→ 它不是"云端没有数据"，
         而是"没读出来"。这种情况下一律保留本地，并提示具体是哪张表。 */
      if (failedKeys.has(key)) {
        protectedKeys.push(key);
        console.warn(`[Store] ⛔ 云端读取 ${key} 失败，本地数据保留不动（绝不用读取失败的结果覆盖本地）`);
        return;
      }
      const next = data[key] === undefined ? null : data[key];
      const cloudEmpty = this._isEmptyValue(next);
      const localHasData = !this._isEmptyValue(current);
      /* 🛑 大单元「防覆盖强锁」：
         云端那份 pe_big_unit_design_v1 缺了核心模块（objectives / textbookAnalysis / …），
         而本地这些模块是有内容的 → 直接拒绝覆盖并报警。
         典型现场：生成到模块 6 时，云端还停留在只有模块 1–3 的旧快照，
         一次静默同步就把刚生成的模块 4、5、6 整份洗掉。
         force=true 是用户在排障界面【亲手】点的"以云端为准"，才放行。 */
      if (key === UNIT_DESIGN_KEY && !force && this._isPlainObject(current)) {
        const missing = UNIT_DESIGN_CORE_FIELDS.filter(field =>
          this._unitFieldHasData(current[field]) && !this._unitFieldHasData(next?.[field]));
        if (missing.length) {
          console.warn(`[Store] ⛔ 云端 ${key} 缺少核心模块 ${missing.join('、')}，本地有内容 → `
            + '拒绝覆盖本地，并把本地这份反推回云端');
          report.refused.push(key);
          this._pushBackToCloud(key, current);
          return;
        }
      }
      /* ⛔ 「清空中」的键：云端回来的旧数据一律【不复活到本地】，
         也绝不触发"反推自愈"（把这份旧数据又推回云端）。
         这是"用户亲手清空体测数据"必须绝对可靠的最后一道闸门：
         没有它，云端清空慢半拍或失败时，旧数据会一路复活回来 ——
         也就是这次要根治的那个毛病（本地缓存把云端重新污染回去）。 */
      if (this._isClearPending(key) && !this._isEmptyValue(next)) {
        protectedKeys.push(key);
        console.warn(`[Store] ⛔ ${key} 处于清空流程中，云端返回的旧数据不会复活到本地（等云端清空确认）`);
        return;
      }
      /* ✅ 云端返回了【有效数据】而本地是空的 → 强制用云端数据覆盖本地，并触发重绘。
         这条是"手机端刷新后必须能看到电脑端刚生成的教案"的保证：
         以前手机端握着一把"空值锁"，云端的数据被挡在门外 → 页面一直空白，
         老师看到的现象就是"云端明明有数据，手机上却看不到"。
         反过来，手机端也绝不会用自己那份空缓存去覆盖云端（见下面的底线规则）。 */
      if (!cloudEmpty && !localHasData) {
        console.log(`[Store] ✅ 云端 ${key} 有 ${this._sizeOf(next)}，本地是空的 → 强制用云端数据覆盖本地并重绘`);
      }
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
      /* 🛑 底线规则（对【所有】键生效，不只是运动会数据）：
         云端这一份是空的，而本地有真实数据 → 绝对拒绝覆盖。
         以前这条只对 pe_sports_meet_* 生效，于是"体测数据上传失败 → 云端表被洗空 →
         刷新时云端返回空数组 → 本地被覆盖成空"这条链畅通无阻 —— 这就是那次数据全没的现场。
         现在只要云端是空的，本地有数据就一律保住本地，并把本地这份反推回云端修好它。
         唯一例外：用户在界面上【亲手清空】且还没确认（pending.clear === true），那时空值是要生效的。 */
      if (cloudEmpty && localHasData) {
        const clearIntent = pending?.clear === true;
        if (!clearIntent) {
          console.warn(`[Store] ⛔ 云端 ${key} 返回空数据，本地有 ${this._sizeOf(current)} → 拒绝覆盖本地，`
            + '并把本地这份反推回云端（云端那份多半是写入失败被洗空了）');
          report.refused.push(key);
          this._pushBackToCloud(key, current);
          return;
        }
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
    const pinnedKeys = [...this._viewPins.keys()].filter(key => STORE_KEYS.includes(key));
    if (pinnedKeys.length) {
      console.log(`[Store] 🔒 视图优先级锁保护中（云端一律不覆盖、也不反推）：${pinnedKeys.join('、')}`);
    }
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
    if (this._readOnlyPull) return;                // ⛔ 纯拉取模式：绝不向云端发送任何修改
    if (this._cloudPaused) return;                 // ⏸ 暂停期间不上锁、不推送
    if (this._backgroundPushBlocked()) return;     // ⏸ 生成 / 载入期间「反杀云端」也不许发 POST
    if (this.cloudState === 'off') return;         // 明确没配云端 / 服务端 503，不做无谓重试
    if (this._pendingWrites.has(key)) return;      // 已经有写入在飞/待推，不重复排队
    this._localWrites.add(key);
    this._markUnconfirmed(key, value);             // 同步上锁（防推进过程中被云端空数据反扑）
    this._persistSafely(key, value);               // 立即推一次，失败由 _scheduleCriticalRetry 接力
    this._scheduleCriticalRetry(key);
  },

  /**
   * 大单元某个模块里是否【真的有内容】。
   * 注意 createEmptyUnit() 会造出 18 条空课时 / 18 个空节点，
   * 所以不能只看数组 length —— 必须看里面的文字，否则强锁会永远不触发。
   */
  _unitFieldHasData(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number' || typeof value === 'boolean') return Boolean(value);
    if (Array.isArray(value)) return value.some(item => this._unitFieldHasData(item));
    if (this._isPlainObject(value)) {
      // 只认内容字段，跳过 no / dimension / id 这类结构性字段
      return Object.entries(value).some(([field, item]) =>
        !['no', 'id', 'dimension'].includes(field) && this._unitFieldHasData(item));
    }
    return false;
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
      /* 🔒 视图优先级锁：本地镜像已经由 pinLocalView() 写成刚载入的资源，
         云端同步 / 其它页面的旧缓存一律不许再回写覆盖它。 */
      if (this.isViewPinned(key)) return;
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
      /* ✅ 明确的清空指令优先于一切本地保护：
           用户亲手确认过的清空必须生效 —— 哪怕本页还握着一把"云端未确认"的锁。
           （以前这条检查排在 pendingWrites 后面：本页握着锁时它会直接 return，
             于是本页把清空前的旧数据当成"本地刚写的"补推回云端 → 数据原地复活。）
           信号里带 keys 清单就照单全收，老版本信号没有清单时退回"清空触发事件的那个键"。 */
      const purgedKeys = this._consumeForeignPurge(key);
      if (purgedKeys && purgedKeys.length) {
        purgedKeys.forEach(purgeKey => {
          this.unpinLocalView(purgeKey, '其它页面明确清空');   // 用户亲手清空优先于视图锁
          this.cache.delete(purgeKey);
          this._localWrites.delete(purgeKey);
          this._failedWrites.delete(purgeKey);
          this._clearUnconfirmed(purgeKey);        // 解除防覆盖锁，别再把旧数据补推回云端
          try { localStorage.removeItem(purgeKey); } catch (error) { /* 忽略 */ }
        });
        console.log(`[Store] 🧨 检测到其它页面执行了清空指令，已同步清空：${purgedKeys.join('、')}（不再从备份复活）`);
        this._dispatchSync(purgedKeys, { reason: 'purgeKeys', crossDocument: true });
        return;
      }
      /* 🔒 用户刚主动载入的资源是最高优先级：其它 iframe / 标签页的旧缓存一律不接收，
         也不派发 store:sync 让页面拿旧数据重绘。 */
      if (this.isViewPinned(key)) {
        console.log(`[Store] 🔒 ${key} 处于视图优先级锁保护中，忽略其它页面传来的旧数据`);
        return;
      }
      // 本页这份键还有「云端未确认」的写入 → 保留本地，绝不让别人（或云端旧值）覆盖
      if (this._pendingWrites.has(key)) return;
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

  /** 盘上的「一键清空」指令：{ epoch, at, keys }（早期版本可能只存了纯数字，一并兼容） */
  _storedPurgeSignal() {
    try {
      const raw = localStorage.getItem(PURGE_SIGNAL_KEY);
      if (!raw) return { epoch: 0, at: 0, keys: [] };
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'number') return { epoch: parsed, at: Date.now(), keys: [] };
      return {
        epoch: Number(parsed?.epoch) || 0,
        at: Number(parsed?.at) || 0,
        keys: Array.isArray(parsed?.keys) ? parsed.keys.filter(key => typeof key === 'string') : [],
      };
    } catch (error) {
      return { epoch: 0, at: 0, keys: [] };
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
    if (at && Date.now() - at > PURGE_SIGNAL_TTL_MS) return false;
    return true;
  },

  /**
   * 读取并"认领"别的文档发来的清空指令。
   * @param {string} eventKey 触发 storage 事件的键（老版本信号没有 keys 清单时用它兜底）
   * @returns {string[]|null} 需要跟着一起清空的键清单；null = 这不是清空指令
   */
  _consumeForeignPurge(eventKey = '') {
    const { epoch, at, keys } = this._storedPurgeSignal();
    if (epoch <= this._purgeEpochSeen) return null;
    this._purgeEpochSeen = epoch;                 // 认下这个世代号，后续不再重复判断
    if (at && Date.now() - at > PURGE_SIGNAL_TTL_MS) return null;
    this._purgeEpoch = Math.max(this._purgeEpoch, epoch);
    const wanted = keys.length ? keys : (eventKey ? [eventKey] : []);
    return wanted.filter(key => STORE_KEYS.includes(key));
  },

  /**
   * 写一份「清空指令」到盘上：兄弟 iframe / 其它标签页据此跟着清空。
   * @param {string[]} keys 本次点名要清的键（老版本只认 epoch/at，keys 会被忽略）
   */
  _writePurgeSignal(keys = []) {
    const signal = JSON.stringify({ epoch: this._purgeEpoch, at: Date.now(), keys: [...keys] });
    try { localStorage.setItem(PURGE_SIGNAL_KEY, signal); } catch (error) { /* 忽略 */ }
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
    /* 🔒 视图优先级锁：当前视图以用户刚载入、已落到主键的那份数据为准。
       就算有谁把内存缓存改回了旧快照，read() 也一律重新对齐主键 ——
       unit-design.js 的 loadUnitData() / Store.onReady 重绘因此拿不到旧数据。 */
    if (this.isViewPinned(key)) {
      try {
        const raw = localStorage.getItem(key);
        this.cache.set(key, raw === null ? null : JSON.parse(raw));
      } catch (error) { /* 忽略 */ }
    }
    /* 缓存还没灌（页面脚本常在 Store.start() 之前就 read()）：
       先把 localStorage 镜像灌进缓存，绝不能因为"缓存里没有"就返回空 ——
       报名页 pageData = loadMeetData() 就是这么拿到 0 条、渲染出空页面的。 */
    if (!this.cache.has(key)) this._hydrateFromLocal(key);
    /* ⛔ 自愈底线：只要主数据是空的，就【无条件、同步】试一次时光机备份。
       不看云同步走到哪一步、不看有没有差异 —— 备份在，任何页面任何时刻读到的都必须是 216 条。
       这是"三个页面（报名 / 赛程 / 成绩）表现绝对一致"的最后保证。 */
    if (this._isMeetKey(key) && !this.isViewPinned(key) && !this._isClearPending(key)) {
      this._healMeetDataFromBackup(key);
    }
    const value = this.cache.get(key);
    const result = value === undefined ? fallback : value;
    if (this._isMeetKey(key)) {
      console.log(`[Store] 读取键：${key}，报名数据：${this._countOf(result)}条`
        + `，赛程：${Array.isArray(result?.schedule?.entries) ? `${result.schedule.entries.length} 个时段` : '无'}`);
    }
    return result;
  },

  /**
   * 现在能不能往云端写？
   * ⛔ 游客（未登录管理员）一律不能 —— 而且是【不发请求】，不是"发了被拒"。
   *    这条是"游客浏览时自动弹登录框"的根治点：
   *    以前后台静默同步（补推待写队列 / 断点续传）会发出写请求 →
   *    被后端 403 → 前端就弹登录框 → 每切一个页面弹一次。
   *    现在游客模式下这些请求根本不会发出，自然就没有 403、也没有弹窗。
   *
   * 没有加载 auth.js 的页面（老页面 / 测试沙箱）保持原行为，不影响既有逻辑。
   */
  _canWriteCloud() {
    if (typeof window === 'undefined') return true;
    const auth = window.Auth;
    if (!auth || typeof auth.isAdmin !== 'function') return true;
    return auth.isAdmin() === true;
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
   * @param {{push?: boolean, allowEmpty?: boolean, force?: boolean, clearIntent?: boolean}} options
   *        push=false 时只落本地（由 writeCritical 自己 await 推送）
   *        allowEmpty / force / clearIntent=true 表示"用户在界面上明确要清空"，才允许把数据写空到云端
   *        （否则 athletes / registrations 从有到无会【抛异常终止写入】）
   */
  write(key, value, options = {}) {
    const before = this._isMeetKey(key) ? this.cache.get(key) : undefined;
    const previousValue = this._isMeetKey(key) ? before : this._readLocalValue(key);
    const merged = this._mergeMeetData(key, value, options);   // ⛔ 空覆盖在这里抛异常
    /* 🔒 用户载入资源后继续编辑：编辑结果仍属于「当前视图」，刷新锁的有效期，
       后台依旧不能用编辑之前的旧快照反盖回来。 */
    if (this.isViewPinned(key)) {
      const pin = this._viewPins.get(key);
      if (pin) { pin.at = Date.now(); this._persistViewPins(); }
    }
    this._traceEmptyWrite(key, before, merged, 'write()');      // 🚨 看门狗：谁把主数据写成 0 条
    /* ⛔ 游客模式（只读身份）：一份写请求都不发。
       ① 不写云端（不发请求 → 不会 403 → 不会弹任何窗）；
       ② 如果这份键正被"保护锁"守护（管理员离线时留下的未同步数据），
          连本地镜像都不许覆盖 —— 覆盖了就等于把管理员那份没推上去的修改弄丢了；
       ③ 其余情况照常写本地，页面照常能用，下次同步云端会覆盖回来。 */
    if (!this._canWriteCloud()) {
      const pending = this._pendingWrites.get(key);
      if (pending) {
        console.warn(`[Store] ℹ️ ${key} 正被保护锁守护，游客模式下不覆盖本地镜像（保住未同步的数据）`);
      } else {
        this.cache.set(key, merged);
        this._pendingClearKeys.delete(key);
        this._failedWrites.delete(key);
        try { localStorage.setItem(key, JSON.stringify(merged)); } catch (error) { /* 忽略 */ }
        if (this._isMeetKey(key)) this._updateBackup(key, merged, options);
      }
      if (typeof window !== 'undefined' && typeof window.Auth?.notifyGuest === 'function') {
        window.Auth.notifyGuest();
      }
      return merged;
    }
    this.cache.set(key, merged);
    this._localWrites.add(key);
    // 用户又写入了这个键 → 解除「清空中」标记（这份新数据照常落地、照常参与同步）
    this._pendingClearKeys.delete(key);
    // 用户又改了 → 之前熔断的状态作废，重新给一次机会
    this._failedWrites.delete(key);
    if (this._isMeetKey(key)) {
      console.log(`[Store] 写入键：${key}，写入前报名数据：${this._countOf(before)}条，写入后报名数据：${this._countOf(merged)}条`);
    }
    try {
      localStorage.setItem(key, JSON.stringify(merged));
    } catch (error) {
      console.warn(`[Store] 写入本地镜像失败：${key}`, error);
    }
    /* 🧹 正常保存成功后立刻清掉这个键的旧 __local_backup 镜像：
       主键已经是最新数据，旧镜像留着只会被误当成"可恢复的旧数据"，还会越堆越大。 */
    this._dropLocalBackup(key);
    if (this._isMeetKey(key)) this._updateBackup(key, merged, options);
    if (options.push === false) return merged;
    // 云端可用才需要"未确认保护"（纯本地模式没有云端数据来覆盖）；
    // 重要表单走 writeCritical，它自己会打 critical 标记，不受这里影响
    if (this.cloudState !== 'off') {
      /* ⛔ 清空意图【只认显式声明】：force / allowEmpty / clearIntent
         以前的推断是"本地从有变无 ⇒ 算用户主动清空" ——
         那正是这次「手机端刷新 → 云端教案凭空消失」的第二把刀：
         手机端本地缓存是旧的（非空），页面初始化时写回了一份空数组，
         于是被当成"用户在界面上清空了教案" → 带 clear:true 推上云端 → 云端被清空。
         现在：清空必须由调用方显式声明；"从有变无"只更新本地，绝不往云端发清空请求。
         （删掉某一条记录依然能生效：payload 变小 → 服务端按 id 删掉那一条旧行。） */
      const explicitClear = options.force === true || options.allowEmpty === true || options.clearIntent === true;
      const wasEmpty = !this._hasContent(key, previousValue);
      const nowEmpty = !this._hasContent(key, merged);
      if (nowEmpty && !explicitClear) {
        console.warn(`[Store] ⛔ ${key} 本地这份是空的，已拦下这次云端推送`
          + '（空数据推上去会把云端洗成 0 条）。'
          + (wasEmpty
            ? '本地本来就是空的。'
            : '本地原本有数据、现在变空了，但没有任何明确的清空声明 —— 一律不推云端。')
          + '若确实要清空，请在界面上点删除并传 { clearIntent: true }。');
        // ⛔ 关键：空值【不】上锁。上锁会让每次同步都跳过这个键 →
        //    手机端明明能从云端拉到教案，却一直显示空的（还会被当成待补推把空推回云端）。
        this._pendingWrites.delete(key);
        try { localStorage.removeItem(this._lockKeyOf(key)); } catch (error) { /* 忽略 */ }
        return merged;
      }
      this._markUnconfirmed(key, merged, {
        clear: explicitClear && nowEmpty,
        deletedIds: this._collectDeletedIds(key, previousValue, merged),
      });
      if (nowEmpty) {
        /* 空数据 → 走【专属的清空通道】_persistClear()。
           _persist 的死规则是"空载荷永远不发"，所以清空只能走这条独立通道，
           而它只有界面上的【清空按钮】/【删光最后一条】才会调用。 */
        this._persistClearSafely(key);
      } else {
        this._persistSafely(key, merged, {
          at: Date.now(),
          deletedIds: this._collectDeletedIds(key, previousValue, merged),
        });
      }
    }
    return merged;
  },

  /**
   * 这次写入"明确删掉了哪些 id"。
   *
   * ⛔ 为什么必须显式：服务端以前是"按这次 payload 里没带的旧行去删"（整表替换语义），
   *    结果手机端拿着旧快照推上来时，把电脑端刚写进去的新教案当成旧行删掉 ——
   *    那就是"空数据自杀式覆盖"的真凶。
   *    改成"客户端点名要删哪几条"，旧快照就再也伤不到新数据。
   *
   * @returns {string[]} 本次被删掉的 id（没有则空数组）
   */
  _collectDeletedIds(key, previous, next) {
    if (this._isMeetKey(key)) return [];              // 合并型键：不按 id 删
    const idsOf = value => {
      if (Array.isArray(value)) return value.map(item => String(item?.id ?? '')).filter(Boolean);
      return [];
    };
    const prev = new Set(idsOf(previous));
    if (!prev.size) return [];
    const nextIds = new Set(idsOf(next));
    return [...prev].filter(id => !nextIds.has(id));
  },

  /**
   * 清空云端某张表的"安全版"：失败时进待写队列（由 _persistEntry 走同一条清空通道重试）。
   */
  async _persistClearSafely(key) {
    /* ⛔ 游客模式：直接跳过，连请求都不发（也不解除保护锁，避免动到管理员的待推数据） */
    if (!this._canWriteCloud()) {
      console.warn(`[Store] ⛔ ${key} 的清空未推送：当前是游客模式（只读）`);
      return;
    }
    try {
      await this._persistClear(key);
      this._clearUnconfirmed(key);
    } catch (error) {
      /* 游客（未登录管理员）被后端 403 拦下：这不是"写失败"，不要重试也不要报错，
         否则老师会看到"同步失败"的误报。本地这份数据交给下次同步用云端覆盖。 */
      if (error?.adminRequired) {
        console.warn(`[Store] ⛔ ${key} 的清空未执行：未登录管理员（游客只读）`);
        this._clearUnconfirmed(key);
        return;
      }
      if (error && error.status === 503) {
        this.cloudState = 'off';
        this.mode = 'local';
        this._clearUnconfirmed(key);
        return;
      }
      const entry = this._pendingWrites.get(key) || { value: null, at: Date.now(), attempts: 0 };
      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastError = error?.message || String(error);
      entry.clear = true;
      if (entry.attempts >= MAX_PERSIST_ATTEMPTS) {
        this._markPersistFailed(key, entry, error);
        return;
      }
      this._pendingWrites.set(key, entry);
      this._writeLock(key, entry);
      this._onPersistError(key, error);
    }
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
        savedAt: Date.now(), version: BACKUP_SCHEMA_VERSION,
        key, count: this._countOf(value), data: value,
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

  /**
   * 🕒 备份合法性：返回空串 = 可用；'foreign' = 属于别的键（不能用，但别删）；
   * 其它字符串 = 不合格原因（必须丢弃这份备份，禁止恢复）。
   * 旧格式（没有 version）只在「有合法时间戳 + 24 小时内」时兼容；
   * 没有时间戳、超时、版本不符、结构不符、内容为空的一律判死。
   */
  _validateBackupSlot(key, slot) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return '格式不是备份对象';
    if (slot.key && slot.key !== key) return 'foreign';
    if (slot.version !== undefined && Number(slot.version) !== BACKUP_SCHEMA_VERSION) {
      return `版本 ${slot.version} 与当前版本 ${BACKUP_SCHEMA_VERSION} 不符`;
    }
    const savedAt = Number(slot.savedAt || 0);
    if (!Number.isFinite(savedAt) || savedAt <= 0) return '缺少时间戳';
    if (savedAt > Date.now() + 60 * 1000) return '时间戳来自未来';
    if (Date.now() - savedAt > BACKUP_MAX_AGE_MS) return `备份已超过 ${Math.round(BACKUP_MAX_AGE_MS / 3600000)} 小时`;
    if (!Object.prototype.hasOwnProperty.call(slot, 'data')) return '缺少 data';
    if (!this._hasContent(key, slot.data)) return '备份内容为空';
    if (this._isCountableMeetKey(key) && !this._isPlainObject(slot.data)) return '数据结构与当前版本不符';
    return '';
  },

  /** 读某个键的备份槽：优先分槽，退回老版本裸备份；不合格的直接删掉，绝不让它复活 */
  _readBackupSlot(key) {
    const parse = (raw, slotKey) => {
      if (!raw) return null;
      let slot = null;
      try { slot = JSON.parse(raw); } catch (error) {
        this._dropBackupSlot(slotKey, '备份不是合法 JSON');
        return null;
      }
      const invalid = this._validateBackupSlot(key, slot);
      if (invalid) {
        // 属于别的键的裸备份：留着给那个键用，这里只是不认
        if (invalid !== 'foreign') this._dropBackupSlot(slotKey, invalid);
        return null;
      }
      return slot;
    };
    return parse(localStorage.getItem(this._backupKeyOf(key)), this._backupKeyOf(key))
      || parse(localStorage.getItem(MEET_BACKUP_KEY), MEET_BACKUP_KEY);
  },

  /** 丢弃一份不合格的备份（连键一起删，避免下次刷新又来一次反噬） */
  _dropBackupSlot(slotKey, reason) {
    try { localStorage.removeItem(slotKey); } catch (error) { /* 忽略 */ }
    console.warn(`[Store] 🗑 已丢弃时光机备份 ${slotKey}：${reason}，禁止用它覆盖当前数据`);
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
        if (this._isClearPending(key)) return;         // 正在清空：备份也不许复活旧数据
        const slot = this._readBackupSlot(key);
        if (!slot) return;
        /* 🔒 用户主动从离线资源库载入的数据带 userModified 标记（最高优先级）：
           刷新时任何备份都不许覆盖它。云端那条路由 _applyCloud 的视图优先级锁挡住。 */
        if (this.isUserModified(key)) {
          console.log(`[Store] 🔒 ${key} 带 userModified 标记，跳过时光机备份恢复（当前视图优先）`);
          return;
        }
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
    if (this._isClearPending(key)) return false;      // 正在清空：绝不允许备份把旧数据复活
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
    /* ⛔ 游客模式（只读身份）：重要表单也不写云端。
       必须在最前面拦：一旦走到后面，就会打上"保护锁"并留下待推记录，
       锁留在盘上会挡住云端把最新数据同步下来，游客反而看到过期数据。 */
    if (!this._canWriteCloud()) {
      const reason = '游客只能查看数据，修改请先点击右上角登录';
      console.warn(`[Store] ⛔ 重要数据 ${key} 未写入云端：${reason}`);
      if (typeof window !== 'undefined' && typeof window.Auth?.notifyGuest === 'function') {
        window.Auth.notifyGuest(reason);
      }
      this._dispatchSync([key], { localWrite: true, cloudConfirmed: false, critical: true });
      return { ok: false, mode: this.mode, localSaved: true, error: reason, adminRequired: true };
    }
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
      if (clearIntent) {
        // 清空走【专属通道】：_persist 的死规则是"空载荷永远不发"
        await this._persistClear(key);
      } else {
        await this._persistWithRetry(key, saved, attempts, { at: lockEntry.at });   // ③ 到这里才发网络请求
      }
      this._clearUnconfirmed(key);
      console.log(`[Store] ✅ ${key} 已写入云端并确认`);
      // 通知所有模块立刻重取（赛程编排不用等下次轮询就能看到新报名）
      this._dispatchSync([key], { localWrite: true, cloudConfirmed: true, critical: true });
      return { ok: true, mode: this.mode, localSaved: true };
    } catch (error) {
      const netFail = isNetworkFailure(error);
      const failed = this._pendingWrites.get(key);
      if (failed) {
        if (!netFail) failed.attempts = (failed.attempts || 0) + 1;   // 断网不计失败次数
        failed.lastError = error?.message || String(error);
        failed.critical = true;
        this._writeLock(key, failed);            // 锁保持（重要表单永不上交云端旧数据）
      }
      if (netFail) {
        console.warn(`[Store] 🌐 网络不可用：重要数据 ${key} 已完整保留在本机，未写入云端；不弹窗，1 分钟后自动续传`);
      }
      this._scheduleCriticalRetry(key);          // 断网时这里自动变成 1 分钟一次的长间隔
      if (!netFail) this._onPersistError(key, error);   // 网络失败完全静默，业务错误才提示
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
        if (isNetworkFailure(error)) throw error;   // 断网不做短间隔重试，交给 1 分钟级续传
        if (attempt < attempts) await this._delay(RETRY_DELAY);
      }
    }
    throw lastError;
  },

  /** 重要表单云端确认失败后的后台续传：按 CRITICAL_RETRY_DELAYS 逐步退避，成功即解除保护 */
  _scheduleCriticalRetry(key) {
    if (typeof window === 'undefined') return;
    /* ⛔ 彻底堵死：静默本地模式 / 加载离线资源 / 生成中 / 断网离线 期间，
       _restoreUnconfirmed 恢复出来的历史积压一律【连定时器都不设】。
       以前只在 runNext 里重排定时器，静默 10 秒一过期照样 POST 502。
       解冻或 online 事件时由 _resumeBackgroundPushes() / handleOnline() 统一重新排队。 */
    const blockedNow = this._backgroundPushBlocked();
    if (blockedNow) {
      this._criticalTimers.delete(key);
      console.log(`[Store] ⏸ ${key} 的历史补推已忽略（${blockedNow}）：不排定时器、不发 POST`);
      return;
    }
    if (this._criticalTimers.has(key)) return;
    let step = 0;
    const runNext = async () => {
      const entry = this._pendingWrites.get(key);
      if (!entry) { this._criticalTimers.delete(key); return; }
      /* ⏸ 生成大单元 / 载入离线资源 / 云端暂停 / 断网期间：一个 POST 都不发，
         并且【不再重排定时器】—— 直接摘掉句柄，等解冻或 online 事件重新排队。 */
      const blocked = this._backgroundPushBlocked();
      if (blocked) {
        this._criticalTimers.delete(key);
        console.log(`[Store] ⏸ ${key} 的后台补推已中止：${blocked}`
          + '（数据与保护锁保留，解冻或 online 事件后自动重新排队）');
        return;
      }
      try {
        const sent = await this._persistEntry(key, entry);
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
        const netFail = isNetworkFailure(error);
        if (!netFail) entry.attempts = (entry.attempts || 0) + 1;
        entry.lastError = error?.message || String(error);
        this._writeLock(key, entry);
        if (netFail) {
          /* 断网：不消耗 step（不会 4 次就耗尽停摆），统一 1 分钟后再试一次 */
          this._criticalTimers.set(key, setTimeout(runNext, OFFLINE_RETRY_MS));
          return;
        }
        step += 1;
        if (step >= CRITICAL_RETRY_DELAYS.length) {
          this._criticalTimers.delete(key);
          console.warn(`[Store] ${key} 仍未写入云端，数据已完整保留在本机，联网后会自动继续重试（不要再刷新或清理浏览器数据）`);
          return;
        }
        this._criticalTimers.set(key, setTimeout(runNext, CRITICAL_RETRY_DELAYS[step]));
      }
    };
    this._criticalTimers.set(key, setTimeout(runNext,
      this.isOfflineMode() ? OFFLINE_RETRY_MS : CRITICAL_RETRY_DELAYS[0]));
  },

  async _persistSafely(key, value, options = {}) {
    /* ⛔ 游客模式：不推云端（连请求都不发） */
    if (!this._canWriteCloud()) {
      console.warn(`[Store] ⛔ ${key} 未推送云端：当前是游客模式（只读）`);
      return;
    }
    try {
      const sent = await this._persist(key, value, options);
      if (sent === false) return;          // 空数据被闸门拦下（锁已在里面交出），无需重试
      this._clearUnconfirmed(key);
    } catch (error) {
      /* 游客（未登录管理员）被后端 403：不是写入失败，安静放行，
         免得把"权限不足"报成"同步失败（可能是数据结构冲突）"。 */
      if (error?.adminRequired) {
        console.warn(`[Store] ⛔ ${key} 未写入云端：未登录管理员（游客只读）`);
        this._clearUnconfirmed(key);
        return;
      }
      // 服务端没配 Supabase：安静地退回纯本地模式，不打扰用户
      if (error && error.status === 503) {
        this.cloudState = 'off';
        this.mode = 'local';
        this._clearUnconfirmed(key);
        return;
      }
      /* 🌐 断网：数据静默留在本地待写队列 —— 不计失败次数、不熔断、不弹窗，
         只排 1 分钟一次的长间隔续传。 */
      if (isNetworkFailure(error)) {
        const queued = this._pendingWrites.get(key) || { value, at: Date.now(), attempts: 0 };
        queued.lastError = error?.message || String(error);
        this._pendingWrites.set(key, queued);
        this._writeLock(key, queued);
        console.warn(`[Store] 🌐 网络不可用：${key} 已静默保存在本地待写队列`
          + `（共 ${this._pendingWrites.size} 条），不弹窗、不计数、不熔断`);
        if (queued.critical) this._scheduleCriticalRetry(key);
        return;
      }
      const entry = this._pendingWrites.get(key) || { value, at: Date.now(), attempts: 0 };
      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastError = error?.message || String(error);
      // ⛔ 连续失败超过上限 → 熔断（和 _flushPending 同一把尺子）：
      //    不再重试、不再排队，但本地数据与保护锁都留着，云端覆盖不到它。
      if (entry.attempts >= MAX_PERSIST_ATTEMPTS) {
        this._markPersistFailed(key, entry, error);
        return;
      }
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
      // 本次"明确要删掉的 id"：补推时要用（服务端只删这些）
      deletedIds: Array.isArray(options.deletedIds) ? options.deletedIds : (prev?.deletedIds || []),
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
      /* 🔒 用户刚主动载入的资源是最高优先级：这个键的历史保护锁全部作废，
         绝不允许「旧缓存 + 未确认锁」在刷新后诈尸、把新资源顶掉。 */
      if (this.isViewPinned(key)) {
        try { localStorage.removeItem(lockKey); } catch (error) { /* 忽略 */ }
        this._pendingWrites.delete(key);
        this._deferredWrites.delete(key);
        console.log(`[Store] 🔒 ${key} 有视图优先级锁，历史保护锁已作废（不会重新排队补推）`);
        return;
      }
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
      /* ⛔ 过期的"清空指令"直接作废：
         清空意图会留在 localStorage 的保护锁里。手机端几个月前的一次删除留下的"清空锁"，
         会在某次刷新时突然生效 → 把云端当天的教案删光。
         现在超过 CLEAR_LOCK_TTL_MS 的清空锁一律作废，绝不再执行。 */
      if (info?.clear === true && Date.now() - (info?.at || 0) > CLEAR_LOCK_TTL_MS) {
        try { localStorage.removeItem(lockKey); } catch (error) { /* 忽略 */ }
        console.warn(`[Store] ⛔ ${key} 的清空锁已过期，已作废（不会再删云端数据）`);
        return;
      }
      /* ⛔ 本地这份是空的 → 这把锁护不住任何东西，反而会坏事：
         ① 它会让之后的每次云端同步都跳过这个键 → 手机端明明能从云端拉到教案，却一直显示空的；
         ② 它还会被当成"待补推的写入" → 把空数据推回云端 → 反向把云端洗成 0 条。
         所以空值的锁直接作废（除非它明确带着 clear:true —— 那是用户亲手清空，要保留）。 */
      if (!this._hasContent(key, value) && info?.clear !== true) {
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
      /* 之前被熔断的键（failed 标记）：不要再自动补推（会变成无限重试），
         但【必须继续保护】本地这份 —— 云端的空数据绝不能覆盖它。 */
      if (info?.failed) {
        this._failedWrites.set(key, { attempts: info?.attempts || 0, lastError: '上次写入云端失败已熔断', at: info?.at || Date.now(), value });
        this._pendingWrites.delete(key);
        console.warn(`[Store] ⛔ ${key} 上次写入云端失败已熔断，本地数据继续保留，刷新后不再自动重试（需要时执行 Store.retryFailedKeys()）`);
        return;
      }
      console.warn(`[Store] ⛔ 检测到「${key}」上次写入云端未确认（${Math.round((Date.now() - (info?.at || Date.now())) / 1000)} 秒前），本地数据已上锁保护，云端不得覆盖`);
      /* 🌐 之前被 deferPendingQueue() 延期隔离的历史队列：刷新后仍回延期区，
         不立刻重推，等 online 事件 / Store.handleOnline() 才放回待写队列。 */
      if (info?.deferred) {
        this._pendingWrites.delete(key);
        this._deferredWrites.set(key, {
          value, at: info?.at || Date.now(), critical: Boolean(info?.critical),
          clear: Boolean(info?.clear), attempts: info?.attempts || 0,
          label: info?.label || '', deferredAt: Date.now(),
          deferredReason: info?.deferredReason || '刷新后续延',
        });
        console.warn(`[Store] 🌐 ${key} 仍处于延期隔离（本地离线查看优先），不自动补推；online 事件后恢复`);
        return;
      }
      /* ⏸ 页面一启动就把整批旧队列重推出去，正是「满屏 _restoreUnconfirmed +
         _scheduleCriticalRetry 把本地 Node 服务器打挂」的源头。
         生成中 / 载入中 / 静默本地 / 断网离线时只上锁保护，不补推；
         解冻或 online 事件后由 _resumeBackgroundPushes() / handleOnline() 重新排队。 */
      const blocked = this._backgroundPushBlocked();
      if (blocked) {
        console.warn(`[Store] ⏸ ${key} 本次只上锁保护、不自动补推：${blocked}`);
        return;
      }
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
        /* 🔒 视图优先级锁：别的页面残留的历史锁不许把旧数据重新挂回待写队列。
           这里只跳过重建（用户本会话新写入的锁仍在内存队列里，不会被误删）。 */
        if (this.isViewPinned(key)) continue;
        if (this._pendingWrites.has(key)) continue;         // 本实例已知道，不重复
        let info = {};
        try { info = JSON.parse(localStorage.getItem(lockKey) || '{}'); } catch (error) { info = {}; }
        const value = this._readLocalValue(key);
        if (value === undefined || value === null) continue;
        // 同上：本地这份为空时不上锁（空锁会挡住云端数据落地，还会被当成待补推把空推回云端）
        if (!this._hasContent(key, value) && info?.clear !== true) continue;
        // 被熔断的键：只保护、不重排队（否则刷新后又变成无限重试）
        if (info?.failed) {
          this._failedWrites.set(key, { attempts: info?.attempts || 0, lastError: '写入云端失败已熔断', at: info?.at || Date.now(), value });
          continue;
        }
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
   * 这个值算不算"空载荷"（绝不允许推到云端的那种空）。
   * ⛔ 空对象 / 空数组 / null / 空字符串一律算空载荷 —— 它们推上去就是"把云端洗成 0 条"。
   */
  _isEmptyPayloadForPush(key, value) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (this._isPlainObject(value)) {
      if (this._isMeetKey(key)) return !this._hasContent(key, value);  // 运动会：报名 0 条 = 空
      return Object.keys(value).length === 0;
    }
    return !String(value).trim();
  },

  /**
   * 推送到云端的唯一出口。
   * ⛔ 云端之所以会被洗成 0 条，绝大多数是"某个页面内存里恰好是空快照，又把它整体写回去了"。
   *    所以这里设一道闸门：本机这份数据是空的，一律不许推，也不许反复重试。
   *    ⚠️ 这道闸门对【所有键】生效（不只是运动会数据）——
   *       「手机端刷新 → 云端教案凭空消失」就是因为 lesson_plans 漏了这道闸门。
   *    唯一例外 options.allowEmpty —— 用户在界面上亲手点的清空 / 删除（clearIntent / force）。
   */
  async _persist(key, value, options = {}) {
    // ⏸ 暂停期间不往云端推任何东西（强行恢复后想推，请先 window.resumeCloud()）
    if (this._cloudPaused) return false;
    /* ⛔ 游客模式：一个字节都不发。
       后台静默同步（补推待写队列 / 断点续传）也会走到这里 ——
       游客模式下这些请求直接跳过，就不会出现 403，也就不会触发任何弹窗提示。 */
    if (!this._canWriteCloud()) {
      console.warn(`[Store] ⛔ ${key} 未写入云端：当前是游客模式（只读）`);
      return false;
    }
    /* ⛔ 死规则（最高优先级）：空载荷【永远不发】—— 不管有没有 clearIntent。
       清空云端只能走 _persistClear() 这条专属通道（只有界面上的【清空按钮】会调它）。
       ⚠️ 以前 _flushPending 会拿 "allowEmpty: entry.clear === true" 绕开闸门，
          结果手机端上那条几周前的"清空锁"会在某次刷新时突然把云端的教案删光。 */
    if (this._isEmptyPayloadForPush(key, value)) {
      console.warn(`[Store] ⛔ 本机 ${key} 是空的，已拦下这次云端推送`
        + '（空载荷永远不发往云端；要在云端清空请用界面上的【清空按钮】）');
      this._clearUnconfirmed(key);
      const timer = this._criticalTimers.get(key);
      if (timer) { clearTimeout(timer); this._criticalTimers.delete(timer); }
      return false;
    }
    // 写入同样带超时：网络挂起时不会一直 pending，失败会进入待写队列
    // snapshotAt：这份本地快照是什么时候生成的 —— 服务端据此判断"哪些行比我新"，
    // 两端同时在线时，另一台设备在我快照之后写进去的行一个都不会被删。
    const rawAt = options.at ?? this._pendingWrites.get(key)?.at;
    const snapshotAt = typeof rawAt === 'number'
      ? new Date(rawAt).toISOString()
      : (rawAt || new Date().toISOString());
    // deletedIds：本次"明确要删掉"的 id —— 服务端只删这些，
    //   绝不按"这次 payload 里没带的"去推断旧行（旧快照会误删别人的新数据）。
    const body = JSON.stringify({
      key,
      value,
      deletedIds: Array.isArray(options.deletedIds) ? options.deletedIds : [],
      snapshotAt,
    });
    /* ④ 诊断日志：每个 POST 发出前都把体积打出来，方便在控制台定位 502。
       Blob.size 是真实 UTF-8 字节数；Node / 老环境回退到字符数（中文会低估，仅作参考）。 */
    let bodyBytes = body.length;
    if (typeof Blob !== 'undefined') {
      try {
        const size = new Blob([body]).size;
        if (typeof size === 'number' && size > 0) bodyBytes = size;
      } catch (error) { /* 忽略，用字符数 */ }
    }
    console.log(`[Store] Payload 大小: ${(bodyBytes / 1024).toFixed(1)} KB`, `（key=${key}）`);
    if (bodyBytes > 4 * 1024 * 1024) {
      console.warn(`[Store] ⚠️ ${key} 的 Payload 超过 4MB，可能被网关/Vercel 拒绝（502/413）。`
        + ' 数据仍完整保留在本机；请精简数据后重试，或在控制台执行 Store.retryFailedKeys()。');
    }
    await this._fetchJSON('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return true;
  },

  /**
   * 清空云端某张表 —— 【唯一】被允许"把云端清空"的通道。
   * 只有界面上的【清空按钮】/【删光最后一条】才会走到这里；
   * 自动同步、补推、修复流程【一律】不许调用。
   */
  async _persistClear(key) {
    if (this._cloudPaused) return false;
    /* ⛔ 游客模式：不清云端（也不发请求）。清空是写操作，游客一律无权。 */
    if (!this._canWriteCloud()) {
      console.warn(`[Store] ⛔ ${key} 的云端清空未执行：当前是游客模式（只读）`);
      return false;
    }
    await this._fetchJSON('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        value: null,
        clear: true,
        clearIntent: true,
        snapshotAt: new Date().toISOString(),
      }),
    });
    return true;
  },

  /**
   * 补推一条待写记录（_flushPending 与后台续传共用）。
   * ⛔ 同样执行死规则：空载荷永远不发；
   *    清空意图只走 _persistClear，且只认 CLEAR_LOCK_TTL_MS 之内的新鲜指令。
   */
  async _persistEntry(key, entry) {
    /* ⛔ 游客模式：补推 / 续传一律跳过（不发请求 → 不会 403 → 不会弹窗） */
    if (!this._canWriteCloud()) {
      console.warn(`[Store] ⛔ ${key} 的待补推已跳过：当前是游客模式（只读）`);
      return false;
    }
    if (entry.clear === true) {
      const age = Date.now() - (entry.at || 0);
      if (age > CLEAR_LOCK_TTL_MS) {
        console.warn(`[Store] ⛔ ${key} 的清空指令已过期（约 ${Math.round(age / 60000)} 分钟前），不再执行`
          + '（防止几天前的清空锁把今天的云端数据删掉）');
        this._clearUnconfirmed(key);
        return false;
      }
      await this._persistClear(key);
      this._clearUnconfirmed(key);
      console.log(`[Store] 已把 ${key} 的清空指令推送到云端`);
      return true;
    }
    if (this._isEmptyPayloadForPush(key, entry.value)) {
      console.warn(`[Store] ⛔ ${key} 这份数据是空的，绝不发往云端（已丢弃这次补推）`);
      this._clearUnconfirmed(key);
      return false;
    }
    const sent = await this._persist(key, entry.value, { at: entry.at, deletedIds: entry.deletedIds });
    if (sent === false) return false;
    this._clearUnconfirmed(key);
    return true;
  },

  /**
   * 补推之前失败的写入。只补推"新鲜"的那部分——
   * 过期的已经在 _dropStalePending 里丢掉，绝不会把本地旧数据推上去覆盖云端
   *
   * ⛔ 熔断：同一个键连续失败超过 MAX_PERSIST_ATTEMPTS 次（默认 3 次），
   *    就把它从队列里摘掉、停止重试，并打印红色错误。
   *    以前这里是"失败了就留着，下一轮同步接着推" —— 碰上 502（表结构冲突 / 字段类型不对）
   *    就是无限重试：每一轮都往服务端打一次 POST，把请求队列和日志刷满，
   *    老师看到的现象就是"上传完数据后页面一直在转，什么也传不上去"。
   *    现在：3 次失败就熔断，数据完整留在本地并保持上锁（云端覆盖不到它），
   *    老师可以用 Store.retryFailedKeys() 手动重来，或修好表结构后刷新页面再试。
   */
  async _flushPending() {
    if (!this._pendingWrites.size) return;
    /* ⏸ 生成中 / 载入离线资源 / 云端暂停：整批补推直接跳过，一个 POST 都不发。
       队列与锁原样保留，解冻后 _resumeBackgroundPushes() 会重新排队，不会丢数据。 */
    const blocked = this._backgroundPushBlocked();
    if (blocked) {
      console.log(`[Store] ⏸ 跳过本次待写队列补推：${blocked}（${this._pendingWrites.size} 条原样保留）`);
      return;
    }
    /* ⛔ 游客模式：整个补推队列直接跳过。
       这是"每切一个页面就弹一次登录框"的直接来源：
       每次同步结束都会调 _flushPending 补推盘上残留的待写记录，
       游客发出去必然 403 → 于是弹窗。游客模式下干脆一个请求都不发。 */
    if (!this._canWriteCloud()) {
      console.warn('[Store] ⛔ 游客模式：已跳过本次待写队列补推（不发任何写请求）');
      return;
    }
    for (const [key, entry] of [...this._pendingWrites]) {
      try {
        // ⛔ 死规则在这里同样生效：空载荷永远不发；清空只走 _persistClear 且必须新鲜
        const sent = await this._persistEntry(key, entry);
        if (sent === false) continue;      // 空数据被拦下，锁已在闸门里交出
        this._clearUnconfirmed(key);
        console.log(`[Store] 已补推 ${key} 到云端`);
      } catch (error) {
        // 游客被权限拦下：停止补推，交给下一次同步用云端数据覆盖本地
        if (error?.adminRequired) {
          console.warn(`[Store] ⛔ ${key} 补推未执行：未登录管理员（游客只读）`);
          this._clearUnconfirmed(key);
          continue;
        }
        /* 🌐 断网：不计失败次数、不熔断、不弹窗，数据留在本地队列等联网续传 */
        if (isNetworkFailure(error)) {
          entry.lastError = error?.message || String(error);
          this._writeLock(key, entry);
          console.warn(`[Store] 🌐 网络不可用：${key} 补推暂缓，数据保留在本地队列（1 分钟后再试）`);
          if (entry.critical) this._scheduleCriticalRetry(key);
          continue;
        }
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastError = error?.message || String(error);
        // 连续失败超过上限 → 熔断：出队、不再重试，但【保留本地数据与保护锁】
        if (entry.attempts >= MAX_PERSIST_ATTEMPTS) {
          this._markPersistFailed(key, entry, error);
          continue;
        }
        this._writeLock(key, entry);
        console.warn(`[Store] 补推 ${key} 仍未成功（第 ${entry.attempts} 次），数据保留在本地`, error);
        // 重要表单：继续排后台续传，绝不因为补推失败就丢
        if (entry.critical) this._scheduleCriticalRetry(key);
      }
    }
  },

  /**
   * 熔断一个反复写不上去的键：
   *   ① 从待写队列摘掉（停止重试）
   *   ② 在保护锁上打 failed 标记（刷新后也不再自动重试，但要继续保护本地数据不被云端覆盖）
   *   ③ 打印红色错误，把恢复办法一起告诉老师
   */
  _markPersistFailed(key, entry, error) {
    const message = error?.message || String(error);
    /* 🌐 断网不是「数据结构冲突」，绝不能熔断锁死这个键：
       把数据放回待写队列、重写不带 failed 标记的保护锁，等联网后自动续传。 */
    if (isNetworkFailure(error)) {
      this._pendingWrites.set(key, entry);
      this._writeLock(key, { ...entry, attempts: 0, failed: false });
      console.warn(`[Store] 🌐 网络不可用：${key} 不熔断、不弹窗，数据留在本地待写队列（1 分钟后重试）`);
      this._scheduleCriticalRetry(key);
      return;
    }
    this._failedWrites.set(key, {
      attempts: entry.attempts || 0,
      lastError: message,
      at: Date.now(),
      value: entry.value,
    });
    // 出队（不再重试），但不调 _clearUnconfirmed —— 保护锁必须留着，
    // 否则云端那份空数据会立刻覆盖掉本地这份真实数据
    this._pendingWrites.delete(key);
    const timer = this._criticalTimers.get(key);
    if (timer) { clearTimeout(timer); this._criticalTimers.delete(key); }
    // 锁上打标记：刷新后 _restoreUnconfirmed 会看到 failed，跳过自动补推（但仍然保护本地）
    try {
      const raw = localStorage.getItem(this._lockKeyOf(key));
      const info = raw ? JSON.parse(raw) : {};
      localStorage.setItem(this._lockKeyOf(key), JSON.stringify({
        ...info, at: info.at || Date.now(), failed: true, attempts: entry.attempts || 0,
      }));
    } catch (error) { /* 忽略：打标记失败不影响熔断本身 */ }
    console.error(
      `[Store] ⛔ 数据同步失败，可能是数据结构冲突：${key} 连续 ${entry.attempts} 次写入云端失败，已停止重试。`
      + ` 数据完整保留在本机，云端不会覆盖它。`
      + ` 最后一次错误：${message}`
      + ` —— 修复办法：检查 Supabase 表结构（主键 id 是否为 text、是否有重复行）后，`
      + ` 在控制台执行 Store.retryFailedKeys() 重推，或直接刷新页面重试。`,
    );
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(`${key} 同步失败（可能是数据结构冲突），已停止重试；数据仍在本机，修复表结构后重试即可`, 'error');
    }
  },

  /**
   * 手动重推被熔断的键（控制台：Store.retryFailedKeys()）
   * 先把本地数据重新放进待写队列，再立刻补推一次。
   */
  async retryFailedKeys() {
    const keys = [...this._failedWrites.keys()];
    if (!keys.length) {
      console.log('[Store] 没有被熔断的键');
      return { ok: true, count: 0 };
    }
    keys.forEach(key => {
      const failed = this._failedWrites.get(key);
      this._failedWrites.delete(key);
      const value = failed?.value ?? this._readLocalValue(key);
      if (value === undefined || value === null) return;
      this._markUnconfirmed(key, value, { clear: Boolean(failed?.clear) });
      this._pendingWrites.get(key).attempts = 0;     // 重新计数
    });
    await this._flushPending();
    console.log(`[Store] 已重推 ${keys.length} 个被熔断的键`);
    return { ok: true, count: keys.length };
  },

  /** 被熔断的键清单（控制台排查用） */
  getFailedWrites() {
    return [...this._failedWrites.entries()].map(([key, info]) => ({
      key, attempts: info.attempts, lastError: info.lastError, at: info.at,
    }));
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
    /* 世代号同时落到 localStorage：这是给兄弟 iframe 看的"明确的清空指令"。
       没有它，兄弟页面会把这次清空当成"对方还在初始化、手上正好是空快照"，
       按防污染规则无视掉 —— 用户眼里就是"点了清空，隔壁 Tab 数据还在"。
       ⚠️ keys 清单让兄弟页面一次清掉全部 4 个键（以前它只清"触发 storage 事件的那一个"）。 */
    this._writePurgeSignal(MEET_DATA_KEYS);
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

  /**
   * ⛔ 这个键是不是正处在「用户亲手清空」的流程里？
   *   · 清空还没被云端确认 → 保护期内（旧数据不复活、不反推）
   *   · 云端已确认清空   → 只留一小段沉降期，挡住"清空前发出、清空后才回来"的旧结果
   * 保护期最长 CLEAR_LOCK_TTL_MS：超过就恢复正常同步（并提示用户重试清空）。
   */
  _isClearPending(key) {
    const entry = this._pendingClearKeys.get(key);
    if (!entry) return false;
    const limit = entry.confirmedAt ? CLEAR_SETTLE_MS : CLEAR_LOCK_TTL_MS;
    if (Date.now() - (entry.confirmedAt || entry.at) > limit) {
      this._pendingClearKeys.delete(key);
      return false;
    }
    return true;
  },

  /**
   * 清空云端失败后的后台补清：断网/超时的情况下，稍后再试一次。
   * 补清成功前，「清空中」标记一直有效 —— 本地绝不会被旧数据顶回来。
   */
  _scheduleClearRetry(key, label = key) {
    if (typeof window === 'undefined') return;
    if (this._clearRetryTimers.has(key)) return;
    const delays = [3000, 10000, 30000];
    let step = 0;
    const runNext = async () => {
      this._clearRetryTimers.delete(key);
      try {
        const sent = await this._persistClear(key);
        if (sent !== false) {
          this._pendingClearKeys.set(key, { at: Date.now(), confirmedAt: Date.now() });
          console.log(`[Store] ✅ ${label} 的云端清空已在后台补成功`);
          if (typeof window.showToast === 'function') window.showToast(`${label}的云端数据已补清`, 'success');
          this._dispatchSync([key], { reason: 'clearKeyRetry', cleared: true, cloudCleared: true });
          return;
        }
      } catch (error) {
        console.warn(`[Store] ${label} 的云端清空重试失败：${error?.message || error}`);
      }
      step += 1;
      if (step >= delays.length) {
        console.warn(`[Store] ${label} 的云端清空多次失败：请联网后再次点击清空按钮，`
          + `或在控制台执行 Store.clearKey('${key}')`);
        return;
      }
      this._clearRetryTimers.set(key, setTimeout(runNext, delays[step]));
    };
    this._clearRetryTimers.set(key, setTimeout(runNext, delays[0]));
  },

  /**
   * 清空单个存储键（用户亲手清空）——【体测数据一键清空】用的专属通道。
   *
   * 一次做完全套，绝不留下任何"能复活旧数据"的痕迹：
   *   ① 内存缓存            → cache.delete
   *   ② localStorage 镜像   → removeItem(key)
   *   ③ 本地备份（时光机）  → removeItem(key__local_backup) + removeItem(备份分槽)
   *   ④ 防覆盖锁            → _clearUnconfirmed(key)（内存队列 + 盘上的锁一起解除）
   *   ⑤ 云端数据库          → POST /api/data { key, value:null, clear:true, clearIntent:true }
   *
   * ⛔ 绝不触发「反推自愈」：
   *   · 世代号 +1 —— 清空之前发出、清空之后才回来的同步结果直接作废；
   *   · 「清空中」标记 —— 云端回来的旧数据不复活到本地，也不会被反推回云端；
   *   · 本地先洗地、云端后清 —— 即使云端清空失败，本地也不会再被旧数据顶回来。
   *
   * ⚠️ 只清传进来的这一个键：学生名单、教案、课表、考勤等其它数据一律不动。
   *
   * @param {string} key Store 管理的存储键名
   * @param {{label?:string, attempts?:number}} options label 只用于提示文案
   * @returns {Promise<{ok:boolean, mode:string, key:string, label:string, cloudCleared:boolean, error?:string}>}
   */
  async clearKey(key, options = {}) {
    if (!STORE_KEYS.includes(key)) {
      throw new Error(`未知的存储键：${key}（只允许清空 Store 管理的键）`);
    }
    /* 用户亲手清空是明确的更高优先级指令：先解除视图优先级锁，别让清空失效 */
    this.unpinLocalView(key, '用户明确清空该键');
    const label = options.label || key;
    const attempts = options.attempts ?? 2;

    // ① 世代号 +1：作废所有还在飞的同步结果（别让它们把刚清掉的数据写回来）
    this._purgeEpoch += 1;
    this._purgeEpochSeen = this._purgeEpoch;
    // ② 标记「清空中」：云端回来的旧数据不复活，也不反推回云端
    this._pendingClearKeys.set(key, { at: Date.now() });
    // ③ 跨文档清空指令：兄弟 iframe / 其它标签页跟着清空
    this._writePurgeSignal([key]);

    // ④ 本地洗地：内存 → 待写队列/锁 → localStorage 镜像 → 备份
    this.cache.delete(key);
    this._localWrites.delete(key);
    this._failedWrites.delete(key);
    this._clearUnconfirmed(key);                     // 解除防覆盖锁（内存队列 + 盘上的锁）
    const timer = this._criticalTimers.get(key);
    if (timer) { clearTimeout(timer); this._criticalTimers.delete(key); }
    try { localStorage.removeItem(key); } catch (error) { /* 忽略 */ }
    try { localStorage.removeItem(`${key}__local_backup`); } catch (error) { /* 忽略 */ }
    // 时光机备份的"分槽"那一份（pe_sports_meet_backup_v1::<key>）
    try { localStorage.removeItem(this._backupKeyOf(key)); } catch (error) { /* 忽略 */ }
    // ⚠️ 裸备份键 pe_sports_meet_backup_v1 装的是【运动会主数据】，只有清它自己时才动
    if (this._isCountableMeetKey(key)) {
      try { localStorage.removeItem(MEET_BACKUP_KEY); } catch (error) { /* 忽略 */ }
    }

    // ⑤ 清云端：走【专属清空通道】—— 只有带 clearIntent 的空载荷才被允许写进云端
    let cloudCleared = false;
    let cloudSkipped = false;
    let error = null;
    if (this.cloudState === 'off') {
      // 纯本地模式（服务端没配 Supabase）或当前离线：没有云端可清，别傻等
      cloudSkipped = true;
      error = '云端存储未连接（服务端未配置 Supabase，或网络不可用）：本次只清空了本地数据';
    } else {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const sent = await this._persistClear(key);
          cloudCleared = sent !== false;
          error = cloudCleared ? null : '云端同步处于暂停状态，本次没有真正清空云端';
          break;
        } catch (clearError) {
          error = clearError?.message || String(clearError);
          if (attempt < attempts) await this._delay(RETRY_DELAY);
        }
      }
    }

    if (cloudCleared) {
      // 云端已确认清空 → 只留一小段沉降期，挡住"清空前发出、清空后才回来"的旧结果
      this._pendingClearKeys.set(key, { at: Date.now(), confirmedAt: Date.now() });
      console.log(`[Store] 🧹 已清空 ${label}（本地 + 云端）`);
    } else if (cloudSkipped) {
      // 没有云端可清：保护标记留着（本地不会被旧数据顶回来），但不做无谓的后台重试
      console.warn(`[Store] ⚠️ ${label} 本地已清空，但${error}`);
    } else {
      // 云端没清掉：保护标记继续有效（本地不会被旧数据顶回来），并在后台补清
      this._scheduleClearRetry(key, label);
      console.warn(`[Store] ⚠️ ${label} 本地已清空，但云端清空失败：${error}（后台会自动补清）`);
    }

    // ⑥ 通知页面重绘（成绩列表 / 统计 / 排名都会立刻变成空）
    this._dispatchSync([key], { reason: 'clearKey', cleared: true, cloudCleared });
    return {
      ok: cloudCleared, mode: this.mode, key, label, cloudCleared, cloudSkipped,
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

  /* ---------------- 脏队列清理 / 后台上传暂停 ---------------- */

  /** 是不是本地开发环境（只有 localhost 才允许自动丢弃旧队列，线上绝不自动清） */
  _isLocalDevHost() {
    try {
      const loc = (typeof window !== 'undefined' && window.location)
        || (typeof location !== 'undefined' ? location : null);
      const host = String(loc?.hostname || '').toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    } catch (error) {
      return false;
    }
  },

  /**
   * 🧹 localhost 启动自清：盘上残留保护锁 > LOCAL_QUEUE_DIRTY_LIMIT 条时，
   * 说明是之前 502 反复失败攒下来的脏队列（每次刷新都会重推，把本地 Node 服务器打挂）。
   * 必须在 _restoreUnconfirmed() 之前调用，否则刚清完又被盘上的锁恢复回来。
   */
  _autoClearDirtyQueue() {
    if (!this._isLocalDevHost()) return 0;
    let locks = 0;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(UNCONFIRMED_LOCK_PREFIX)) locks += 1;
      }
    } catch (error) {
      return 0;
    }
    if (locks <= LOCAL_QUEUE_DIRTY_LIMIT) return 0;
    console.warn(`[Store] 🧹 localhost 启动检测到 ${locks} 条残留保护锁（阈值 ${LOCAL_QUEUE_DIRTY_LIMIT}）`
      + '，判定为旧 502 留下的脏待写队列，全部丢弃，不再自动补推');
    this.clearPendingQueue(`localhost 脏队列 ${locks} 条`, { allLocks: true });
    return locks;
  },

  /**
   * 清空后台重推队列（控制台：Store.clearPendingQueue()）。
   * ⚠️ 只丢「队列 / 续传定时器 / 保护锁 / 熔断记录」；
   *    业务数据（localStorage 主键、cache、物理备份）一个字节都不动。
   * allLocks=true 时连盘上所有未确认锁一起删（启动自清用，防止刷新后复活）。
   */
  clearPendingQueue(reason = 'manual', { allLocks = false } = {}) {
    const count = this._pendingWrites.size;
    const timers = this._pauseCriticalTimers();
    [...this._pendingWrites.keys()].forEach(key => this._clearUnconfirmed(key));
    this._pendingWrites.clear();
    /* 熔断记录里装的就是这批旧失败数据；不清的话，页面初始化的
       autoRecoverStoreCircuit() 会立刻 retryFailedKeys() 又把它们推一遍。 */
    const failed = this._failedWrites.size;
    this._failedWrites.clear();
    const locks = allLocks ? this._clearLocksFromStorage() : 0;
    console.warn(`[Store] 🧹 已清空待写队列（原因：${reason}）：队列 ${count} 条、续传定时器 ${timers} 个、`
      + `熔断 ${failed} 条、盘上锁 ${locks} 个。业务数据仍完整保留在本机，只是不再自动重推；`
      + '需要时手动点保存，或执行 Store.retryPendingWrites()。');
    return count;
  },

  /* ---------------- 🧨 终极清理（控制台一键重置） ---------------- */

  /**
   * 🧨 一键把本机「旧缓存 + 未确认锁 + 后台队列」连根拔起，然后刷新页面。
   *
   * 典型现场：Supabase 后台已经清空，本机却因为断网进了离线模式，
   * localStorage 里的旧缓存 + 历史未确认锁反复把新导入的离线资源顶掉（脏数据诈尸）。
   * 执行 window.hardResetAll() 后：
   *   ① 冻结一切云端同步 / 反推自愈 / 后台补推，并 abort 所有在飞 GET；
   *   ② 停掉全部续传、重连、提示定时器；
   *   ③ 清空内存缓存、待写队列、熔断记录、延期区、清空锁、视图优先级锁；
   *   ④ 洗掉所有相关 localStorage（含 __local_backup、锁、备份分槽、世代号、
   *      生成冻结信号、离线资源小票、分步物理备份、布局/侧栏/待办等）与 sessionStorage；
   *   ⑤ 刷新页面，让 Store 从干净状态重新 start()。
   *
   * 默认保留管理员登录凭据（清掉会导致后续写云端 403）；要连登录态一起清传
   * hardResetAll({ includeAuth: true })。调试时可用 hardResetAll({ reload: false })。
   */
  hardResetAll(options = {}) {
    const { reload = true, includeAuth = false, reason = '控制台 hardResetAll()' } = options || {};

    /* ① 先冻结：在飞的同步结果、后台补推、反推自愈一律不许再落地 */
    this._cloudPaused = true;
    this.syncing = false;
    this._readOnlyPull = false;
    this._healing = false;
    this._generating = false;
    const aborted = this.abortInFlightReads(reason);

    /* ② 停掉所有定时器句柄 */
    let timers = 0;
    this._criticalTimers.forEach(timer => { clearTimeout(timer); timers += 1; });
    this._criticalTimers.clear();
    this._clearRetryTimers.forEach(timer => { clearTimeout(timer); timers += 1; });
    this._clearRetryTimers.clear();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; timers += 1; }
    if (this._slowHintTimer) { clearTimeout(this._slowHintTimer); this._slowHintTimer = null; timers += 1; }

    /* ③ 清空内存缓存与全部锁 / 队列 / 状态 */
    const before = {
      cache: this.cache.size,
      pending: this._pendingWrites.size,
      failed: this._failedWrites.size,
      deferred: this._deferredWrites.size,
      clearLocks: this._pendingClearKeys.size,
      viewPins: this._viewPins.size,
    };
    this.cache.clear();
    this._pendingWrites.clear();
    this._failedWrites.clear();
    this._deferredWrites.clear();
    this._pendingClearKeys.clear();
    this._localWrites.clear();
    this._viewPins.clear();
    this._viewPinEpoch = 0;
    this._backgroundSyncHolds.clear();
    this._inFlightReads.clear();
    this._quietLocalUntil = 0;
    this._quietReason = '';
    this._quietHoldKey = '';
    this._offlineMode = false;
    this._networkFailures = 0;
    this._offlineSince = 0;
    this._reconnectAttempts = 0;
    this._purgeEpoch = 0;
    this._purgeEpochSeen = 0;
    this._lastSyncReport = null;
    this._backedUp = false;
    this._loadingNode = null;
    this._syncPromise = null;
    this.schema = null;
    this.lastSyncAt = null;
    this.lastError = null;
    this.mode = 'local';
    this.cloudState = 'unknown';
    if (typeof window !== 'undefined') {
      try { window.__offlineFromEvent = undefined; } catch (error) { /* 忽略 */ }
    }

    /* ④ 洗地：业务主键 / 备份 / 锁 / 世代号 / 生成信号 / 小票 / 布局 … 一个不留 */
    const removedKeys = this._hardClearLocalStorage({ includeAuth });
    const removedSession = this._hardClearSessionStorage();

    console.warn(`[Store] 🧨 终极清理完成（${reason}）：localStorage ${removedKeys.length} 个键、`
      + `sessionStorage ${removedSession} 个键、内存缓存 ${before.cache} 项、`
      + `待写 ${before.pending} 条 / 熔断 ${before.failed} 条 / 延期 ${before.deferred} 条 / `
      + `清空锁 ${before.clearLocks} 个 / 视图锁 ${before.viewPins} 个、`
      + `定时器 ${timers} 个、在飞 GET ${aborted} 个。`
      + (includeAuth ? '登录凭据也已清除。'
        : '登录凭据已保留（要连登录态一起清用 hardResetAll({includeAuth:true})）。'));

    /* ⑤ 刷新页面：新页面重新 start()，只认云端（或干净的本地）数据 */
    const canReload = reload && typeof window !== 'undefined'
      && typeof window.location?.reload === 'function';
    if (canReload) {
      setTimeout(() => {
        try { window.location.reload(); }
        catch (error) { console.warn('[Store] 页面刷新失败，请手动按 Cmd+Shift+R', error); }
      }, 0);
    }
    return { ok: true, removedKeys, removedSession, cleared: before, timers, aborted, willReload: Boolean(canReload) };
  },

  /**
   * 💥 核弹级清空：控制台执行 window.nukeAllStorage()
   * 与 hardResetAll() 的区别：这里直接 localStorage.clear()，连登录凭据、第三方键、
   * 任何历史备份 / 锁 / 摘要都一个不留，然后刷新页面。
   * 先冻结同步 + abort 在飞 GET 再 clear —— 否则在飞的旧请求结果会把脏数据又写回来。
   */
  nukeAllStorage(options = {}) {
    const { reload = true, reason = '控制台 nukeAllStorage()' } = options || {};
    const pre = this.hardResetAll({ reload: false, includeAuth: true, reason: `${reason}（预清理）` });
    let cleared = 0;
    try {
      cleared = localStorage.length;
      localStorage.clear();
    } catch (error) {
      console.warn('[Store] 💥 localStorage.clear() 失败（可能是隐私模式）', error);
    }
    /* sessionStorage 里的运动会清空提示刷新后也会诈尸，一并清掉 */
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.clear(); } catch (error) { /* 忽略 */ }
    const canReload = reload && typeof window !== 'undefined'
      && typeof window.location?.reload === 'function';
    if (canReload) {
      setTimeout(() => {
        try { window.location.reload(); }
        catch (error) { console.warn('[Store] 页面刷新失败，请手动按 Cmd+Shift+R', error); }
      }, 0);
    }
    console.warn(`[Store] 💥 nukeAllStorage：localStorage.clear() 已执行（约 ${cleared} 个键全部清空，`
      + '含登录凭据与所有历史备份），页面即将刷新');
    return { ok: true, clearedKeys: cleared, preCleared: pre.removedKeys.length, willReload: Boolean(canReload) };
  },

  /** 洗掉所有与本项目相关的 localStorage 键（枚举 + 内置键兜底） */
  _hardClearLocalStorage({ includeAuth = false } = {}) {
    const candidates = new Set([
      ...STORE_KEYS, VIEW_PIN_KEY, UNIT_GENERATING_KEY, MEET_BACKUP_KEY, PURGE_SIGNAL_KEY,
      'pe_offline_resources_pending_v1', `${UNIT_DESIGN_KEY}__step_backup`,
      'pe_sidebar_collapsed', 'pe_sports_meet_sheet_layout', 'pe_todo_v1',
      ...HARD_RESET_MISC_KEYS, ...HARD_RESET_AUTH_KEYS,
    ]);
    STORE_KEYS.forEach(key => candidates.add(`${key}__local_backup`));
    try {
      if (typeof localStorage.key === 'function' && typeof localStorage.length === 'number') {
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key) candidates.add(key);
        }
      }
    } catch (error) { /* 枚举失败时用内置清单继续 */ }
    const removed = [];
    candidates.forEach(key => {
      if (!includeAuth && HARD_RESET_AUTH_KEYS.includes(key)) return;
      const ours = STORE_KEYS.includes(key)
        || key.startsWith('pe_') || key.startsWith('sportsMeet')
        || key.includes('sportsMeet') || key.includes('__local_backup')
        || HARD_RESET_MISC_KEYS.includes(key)
        || (includeAuth && HARD_RESET_AUTH_KEYS.includes(key));
      if (!ours) return;
      try {
        if (localStorage.getItem(key) === null) return;
        localStorage.removeItem(key);
        removed.push(key);
      } catch (error) { /* 隐私模式下可能抛 SecurityError，跳过这一个键 */ }
    });
    return removed;
  },

  /** 洗掉 sessionStorage 里的运动会清空提示等本项目状态 */
  _hardClearSessionStorage() {
    if (typeof sessionStorage === 'undefined') return 0;
    const candidates = new Set(HARD_RESET_MISC_KEYS);
    try {
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (key) candidates.add(key);
      }
    } catch (error) { /* 忽略 */ }
    let removed = 0;
    candidates.forEach(key => {
      const ours = HARD_RESET_MISC_KEYS.includes(key) || key.startsWith('pe_')
        || key.includes('sportsMeet');
      if (!ours) return;
      try {
        if (sessionStorage.getItem(key) === null) return;
        sessionStorage.removeItem(key);
        removed += 1;
      } catch (error) { /* 隐私模式下可能抛 SecurityError，跳过这一个键 */ }
    });
    return removed;
  },

  /** 后台上传是否被暂停：返回原因字符串（空串 = 可以发 POST） */
  _backgroundPushBlocked() {
    if (this._cloudPaused) return '云端同步已暂停';
    if (this.isGenerating()) return '大单元生成中';
    if (this._backgroundSyncHolds.size) return `后台上传已暂停（${[...this._backgroundSyncHolds].join('、')}）`;
    return '';
  },

  /** 停掉所有即将触发的后台续传定时器（队列与锁原样保留，恢复后重排） */
  _pauseCriticalTimers() {
    let stopped = 0;
    this._criticalTimers.forEach(timer => { clearTimeout(timer); stopped += 1; });
    this._criticalTimers.clear();
    return stopped;
  },

  /**
   * ⏸ 暂停所有后台上传重试（生成大单元 / 载入离线资源时用）。
   * 返回一个 release 函数，调用方放在 finally 里保证一定恢复，绝不把 Store 永久冻住。
   */
  pauseBackgroundSync(reason = 'manual') {
    this._backgroundSyncHolds.add(reason);
    const stopped = this._pauseCriticalTimers();
    console.log(`[Store] ⏸ 后台上传重试已暂停（${reason}）：停掉 ${stopped} 个续传定时器，`
      + `待写队列 ${this._pendingWrites.size} 条原样保留`);
    return () => this.resumeBackgroundSync(reason);
  },

  /** ▶ 解除一层暂停；所有原因都解除后才重新排队补推（不丢数据） */
  resumeBackgroundSync(reason = 'manual') {
    const removed = this._backgroundSyncHolds.delete(reason);
    const blocked = this._backgroundPushBlocked();
    console.log(`[Store] ▶ 后台上传重试恢复（${reason}）${blocked ? `，仍被「${blocked}」挡住` : ''}`);
    if (!blocked) this._resumeBackgroundPushes();
    return { ok: removed, blocked };
  },

  /** 解冻后给队列里的重要写入重新排续传（已熔断的、已在排队的都不重复排） */
  _resumeBackgroundPushes({ force = false, all = false } = {}) {
    if (this._backgroundPushBlocked()) return 0;
    // online 自愈时 force=true：此时 cloudState 可能还是 off，但正需要那一发探测请求
    if (!force && this.cloudState === 'off') return 0;
    let scheduled = 0;
    this._pendingWrites.forEach((entry, key) => {
      if (!all && !entry?.critical) return;
      if (this._failedWrites.has(key) || this._criticalTimers.has(key)) return;
      this._scheduleCriticalRetry(key);
      scheduled += 1;
    });
    return scheduled;
  },

  _onPersistError(key, error) {
    /* 🌐 断网：绝不弹红色报错弹窗。只警告，数据已由调用方静默留在本地待写队列，
       联网后 _scheduleCriticalRetry / _flushPending 会自动续传。 */
    if (isNetworkFailure(error)) {
      console.warn(`[Store] 🌐 网络不可用：${key} 本次未写入云端；数据已静默保存在本地待写队列，联网后自动续传（不打扰用户）`);
      return;
    }
    console.error(`[Store] 保存 ${key} 失败`, error);
    const message = error?.message ? String(error.message) : '';
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(`云端保存失败：${message || '请检查 Supabase 配置'}`, 'error');
    }
  },

  /**
   * 一次性回滚快照：只在 forceSyncCloud() 强制拉云端【之前】调用。
   * ⚠️ 不再每次同步都写 17 份（那是冗余镜像堆积的源头）；带时间戳元数据，24 小时后自动清。
   */
  _backupLocal() {
    let saved = 0;
    STORE_KEYS.forEach(key => {
      const raw = localStorage.getItem(key);
      if (raw === null || raw.length > LOCAL_BACKUP_MAX_BYTES) return;
      try { localStorage.setItem(`${key}__local_backup`, raw); saved += 1; } catch (error) { /* 忽略 */ }
    });
    try {
      localStorage.setItem(LOCAL_BACKUP_META_KEY, JSON.stringify({
        at: Date.now(), version: BACKUP_SCHEMA_VERSION, keys: saved,
      }));
    } catch (error) { /* 忽略 */ }
    return saved;
  },

  /** 正常保存成功后删掉这一个键的冗余镜像（主键本身就是最新数据） */
  _dropLocalBackup(key) {
    try { localStorage.removeItem(`${key}__local_backup`); } catch (error) { /* 忽略 */ }
  },

  /** 清空全部 __local_backup 镜像 + 时间戳元数据，返回删掉的镜像条数 */
  _clearLocalBackups() {
    let removed = 0;
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.includes('__local_backup')) keys.push(key);
      }
      keys.forEach(key => { localStorage.removeItem(key); removed += 1; });
      localStorage.removeItem(LOCAL_BACKUP_META_KEY);
    } catch (error) { /* 忽略 */ }
    return removed;
  },

  /** 启动时清理：没有时间戳 / 版本不符 / 超过 24 小时的镜像一律整批删掉 */
  _clearStaleLocalBackups() {
    let meta = {};
    try { meta = JSON.parse(localStorage.getItem(LOCAL_BACKUP_META_KEY) || '{}') || {}; } catch (error) { meta = {}; }
    const at = Number(meta.at || 0);
    const fresh = at > 0 && Date.now() - at <= BACKUP_MAX_AGE_MS
      && (meta.version === undefined || Number(meta.version) === BACKUP_SCHEMA_VERSION);
    if (fresh) return 0;
    const removed = this._clearLocalBackups();
    if (removed) {
      console.warn(`[Store] 🧹 已清理 ${removed} 份过期 / 历史遗留 __local_backup 镜像`
        + '（没有时间戳或超过 24 小时），不再无限期堆积');
    }
    return removed;
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
      /* 云端重建成功 → 一次性回滚快照没用了，立刻清掉，别又变成一堆长期驻留的旧镜像 */
      this._clearLocalBackups();
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
      /* 🔒 带 userModified 标记的数据是用户亲手载入的，连手动 forceRecover 也不许用备份盖掉 */
      if (this.isUserModified(key)) {
        console.warn(`[Store] 🔒 ${key} 带 userModified 标记，forceRecover 跳过（当前视图优先）`);
        return;
      }
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
        backupVersion: slot?.version ?? '旧格式',
        userModified: this.isUserModified(key),
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

  /**
   * 通用数据量（条数）：数组看长度，单例看最大的数组字段，字符串算 1 条。
   * 用来判断"本地这份比云端多不多"——只有本地更全时才值得推回云端。
   */
  _dataSize(value, key = '') {
    if (value === null || value === undefined) return 0;
    if (Array.isArray(value)) return value.length;
    if (this._isPlainObject(value)) {
      if (key && this._isMeetKey(key)) return this._countOf(value);
      let max = 0;
      Object.values(value).forEach(item => {
        if (Array.isArray(item)) max = Math.max(max, item.length);
      });
      return max || Object.keys(value).length;
    }
    return String(value).trim() ? 1 : 0;
  },

  /**
   * 📥 纯拉取：从云端把数据拉到本地，【绝对不向云端发送任何修改】。
   *
   * 手机端遇到"云端有数据、屏幕上却是空的"时，在控制台敲这一行就行：
   *   await pullCloudOnly()
   *   await pullCloudOnly(['pe_lesson_plans'])     // 只拉某个键
   *
   * ⛔ 保险丝：整个过程只发 GET，一个 POST 都没有 ——
   *    连"把本地数据反推回云端"的自愈动作也会被关闭（_readOnlyPull）。
   * ⛔ 强制以云端为准：本地未确认锁、熔断状态一律忽略，云端有数据就覆盖本地并重绘。
   */
  async pullCloudOnly(keys = null) {
    this._readOnlyPull = true;          // ⛔ 全程只读
    try {
      const payload = await this._fetchJSON('/api/data', { headers: { Accept: 'application/json' } });
      const data = payload?.data || {};
      const wanted = Array.isArray(keys) && keys.length ? keys : null;
      const target = {};
      (wanted || Object.keys(data)).forEach(key => { target[key] = data[key]; });
      const changed = this._applyCloud(target, { force: true });
      this._mirrorLocal(changed);
      this._dispatchSync(changed, { forced: true, pulled: true });
      console.log(`[Store] 📥 已从云端拉取 ${changed.length} 项数据并重绘（本次未向云端发送任何修改）`);
      return changed;
    } finally {
      this._readOnlyPull = false;
    }
  },

  /**
   * 🛟 抢救脚本：把本地缓存 / 本地备份里的数据推回云端   *
   * 适用场景：「手机端刷新后云端的教案凭空消失」——云端表被洗成 0 条，
   *          但这台电脑上还留着那份数据（localStorage 镜像 / 时光机备份）。
   *
   * 用法（浏览器控制台）：
   *   await restoreCloudData()                    // 全部键
   *   await restoreCloudData(['pe_lesson_plans'])  // 只救一个键
   *   await restoreCloudData(['pe_lesson_plans'], { force: true })  // 云端条目更多也照样覆盖
   *
   * ⛔ 铁律：只用"本地更全"的那份去覆盖云端，绝不用更少的覆盖更多的；
   *    推送走 upsert（按 id 覆盖），不会把云端其它表清空。
   */
  async restoreCloudData(keys = STORE_KEYS, options = {}) {
    const report = [];
    const wanted = Array.isArray(keys) && keys.length ? keys : STORE_KEYS;
    const force = options.force === true;

    // 先看看云端现在有什么（避免用更少的数据覆盖更多的数据）
    let cloudData = {};
    try {
      const payload = await this._fetchJSON('/api/data', { headers: { Accept: 'application/json' } });
      cloudData = payload?.data || {};
    } catch (error) {
      console.warn('[Store] ⚠ 读取云端现状失败，将直接用本地数据修复云端', error);
    }

    for (const key of wanted) {
      const candidates = [];
      const local = this._readLocalValue(key);
      if (local !== undefined && local !== null) {
        candidates.push({ source: '本地缓存', value: local });
      }
      const slot = this._readBackupSlot(key);
      if (slot && slot.data !== undefined && slot.data !== null) {
        const savedAt = slot.savedAt ? new Date(slot.savedAt).toLocaleString('zh-CN') : '未知时间';
        candidates.push({ source: `本地备份（${savedAt}）`, value: slot.data });
      }
      // 选数据量最多的那份
      const best = candidates
        .filter(item => this._hasContent(key, item.value))
        .sort((a, b) => this._dataSize(b.value, key) - this._dataSize(a.value, key))[0];
      if (!best) {
        report.push({ key, status: 'skipped', reason: '本地缓存与备份里都没有可恢复的数据' });
        continue;
      }
      const cloudCount = this._dataSize(cloudData[key], key);
      const localCount = this._dataSize(best.value, key);
      if (!force && cloudCount >= localCount && cloudCount > 0) {
        report.push({ key, status: 'skipped', reason: `云端已有 ${cloudCount} 条，不比本地少，不覆盖` });
        continue;
      }
      try {
        // ⛔ 永远不带清空意图：这是"把数据补回去"，绝不是"清空云端"
        await this._persist(key, best.value, { allowEmpty: false });
        report.push({
          key, status: 'ok', source: best.source, count: localCount, cloudBefore: cloudCount,
        });
        console.log(`[Store] 🛟 ${key}：已把${best.source}的 ${localCount} 条推回云端`);
      } catch (error) {
        report.push({ key, status: 'error', message: error?.message || String(error) });
      }
    }
    console.log('[Store] 🛟 云端数据恢复报告：', report);
    const ok = report.filter(item => item.status === 'ok').length;
    if (ok) this._dispatchSync(report.filter(item => item.status === 'ok').map(item => item.key), { restored: true });
    return report;
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
  /* 熔断后的手动重推：Store.retryFailedKeys() / window.retryFailedKeys()
     —— 修好表结构（主键冲突 / 字段类型）之后，把被熔断的键重新推一次 */
  window.retryFailedKeys = () => Store.retryFailedKeys();
  window.getFailedWrites = () => Store.getFailedWrites();
  /* 🛟 云端数据抢救：window.restoreCloudData()
       —— 把本地缓存 / 时光机备份里的数据推回云端（云端被洗成 0 条时用）
       用法：await restoreCloudData()  /  await restoreCloudData(['pe_lesson_plans']) */
  window.restoreCloudData = (keys, options) => Store.restoreCloudData(keys, options || {});
  /* 🧹 单键彻底清空（控制台）：await clearStoreKey('pe_fitness_records')
     —— 内存 + localStorage + 云端 + 备份 + 保护锁一次清干净，绝不反推自愈 */
  window.clearStoreKey = (key, options) => Store.clearKey(key, options || {});
  /* 📥 手机端不同步时的救命一行（只读，绝不向云端发任何修改）：
       await pullCloudOnly()                  拉全部键
       await pullCloudOnly(['pe_lesson_plans']) 只拉某个键 */
  window.pullCloudOnly = (keys) => Store.pullCloudOnly(keys);
  window.forcePullCloud = (keys) => Store.pullCloudOnly(keys);
  /* 🧨 终极清理：云端删了、本地旧缓存还在打架时，控制台直接敲 hardResetAll()
       hardResetAll()                       清空一切本机状态并刷新（保留登录态）
       hardResetAll({includeAuth:true})     连登录态一起清
       hardResetAll({reload:false})         只清理、不刷新（调试用）
     🔓 只想恢复云端同步、不动数据：clearViewPriority() */
  window.hardResetAll = options => Store.hardResetAll(options || {});
  window.clearViewPriority = reason => Store.clearViewPins(reason || '控制台手动解除');
  /* 💥 最狠的一键：localStorage.clear() + 刷新（连登录态都不留，刷新后需重新登录） */
  window.nukeAllStorage = options => Store.nukeAllStorage(options || {});
}
