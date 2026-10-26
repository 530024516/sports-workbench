/**
 * 教案与资源库模块
 */

let lessonView = 'list'; // list | grid
let selectedResourceType = 'all';
let selectedResourceTag = 'all';
let favoritesOnly = false;
let aiLessonDraft = null;

Layout.init('lessons', '教案与资源库', '教案与资源');

const content = document.getElementById('page-content');

let lessons = DB.getLessonPlans();
let resources = DB.getResources();

content.innerHTML = `
  <div class="page-header">
    <div>
      <h1>教案与资源库</h1>
      <p>管理教学计划、教案与教学资源</p>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-secondary" onclick="openAddLesson()">
        <span>📋</span> 新建教案
      </button>
      <button class="btn btn-secondary" onclick="openAIGeneration()">
        <span>✨</span> AI 生成教案
      </button>
      <button class="btn btn-primary" onclick="openAddResource()">
        <span>📎</span> 添加资源
      </button>
    </div>
  </div>

  <!-- 教案区域 -->
  <div id="lessonsSection"></div>

  <!-- 分隔 -->
  <div style="height:32px;"></div>

  <!-- 资源库区域 -->
  <div id="resourcesSection"></div>
`;

Store.ready.then(() => {
  renderLessons();
  renderResources();
});

function escapeLessonHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function refreshLessonData() {
  lessons = DB.getLessonPlans();
  resources = DB.getResources();
  renderLessons();
  renderResources();
}

