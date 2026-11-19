/**
 * 教案导出 / 打印回归测试：
 *   · 兼容 ===KEY=== 纯文本分段、## Markdown 标题、结构化字段；
 *   · Word = UTF-8 BOM + application/msword + .doc；
 *   · PDF = 隐藏 iframe 里写独立 A4 HTML 后调 print()；
 *   · UI 按钮与打印样式确实接上。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lessonsSource = fs.readFileSync(path.join(ROOT, 'js/lessons.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(ROOT, 'lessons.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

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
function extractBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`js/lessons.js 里找不到函数 ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; opened = true; }
    else if (source[i] === '}') {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`提取 ${name} 失败`);
}
function extractConst(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([\\s\\S]*?);\\n`));
  if (!match) throw new Error(`js/lessons.js 里找不到常量 ${name}`);
  return match[1];
}

const LESSON = {
  id: 'lesson-1',
  title: '排球垫球：自垫与对垫',
  grade: '四年级', sport: '排球', duration: '40分钟', difficulty: '中等', status: '待上课',
  objectiveKnowledge: '知道垫球的起源与规则',
  objectiveSkill: '能连续自垫 10 次',
  objectiveAttitude: '乐于与同伴合作练习',
  keyPoints: '击球点稳定', difficultyPoints: '力量控制',
  equipment: '排球 20 个',
  processSteps: [
    { stage: '准备部分', minutes: '8', content: '徒手模仿与球感游戏' },
    { stage: '基本部分', minutes: '25', content: '1. 自抛自垫\n2. 两人一抛一垫' },
    { stage: '结束部分', minutes: '7', content: '拉伸与小结' },
  ],
  practiceDensity: '练习密度 45%',
  reflection: '下次增加移动垫球',
};

function createSandbox({ withSections = false, withMarkdown = false } = {}) {
  const lesson = { ...LESSON };
  if (withSections) {
    lesson.content = [
      '===CONTENT===', '垫球：自垫、对垫启蒙',
      '===TARGET===', '运动能力：能连续自垫',
      '===PREPARATION===', '徒手模仿',
      '===REFLECTION===', '注意击球点',
    ].join('\n');
  }
  if (withMarkdown) {
    lesson.content = '## 一、教学内容\n垫球启蒙\n\n## 五、教学过程 · 基本部分\n两人一抛一垫\n\n## 补充：安全提示\n保持间距';
  }

  const frames = [];
  const links = [];
  const blobs = [];
  const bodyClasses = new Set();
  const timers = [];
  const link = { click: () => links.push(link), href: '', download: '' };
  const frameWindow = {
    document: {
      open: () => { frameWindow.document.written = ''; },
      write: html => { frameWindow.document.written = html; },
      close: () => {},
    },
    addEventListener: (event, handler) => { frameWindow.events[event] = handler; },
    events: {},
    focus: () => { frameWindow.focused = true; },
    print: () => { frameWindow.printed = true; },
  };
  const frame = { contentWindow: frameWindow, style: {} };
  const sandbox = {
    console,
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    Blob: class FakeBlob {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options?.type || '';
        blobs.push(this);
      }
    },
    URL: {
      createObjectURL: () => 'blob:lesson-export-test',
      revokeObjectURL: url => { sandbox.revoked = url; },
    },
    document: {
      getElementById: id => (id === 'lessonPrintFrame' ? frame : null),
      createElement: () => link,
      body: {
        classList: {
          add: name => bodyClasses.add(name),
          remove: name => bodyClasses.delete(name),
        },
      },
    },
    window: { open: () => null },
    showToast: (message, type) => { sandbox.toast = { message, type }; },
    DB: { getLessonPlans: () => [lesson] },
    LESSON_SECTION_TITLES: vm.runInNewContext(`(${extractConst(lessonsSource, 'LESSON_SECTION_TITLES')})`),
    LESSON_PROCESS_STAGES: vm.runInNewContext(`(${extractConst(lessonsSource, 'LESSON_PROCESS_STAGES')})`),
  };
  ['escapeLessonHTML', 'parseLessonSections', 'parseLessonMarkdownSections',
    'lessonExportSections', 'lessonExportMarkdownToHTML', 'buildLessonExportHTML',
    'exportLessonWord', 'printLessonPDF', 'lessonExportButtonsHTML',
  ].forEach(name => {
    vm.runInNewContext(`${extractBlock(lessonsSource, name)}\nthis.${name} = ${name};`, sandbox);
  });
  return { sandbox, lesson, frames, links, blobs, bodyClasses, timers, frame, frameWindow };
}

console.log('\n🧪 教案导出 / 打印回归测试\n');

await test('① === 分段教案：分隔符被还原成「一、教学内容」等标题', () => {
  const { sandbox, lesson } = createSandbox({ withSections: true });
  const html = sandbox.buildLessonExportHTML(lesson);
  assert(html.includes('<meta charset="UTF-8">'), '导出 HTML 必须声明 UTF-8');
  assert(html.includes('===CONTENT===') === false, '=== 分隔符不能出现在成品里');
  ['一、教学内容', '二、教学目标', '五、教学过程', '九、课后反思'].forEach(title => {
    assert(html.includes(title), `缺少标题：${title}`);
  });
  assert(html.includes('注意击球点'), '=== 分段里的反思内容必须保留');
});

await test('② Markdown 教案：## 标题映射成可读标题，未识别段落也不丢', () => {
  const { sandbox, lesson } = createSandbox({ withMarkdown: true });
  const sections = sandbox.lessonExportSections(lesson);
  assert(sections.some(item => item.title === '五、教学过程' || item.title.includes('基本部分')),
    '基本部分要映射成教学过程标题');
  assert(sections.some(item => item.body.includes('保持间距')), '未识别的补充段落要保留');
  const html = sandbox.buildLessonExportHTML(lesson);
  assert(html.includes('两人一抛一垫'), 'Markdown 正文要出现在导出里');
});

await test('③ 结构化字段：目标 / 重难点 / 器材 / 过程 / 密度 / 反思全部导出', () => {
  const { sandbox, lesson } = createSandbox();
  const html = sandbox.buildLessonExportHTML(lesson);
  [
    '知道垫球的起源与规则', '能连续自垫 10 次', '乐于与同伴合作练习',
    '击球点稳定', '力量控制', '排球 20 个',
    '徒手模仿与球感游戏', '两人一抛一垫', '练习密度 45%', '下次增加移动垫球',
  ].forEach(text => assert(html.includes(text), `缺少教案内容：${text}`));
  assert(html.includes('@page { size: A4 portrait'), '要有 A4 纵向打印规则');
  assert(html.includes('border: 1px solid #888'), '表格要有边框样式');
});

await test('④ Word 导出：UTF-8 BOM + msword 类型 + .doc 文件名', () => {
  const env = createSandbox();
  env.sandbox.exportLessonWord('lesson-1');
  equal(env.blobs.length, 1, '创建 1 个 Blob');
  equal(env.blobs[0].type, 'application/msword;charset=utf-8', 'Blob 类型正确');
  assert(env.blobs[0].parts[0] === '\ufeff', '首段必须是 UTF-8 BOM');
  assert(env.blobs[0].parts[1].includes('排球垫球'), 'Blob 里要有教案 HTML');
  equal(env.links[0].download, '排球垫球：自垫与对垫.doc', '文件名改为 .doc');
  env.timers[0].fn();
  equal(env.sandbox.revoked, 'blob:lesson-export-test', '下载完成后释放 objectURL');
});

await test('⑤ PDF 打印：隐藏 iframe 写入 A4 文档并调用 print()', () => {
  const env = createSandbox();
  env.sandbox.printLessonPDF('lesson-1');
  assert(env.frameWindow.document.written.includes('@page { size: A4 portrait'),
    '打印内容要是独立 A4 文档');
  equal(env.frame.style.width, '660px', 'iframe 宽度按 A4 版心设置');
  assert(env.bodyClasses.has('lesson-print-mode'), '打印时给 body 加专属 class');
  env.timers[0].fn();
  equal(env.frameWindow.printed, true, '要调用 iframe 的 print()');
});

await test('⑥ UI 与打印样式已接通', () => {
  ['📥 导出 Word', '🖨️ 打印 / 导出 PDF', 'exportLessonWord(', 'printLessonPDF('].forEach(text => {
    assert(lessonsSource.includes(text), `lessons.js 缺少：${text}`);
  });
  assert(htmlSource.includes('id="lessonPrintFrame"'), 'lessons.html 缺少隐藏打印 iframe');
  assert(cssSource.includes('.lesson-print-frame'), 'style.css 缺少隐藏打印区样式');
  assert(cssSource.includes('@media print'), 'style.css 缺少打印样式');
  ['.sidebar', '.topbar', '.toolbar', 'button'].forEach(selector => {
    assert(cssSource.includes(`body.lesson-print-mode ${selector}`), `打印样式没隐藏 ${selector}`);
  });
});

const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) process.exitCode = 1;
