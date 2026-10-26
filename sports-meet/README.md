# 运动会数据模型

`schema.sql` 使用 SQLite 建立运动员、比赛项目、报名、分组/轮次和成绩表。`event.is_team` 是布尔标记（前端报名记录映射为 `isTeamEvent`）。报名表通过数据库触发器限制每名运动员最多报名 2 个单项和 1 个团队项目，并校验运动员性别与项目组别一致。分组中的 `position_number` 对径赛表示道次，对田赛表示出场顺序。

## 运动会工作台

从侧栏的“赛事管理”展开菜单进入“运动会编排” (`sports-meet.html`)。页面标题可通过旁边的铅笔按钮编辑，按 Enter 或移开焦点保存，按 Esc 取消；自定义标题保存在浏览器 `localStorage` 的 `sportsMeetTitle` 键中，未设置时默认显示当前年份的秋季田径运动会工作台。主页面标签页承载报名、赛程、成绩排名与导出颁奖模块。

“大单元设计”是教学管理中的独立页面 `unit-design.html`，包含前置分析、问题链与结构图、18课次计划表、考核与反思四个子板块。数据以单一对象自动保存在浏览器 `localStorage` 的 `pe_big_unit_design_v1` 键中；问题链节点可跳转到相应课次。每个板块均可请求 AI 辅助生成草稿，Word 导出生成 `.doc` 文件，PDF 通过浏览器打印对话框另存。

AI 功能需使用 `node server.js` 启动本机服务。服务端会读取项目根目录的 `.env.local`。AI 教案生成接口统一返回 `{ success: true, content: "Markdown 教案正文" }`，前端使用 Marked 渲染并由 DOMPurify 清理 HTML；兼容从 JSON 包裹内容或旧版结构化教案中提取 Markdown。教案草稿可继续请求 AI 扩写并保存到本地教案库。大单元设计使用智谱 JSON 流式模式，输出上限为 8192 tokens，并可传输至 16 MiB；网络中断或达到上限时会尽可能恢复、显示并保存已收到的部分内容，同时提示可能截断。智谱配置示例：

```env
VITE_ZHIPUAI_API_KEY=你的智谱API_Key
VITE_ZHIPUAI_MODEL=glm-4-flash
```

请将示例 Key 替换为自己的智谱 API Key；该文件已加入 Git 忽略规则，密钥仅由本地服务端读取，不会发到浏览器。有效的智谱 Key 默认优先使用；原有 `AI_API_URL`、`AI_API_KEY`、`AI_MODEL` 配置仍可使用。如同时配置多个提供商并要指定使用 DeepSeek，可设置 `AI_PROVIDER=deepseek`。未配置有效密钥时，页面会显示服务错误。也可以继续直接访问 `registration.html`、`schedule.html` 和 `results.html` 使用独立页面。

页面使用各自的静态 HTML 路由，公共 `js/layout.js` 负责生成全局菜单、当前页面高亮和父级菜单自动展开；从侧栏点击子菜单会导航到对应 HTML 页面。兼容的旧运动会锚点 `sports-meet.html#unit-design` 会跳转到新的独立页面。

全局工作台显示设置可通过顶栏 ⚙️ 打开，修改工作台名称和老师称呼后会立即更新侧栏、首页欢迎语和浏览器页面标题，并保存在浏览器 `localStorage`。

## 生成 1000 条测试数据

需要 Node.js（无第三方 npm 依赖）：

```bash
node sports-meet/seed.js
```

命令会生成 `sports-meet/seed-athletes.sql`。该文件为运动员生成按班级连号的参赛号码，并只替换 `athlete` 表数据；请先备份已有数据库中的运动员数据。
由于外键使用级联删除，重新导入会同时删除这些运动员关联的报名、分组和成绩记录，因此应仅用于测试数据库。

## 创建数据库并导入

安装 SQLite 命令行工具后，在项目根目录运行：

```bash
sqlite3 sports-meet/meet.db < sports-meet/schema.sql
sqlite3 sports-meet/meet.db < sports-meet/seed-athletes.sql
```

如果数据库已按旧版 `schema.sql` 创建，先备份数据库，再按顺序运行迁移：

