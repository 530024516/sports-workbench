/**
 * 「教材大类 / 细项 → 水平 → 教学内容」映射字典（大单元设计三选项联动用）
 *
 * 分类依据：《义务教育体育与健康课程标准（2022年版）》专项运动技能六大类
 *   —— 球类、田径类、体操类、中华传统体育类、新兴体育类、水上或冰雪类。
 * 水平划分：水平一（1–2年级）侧重基本运动技能；水平二（3–4年级）、水平三（5–6年级）、
 *          水平四（7–9年级）逐步过渡到专项运动技能模块学习。
 *
 * ⚠️ 诚实声明（重要）：
 *   课标正文只给出"类目 + 内容要求 + 学业质量"的框架，并不逐条列出上表的"教学内容"，
 *   因此本字典的条目是【按课标类目整理的常用教材内容】，不是课标逐字原文。
 *   凡是调研不到确切依据、或高度依赖本校条件（如游泳场馆、冰雪场地、初中阶段）的条目，
 *   一律以 [待确认] 开头标注，页面上会打橙色标记提醒老师核对，不得直接当课标条款使用。
 *
 * 田径类按「跑类 / 跳跃类 / 投掷类 / 跑跳投综合」四个子类组织（旧版五个细项的 id 走
 * UNIT_ITEM_ALIASES 映射，老师以前保存的数据不会失效）。
 *
 * 用法（window 全局）：
 *   UNIT_LEVELS                 水平选项
 *   UNIT_CATALOG                六大类 → 细项 → topics[水平]
 *   findUnitCatalogItem(id)     按细项 id 取条目（含旧 id 映射）
 *   listUnitTopics(itemId, lv)  取某细项在某水平下的教学内容（可能含 [待确认] 项）
 *   unitCatalogBrief(itemId, lv) 取「细项 + 水平 + 完整教学内容清单」，供 AI prompt 使用
 */
'use strict';

const UNIT_LEVELS = [
  { id: 'L1', label: '水平一（1–2 年级）', stage: '以基本运动技能为主，游戏化、情境化启蒙' },
  { id: 'L2', label: '水平二（3–4 年级）', stage: '基本运动技能向专项运动技能过渡，学习单一技术' },
  { id: 'L3', label: '水平三（5–6 年级）', stage: '组合技术与简单战术，开始正式比赛与规则学习' },
  { id: 'L4', label: '水平四（7–9 年级）', stage: '专项运动技能系统化，战术运用与比赛能力提升' },
];

/* 缩写约定：T = [待确认] 前缀，便于集中管理 */
const T = '[待确认] ';

/**
 * 教学内容的「七大维度」（水平二至四的球类细项按这七个维度组织）。
 * 没有内容的维度不会出现在下拉框里（例如水平二没有战术、多数水平没有观赏），
 * 保持"有什么写什么"，不为了凑维度而编条目。
 */
const UNIT_DIMENSIONS = [
  { id: 'basic', label: '基础知识' },
  { id: 'technique', label: '基本技术' },
  { id: 'tactic', label: '战术' },
  { id: 'fitness', label: '体能' },
  { id: 'match', label: '比赛' },
  { id: 'rule', label: '规则' },
  { id: 'watch', label: '观赏' },
];

/** 维度的显示名（未知维度返回空串） */
function unitDimensionLabel(dimensionId) {
  const dimension = UNIT_DIMENSIONS.find(entry => entry.id === dimensionId);
  return dimension ? dimension.label : '';
}

