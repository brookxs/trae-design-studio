---
name: UI 界面设计工作台
description: 做网页、App、微信小程序、平板、桌面软件、海报/社媒图、幻灯片、邮件、路线图·导图、组件这类「看得见的设计」时加载。自动唤起 trae-design-studio MCP 预览工作台，打开右侧面板实时预览、点选元素直接对话修改。
triggers:
  - 设计
  - UI
  - UX
  - 界面
  - 网页
  - App
  - 小程序
  - 海报
  - 幻灯片
  - PPT
  - 品牌官网
  - 落地页
  - 首页
  - Mockup
  - 原型
  - 导图
  - 路线图
  - 架构图
---

# 🎨 UI 界面设计工作台（trae-design-studio）

> 当用户提到要设计任何「看得见的界面」时，**自动加载本 Skill**，引导完成：
>
> **生成 HTML → 调 `design_preview` 启动预览服务器 → 拿到 `panel_html` → 立刻调 `PureShowWidget`（mode: "panel"）打开右侧画布 → 用户在画布上点选元素 → AI 拿 `design_poll_selection` 获取元素信息 → 改源文件 → 画布自动刷新。**

## 0 · 触发即启动：三步打开工作台

加载本 Skill 后，**在用户还没说更多之前**，立刻执行以下三步。不要等用户指定预览。

### 第一步：创建设计目录 + tokens.css

用户的项目里很可能已经有 `index.html`，**不要写在工作区根目录**。新建：

```
<workspace>/designs/<设计名>/   ← 例如 designs/gym-app/ 或 designs/coffee-landing/
├── tokens.css                  ← 设计变量（颜色、字体、圆角、阴影等）
├── home.html                   ← 第一屏（首页/封面）
└── ...                         ← 后续每屏一个 HTML
```

### 第二步：调 `design_preview` 启动预览

生成第一屏 HTML 和 `tokens.css` 后，**立刻调**：

```
tool: design_preview
args: {
  target: "<设计目录的绝对路径>",    // 目录路径，不是单个文件
  kind: "<类型>",                     // 见下表选一个
  designId: "<短英文id>"              // 可选，自己生成一个（如 gym-app）
}
```

### 第三步：调 `PureShowWidget` 打开右侧画布

从 `design_preview` 的返回里找到 `--- panel_html ---` 和 `--- panel_html end ---` 之间的内容，**立刻调**：

```
tool: PureShowWidget
args: {
  mode: "panel",
  html: "<panel_html 的完整内容>",
  title: "🎨 设计工作台 · <类型>"
}
```

---

## 类型速查（`kind` 字段）

| kind | 适用场景 | 画幅 | 外框 |
|---|---|---|---|
| `web` | 官网、落地页、SaaS 后台 | 1280×800 | 浏览器窗口 |
| `app` | iOS/Android App | 390×844 | iPhone（灵动岛） |
| `miniprogram` | 微信/支付宝小程序 | 375×812 | 手机 + 右上角胶囊 |
| `tablet` | iPad 平板 | 820×1180 | 平板 |
| `desktop` | Mac/Windows 桌面软件 | 1280×800 | 窗口 + 红绿灯 |
| `poster` | 海报、社媒封面（小红书/朋友圈） | 1080×1350 | 卡片 |
| `slides` | 幻灯片/PPT 单页 | 1280×720 | 卡片 |
| `email` | 邮件模板 | 600 宽 | 卡片 |
| `diagram` | 思维导图、架构图、路线图、产品路线图 | 自适应 | 卡片 |

> 用户没说时，按场景猜：说「App」→ `app`，说「网页/官网」→ `web`，说「小程序」→ `miniprogram`，说「海报/封面」→ `poster`，说「PPT/幻灯片」→ `slides`。

---

## 完整流程

### 0. 先问清，先出方向（可选）

