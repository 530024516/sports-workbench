/**
 * 体育教师工作台 - 数据层
 * 使用 localStorage 持久化，首次加载注入示例数据
 */

const FITNESS_STANDARD_POINTS = [100, 95, 90, 85, 80, 78, 76, 74, 72, 70, 68, 66, 64, 62, 60, 50, 40, 30, 20, 10];
// 2014 standard tables 1-3–1-10 and 1-13–1-16; columns are ordered by grade.
// Source: https://www.scqs.gov.cn/info/9532/200033.htm
const FITNESS_STANDARD_TABLES = {
  run50: {
    male: `10.2,9.6,9.1,8.7,8.4,8.2;10.3,9.7,9.2,8.8,8.5,8.3;10.4,9.8,9.3,8.9,8.6,8.4;10.5,9.9,9.4,9.0,8.7,8.5;10.6,10.0,9.5,9.1,8.8,8.6;10.8,10.2,9.7,9.3,9.0,8.8;11.0,10.4,9.9,9.5,9.2,9.0;11.2,10.6,10.1,9.7,9.4,9.2;11.4,10.8,10.3,9.9,9.6,9.4;11.6,11.0,10.5,10.1,9.8,9.6;11.8,11.2,10.7,10.3,10.0,9.8;12.0,11.4,10.9,10.5,10.2,10.0;12.2,11.6,11.1,10.7,10.4,10.2;12.4,11.8,11.3,10.9,10.6,10.4;12.6,12.0,11.5,11.1,10.8,10.6;12.8,12.2,11.7,11.3,11.0,10.8;13.0,12.4,11.9,11.5,11.2,11.0;13.2,12.6,12.1,11.7,11.4,11.2;13.4,12.8,12.3,11.9,11.6,11.4;13.6,13.0,12.5,12.1,11.8,11.6`,
    female: `11.0,10.0,9.2,8.7,8.3,8.2;11.1,10.1,9.3,8.8,8.4,8.3;11.2,10.2,9.4,8.9,8.5,8.4;11.5,10.5,9.7,9.2,8.8,8.7;11.8,10.8,10.0,9.5,9.1,9.0;12.0,11.0,10.2,9.7,9.3,9.2;12.2,11.2,10.4,9.9,9.5,9.4;12.4,11.4,10.6,10.1,9.7,9.6;12.6,11.6,10.8,10.3,9.9,9.8;12.8,11.8,11.0,10.5,10.1,10.0;13.0,12.0,11.2,10.7,10.3,10.2;13.2,12.2,11.4,10.9,10.5,10.4;13.4,12.4,11.6,11.1,10.7,10.6;13.6,12.6,11.8,11.3,10.9,10.8;13.8,12.8,12.0,11.5,11.1,11.0;14.0,13.0,12.2,11.7,11.3,11.2;14.2,13.2,12.4,11.9,11.5,11.4;14.4,13.4,12.6,12.1,11.7,11.6;14.6,13.6,12.8,12.3,11.9,11.8;14.8,13.8,13.0,12.5,12.1,12.0`,
  },
  vitalCapacity: {
    male: `1700,2000,2300,2600,2900,3200;1600,1900,2200,2500,2800,3100;1500,1800,2100,2400,2700,3000;1400,1650,1900,2150,2450,2750;1300,1500,1700,1900,2200,2500;1240,1430,1620,1820,2110,2400;1180,1360,1540,1740,2020,2300;1120,1290,1460,1660,1930,2200;1060,1220,1380,1580,1840,2100;1000,1150,1300,1500,1750,2000;940,1080,1220,1420,1660,1900;880,1010,1140,1340,1570,1800;820,940,1060,1260,1480,1700;760,870,980,1180,1390,1600;700,800,900,1100,1300,1500;660,750,840,1030,1220,1410;620,700,780,960,1140,1320;580,650,720,890,1060,1230;540,600,660,820,980,1140;500,550,600,750,900,1050`,
    female: `1400,1600,1800,2000,2250,2500;1300,1500,1700,1900,2150,2400;1200,1400,1600,1800,2050,2300;1100,1300,1500,1700,1950,2200;1000,1200,1400,1600,1850,2100;960,1150,1340,1530,1770,2010;920,1100,1280,1460,1690,1920;880,1050,1220,1390,1610,1830;840,1000,1160,1320,1530,1740;800,950,1100,1250,1450,1650;760,900,1040,1180,1370,1560;720,850,980,1110,1290,1470;680,800,920,1040,1210,1380;640,750,860,970,1130,1290;600,700,800,900,1050,1200;580,680,780,880,1020,1170;560,660,760,860,990,1140;540,640,740,840,960,1110;520,620,720,820,930,1080;500,600,700,800,900,1050`,
  },
  sitReach: {
    male: `16.1,16.2,16.3,16.4,16.5,16.6;14.6,14.7,14.9,15.0,15.2,15.3;13.0,13.2,13.4,13.6,13.8,14.0;12.0,11.9,11.8,11.7,11.6,11.5;11.0,10.6,10.2,9.8,9.4,9.0;9.9,9.5,9.1,8.6,8.2,7.7;8.8,8.4,8.0,7.4,7.0,6.4;7.7,7.3,6.9,6.2,5.8,5.1;6.6,6.2,5.8,5.0,4.6,3.8;5.5,5.1,4.7,3.8,3.4,2.5;4.4,4.0,3.6,2.6,2.2,1.2;3.3,2.9,2.5,1.4,1.0,-0.1;2.2,1.8,1.4,0.2,-0.2,-1.4;1.1,0.7,0.3,-1.0,-1.4,-2.7;0.0,-0.4,-0.8,-2.2,-2.6,-4.0;-0.8,-1.2,-1.6,-3.2,-3.6,-5.0;-1.6,-2.0,-2.4,-4.2,-4.6,-6.0;-2.4,-2.8,-3.2,-5.2,-5.6,-7.0;-3.2,-3.6,-4.0,-6.2,-6.6,-8.0;-4.0,-4.4,-4.8,-7.2,-7.6,-9.0`,
    female: `18.6,18.9,19.2,19.5,19.8,19.9;17.3,17.6,17.9,18.1,18.5,18.7;16.0,16.3,16.6,16.9,17.2,17.5;14.7,14.8,14.9,15.0,15.1,15.2;13.4,13.3,13.2,13.1,13.0,12.9;12.3,12.2,12.1,12.0,11.9,11.8;11.2,11.1,11.0,10.9,10.8,10.7;10.1,10.0,9.9,9.8,9.7,9.6;9.0,8.9,8.8,8.7,8.6,8.5;7.9,7.8,7.7,7.6,7.5,7.4;6.8,6.7,6.6,6.5,6.4,6.3;5.7,5.6,5.5,5.4,5.3,5.2;4.6,4.5,4.4,4.3,4.2,4.1;3.5,3.4,3.3,3.2,3.1,3.0;2.4,2.3,2.2,2.1,2.0,1.9;1.6,1.5,1.4,1.3,1.2,1.1;0.8,0.7,0.6,0.5,0.4,0.3;0.0,-0.1,-0.2,-0.3,-0.4,-0.5;-0.8,-0.9,-1.0,-1.1,-1.2,-1.3;-1.6,-1.7,-1.8,-1.9,-2.0,-2.1`,
  },
  jumpRope: {
    male: `109,117,126,137,148,157;104,112,121,132,143,152;99,107,116,127,138,147;93,101,110,121,132,141;87,95,104,115,126,135;80,88,97,108,119,128;73,81,90,101,112,121;66,74,83,94,105,114;59,67,76,87,98,107;52,60,69,80,91,100;45,53,62,73,84,93;38,46,55,66,77,86;31,39,48,59,70,79;24,32,41,52,63,72;17,25,34,45,56,65;14,22,31,42,53,62;11,19,28,39,50,59;8,16,25,36,47,56;5,13,22,33,44,53;2,10,19,30,41,50`,
    female: `117,127,139,149,158,166;110,120,132,142,151,159;103,113,125,135,144,152;95,105,117,127,136,144;87,97,109,119,128,136;80,90,102,112,121,129;73,83,95,105,114,122;66,76,88,98,107,115;59,69,81,91,100,108;52,62,74,84,93,101;45,55,67,77,86,94;38,48,60,70,79,87;31,41,53,63,72,80;24,34,46,56,65,73;17,27,39,49,58,66;14,24,36,46,55,63;11,21,33,43,52,60;8,18,30,40,49,57;5,15,27,37,46,54;2,12,24,34,43,51`,
  },
  sitUps: {
    male: `48,49,50,51;45,46,47,48;42,43,44,45;39,40,41,42;36,37,38,39;34,35,36,37;32,33,34,35;30,31,32,33;28,29,30,31;26,27,28,29;24,25,26,27;22,23,24,25;20,21,22,23;18,19,20,21;16,17,18,19;14,15,16,17;12,13,14,15;10,11,12,13;8,9,10,11;6,7,8,9`,
    female: `46,47,48,49;44,45,46,47;42,43,44,45;39,40,41,42;36,37,38,39;34,35,36,37;32,33,34,35;30,31,32,33;28,29,30,31;26,27,28,29;24,25,26,27;22,23,24,25;20,21,22,23;18,19,20,21;16,17,18,19;14,15,16,17;12,13,14,15;10,11,12,13;8,9,10,11;6,7,8,9`,
  },
  run50x8: {
    male: `96,90;99,93;102,96;105,99;108,102;111,105;114,108;117,111;120,114;123,117;126,120;129,123;132,126;135,129;138,132;142,136;146,140;150,144;154,148;158,152`,
    female: `101,97;104,100;107,103;110,106;113,109;116,112;119,115;122,118;125,121;128,124;131,127;134,130;137,133;140,136;143,139;147,143;151,147;155,151;159,155;163,159`,
  },
};

