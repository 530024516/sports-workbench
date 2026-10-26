# 体育教师工作台 - 项目记忆

## 项目概况
- 用户身份：体育老师
- 工作台类型：网页应用（纯 HTML/CSS/JS）
- 项目路径：`/Users/dengyinhong/Desktop/Personal/01_进行中/体育教师工作台/`
- 预览端口：5123（`node server.js`）

## 技术选型
- 无框架，原生 HTML + CSS + JavaScript
- Chart.js 4.4.1（CDN）做数据可视化
- localStorage 做数据持久化（首次加载注入示例数据）
- 自建设计令牌系统，主题色为运动橙 #E85D04

## 三大模块
1. **学生信息管理** (`students.html`)：增删改查、搜索筛选、学生档案详情
2. **体测数据** (`fitness.html`)：成绩录入（含等级预览）、统计分析（饼图+柱状图）、成绩明细
3. **教案与资源库** (`lessons.html`)：教案卡片/列表双视图、教案详情、教学资源卡片

## 数据结构
- 学生：id、name、gender、grade、class、height、weight、guardian、phone、status
- 体测记录：studentId、testType、value、testDate、semester
- 教案：title、grade、sport、duration、difficulty、objectives、keyPoints、process、equipment、status
- 资源：name、type、subject、size

## 体测项目与评分
- BMI、50米跑、坐位体前屈、跳绳、肺活量、仰卧起坐
- 评分标准基于国家体质健康标准（简化版），分男女