```bash
sqlite3 sports-meet/meet.db < sports-meet/migrations/001_registration_extensions.sql
sqlite3 sports-meet/meet.db < sports-meet/migrations/002_team_registration_limit.sql
sqlite3 sports-meet/meet.db < sports-meet/migrations/003_result_attempts.sql
sqlite3 sports-meet/meet.db < sports-meet/schema.sql
```

运动员使用 `male` / `female` 表示性别，项目使用 `track` / `field` 表示径赛 / 田赛，轮次使用 `preliminary` / `final` 表示预赛 / 决赛。项目的 `unit` 保存成绩单位，例如秒、米、厘米或次。

## 报名管理页面

在工作台打开“运动会报名”，或直接访问项目根目录的 `registration.html`。页面接受 CSV、XLS 和 XLSX 文件；可下载 CSV 模板查看列格式。报名数据、自动参赛号码和预赛分组保存在浏览器 `localStorage`，与 SQLite 数据库相互独立。

项目名称包含“团体”或“接力”，或标记为 4×100 米接力时，会自动设置 `isTeamEvent: true`。每名运动员允许最多 2 个单项及 1 个团队项目；同一项目重复报名只计一次。系统兼容旧本地数据中的 `isTeam` 标记，并在载入时补齐 `isTeamEvent`。超限时会拒绝保存并分别显示单项和团队项目数量。径赛项目通过名称中的米数、跑步、跨栏或接力关键字识别。自动分组按 6、7 或 8 道均衡分配；当人数无法满足每组至少 6 人时会显示提示。

报名列表支持跨页勾选并批量删除选中运动员及其全部报名；删除前需确认。清空全部报名需在确认框中准确输入 `DELETE`。所有删除都会同步更新本地报名、参赛运动员、计数和预赛分组。

## 赛程编排

在工作台打开“赛程编排”。系统以年级、性别、项目为最小比赛单元分别生成径赛预赛分组与决赛（不超过跑道数时直接决赛），并为田赛生成班级轮流或随机顺序；每个组别内独立安排道次和出场顺序，不会跨年级或性别混排。秩序册支持按年级和性别筛选。径赛与田赛是各自独立的并行时间轴，可在同一时刻启动；每个赛区内部按项目时段串行。编排优先保留径赛时段，并自动推迟与其发生运动员时间冲突的田赛项目，间隔不足 15 分钟时会继续顺延。默认径赛时段 20 分钟、田赛项目 60 分钟，检录时间为开赛前 15 分钟；比赛开始时间和场地可在双栏秩序册中逐项编辑。旧版未按年级隔离的已保存赛程会在载入时自动作废，需要重新编排。

“打印 / 导出 PDF”会打开浏览器打印对话框，可选择“存储为 PDF”；“导出 Word”会下载 `.doc` 格式秩序册。编排结果存入 `pe_sports_meet_v1.schedule`，与报名数据共享本地存储。报名数据重新导入、批量删除或清空后，旧赛程会失效，需要重新编排。

## 成绩录入与班级积分

在工作台打开“成绩管理”。成绩录入按年级、性别和项目筛选；排名只在年级、性别、项目完全一致的组别中计算。径赛支持秒数及分:秒格式；50 米成绩超过 15 秒时会提示复核。田赛支持米或厘米输入，记录最多 6 次试跳/试掷并以最好成绩排名。成绩、尝试次数、名次和积分保存在 `pe_sports_meet_v1.results`；每个独立组别成绩保存后重算排名和积分，前 8 名按 9、7、6、5、4、3、2、1 分计，名次相同时同分，团队项目双倍计分且按年级内班级作为参赛队计分。班级总分按“年级 + 班级”聚合该班运动员在各自年级和性别组别的所得分数。旧版成绩在能够确定年级时会迁移到对应组别。SQLite `result.attempts_json` 用于保存多次试投成绩；旧数据库可运行 `migrations/003_result_attempts.sql` 升级。

成绩管理页“报表导出”支持导出 Excel 可打开的 UTF-8 CSV：成绩册包含全部项目组别的前 8 名（并列名次会一并保留）；颁奖名单包含已排名成绩，可按年级/班级或班级/年级排序，团队项目列出队员；团体总分奖仅列出已获得积分的班级，按全校积分稳定排序，并依班级数量从高到低平均分为一等奖、二等奖、三等奖三档，同分时按年级和班级名称排序。导出不受页面当前年级、性别筛选影响。