const FITNESS_BMI_BOUNDS = {
  male: [[13.4, 18.1, 20.3], [13.6, 18.4, 20.4], [13.8, 19.4, 22.1], [14.1, 20.1, 22.6], [14.3, 21.4, 24.1], [14.6, 21.8, 24.5]],
  female: [[13.2, 17.3, 19.2], [13.4, 17.8, 20.2], [13.5, 18.6, 21.1], [13.6, 19.4, 22.0], [13.7, 20.5, 22.9], [14.1, 20.8, 23.6]],
};

const FITNESS_ANNUAL_WEIGHTS = [
  { BMI: 0.15, vitalCapacity: 0.15, run50: 0.20, sitReach: 0.30, jumpRope: 0.20 },
  { BMI: 0.15, vitalCapacity: 0.15, run50: 0.20, sitReach: 0.30, jumpRope: 0.20 },
  { BMI: 0.15, vitalCapacity: 0.15, run50: 0.20, sitReach: 0.20, jumpRope: 0.20, sitUps: 0.10 },
  { BMI: 0.15, vitalCapacity: 0.15, run50: 0.20, sitReach: 0.20, jumpRope: 0.20, sitUps: 0.10 },
  { BMI: 0.15, vitalCapacity: 0.15, run50: 0.20, sitReach: 0.10, jumpRope: 0.10, sitUps: 0.20, run50x8: 0.10 },
  { BMI: 0.15, vitalCapacity: 0.15, run50: 0.20, sitReach: 0.10, jumpRope: 0.10, sitUps: 0.20, run50x8: 0.10 },
];

