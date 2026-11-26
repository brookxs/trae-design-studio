/**
 * trae-design-studio MCP Server
 *
 * 把 dsh-design-studio 的核心服务端模块（preview server / tracker / history / browser /
 * look / doc / bundle 等）暴露成 MCP 工具，供 TRAE AI 调用。
 *
 * 与 DSH 的区别：
 *   - DSH 用 @deepseek-ai/dsh-tools 注册工具 + Cordis ctx；这里用 MCP 标准协议 (stdio + JSON-RPC)
 *   - DSH 靠 sidebarRightTabs 钩子注入右侧栏；这里返回 URL + HTML，让 TRAE 用 PureShowWidget(panel) 打开
 *   - DSH 的 session 概念换成 designId（每个设计一个唯一 ID）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LIB = path.join(ROOT, 'lib')

// 加载核心模块
// 用动态 import 避免顶层执行（某些模块在 DSH apply() 之后才初始化）
let serveMod, coreMod, historyMod, browserMod, lookMod, docMod, bundleMod
try {
  serveMod = await import(path.join(LIB, 'serve.js'))
  coreMod = await import(path.join(LIB, 'core.js'))
  historyMod = await import(path.join(LIB, 'history.js'))
  browserMod = await import(path.join(LIB, 'browser.js'))
  lookMod = await import(path.join(LIB, 'look.js'))
  docMod = await import(path.join(LIB, 'doc.js'))
  bundleMod = await import(path.join(LIB, 'bundle.js'))
} catch (e) {
  console.error('[trae-design-studio] Failed to load core modules:', e.message)
}

// 全局状态（类似 dsh-design-studio 的 studio 对象）
const studio = {
  hub: null,           // 全局共享一个 hub（简化版，后续扩多 designId）
  designs: new Map(),  // designId → { origin, kind, target }
  history: null,
  browser: null,
  log: (e) => process.stderr.write(`[trae-design-studio] ${e && e.message ? e.message : e}\n`),
}

// 缓存路径：优先 ~/.trae-cn，写不了就存项目内 .cache
function pickCacheDir() {
  const preferred = path.join(os.homedir(), '.trae-cn', 'cache', 'trae-design-studio')
  try {
    fs.mkdirSync(preferred, { recursive: true })
    return preferred
  } catch {
    return path.join(ROOT, '.cache')
  }
}
const CACHE_DIR = pickCacheDir()
const HISTORY_DIR = path.join(CACHE_DIR, 'history')
const REFS_DIR = path.join(CACHE_DIR, 'refs')

// ---------- MCP JSON-RPC 协议层 ----------

const INPUT_BUF = []
process.stdin.on('data', (chunk) => {
  INPUT_BUF.push(chunk)
  drainInput()
})

function drainInput() {
  const data = Buffer.concat(INPUT_BUF).toString('utf-8')
  INPUT_BUF.length = 0
  for (const line of data.split('\n')) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      handleRequest(msg)
    } catch (e) {
      process.stderr.write(`[parse] ${e.message}\n`)
    }
  }
}

function sendResponse(id, result, error) {
  const msg = error
    ? { jsonrpc: '2.0', id, error: { code: error.code || -32603, message: error.message } }
    : { jsonrpc: '2.0', id, result }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function sendNotification(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

// ---------- Tools 定义 ----------

const TOOLS = [
  {
    name: 'design_preview',
    description: '在本地启动设计预览服务器，返回一个可在 TRAE 右侧面板打开的 URL。写好 HTML 后调一次，之后改文件自动刷新。支持多个页面并排预览。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '本地 HTML 文件的绝对路径，或目录路径，或开发服务器地址 (http://localhost:5173)' },
        kind: {
          type: 'string',
          enum: ['web', 'app', 'miniprogram', 'tablet', 'desktop', 'poster', 'slides', 'email', 'diagram'],
          description: '设计类型：web(网页)、app(手机App)、miniprogram(小程序)、tablet、desktop、poster、slides、email、diagram(路线图/导图)',
        },
        designId: { type: 'string', description: '可选，自定义设计ID（用于多屏管理和历史记录）' },
      },
      required: ['target'],
    },
  },
  {
    name: 'design_check',
    description: '设计体检：用无头浏览器按真实尺寸量每一屏，检查文字溢出、对比度不够、按钮太小、字太小等问题，返回问题清单。',
    inputSchema: {
      type: 'object',
      properties: {
        designId: { type: 'string', description: 'design_preview 返回的 designId' },
        target: { type: 'string', description: '备选：直接指定 HTML 路径或地址' },
      },
      required: [],
    },
  },
  {
    name: 'design_look',
    description: '用无头浏览器按真实尺寸截图，返回页面渲染图，用于视觉检查。',
    inputSchema: {
      type: 'object',
      properties: {
        designId: { type: 'string', description: 'design_preview 返回的 designId' },
        target: { type: 'string', description: '备选：直接指定 HTML 路径或地址' },
      },
      required: [],
    },
  },
  {
    name: 'design_history',
    description: '查看或恢复设计历史版本。每轮对话前后自动存一版。',
    inputSchema: {
      type: 'object',
      properties: {
        designId: { type: 'string', description: 'designId' },
        action: { type: 'string', enum: ['list', 'restore'], description: 'list 列出版本，restore 回到某一版' },
        version: { type: 'number', description: 'restore 时指定版本号' },
      },
      required: ['designId', 'action'],
    },
  },
  {
    name: 'design_export',
    description: '导出设计：展示图、PDF、PPT。',
    inputSchema: {
      type: 'object',
      properties: {
        designId: { type: 'string', description: 'designId' },
        format: { type: 'string', enum: ['png', 'pdf', 'pptx'], description: '导出格式' },
        name: { type: 'string', description: '文件名（不含扩展名）' },
      },
      required: ['designId', 'format'],
    },
  },
  {
    name: 'design_close',
    description: '关闭所有预览服务器，释放端口。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

// ---------- Request Handler ----------

async function handleRequest(req) {
  try {
    if (req.method === 'initialize') {
      sendResponse(req.id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'trae-design-studio', version: '0.1.0' },
        capabilities: { tools: {} },
      })
    } else if (req.method === 'notifications/initialized') {
      // handshake done
    } else if (req.method === 'ping') {
      sendResponse(req.id, {})
    } else if (req.method === 'tools/list') {
      sendResponse(req.id, { tools: TOOLS })
    } else if (req.method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === req.params.name)
      if (!tool) {
        sendResponse(req.id, null, { message: `Unknown tool: ${req.params.name}` })
        return
      }
      const result = await callTool(tool.name, req.params.arguments || {})
      sendResponse(req.id, result)
    } else {
      sendResponse(req.id, null, { message: `Unknown method: ${req.method}` })
    }
  } catch (e) {
    sendResponse(req.id, null, { message: e.message })
  }
}

// ---------- Tool Implementations ----------

async function callTool(name, args) {
  if (name === 'design_preview') return toolPreview(args)
  if (name === 'design_check') return toolCheck(args)
  if (name === 'design_look') return toolLook(args)
  if (name === 'design_history') return toolHistory(args)
  if (name === 'design_export') return toolExport(args)
  if (name === 'design_close') return toolClose(args)
  return { content: [{ type: 'text', text: `Tool ${name} not implemented` }] }
}

/** 全局共享一个 hub（设计简单，后续多 designId 并行时每个开一个） */
function getHub() {
  if (!serveMod) throw new Error('serve.js 未加载')
  if (!studio.hub) studio.hub = serveMod.createHub({ log: studio.log })
  return studio.hub
}