const UNIT_CATALOG = [
  {
    id: 'ball',
    label: '球类',
    note: '同场对抗与隔网对抗项目为主，突出球感、传接、投篮/射门与团队配合；水平二至四按「基础知识 / 基本技术 / 战术 / 体能 / 比赛 / 规则 / 观赏」七个维度组织。',
    items: [
      {
        id: 'basketball',
        label: '篮球',
        topics: {
          L1: [
            '熟悉球性游戏：抛接球、滚球、地面拍球、抱球跑',
            '篮球情境下的移动性技能游戏：跑、停、变向、躲闪',
            '原地与移动中的拍球比多、球性小竞赛',
            `${T}小篮球：低篮架投篮启蒙（视本校器材条件开设）`,
          ],
          L2: [
            { dim: 'basic', text: '篮球运动的起源与场地器材小常识' },
            { dim: 'basic', text: '小篮球的简单规则认知（得分、出界、走步）' },
            { dim: 'technique', text: '移动：基本站立姿势、起动、变向跑、侧身跑' },
            { dim: 'technique', text: '原地运球（高低运球）与行进间直线、曲线运球' },
            { dim: 'technique', text: '双手胸前传接球' },
            { dim: 'technique', text: '双手胸前投篮（小篮球规则、低篮架）' },
            { dim: 'fitness', text: '追逐跑、折线跑、变向跑' },
            { dim: 'fitness', text: '滚球与滚球接力游戏（球性＋灵敏）' },
            { dim: 'match', text: '运球、传球展示与小组表演' },
            { dim: 'match', text: '简化规则的小篮球赛（2v2 / 3v3）' },
            { dim: 'rule', text: '知道基本规则：走步、两次运球等简单违例' },
            { dim: 'watch', text: '观看篮球比赛，能说出场上人数与得分方式' },
          ],
          L3: [
            { dim: 'basic', text: '场地器材认知与安全防护（低篮架、小篮球、场地检查）' },
            { dim: 'basic', text: '篮球运动的锻炼价值与锻炼常识' },
            { dim: 'technique', text: '原地变向运球（体前换手、胯下启蒙）' },
            { dim: 'technique', text: '单手肩上传接球' },
            { dim: 'technique', text: '原地单手肩上投篮' },
            { dim: 'technique', text: '顺步持球突破' },
            { dim: 'technique', text: '个人防守：防守站位、滑步堵截与卡位' },
            { dim: 'tactic', text: '长传快攻' },
            { dim: 'tactic', text: '传切配合：传球后切入、二过一' },
            { dim: 'tactic', text: '侧掩护' },
            { dim: 'tactic', text: '半场人盯人防守' },
            { dim: 'fitness', text: '滑步与滑步接力' },
            { dim: 'fitness', text: '多障碍跳跃' },
            { dim: 'fitness', text: '起跳摸高' },
            { dim: 'fitness', text: '绕球（球性＋腰腹控制）' },
            { dim: 'match', text: '半场 3v3 比赛' },
            { dim: 'match', text: '全场 5v5 简化规则比赛' },
            { dim: 'match', text: '比赛中的基本礼仪：赛前握手、赛后致谢' },
            { dim: 'rule', text: '违例与犯规的定义（走步、两次运球、打手等）' },
            { dim: 'rule', text: '常见裁判手势识别' },
          ],
          L4: [
            { dim: 'basic', text: '篮球运动文化与赛事常识' },
            { dim: 'basic', text: '战术原理：空间、时间与人数优势' },
            { dim: 'technique', text: '运球转身：前后转身与背后运球' },
            { dim: 'technique', text: '击地传球' },
            { dim: 'technique', text: '行进间低手投篮（三步上篮）' },
            { dim: 'technique', text: '交叉步持球突破' },
            { dim: 'technique', text: '抢篮板：卡位、预判与起跳' },
            { dim: 'tactic', text: '短传快攻' },
            { dim: 'tactic', text: '运球掩护' },
            { dim: 'tactic', text: '突分配合' },
            { dim: 'tactic', text: '策应配合' },
            { dim: 'tactic', text: '区域联防' },
            { dim: 'fitness', text: '轻负荷力量练习（自重与轻器械）' },
            { dim: 'fitness', text: '组合跑：速度与灵敏的组合练习' },
            { dim: 'fitness', text: '滑步接力' },
            { dim: 'match', text: '全场 5v5 比赛' },
            { dim: 'match', text: '比赛中的战术配合执行与临场调整' },
            { dim: 'rule', text: `${T}3 秒、8 秒、24 秒等完整规则与违例判罚（属初中阶段统筹）` },
            { dim: 'rule', text: `${T}担任裁判与记录台工作（属初中阶段，须按中学课时统筹）` },
          ],
        },
      },
      {
        id: 'football',
        label: '足球',
        topics: {
          L1: [
            '熟悉球性游戏：脚内侧拨球、拉球、夹球跳',
            '足球情境下的跑动与躲闪游戏',
            '脚内侧轻推球前进与停住球的带球小游戏',
            `${T}足球游戏化比赛（小场地、无守门员形式）`,
          ],
          L2: [
            { dim: 'technique', text: '脚内侧传球' },
            { dim: 'technique', text: '接球：地滚球停球' },
            { dim: 'technique', text: '运球：脚内侧与脚背外侧直线运球' },
            { dim: 'technique', text: '脚内侧射门' },
            { dim: 'tactic', text: '二到三人传接球配合' },
            { dim: 'fitness', text: '翻滚与自我保护' },
            { dim: 'fitness', text: '起动跑：听信号快速起动' },
            { dim: 'match', text: '小场地比赛（3v3 / 4v4，简化规则）' },
            { dim: 'rule', text: '比赛时间与换人规则' },
          ],
          L3: [
            { dim: 'technique', text: '行进间传接球' },
            { dim: 'technique', text: '射门技术组合：运球—射门、接球—射门' },
            { dim: 'technique', text: '防守技术：正面防守与抢截球' },
            { dim: 'tactic', text: '二三人局部配合' },
            { dim: 'tactic', text: '运球过人：假动作与变向过人' },
            { dim: 'fitness', text: '结合球的体能练习：运球跑、变速跑' },
            { dim: 'match', text: '小场地比赛：5v5 / 7v7' },
            { dim: 'rule', text: `${T}越位规则（属正式竞赛规则，小学阶段多为简化介绍，须按本校教材核对）` },
          ],
          L4: [
            { dim: 'technique', text: '长传球' },
            { dim: 'technique', text: '接空中球：胸部、大腿与脚部停球' },
            { dim: 'technique', text: '正面防守与侧面防守技术' },
            { dim: 'tactic', text: '二三人攻防配合' },
            { dim: 'tactic', text: '定位球战术：角球、任意球' },
            { dim: 'fitness', text: '结合信号的专项体能：听哨声变速跑、变向跑' },
            { dim: 'match', text: `${T}11 人制比赛（属初中阶段统筹，小学多为 5v5 / 7v7）` },
            { dim: 'rule', text: `${T}裁判跑位与手势（属初中阶段，须按中学课时统筹）` },
          ],
        },
      },
      {
        id: 'volleyball',
        label: '排球',
        topics: {
          L1: [
            '气球 / 软排托球、抛接游戏（感受球的飞行轨迹）',
            '移动接球游戏：低重心移动与准备姿势',
            '向上托球与连续托球计数的软排击球游戏',
            `${T}软式排球活动组合（视本校器材条件开设）`,
          ],
          L2: [
            { dim: 'technique', text: '准备姿势与移动步法（并步、交叉步）' },
            { dim: 'technique', text: '垫球：自垫、对垫启蒙' },
            { dim: 'technique', text: '传球：正面双手传球启蒙' },
            { dim: 'technique', text: '发球游戏：抛球与下手发球体验' },
            { dim: 'tactic', text: '轮转游戏：位置与轮转意识的启蒙' },
            { dim: 'fitness', text: '移动类体能：低重心移动、并步与交叉步练习' },
            { dim: 'match', text: '排球游戏节：垫球、发球、接力等组合游戏' },
          ],
          L3: [
            { dim: 'technique', text: '正面双手垫球' },
            { dim: 'technique', text: '正面双手传球' },
            { dim: 'technique', text: '侧面下手发球' },
            { dim: 'technique', text: '正面下手发球' },
            { dim: 'technique', text: '原地扣球（低网、软排）' },
            { dim: 'tactic', text: '6 人站位与轮转' },
            { dim: 'tactic', text: '垫、传、发的个人战术运用' },
            { dim: 'match', text: '低网 3v3 / 6v6 比赛' },
          ],
          L4: [
            { dim: 'technique', text: '体侧垫球' },
            { dim: 'technique', text: '背垫' },
            { dim: 'technique', text: '背传' },
            { dim: 'technique', text: '顺网传球' },
            { dim: 'technique', text: '正面上手发球' },
            { dim: 'technique', text: '正面扣球' },
            { dim: 'technique', text: '单人拦网' },
            { dim: 'tactic', text: '位置分工' },
            { dim: 'tactic', text: '接发球阵形' },
            { dim: 'tactic', text: '中一二进攻' },
            { dim: 'tactic', text: '防守战术' },
            { dim: 'match', text: `${T}中高网 4v4 / 6v6 比赛（属初中阶段，须按场地与器材条件开设）` },
          ],
        },
      },
      {
        id: 'tableTennis',
        label: '乒乓球',
        topics: {
          L1: [
            '球拍与球熟悉游戏：托球走、颠球比多',
            '手眼协调类抛接游戏',
            '台面滚球与击球入区游戏',
            `${T}乒乓球启蒙（台面练习，视本校器材条件开设）`,
          ],
          L2: [
            { dim: 'basic', text: '握拍方法与球拍、球的认知' },
            { dim: 'technique', text: '基本站位与准备姿势' },
            { dim: 'technique', text: '平击发球' },
            { dim: 'technique', text: '推挡（直拍）/ 拨球（横拍）' },
            { dim: 'technique', text: '正手攻球' },
            { dim: 'technique', text: '左推右攻' },
            { dim: 'fitness', text: '移动换球类体能练习（左右移动取球）' },
            { dim: 'match', text: '颠球比赛与平击球比赛' },
          ],
          L3: [
            { dim: 'technique', text: '正手攻球与反手攻球' },
            { dim: 'technique', text: '急长发球' },
            { dim: 'technique', text: '防守：推挡与搓球启蒙' },
            { dim: 'tactic', text: '左推右攻战术' },
            { dim: 'tactic', text: '发上旋球抢攻' },
            { dim: 'fitness', text: '移动摸台角的灵敏与移动练习' },
            { dim: 'match', text: '7 分制 / 11 分制单打比赛' },
          ],
          L4: [
            { dim: 'technique', text: '拉下旋球' },
            { dim: 'technique', text: '正手转与不转发球' },
            { dim: 'tactic', text: '推挡侧身攻' },
            { dim: 'tactic', text: '连续进攻战术' },
            { dim: 'tactic', text: '双打战术' },
            { dim: 'fitness', text: '多球练习与多点攻的专项体能' },
            { dim: 'match', text: '分类战术比赛（按战术主题分组比赛）' },
            { dim: 'rule', text: `${T}裁判手势与比赛编排（属初中阶段统筹）` },
          ],
        },
      },
      {
        id: 'badminton',
        label: '羽毛球',
        topics: {
          L1: [
            '球感游戏：托飘球、击打悬挂球、抛接降落球',
            '空间定向游戏：判断来球落点与移动接球',
            '挥拍击打悬挂球与托球比稳',
            `${T}羽毛球启蒙（视本校器材与场地条件开设）`,
          ],
          L2: [
            { dim: 'technique', text: '正手握拍与反手握拍' },
            { dim: 'technique', text: '正手发高远球' },
            { dim: 'technique', text: '挑球' },
            { dim: 'technique', text: '放网' },
            { dim: 'technique', text: '击高远球' },
            { dim: 'technique', text: '杀球启蒙' },
            { dim: 'tactic', text: '单打基本站位' },
            { dim: 'fitness', text: '基本步法：垫步、并步、跨步与前后场移动' },
            { dim: 'match', text: '颠球比赛与掷远、掷准比赛' },
          ],
          L3: [
            { dim: 'technique', text: '正手网前球' },
            { dim: 'technique', text: '正手吊球' },
            { dim: 'technique', text: '后场击球组合' },
            { dim: 'technique', text: '杀上网' },
            { dim: 'tactic', text: '重复放网' },
            { dim: 'tactic', text: '下压上网' },
            { dim: 'tactic', text: '双打站位' },
            { dim: 'fitness', text: '4 角移动步法练习' },
            { dim: 'match', text: '双打挑战赛' },
          ],
          L4: [
            { dim: 'technique', text: '反手发网前球' },
            { dim: 'technique', text: '挡球' },
            { dim: 'technique', text: '扑球' },
            { dim: 'technique', text: '中场两侧击球' },
            { dim: 'technique', text: '全场步法' },
            { dim: 'tactic', text: '四方球战术' },
            { dim: 'tactic', text: '拉吊突击' },
            { dim: 'tactic', text: '双打攻防战术' },
            { dim: 'fitness', text: '多球练习与连续杀球的专项体能' },
            { dim: 'match', text: `${T}21 分制正式比赛（属初中阶段统筹）` },
            { dim: 'rule', text: `${T}裁判规则与手势（属初中阶段统筹）` },
          ],
        },
      },
    ],
  },

  {
    id: 'athletics',
    label: '田径类',
    note: '按「跑类 / 跳跃类 / 投掷类 / 跑跳投综合」四个子类组织，内容可量化，便于做学业质量的分水平观测；水平二至四同样按七大维度组织。',
    items: [
      {
        id: 'running',
        label: '跑类（短跑 / 中长跑 / 接力跑 / 跨栏跑 / 障碍跑）',
        topics: {
          L1: [
            '自然奔跑游戏：直线跑、曲线跑、变向跑、追逐与躲闪游戏',
            '听信号快速起动与停止（反应速度游戏）',
            '正确跑姿启蒙：摆臂自然、前脚掌着地、眼看前方',
            '持轻物的接力式游戏：抱球跑、传物接力',
          ],
          L2: [
            { dim: 'basic', text: '跑的场地与跑道认知、热身与运动安全常识' },
            { dim: 'technique', text: '站立式起跑（各就位—跑的口令与快速起动）' },
            { dim: 'technique', text: '50 米快速跑：站立式起跑—加速跑—途中跑' },
            { dim: 'technique', text: '迎面接力跑：错肩交接与接力区意识启蒙' },
            { dim: 'technique', text: '障碍跑：绕、跨、钻、跳通过 3–4 个障碍的组合跑' },
            { dim: 'match', text: '简化规则比赛：50 米跑、迎面接力、障碍跑接力' },
          ],
          L3: [
            { dim: 'basic', text: '短跑与耐久跑的锻炼价值、呼吸节奏常识（两步一呼、两步一吸）' },
            { dim: 'technique', text: '蹲踞式起跑（各就位—预备—跑）' },
            { dim: 'technique', text: '短跑：起跑—加速—途中跑的完整技术' },
            { dim: 'technique', text: '耐久跑：400–600 米匀速跑与体力分配' },
            { dim: 'technique', text: '上挑式接力跑：原地—慢跑—快速跑递进的交接棒' },
            { dim: 'match', text: '十字接力等接力比赛' },
            { dim: 'match', text: '计时跑与达标测试' },
            { dim: 'fitness', text: '计时跑体能：定时跑、重复跑与间歇跑' },
          ],
          L4: [
            { dim: 'basic', text: '短跑、接力跑与耐久跑的技术原理与安全常识（步频步长、体力分配、运动后恢复）' },
            { dim: 'technique', text: '蹲踞式起跑与起跑后的加速跑' },
            { dim: 'technique', text: '途中跑：摆臂、后蹬与放松跑' },
            { dim: 'technique', text: '终点冲刺与撞线技术' },
            { dim: 'technique', text: '下压式接力跑：交接棒手型与接力区内的配合' },
            { dim: 'technique', text: `${T}跨栏跑：起跨腿与摆动腿的过栏技术（正式跨栏跑属初中阶段，小学多用小栏架、软式栏架替代）` },
            { dim: 'technique', text: `${T}800 米 / 1000 米耐久跑（属初中阶段统筹，小学以 400–600 米与定时跑为主）` },
            { dim: 'match', text: '跨栏跑游戏与比赛（小栏架、软式栏架）' },
            { dim: 'fitness', text: '定向越野体能：校园定向的持续跑与变速跑' },
          ],
        },
      },
      {
        id: 'jumping',
        label: '跳跃类（立定跳远 / 急行跳远·蹲踞式 / 跨越式跳高）',
        topics: {
          L1: [
            '单双脚跳跃游戏：跳过小河、跳格子、连续跳过软障碍',
            '落地缓冲启蒙：屈膝缓冲、双臂配合、稳稳站住',
            '纵跳与向上摆臂游戏（摸高、跳起拍响）',
          ],
          L2: [
            { dim: 'basic', text: '跳跃的场地器材认知与落地区安全（沙坑、落垫、起跳区）' },
            { dim: 'technique', text: '立定跳远：预摆—蹬地—腾起—落地缓冲' },
            { dim: 'technique', text: '模仿跳跃游戏（模仿动物跳、双脚连续跳）' },
            { dim: 'technique', text: '跳格子游戏（单双脚跳、方向与距离控制）' },
          ],
          L3: [
            { dim: 'basic', text: '跳跃的助跑、踏跳与落地的安全常识' },
            { dim: 'technique', text: '急行跳远：助跑与踏跳（单脚起跳、双脚落地）' },
            { dim: 'technique', text: '跨越式跳高：助跑与起跳（起跳腿与摆动腿的配合）' },
            { dim: 'technique', text: '跳上跳下台阶：连续跳过与落地缓冲' },
          ],
          L4: [
            { dim: 'basic', text: '跳远与跳高的技术原理、丈量方法与成绩记录' },
            { dim: 'technique', text: '蹲踞式跳远完整技术：助跑—踏跳—腾空步—落地' },
            { dim: 'technique', text: '跨越式跳高完整技术：助跑—起跳—过杆—落垫' },
            { dim: 'technique', text: `${T}背越式跳高或挺身式跳远的尝试（属初中阶段，须按器材与安全条件开设）` },
          ],
        },
      },
      {
        id: 'throwing',
        label: '投掷类（投掷垒球 / 沙包 / 双手前掷实心球 / 侧向推实心球）',
        topics: {
          L1: [
            '抛接与掷准游戏：向目标投掷沙包、软球、纸球',
            '挥臂甩腕的全身用力游戏（甩纸炮、掷远比远）',
            '投掷中的方向感与距离感启蒙',
          ],
          L2: [
            { dim: 'basic', text: '投掷练习的分区安全与统一取器械规则' },
            { dim: 'technique', text: '抛接轻物：沙包、软球、纸球的抛接与掷准' },
            { dim: 'technique', text: '掷远游戏：挥臂甩腕的全身用力' },
            { dim: 'technique', text: '原地投掷沙包 / 垒球（背后过肩挥臂）' },
            { dim: 'technique', text: '双手前掷实心球：蹬地—送髋—挥臂—拨指' },
          ],
          L3: [
            { dim: 'basic', text: '投掷的用力顺序与安全间距常识' },
            { dim: 'technique', text: '上步投掷垒球 / 沙包（交叉步与蹬地转体的衔接）' },
            { dim: 'technique', text: '双手前掷实心球的完整技术（满弓与最后用力）' },
            { dim: 'technique', text: `${T}侧向推实心球（多为初中教材内容，小学阶段以投掷沙包 / 垒球与双手前掷实心球为主，须按本校教材与器材核对）` },
          ],
          L4: [
            { dim: 'basic', text: '投掷项目的技术原理与安全规定（出手角度、出手速度、分区管理）' },
            { dim: 'technique', text: `${T}侧向滑步推实心球（或推铅球，属初中阶段内容，须按安全规定与器材条件开设）` },
            { dim: 'technique', text: '正面双手头上掷实心球（双手头上前掷的完整技术）' },
            { dim: 'technique', text: '多种姿势投掷：原地、上步、侧向与双手头上的对比练习' },
          ],
        },
      },
      {
        id: 'combined',
        label: '跑跳投综合（跑＋跳 / 跑＋投 / 综合积分赛 / 全能挑战）',
        topics: {
          L1: [
            '跑跳组合游戏：跑过障碍—跳过小河—再跑回的情境活动',
            '跑投组合游戏：跑至投掷线后向目标投掷沙包',
            '小组接力式综合游戏：跑、跳、投各设一站轮换',
          ],
          L2: [
            { dim: 'basic', text: '综合活动的安全分区与轮换规则' },
            { dim: 'technique', text: '跑＋跳组合游戏（跑过障碍—跳过小河—再跑回）' },
            { dim: 'technique', text: '跑＋投组合（跑至投掷线后投掷沙包）' },
            { dim: 'match', text: '简化田径积分赛：跑、跳、投各设一站的班级积分赛' },
          ],
          L3: [
            { dim: 'basic', text: '综合比赛的规则制定与公平竞赛常识' },
            { dim: 'match', text: '跑跳投综合积分赛：三项成绩换算积分的班级联赛' },
            { dim: 'match', text: '小组全能挑战：分组完成跑、跳、投三项' },
          ],
          L4: [
            { dim: 'basic', text: `${T}个人 / 小组全能比赛的成绩换算方法（课标未给出换算表，属校本设计，请按本校实际核对）` },
            { dim: 'match', text: '个人 / 小组全能比赛' },
            { dim: 'match', text: '田径专项体能组合赛：速度、力量、灵敏的组合循环赛' },
          ],
        },
      },
    ],
  },

  {
    id: 'gymnastics',
    label: '体操类',
    note: '技巧、支撑跳跃、单杠、双杠与艺术体操，强调身体姿态、控制力与自我保护；水平二至四同样按七大维度组织（体操无战术，该维度留空）。',
    items: [
      {
        id: 'skills',
        label: '技巧（垫上运动）',
        topics: {
          L1: [
            '垫上滚动游戏：团身滚动、直体滚动',
            '身体平衡游戏：燕式平衡、单脚支撑比稳',
            '模仿动作：动物爬行与造型',
            '垫上安全规则：按顺序上垫、不推挤',
          ],
          L2: [
            { dim: 'basic', text: '垫上运动的术语与安全常识（按顺序上垫、不推挤、不戴硬物）' },
            { dim: 'basic', text: '技巧动作的锻炼价值与自我保护常识' },
            { dim: 'technique', text: '前滚翻（蹲撑开始：低头含胸、团身滚动）' },
            { dim: 'technique', text: '后滚翻（团身紧、推手及时）' },
            { dim: 'technique', text: '仰卧推起成桥（推起—挺髋—回落）' },
            { dim: 'technique', text: '跪跳起（摆臂—提腰—收腿成蹲撑）' },
            { dim: 'technique', text: '挺身跳（摆臂—展体—落地缓冲）' },
            { dim: 'technique', text: '简单组合：滚翻 + 平衡 + 挺身跳的小组合' },
            { dim: 'technique', text: '同伴保护与帮助的站位（前滚翻托背提臀、后滚翻托腰背）' },
            { dim: 'fitness', text: '仰卧起坐' },
            { dim: 'fitness', text: '平板支撑' },
          ],
          L3: [
            { dim: 'basic', text: '技巧动作的术语、动作规格与完成质量的观察点' },
            { dim: 'technique', text: '侧手翻（摆腿—依次撑地—并腿落地，含靠墙分解与保护下完成）' },
            { dim: 'technique', text: '燕式平衡（单腿站立、后举腿与身体成反弓）' },
            { dim: 'technique', text: '肩肘倒立（屈体—伸髋—夹肘支撑）' },
            { dim: 'technique', text: '组合动作：侧手翻—燕式平衡—肩肘倒立的串联' },
            { dim: 'technique', text: '保护与帮助的站位与手法（侧手翻扶腰、肩肘倒立扶腿）' },
            { dim: 'fitness', text: '横叉 / 纵叉的柔韧性练习' },
            { dim: 'match', text: '小组技巧组合的展示与互评' },
          ],
          L4: [
            { dim: 'basic', text: '技巧成套动作的编排常识（动作顺序、节奏与空间运用）' },
            { dim: 'technique', text: '头手倒立（三角支撑、重心控制与落下保护）' },
            { dim: 'technique', text: '多个组合动作的串联（滚翻 + 倒立 + 平衡 + 跳）' },
            { dim: 'technique', text: '结合音乐创编技巧组合动作' },
            { dim: 'technique', text: '保护与帮助与自我保护（含落下时的团身缓冲）' },
            { dim: 'fitness', text: '俯卧撑' },
            { dim: 'match', text: '小组创编动作的展示与互评' },
          ],
        },
      },
      {
        id: 'vault',
        label: '支撑跳跃（山羊 / 跳箱 / 横箱）',
        topics: {
          L1: [
            '跳上跳下游戏：跳上软垫台阶—双脚落地缓冲',
            '双手支撑的"小木马"游戏（同伴扶持下的支撑体验）',
            `${T}山羊 / 跳箱高度的初步体验（视器材条件开设）`,
          ],
          L2: [
            { dim: 'basic', text: '山羊 / 跳箱的结构认知、高度调节与安全检查' },
            { dim: 'technique', text: '助跑—踏跳—双手撑—落地缓冲的完整节奏（分腿腾越启蒙）' },
            { dim: 'technique', text: '跳上成蹲撑—向前跳下（山羊 / 跳箱）' },
            { dim: 'technique', text: '助跑与踏跳点的标记练习' },
            { dim: 'technique', text: '保护与帮助的站位（侧前方扶上臂）' },
          ],
          L3: [
            { dim: 'basic', text: '山羊分腿腾越的动作环节与术语：助跑、踏跳、支撑、腾空、落地' },
            { dim: 'technique', text: '山羊分腿腾越完整动作：助跑—踏跳—支撑—腾空—落地缓冲' },
            { dim: 'technique', text: '助跑与踏跳：单起双落、踏跳点准确' },
            { dim: 'technique', text: '支撑推手与分腿腾越（顶肩推手、分腿直膝）' },
            { dim: 'technique', text: '落地稳定与自我保护（屈膝缓冲、站稳后再离开）' },
            { dim: 'technique', text: '保护与帮助：站在器械侧前方扶上臂的方法' },
            { dim: 'fitness', text: '俯撑爬行' },
          ],
          L4: [
            { dim: 'basic', text: '横箱分腿腾越的动作标准解析与评价要点（含分层完成标准）' },
            { dim: 'technique', text: '横箱分腿腾越完整技术' },
            { dim: 'technique', text: '助跑速度、踏跳与推手时机的配合' },
            { dim: 'technique', text: '组合动作创编（支撑跳跃 + 垫上动作的衔接）' },
            { dim: 'technique', text: '保护与帮助的站位与自我保护' },
            { dim: 'fitness', text: '推小车' },
            { dim: 'match', text: '分组创编动作的展示与互评' },
          ],
        },
      },
      {
        id: 'horizontalBar',
        label: '单杠',
        topics: {
          L1: [
            '低单杠悬垂游戏：悬垂摆动、悬垂静止计时',
            '安全的上下器械方法与握杠方法（正握）',
            `${T}低单杠的支撑与悬垂体验（视器材条件开设）`,
          ],
          L2: [
            { dim: 'basic', text: '低单杠的高度、握杠方法与安全检查常识' },
            { dim: 'technique', text: '跳上成支撑' },
            { dim: 'technique', text: '前翻下' },
            { dim: 'technique', text: '单个动作与组合动作的串联' },
            { dim: 'technique', text: '保护与帮助的站位与方法' },
            { dim: 'fitness', text: '悬垂举腿' },
          ],
          L3: [
            { dim: 'technique', text: '支撑后摆下' },
            { dim: 'technique', text: '单腿摆越成骑撑' },
            { dim: 'technique', text: '单腿向后摆越成支撑' },
            { dim: 'technique', text: '组合动作与保护帮助' },
            { dim: 'fitness', text: '推小车接力赛' },
          ],
          L4: [
            { dim: 'technique', text: '单腿摆越成骑撑—单腿向后摆越成支撑（联合动作）' },
            { dim: 'technique', text: '成套动作创编' },
            { dim: 'technique', text: '保护与帮助与自我保护（脱手时的团身落地）' },
            { dim: 'fitness', text: '引体向上' },
            { dim: 'match', text: '小组成套动作的展示与互评' },
          ],
        },
      },
      {
        id: 'parallelBars',
        label: '双杠',
        topics: {
          // 双杠按本校教材只在水平四开设，水平一至三给的是衔接准备内容（已标 [待确认]，请按本校实际取舍）
          L1: [
            `${T}以垫上与低单杠的支撑、悬垂练习做衔接准备（双杠内容按本校教材在水平四开设，须按实际核对）`,
          ],
          L2: [
            `${T}支撑摆动与支撑移动的准备性练习（双杠内容按本校教材在水平四开设，须按实际核对）`,
          ],
          L3: [
            `${T}杠上支撑与跳下的准备性练习（双杠内容按本校教材在水平四开设，须按实际核对）`,
          ],
          L4: [
            { dim: 'basic', text: '双杠的结构认知、高度调节与安全检查' },
            { dim: 'basic', text: '保护与帮助的站位与手法（杠侧保护、托腰扶腿）' },
            { dim: 'technique', text: '支撑摆动' },
            { dim: 'technique', text: '支撑后摆下' },
            { dim: 'technique', text: '外侧坐越两杠挺身下' },
            { dim: 'technique', text: '组合动作：支撑摆动 + 后摆下 + 外侧坐越两杠挺身下的串联' },
            { dim: 'fitness', text: '双杠臂屈伸' },
            { dim: 'fitness', text: '推小车' },
            { dim: 'fitness', text: '悬垂举腿' },
            { dim: 'match', text: '小组组合动作的展示与互评' },
          ],
        },
      },
      {
        id: 'rhythmic',
        label: '艺术体操（韵律操 / 啦啦操 / 健美操）',
        topics: {
          L1: [
            '节奏与模仿操：跟着音乐做头手的基本动作',
            '队列中的位置感与集体造型游戏',
            '简单的韵律操组合（4×8 拍）',
            '听节拍做动作的节奏反应游戏',
          ],
          L2: [
            { dim: 'basic', text: '艺术体操的术语与音乐节拍常识（4×8 拍的起止与口令）' },
            { dim: 'technique', text: '基本手位' },
            { dim: 'technique', text: '基本脚位' },
            { dim: 'technique', text: '基本步伐（柔软步、足尖步、跑跳步）' },
            { dim: 'technique', text: '跳步（并步跳、开合跳）' },
            { dim: 'technique', text: '波浪（手臂波浪、身体波浪）' },
            { dim: 'technique', text: '韵律操组合（4×8 拍）' },
            { dim: 'fitness', text: '基础体能：柔韧、协调与节奏感练习' },
          ],
          L3: [
            { dim: 'technique', text: `${T}六种基本手型（并掌、开掌、拳、立掌、屈指、芭蕾手 —— 六种的具体名称请按本校教材核对）` },
            { dim: 'technique', text: '常用手位' },
            { dim: 'technique', text: '下肢动作（踏步、点地、吸腿、踢腿）' },
            { dim: 'technique', text: '啦啦操组合（32 拍）' },
            { dim: 'technique', text: '创编动作（小组自编 4×8 拍）' },
            { dim: 'fitness', text: '俯撑钻爬' },
            { dim: 'match', text: '小组创编动作的展示与互评' },
          ],
          L4: [
            { dim: 'technique', text: '常用手型与步法' },
            { dim: 'technique', text: '健美操动作组合' },
            { dim: 'technique', text: '结合音乐的小组创编' },
            { dim: 'fitness', text: '靠墙静蹲' },
            { dim: 'match', text: '小组创编动作的展示与互评' },
          ],
        },
      },
    ],
  },

  {
    id: 'traditional',
    label: '中华传统体育类',
    note: '承载文化传承，强调礼仪、精气神与传统体育的道德规范。',
    items: [
      {
        id: 'wushu',
        label: '武术',
        topics: {
          L1: [
            '武术礼仪：抱拳礼与上下课礼节',
            '模仿操：弓步、马步等基本步型的游戏化练习',
            '手型（拳、掌、勾）与冲拳、推掌启蒙',
          ],
          L2: [
            '基本功：正踢腿、侧踢腿、弹踢',
            '基本手型手法与步型步法组合',
            '五步拳（简化）前两段',
            '武术中的精气神与发声练习',
          ],
          L3: [
            '少年拳（第一套）或校本简化套路',
            '手眼身法步的配合',
            '双人攻防练习启蒙（安全条件下的假设性对练）',
            '武德教育：尊师重道、以礼始以礼终',
          ],
          L4: [
            '少年拳全套定型与套路演练评分要点',
            `${T}器械（如短棍）与散打基础（属初中阶段，须按安全规范开设）`,
          ],
        },
      },
      {
        id: 'changquan',
        label: '长拳',
        topics: {
          L1: [
            '武术礼仪游戏：抱拳礼与"以礼始、以礼终"的课堂常规',
            '手型与步型的模仿操：拳、掌、勾与弓步、马步的游戏化练习',
            `${T}长拳套路启蒙（水平一以基本功游戏为主，视本校开设情况）`,
          ],
          L2: [
            { dim: 'basic', text: '基本礼仪：抱拳礼与上下课礼节' },
            { dim: 'technique', text: '基本手型：拳、掌、勾' },
            { dim: 'technique', text: '基本步型：弓步、马步、仆步' },
            { dim: 'technique', text: '基本手法：冲拳、劈掌' },
            { dim: 'technique', text: '基本腿法：弹踢' },
            { dim: 'technique', text: '五步拳' },
          ],
          L3: [
            { dim: 'technique', text: '基本腿法：正踢、拍脚' },
            { dim: 'technique', text: `${T}少年拳第一套（套路的具体动作顺序以本校教材为准，须核对）` },
            { dim: 'technique', text: '武术健身操' },
            { dim: 'technique', text: '组合技术运用：手眼身法步的配合' },
          ],
          L4: [
            { dim: 'technique', text: '基本腿法：侧踹' },
            { dim: 'technique', text: '平衡：望月平衡' },
            { dim: 'technique', text: `${T}少年拳第二套（套路的具体动作顺序以本校教材为准，须核对）` },
            { dim: 'technique', text: '健身长拳' },
            { dim: 'technique', text: '攻防演练：假设性对练中的攻防含义与距离控制' },
          ],
        },
      },
      {
        id: 'jianzi',
        label: '毽球',
        topics: {
          L1: [
            '踢毽游戏：吊毽练习、单脚连续踢',
            '身体协调类游戏：跳跃 + 踢准',
            '计数挑战赛（累计次数）',
          ],
          L2: [
            '盘踢（脚内侧）与拐踢（外侧）',
            '磕踢、绷踢启蒙',
            '连续踢毽计数与小组接力',
          ],
          L3: [
            '盘踢、拐踢、磕踢、绷踢组合',
            '两人传踢与花毽花样启蒙',
            '毽球场地职责与简化比赛规则',
          ],
          L4: [
            '毽球发球、接发球与进攻腿法',
            `${T}正式毽球比赛规则（属初中阶段统筹）`,
          ],
        },
      },
      {
        id: 'tradRope',
        label: '跳绳（民间传统跳法）',
        topics: {
          L1: [
            '并脚跳绳启蒙：徒手摇绳—跳过绳子',
            '短绳与地面障碍结合的跳准游戏',
            '一分钟连续跳的坚持与计数挑战',
          ],
          L2: [
            '并脚连续跳绳（正反摇绳）与节奏控制',
            '双脚交替跳（单摇换脚跳）',
            '双人同跳与一带一跳的协作练习',
            '速度跳绳：30 秒计数与自测记录',
          ],
          L3: [
            '单摇跳的定型与 1 分钟达标练习',
            '长绳：八字跑入跳与多人同步跳',
            '跳绳的民间传统玩法（编花、带人、跳绳歌谣）',
            '班级跳绳联赛与记录墙',
          ],
          L4: [
            '双摇与编花跳的技术提高',
            '长绳团体配合的进出时机与节奏统一',
            `${T}跳绳竞速与团体花样的正式比赛规则（属初中阶段统筹）`,
          ],
        },
      },
      {
        id: 'taiji',
        label: '太极拳（简化）',
        topics: {
          L1: [
            '静态平衡与慢动作模仿游戏',
            `${T}简化太极启蒙（低年级以游戏化模仿为主，需教研组长确认是否开课）`,
          ],
          L2: [
            '太极的基本手型与步型（云手、野马分鬣启蒙）',
            '呼吸与动作配合的慢练节奏',
            '简短的太极操练习',
          ],
          L3: [
            '简化太极拳前 8 式',
            '动作的连贯与中国传统文化释义',
            '小组展示与自评互评',
          ],
          L4: [
            '简化太极拳完整套路（24 式）',
            `${T}太极推手（须有专业指导与保护）`,
          ],
        },
      },
      {
        id: 'wrestling',
        label: '中国式摔跤',
        topics: {
          L1: [
            '垫上滚翻与爬行游戏：团身滚动、直体滚动',
            '双人推手与躲闪的角力游戏（低重心对抗，不涉及摔法）',
            `${T}中国式摔跤的礼仪与基本对抗体验（水平一以游戏化启蒙为主，须按本校实际开设）`,
          ],
          L2: [
            { dim: 'basic', text: '中国式摔跤的礼仪与行为规范（抱拳礼、上下场礼节）' },
            { dim: 'basic', text: '摔跤练习的安全常规：垫子检查、体重相近配对、禁动作清单' },
            { dim: 'technique', text: '自我保护：卷体、前倒（受身动作）' },
            { dim: 'technique', text: '基本手法：拉、撒、插、闪' },
            { dim: 'technique', text: '基本步法：进步、撤步、滑步与绕步' },
          ],
          L3: [
            { dim: 'basic', text: '摔跤的锻炼价值与安全配对常识（体重相近、禁动作清单）' },
            { dim: 'technique', text: '侧滚翻（受身与自我保护）' },
            { dim: 'technique', text: '基本手法与步法的组合运用' },
            { dim: 'technique', text: '基本摔法：抱腿' },
            { dim: 'technique', text: '基本摔法：手别' },
            { dim: 'match', text: '推手对抗赛（限定动作、限定力度）' },
          ],
          L4: [
            { dim: 'technique', text: '后倒展腹（受身）' },
            { dim: 'technique', text: '抢背' },
            { dim: 'technique', text: '基本摔法：抱腿' },
            { dim: 'technique', text: '基本摔法：挑腿' },
            { dim: 'match', text: `${T}实战对抗赛（属初中阶段统筹，须按安全规定与保护装备开设）` },
            { dim: 'rule', text: `${T}裁判规则与判分方法（属初中阶段，须按本校教材核对）` },
          ],
        },
      },
      {
        id: 'dragon',
        label: '舞龙',
        topics: {
          L1: [
            '持轻物（丝带、彩绳）的挥摆与跑动游戏',
            '跟随音乐做队形跑动与造型游戏',
            `${T}小龙具（纸龙、布龙）的持握与游走体验（视器材条件开设）`,
          ],
          L2: [
            { dim: 'basic', text: '舞龙的礼仪与文化常识（龙的寓意、开场与收场礼节）' },
            { dim: 'technique', text: '基本持龙方法：高举、平端' },
            { dim: 'technique', text: '基本步法：圆场步、矮步' },
            { dim: 'technique', text: '游龙类动作：直线行进、曲线游走' },
          ],
          L3: [
            { dim: 'technique', text: '8 字舞龙类动作' },
            { dim: 'technique', text: '组团造型类动作（龙塔、龙舟等造型）' },
            { dim: 'technique', text: '舞龙组合串联：动作之间的衔接与队形变化' },
          ],
          L4: [
            { dim: 'technique', text: '穿腾类动作：穿越、腾越' },
            { dim: 'technique', text: '舞龙套路' },
            { dim: 'technique', text: '舞龙套路创编（音乐、队形与动作的组合）' },
            { dim: 'match', text: `${T}参与校内外舞龙比赛（属校本与赛事安排，须按本校实际核对）` },
          ],
        },
      },
    ],
  },

  {
    id: 'emerging',
    label: '新兴体育类',
    note: '贴近学生兴趣，器材门槛低，便于开展班级联赛与课外延伸。',
    items: [
      {
        id: 'ropeSkipping',
        label: '花样跳绳',
        topics: {
          L1: [
            '并脚跳绳启蒙（徒手摇绳—跳过绳子）',
            '节奏基础上的连续跳',
            '跳绳游戏中的计数与坚持',
            '短绳游戏：摇绳比稳、跳准过关',
          ],
          L2: [
            { dim: 'basic', text: '花样跳绳的起源与发展' },
            { dim: 'basic', text: '基本方法：绳长选择、摇绳与起跳时机' },
            { dim: 'technique', text: '并脚跳' },
            { dim: 'technique', text: '双脚交换跳' },
            { dim: 'technique', text: '开合跳' },
            { dim: 'technique', text: '正摇编花' },
            { dim: 'match', text: '1 分钟双脚交换跳（计数赛）' },
          ],
          L3: [
            { dim: 'basic', text: '花样跳绳的内容分类（个人绳、双人车轮跳、交互绳等）' },
            { dim: 'technique', text: '并脚左右跳' },
            { dim: 'technique', text: '后摇跳' },
            { dim: 'technique', text: '双摇跳' },
            { dim: 'technique', text: '车轮跳（双人）' },
            { dim: 'technique', text: '交互绳' },
            { dim: 'match', text: '30 秒双摇跳（计数赛）' },
          ],
          L4: [
            { dim: 'basic', text: '花样跳绳的创编要素（节奏、方向、队形与音乐）' },
            { dim: 'technique', text: '弹踢腿跳' },
            { dim: 'technique', text: '钟摆跳' },
            { dim: 'technique', text: '双摇编花' },
            { dim: 'technique', text: '长短绳组合' },
            { dim: 'technique', text: `${T}网绳（多人网绳，须按场地与安全条件开设）` },
            { dim: 'match', text: '30 秒双摇计时赛' },
            { dim: 'match', text: '挑战接龙（连续接力挑战）' },
          ],
        },
      },
      {
        id: 'frisbee',
        label: '飞盘',
        topics: {
          L1: [
            '软盘（布质）抛接与远距离放置类',
            '投掷方向感游戏',
            `${T}团队飞盘启蒙（视器材条件开设）`,
          ],
          L2: [
            '正手（侧手）投掷与反手投掷基础',
            '正反手的接盘手法（双手夹接）',
            '飞盘掷准与投远的练习形式（掷准架、标靶）',
            '掷准比赛（投远、投准）',
          ],
          L3: [
            '团队飞盘：传接推进与得分区规则',
            '无裁判自我申诉机制（Spirit of the Game）',
            '小型班级飞盘赛（3v3 / 4v4）',
          ],
          L4: [
            '团队飞盘的进攻、防守站位与轮转',
            `${T}正式团队飞盘赛规则与场地规格（属初中阶段统筹）`,
          ],
        },
      },
      {
        id: 'orienteering',
        label: '定向运动（百米定向 / 校园定向 / 积分赛）',
        topics: {
          L1: [
            '校园定向：识别标志性建筑与方向游戏',
            '简单的地图符号认知（厕所、树、旗杆）',
            '小组合作找点游戏（按图找到指定标志物，协作完成任务）',
          ],
          L2: [
            { dim: 'basic', text: '定向运动的概念与分类' },
            { dim: 'basic', text: '地图方向：磁北线与地图方向的确定' },
            { dim: 'basic', text: '百米定向的地图符号' },
            { dim: 'technique', text: '地图对北：转动地图与实际地形对照' },
            { dim: 'technique', text: '拇指辅行法' },
            { dim: 'match', text: '百米定向比赛' },
          ],
          L3: [
            { dim: 'basic', text: '地图的颜色分类与符号含义（地物、地貌）' },
            { dim: 'technique', text: '边跑边读图' },
            { dim: 'technique', text: '沿线行进：沿道路、边界等线性地物行进' },
            { dim: 'technique', text: `${T}经典团队积分赛的路线规划（属校本设计，须按场地实际核对）` },
            { dim: 'match', text: '短距离接力赛（定向接力）' },
          ],
          L4: [
            { dim: 'basic', text: '等高线与地貌判读' },
            { dim: 'technique', text: '偏向瞄准法（偏北瞄准法）' },
            { dim: 'technique', text: '指北针导航' },
            { dim: 'match', text: '积分赛' },
            { dim: 'match', text: '团队赛' },
            { dim: 'fitness', text: '心肺耐力体能：持续越野跑与变速跑' },
          ],
        },
      },
      {
        id: 'roller',
        label: '轮滑',
        topics: {
          L1: [
            `${T}轮滑启蒙须穿戴全套护具，须有保护垫场地（强烈依赖条件，须教务处在课表冗余报告）`,
          ],
          L2: [
            { dim: 'basic', text: '轮滑的起源与发展' },
            { dim: 'basic', text: '轮滑装备与术语（护具、轮鞋、制动器）' },
            { dim: 'basic', text: '安全常识与护具佩戴检查' },
            { dim: 'technique', text: '摔倒与站立（正确的摔倒姿势与起立方法）' },
            { dim: 'technique', text: '直线滑行' },
            { dim: 'technique', text: '制动器刹车' },
            { dim: 'match', text: '直线速度赛' },
          ],
          L3: [
            { dim: 'technique', text: '交叉步滑行' },
            { dim: 'technique', text: '8 字刹停' },
            { dim: 'technique', text: 'T 字刹停' },
            { dim: 'technique', text: '单腿蹬接双腿滑行（蹬地与滑行的衔接）' },
            { dim: 'match', text: '竞速赛' },
          ],
          L4: [
            { dim: 'technique', text: '正滑蛇形' },
            { dim: 'technique', text: '倒滑' },
            { dim: 'technique', text: '弯道滑行' },
            { dim: 'match', text: '个人绕圈计时赛' },
            { dim: 'fitness', text: '平衡与下肢力量练习' },
          ],
        },
      },
    ],
  },

  {
    id: 'aquatic',
    label: '水上或冰雪类',
    note: '⚠️ 高度依赖场馆、水温与救护条件，开课须经学校审批与家长知情同意。',
    items: [
      {
        id: 'swimming',
        label: '游泳',
        topics: {
          L1: [
            `${T}须游泳馆与救生员配置齐备方可开设，否则以干地教学替代`,
            '水中安全教育与自救常识（干地宣讲）',
          ],
          L2: [
            '熟悉水性：水中行走、呼吸练习、闭气浮体',
            '扶池边蹬腿漂浮与站立（须分组、配救生浮具）',
            `${T}蛙泳腿启蒙（须教练先完成水中安全教学）`,
          ],
          L3: [
            '蛙泳完整配合：腿—手—呼吸节奏',
            '仰泳腿部与漂浮练习',
            '水中自救与避险（抽筋处置、靠岸方法）',
            '游泳距离闯关：25 米达标',
          ],
          L4: [
            '自由泳 / 仰泳完整技术',
            `${T}救生与心肺复苏常识（须专业教师授课）`,
          ],
        },
      },
      {
        id: 'iceSnow',
        label: '冰雪（旱地替代）',
        topics: {
          L1: [
            `${T}冰雪运动受地域与季节限制，多数地区采用旱地替代项目`,
            '冰上/雪上的基本站立与移动（图片、视频辅助认知）',
          ],
          L2: [
            '旱地轮滑冰球启蒙（护具齐备条件下）',
            '旱地冰壶（地板冰壶）投掷与规则入门',
            '冰雪运动的安全着装与低温防护常识',
          ],
          L3: [
            '旱地冰壶团队配合与战术',
            '旱地冰球的传控配合与小组比赛',
            '北京冬奥知识与冰雪文化（跨学科主題）',
          ],
          L4: [
            `${T}真冰/真雪运动技能（须专业场地与教练，绝大多数地区改为旱地替代）`,
          ],
        },
      },
    ],
  },
];