const FITNESS_GRADE_NAMES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];
const FITNESS_SCORE_CACHE = new Map();

function fitnessGradeIndex(grade) {
  const value = String(grade ?? '').trim();
  const namedIndex = FITNESS_GRADE_NAMES.findIndex(name => value.includes(name));
  if (namedIndex >= 0) return namedIndex;
  const digit = Number(value.match(/[1-6]/)?.[0]);
  if (digit >= 1 && digit <= 6) return digit - 1;
  return -1;
}

function fitnessAcademicPeriod(record) {
  const period = String(record.semester || '').trim();
  const years = period.match(/\d{4}/g);
  if (years?.length > 1) return `${years[0]}-${years[1]}学年`;
  if (years?.length === 1) {
    const year = Number(years[0]);
    if (/(春|下|第二)/.test(period)) return `${year - 1}-${year}学年`;
    if (/(秋|上|第一)/.test(period)) return `${year}-${year + 1}学年`;
    return period;
  }
  const calendarYear = String(record.testDate || '').slice(0, 4);
  return /^\d{4}$/.test(calendarYear) ? `${calendarYear}年` : '';
}

function getFitnessScoreThresholds(testType, gender) {
  const sex = gender === '男' ? 'male' : gender === '女' ? 'female' : '';
  const encoded = FITNESS_STANDARD_TABLES[testType]?.[sex];
  if (!encoded) return null;
  const cacheKey = `${testType}:${sex}`;
  if (!FITNESS_SCORE_CACHE.has(cacheKey)) {
    FITNESS_SCORE_CACHE.set(cacheKey, encoded.split(';').map(row => row.split(',').map(Number)));
  }
  return FITNESS_SCORE_CACHE.get(cacheKey);
}

