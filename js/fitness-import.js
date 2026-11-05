/**
 * 体测成绩「批量录入模板」与导入解析（彻底重构版）
 *
 * 设计原则（对应《国家学生体质健康标准》）：
 *   ① 全量固定表头 —— 导出的模板第一行永远是同一组列，不按年级过滤；
 *      一二年级不需要 50米×8 往返跑 / 1分钟仰卧起坐，老师留空即可。
 *   ② 绝对容错 —— 某个格子空着 / 不是数字 / 取值不合理，
 *      只跳过【那一个字段】，绝不报错、绝不阻断整批导入。
 *   ③ 精准映射 —— 表头中文名 → 内部 testType 一一对应，导入后可直接自动算分。
 *   ④ 【零名单依赖】—— 不再校验"学号/姓名是否在学生名单里"。
 *      每一行的姓名、性别、年级、班级都直接从 Excel 里读，
 *      记录自带这些信息，导入成功即入库，不存在"找不到学生"的错误。
 *
 * 本文件独立于 fitness.js，避免把已经很长的主文件撑爆；
 * 页面里引在 fitness.js 之后（要用到 fitness.js 里的 getFitnessScoringFields 等函数）。
 */
'use strict';

/* ==========================================================================
 * 一、模板列定义（全量固定表头）
 * ========================================================================== */

/** 项目列 → 内部 testType（顺序 = 模板里的列顺序） */
const FITNESS_TEMPLATE_ITEM_KEYS = [
  'height', 'weight', 'vitalCapacity', 'run50', 'sitReach',
  'jumpRope', 'sitUps', 'run50x8', 'standingJump',
];

/**
 * 模板列（role=basic 是学生基本信息，role=item 是体测项目）
 * ⚠️ 顺序即模板里的列顺序，别随便调整（老师已经按这个顺序填过了）。
 * ℹ️ 已去掉「学号」列 —— 现在只要姓名 + 性别 + 年级 + 班级就能导入。
 */
const FITNESS_TEMPLATE_COLUMNS = [
  { key: 'studentName', header: '姓名', role: 'basic' },
  { key: 'gender', header: '性别', role: 'basic' },
  { key: 'grade', header: '年级', role: 'basic' },
  { key: 'class', header: '班级', role: 'basic' },
  { key: 'height', header: '身高(cm)', role: 'item' },
  { key: 'weight', header: '体重(kg)', role: 'item' },
  { key: 'vitalCapacity', header: '肺活量(ml)', role: 'item' },
  { key: 'run50', header: '50米跑(秒)', role: 'item' },
  { key: 'sitReach', header: '坐位体前屈(cm)', role: 'item' },
  { key: 'jumpRope', header: '1分钟跳绳(个)', role: 'item' },
  { key: 'sitUps', header: '1分钟仰卧起坐(个)', role: 'item' },
  { key: 'run50x8', header: '50米×8往返跑(秒)', role: 'item' },
  { key: 'standingJump', header: '立定跳远(cm)', role: 'item' },
];

/**
 * 表头别名（导入时用来精准识别"老师自己改过的表头"）。
 * 归一化后会去掉括号里的单位，所以"身高(cm)"和"身高"都能认。
 * ℹ️ 学号只作兼容保留（老文件里还有这一列也照样能导），新模板不再输出它。
 */
const FITNESS_TEMPLATE_ALIASES = {
  studentId: ['学号', '学生学号', '编号', '学籍号'],
  studentName: ['姓名', '名字', '学生姓名'],
  gender: ['性别'],
  grade: ['年级'],
  class: ['班级', '班次', '所在班级'],
  height: ['身高'],
  weight: ['体重'],
  vitalCapacity: ['肺活量', '最大肺活量'],
  run50: ['50米跑', '五十米跑', '50米', '50米冲刺'],
  sitReach: ['坐位体前屈', '体前屈', '坐位体前屈成绩'],
  jumpRope: ['1分钟跳绳', '一分钟跳绳', '跳绳', '跳绳1分钟'],
  sitUps: ['1分钟仰卧起坐', '一分钟仰卧起坐', '仰卧起坐', '仰卧起坐1分钟'],
  run50x8: ['50米×8往返跑', '50米x8往返跑', '50米8往返跑', '50×8往返跑', '50米×8', '往返跑'],
  standingJump: ['立定跳远'],
  BMI: ['bmi', '身体质量指数', '体质指数'],
};

