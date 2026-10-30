'use strict';

/**
 * 离线资源库
 *
 * 三件事：
 *   ① 把 AI 生成（或手写）的大单元完整存档：本地 localStorage 立即可用 + 联网时同步 Supabase
 *      offline_resources 表（id / category / level / content / modules_json / created_at）
 *   ② 资源库管理页：卡片列表 + 查看 / 编辑 / 删除 + 手动添加（不经过 AI）
 *   ③ 给大单元设计页提供「保存到这里」与「从这里加载」两个入口
 *
 * ⚠️ 离线优先：所有读操作都先落在本地（Store.read 本身就是本地优先），
 *    写操作先写本地再异步推云端；断网时照样能存、能看、能改。
 *    为了保证"离线存的资源不会被云端列表洗掉"，另有一个「待同步本地凭证」机制：
 *    每条本地保存都记一张小票（Pending Map），云端同步回来后发现小票上的资源不见了，
 *    就把它们补回列表并重新推一次云端（详见 reconcile()）。
 *
 * 依赖：js/unit-model.js（数据模型）、js/unit-catalog.js（手动添加时的选题下拉）
 */

const RESOURCES_KEY = 'pe_offline_resources_v1';
// 本地已确认持有的资源小票（id → 记录），用于对抗"云端列表缺失"的覆盖
const RESOURCES_PENDING_KEY = 'pe_offline_resources_pending_v1';
const MAX_PENDING_RECORDS = 20;