- **什么时候跳过**：用户说了「直接做」「不用问」「帮我推荐」，或者需求已经够具体（说了做什么 + 哪几屏）。跳过 = 第一句话说清你按什么理解开工，直接从「第一步」做全套。
- **问**：只问最关键的两三个问题，一次问完：给谁用、想要什么感觉（给三个具体选项）、有没有品牌色。能用 `AskUserQuestion` 就用它。
- **出三个方向**：只做最能代表的一屏（首页/封面），三个明显不同的方向：`home-a.html`、`home-b.html`、`home-c.html`。**不要同一版式换颜色**。每个方向的 `tokens.css` 变量写在自己文件的 `<style>` 里（`:root{…}`），`<title>` 写成「方向 A · 风格名」。写完第一屏就按「三步打开工作台」预览，另外两个会并排出现。等用户挑：可以混搭（「A 的配色 + C 的版式」）。挑定后：选中方向变量搬进 `tokens.css`，文件改成正式名字（`home.html`），另外两个移进 `drafts/`。

### 1. 每屏一个 HTML，放设计目录

```
designs/gym-app/
├── tokens.css           ← 变量，所有屏共用
├── home.html            ← 首页（第一屏，最先写）
├── profile.html         ← 个人中心
├── activity.html        ← 活动详情
├── icons.svg            ← 共用 SVG 图标（<symbol>）
└── components/          ← 3 屏以上、同一块出现 2 次以上才抽组件
    └── bottom-nav.html
```

**规则**：
- 文件名英文小写，`<title>` 写「屏名 · 产品名」（如「首页 · IronForge」），**用用户的语言**
- 每屏 `<head>` 里 `<link rel="stylesheet" href="tokens.css">`
- 临时试验用 `_` 开头（`_test.html`），不进画布
- **几屏之间用真链接**：按钮、卡片、返回箭头写 `<a href="detail.html">`。返回箭头加 `data-back`：`data-back` 存在时回到上一屏，`href` 是没有上一屏时去哪。
- **同一屏的多种样子**（空列表/有数据/已付款/出错）用「状态」：`<meta name="dsh-states" content="default:有数据, empty:空列表">` + `<html data-state="default">`，差别用 CSS 写 `[data-state="empty"] .list { display: none }`。链接 `?state=empty` 切。

### 2. 调 `design_preview` 打开工作台

写完第一屏 HTML + `tokens.css` 后，**立刻调**（见「三步打开工作台」）。后续每往目录里加 HTML 文件，画布会自动并排出现，不用再调。

### 3. 用户点选元素后改

用户在右侧画布上**直接点**那个要改的元素。然后回到对话说点好了。

**你立刻调**：
```
tool: design_poll_selection
args: {}
```

返回的 payload 里有 `selector`、`text`、`rect`、`kind`（element / region / image / link / input）。**找到源文件，改那一处**：
- 颜色/字号/圆角 → 优先改 `tokens.css` 里的变量，让所有屏保持一致
- 用户在工作台里**手调过样式**（`style="…"`）→ 值是用户要的，别随手删
- 改完只回一句话告诉用户改了什么

### 4. 设计体检 + 截图（需要本机 Chrome 或 Edge）

写完所有屏后：

```
tool: design_check       ← 用无头浏览器按真实尺寸实测
args: { designId: "...", sizes: ["375x667", "430x932"] }

tool: design_look        ← 看一眼真实渲染
args: { designId: "..." }
```

**`design_check` 检查**：文字截断、重叠、对比度、点击区、字号、变形、行太长、固定栏压住内容、脚本报错、文件没载出、跳到不存在的页面。返回问题清单（哪一屏、哪个元素、具体数字）。

**改体检问题**（逐条改，没列出来的别动）：
- 对比度不够 → 调深文字色 / 调浅底色，能改 `tokens.css` 就改变量
- 文字被截断 / 超出框 → 放宽容器、允许换行，别靠缩小字号硬塞
- 文字叠在一起 → 检查绝对定位和负边距
- 点击区太小 → 加内边距或 `min-height`，图标按钮的点击区可以比图标本身大
- 被固定栏压住 → 给内容留出栏高：`padding-bottom: calc(栏高 + 16px)`（App 再加 `env(safe-area-inset-bottom)`）
- 字太小、字号太杂 → 收进 `tokens.css` 的字号阶梯