/* ==========================================================================
 * 二、表头归一化与匹配
 * ========================================================================== */

/** 把表头文字归一化：去单位括号、去空白、乘号统一、全角转小写 */
function normalizeFitnessHeader(text) {
  return String(text ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')     // 去掉括号（连单位一起）
    .replace(/[（(]/g, '')
    .replace(/[）)]/g, '')
    .replace(/[\s\u3000]/g, '')            // 去掉所有空白
    .replace(/[×✕✖*]/g, 'x')              // 各种乘号 → x
    .replace(/[·・]/g, '')
    .toLowerCase();
}

/** 精确匹配表：归一化后的表头 → 内部 key */
function buildFitnessHeaderIndex() {
  const index = new Map();
  Object.entries(FITNESS_TEMPLATE_ALIASES).forEach(([key, aliases]) => {
    aliases.forEach(alias => {
      const normalized = normalizeFitnessHeader(alias);
      if (!normalized) return;
      if (!index.has(normalized)) index.set(normalized, key);
    });
  });
  // 模板自带的标准表头优先（万一别名撞车，标准表头说了算）
  FITNESS_TEMPLATE_COLUMNS.forEach(column => {
    index.set(normalizeFitnessHeader(column.header), column.key);
  });
  return index;
}

/**
 * 把老师表格里的一个表头单元格，映射到内部 key。
 * ① 精确命中 → 直接用；
 * ② 模糊命中（表头里包含某个别名）→ 取【最长】的那个别名，
 *    这样"50米"不会误认成"50米×8往返跑"，"50米×8往返跑"也不会误认成"50米跑"；
 * ③ 认不出来 → 返回 null（这一列直接忽略，不报错）。
 * @returns {string|null}
 */
function matchFitnessHeader(header, index = buildFitnessHeaderIndex()) {
  const text = normalizeFitnessHeader(header);
  if (!text) return null;
  const exact = index.get(text);
  if (exact) return exact;

  let best = null;
  let bestLength = 0;
  let tie = false;
  Object.entries(FITNESS_TEMPLATE_ALIASES).forEach(([key, aliases]) => {
    aliases.forEach(alias => {
      const normalized = normalizeFitnessHeader(alias);
      if (!normalized || !text.includes(normalized)) return;
      if (normalized.length > bestLength) {
        best = key;
        bestLength = normalized.length;
        tie = false;
      } else if (normalized.length === bestLength && best !== key) {
        tie = true;
      }
    });
  });
  return tie ? null : best;
}

/* ==========================================================================
 * 三、数值解析（绝对容错）
 * ========================================================================== */

/**
 * 宽松地把单元格变成数字：
 *   "2100" / "2100ml" / "8.1 秒" / "1,600" / "45个" 都能认；
 *   空、"abc"、"--" → null（跳过这一格，绝不报错）。
 */
function parseFitnessNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const cleaned = text.replace(/[,\s，]/g, '').replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/* ==========================================================================
 * 四、从表格行里直接解析学生信息（不查任何名单）
 * ========================================================================== */

/** 性别归一化：认不出来的就留空（该条记录不参与国标算分，但照常导入） */
function normalizeFitnessGender(text) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  if (/^(男|男性|male|m|boy|1)$/i.test(value)) return '男';
  if (/^(女|女性|female|f|girl|2)$/i.test(value)) return '女';
  return '';
}

/**
 * 每一行都是"自带的"：姓名、性别、年级、班级直接从 Excel 里读，
 * 系统用「姓名 + 班级 + 年级」算出一个稳定的内部 id（同一个学生多条记录共用一个 id）。
 * 只有【没有姓名】才跳过这一行 —— 其余缺失一律容错。
 */