const OfflineResources = {
  /** 管理页筛选状态 */
  state: { keyword: '', category: '' },
  /** 选择器回调（加载资源到大单元页用） */
  _picker: null,

  /* ---------------- 底层读写 ---------------- */

  _escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  },

  _now() {
    return new Date().toISOString();
  },

  newId() {
    return `ur_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  },

  /** cloudState / mode 之类的状态（Store 还没起也能安全调用） */
  cloudStatus() {
    const store = typeof Store !== 'undefined' ? Store : null;
    if (!store) return { mode: 'local', state: 'off' };
    return {
      mode: store.mode || 'local',
      state: store.cloudState || 'off',
      paused: Boolean(store._cloudPaused),
      lastSyncAt: store.lastSyncAt || 0,
    };
  },

  /** 本地优先读取：Store 就绪与否都能读到 localStorage 里的列表 */
  readRawList() {
    const fromDirect = () => {
      try {
        const raw = localStorage.getItem(RESOURCES_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        console.warn('[离线资源库] 读取本地列表失败', error);
        return [];
      }
    };
    if (typeof Store !== 'undefined' && typeof Store.read === 'function') {
      try {
        const value = Store.read(RESOURCES_KEY, null);
        if (Array.isArray(value)) return value;
      } catch (error) {
        console.warn('[离线资源库] Store.read 失败，改用本地直读', error);
      }
    }
    return fromDirect();
  },

  /** 写列表：先本地（Store.write 同步落盘），再异步推云端 */
  writeList(list) {
    const rows = Array.isArray(list) ? list : [];
    if (typeof Store !== 'undefined' && typeof Store.write === 'function') {
      Store.write(RESOURCES_KEY, rows, { label: '离线资源库' });
      return true;
    }
    try {
      localStorage.setItem(RESOURCES_KEY, JSON.stringify(rows));
      return true;
    } catch (error) {
      console.warn('[离线资源库] 写入本地失败', error);
      return false;
    }
  },

  /* ---------------- 记录整形 ---------------- */

  /**
   * 记录整形：缺 id 的记录直接丢弃（无法定位），modules_json 过一遍 normalizeUnit，
   * 保证即使库里存的是残缺数据，前端也永远拿到 18 课时齐全的结构。
   */
  normalizeRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const id = String(record.id || '').trim();
    if (!id) return null;
    const unit = normalizeUnit(record.modules_json);
    const meta = unit.meta || {};
    return {
      id,
      category: String(record.category ?? meta.category ?? '').trim(),
      level: String(record.level ?? meta.level ?? '').trim(),
      content: String(record.content ?? meta.topic ?? '').trim(),
      source: String(record.source ?? meta.source ?? (meta.generatedAt ? 'ai' : 'manual')).trim() || 'manual',
      created_at: record.created_at || meta.generatedAt || this._now(),
      updated_at: record.updated_at || null,
      modules_json: unit,
    };
  },

  /** 列表：去重（同 id 以 updated_at 新的为准）+ 倒序 */
  list() {
    const rows = [];
    const byId = new Map();
    this.readRawList().forEach(item => {
      const record = this.normalizeRecord(item);
      if (!record) return;
      const existing = byId.get(record.id);
      if (!existing || (record.updated_at || record.created_at) >= (existing.updated_at || existing.created_at)) {
        byId.set(record.id, record);
      }
    });
    byId.forEach(record => rows.push(record));
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return rows;
  },

  count() {
    return this.list().length;
  },

  get(id) {
    return this.list().find(record => record.id === id) || null;
  },

  /** 大单元 → 资源记录（完整 11 模块塞进 modules_json，六列之外的一律放 modules_json 里） */
  recordFromUnit(unit, options = {}) {
    const normalized = normalizeUnit(unit);
    const meta = normalized.meta || {};
    const now = this._now();
    const source = options.source || meta.source || (meta.generatedAt ? 'ai' : 'manual');
    const payload = {
      ...normalized,
      meta: { ...meta, source },
    };
    return {
      id: options.id || meta.resourceId || this.newId(),
      category: meta.category || '',
      level: meta.level || '',
      content: meta.topic || '',
      source,
      created_at: options.created_at || meta.createdAt || now,
      updated_at: now,
      modules_json: payload,
    };
  },

  /** 资源记录 → 大单元（并记住自己属于哪个资源，后续编辑覆盖同一条） */
  unitFromRecord(record) {
    if (!record) return null;
    const unit = normalizeUnit(record.modules_json);
    unit.meta = {
      ...unit.meta,
      resourceId: record.id,
      source: record.source || unit.meta.source || 'manual',
      category: unit.meta.category || record.category || '',
      level: unit.meta.level || record.level || '',
      topic: unit.meta.topic || record.content || '',
    };
    return unit;
  },

  /**
   * 保存一条记录（新增或覆盖同 id）。
   * @returns {{ok:boolean, created:boolean, record:object}}
   */
  save(record) {
    const normalized = this.normalizeRecord(record);
    if (!normalized) return { ok: false, reason: '缺少资源 id', record: null };
    const list = this.list();
    const index = list.findIndex(item => item.id === normalized.id);
    if (index >= 0) {
      normalized.created_at = list[index].created_at || normalized.created_at;
      list[index] = normalized;
    } else {
      list.unshift(normalized);
    }
    this.writeList(list);
    this.markPending(normalized);          // 本地小票：防止之后被云端列表覆盖掉
    return { ok: true, created: index < 0, record: normalized };
  },

  remove(id) {
    const list = this.list();
    const next = list.filter(item => item.id !== id);
    if (next.length === list.length) return { ok: false, removed: false };
    this.writeList(next);
    this.dropPending([id]);
    return { ok: true, removed: true };
  },

  /* ---------------- 离线守护：本地小票 ---------------- */

  readPendingMap() {
    try {
      const raw = localStorage.getItem(RESOURCES_PENDING_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  },

  writePendingMap(map) {
    try {
      localStorage.setItem(RESOURCES_PENDING_KEY, JSON.stringify(map));
    } catch (error) {
      console.warn('[离线资源库] 写入本地小票失败', error);
    }
  },

  markPending(record) {
    if (!record?.id) return;
    const map = this.readPendingMap();
    map[record.id] = record;
    // 上限保护：太久的小票先丢（按 created_at 升序）
    const ids = Object.keys(map);
    if (ids.length > MAX_PENDING_RECORDS) {
      ids
        .sort((a, b) => String(map[a]?.created_at || '').localeCompare(String(map[b]?.created_at || '')))
        .slice(0, ids.length - MAX_PENDING_RECORDS)
        .forEach(id => delete map[id]);
    }
    this.writePendingMap(map);
  },

  dropPending(ids) {
    const map = this.readPendingMap();
    let changed = false;
    (Array.isArray(ids) ? ids : [ids]).forEach(id => {
      if (map[id]) { delete map[id]; changed = true; }
    });
    if (changed) this.writePendingMap(map);
    return changed;
  },

  /**
   * 云端同步之后核对一次：本地有、列表里却没了的资源，补回并重推云端。
   * 典型场景：A 机离线存了 3 条，B 机后来整表覆盖了云端 —— 没有这道防线，A 机一联网就被洗掉。
   */
  reconcile() {
    const map = this.readPendingMap();
    const ids = Object.keys(map);
    if (!ids.length) return { restored: 0, cleared: 0 };
    const list = this.list();
    const present = new Set(list.map(item => item.id));
    const cleared = ids.filter(id => present.has(id));
    const missing = ids.filter(id => !present.has(id));
    if (cleared.length) this.dropPending(cleared);
    if (!missing.length) return { restored: 0, cleared: cleared.length };

    const restoredRecords = missing
      .map(id => this.normalizeRecord(map[id]))
      .filter(Boolean);
    if (!restoredRecords.length) return { restored: 0, cleared: cleared.length };

    this.writeList([...restoredRecords, ...list]);
    console.warn(`[离线资源库] ☁ 云端列表缺少 ${restoredRecords.length} 条本机资源，已补回并重推`);
    return { restored: restoredRecords.length, cleared: cleared.length };
  },

  /** 监听云端同步（只在 offline-resources / unit-design 页面启用一次） */
  bindSyncWatch() {
    if (this._watchBound || typeof window === 'undefined') return;
    this._watchBound = true;
    window.addEventListener('store:sync', event => {
      const mode = event?.detail?.mode;
      // 只有云端真的带来了数据才对账（纯本地模式下"列表"就是本机写的，对账没有意义）
      if (mode === 'local') return;
      this.reconcile();
      if (this.renderPage && document.getElementById('resGrid')) this.renderCards();
    });
  },

  /* ---------------- 给大单元设计页用的入口 ---------------- */

  /**
   * 把当前大单元存进资源库。
   * 已经绑定过资源（meta.resourceId）时更新同一条，否则新建。
   * @returns {{ok:boolean, created:boolean, record:object}}
   */
  saveUnit(unit, options = {}) {
    const normalized = normalizeUnit(unit);
    const boundId = options.id || normalized.meta.resourceId || '';
    const existing = boundId ? this.get(boundId) : null;
    const result = this.save(this.recordFromUnit(normalized, {
      ...options,
      id: existing ? existing.id : this.newId(),
      created_at: existing ? existing.created_at : undefined,
    }));
    // ⚠️ 自动落库（编辑时的防抖同步）必须安静进行，否则老师每停一下手就弹一次 toast
    if (result.ok && options.notify !== false && typeof showToast === 'function') {
      showToast(existing ? '已更新离线资源库' : '已保存到离线资源库');
    }
    return result;
  },

  /** 大单元页编辑时的落库（绑定到资源才写，没绑定就什么都不做） */
  syncUnit(unit) {
    const id = normalizeUnit(unit).meta.resourceId;
    if (!id || !this.get(id)) return { ok: false, reason: 'not-bound' };
    return this.saveUnit(unit, { id, notify: false });
  },

  /* ---------------- 列表筛选 ---------------- */

  filteredList() {
    const keyword = String(this.state.keyword || '').trim().toLowerCase();
    const category = String(this.state.category || '').trim();
    return this.list().filter(record => {
      if (category && record.category !== category) return false;
      if (!keyword) return true;
      const unit = record.modules_json || {};
      const haystack = [
        record.category, record.level, record.content,
        unit.unitTitle, unit.meta?.item, unit.teachingContent, unit.objectives?.ability,
      ].map(text => String(text || '').toLowerCase()).join(' ');
      return haystack.includes(keyword);
    });
  },

  setFilter(keyword, category) {
    this.state.keyword = keyword ?? this.state.keyword;
    this.state.category = category ?? this.state.category;
    this.renderCards();
  },

  /* ---------------- 管理页渲染 ---------------- */

  renderPage() {
    const host = document.getElementById('page-content');
    if (!host) return;
    const categories = (typeof UNIT_CATALOG !== 'undefined' ? UNIT_CATALOG : []).map(item => item.label);
    host.innerHTML = `
      <section class="res-header">
        <div>
          <p class="res-eyebrow">OFFLINE RESOURCE LIBRARY</p>
          <h1>离线资源库</h1>
          <p>保存 AI 生成的或手写的大单元设计；数据优先存在本机，断网也能查看与编辑。</p>
        </div>
        <div class="res-header-actions">
          <button class="btn btn-primary" type="button" onclick="OfflineResources.openCreateDialog()">＋ 手动添加</button>
          <a class="btn btn-secondary" href="unit-design.html">去 AI 生成</a>
        </div>
      </section>

      <section class="sports-meet-card res-card-panel">
        <div class="res-toolbar">
          <input id="resKeyword" class="form-control" type="search" placeholder="搜索教材 / 水平 / 教学内容 / 单元名"
            value="${this._escape(this.state.keyword)}" oninput="OfflineResources.setFilter(this.value)" aria-label="搜索离线资源">
          <select id="resCategory" class="form-control" onchange="OfflineResources.setFilter(undefined, this.value)" aria-label="按教材大类筛选">
            <option value="">全部教材大类</option>
            ${categories.map(label => `<option value="${this._escape(label)}"${this.state.category === label ? ' selected' : ''}>${this._escape(label)}</option>`).join('')}
          </select>
          <span class="res-toolbar-space"></span>
          <button class="btn btn-ghost" type="button" onclick="OfflineResources.renderPage()">刷新</button>
        </div>
        <p id="resSummary" class="res-summary"></p>
        <div id="resGrid" class="res-grid"></div>
      </section>
    `;
    this.renderCards();
  },

  renderCards() {
    const grid = document.getElementById('resGrid');
    if (!grid) return;
    const summary = document.getElementById('resSummary');
    const list = this.filteredList();
    const total = this.count();
    const status = this.cloudStatus();
    if (summary) {
      summary.innerHTML = `本地共 <b>${total}</b> 条资源${list.length !== total ? `，当前筛选出 <b>${list.length}</b> 条` : ''}`
        + `　·　云端：${status.state === 'off' ? '<span class="res-offline">离线（仅本机）</span>'
          : (status.paused ? '<span class="res-offline">已暂停同步</span>' : '<span class="res-online">已连接</span>')}`;
    }
    if (!list.length) {
      grid.innerHTML = `
        <div class="res-empty">
          <h2>${total ? '没有匹配的资源' : '资源库还是空的'}</h2>
          <p>${total
            ? '换个关键词或把「教材大类」切回全部试试。'
            : '可以在大单元设计页点【保存到离线资源库】，或这里点【＋ 手动添加】手写一份。'}</p>
        </div>`;
      return;
    }
    grid.innerHTML = list.map(record => this.cardHTML(record, 'manage')).join('');
  },

  /** 一张卡片（管理模式 3 个按钮；选择模式只有「载入」） */
  cardHTML(record, mode = 'manage') {
    const unit = normalizeUnit(record.modules_json);
    const title = unit.unitTitle || record.content || '未命名大单元';
    const savedAt = record.created_at ? new Date(record.created_at).toLocaleString('zh-CN') : '—';
    const updatedAt = record.updated_at ? new Date(record.updated_at).toLocaleString('zh-CN') : '';
    const actions = mode === 'pick'
      ? `<button class="btn btn-primary" type="button" onclick="OfflineResources.pick('${record.id}')">载入到设计页</button>`
      : `
        <button class="btn btn-secondary" type="button" onclick="OfflineResources.view('${record.id}')">查看</button>
        <button class="btn btn-secondary" type="button" onclick="OfflineResources.edit('${record.id}')">编辑</button>
        <button class="btn btn-ghost" type="button" onclick="OfflineResources.confirmDelete('${record.id}')">删除</button>`;
    const missing = missingStructureNumbers(unit).length;
    return `
      <article class="res-card">
        <div class="res-card-top">
          <span class="res-chip">${this._escape([record.category, unit.meta?.item].filter(Boolean).join(' · ') || '未选题')}</span>
          <span class="res-source res-source-${this._escape(record.source)}">${record.source === 'ai' ? 'AI 生成' : '手填'}</span>
        </div>
        <h3 class="res-card-title">${this._escape(title)}</h3>
        <p class="res-card-content">${this._escape(record.content || '（未填写教学内容）')}</p>
        <dl class="res-card-meta">
          <dt>水平</dt><dd>${this._escape(record.level || '—')}</dd>
          <dt>保存</dt><dd>${this._escape(savedAt)}</dd>
          ${updatedAt ? `<dt>更新</dt><dd>${this._escape(updatedAt)}</dd>` : ''}
          <dt>课时</dt><dd>${missing ? `<span class="res-warn">结构图缺 ${missing} 个</span>` : '18 课时已挂载'}</dd>
        </dl>
        <div class="res-card-actions">${actions}</div>
      </article>`;
  },

  /* ---------------- 操作 ---------------- */

  view(id) {
    const record = this.get(id);
    if (!record) return showToast('资源不存在或已被删除', 'error');
    const unit = normalizeUnit(record.modules_json);
    const footer = `
      <button class="btn btn-secondary" type="button" onclick="OfflineResources.exportWord('${id}')">导出 Word</button>
      <button class="btn btn-secondary" type="button" onclick="OfflineResources.printUnit('${id}')">打印 / PDF</button>
      <button class="btn btn-primary" type="button" onclick="OfflineResources.edit('${id}')">编辑</button>`;
    showModal(
      `查看 · ${this._escape(unit.unitTitle || record.content || '未命名大单元')}`,
      this.readonlyHTML(record),
      footer,
    );
  },

  edit(id) {
    const record = this.get(id);
    if (!record) return showToast('资源不存在或已被删除', 'error');
    window.location.href = `unit-design.html?resource=${encodeURIComponent(id)}`;
  },

  confirmDelete(id) {
    const record = this.get(id);
    if (!record) return;
    const unit = normalizeUnit(record.modules_json);
    const name = unit.unitTitle || record.content || '这个大单元';
    if (!window.confirm(`确定删除「${name}」吗？此操作不可撤销（会同时从本机与云端移除）。`)) return;
    this.remove(id);
    showToast('已删除');
    this.renderCards();
  },

  exportWord(id) {
    const record = this.get(id);
    if (!record) return showToast('资源不存在', 'error');
    const html = buildUnitExportHTML(normalizeUnit(record.modules_json));
    const name = normalizeUnit(record.modules_json).unitTitle || record.content || '离线资源';
    const blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${String(name).replace(/[\\/:*?"<>|]/g, '_')}.doc`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  printUnit(id) {
    const record = this.get(id);
    if (!record) return showToast('资源不存在', 'error');
    const printWindow = window.open('', '_blank');
    if (!printWindow) return showToast('浏览器阻止了打印窗口，请允许弹出窗口后重试', 'error');
    printWindow.document.open();
    printWindow.document.write(buildUnitExportHTML(normalizeUnit(record.modules_json)));
    printWindow.document.close();
    printWindow.addEventListener('load', () => printWindow.print(), { once: true });
  },

  /** 选择弹窗（大单元设计页「从离线资源库加载」用） */
  openPicker(onPick) {
    this._picker = typeof onPick === 'function' ? onPick : null;
    const list = this.list();
    const body = list.length
      ? `<p class="res-note">共 ${list.length} 条资源，载入后会直接填充到大单元设计页的结果区（不调用 AI）。</p>
         <div class="res-grid">${list.map(record => this.cardHTML(record, 'pick')).join('')}</div>`
      : `<div class="res-empty"><h2>离线资源库还是空的</h2>
           <p>先在大单元设计页生成后点【保存到离线资源库】，或到「离线资源库」页手动添加。</p></div>`;
    showModal('从离线资源库加载', body, '<button class="btn btn-secondary" type="button" onclick="OfflineResources.closeModals()">关闭</button>');
  },

  pick(id) {
    const record = this.get(id);
    if (!record) return showToast('资源不存在', 'error');
    const callback = this._picker;
    this._picker = null;
    this.closeModals();
    if (callback) callback(record);
  },

  closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.remove());
  },

  /* ---------------- 手动添加 ---------------- */

  openCreateDialog() {
    const categories = typeof UNIT_CATALOG !== 'undefined' ? UNIT_CATALOG : [];
    const levels = typeof UNIT_LEVELS !== 'undefined' ? UNIT_LEVELS : [];
    const body = `
      <form id="resCreateForm" class="res-form" onsubmit="return false;">
        <label class="res-form-field">
          <span>单元名称</span>
          <input id="resCreateTitle" class="form-control" type="text" placeholder="例如：水平三篮球大单元（18 课时）">
        </label>
        <label class="res-form-field">
          <span>教材大类 / 细项</span>
          <div class="res-form-row">
            <select id="resCreateCategory" class="form-control" onchange="OfflineResources.onCreateCategoryChange()">
              <option value="">请选择教材大类</option>
              ${categories.map(item => `<option value="${item.id}">${this._escape(item.label)}</option>`).join('')}
            </select>
            <select id="resCreateItem" class="form-control" onchange="OfflineResources.onCreateTopicRefresh()">
              <option value="">请选择细项</option>
            </select>
          </div>
        </label>
        <label class="res-form-field">
          <span>水平</span>
          <select id="resCreateLevel" class="form-control" onchange="OfflineResources.onCreateTopicRefresh()">
            ${levels.map(level => `<option value="${level.id}">${this._escape(level.label)}</option>`).join('')}
          </select>
          <p id="resCreateLevelNote" class="res-note">${levels.length ? this._escape(levels[0].stage) : ''}</p>
        </label>
        <label class="res-form-field">
          <span>教学内容</span>
          <select id="resCreateTopic" class="form-control" onchange="OfflineResources.onCreateTopicChange()"></select>
          <p id="resCreateTopicNote" class="res-note"></p>
        </label>
        <p class="res-tip">创建后会得到一份<b>空白的大单元（18 课时框架齐全）</b>，
          系统会把你带到大单元设计页，用同一套编辑界面逐项填写 —— 不需要 AI。</p>
      </form>`;
    const footer = `
      <button class="btn btn-ghost" type="button" onclick="OfflineResources.closeModals()">取消</button>
      <button class="btn btn-primary" type="button" onclick="OfflineResources.createBlank({ goto: true })">创建并去填写</button>`;
    this.onCreateTopicRefresh();
    showModal('手动添加离线大单元', body, footer);
  },

  onCreateCategoryChange() {
    const category = (typeof UNIT_CATALOG !== 'undefined' ? UNIT_CATALOG : [])
      .find(item => item.id === document.getElementById('resCreateCategory')?.value);
    const itemSelect = document.getElementById('resCreateItem');
    if (!itemSelect) return;
    itemSelect.innerHTML = '<option value="">请选择细项</option>'
      + (category ? category.items.map(entry => `<option value="${entry.id}">${this._escape(entry.label)}</option>`).join('') : '');
    this.onCreateTopicRefresh();
  },

  /** 教学内容 = f(细项, 水平) */
  onCreateTopicRefresh() {
    const itemId = document.getElementById('resCreateItem')?.value || '';
    const levelId = document.getElementById('resCreateLevel')?.value || '';
    const topicSelect = document.getElementById('resCreateTopic');
    const note = document.getElementById('resCreateLevelNote');
    if (note) {
      const level = (typeof UNIT_LEVELS !== 'undefined' ? UNIT_LEVELS : []).find(entry => entry.id === levelId);
      note.textContent = level ? level.stage : '';
    }
    if (!topicSelect) return;
    const topics = itemId && levelId ? listUnitTopics(itemId, levelId) : [];
    topicSelect.innerHTML = topics.length
      ? topics.map(topic => `<option value="${this._escape(topic)}">${this._escape(topic)}</option>`).join('')
      : '<option value="">请先选择「教材细项」与「水平」</option>';
    topicSelect.disabled = !topics.length;
    this.onCreateTopicChange();
  },

  onCreateTopicChange() {
    const topic = document.getElementById('resCreateTopic')?.value || '';
    const note = document.getElementById('resCreateTopicNote');
    if (!note) return;
    note.innerHTML = isUnitTopicPending(topic)
      ? '<span class="ud2-pending-tag">[待确认]</span> 该条目依赖本校条件，请你核对后使用。'
      : (topic ? `将围绕「${this._escape(topic)}」建立空白大单元。` : '');
  },

  /** 按表单选题建一条空白资源（不经过 AI） */
  createBlank({ goto = true } = {}) {
    const categoryId = document.getElementById('resCreateCategory')?.value || '';
    const itemId = document.getElementById('resCreateItem')?.value || '';
    const levelId = document.getElementById('resCreateLevel')?.value || '';
    const topic = document.getElementById('resCreateTopic')?.value || '';
    const title = document.getElementById('resCreateTitle')?.value?.trim() || '';
    const category = (typeof UNIT_CATALOG !== 'undefined' ? UNIT_CATALOG : []).find(item => item.id === categoryId);
    const item = category?.items.find(entry => entry.id === itemId);
    const level = (typeof UNIT_LEVELS !== 'undefined' ? UNIT_LEVELS : []).find(entry => entry.id === levelId);

    const unit = createEmptyUnit();
    unit.unitTitle = title || [item?.label, level?.label].filter(Boolean).join(' ') || '未命名大单元';
    unit.meta = {
      ...unit.meta,
      unitTitle: unit.unitTitle,
      categoryId, category: category?.label || '',
      itemId, item: item?.label || '',
      levelId, level: level?.label || '',
      topic, topicPending: Boolean(topic && isUnitTopicPending(topic)),
      source: 'manual',
    };
    const result = this.saveUnit(unit, { source: 'manual' });
    if (!result.ok) return showToast('创建失败，请重试', 'error');
    this.closeModals();
    if (!goto) {
      showToast('空白大单元已创建');
      this.renderPage();
      return result.record;      // 让调用方拿到创建结果（测试与后续流程都要用）
    }
    window.location.href = `unit-design.html?resource=${encodeURIComponent(result.record.id)}`;
    return result.record;
  },

  /* ---------------- 只读详情（查看弹窗 / 打印共用） ---------------- */

  readonlyHTML(record) {
    const unit = normalizeUnit(record.modules_json);
    const line = (label, value) => `<div class="res-ro-field"><span>${label}</span><p class="res-pre">${this._escape(value) || '（空）'}</p></div>`;
    const modules = UNIT_MODULES.map((module, index) => {
      const body = this.moduleReadonly(unit, module.id, line);
      return `<details class="res-ro-block" open>
        <summary>模块 ${index + 1} · ${this._escape(module.title)}</summary>
        <div class="res-ro-body">${body}</div>
      </details>`;
    }).join('');
    return `
      <div class="res-ro">
        <dl class="res-ro-summary">
          <dt>教材</dt><dd>${this._escape([record.category, unit.meta?.item].filter(Boolean).join(' · ') || '—')}</dd>
          <dt>水平</dt><dd>${this._escape(record.level || '—')}</dd>
          <dt>内容</dt><dd>${this._escape(record.content || '—')}</dd>
          <dt>保存</dt><dd>${record.created_at ? new Date(record.created_at).toLocaleString('zh-CN') : '—'}</dd>
        </dl>
        ${modules}
      </div>`;
  },

  moduleReadonly(unit, id, line) {
    switch (id) {
      case 'objectives': return line('运动能力', unit.objectives.ability)
        + line('健康行为', unit.objectives.health) + line('体育品德', unit.objectives.character);
      case 'keyDifficulties': return line('学生学习的重难点', unit.keyDifficulties.learning)
        + line('学习内容的重难点', unit.keyDifficulties.content)
        + line('教学组织的重难点', unit.keyDifficulties.organization)
        + line('教学方法的重难点', unit.keyDifficulties.method);
      case 'evaluation': return line('过程性评价', unit.evaluation.process)
        + line('终结性评价', unit.evaluation.summative)
        + line('「学、练、赛、评」一体化', unit.evaluation.integration);
      case 'structure': return `<div class="res-ro-tree">${UNIT_STRUCTURE_BRANCHES.map(branch => `
        <div class="res-ro-branch"><b>${branch.label}</b>
          ${unit.structure[branch.id].length
            ? `<ol>${unit.structure[branch.id].map(node => `<li>${this._escape(node.title)}</li>`).join('')}</ol>`
            : '<p class="res-note">无</p>'}
        </div>`).join('')}</div>`;
      case 'lessons': return `<div class="res-ro-table-wrap"><table class="data-table res-ro-table">
        <thead><tr><th>课时</th><th>学习目标（三维）</th><th>教学内容</th><th>组织教学与方法</th></tr></thead><tbody>
        ${unit.lessons.map(lesson => `<tr>
          <td>第 ${lesson.no} 课</td>
          <td>能力：${this._escape(lesson.objectives.ability) || '—'}<br>健康：${this._escape(lesson.objectives.health) || '—'}<br>品德：${this._escape(lesson.objectives.character) || '—'}</td>
          <td>${this._escape(lesson.content) || '—'}</td>
          <td>${this._escape(lesson.method) || '—'}</td></tr>`).join('')}
        </tbody></table></div>`;
      default: return line('', unit[id]);
    }
  },
};

if (typeof window !== 'undefined') {
  window.OfflineResources = OfflineResources;
  window.RESOURCES_KEY = RESOURCES_KEY;
  OfflineResources.bindSyncWatch();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OfflineResources, RESOURCES_KEY, RESOURCES_PENDING_KEY };
}
