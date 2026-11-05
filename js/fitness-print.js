/**
 * 体测 · 页面打印
 * ─────────────────────────────────────────────────────────────
 * 三个页面（成绩列表 / 统计分析看板 / 成绩排名）右上角各有一个绿色的
 * 【🖨️ 打印当前页面】按钮，点一下把"干净版"内容送进打印预览。
 *
 * 为什么不直接 window.print()？
 *   直接打印会把左侧导航栏、顶部的筛选下拉框、一堆导出/打印按钮一起打出来。
 *   这里改成：把要打印的内容复制一份 → 去掉筛选器和所有按钮 → 图表转成
 *   Base64 图片 → 拼成一个独立 HTML → 塞进一个藏在屏幕外的 iframe →
 *   调 iframe.contentWindow.print()。
 *   这样打印出来的就是"干净的报表页"，而且 iframe 有自己的 @page 规则，
 *   横向表（A4 横向）和看板（A4 纵向）可以各用各的纸张方向。
 *
 * 结构上刻意做成"纯字符串处理"：
 *   DOM 只负责两件事 —— 读出容器的 innerHTML、拿图表的 Base64 图片；
 *   剩下的清洗（去按钮、去筛选器、图表换图片、拼文档）全是纯函数，
 *   所以不依赖浏览器也能完整地跑单元测试。
 */
'use strict';

/* ==========================================================================
 * 一、三个页面的打印配置
 * ========================================================================== */

const FITNESS_PRINT_PAGES = {
  records: {
    key: 'records',
    title: '体测数据',
    docTitle: '体测成绩册',
    orientation: 'landscape',       // 宽表格 → 横向
    sourceId: 'fitnessContent',
    charts: ['fitnessWeakChart'],
  },
  ranking: {
    key: 'ranking',
    title: '成绩排名',
    docTitle: '体测成绩排名',
    orientation: 'landscape',
    sourceId: 'fitnessContent',
    charts: [],
  },
  dashboard: {
    key: 'dashboard',
    title: '统计分析看板',
    docTitle: '体测统计分析看板',
    orientation: 'portrait',        // 以图表为主 → 纵向
    sourceId: 'fitnessContent',
    charts: ['fitnessChartLevel', 'fitnessChartBmi', 'fitnessChartItem', 'fitnessChartGradeCompare'],
  },
};

/** 打印件里要整块删掉的容器 class（筛选器 / 操作区 / 空掉的按钮条） */
const FITNESS_PRINT_REMOVE_CLASSES = [
  'fitness-bi-control',          // 看板的年级/班级 Tab + 导出按钮
  'fitness-bi-watch-tabs',       // 关注名单的分类 Tab
  'segmented',                   // 分段按钮（指标切换）
  'toolbar',
  'ranking-export-actions',      // 排名页的导出按钮条
];

/* ==========================================================================
 * 二、纯函数工具
 * ========================================================================== */

