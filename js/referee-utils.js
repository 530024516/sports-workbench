'use strict';

/**
 * 裁判员字典工具（裁判员管理页 + 赛程编排页共用）
 * ─────────────────────────────────────────────────────────────
 * 现行格式：按【项目名】绑定，一个项目可以有多个人
 *   referees = {
 *     "50米": [{ name: '张老师', phone: '13800000000' }, { name: '李老师', phone: '' }],
 *     "跳远": [{ name: '王老师', phone: '13911112222' }]
 *   }
 *   键 = 项目名去空格后的小写。50 米这项比赛不论哪个年级、男/女，用的都是同一组裁判。
 *
 * 旧格式（按「年级|组别|项目」绑定、且只有一个人）：
 *   referees = { "3|male|50米": { name: '张老师', phone: '138…' } }
 * → normalize() 会自动折算成新格式（取键的最后一段当项目名），
 *   老师以前填过的裁判员不会丢，页面上也会提示"已自动升级"。
 */
(function (global) {
  /** 项目键：项目名去空格 + 小写 */
  function projectKey(eventName) {
    return String(eventName || '').trim().toLowerCase();
  }

  /** 单条数据（对象或数组）→ 干净的 [{name, phone}] 数组（去空值、去重复） */
  function toMembers(value) {
    if (!value) return [];
    const list = Array.isArray(value) ? value : [value];
    const members = [];
    list.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const name = String(item.name ?? '').trim();
      const phone = String(item.phone ?? '').trim();
      if (!name && !phone) return;
      if (members.some(member => member.name === name && member.phone === phone)) return;
      members.push({ name, phone });
    });
    return members;
  }

  /**
   * 归一化整个裁判员字典（兼容旧格式）
   * @returns {{dict: Object, migrated: boolean}} dict 为新格式，migrated 表示是否发现旧数据
   */
  function normalize(referees) {
    const dict = {};
    let migrated = false;
    if (!referees || typeof referees !== 'object' || Array.isArray(referees)) return { dict, migrated };
    Object.keys(referees).forEach(rawKey => {
      const members = toMembers(referees[rawKey]);
      if (!members.length) return;
      const parts = String(rawKey).split('|');
      const isLegacy = parts.length >= 2 || !Array.isArray(referees[rawKey]);
      if (isLegacy) migrated = true;
      const key = projectKey(parts.length >= 2 ? parts[parts.length - 1] : rawKey);
      if (!key) return;
      const merged = dict[key] || [];
      members.forEach(member => {
        if (merged.some(item => item.name === member.name && item.phone === member.phone)) return;
        merged.push(member);
      });
      dict[key] = merged;
    });
    return { dict, migrated };
  }

  /** 取某个项目的裁判名单（数组） */
  function membersOf(dict, eventName) {
    if (!dict || typeof dict !== 'object') return [];
    return dict[projectKey(eventName)] || [];
  }

  /** 裁判姓名串："张老师、李老师" */
  function namesOf(dict, eventName) {
    return membersOf(dict, eventName)
      .map(member => member.name || '（未填姓名）')
      .join('、');
  }

  /** 裁判姓名 + 电话串："张老师（13800000000）、李老师" */
  function fullOf(dict, eventName) {
    return membersOf(dict, eventName)
      .map(member => (member.phone ? `${member.name}（${member.phone}）` : member.name))
      .join('、');
  }

  /** 显示文本：没指派时返回"待指派" */
  function labelOf(dict, eventName) {
    return namesOf(dict, eventName) || '待指派';
  }

  global.RefereeUtils = {
    projectKey,
    toMembers,
    normalize,
    membersOf,
    namesOf,
    fullOf,
    labelOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