async function toolPreview(args) {
  const target = args.target
  const kind = args.kind || 'web'
  const designId = args.designId || crypto.randomUUID().slice(0, 8)

  // 解析 target → createHub.open() 需要的格式
  let parsed
  if (/^\d+$/.test(target)) {
    parsed = { kind: 'proxy', port: Number(target) }
  } else if (target.startsWith('http://') || target.startsWith('https://')) {
    const u = new URL(target)
    if (!u.port) throw new Error(`URL 需要带端口号，例如 http://localhost:5173`)
    parsed = { kind: 'proxy', port: Number(u.port) }
  } else {
    // 本地路径
    const abs = path.resolve(target)
    let stat
    try { stat = fs.statSync(abs) } catch { throw new Error(`路径不存在: ${abs}`) }
    parsed = { kind: 'file', root: stat.isDirectory() ? abs : path.dirname(abs) }
  }

  const hub = getHub()
  const r = await hub.open(parsed)

  studio.designs.set(designId, { origin: r.origin, kind, target })

  // 生成 panel HTML：iframe + 设备外框 + 多屏切换占位
  const panelHtml = renderPanelFrame(r.origin, kind)

  return {
    content: [
      {
        type: 'text',
        text: `✅ 预览服务器已启动\n` +
          `  designId: ${designId}\n` +
          `  origin: ${r.origin}\n` +
          `  kind: ${kind}\n` +
          `  target: ${target}\n\n` +
          `👉 现在请用 PureShowWidget 打开右侧面板:\n` +
          `   mode: "panel"\n` +
          `   widget_code: 用下面这份 panel_html\n\n` +
          `picker.js 已自动注入，页面元素可点选。\n` +
          `改源文件后预览自动刷新。`,
      },
      { type: 'text', text: `--- panel_html 开始 ---\n${panelHtml}\n--- panel_html 结束 ---` },
    ],
  }
}

