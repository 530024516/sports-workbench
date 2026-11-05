/**
 * 侧边栏折叠（☰）回归测试
 * node tests/layout-sidebar-smoke.mjs 直接跑
 *
 * 覆盖：
 *   ① 折叠状态能读出来（localStorage / Store 本地镜像）
 *   ② 点 ☰ → body 上加/去 sidebar-collapsed，并写回本地
 *   ③ 刷新页面（重新 init）→ 折叠状态自动恢复
 *   ④ 折叠态鼠标悬停图标 → 弹出黑色提示框，写着图标名称
 *   ⑤ 展开态不弹提示框
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT_SOURCE = fs.readFileSync(path.join(ROOT, 'js/layout.js'), 'utf8');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
}

/* ------------------------------ 沙箱 ------------------------------ */

/** 极简元素替身：够 Layout 用就行 */
function makeElement(tag = 'div') {
  const listeners = {};
  const classes = new Set();
  return {
    tagName: tag,
    innerHTML: '',
    textContent: '',
    title: '',
    attributes: {},
    listeners,
    style: {},
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classes.has(name) : !!force;
        if (shouldAdd) classes.add(name); else classes.delete(name);
        return shouldAdd;
      },
      contains: name => classes.has(name),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    hasAttribute(name) { return name in this.attributes; },
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    removeEventListener() {},
    dispatch(type, event = {}) { (listeners[type] || []).forEach(handler => handler(event)); },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 100, left: 0, right: 64, bottom: 140, width: 64, height: 40 }),
    closest: () => null,
    parent: null,
    appendChild(child) { child.parent = this; this.children = this.children || []; this.children.push(child); return child; },
    remove() {
      if (this.parent?.children) {
        const index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
      }
    },
  };
}

/**
 * @param {object} initialStore 初始存储（localStorage 镜像）
 */
function createEnv(initialStore = {}) {
  const storeData = { ...initialStore };
  const writes = [];

  const body = makeElement('body');
  body.children = [];
  const bodyChildren = body.children;

  const toggle = makeElement('button');
  const sidebar = makeElement('aside');
  const navItem = makeElement('a');
  navItem.setAttribute('data-tip', '体测数据');
  const groupToggle = makeElement('button');
  groupToggle.setAttribute('data-tip', '教学管理');

  const root = makeElement('div');
  root.querySelector = selector => {
    if (selector === '#sidebarCollapseToggle') return toggle;
    if (selector === '.sidebar') return sidebar;
    if (selector === '.brand-text') return null;
    if (selector === '.sidebar-footer .user-name') return null;
    if (selector === '#dashboardGreetingName') return null;
    return null;
  };
  root.querySelectorAll = selector => {
    if (selector === '.nav-item, .nav-group-toggle') return [navItem, groupToggle];
    return [];
  };

  const documentStub = {
    readyState: 'complete',
    title: '体育老师工作台 - 体测数据',
    body,
    getElementById: id => {
      if (id === 'app') return root;
      if (id === 'sidebarCollapseToggle') return toggle;
      return null;
    },
    querySelector: selector => (selector === '.sidebar' ? sidebar : null),
    querySelectorAll: () => [],
    createElement: tag => makeElement(tag),
    addEventListener() {},
  };

  const context = vm.createContext({
    document: documentStub,
    console,
    Promise, Object, Array, String, Number, Boolean, Set, Map, Date, Error, JSON, Math, URLSearchParams,
    setTimeout, clearTimeout,
    window: {
      location: { search: '' },
      addEventListener() {},
      removeEventListener() {},
      innerWidth: 1440,
    },
    localStorage: {
      getItem: key => (key in storeData ? JSON.stringify(storeData[key]) : null),
      setItem: (key, value) => { storeData[key] = JSON.parse(value); },
      removeItem: key => { delete storeData[key]; },
    },
    Store: {
      read: (key, fallback = null) => (key in storeData ? storeData[key] : fallback),
      write: (key, value) => { storeData[key] = value; writes.push({ key, value }); return value; },
      onReady: () => () => {},
    },
    showToast: () => {},
    showModal: () => {},
    closeModal: () => {},
  });
  context.globalThis = context;
  context.parent = context;

  new vm.Script(LAYOUT_SOURCE, { filename: 'js/layout.js' }).runInContext(context);
  // const Layout = {...} 不会挂到 globalThis 上，要单独取出来
  new vm.Script('globalThis.__Layout = Layout;', { filename: 'extract.js' }).runInContext(context);

  return {
    context,
    Layout: context.__Layout,
    body,
    bodyChildren,
    toggle,
    navItem,
    groupToggle,
    storeData,
    writes,
    documentStub,
  };
}