const WEEK_MODE_KEY = 'pe_week_mode';

const DB = {
  // ===== 存储键 =====
  KEYS: {
    STUDENTS: 'pe_students',
    FITNESS_RECORDS: 'pe_fitness_records',
    ATTENDANCE: 'pe_attendance',
    LESSON_PLANS: 'pe_lesson_plans',
    RESOURCES: 'pe_resources',
    COURSES: 'pe_courses',
    SCHEDULE: 'pe_schedule_v1',       // 可编辑周课表
    TODOS: 'pe_todos_v1',              // 待办清单
  },

  // ===== 初始化 =====
  init() {
    // 不再自动生成任何示例数据：库里有什么就显示什么，没有就是空
    // 数据就绪后再做结构迁移（迁移结果会写回 Supabase）
    Store.ready.then(() => {
      this._migrateSchedule();
      this._migrateTodos();
      this._migrateLessonResources();
    });
  },

  _migrateLessonResources() {
    const plans = this.getLessonPlans();
    let plansChanged = false;
    plans.forEach(plan => {
      if (!plan.objectiveKnowledge) { plan.objectiveKnowledge = ''; plansChanged = true; }
      if (!plan.objectiveSkill) { plan.objectiveSkill = plan.objectives || ''; plansChanged = true; }
      if (!plan.objectiveAttitude) { plan.objectiveAttitude = ''; plansChanged = true; }
      if (!Array.isArray(plan.processSteps)) {
        const duration = Number(String(plan.duration || '').match(/\d+/)?.[0]) || 40;
        plan.processSteps = plan.process ? [{ stage: '教学过程', minutes: duration, content: plan.process }] : [];
        plansChanged = true;
      }
      if (typeof plan.isFavorite !== 'boolean') { plan.isFavorite = false; plansChanged = true; }
    });
    if (plansChanged) this.saveLessonPlans(plans);

    const resources = this.getResources();
    let resourcesChanged = false;
    resources.forEach(resource => {
      if (!resource.resourceType) {
        resource.resourceType = resource.type === '视频' ? '视频链接'
          : ['图片', '图文'].includes(resource.type) ? '图文'
            : resource.type === '文档' ? '课件文件' : '图文';
        resourcesChanged = true;
      }
      if (!Array.isArray(resource.tags)) { resource.tags = []; resourcesChanged = true; }
    });
    if (resourcesChanged) this.set(this.KEYS.RESOURCES, resources);
  },

  // 旧课表数据迁移：把没有 odd::/even:: 前缀的 key 加上 odd:: 前缀
  _migrateSchedule() {
    try {
      const data = this.getSchedule();
      if (!data || typeof data !== 'object') return;
      let changed = false;
      const newData = {};
      for (const key in data) {
        if (key.startsWith('odd::') || key.startsWith('even::')) {
          newData[key] = data[key];
        } else {
          newData['odd::' + key] = data[key];
          changed = true;
        }
      }
      if (changed) {
        this.saveSchedule(newData);
      }
    } catch {}
  },

  // ===== 通用读写（统一走 Store：Supabase 或 localStorage） =====
  get(key) {
    try {
      return Store.read(key, []) || [];
    } catch {
      return [];
    }
  },

  set(key, data) {
    Store.write(key, data);
  },

  // ===== 学生管理 =====
  getStudents() {
    return this.get(this.KEYS.STUDENTS);
  },

  saveStudents(list) {
    const ids = new Set();
    list.forEach(student => {
      const id = String(student.id ?? '').trim();
      if (!id) throw new Error('学生学号不能为空');
      if (ids.has(id)) throw new Error(`学号 ${id} 重复，未保存学生名单`);
      ids.add(id);
    });
    this.set(this.KEYS.STUDENTS, list);
  },

  addStudent(student) {
    const list = this.getStudents();
    student.id = String(student.id || `S${Date.now()}`).trim();
    if (list.some(existing => String(existing.id) === student.id)) {
      throw new Error(`学号 ${student.id} 已存在`);
    }
    student.createdAt = student.createdAt || new Date().toISOString();
    list.push(student);
    this.saveStudents(list);
    return student;
  },

  updateStudent(id, updates) {
    const list = this.getStudents();
    const idx = list.findIndex(s => s.id === id);
    if (idx >= 0) {
      const nextId = String(updates.id ?? id).trim();
      if (list.some((student, index) => index !== idx && String(student.id) === nextId)) {
        throw new Error(`学号 ${nextId} 已存在`);
      }
      list[idx] = { ...list[idx], ...updates, id: nextId };
      this.saveStudents(list);
      return list[idx];
    }
    return null;
  },

  deleteStudent(id) {
    const list = this.getStudents().filter(s => s.id !== id);
    this.saveStudents(list);
    // 同时删除该学生的体测记录
    const records = this.getFitnessRecords().filter(r => r.studentId !== id);
    this.set(this.KEYS.FITNESS_RECORDS, records);
  },

  getStudentById(id) {
    return this.getStudents().find(s => s.id === id);
  },

  // ===== 体测数据 =====
  getFitnessRecords() {
    return this.get(this.KEYS.FITNESS_RECORDS);
  },

  saveFitnessRecords(list) {
    this.set(this.KEYS.FITNESS_RECORDS, list);
  },

  addFitnessRecord(record) {
    const list = this.getFitnessRecords();
    record.id = record.id || `F${Date.now()}`;
    record.createdAt = record.createdAt || new Date().toISOString();
    list.push(record);
    this.saveFitnessRecords(list);
    return record;
  },

  updateFitnessRecord(id, updates) {
    const list = this.getFitnessRecords();
    const idx = list.findIndex(r => r.id === id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...updates };
      this.saveFitnessRecords(list);
      return list[idx];
    }
    return null;
  },

  deleteFitnessRecord(id) {
    const list = this.getFitnessRecords().filter(r => r.id !== id);
    this.saveFitnessRecords(list);
  },

  getRecordsByStudent(studentId) {
    return this.getFitnessRecords().filter(r => r.studentId === studentId);
  },

  getRecordsByTestType(testType) {
    return this.getFitnessRecords().filter(r => r.testType === testType);
  },

  // ===== 教案 =====
  getLessonPlans() {
    return this.get(this.KEYS.LESSON_PLANS);
  },

  saveLessonPlans(list) {
    this.set(this.KEYS.LESSON_PLANS, list);
  },

  addLessonPlan(plan) {
    const list = this.getLessonPlans();
    const nextPlan = { ...plan, id: plan.id || `L${Date.now()}`, createdAt: plan.createdAt || new Date().toISOString() };
    list.push(nextPlan);
    this.saveLessonPlans(list);
    return nextPlan;
  },

  updateLessonPlan(id, updates) {
    const list = this.getLessonPlans();
    const idx = list.findIndex(p => p.id === id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...updates };
      this.saveLessonPlans(list);
      return list[idx];
    }
    return null;
  },

  deleteLessonPlan(id) {
    const list = this.getLessonPlans().filter(p => p.id !== id);
    this.saveLessonPlans(list);
  },

  // ===== 资源 =====
  getResources() {
    return this.get(this.KEYS.RESOURCES);
  },

  addResource(resource) {
    const list = this.getResources();
    const nextResource = { ...resource, id: resource.id || `R${Date.now()}`, createdAt: resource.createdAt || new Date().toISOString() };
    list.push(nextResource);
    this.set(this.KEYS.RESOURCES, list);
    return nextResource;
  },

  updateResource(id, updates) {
    const list = this.getResources();
    const index = list.findIndex(resource => resource.id === id);
    if (index < 0) return null;
    list[index] = { ...list[index], ...updates };
    this.set(this.KEYS.RESOURCES, list);
    return list[index];
  },

  deleteResource(id) {
    const list = this.getResources().filter(r => r.id !== id);
    this.set(this.KEYS.RESOURCES, list);
  },

  // ===== 课程表 =====
  getCourses() {
    return this.get(this.KEYS.COURSES);
  },

  // ===== 可编辑周课表 =====
  getSchedule() {
    const data = Store.read(this.KEYS.SCHEDULE, {});
    return data && typeof data === 'object' ? data : {};
  },

  saveSchedule(data) {
    Store.write(this.KEYS.SCHEDULE, data);
  },

  // 当前周次模式：'odd'（单周）或 'even'（双周）
  getWeekMode() {
    return Store.read(WEEK_MODE_KEY, 'odd') || 'odd';
  },

  setWeekMode(mode) {
    Store.write(WEEK_MODE_KEY, mode);
  },

  // ===== 待办清单 =====
  getTodos() {
    return this.get(this.KEYS.TODOS);
  },

  saveTodos(list) {
    this.set(this.KEYS.TODOS, list);
  },

  _migrateTodos() {
    const list = this.getTodos();
    let changed = false;
    list.forEach(todo => {
      if (!['high', 'medium', 'low'].includes(todo.priority)) {
        todo.priority = 'medium';
        changed = true;
      }
    });
    if (changed) this.saveTodos(list);
  },

  addTodo(text, priority = 'medium') {
    const list = this.getTodos();
    const todo = {
      id: Date.now(),
      text,
      priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium',
      done: false,
      time: this._now(),
    };
    list.unshift(todo);
    this.saveTodos(list);
    return todo;
  },

  toggleTodo(id) {
    const list = this.getTodos();
    const t = list.find(t => t.id === id);
    if (t) {
      t.done = !t.done;
      this.saveTodos(list);
    }
  },

  deleteTodo(id) {
    this.saveTodos(this.getTodos().filter(t => t.id !== id));
  },

  _now() {
    const d = new Date();
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  },

  // ===== 示例数据 =====







  // ===== 体测项目配置 =====
  FITNESS_ITEMS: [
    { key: 'height', name: '身高', unit: '厘米', icon: '📏' },
    { key: 'weight', name: '体重', unit: '公斤', icon: '⚖️' },
    { key: 'BMI', name: '身体质量指数', unit: '', icon: '⚖️' },
    { key: 'run50', name: '50米跑', unit: '秒', icon: '🏃' },
    { key: 'sitReach', name: '坐位体前屈', unit: '厘米', icon: '🤸' },
    { key: 'jumpRope', name: '1分钟跳绳', unit: '个', icon: '🪢' },
    { key: 'vitalCapacity', name: '肺活量', unit: '毫升', icon: '💨' },
    { key: 'sitUps', name: '1分钟仰卧起坐', unit: '个', icon: '💪' },
    { key: 'run50x8', name: '50米×8往返跑', unit: '秒', icon: '🏃' },
    { key: 'standingJump', name: '立定跳远', unit: '厘米', icon: '🦘' },
  ],

  isNationalFitnessTest(testType, grade) {
    const gradeIndex = fitnessGradeIndex(grade);
    if (['BMI', 'run50', 'sitReach', 'jumpRope', 'vitalCapacity'].includes(testType)) return gradeIndex >= 0;
    if (testType === 'sitUps') return gradeIndex >= 2;
    return testType === 'run50x8' && gradeIndex >= 4;
  },

  getFitnessScore(value, testType, gender, grade) {
    const numericValue = Number(value);
    const gradeIndex = fitnessGradeIndex(grade);
    if (!Number.isFinite(numericValue) || gradeIndex < 0 || !['男', '女'].includes(gender)) return null;

    if (testType === 'BMI') {
      // The standard bins BMI by tenths; normalize recorded values to that precision.
      const bmi = Math.round((numericValue + Number.EPSILON) * 10) / 10;
      const [underweightMax, normalMax, overweightMax] = FITNESS_BMI_BOUNDS[gender === '男' ? 'male' : 'female'][gradeIndex];
      if (bmi <= underweightMax) return { score: 80, bonus: 0, category: '偏瘦' };
      if (bmi <= normalMax) return { score: 100, bonus: 0, category: '正常' };
      if (bmi <= overweightMax) return { score: 80, bonus: 0, category: '偏胖' };
      return { score: 60, bonus: 0, category: '肥胖' };
    }

    if (!this.isNationalFitnessTest(testType, grade)) return null;
    const thresholds = getFitnessScoreThresholds(testType, gender);
    if (!thresholds) return null;
    const gradeColumn = testType === 'sitUps' ? gradeIndex - 2 : testType === 'run50x8' ? gradeIndex - 4 : gradeIndex;
    const lowerIsBetter = testType === 'run50' || testType === 'run50x8';
    let score = 0;
    for (let rowIndex = 0; rowIndex < FITNESS_STANDARD_POINTS.length; rowIndex++) {
      const threshold = thresholds[rowIndex]?.[gradeColumn];
      if (!Number.isFinite(threshold)) continue;
      if (lowerIsBetter ? numericValue <= threshold : numericValue >= threshold) {
        score = FITNESS_STANDARD_POINTS[rowIndex];
        break;
      }
    }

    let bonus = 0;
    if (testType === 'jumpRope' && score === 100) {
      const topThreshold = thresholds[0][gradeColumn];
      bonus = Math.min(20, Math.floor((numericValue - topThreshold) / 2));
    }
    return { score, bonus };
  },

  getAnnualFitnessSummary(records, grade, gender) {
    const gradeIndex = fitnessGradeIndex(grade);
    if (gradeIndex < 0 || !['男', '女'].includes(gender)) return null;
    const weights = FITNESS_ANNUAL_WEIGHTS[gradeIndex];
    const periods = new Map();
    records.forEach(record => {
      const period = fitnessAcademicPeriod(record);
      if (!period) return;
      const periodRecords = periods.get(period) || [];
      periodRecords.push(record);
      periods.set(period, periodRecords);
    });
    const latestPeriod = [...periods.entries()].sort((a, b) => {
      const latestDate = rows => rows.reduce((latest, row) => row.testDate > latest ? row.testDate : latest, '');
      return latestDate(b[1]).localeCompare(latestDate(a[1]));
    })[0];
    if (!latestPeriod) return { complete: false, missingItems: Object.keys(weights), period: '' };

    const latestByType = new Map();
    latestPeriod[1].forEach(record => {
      const current = latestByType.get(record.testType);
      if (!current || String(record.testDate || '').localeCompare(String(current.testDate || '')) > 0) {
        latestByType.set(record.testType, record);
      }
    });
    const missingItems = Object.keys(weights).filter(testType =>
      !latestByType.has(testType) || !this.getFitnessScore(latestByType.get(testType).value, testType, gender, grade));
    if (missingItems.length) {
      return { complete: false, period: latestPeriod[0], missingItems };
    }

    const standardScore = Object.entries(weights).reduce((sum, [testType, weight]) => {
      const record = latestByType.get(testType);
      return sum + this.getFitnessScore(record.value, testType, gender, grade).score * weight;
    }, 0);
    const ropeRecord = latestByType.get('jumpRope');
    const bonus = this.getFitnessScore(ropeRecord.value, 'jumpRope', gender, grade).bonus;
    const totalScore = Math.min(120, standardScore + bonus);
    const roundedScore = Math.round(totalScore * 10) / 10;
    const level = roundedScore >= 90 ? '优秀' : roundedScore >= 80 ? '良好' : roundedScore >= 60 ? '及格' : '不及格';
    return { complete: true, period: latestPeriod[0], standardScore: Math.round(standardScore * 10) / 10, bonus, totalScore: roundedScore, level };
  },

  // ===== 国标评分；不覆盖的校内扩展项目沿用原有简化评级 =====
  getGrade(value, testType, gender, grade) {
    const standardScore = this.getFitnessScore(value, testType, gender, grade);
    if (standardScore) {
      const level = standardScore.category || (standardScore.score >= 90 ? '优秀' : standardScore.score >= 80 ? '良好' : standardScore.score >= 60 ? '及格' : '不及格');
      const badgeClass = standardScore.score >= 90 ? 'badge-success' : standardScore.score >= 80 ? 'badge-info' : standardScore.score >= 60 ? 'badge-warning' : 'badge-danger';
      return { level, class: badgeClass };
    }
    if (['height', 'weight'].includes(testType)) return { level: '记录', class: 'badge-info' };
    if (['sitUps', 'run50x8'].includes(testType) && fitnessGradeIndex(grade) >= 0) {
      return { level: '不适用', class: 'badge-info' };
    }

    const standards = {
      run50: { male: [7.5, 8.5, 9.5], female: [8.0, 9.0, 10.0] }, // 秒，越低越好
      sitReach: { male: [15, 10, 5], female: [18, 13, 8] }, // 厘米，越高越好
      jumpRope: { male: [140, 110, 80], female: [140, 110, 80] }, // 个，越高越好
      vitalCapacity: { male: [2500, 2000, 1500], female: [2000, 1600, 1200] }, // 毫升
      sitUps: { male: [45, 35, 25], female: [40, 30, 20] }, // 个
      standingJump: { male: [180, 155, 130], female: [155, 130, 110] }, // 厘米，越高越好
    };
    const s = standards[testType];
    if (!s) return { level: '无', class: 'badge-info' };

    const g = gender === '男' ? s.male : s.female;

    // run50 越低越好
    if (testType === 'run50') {
      if (value <= g[0]) return { level: '优秀', class: 'badge-success' };
      if (value <= g[1]) return { level: '良好', class: 'badge-info' };
      if (value <= g[2]) return { level: '及格', class: 'badge-warning' };
      return { level: '不及格', class: 'badge-danger' };
    }

    // 其余越高越好
    if (value >= g[0]) return { level: '优秀', class: 'badge-success' };
    if (value >= g[1]) return { level: '良好', class: 'badge-info' };
    if (value >= g[2]) return { level: '及格', class: 'badge-warning' };
    return { level: '不及格', class: 'badge-danger' };
  },
};

// 初始化数据
DB.init();