/**
 * 旧版细项 id → 新版细项 id。
 * 田径原按「短跑/耐久跑/跳远/跳高/投掷」五个细项组织，现重构为「跑类/跳跃类/投掷类/跑跳投综合」四个子类；
 * 老师以前保存的大单元里存的是旧 id，这里做映射，保证旧数据仍能反查到内容，不会变成"找不到教学内容"。
 */
const UNIT_ITEM_ALIASES = {
  sprint: 'running',
  dash: 'running',
  distanceRun: 'running',
  middleDistance: 'running',
  relay: 'running',
  hurdle: 'running',
  longJump: 'jumping',
  highJump: 'jumping',
  jump: 'jumping',
  shot: 'throwing',
  throwingSandbag: 'throwing',
  // 体操原「器械（单杠/双杠）」拆成单杠、双杠两个细项
  apparatus: 'horizontalBar',
  horizontalbar: 'horizontalBar',
  parallelbars: 'parallelBars',
  // 韵律操与舞蹈 → 艺术体操
  dance: 'rhythmic',
};

/** 某个水平的显示名 */
function unitLevelLabel(levelId) {
  const level = UNIT_LEVELS.find(item => item.id === levelId);
  return level ? level.label : '';
}

/** 按细项 id 找条目（含所属大类）；旧 id 走 UNIT_ITEM_ALIASES 映射 */
function findUnitCatalogItem(itemId) {
  const direct = lookupUnitItem(itemId);
  if (direct) return direct;
  const aliasId = UNIT_ITEM_ALIASES[String(itemId || '')];
  return aliasId ? lookupUnitItem(aliasId) : null;
}