async function toolCheck(args) {
  if (!lookMod || !browserMod) {
    return { content: [{ type: 'text', text: 'look.js / browser.js 未加载' }] }
  }
  const origin = args.designId ? (studio.designs.get(args.designId)?.origin) : null
  const target = args.target || (origin ? null : null)
  if (!origin && !target) {
    return { content: [{ type: 'text', text: '需要 designId 或 target' }] }
  }
  // TODO: 打通 browser.js createBrowser() → lookMod.checkDess()
  return {
    content: [
      { type: 'text', text: 'design_check 骨架已就位，browser.js + look.js 打通中。\n' +
        `designId: ${args.designId || '-'}\n` +
        `origin: ${origin || '-'}` },
    ],
  }
}

async function toolLook(args) {
  return { content: [{ type: 'text', text: `design_look 骨架已就位 (${JSON.stringify(args)})` }] }
}

async function toolHistory(args) {
  return { content: [{ type: 'text', text: `design_history 骨架已就位 (${JSON.stringify(args)})` }] }
}

async function toolExport(args) {
  return { content: [{ type: 'text', text: `design_export 骨架已就位 (${JSON.stringify(args)})` }] }
}

async function toolClose(args) {
  const hub = studio.hub
  if (!hub) return { content: [{ type: 'text', text: '没有打开的预览服务器' }] }
  hub.closeAll()
  studio.hub = null
  studio.designs.clear()
  return { content: [{ type: 'text', text: '所有预览服务器已关闭' }] }
}