function resolveFitnessRowStudent(info) {
  const name = String(info?.studentName || '').trim();
  if (!name) return null;
  const gender = normalizeFitnessGender(info?.gender);
  const grade = String(info?.grade || '').trim();
  const className = String(info?.className || '').trim();
  const studentId = typeof DB !== 'undefined' && typeof DB.makeFitnessStudentId === 'function'
    ? DB.makeFitnessStudentId({ name, grade, class: className })
    : `H${name}|${className}|${grade}`;
  return { id: studentId, name, gender, grade, class: className };
}

/* ==========================================================================
 * 五、核心解析（整批导入，绝不因单个字段失败而阻断）
 * ========================================================================== */

/**
 * 在前几行里找出表头行（老师可能在上面加了标题行）。
 * 规则：某一行里能认出 ≥2 个表头（学号/姓名/项目列任意组合）→ 就是表头行。
 */
function detectFitnessHeaderRow(rows, maxScan = 5) {
  const index = buildFitnessHeaderIndex();
  const limit = Math.min(rows.length, maxScan);
  for (let r = 0; r < limit; r += 1) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    let hits = 0;
    row.forEach(cell => { if (matchFitnessHeader(cell, index)) hits += 1; });
    if (hits >= 2) return r;
  }
  return 0;
}

/**
 * 解析整张表 → 待导入的体测记录数组。
 *
 * ⛔ 绝对容错：任何一格为空 / 不是数字 / 不合取值范围，只跳过那一格；
 *    任何一行有问题，只跳过那一行；整批导入绝不失败。
 * ⛔ 零名单依赖：不再校验"这个学生在不在名单里"，每一行自带姓名/性别/年级/班级。
 *
 * @param {Array[]} rows aoa 二维数组（第一行通常是表头）
 * @param {{testDate?:string, semester?:string}} options
 * @returns {{records:Array, warnings:string[], skipped:object, columnMap:Array, headerRowIndex:number}}
 */