function lookupUnitItem(itemId) {
  for (const category of UNIT_CATALOG) {
    const item = category.items.find(entry => entry.id === itemId);
    if (item) return { category, item };
  }
  return null;
}

/** 某细项在某水平下的教学内容列表（找不到返回空数组） */
function listUnitTopics(itemId, levelId) {
  return unitTopicEntries(itemId, levelId).map(entry => entry.text);
}

/**
 * 某细项在某水平下的教学内容「带维度」的条目。
 * 条目有两种写法，混用无障碍：
 *   ① 直接写字符串（水平一的游戏化内容、田径等类目）—— dimension 记为空串
 *   ② 写 { dim, text }（球类水平二至四按七大维度组织）
 */
function unitTopicEntries(itemId, levelId) {
  const found = findUnitCatalogItem(itemId);
  const raw = found?.item.topics?.[levelId];
  if (!Array.isArray(raw)) return [];
  return raw.map(entry => (entry && typeof entry === 'object'
    ? { dimension: String(entry.dim || ''), text: String(entry.text || '') }
    : { dimension: '', text: String(entry || '') })).filter(entry => entry.text);
}

/**
 * 按七大维度分组后的教学内容（按 UNIT_DIMENSIONS 顺序，只含有内容的维度）。
 * 页面用它渲染 <optgroup>，AI prompt 用它把维度一起喂给模型。
 */
