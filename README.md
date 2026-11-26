# trae-design-studio

> Design Studio for TRAE — 实时预览画布 · 点击元素对话修改 · 设计检查 · 导出分享

从 [dsh-design-studio](https://github.com/OrderG-X/dsh-design-studio) 移植而来，去掉了所有 DSH (DeepSeek Harness) 依赖，适配 TRAE 的插件体系（MCP server + Skill）。

## 功能

- 🎨 **实时预览画布**：写好 HTML 自动弹出预览，套手机/浏览器/桌面外框
- 🖱️ **点选元素修改**：picker.js 注入页面，点元素 → AI 直接改
- 📱 **多屏并排**：App 多界面、网站多页面一起看，点切换
- ✅ **设计体检**：check_design 用无头浏览器按真实尺寸量，查文字溢出/对比度/按钮尺寸等
- 📷 **视觉检查**：look_design 按真实尺寸截图交回 AI
- 📜 **版本管理**：每轮自动存版，回退对比
- 📤 **导出分享**：展示图、PDF（带书签）、PPT（屏间跳转可点）
- 🔑 **品牌设计系统提取**：给官网 URL → 自动生成 tokens.css
- ➡️ **转代码**：React / Vue / HTML / uni-app，逐像素比对

## 架构

```
┌───────────────────── TRAE 对话 ─────────────────────┐
│  AI 调 MCP 工具: design_preview / check / look / ... │
└──────────────┬──────────────────────────────────────┘
               │ stdio JSON-RPC
               ▼
┌──────────── MCP Server (Node.js) ────────────────────┐
│  server/main.mjs                                     │
│    ├─ preview  → lib/serve.js (本地预览服务器)        │
│    ├─ check    → lib/browser.js + lib/look.js        │
│    ├─ look     → lib/browser.js + lib/look.js        │
│    ├─ history  → lib/history.js                      │
│    ├─ export   → lib/doc.js                          │
│    └─ 更多待适配...                                    │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌────────── PureShowWidget(panel) 画布 ─────────────────┐
│  iframe → http://localhost:PORT/                      │
│  注入 picker.js → postMessage ↔ MCP ↔ AI              │
└──────────────────────────────────────────────────────┘
```

## 目录

```
trae-design-studio/
├── .trae-plugin/plugin.json   # TRAE 插件声明
├── .mcp.json                  # MCP server 配置
├── server/main.mjs            # MCP server 入口
├── lib/                       # 核心模块（从 dsh-design-studio 移植）
│   ├── serve.js               # 预览服务器
│   ├── picker.js              # 页面选取器（注入到被预览的 HTML）
│   ├── browser.js             # 无头浏览器（自动找本机 Chrome/Edge）
│   ├── look.js                # 设计体检 + 截图
│   ├── history.js             # 版本存盘
│   ├── doc.js                 # PDF/PPT/展示图导出
│   ├── bundle.js              # 远程看打包
│   ├── core.js                # 会话跟踪 + 自动发现
│   ├── system.js              # 品牌设计系统提取
│   ├── handoff.js             # 转代码
│   └── ...
├── skills/ui-design/          # 内置设计规范技能
├── locale/                    # 多语言
└── assets/                    # 图标和演示图
```

## 开发进度

- [x] 核心模块移植（serve / browser / look / history / doc / bundle 等）
- [x] MCP server 入口骨架
- [x] TRAE 插件配置
- [ ] serve.js createHub() API 适配 → 让 `toolPreview` 能跑通
- [ ] browser.js + look.js → `toolCheck` / `toolLook` 打通
- [ ] history.js → `toolHistory` 打通
- [ ] doc.js → `toolExport` 打通
- [ ] picker.js 通信链路 → 选完元素直接调 MCP 工具
- [ ] panel HTML 模板（设备外框 + 多屏切换 UI）

## 致谢

基于 [dsh-design-studio](https://github.com/OrderG-X/dsh-design-studio) 开发，感谢原作者的优秀设计。

## License

MIT