/* ------------------------------ 用例 ------------------------------ */

console.log('\n🧪 侧边栏折叠（☰）回归测试\n');

await test('① 折叠状态存在本地存储里（isCollapsed: true）', () => {
  const env = createEnv({ pe_sidebar_collapsed: true });
  equal(env.Layout.isSidebarCollapsed(), true, '应该读出折叠状态');
  const expanded = createEnv({ pe_sidebar_collapsed: false });
  equal(expanded.Layout.isSidebarCollapsed(), false, '没折叠时应为 false');
  const missing = createEnv({});
  equal(missing.Layout.isSidebarCollapsed(), false, '没有任何记录时默认展开');
});

await test('② 点 ☰ → body 加上 sidebar-collapsed，并写回本地', () => {
  const env = createEnv({});
  env.Layout.init('fitness', '体测数据', '教学管理');
  equal(env.body.classList.contains('sidebar-collapsed'), false, '初始是展开的');

  env.Layout.toggleSidebar();
  equal(env.body.classList.contains('sidebar-collapsed'), true, '点一下应该折叠');
  equal(env.storeData.pe_sidebar_collapsed, true, '折叠状态要写进本地存储');
  equal(env.toggle.getAttribute('aria-expanded'), 'false', '按钮的 aria-expanded 要跟着变');
  equal(env.toggle.title, '展开侧边栏', '按钮提示要改成"展开侧边栏"');

  env.Layout.toggleSidebar();
  equal(env.body.classList.contains('sidebar-collapsed'), false, '再点一下应该展开');
  equal(env.storeData.pe_sidebar_collapsed, false, '展开状态也要写回本地');
});

await test('③ 刷新页面（重新 init）→ 折叠状态自动恢复', () => {
  const env = createEnv({ pe_sidebar_collapsed: true });
  env.Layout.init('fitness', '体测数据', '教学管理');
  equal(env.body.classList.contains('sidebar-collapsed'), true, '刷新后应保持折叠');
  equal(env.toggle.getAttribute('aria-expanded'), 'false', '按钮状态也要跟着恢复');
});

await test('④ 折叠态悬停图标 → 弹出黑色提示框（写着图标名称）', () => {
  const env = createEnv({ pe_sidebar_collapsed: true });
  env.Layout.init('fitness', '体测数据', '教学管理');

  env.navItem.dispatch('mouseenter');
  const tip = env.bodyChildren.find(child => child.className === 'sidebar-tip');
  assert(tip, '应该弹出提示框');
  equal(tip.textContent, '体测数据', '提示框里要写图标名称');
  assert(tip.style.left && tip.style.top, '提示框要定位到侧边栏右侧');

  env.navItem.dispatch('mouseleave');
  equal(env.bodyChildren.filter(child => child.className === 'sidebar-tip').length, 0, '移开后提示框要消失');
});

await test('⑤ 展开态不弹提示框', () => {
  const env = createEnv({});
  env.Layout.init('fitness', '体测数据', '教学管理');
  env.navItem.dispatch('mouseenter');
  equal(env.bodyChildren.filter(child => child.className === 'sidebar-tip').length, 0, '展开时不该有提示框');
});

await test('⑥ 导航项都带 data-tip（折叠后才知道图标是什么）', () => {
  const env = createEnv({});
  env.Layout.init('fitness', '体测数据', '教学管理');
  const html = env.context.document.body ? '' : '';
  // 直接检查侧边栏 HTML 里每个导航项都有 data-tip
  const sidebarHtml = env.Layout.sidebarHTML();
  const tipCount = (sidebarHtml.match(/data-tip="/g) || []).length;
  assert(tipCount >= 6, `每个导航项都该有 data-tip（实际 ${tipCount} 个）`);
  assert(sidebarHtml.includes('data-tip="体测数据"'), '体测数据要有 data-tip');
  assert(sidebarHtml.includes('data-tip="教学管理"'), '教学管理分组要有 data-tip');
});

const failed = results.filter(item => !item.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exit(1);