function unitTopicGroups(itemId, levelId) {
  const entries = unitTopicEntries(itemId, levelId);
  if (!entries.length) return [];
  return UNIT_DIMENSIONS
    .map(dimension => ({
      id: dimension.id,
      label: dimension.label,
      topics: entries.filter(entry => entry.dimension === dimension.id).map(entry => entry.text),
    }))
    .filter(group => group.topics.length);
}

/**
 * 带维度前缀的教学内容清单（供 AI prompt 用），形如：
 *   【基本技术】原地运球与行进间直线、曲线运球
 * 没有维度的内容只输出原文。
 */
function unitTopicListWithDimension(itemId, levelId) {
  return unitTopicEntries(itemId, levelId).map(entry => (entry.dimension
    ? `【${unitDimensionLabel(entry.dimension)}】${entry.text}`
    : entry.text));
}

/**
 * 某细项 + 某水平下的「完整教学内容清单」（给 AI prompt 用）。
 * 生成大单元时必须让 AI 围绕这些具体项目构建 18 课时，而不是泛泛地写"田径""球类"。
 */
function unitCatalogBrief(itemId, levelId) {
  const found = findUnitCatalogItem(itemId);
  if (!found) return null;
  const level = UNIT_LEVELS.find(entry => entry.id === levelId);
  return {
    categoryLabel: found.category.label,
    itemLabel: found.item.label,
    levelId: level ? level.id : '',
    levelLabel: level ? level.label : '',
    topics: found.item.topics?.[levelId] || [],
  };
}

