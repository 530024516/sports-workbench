'use strict';

/**
 * 截断 JSON 的强制修复（手写扫描器，不引第三方依赖）。
 *
 * 为什么需要它：
 *   大单元一次要输出 18 个课时，模型的单次输出上限很容易把它砍成半截 JSON，
 *   常见的截断形态有三种：
 *     ① 断在某个字符串中间   {"content":"原地运球与行进间
 *     ② 断在键名或冒号后面   {"content":
 *     ③ 断在某个对象/数组里  {"objectives":{"ability":"能完成…","heal
 *   只补括号（老写法）对 ①② 无能为力 —— 补出来的 {"content":} 依旧解析失败。
 *
 * 这里的做法：扫描时记录所有「安全截断点」（字符串外遇到的 { [ , } ] 之后），
 * 截断时回退到最后一个安全点，丢掉那半截字段，再按括号栈补齐闭合符。
 * 这样第 ③ 种情况会丢掉最后一个不完整的课时，但前面的课时全部保住 —— 正是我们想要的。
 */

/** 去掉 Markdown 代码围栏，并从第一个 { 或 [ 开始 */
function jsonBodyOf(text) {
  let source = String(text ?? '').trim();
  if (source.startsWith('```')) {
    source = source.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  source = source.trim();
  const brace = source.indexOf('{');
  const bracket = source.indexOf('[');
  const starts = [brace, bracket].filter(index => index >= 0);
  if (!starts.length) return '';
  return source.slice(Math.min(...starts));
}

/** 扫一遍，收集「安全截断点」及其对应的闭合符栈 */
function scanJson(source) {
  const stack = [];            // 需要补的闭合符（栈顶是最内层）
  const cuts = [];             // { at, closers }：at 之前的内容是完整的
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        cuts.push({ at: index + 1, closers: stack.slice() });   // 一个完整的字符串值结束
      }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') { stack.push('}'); cuts.push({ at: index + 1, closers: stack.slice() }); continue; }
    if (char === '[') { stack.push(']'); cuts.push({ at: index + 1, closers: stack.slice() }); continue; }
    if (char === '}' || char === ']') {
      if (stack[stack.length - 1] === char) stack.pop();
      cuts.push({ at: index + 1, closers: stack.slice() });
      continue;
    }
    if (char === ',') { cuts.push({ at: index + 1, closers: stack.slice() }); continue; }
  }
  return { stack, cuts, inString };
}

/**
 * 把截断的 JSON 强行补成合法 JSON 并解析；失败返回 null（绝不抛异常）。
 * @param {string} text 可能被截断的内容
 * @returns {object|null}
 */
function repairTruncatedJSON(text) {
  const source = jsonBodyOf(text);
  if (!source) return null;
  try {
    return JSON.parse(source);        // 本来就是完整的，直接返回
  } catch { /* 继续抢救 */ }

  const { stack, cuts, inString } = scanJson(source);
  const candidates = [];
  // ① 整体补括号（断在字符串里时也能试一把）
  if (!inString && stack.length) {
    candidates.push(source.replace(/[,，]\s*$/, '') + stack.slice().reverse().join(''));
  }
  // ② 回退到最近的安全截断点（最多试 8 个，越靠前的点越保守）
  for (let index = cuts.length - 1; index >= 0 && candidates.length < 8; index -= 1) {
    const cut = cuts[index];
    const body = source.slice(0, cut.at).replace(/[,，]\s*$/, '');
    candidates.push(body + cut.closers.slice().reverse().join(''));
  }
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      return JSON.parse(candidates[index]);
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/** 先原文解析，失败再修复；顺带告诉调用方"是不是抢救出来的" */
function parseOrRepairJSON(text) {
  const source = jsonBodyOf(text);
  if (!source) return { data: null, repaired: false };
  try {
    return { data: JSON.parse(source), repaired: false };
  } catch { /* 继续 */ }
  const data = repairTruncatedJSON(source);
  return { data, repaired: Boolean(data) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { repairTruncatedJSON, parseOrRepairJSON, jsonBodyOf };
}
if (typeof window !== 'undefined') {
  window.repairTruncatedJSON = repairTruncatedJSON;
  window.parseOrRepairJSON = parseOrRepairJSON;
}