/** HTML 转义 */
function fitnessPrintEscape(value) {
  if (typeof escapeFitnessHTML === 'function') return escapeFitnessHTML(value);
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

/** 当前时间：2026-11-06 10:00 */
function fitnessPrintNowText() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 页眉：INh工作台 - [体测数据/成绩排名/统计分析看板] 打印时间：… */
function fitnessPrintHeaderHTML(title) {
  return `
    <div class="fp-header">
      <span class="fp-header-title">INh工作台 - ${fitnessPrintEscape(title)}</span>
      <span class="fp-header-time">打印时间：${fitnessPrintNowText()}</span>
    </div>`;
}

/**
 * 找到一个元素在 HTML 字符串里的区间 [start, end)。
 * 自己数标签配对，嵌套多少层都不会切错（正则的非贪婪匹配会切错）。
 * @returns {{start:number,end:number}|null}
 */
function fitnessPrintFindElementRange(html, { tag = 'div', className = '', id = '' } = {}) {
  const source = String(html || '');
  const opener = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let match = opener.exec(source);
  while (match !== null) {
    const startTag = match[0];
    const classHit = !className || new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`, 'i').test(startTag);
    const idHit = !id || new RegExp(`id="${id}"`, 'i').test(startTag);
    if (classHit && idHit) {
      const contentStart = match.index + startTag.length;
      const end = fitnessPrintFindClosingTag(source, tag, contentStart);
      if (end >= 0) return { start: match.index, end };
    }
    match = opener.exec(source);
  }
  return null;
}

/** 从 from 开始数标签，找到与开头配对的结束标签位置 */
function fitnessPrintFindClosingTag(html, tag, from) {
  const scanner = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  scanner.lastIndex = from;
  let depth = 1;
  let match = scanner.exec(html);
  while (match !== null) {
    if (match[1] === '/') {
      depth -= 1;
      if (depth === 0) return match.index + match[0].length;
    } else {
      depth += 1;
    }
    match = scanner.exec(html);
  }
  return -1;
}

/** 按 class 删掉整块元素（连内容一起删） */
function fitnessPrintRemoveByClass(html, className) {
  let out = String(html || '');
  for (let guard = 0; guard < 50; guard += 1) {
    const range = fitnessPrintFindElementRange(out, { tag: 'div', className });
    if (!range) break;
    out = out.slice(0, range.start) + out.slice(range.end);
  }
  return out;
}

/** 删掉所有交互元素（按钮 / 输入框 / 下拉框）和事件属性 */
function fitnessPrintStripInteractive(html) {
  let out = String(html || '');
  // ⚠️ 成绩册的姓名是一个 <button>（点开看诊断报告），直接删按钮会把姓名也删没 →
  //    先把这种"内容型按钮"换成 <span>，再删剩下的真按钮。
  out = out.replace(
    /<button\b([^>]*\bclass="[^"]*\bfitness-gb-name-link\b[^"]*"[^>]*)>([\s\S]*?)<\/button>/gi,
    '<span$1>$2</span>',
  );
  out = out.replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '');
  out = out.replace(/<input\b[^>]*\/?>/gi, '');
  out = out.replace(/<select\b[^>]*>[\s\S]*?<\/select>/gi, '');
  out = out.replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, '');
  out = out.replace(/\son[a-z-]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z-]+\s*=\s*'[^']*'/gi, '');
  return out;
}

/** 把图表容器整块换成 <img>（canvas 克隆不出来，必须用 Base64 图片） */
function fitnessPrintReplaceWithImage(html, elementId, url) {
  const source = String(html || '');
  const range = fitnessPrintFindElementRange(source, { tag: 'div', id: elementId });
  if (!range) return source;
  const image = `<img class="fp-chart-img" alt="${elementId}" src="${url}">`;
  return source.slice(0, range.start) + image + source.slice(range.end);
}

/**
 * 打印片段的清洗总入口（纯函数）。
 * @param {string} rawHTML 页面容器的 innerHTML
 * @param {Object<string,string>} chartImages 图表 id → Base64 图片地址
 */
function fitnessPrintBuildBodyHTML(rawHTML, chartImages = {}) {
  let html = String(rawHTML || '');
  // ① 图表先换成图片（容器里的 canvas 打印出来是空白的）
  Object.entries(chartImages || {}).forEach(([id, url]) => {
    if (url) html = fitnessPrintReplaceWithImage(html, id, url);
  });
  // ② 整块删掉筛选器 / 操作区
  FITNESS_PRINT_REMOVE_CLASSES.forEach(className => {
    html = fitnessPrintRemoveByClass(html, className);
  });
  // ③ 删掉剩下的按钮、下拉框和事件属性
  html = fitnessPrintStripInteractive(html);
  return html;
}

/* ==========================================================================
 * 三、DOM 部分：只负责取原始内容和图表图片
 * ========================================================================== */

/**
 * 图表 → Base64 高清图片。
 * ECharts 的 canvas 没法靠克隆 HTML 搬进打印页（复制过来是空白的），
 * 必须调 getDataURL 把它转成图片再贴进去。
 */
function fitnessPrintChartDataURL(elementId) {
  const element = document.getElementById(elementId);
  if (!element) return '';
  try {
    if (typeof echarts === 'undefined' || typeof echarts.getInstanceByDom !== 'function') return '';
    const chart = echarts.getInstanceByDom(element);
    if (!chart) return '';
    // 容器被隐藏时画布是 0 x 0，导出来是一张空白图 → 直接跳过
    if (typeof chart.getWidth === 'function' && (!chart.getWidth() || !chart.getHeight())) return '';
    return chart.getDataURL({ pixelRatio: 2, backgroundColor: '#fff' }) || '';
  } catch (error) {
    console.warn('[体测打印] 图表导出失败：', elementId, error);
    return '';
  }
}

/** 取容器原始 HTML + 图表图片 */
function fitnessPrintCollectSource(page) {
  const source = document.getElementById(page.sourceId);
  const rawHTML = source ? String(source.innerHTML || '') : '';
  const chartImages = {};
  (page.charts || []).forEach(id => {
    const url = fitnessPrintChartDataURL(id);
    if (url) chartImages[id] = url;
  });
  return { rawHTML, chartImages };
}

/** 取某个元素的文字 */
function fitnessPrintTextOf(elementId) {
  const element = document.getElementById(elementId);
  if (!element) return '';
  return String(element.textContent || '').trim();
}

/* ==========================================================================
 * 四、各页面的打印内容
 * ========================================================================== */

/** 通用：标题 + 内容 */
function fitnessPrintPageBody(page, extraHTML = '') {
  const { rawHTML, chartImages } = fitnessPrintCollectSource(page);
  const content = fitnessPrintBuildBodyHTML(rawHTML, chartImages);
  return `
    <div class="fp-doc-title">${fitnessPrintEscape(page.docTitle)}</div>
    ${extraHTML}
    <div class="fp-content">${content}</div>`;
}

/** 成绩列表（宽表 → 横向） */
function fitnessPrintRecordsBody() {
  return fitnessPrintPageBody(FITNESS_PRINT_PAGES.records);
}

/** 成绩排名（两个宽表 → 横向） */
function fitnessPrintRankingBody() {
  return fitnessPrintPageBody(FITNESS_PRINT_PAGES.ranking);
}

/**
 * 统计分析看板（图表为主 → 纵向）
 * 控制区（年级/班级 Tab、导出按钮）不打印，
 * 但"统计范围"要留在页眉下面 —— 那才是这份报表的口径。
 */
function fitnessPrintDashboardBody() {
  const scope = fitnessPrintTextOf('fitnessDashboardScope');
  return fitnessPrintPageBody(
    FITNESS_PRINT_PAGES.dashboard,
    scope ? `<div class="fp-scope">统计范围：${fitnessPrintEscape(scope)}</div>` : '',
  );
}

/* ==========================================================================
 * 五、打印内核
 * ========================================================================== */

/** 拼出打印用的独立 HTML 文档 */
function fitnessPrintDocumentHTML(page, bodyHTML) {
  const landscape = page.orientation === 'landscape';
  const cssBase = new URL('css/style.css', document.baseURI).href;
  const cssPrint = new URL('css/fitness-print.css', document.baseURI).href;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${fitnessPrintEscape(page.docTitle)}</title>
<link rel="stylesheet" href="${cssBase}">
<link rel="stylesheet" href="${cssPrint}">
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 10mm; }
  html, body { margin: 0; padding: 0; background: #fff; overflow-x: hidden; }
</style>
</head>
<body class="fp-body ${landscape ? 'is-landscape' : 'is-portrait'}">
  <div class="fp-doc">
    ${fitnessPrintHeaderHTML(page.title)}
    ${bodyHTML}
  </div>
</body>
</html>`;
}

/** 把 HTML 塞进隐藏 iframe 并触发打印 */
function fitnessPrintRun(html, orientation) {
  const frame = document.getElementById('fitnessPrintFrame');
  if (!frame) {
    showToast('打印区缺失，请刷新页面后重试', 'error');
    return;
  }
  const frameWindow = frame.contentWindow;
  const doc = frameWindow?.document;
  if (!doc) {
    showToast('打印区初始化失败，请刷新页面后重试', 'error');
    return;
  }

  // iframe 的尺寸要跟"可打印区"一致：
  //   A4 横向 297mm，减去 @page 左右各 10mm 页边距 → 可打印宽 277mm ≈ 1047px；
  //   这里故意留一点余量取 1030px。
  // ⚠️ 千万别用整页宽（1123px）当视口 —— 打印时 @page 边距会把版心缩到 1047px，
  //    多出来的 76px 会被纸边切掉，最右侧的"备注 / 弱项"就是这么没的。
  const landscape = orientation !== 'portrait';
  frame.style.width = landscape ? '1030px' : '700px';
  frame.style.height = landscape ? '700px' : '1030px';

  doc.open();
  doc.write(html);
  doc.close();
  try { frameWindow.focus(); } catch (error) { /* 忽略：部分浏览器会拒绝聚焦 */ }
  showToast('正在打开打印预览，请确认纸张方向与页边距…', 'info');
  // 等一帧让排版稳定（图片要解码完），再调打印
  setTimeout(() => {
    try {
      frameWindow.print();
    } catch (error) {
      console.error('体测页面打印失败', error);
      showToast('打印失败，请检查浏览器的打印权限设置', 'error');
    }
  }, 420);
}

/**
 * 打印当前页面（三个页面共用一个入口）。
 * @param {'records'|'ranking'|'dashboard'} pageKey
 */
function printFitnessPage(pageKey) {
  const page = FITNESS_PRINT_PAGES[pageKey] || FITNESS_PRINT_PAGES.records;
  let bodyHTML = '';
  try {
    if (page.key === 'ranking') bodyHTML = fitnessPrintRankingBody();
    else if (page.key === 'dashboard') bodyHTML = fitnessPrintDashboardBody();
    else bodyHTML = fitnessPrintRecordsBody();
  } catch (error) {
    console.error('[体测打印] 生成打印内容失败', error);
    showToast('打印内容生成失败，请刷新页面后重试', 'error');
    return;
  }
  if (!bodyHTML.replace(/<[^>]*>/g, '').trim()) {
    showToast('当前页面没有可打印的内容', 'error');
    return;
  }
  fitnessPrintRun(fitnessPrintDocumentHTML(page, bodyHTML), page.orientation);
}