/** 教学内容是否属于"待确认"条目 */
function isUnitTopicPending(topic) {
  return String(topic || '').startsWith('[待确认]');
}

if (typeof window !== 'undefined') {
  window.UNIT_LEVELS = UNIT_LEVELS;
  window.UNIT_CATALOG = UNIT_CATALOG;
  window.UNIT_ITEM_ALIASES = UNIT_ITEM_ALIASES;
  window.UNIT_DIMENSIONS = UNIT_DIMENSIONS;
  window.unitLevelLabel = unitLevelLabel;
  window.findUnitCatalogItem = findUnitCatalogItem;
  window.listUnitTopics = listUnitTopics;
  window.unitTopicEntries = unitTopicEntries;
  window.unitTopicGroups = unitTopicGroups;
  window.unitTopicListWithDimension = unitTopicListWithDimension;
  window.unitDimensionLabel = unitDimensionLabel;
  window.unitCatalogBrief = unitCatalogBrief;
  window.isUnitTopicPending = isUnitTopicPending;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    UNIT_LEVELS, UNIT_CATALOG, UNIT_ITEM_ALIASES, UNIT_DIMENSIONS, unitLevelLabel,
    findUnitCatalogItem, listUnitTopics, unitTopicEntries, unitTopicGroups,
    unitTopicListWithDimension, unitDimensionLabel, unitCatalogBrief, isUnitTopicPending,
  };
}