### 5. 版本管理（随时可回滚）

```
tool: design_history
args: { designId: "...", action: "save", label: "首页改完" }    ← 存一版
args: { designId: "...", action: "list" }                        ← 看历史
args: { designId: "...", action: "restore", version: 2 }          ← 回到某一版
```

### 6. 导出

```
tool: design_export
args: { designId: "...", format: "pdf", name: "gym-app-v1" }
```

格式支持：`pdf`（带书签）/ `png`（展示图）/ `pptx`（屏间跳转可点）。

### 7. 收尾

一两句话告诉用户：
- 做了哪几屏
- 风格要点
- 还剩什么没解决（如果有的话）

---

## 设计原则

**层级**：每屏只有一个视觉焦点（最大的字 / 最亮的按钮）。用字号、字重、颜色深浅三档拉开层级。主操作一个，次操作弱化成描边或文字按钮。

**间距**：全部用 4/8 的倍数。相关的东西靠近（组内间距 < 组间间距 < 区块间距）。宁可留白多，不要塞满。

**字号阶梯**：比例 1.2–1.25，例如 12 / 14 / 16 / 20 / 24 / 32 / 40 / 56。一屏最多 4 个字号。正文 15–16px，行高 1.5–1.7。

**颜色**：按角色定义，不按色相：bg / surface / text / muted / line / primary / accent / success / warning / danger。主色只用在关键操作（60 中性 – 30 辅助 – 10 主色）。

**对比度**：正文对背景 ≥ 4.5:1，大字和图标 ≥ 3:1。

**真实内容**：不要 Lorem ipsum、「标题一」「示例文字」。写像真产品的文案。

**界面语言跟着用户走**：用户用什么语言提需求，界面文案就用什么语言。

**中文排版**：
- 字体栈：`"PingFang SC", "HarmonyOS Sans SC", "MiSans", "Microsoft YaHei", system-ui, sans-serif`
- 不用斜体；字重用 400/500/600
- 中英文/数字之间加空格
- 行高 1.6–1.75

---

## 别有「AI 味」

一眼像 AI 生成的通病，避开：
- 默认紫蓝渐变、霓虹发光、到处玻璃拟态
- 每个区块都居中、每段都是「图标 + 标题 + 一句话」的三栏卡片
- emoji 当图标
- 没有内容的口号式文案（「赋能」「一站式」「极致体验」）
- 什么都往米色/奶油底 + 衬线标题 + 砖红或墨绿上靠

---

## 自查清单（每次写完过一遍）

- [ ] 所有颜色、字号、圆角都来自 `tokens.css`，没有散落的魔法数字
- [ ] 一屏只有一个焦点；主按钮只有一个
- [ ] 间距都是 4/8 的倍数，同类元素间距一致，左边缘对齐
- [ ] 正文对比度 ≥ 4.5:1，灰字没有太浅
- [ ] 文案是真实内容、用的是用户的语言，没有占位文字
- [ ] 图标同一套线性 SVG，没有 emoji 图标
- [ ] 画幅对：App 留出状态栏和安全区
- [ ] `design_check` 没有问题（或剩下的说得出理由）
- [ ] 多屏之间导航、按钮、卡片样式一致

---

## trae-design-studio MCP 工具速查

| 工具 | 做什么 | 什么时候调 |
|---|---|---|
| `design_preview` | 起预览服务器 + 返回 panel HTML | 写完第一屏 HTML，立刻调 |
| `design_poll_selection` | 拿用户在画布上最后一次点的元素 | 用户说「点好了」「改这个」，立刻调 |
| `design_check` | 设计体检（文字溢出、对比度、点击区…） | 写完所有屏后；改完问题后 |
| `design_look` | 截图（真实渲染） | 写完所有屏后，快速扫一眼 |
| `design_history` | 存/看/回滚版本 | 随时存：改之前存一版；用户说「回到刚才」时 restore |
| `design_export` | 导出 PDF/PNG/PPTX | 用户要导出时 |
| `design_close` | 关所有预览 | 用户说「关掉预览」时 |