/** 给 PureShowWidget(panel) 的 HTML：设备外框 + iframe */
function renderPanelFrame(origin, kind) {
  // 默认设备尺寸
  const sizes = {
    web: { w: '100%', h: '100%', frame: false },
    app: { w: '390px', h: '844px', frame: true, frameName: 'iphone' },
    miniprogram: { w: '375px', h: '812px', frame: true, frameName: 'miniprogram' },
    tablet: { w: '820px', h: '1180px', frame: true, frameName: 'ipad' },
    desktop: { w: '1280px', h: '800px', frame: true, frameName: 'mac' },
    poster: { w: '390px', h: '520px', frame: true, frameName: 'iphone' },
    slides: { w: '960px', h: '540px', frame: true, frameName: 'slides' },
    email: { w: '600px', h: '900px', frame: false },
    diagram: { w: '1000px', h: '625px', frame: false },
  }
  const s = sizes[kind] || sizes.web

  const frame = s.frame ? FRAMES[s.frameName] || FRAMES.iphone : ''

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>trae-design-studio · ${kind}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#f5f6f8; font-family:-apple-system,Segoe UI,sans-serif; min-height:100vh; display:flex; flex-direction:column; align-items:center; gap:24px; }
  .ds-header { width:100%; max-width:${s.w}; display:flex; justify-content:space-between; align-items:center; }
  .ds-title { font-size:13px; color:#666; font-weight:600; }
  .ds-origin { font-family:monospace; font-size:11px; color:#999; }
  .ds-frame { ${s.frame ? frame : 'width:'+s.w+';height:'+s.h+';border:1px solid #e1e1e4;border-radius:8px;background:#fff;overflow:hidden;'} }
  .ds-frame iframe { width:100%; height:100%; border:0; display:block; }
  /* 设备外框（iPhone 风格）*/
  .ds-device { position:relative; background:#1a1a1a; border-radius:48px; padding:10px; box-shadow:0 20px 60px rgba(0,0,0,0.15); }
  .ds-device::before { content:""; position:absolute; top:12px; left:50%; transform:translateX(-50%); width:120px; height:30px; background:#000; border-radius:0 0 20px 20px; z-index:2; }
  .ds-device iframe { border-radius:36px; }
  /* Mac 窗口 */
  .ds-mac { background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,0.15); }
  .ds-mac-bar { height:30px; background:#ececec; display:flex; align-items:center; padding-left:12px; gap:6px; }
  .ds-mac-bar span { width:12px; height:12px; border-radius:50%; display:inline-block; }
  .ds-mac-bar .r { background:#ff5f57; }
  .ds-mac-bar .y { background:#febc2e; }
  .ds-mac-bar .g { background:#28c840; }
  .ds-mac-iframe { border-top:1px solid #e1e1e4; }
  /* 小程序 */
  .ds-mini { position:relative; background:#fff; border-radius:24px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,0.15); }
  .ds-mini::after { content:""; position:absolute; top:8px; right:12px; width:76px; height:26px; border-radius:13px; border:1px solid #000; z-index:2; }
</style></head>
<body>
  <div class="ds-header">
    <div class="ds-title">🎨 设计工作台 · ${kind} · ${s.w}×${s.h}</div>
    <div class="ds-origin">${origin}</div>
  </div>
  ${frameBlock(origin, kind, s)}
</body></html>`
}

function frameBlock(origin, kind, s) {
  if (kind === 'app' || kind === 'poster') {
    return `<div class="ds-device" style="width:${s.w};height:${s.h};"><iframe src="${origin}" style="width:100%;height:100%;"></iframe></div>`
  }
  if (kind === 'miniprogram') {
    return `<div class="ds-mini" style="width:${s.w};height:${s.h};"><iframe src="${origin}" style="width:100%;height:100%;"></iframe></div>`
  }
  if (kind === 'desktop') {
    return `<div class="ds-mac" style="width:${s.w};height:${s.h};"><div class="ds-mac-bar"><span class="r"></span><span class="y"></span><span class="g"></span></div><div class="ds-mac-iframe" style="width:100%;height:calc(100% - 30px);"><iframe src="${origin}" style="width:100%;height:100%;border:0;display:block;"></iframe></div></div>`
  }
  // web / slides / email / diagram / tablet
  const w = kind === 'web' ? '96%' : s.w
  const h = kind === 'web' ? '85vh' : s.h
  return `<div class="ds-frame" style="width:${w};height:${h};"><iframe src="${origin}"></iframe></div>`
}

const FRAMES = { /* 占位，上面的 CSS 里已写了 */ }

// ---------- Bootstrap ----------

function ensureDirs() {
  for (const d of [CACHE_DIR, HISTORY_DIR, REFS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  }
}

ensureDirs()

process.stderr.write('[trae-design-studio] MCP server ready\n')
process.stderr.write(`[trae-design-studio] lib loaded: ${!!serveMod}\n`)