function parseFitnessTemplateRows(rows, options = {}) {
  const testDate = options.testDate || '';
  const semester = options.semester || '';
  const index = buildFitnessHeaderIndex();

  const headerRowIndex = detectFitnessHeaderRow(rows);
  const headerRow = Array.isArray(rows[headerRowIndex]) ? rows[headerRowIndex] : [];
  // 每一列对应到哪个内部 key（null = 这一列不认识，直接忽略）
  const columnMap = headerRow.map(cell => matchFitnessHeader(cell, index));

  const records = [];
  const warnings = [];
  const skipped = { emptyCells: 0, invalidCells: 0, unknownStudents: 0, emptyRows: 0, unknownColumns: 0 };
  const itemMeta = {};
  if (typeof DB !== 'undefined' && Array.isArray(DB.FITNESS_ITEMS)) {
    DB.FITNESS_ITEMS.forEach(item => { itemMeta[item.key] = item; });
  }

  columnMap.forEach(key => { if (!key) skipped.unknownColumns += 1; });

  for (let r = headerRowIndex + 1; r < rows.length; r += 1) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    const isBlank = !row.length || row.every(cell => String(cell ?? '').trim() === '');
    if (isBlank) { skipped.emptyRows += 1; continue; }

    // ① 先取出这一行的基本信息
    const info = { studentId: '', studentName: '', gender: '', grade: '', className: '' };
    columnMap.forEach((key, col) => {
      if (!key) return;
      const text = String(row[col] ?? '').trim();
      if (key === 'studentId') info.studentId = text;
      else if (key === 'studentName') info.studentName = text;
      else if (key === 'gender') info.gender = text;
      else if (key === 'grade') info.grade = text;
      else if (key === 'class') info.className = text;
    });

    // ② 这一行自带学生信息（没有姓名才跳过）
    const student = resolveFitnessRowStudent(info);
    if (!student) { skipped.emptyRows += 1; continue; }

    if (!student.gender) {
      warnings.push(`第${r + 1}行「${student.name}」：没识别到性别，这条记录照常导入，但不参与国标算分`);
    }
    if (!student.grade) {
      warnings.push(`第${r + 1}行「${student.name}」：没填年级，这条记录照常导入，但不参与国标算分`);
    }

    // ③ 逐项目列取值：空 → 直接跳过（绝对容错），其它列照常录入
    let rowRecords = 0;
    columnMap.forEach((key, col) => {
      if (!key) return;
      const isItem = FITNESS_TEMPLATE_ITEM_KEYS.includes(key) || key === 'BMI';
      if (!isItem) return;

      const raw = row[col];
      const rawText = String(raw ?? '').trim();
      if (!rawText) { skipped.emptyCells += 1; return; }     // 空格子 → 只跳过这一项

      const value = parseFitnessNumber(raw);
      if (value === null) {
        skipped.invalidCells += 1;
        warnings.push(`第${r + 1}行「${student.name}」的${itemMeta[key]?.name || key}："${rawText}" 不是数字，已跳过这一项`);
        return;
      }
      if (typeof isFitnessValueValid === 'function' && !isFitnessValueValid(value, key)) {
        skipped.invalidCells += 1;
        warnings.push(`第${r + 1}行「${student.name}」的${itemMeta[key]?.name || key}："${rawText}" 取值不合理，已跳过这一项`);
        return;
      }

      const item = itemMeta[key] || { key, name: key, unit: '' };
      const scoring = typeof getFitnessScoringFields === 'function'
        ? getFitnessScoringFields(value, key, student)
        : {};
      records.push({
        studentId: student.id,
        studentName: student.name,
        gender: student.gender,
        grade: student.grade,
        class: student.class,
        testType: key,
        testName: item.name,
        unit: item.unit,
        value,
        testDate,
        semester,
        ...scoring,
      });
      rowRecords += 1;
    });

    if (rowRecords === 0) skipped.emptyRows += 1;
  }

  return { records, warnings, skipped, columnMap, headerRowIndex };
}

/* ==========================================================================
 * 六、模板导出
 * ========================================================================== */

/** 当前学期选项（秋 / 春） */
function fitnessSemesterOptions() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const list = month >= 8
    ? [`${year}秋`, `${year + 1}春`]
    : [`${year - 1}秋`, `${year}春`];
  return list;
}

/** 导出范围：年级 / 班级（只影响"预填哪些学生"，不影响表头） */
function getFitnessExportStudents() {
  const grade = document.getElementById('batchExportGrade')?.value || '';
  const className = document.getElementById('batchExportClass')?.value || '';
  // 名单来源：已录入过体测成绩的学生（不再有独立的学生信息表）
  let list = typeof DB !== 'undefined' && typeof DB.getFitnessStudents === 'function'
    ? DB.getFitnessStudents()
    : [];
  if (grade) list = list.filter(student => student.grade === grade);
  if (className) list = list.filter(student => student.class === className);
  return list;
}