// ===== 教案 =====
function renderLessons() {
  lessons = DB.getLessonPlans();
  const visibleLessons = favoritesOnly ? lessons.filter(lesson => lesson.isFavorite) : lessons;
  const section = document.getElementById('lessonsSection');

  const completed = visibleLessons.filter(l => l.status === '已完成');
  const pending = visibleLessons.filter(l => l.status === '待上课');

  section.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <h2 style="font-size:18px;font-weight:700;">📚 教案管理</h2>
        <span class="badge badge-primary">共 ${visibleLessons.length} 个</span>
        <span class="badge badge-success">已完成 ${completed.length}</span>
        <span class="badge badge-warning">待上课 ${pending.length}</span>
        <span class="badge badge-primary">⭐ 收藏 ${lessons.filter(l => l.isFavorite).length}</span>
      </div>
      <div class="toolbar-right">
        <button class="btn ${favoritesOnly ? 'btn-primary' : 'btn-secondary'} btn-sm" onclick="favoritesOnly=!favoritesOnly;renderLessons()">${favoritesOnly ? '⭐ 只看收藏' : '☆ 收藏模板'}</button>
        <div class="segmented">
          <button class="${lessonView === 'grid' ? 'active' : ''}" onclick="lessonView='grid';renderLessons();">卡片</button>
          <button class="${lessonView === 'list' ? 'active' : ''}" onclick="lessonView='list';renderLessons();">列表</button>
        </div>
      </div>
    </div>

    ${lessonView === 'grid' ? renderLessonGrid(visibleLessons) : renderLessonList(visibleLessons)}
  `;
}

function renderLessonGrid(visibleLessons = lessons) {
  if (visibleLessons.length === 0) {
    return `<div class="card"><div class="card-body"><div class="empty-state"><div class="empty-icon">📋</div><p>暂无教案，点击"新建教案"开始创建</p></div></div></div>`;
  }

  return `
    <div class="grid grid-2">
      ${visibleLessons.map((l, i) => `
        <div class="card fade-in ${i < 4 ? 'fade-in-delay-' + (i+1) : ''}" style="cursor:pointer;" onclick="viewLesson('${l.id}')">
          <div class="card-header" style="padding:16px 20px;">
            <div class="card-title" style="font-size:15px;">
              <span>${getSportIcon(l.sport)}</span> ${escapeLessonHTML(l.title)}
            </div>
                <div class="lesson-card-actions">
                  <button class="btn btn-ghost btn-sm" aria-label="${l.isFavorite ? '取消收藏' : '收藏'}教案" title="${l.isFavorite ? '取消收藏' : '收藏'}" onclick="event.stopPropagation();toggleLessonFavorite('${l.id}')">${l.isFavorite ? '⭐' : '☆'}</button>
                  <span class="badge ${l.status === '已完成' ? 'badge-success' : 'badge-warning'}">${escapeLessonHTML(l.status)}</span>
                </div>
          </div>
          <div class="card-body" style="padding:16px 20px;">
            <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
              <span class="tag">${escapeLessonHTML(l.grade)}</span>
              <span class="tag">${escapeLessonHTML(l.sport)}</span>
              <span class="tag">${escapeLessonHTML(l.duration)}</span>
              <span class="tag">${escapeLessonHTML(l.difficulty)}</span>
            </div>
            <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;">
              <strong>${l.content ? '教案摘要：' : '教学目标：'}</strong>${escapeLessonHTML((l.content || l.objectiveSkill || l.objectives || '').split('\n')[0].slice(0, 140))}
            </p>
            <div class="lesson-card-footer">
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();reuseLessonTemplate('${l.id}')">↻ 复用为新教案</button>
              <span>${l.processSteps?.length ? `${l.processSteps.length} 个教学环节` : ''}</span>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderLessonList(visibleLessons = lessons) {
  if (visibleLessons.length === 0) {
    return `<div class="card"><div class="card-body"><div class="empty-state"><div class="empty-icon">📋</div><p>暂无教案</p></div></div></div>`;
  }

  return `
    <div class="card fade-in">
      <div class="card-body" style="padding:0;">
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr><th>教案标题</th><th>年级</th><th>项目</th><th>时长</th><th>难度</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${visibleLessons.map(l => `
                <tr>
                  <td><strong>${getSportIcon(l.sport)} ${escapeLessonHTML(l.title)}</strong></td>
                  <td>${escapeLessonHTML(l.grade)}</td>
                  <td><span class="tag">${escapeLessonHTML(l.sport)}</span></td>
                  <td>${escapeLessonHTML(l.duration)}</td>
                  <td>${escapeLessonHTML(l.difficulty)}</td>
                  <td><span class="badge ${l.status === '已完成' ? 'badge-success' : 'badge-warning'}">${escapeLessonHTML(l.status)}</span></td>
                  <td>
                    <button class="btn btn-ghost btn-sm" onclick="toggleLessonFavorite('${l.id}')" title="${l.isFavorite ? '取消收藏' : '收藏'}">${l.isFavorite ? '⭐' : '☆'}</button>
                    <button class="btn btn-ghost btn-sm" onclick="reuseLessonTemplate('${l.id}')" title="复用教案">↻</button>
                    <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();viewLesson('${l.id}')" title="查看">👁️</button>
                    <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openEditLesson('${l.id}')" title="编辑">✏️</button>
                    <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();confirmDeleteLesson('${l.id}')" title="删除">🗑️</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function getSportIcon(sport) {
  const icons = {
    '田径': '🏃', '篮球': '🏀', '足球': '⚽', '跳绳': '🪢',
    '体适能': '💪', '排球': '🏐', '乒乓球': '🏓', '羽毛球': '🏸',
  };
  return icons[sport] || '📋';
}

// 查看教案详情
function legacyViewLesson(id) {
  const l = DB.getLessonPlans().find(p => p.id === id);
  if (!l) return;
  const bodyHTML = `
    <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;">
      <span class="tag">${l.grade}</span>
      <span class="tag">${l.sport}</span>
      <span class="tag">${l.duration}</span>
      <span class="tag">${l.difficulty}</span>
      <span class="badge ${l.status === '已完成' ? 'badge-success' : 'badge-warning'}">${l.status}</span>
    </div>
    <div style="margin-bottom:20px;">
      <h3 style="font-size:14px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">🎯 教学目标</h3>
      <p style="white-space:pre-line;font-size:14px;line-height:1.8;">${l.objectives || '未填写'}</p>
    </div>
    <div class="grid grid-2" style="margin-bottom:20px;">
      <div style="padding:12px;background:var(--bg-hover);border-radius:var(--radius-sm);">
        <h4 style="font-size:13px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">⭐ 重点</h4>
        <p style="font-size:13px;">${l.keyPoints || '未填写'}</p>
      </div>
      <div style="padding:12px;background:var(--bg-hover);border-radius:var(--radius-sm);">
        <h4 style="font-size:13px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">⚠️ 难点</h4>
        <p style="font-size:13px;">${l.difficultyPoints || '未填写'}</p>
      </div>
    </div>
    <div style="margin-bottom:20px;">
      <h3 style="font-size:14px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">📝 教学流程</h3>
      <p style="white-space:pre-line;font-size:14px;line-height:1.8;padding:16px;background:var(--bg-hover);border-radius:var(--radius-sm);">${l.process || '未填写'}</p>
    </div>
    <div>
      <h3 style="font-size:14px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">🎒 器材准备</h3>
      <p style="font-size:14px;">${l.equipment || '未填写'}</p>
    </div>
  `;
  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">关闭</button>
    <button class="btn btn-primary" onclick="closeModal(this);openEditLesson('${id}')">编辑</button>
  `;
  showModal(`${getSportIcon(l.sport)} ${l.title}`, bodyHTML, footerHTML);
}

// 新建教案
function legacyOpenAddLesson() {
  const bodyHTML = `
    <form id="lessonForm" onsubmit="return false;">
      <div class="form-group">
        <label>教案标题 <span class="required">*</span></label>
        <input class="form-control" name="title" required placeholder="如: 短跑-50米快速跑技术">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>年级 <span class="required">*</span></label>
          <select class="form-control" name="grade">
            ${['一年级','二年级','三年级','四年级','五年级','六年级'].map(g => `<option value="${g}">${g}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>运动项目 <span class="required">*</span></label>
          <select class="form-control" name="sport">
            ${['田径','篮球','足球','跳绳','体适能','排球','乒乓球','羽毛球','其他'].map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>时长</label>
          <input class="form-control" name="duration" value="40分钟" placeholder="如: 40分钟">
        </div>
        <div class="form-group">
          <label>难度</label>
          <select class="form-control" name="difficulty">
            <option value="简单">简单</option>
            <option value="中等" selected>中等</option>
            <option value="较难">较难</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>教学目标</label>
        <textarea class="form-control" name="objectives" rows="3" placeholder="1. ...\n2. ...\n3. ..."></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>教学重点</label>
          <input class="form-control" name="keyPoints" placeholder="核心动作要领">
        </div>
        <div class="form-group">
          <label>教学难点</label>
          <input class="form-control" name="difficultyPoints" placeholder="学生容易出错的地方">
        </div>
      </div>
      <div class="form-group">
        <label>教学流程</label>
        <textarea class="form-control" name="process" rows="5" placeholder="1. 热身...\n2. 讲解示范...\n3. 分组练习...\n4. ..."></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>器材准备</label>
          <input class="form-control" name="equipment" placeholder="如: 标志筒4个、篮球24个">
        </div>
        <div class="form-group">
          <label>状态</label>
          <select class="form-control" name="status">
            <option value="待上课" selected>待上课</option>
            <option value="已完成">已完成</option>
          </select>
        </div>
      </div>
    </form>
  `;
  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="saveNewLesson()">保存教案</button>
  `;
  showModal('新建教案', bodyHTML, footerHTML);
}

function legacySaveNewLesson() {
  const form = document.getElementById('lessonForm');
  const data = Object.fromEntries(new FormData(form));
  if (!data.title) { showToast('请填写教案标题', 'error'); return; }
  DB.addLessonPlan(data);
  closeModal(document.querySelector('.modal-close'));
  // 重新加载
  location.reload();
  showToast('教案创建成功');
}

// 编辑教案
function legacyOpenEditLesson(id) {
  const l = DB.getLessonPlans().find(p => p.id === id);
  if (!l) return;
  const bodyHTML = `
    <form id="lessonForm" onsubmit="return false;">
      <input type="hidden" name="id" value="${l.id}">
      <div class="form-group">
        <label>教案标题 <span class="required">*</span></label>
        <input class="form-control" name="title" value="${l.title}" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>年级</label>
          <select class="form-control" name="grade">
            ${['一年级','二年级','三年级','四年级','五年级','六年级'].map(g => `<option value="${g}" ${l.grade === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>运动项目</label>
          <select class="form-control" name="sport">
            ${['田径','篮球','足球','跳绳','体适能','排球','乒乓球','羽毛球','其他'].map(s => `<option value="${s}" ${l.sport === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>时长</label>
          <input class="form-control" name="duration" value="${l.duration || ''}">
        </div>
        <div class="form-group">
          <label>难度</label>
          <select class="form-control" name="difficulty">
            ${['简单','中等','较难'].map(d => `<option value="${d}" ${l.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>教学目标</label>
        <textarea class="form-control" name="objectives" rows="3">${l.objectives || ''}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>教学重点</label>
          <input class="form-control" name="keyPoints" value="${l.keyPoints || ''}">
        </div>
        <div class="form-group">
          <label>教学难点</label>
          <input class="form-control" name="difficultyPoints" value="${l.difficultyPoints || ''}">
        </div>
      </div>
      <div class="form-group">
        <label>教学流程</label>
        <textarea class="form-control" name="process" rows="5">${l.process || ''}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>器材准备</label>
          <input class="form-control" name="equipment" value="${l.equipment || ''}">
        </div>
        <div class="form-group">
          <label>状态</label>
          <select class="form-control" name="status">
            <option value="待上课" ${l.status === '待上课' ? 'selected' : ''}>待上课</option>
            <option value="已完成" ${l.status === '已完成' ? 'selected' : ''}>已完成</option>
          </select>
        </div>
      </div>
    </form>
  `;
  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="saveEditLesson('${id}')">保存</button>
  `;
  showModal('编辑教案', bodyHTML, footerHTML);
}

function legacySaveEditLesson(id) {
  const form = document.getElementById('lessonForm');
  const data = Object.fromEntries(new FormData(form));
  if (!data.title) { showToast('请填写教案标题', 'error'); return; }
  DB.updateLessonPlan(id, data);
  closeModal(document.querySelector('.modal-close'));
  location.reload();
  showToast('教案已更新');
}

function confirmDeleteLesson(id) {
  const l = DB.getLessonPlans().find(p => p.id === id);
  if (!l) return;
  const bodyHTML = `<p style="font-size:15px;">确定删除教案 <strong style="color:var(--danger);">${l.title}</strong> 吗？此操作不可撤销。</p>`;
  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-danger" onclick="deleteLesson('${id}')">确认删除</button>
  `;
  showModal('删除教案', bodyHTML, footerHTML);
}

function deleteLesson(id) {
  DB.deleteLessonPlan(id);
  closeModal(document.querySelector('.modal-close'));
  location.reload();
  showToast('教案已删除');
}

// ===== 资源库 =====
function legacyRenderResources() {
  const section = document.getElementById('resourcesSection');

  const typeIcons = {
    '视频': '🎬', '文档': '📄', '图片': '🖼️', '音频': '🎵', '其他': '📎',
  };

  section.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <h2 style="font-size:18px;font-weight:700;">📦 教学资源库</h2>
        <span class="badge badge-primary">共 ${resources.length} 个</span>
      </div>
    </div>
    <div class="grid grid-4">
      ${resources.map((r, i) => `
        <div class="card fade-in ${i < 4 ? 'fade-in-delay-' + (i+1) : ''}" style="text-align:center;">
          <div class="card-body" style="padding:20px;">
            <div style="font-size:40px;margin-bottom:12px;">${typeIcons[r.type] || '📎'}</div>
            <h3 style="font-size:14px;font-weight:600;margin-bottom:6px;line-height:1.4;">${r.name}</h3>
            <div style="margin-bottom:12px;">
              <span class="tag">${r.type}</span>
              <span class="tag">${r.subject}</span>
            </div>
            <p style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">${r.size || ''}</p>
            <div style="display:flex;justify-content:center;gap:8px;">
              <button class="btn btn-ghost btn-sm" title="下载">⬇️</button>
              <button class="btn btn-ghost btn-sm" onclick="deleteResource('${r.id}')" title="删除">🗑️</button>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function legacyOpenAddResource() {
  const bodyHTML = `
    <form id="resourceForm" onsubmit="return false;">
      <div class="form-group">
        <label>资源名称 <span class="required">*</span></label>
        <input class="form-control" name="name" required placeholder="如: 50米跑技术示范视频">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>类型</label>
          <select class="form-control" name="type">
            ${['视频','文档','图片','音频','其他'].map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>所属项目</label>
          <select class="form-control" name="subject">
            ${['通用','田径','篮球','足球','跳绳','体适能','排球','乒乓球','羽毛球'].map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>文件大小</label>
        <input class="form-control" name="size" placeholder="如: 45MB">
      </div>
    </form>
  `;
  const footerHTML = `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="saveResource()">添加</button>
  `;
  showModal('添加教学资源', bodyHTML, footerHTML);
}

function legacySaveResource() {
  const form = document.getElementById('resourceForm');
  const data = Object.fromEntries(new FormData(form));
  if (!data.name) { showToast('请填写资源名称', 'error'); return; }
  DB.addResource(data);
  closeModal(document.querySelector('.modal-close'));
  location.reload();
  showToast('资源添加成功');
}

function legacyDeleteResource(id) {
  DB.deleteResource(id);
  location.reload();
  showToast('资源已删除');
}

// ===== 结构化教案 =====
function lessonFormMarkup(lesson = {}) {
  const objectives = lesson.objectives || '';
  const goalKnowledge = lesson.objectiveKnowledge || objectives.match(/(?:知识|认知)目标[：:]?\s*([^\n]+)/)?.[1] || '';
  const goalSkill = lesson.objectiveSkill || objectives.match(/(?:技能|运动技能)目标[：:]?\s*([^\n]+)/)?.[1] || objectives.split('\n')[0] || '';
  const goalAttitude = lesson.objectiveAttitude || objectives.match(/(?:情感|态度|社会适应)目标[：:]?\s*([^\n]+)/)?.[1] || '';
  const durationMinutes = Number(String(lesson.duration || '').match(/\d+/)?.[0]) || 40;
  const warmupMinutes = Math.round(durationMinutes * 0.2);
  const skillMinutes = Math.round(durationMinutes * 0.3);
  const practiceMinutes = Math.round(durationMinutes * 0.375);
  const rawProcessSteps = Array.isArray(lesson.processSteps) && lesson.processSteps.length
    ? lesson.processSteps : lesson.process ? [{ stage: '教学过程', minutes: durationMinutes, content: lesson.process }] : [
      { stage: '准备活动', minutes: warmupMinutes, content: '' },
      { stage: '技能学习', minutes: skillMinutes, content: '' },
      { stage: '练习与游戏', minutes: practiceMinutes, content: '' },
      { stage: '整理放松', minutes: durationMinutes - warmupMinutes - skillMinutes - practiceMinutes, content: '' },
    ];
  const processSteps = normalizeLessonProcessSteps(rawProcessSteps);
  const sports = ['田径', '篮球', '足球', '跳绳', '体适能', '排球', '乒乓球', '羽毛球', '其他'];
  const grades = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];
  return `
    <form id="lessonForm" onsubmit="return false;" class="lesson-form">
      <input type="hidden" name="id" value="${escapeLessonHTML(lesson.id)}">
      <input type="hidden" name="studentCount" value="${escapeLessonHTML(lesson.studentCount || '')}">
      ${lesson.content ? `<div class="form-group lesson-markdown-editor"><label>教案 Markdown 正文</label><textarea class="form-control" name="content" rows="18">${escapeLessonHTML(lesson.content)}</textarea><small>可直接编辑 Markdown 文本；查看教案时会自动排版显示。</small></div>` : ''}
      <div class="form-group">
        <label>课题名称 <span class="required">*</span></label>
        <input class="form-control" name="title" required maxlength="120" value="${escapeLessonHTML(lesson.title)}" placeholder="如：篮球原地运球">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>授课年级</label>
          <select class="form-control" name="grade">${grades.map(grade => `<option value="${grade}" ${lesson.grade === grade ? 'selected' : ''}>${grade}</option>`).join('')}</select>
        </div>
        <div class="form-group">
          <label>运动项目</label>
          <select class="form-control" name="sport">${sports.map(sport => `<option value="${sport}" ${lesson.sport === sport ? 'selected' : ''}>${sport}</option>`).join('')}</select>
        </div>
        <div class="form-group">
          <label>课时</label>
          <input class="form-control" name="duration" value="${escapeLessonHTML(lesson.duration || '40分钟')}" placeholder="如：40分钟">
        </div>
      </div>
      <fieldset class="lesson-form-section">
        <legend>教学目标（三维）</legend>
        <div class="form-group"><label>知识与认知</label><textarea class="form-control" name="objectiveKnowledge" rows="2">${escapeLessonHTML(goalKnowledge)}</textarea></div>
        <div class="form-group"><label>运动技能</label><textarea class="form-control" name="objectiveSkill" rows="2">${escapeLessonHTML(goalSkill)}</textarea></div>
        <div class="form-group"><label>情感态度与社会适应</label><textarea class="form-control" name="objectiveAttitude" rows="2">${escapeLessonHTML(goalAttitude)}</textarea></div>
      </fieldset>
      <div class="form-row">
        <div class="form-group"><label>教学重点</label><textarea class="form-control" name="keyPoints" rows="3">${escapeLessonHTML(lesson.keyPoints)}</textarea></div>
        <div class="form-group"><label>教学难点</label><textarea class="form-control" name="difficultyPoints" rows="3">${escapeLessonHTML(lesson.difficultyPoints)}</textarea></div>
      </div>
      <div class="form-group">
        <label>场地与器材</label>
        <textarea class="form-control" name="equipment" rows="2" placeholder="场地、器材与数量">${escapeLessonHTML(lesson.equipment)}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group"><label>预计练习密度与心率</label><textarea class="form-control" name="practiceDensity" rows="3" placeholder="预计练习密度与平均 / 最高心率，注明为估计值">${escapeLessonHTML(lesson.practiceDensity)}</textarea></div>
        <div class="form-group"><label>课后反思</label><textarea class="form-control" name="reflection" rows="3" placeholder="课后观察维度与反思问题">${escapeLessonHTML(lesson.reflection)}</textarea></div>
      </div>
      <div class="lesson-form-section">
        <div class="lesson-process-heading"><div><h3>教学过程与时间分配</h3><p>请填写各环节时长与活动内容。</p></div><button type="button" class="btn btn-secondary btn-sm" onclick="addLessonProcessStep()">＋ 添加环节</button></div>
        <div id="lessonTimingWarning" class="lesson-timing-warning" role="status" hidden></div>
        <div id="lessonProcessSteps">${processSteps.map((step, index) => lessonProcessStepMarkup(step, index)).join('')}</div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>难度</label><select class="form-control" name="difficulty">${['简单', '中等', '较难'].map(value => `<option value="${value}" ${(lesson.difficulty || '中等') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
        <div class="form-group"><label>状态</label><select class="form-control" name="status">${['待上课', '已完成'].map(value => `<option value="${value}" ${(lesson.status || '待上课') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
      </div>
    </form>
  `;
}

function lessonProcessStepMarkup(step = {}, index = 0) {
  return `<div class="lesson-process-row">
    <input class="form-control" data-process-stage value="${escapeLessonHTML(step.stage)}" aria-label="环节名称" placeholder="环节名称">
    <input class="form-control" data-process-minutes type="number" min="1" max="90" value="${escapeLessonHTML(step.minutes ?? '')}" aria-label="时长（分钟）" placeholder="分钟" oninput="updateLessonTimingWarning()">
    <textarea class="form-control" data-process-content rows="2" aria-label="活动内容" placeholder="教学活动内容">${escapeLessonHTML(step.content)}</textarea>
    <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.lesson-process-row').remove(); updateLessonTimingWarning()" aria-label="删除环节">删除</button>
  </div>`;
}

function getFallbackLessonMinutes(stage, index, count) {
  if (/准备|热身|导入/.test(stage)) return 6;
  if (/结束|放松|小结/.test(stage)) return 5;
  if (/基本|练习|学练|比赛/.test(stage)) return 29;
  if (count === 1) return 40;
  return index === 0 ? 6 : index === count - 1 ? 5 : 29;
}

function normalizeLessonProcessSteps(steps) {
  return steps.map((step, index) => {
    const stage = typeof step?.stage === 'string' && step.stage.trim()
      ? step.stage.trim() : `教学环节 ${index + 1}`;
    const minutes = Number(step?.minutes);
    return {
      ...step,
      stage,
      minutes: Number.isInteger(minutes) && minutes > 0
        ? minutes : getFallbackLessonMinutes(stage, index, steps.length),
      content: typeof step?.content === 'string' ? step.content : '',
    };
  });
}

function addLessonProcessStep(step = {}) {
  const container = document.getElementById('lessonProcessSteps');
  if (!container) return;
  container.insertAdjacentHTML('beforeend', lessonProcessStepMarkup(step, container.children.length));
  updateLessonTimingWarning();
}

function lessonFormData() {
  const form = document.getElementById('lessonForm');
  const data = Object.fromEntries(new FormData(form));
  const processSteps = [...form.querySelectorAll('.lesson-process-row')].map(row => ({
    stage: row.querySelector('[data-process-stage]').value.trim(),
    minutes: Number(row.querySelector('[data-process-minutes]').value) || 0,
    content: row.querySelector('[data-process-content]').value.trim(),
  })).filter(step => step.stage || step.content);
  data.processSteps = processSteps;
  data.process = processSteps.map(step => `${step.stage}（${step.minutes}分钟）：${step.content}`).join('\n');
  data.objectives = [
    data.objectiveKnowledge && `知识与认知目标：${data.objectiveKnowledge}`,
    data.objectiveSkill && `运动技能目标：${data.objectiveSkill}`,
    data.objectiveAttitude && `情感态度与社会适应目标：${data.objectiveAttitude}`,
  ].filter(Boolean).join('\n');
  return data;
}

function validateLessonTiming(data) {
  if (!data.processSteps.length) return '请至少添加一个教学过程环节';
  if (data.processSteps.some(step => !step.stage || !step.content || step.minutes < 1)) {
    return '每个教学环节都需要填写环节名称、活动内容和正整数分钟数';
  }
  return '';
}

function updateLessonTimingWarning() {
  const form = document.getElementById('lessonForm');
  const warning = form?.querySelector('#lessonTimingWarning');
  if (!form || !warning) return;
  const allocated = [...form.querySelectorAll('[data-process-minutes]')]
    .reduce((sum, field) => sum + (Number(field.value) || 0), 0);
  warning.textContent = allocated !== 40
    ? `注意：AI 生成的时间分配合计为 ${allocated} 分钟，与标准 40 分钟有偏差，请老师手动微调。`
    : '';
  warning.hidden = allocated === 40;
}

function openAddLesson(initialLesson = {}) {
  showModal(initialLesson.title ? 'AI 教案草稿（可编辑）' : '新建教案', lessonFormMarkup(initialLesson), `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    ${initialLesson.aiDraft ? '<button class="btn btn-secondary" id="continueLessonButton" onclick="continueLessonWithAI()">继续生成 / 扩写</button>' : ''}
    <button class="btn btn-primary" onclick="saveNewLesson()">保存教案</button>
  `);
  updateLessonTimingWarning();
}

async function continueLessonWithAI() {
  if (!aiLessonDraft?.content) return;
  const baseContent = aiLessonDraft.content;
  setLessonContinueState({ streaming: true });

  try {
    const result = await streamLessonMarkdown({
      mode: 'continue',
      grade: aiLessonDraft.grade,
      studentCount: aiLessonDraft.studentCount,
      topic: aiLessonDraft.title,
      lesson: { content: baseContent },
    }, text => {
      aiLessonDraft.content = text ? `${baseContent}\n\n${text}` : baseContent;
      renderLessonDraftPreview(true);
    });
    aiLessonDraft.content = result.content ? `${baseContent}\n\n${result.content}` : baseContent;
    renderLessonDraftPreview();
    if (result.truncated) {
      setLessonContinueState({ hint: `⚠️ ${result.warning || 'AI 输出未完整结束。'}可继续点击「继续生成」续写剩余部分。` });
      showToast('续写仍未写完，可继续点击「继续生成」。', 'error');
    } else {
      setLessonContinueState({});
      showToast('AI 已续写剩余内容，请核对后保存。', 'success');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '发生未知错误，请稍后重试。';
    showToast(`AI 教案续写失败：${message}`, 'error');
    setLessonContinueState({ hint: `续写失败：${message}` });
  }
}

/**
 * 流式读取统一 AI 入口 /api/ai（type: 'lesson'，SSE）
 * 每收到一段就通过 onUpdate 回调增量渲染，实现打字机效果
 * 返回 { content, truncated, warning }
 */
async function streamLessonMarkdown(payload, onUpdate) {
  let response;
  try {
    response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'lesson', ...payload }),
    });
  } catch {
    throw new Error('无法连接本地 AI 服务，请确认已运行 node server.js。');
  }

  if (!response.ok) {
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`AI 服务返回格式异常（HTTP ${response.status}），请重试。`);
    }
    throw new Error(data?.error || `AI 服务请求失败（HTTP ${response.status}）`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('浏览器不支持读取 AI 流式响应，请更新浏览器后重试。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let truncated = false;
  let warning = '';
  let frameHandle = null;

  const flushUpdate = () => {
    frameHandle = null;
    if (typeof onUpdate === 'function') onUpdate(content);
  };
  const scheduleUpdate = () => {
    if (frameHandle !== null) return;
    frameHandle = requestAnimationFrame(flushUpdate);
  };

  const consumeFrame = frame => {
    let eventName = 'message';
    const dataLines = [];
    frame.split(/\r?\n/).forEach(line => {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    });
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;

    let frameData;
    try {
      frameData = JSON.parse(data);
    } catch {
      return;
    }
    if (eventName === 'truncated' || eventName === 'error') {
      truncated = true;
      warning = frameData.warning || frameData.error || 'AI 输出未完整结束。';
      return;
    }
    const text = getLessonDeltaText(frameData.choices?.[0]?.delta);
    if (text) {
      content += text;
      scheduleUpdate();
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      frames.forEach(consumeFrame);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeFrame(buffer);
  } finally {
    if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    flushUpdate();
  }

  return { content: content.trim(), truncated, warning };
}

function getLessonDeltaText(delta) {
  if (typeof delta === 'string') return delta;
  if (typeof delta?.content === 'string') return delta.content;
  const parts = Array.isArray(delta?.content) ? delta.content : Array.isArray(delta) ? delta : null;
  return parts ? parts.map(part => (typeof part?.text === 'string' ? part.text : '')).join('') : '';
}

function renderLessonDraftPreview(autoScroll = false) {
  const preview = document.getElementById('aiGeneratedLessonContent');
  if (preview) {
    const modal = preview.closest('.modal');
    const nearBottom = modal ? modal.scrollHeight - modal.scrollTop - modal.clientHeight < 120 : false;
    preview.innerHTML = renderLessonMarkdown(aiLessonDraft?.content || '');
    if (autoScroll && modal && nearBottom) modal.scrollTop = modal.scrollHeight;
    return;
  }
  const textarea = document.querySelector('#lessonForm textarea[name="content"]');
  if (textarea) textarea.value = aiLessonDraft?.content || '';
}

function setLessonContinueState(options = {}) {
  const { streaming = false, hint = '' } = options;
  const button = document.getElementById('continueLessonButton');
  const hintNode = document.getElementById('lessonContinueHint');
  if (button) {
    button.disabled = streaming || !(aiLessonDraft?.content || '').trim();
    button.innerHTML = streaming
      ? '<span class="lesson-ai-spinner" aria-hidden="true"></span> 正在续写…'
      : '继续生成 / 续写剩余部分';
  }
  if (hintNode) {
    hintNode.textContent = hint;
    hintNode.hidden = !hint;
  }
}

function openAIGeneratedLesson(draft) {
  aiLessonDraft = draft;
  showModal(`AI 教案草稿：${escapeLessonHTML(draft.title)}`, `
    <div class="lesson-detail-tags">
      <span class="tag">${escapeLessonHTML(draft.grade)}</span>
      <span class="tag">${escapeLessonHTML(draft.sport)}</span>
      <span class="tag">${escapeLessonHTML(draft.duration)}</span>
    </div>
    <article id="aiGeneratedLessonContent" class="markdown-body lesson-full-markdown">${renderLessonMarkdown(draft.content)}</article>
    <div class="lesson-ai-continue">
      <p class="lesson-ai-continue-hint" id="lessonContinueHint" hidden></p>
      <button class="btn btn-secondary" id="continueLessonButton" type="button" onclick="continueLessonWithAI()">继续生成 / 续写剩余部分</button>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal(this)">关闭</button>
    <button class="btn btn-primary" onclick="saveAIGeneratedLesson()">保存教案</button>
  `);
}

function saveAIGeneratedLesson() {
  if (!aiLessonDraft?.content) {
    showToast('教案内容为空，无法保存。', 'error');
    return;
  }
  try {
    DB.addLessonPlan({
      title: aiLessonDraft.title,
      grade: aiLessonDraft.grade,
      sport: aiLessonDraft.sport,
      duration: aiLessonDraft.duration,
      difficulty: '中等',
      status: '待上课',
      content: aiLessonDraft.content,
      processSteps: [],
      isFavorite: false,
    });
    closeModal(document.querySelector('.modal-close'));
    aiLessonDraft = null;
    refreshLessonData();
    showToast('AI 教案已保存');
  } catch (error) {
    showToast(`教案保存失败：${error.message}`, 'error');
  }
}

function saveNewLesson() {
  const data = lessonFormData();
  if (!data.title.trim()) { showToast('请填写课题名称', 'error'); return; }
  const timingError = validateLessonTiming(data);
  if (timingError) { showToast(timingError, 'error'); return; }
  try {
    DB.addLessonPlan(data);
    closeModal(document.querySelector('.modal-close'));
    refreshLessonData();
    showToast('教案创建成功');
  } catch (error) {
    showToast(`教案保存失败：${error.message}`, 'error');
  }
}

function openEditLesson(id) {
  const lesson = DB.getLessonPlans().find(plan => plan.id === id);
  if (!lesson) { showToast('找不到该教案', 'error'); return; }
  if (lesson.content) {
    showModal('编辑 Markdown 教案', `
      <form id="markdownLessonEditForm" onsubmit="return false;">
        <div class="form-group"><label>教案标题</label><input class="form-control" name="title" maxlength="120" value="${escapeLessonHTML(lesson.title)}" required></div>
        <div class="form-group lesson-markdown-editor"><label>Markdown 正文</label><textarea class="form-control" name="content" rows="22" required>${escapeLessonHTML(lesson.content)}</textarea><small>保存后会按 Markdown 格式排版显示。</small></div>
      </form>
    `, `
      <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
      <button class="btn btn-primary" onclick="saveMarkdownLesson('${escapeLessonHTML(id)}')">保存</button>
    `);
    return;
  }
  showModal('编辑教案', lessonFormMarkup(lesson), `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" onclick="saveEditLesson('${escapeLessonHTML(id)}')">保存</button>
  `);
  updateLessonTimingWarning();
}

function saveMarkdownLesson(id) {
  const form = document.getElementById('markdownLessonEditForm');
  if (!form) return;
  const title = String(new FormData(form).get('title') || '').trim();
  const content = String(new FormData(form).get('content') || '').trim();
  if (!title || !content) {
    showToast('教案标题和 Markdown 正文不能为空。', 'error');
    return;
  }
  try {
    DB.updateLessonPlan(id, { title, content });
    closeModal(document.querySelector('.modal-close'));
    refreshLessonData();
    showToast('教案已更新');
  } catch (error) {
    showToast(`教案更新失败：${error.message}`, 'error');
  }
}

function saveEditLesson(id) {
  const data = lessonFormData();
  if (!data.title.trim()) { showToast('请填写课题名称', 'error'); return; }
  const timingError = validateLessonTiming(data);
  if (timingError) { showToast(timingError, 'error'); return; }
  try {
    DB.updateLessonPlan(id, data);
    closeModal(document.querySelector('.modal-close'));
    refreshLessonData();
    showToast('教案已更新');
  } catch (error) {
    showToast(`教案更新失败：${error.message}`, 'error');
  }
}

function renderLessonMarkdown(value) {
  const markdown = String(value || '');
  if (!markdown) return '<p class="markdown-empty">未填写</p>';
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return `<p>${escapeLessonHTML(markdown).replace(/\r?\n/g, '<br>')}</p>`;
  }
  const html = marked.parse(markdown, { breaks: true, gfm: true });
  return DOMPurify.sanitize(html);
}

function viewLesson(id) {
  const lesson = DB.getLessonPlans().find(plan => plan.id === id);
  if (!lesson) return;
  if (lesson.content) {
    const bodyHTML = `
      <div class="lesson-detail-tags"><span class="tag">${escapeLessonHTML(lesson.grade || '未指定年级')}</span><span class="tag">${escapeLessonHTML(lesson.sport || '其他')}</span><span class="tag">${escapeLessonHTML(lesson.duration || '40分钟')}</span><span class="badge ${lesson.status === '已完成' ? 'badge-success' : 'badge-warning'}">${escapeLessonHTML(lesson.status || '待上课')}</span></div>
      <article class="markdown-body lesson-full-markdown">${renderLessonMarkdown(lesson.content)}</article>
    `;
    showModal(`${getSportIcon(lesson.sport)} ${escapeLessonHTML(lesson.title)}`, bodyHTML, `
      <button class="btn btn-ghost" onclick="closeModal(this)">关闭</button>
      <button class="btn btn-secondary" onclick="closeModal(this);reuseLessonTemplate('${escapeLessonHTML(id)}')">↻ 复用为新教案</button>
      <button class="btn btn-primary" onclick="closeModal(this);openEditLesson('${escapeLessonHTML(id)}')">编辑</button>
    `);
    return;
  }
  const rawProcessSteps = lesson.processSteps?.length
    ? lesson.processSteps
    : (lesson.process || '').split('\n').filter(Boolean).map((content, index) => ({ stage: `环节 ${index + 1}`, minutes: '', content }));
  const processSteps = normalizeLessonProcessSteps(rawProcessSteps);
  const objectiveKnowledge = lesson.objectiveKnowledge || '未填写';
  const objectiveSkill = lesson.objectiveSkill || lesson.objectives || '未填写';
  const objectiveAttitude = lesson.objectiveAttitude || '未填写';
  const bodyHTML = `
    <div class="lesson-detail-tags"><span class="tag">${escapeLessonHTML(lesson.grade)}</span><span class="tag">${escapeLessonHTML(lesson.sport)}</span><span class="tag">${escapeLessonHTML(lesson.duration)}</span><span class="badge ${lesson.status === '已完成' ? 'badge-success' : 'badge-warning'}">${escapeLessonHTML(lesson.status)}</span></div>
    <section class="lesson-detail-section"><h3>教学目标（三维）</h3><div class="markdown-body lesson-detail-markdown"><p><strong>知识与认知：</strong></p>${renderLessonMarkdown(objectiveKnowledge)}<p><strong>运动技能：</strong></p>${renderLessonMarkdown(objectiveSkill)}<p><strong>情感态度与社会适应：</strong></p>${renderLessonMarkdown(objectiveAttitude)}</div></section>
    <div class="grid grid-2 lesson-detail-focus"><div><h3>教学重点</h3><div class="markdown-body lesson-detail-markdown">${renderLessonMarkdown(lesson.keyPoints)}</div></div><div><h3>教学难点</h3><div class="markdown-body lesson-detail-markdown">${renderLessonMarkdown(lesson.difficultyPoints)}</div></div></div>
    <section class="lesson-detail-section"><h3>场地与器材</h3><div class="markdown-body lesson-detail-markdown">${renderLessonMarkdown(lesson.equipment)}</div></section>
    <section class="lesson-detail-section"><h3>教学过程与时间分配</h3><ol class="lesson-process-list">${processSteps.map(step => `<li class="lesson-process-card"><div class="lesson-process-card-heading"><span class="lesson-process-time">${escapeLessonHTML(step.minutes ? `${step.minutes} 分钟` : '时间待定')}</span><strong>${escapeLessonHTML(step.stage || '教学环节')}</strong></div><div class="markdown-body lesson-detail-markdown">${renderLessonMarkdown(step.content)}</div></li>`).join('')}</ol></section>
    <section class="lesson-detail-section"><h3>预计练习密度与心率</h3><div class="markdown-body lesson-detail-markdown">${renderLessonMarkdown(lesson.practiceDensity)}</div></section>
    <section class="lesson-detail-section"><h3>课后反思</h3><div class="markdown-body lesson-detail-markdown">${renderLessonMarkdown(lesson.reflection)}</div></section>
  `;
  showModal(`${getSportIcon(lesson.sport)} ${escapeLessonHTML(lesson.title)}`, bodyHTML, `
    <button class="btn btn-ghost" onclick="closeModal(this)">关闭</button>
    <button class="btn btn-secondary" onclick="closeModal(this);reuseLessonTemplate('${escapeLessonHTML(id)}')">↻ 复用为新教案</button>
    <button class="btn btn-primary" onclick="closeModal(this);openEditLesson('${escapeLessonHTML(id)}')">编辑</button>
  `);
}

function toggleLessonFavorite(id) {
  const lesson = DB.getLessonPlans().find(plan => plan.id === id);
  if (!lesson) return;
  DB.updateLessonPlan(id, { isFavorite: !lesson.isFavorite });
  renderLessons();
  showToast(lesson.isFavorite ? '已取消收藏' : '已收藏为教案模板');
}

function reuseLessonTemplate(id) {
  const lesson = DB.getLessonPlans().find(plan => plan.id === id);
  if (!lesson) { showToast('找不到该教案模板', 'error'); return; }
  const duplicate = {
    ...lesson,
    id: undefined,
    title: `${lesson.title}（复用）`,
    status: '待上课',
    isFavorite: false,
    processSteps: lesson.processSteps?.map(step => ({ ...step })) || [],
  };
  try {
    DB.addLessonPlan(duplicate);
    refreshLessonData();
    showToast('已基于模板创建新教案');
  } catch (error) {
    showToast(`教案复用失败：${error.message}`, 'error');
  }
}

function openAIGeneration() {
  showModal('AI 智能生成教案', `
    <form id="aiLessonForm" onsubmit="return false;">
      <p class="lesson-ai-disclaimer">AI 将生成可阅读、可继续扩写的 Markdown 教案。保存前请核对教学内容与安全安排。不会发送学生个人信息。</p>
      <div class="form-row">
        <div class="form-group"><label>授课年级</label><select class="form-control" name="grade">${['一年级','二年级','三年级','四年级','五年级','六年级'].map(grade => `<option value="${grade}">${grade}</option>`).join('')}</select></div>
        <div class="form-group"><label>班级人数</label><input class="form-control" name="studentCount" type="number" min="1" max="100" value="30" required></div>
      </div>
      <div class="form-group"><label>课题</label><input class="form-control" name="topic" maxlength="120" required placeholder="如：篮球原地运球"></div>
      <small>AI 需要通过本地服务端调用。请使用 node server.js 启动，并在项目根目录的 .env.local 配置智谱 API Key。</small>
    </form>
  `, `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-primary" id="generateLessonButton" onclick="generateLessonWithAI()"><span>✨</span> 生成教案草稿</button>
  `);
}

async function generateLessonWithAI() {
  const form = document.getElementById('aiLessonForm');
  if (!form) return;
  const input = Object.fromEntries(new FormData(form));
  if (!input.topic?.trim() || !input.studentCount) { showToast('请填写课题和班级人数', 'error'); return; }
  const button = document.getElementById('generateLessonButton');
  button.disabled = true;
  button.innerHTML = '<span class="lesson-ai-spinner" aria-hidden="true"></span> 正在生成教案…';

  const draft = {
    title: input.topic.trim(),
    grade: input.grade,
    sport: '其他',
    duration: '40分钟',
    studentCount: Number(input.studentCount),
    content: '',
  };

  try {
    closeModal(document.querySelector('.modal-close'));
    openAIGeneratedLesson(draft);
    const preview = document.getElementById('aiGeneratedLessonContent');
    if (preview) {
      preview.innerHTML = '<p class="markdown-empty"><span class="lesson-ai-spinner" aria-hidden="true"></span> AI 正在生成教案，内容将实时显示…</p>';
    }
    setLessonContinueState({ streaming: true });

    const result = await streamLessonMarkdown({
      grade: draft.grade,
      studentCount: draft.studentCount,
      topic: draft.title,
    }, text => {
      aiLessonDraft.content = text;
      renderLessonDraftPreview(true);
    });
    aiLessonDraft.content = result.content;
    renderLessonDraftPreview();
    if (result.truncated) {
      setLessonContinueState({ hint: `⚠️ ${result.warning || 'AI 输出未完整结束。'}可点击「继续生成」续写剩余部分。` });
      showToast('AI 输出已达上限，可点击「继续生成」续写剩余部分。', 'error');
    } else {
      setLessonContinueState({});
      showToast('AI 教案生成完成，请核对后保存。', 'success');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '发生未知错误，请稍后重试。';
    showToast(`AI 教案生成失败：${message}`, 'error');
    setLessonContinueState({ hint: `生成失败：${message}` });
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = '<span>✨</span> 生成教案草稿';
    }
  }
}

function renderResources() {
  resources = DB.getResources();
  const section = document.getElementById('resourcesSection');
  const filtered = resources.filter(resource =>
    (selectedResourceType === 'all' || resource.resourceType === selectedResourceType) &&
    (selectedResourceTag === 'all' || (resource.tags || []).includes(selectedResourceTag)));
  const allTags = [...new Set(resources.flatMap(resource => resource.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const icons = { '图文': '🖼️', '视频链接': '🎬', '课件文件': '📑' };
  section.innerHTML = `
    <div class="toolbar resource-toolbar">
      <div class="toolbar-left"><h2 style="font-size:18px;font-weight:700;">📦 教学资源库</h2><span class="badge badge-primary">共 ${resources.length} 个</span></div>
      <div class="toolbar-right">
        <select class="form-control" aria-label="按资源类型筛选" onchange="selectedResourceType=this.value;renderResources()">
          ${[['all','全部类型'],['图文','图文'],['视频链接','视频链接'],['课件文件','课件文件']].map(([value,label]) => `<option value="${value}" ${selectedResourceType === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <select class="form-control" aria-label="按标签筛选" onchange="selectedResourceTag=this.value;renderResources()">
          <option value="all">全部标签</option>${allTags.map(tag => `<option value="${escapeLessonHTML(tag)}" ${selectedResourceTag === tag ? 'selected' : ''}>#${escapeLessonHTML(tag)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${filtered.length ? `<div class="resource-card-grid">${filtered.map((resource, index) => `
      <article class="card resource-card fade-in ${index < 4 ? `fade-in-delay-${index + 1}` : ''}">
        <div class="resource-card-icon">${icons[resource.resourceType] || '📎'}</div>
        <div class="resource-card-content">
          <span class="badge badge-info">${escapeLessonHTML(resource.resourceType || '图文')}</span>
          <h3>${escapeLessonHTML(resource.name)}</h3>
          <p>${escapeLessonHTML(resource.description || resource.subject || '')}</p>
          <div class="resource-tags">${(resource.tags || []).map(tag => `<button class="tag" onclick="selectedResourceTag='${escapeLessonHTML(tag)}';renderResources()">#${escapeLessonHTML(tag)}</button>`).join('')}</div>
          <div class="resource-card-meta"><span>${escapeLessonHTML(resource.subject || '通用')}</span><span>${escapeLessonHTML(resource.size || '')}</span></div>
          <div class="resource-card-actions">
            ${resource.dataUrl ? `<a class="btn btn-secondary btn-sm" href="${escapeLessonHTML(resource.dataUrl)}" download="${escapeLessonHTML(resource.fileName || resource.name)}">下载文件</a>` : resource.url && (resource.url.startsWith('https://') || resource.url.startsWith('http://')) ? `<a class="btn btn-secondary btn-sm" href="${escapeLessonHTML(resource.url)}" target="_blank" rel="noopener noreferrer">${resource.resourceType === '视频链接' ? '打开视频' : '打开资源'}</a>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="deleteResource('${escapeLessonHTML(resource.id)}')" title="删除资源">🗑️</button>
          </div>
        </div>
      </article>`).join('')}</div>` : '<div class="card"><div class="card-body"><div class="empty-state"><div class="empty-icon">📦</div><p>没有符合筛选条件的资源</p></div></div></div>'}
  `;
}

let pendingResourceFile = null;

function openAddResource() {
  pendingResourceFile = null;
  showModal('添加教学资源', `
    <form id="resourceForm" onsubmit="return false;">
      <div class="form-group"><label>资源名称 <span class="required">*</span></label><input class="form-control" name="name" maxlength="120" required placeholder="如：篮球原地运球示范"></div>
      <div class="form-row">
        <div class="form-group"><label>资源类型</label><select class="form-control" name="resourceType" id="resourceType" onchange="updateResourceInput()"><option>图文</option><option>视频链接</option><option>课件文件</option></select></div>
        <div class="form-group"><label>所属项目</label><select class="form-control" name="subject">${['通用','田径','篮球','足球','跳绳','体适能','排球','乒乓球','羽毛球'].map(subject => `<option>${subject}</option>`).join('')}</select></div>
      </div>
      <div class="form-group"><label>简介</label><textarea class="form-control" name="description" rows="2" placeholder="资源说明或适用场景"></textarea></div>
      <div class="form-group"><label>标签（逗号分隔）</label><input class="form-control" name="tags" placeholder="篮球，热身游戏，体能训练"></div>
      <div id="resourceInputArea"></div>
    </form>
  `, `<button class="btn btn-ghost" onclick="closeModal(this)">取消</button><button class="btn btn-primary" onclick="saveResource()">添加资源</button>`);
  updateResourceInput();
}

function updateResourceInput() {
  const type = document.getElementById('resourceType')?.value;
  const area = document.getElementById('resourceInputArea');
  if (!area) return;
  area.innerHTML = type === '课件文件'
    ? `<div class="form-group"><label>课件文件（本地浏览器保存上限 1MB）</label><input class="form-control" type="file" id="resourceFile" accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.jpg,.png" onchange="readResourceFile(this)"><small id="resourceFileStatus">选择文件后将保存到本机浏览器。</small></div><div class="form-group"><label>或填写已有课件链接</label><input class="form-control" name="url" type="url" placeholder="https://…"></div>`
    : `<div class="form-group"><label>${type === '视频链接' ? '视频链接' : '图片 / 文章链接'}</label><input class="form-control" name="url" type="url" placeholder="https://…"></div>`;
}

function readResourceFile(input) {
  const file = input.files?.[0];
  pendingResourceFile = null;
  if (!file) return;
  if (file.size > 1024 * 1024) {
    input.value = '';
    document.getElementById('resourceFileStatus').textContent = '文件超过 1MB，请改用课件链接。';
    showToast('为避免占满浏览器存储，本地课件文件不能超过 1MB', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => showToast('读取课件文件失败', 'error');
  reader.onload = () => {
    pendingResourceFile = { name: file.name, size: file.size, dataUrl: String(reader.result) };
    document.getElementById('resourceFileStatus').textContent = `已选择：${file.name}（${formatResourceSize(file.size)}）`;
  };
  reader.readAsDataURL(file);
}

function formatResourceSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function saveResource() {
  const form = document.getElementById('resourceForm');
  const data = Object.fromEntries(new FormData(form));
  if (!data.name?.trim()) { showToast('请填写资源名称', 'error'); return; }
  const url = (data.url || '').trim();
  if (url && !(url.startsWith('https://') || url.startsWith('http://'))) { showToast('资源链接必须以 http:// 或 https:// 开头', 'error'); return; }
  const tags = [...new Set((data.tags || '').split(/[，,、]/).map(tag => tag.trim().replace(/^#/, '')).filter(Boolean))];
  const resource = {
    name: data.name.trim(),
    resourceType: data.resourceType,
    type: data.resourceType,
    subject: data.subject,
    description: (data.description || '').trim(),
    tags,
    url: pendingResourceFile?.dataUrl || url,
    fileName: pendingResourceFile?.name || '',
    size: pendingResourceFile ? formatResourceSize(pendingResourceFile.size) : '',
    dataUrl: pendingResourceFile?.dataUrl || '',
  };
  try {
    DB.addResource(resource);
    pendingResourceFile = null;
    closeModal(document.querySelector('.modal-close'));
    resources = DB.getResources();
    renderResources();
    showToast('资源已添加');
  } catch (error) {
    showToast(`资源保存失败：${error.message}`, 'error');
  }
}

function deleteResource(id) {
  if (!DB.getResources().some(resource => resource.id === id)) return;
  DB.deleteResource(id);
  resources = DB.getResources();
  renderResources();
  showToast('资源已删除');
}

function confirmDeleteLesson(id) {
  const lesson = DB.getLessonPlans().find(plan => plan.id === id);
  if (!lesson) return;
  showModal('删除教案', `<p>确定删除教案 <strong>${escapeLessonHTML(lesson.title)}</strong> 吗？此操作不可撤销。</p>`, `
    <button class="btn btn-ghost" onclick="closeModal(this)">取消</button>
    <button class="btn btn-danger" onclick="deleteLesson('${escapeLessonHTML(id)}')">确认删除</button>
  `);
}

function deleteLesson(id) {
  DB.deleteLessonPlan(id);
  closeModal(document.querySelector('.modal-close'));
  refreshLessonData();
  showToast('教案已删除');
}