/** 下载成绩模板（全量固定表头，XLSX；已删除「学号」列） */
function downloadTemplate() {
  if (typeof XLSX === 'undefined') {
    showToast('Excel 组件还没加载，请稍后再试', 'error');
    return;
  }
  const students = getFitnessExportStudents();
  const header = FITNESS_TEMPLATE_COLUMNS.map(column => column.header);
  const data = [header];
  students.forEach(student => {
    data.push([
      student.name || '',
      student.gender || '',
      student.grade || '',
      student.class || '',
      '', '', '', '', '', '', '', '', '',      // 9 个项目列留空
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = FITNESS_TEMPLATE_COLUMNS.map(column => ({
    wch: column.role === 'basic' ? 12 : 14,
  }));

  // 第二张表：填表说明（老师照着填，别改表头）
  const guide = [
    ['体测成绩录入模板 · 填表说明'],
    [''],
    ['项目', '单位', '说明'],
    ...FITNESS_TEMPLATE_ITEM_KEYS.map(key => {
      const item = DB.FITNESS_ITEMS.find(entry => entry.key === key);
      const note = (key === 'run50x8' || key === 'sitUps') ? '一年级、二年级可以不填，留空即可' : '';
      return [item?.name || key, item?.unit || '', note];
    }),
    [''],
    ['重要提醒', '', ''],
    ['1', '不要修改第一行的表头文字', '系统按表头识别每一列'],
    ['2', '没测的项目留空就行', '留空的格子会被直接跳过，不影响其它项目导入'],
    ['3', '只要有姓名就能导', '不需要先建学生名单，姓名+性别+年级+班级填好即可；同名同班会被视为同一人'],
    ['4', '只填数值', '例如肺活量填 2100，不要填 2100ml'],
    ['5', '性别和年级建议填', '这两项是国标算分依据，缺了成绩照样导入，但不参与国标算分'],
  ];
  const guideWs = XLSX.utils.aoa_to_sheet(guide);
  guideWs['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 52 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '成绩录入');
  XLSX.utils.book_append_sheet(wb, guideWs, '填表说明');
  const fileName = `体测成绩模板_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fileName);
  showToast(`模板已下载（${students.length} 名学生已预填，没有名单也可以自己填）`);
}

/* ==========================================================================
 * 七、导入流程（弹窗 → 解析 → 预览 → 入库）
 * ========================================================================== */

/** 待导入的数据（预览阶段暂存，确认后才写库） */
let fitnessBatchPending = { records: [], warnings: [], skipped: {}, rows: [] };

function openBatchImport() {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const semesters = fitnessSemesterOptions();
  const grades = [...new Set((typeof DB !== 'undefined' && DB.getFitnessStudents ? DB.getFitnessStudents() : [])
    .map(student => student.grade).filter(Boolean))];

  const bodyHTML = `
    <div class="batch-step" id="batchStep1">
      <div class="form-row">
        <div class="form-group">
          <label>测试日期 <span class="required">*</span></label>
          <input class="form-control" type="date" id="batchTestDate" value="${todayStr}">
        </div>
        <div class="form-group">
          <label>学期</label>
          <select class="form-control" id="batchSemester">
            ${semesters.map(value => `<option value="${value}">${value}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>导出范围 · 年级</label>
          <select class="form-control" id="batchExportGrade" onchange="updateFitnessExportClasses()">
            <option value="">全部年级</option>
            ${grades.map(grade => `<option value="${escapeFitnessHTML(grade)}">${escapeFitnessHTML(grade)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>导出范围 · 班级</label>
          <select class="form-control" id="batchExportClass">
            <option value="">全部班级</option>
          </select>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:20px;">
        <button class="btn btn-secondary" onclick="downloadTemplate()" style="flex:1;">
          <span>📥</span> 下载成绩模板
        </button>
        <button class="btn btn-primary" onclick="triggerUpload()" style="flex:1;">
          <span>📤</span> 上传填好的模板
        </button>
      </div>
      <input type="file" id="batchFileInput" accept=".xlsx,.xls" style="display:none;" onchange="handleFileUpload(event)">
      <div class="fitness-import-guide">
        <strong>怎么用：</strong>
        <ol>
          <li>选好测试日期（整批成绩用同一个日期）</li>
          <li>点「下载成绩模板」——表头是固定的全部国标项目，跟年级无关</li>
          <li>在 Excel 里填成绩：<b>没测的项目直接留空</b>，留空不会报错、也不会影响其它项目</li>
          <li>点「上传填好的模板」→ 预览确认 → 导入</li>
        </ol>
        <p class="fitness-import-guide-note">
          一二年级不需要 <b>50米×8往返跑</b> / <b>1分钟仰卧起坐</b>，留空即可；
          任何一格为空或不是数字，系统都只跳过那一项，其余照常导入。
        </p>
      </div>
    </div>

    <!-- 预览区 -->
    <div class="batch-step" id="batchStep2" style="display:none;">
      <div id="batchPreviewInfo" style="margin-bottom:12px;font-size:14px;"></div>
      <div class="table-wrapper" style="max-height:320px;overflow-y:auto;">
        <table class="data-table">
          <thead><tr><th>姓名</th><th>班级</th><th style="width:52%;">录入明细</th></tr></thead>
          <tbody id="batchPreviewBody"></tbody>
        </table>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-ghost" onclick="backToStep1()">返回修改</button>
        <button class="btn btn-primary" onclick="confirmBatchImport()" style="flex:1;">确认导入</button>
      </div>
    </div>

    <!-- 结果区 -->
    <div class="batch-step" id="batchStep3" style="display:none;">
      <div id="batchResultInfo" style="text-align:center;padding:20px 0;"></div>
    </div>
  `;

  const footerHTML = `<button class="btn btn-ghost" onclick="closeModal(this)">关闭</button>`;
  showModal('批量录入成绩', bodyHTML, footerHTML);
  updateFitnessExportClasses();
}

/** 年级变了 → 班级下拉跟着变（班级字典来自已录入的体测数据） */
function updateFitnessExportClasses() {
  const grade = document.getElementById('batchExportGrade')?.value || '';
  const select = document.getElementById('batchExportClass');
  if (!select) return;
  const classes = [...new Set(
    (typeof DB !== 'undefined' && DB.getFitnessStudents ? DB.getFitnessStudents() : [])
      .filter(student => !grade || student.grade === grade)
      .map(student => student.class)
      .filter(Boolean),
  )];
  select.innerHTML = '<option value="">全部班级</option>'
    + classes.map(name => `<option value="${escapeFitnessHTML(name)}">${escapeFitnessHTML(name)}</option>`).join('');
}

/** 触发文件选择 */
function triggerUpload() {
  const testDate = document.getElementById('batchTestDate')?.value;
  if (!testDate) {
    showToast('请先选择测试日期', 'error');
    return;
  }
  document.getElementById('batchFileInput')?.click();
}

/** 解析上传的文件 */
function handleFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (typeof XLSX === 'undefined') {
    showToast('Excel 组件还没加载，请稍后再试', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      if (!rows || rows.length < 2) {
        showToast('文件里没有数据行', 'error');
        return;
      }

      const testDate = document.getElementById('batchTestDate')?.value || '';
      const semester = document.getElementById('batchSemester')?.value || '';
      const parsed = parseFitnessTemplateRows(rows, { testDate, semester });

      // 一个字段都没解析出来 → 给出可读的原因（但不"阻断"其它能力）
      if (!parsed.records.length) {
        const reason = parsed.skipped.emptyRows > 0
          ? '没有读到有效成绩（请确认填了姓名，并在模板的国标项目列里填了数值）'
          : '没有读到任何有效成绩（请确认填在模板的国标项目列里）';
        showToast(reason, 'error');
        if (parsed.warnings.length) console.warn('[体测导入] 提示：', parsed.warnings);
        return;
      }

      fitnessBatchPending = parsed;

      // 预览
      document.getElementById('batchStep1').style.display = 'none';
      document.getElementById('batchStep2').style.display = 'block';
      document.getElementById('batchStep3').style.display = 'none';

      const byStudent = new Map();
      parsed.records.forEach(record => {
        if (!byStudent.has(record.studentId)) byStudent.set(record.studentId, []);
        byStudent.get(record.studentId).push(record);
      });

      const skipped = parsed.skipped;
      const skipNote = [
        skipped.emptyCells ? `${skipped.emptyCells} 个空格已跳过` : '',
        skipped.invalidCells ? `${skipped.invalidCells} 个非法值已跳过` : '',
        skipped.emptyRows ? `${skipped.emptyRows} 行没有成绩已跳过` : '',
      ].filter(Boolean).join('，');

      document.getElementById('batchPreviewInfo').innerHTML = `
        共 <strong style="color:var(--primary);">${parsed.records.length}</strong> 条成绩，
        来自 <strong>${byStudent.size}</strong> 名学生${skipNote ? `；${skipNote}` : ''}。
        ${parsed.warnings.length ? `<details style="margin-top:8px;font-size:12px;color:var(--text-secondary);"><summary>查看 ${parsed.warnings.length} 条提示（不影响导入）</summary>`
          + parsed.warnings.map(warning => `<div>${escapeFitnessHTML(warning)}</div>`).join('') + '</details>' : ''}
      `;

      document.getElementById('batchPreviewBody').innerHTML = [...byStudent.entries()].map(([, list]) => `
        <tr>
          <td><strong>${escapeFitnessHTML(list[0].studentName)}</strong></td>
          <td>${escapeFitnessHTML(list[0].grade || '')}${escapeFitnessHTML(list[0].class || '')}</td>
          <td>${list.map(record => `
            <span class="fitness-import-chip">
              <b>${escapeFitnessHTML(record.testName)}</b>
              ${record.value}${escapeFitnessHTML(record.unit || '')}
              ${record.score !== null && record.score !== undefined
                ? `<span class="badge ${escapeFitnessHTML(record.gradeClass || '')}">${escapeFitnessHTML(record.score)}${record.scoreBonus ? `+${record.scoreBonus}` : ''} ${escapeFitnessHTML(record.gradeLevel || '')}</span>`
                : ''}
            </span>`).join('')}
          </td>
        </tr>
      `).join('');
    } catch (error) {
      console.error('[体测导入] 解析失败', error);
      showToast(`文件解析失败：${error.message}`, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

/** 返回第一步 */
function backToStep1() {
  const step1 = document.getElementById('batchStep1');
  const step2 = document.getElementById('batchStep2');
  const step3 = document.getElementById('batchStep3');
  if (step1) step1.style.display = 'block';
  if (step2) step2.style.display = 'none';
  if (step3) step3.style.display = 'none';
  const input = document.getElementById('batchFileInput');
  if (input) input.value = '';
}

/** 确认导入（一次写库，别一条一条写） */
function confirmBatchImport() {
  const records = fitnessBatchPending.records || [];
  if (!records.length) {
    showToast('没有可导入的数据', 'error');
    return;
  }
  const now = new Date().toISOString();
  const stamped = records.map(record => ({
    ...record,
    id: record.id || newFitnessRecordId(),
    createdAt: record.createdAt || now,
  }));
  const existing = DB.getFitnessRecords();
  DB.saveFitnessRecords([...existing, ...stamped]);

  const studentCount = new Set(stamped.map(record => record.studentId)).size;

  document.getElementById('batchStep1').style.display = 'none';
  document.getElementById('batchStep2').style.display = 'none';
  document.getElementById('batchStep3').style.display = 'block';

  const skipped = fitnessBatchPending.skipped || {};
  const skipNote = [
    skipped.emptyCells ? `${skipped.emptyCells} 个空格已跳过` : '',
    skipped.invalidCells ? `${skipped.invalidCells} 个非法值已跳过` : '',
    skipped.emptyRows ? `${skipped.emptyRows} 行没有成绩已跳过` : '',
  ].filter(Boolean).join('，');

  document.getElementById('batchResultInfo').innerHTML = `
    <div style="font-size:48px;margin-bottom:8px;">✅</div>
    <h3 style="font-size:18px;font-weight:700;">导入完成</h3>
    <p style="color:var(--text-secondary);margin-top:4px;">
      成功导入 <strong style="color:var(--primary);">${stamped.length}</strong> 条成绩（${studentCount} 名学生）
    </p>
    ${skipNote ? `<p style="color:var(--text-secondary);font-size:13px;margin-top:6px;">${skipNote}</p>` : ''}
  `;

  refreshFitnessDataViews();
  fitnessBatchPending = { records: [], warnings: [], skipped: {}, rows: [] };
  showToast(`成功导入 ${stamped.length} 条成绩`);
}
