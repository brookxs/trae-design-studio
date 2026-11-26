/**
 * trae-design-studio MCP Server v0.1.0
 *
 * 核心模块移植自 dsh-design-studio，DSH/Cordis 依赖全部移除。
 * 协议层：MCP JSON-RPC over stdio + HTTP endpoint（picker.js 通信）
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LIB = path.join(ROOT, 'lib')

// 动态 import 所有核心模块
const MOD = {}
for (const name of ['serve', 'history', 'browser', 'look', 'doc', 'bundle', 'core']) {
  try { MOD[name] = await import(path.join(LIB, name + '.js')) } catch (e) { process.stderr.write(`[load] ${name} FAIL: ${e.message}\n`) }
}

// ---------- 全局状态 ----------
function pickCacheDir() {
  const preferred = path.join(os.homedir(), '.trae-cn', 'cache', 'trae-design-studio')
  try { fs.mkdirSync(preferred, { recursive: true }); return preferred } catch { return path.join(ROOT, '.cache') }
}
const CACHE_DIR = pickCacheDir()
const HISTORY_DIR = path.join(CACHE_DIR, 'history')
const EXPORT_DIR = path.join(CACHE_DIR, 'exports')
for (const d of [CACHE_DIR, HISTORY_DIR, EXPORT_DIR]) { try { fs.mkdirSync(d, { recursive: true }) } catch {} }

const studio = {
  hub: null,
  designs: new Map(),          // designId → { origin, kind, root }
  pendingSelections: [],       // picker 发来的选择（FIFO，最多 20 条）
  history: null,               // historyMod.createHistory() 实例
  browser: null,               // browserMod.createBrowser() 实例（懒初始化）
  httpPort: 0,                 // MCP HTTP endpoint 端口
  log: (e) => process.stderr.write(`[ds] ${e && e.message ? e.message : e}\n`),
}

if (MOD.history) studio.history = MOD.history.createHistory({ base: HISTORY_DIR, log: studio.log })

// ---------- MCP HTTP Endpoint（picker.js 选完元素 fetch 这里） ----------
function startHttp() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host)
    // CORS：面板 iframe 在另一个源里
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (url.pathname === '/__pick__' && req.method === 'POST') {
      let buf = ''
      req.on('data', (c) => buf += c)
      req.on('end', () => {
        try {
          const data = JSON.parse(buf)
          if (data.type === 'picked' && data.payload) {
            studio.pendingSelections.push({ at: Date.now(), ...data.payload })
            if (studio.pendingSelections.length > 20) studio.pendingSelections.shift()
            studio.log(`picker: ${data.payload.kind || '?'} ${data.payload.selector || data.payload.rect ? 'region' : ''}`)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.writeHead(400); res.end('bad json')
        }
      })
      return
    }

    if (url.pathname === '/__pick__poll' && req.method === 'GET') {
      const latest = studio.pendingSelections.pop()
      if (latest) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(latest))
      } else {
        res.writeHead(204); res.end() // no selection yet
      }
      return
    }

    res.writeHead(404); res.end('not found')
  })
  server.listen(0, '127.0.0.1', () => {
    studio.httpPort = server.address().port
    process.stderr.write(`[ds] HTTP endpoint on 127.0.0.1:${studio.httpPort}\n`)
  })
}
startHttp()

// ---------- MCP JSON-RPC over stdio ----------
const INPUT_BUF = []
process.stdin.on('data', (chunk) => { INPUT_BUF.push(chunk); drainInput() })
function drainInput() {
  const data = Buffer.concat(INPUT_BUF).toString('utf-8'); INPUT_BUF.length = 0
  for (const line of data.split('\n')) {
    if (!line.trim()) continue
    try { handleRequest(JSON.parse(line)) } catch (e) { process.stderr.write(`[parse] ${e.message}\n`) }
  }
}
function sendResponse(id, result, err) {
  const msg = err
    ? { jsonrpc: '2.0', id, error: { code: err.code || -32603, message: err.message } }
    : { jsonrpc: '2.0', id, result }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

// ---------- Tools ----------
const TOOLS = [
  { name: 'design_preview',
    description: '启动设计预览服务器（本地文件/目录/开发服务器），返回预览地址 + panel HTML。picker.js 自动注入，改文件自动刷新。',
    inputSchema: { type: 'object', properties: {
      target: { type: 'string', description: '本地 HTML 路径、目录、http://host:port、或端口号' },
      kind: { type: 'string', enum: ['web','app','miniprogram','tablet','desktop','poster','slides','email','diagram'], default: 'web', description: '设计类型（决定设备外框）' },
      designId: { type: 'string', description: '自定义 ID（可省略，自动生成）' },
    }, required: ['target'] } },
  { name: 'design_poll_selection',
    description: '获取用户在预览面板里最后一次点选的元素。用户在 panel 里点选元素后，调这个工具就能拿到 selector、text、bounding rect 等信息，然后去改源文件。没选过返回空。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'design_check',
    description: '设计体检：用无头浏览器按真实尺寸打开页面，检查文字溢出、对比度不够、按钮太小、字太小等问题，返回问题清单。需要本机 Chrome/Edge。',
    inputSchema: { type: 'object', properties: {
      designId: { type: 'string', description: 'design_preview 返回的 designId' },
      target: { type: 'string', description: '备选：直接指定 HTML 路径或 http 地址' },
    } } },
  { name: 'design_look',
    description: '用无头浏览器按真实尺寸截图，返回 base64 PNG 图片用于视觉检查。需要本机 Chrome/Edge。',
    inputSchema: { type: 'object', properties: {
      designId: { type: 'string' },
      target: { type: 'string' },
    } } },
  { name: 'design_history',
    description: '查看/恢复设计历史版本。save 存一版，list 列出所有版本，restore 回到某一版。',
    inputSchema: { type: 'object', properties: {
      designId: { type: 'string' },
      action: { type: 'string', enum: ['list','save','restore'] },
      version: { type: 'number', description: 'restore 时指定版本号' },
      label: { type: 'string', description: 'save 时的版本标签' },
    }, required: ['designId','action'] } },
  { name: 'design_export',
    description: '导出设计文件：PNG 展示图 / PDF（带书签）/ PPTX（屏间跳转可点）。返回导出的文件路径。',
    inputSchema: { type: 'object', properties: {
      designId: { type: 'string' },
      format: { type: 'string', enum: ['png','pdf','pptx'] },
      name: { type: 'string', description: '文件名（不含扩展名）' },
    }, required: ['designId','format'] } },
  { name: 'design_close',
    description: '关闭所有预览服务器，释放端口。',
    inputSchema: { type: 'object', properties: {} } },
]

// ---------- Request Handler ----------
async function handleRequest(req) {
  try {
    if (req.method === 'initialize') {
      sendResponse(req.id, { protocolVersion: '2024-11-05', serverInfo: { name: 'trae-design-studio', version: '0.1.0' }, capabilities: { tools: {} } })
    } else if (req.method === 'ping') sendResponse(req.id, {})
    else if (req.method === 'tools/list') sendResponse(req.id, { tools: TOOLS })
    else if (req.method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === req.params.name)
      if (!tool) { sendResponse(req.id, null, { message: `Unknown tool: ${req.params.name}` }); return }
      const r = await callTool(tool.name, req.params.arguments || {})
      sendResponse(req.id, r)
    }
  } catch (e) { sendResponse(req.id, null, { message: e.message }) }
}
async function callTool(name, args) {
  const map = {
    design_preview: toolPreview, design_poll_selection: toolPoll,
    design_check: toolCheck, design_look: toolLook,
    design_history: toolHistory, design_export: toolExport, design_close: toolClose,
  }
  return (map[name] || (() => ({ content: [{ type: 'text', text: `Tool ${name} not impl` }] })))(args)
}

// ---------- 工具实现 ----------
function getHub() {
  if (!MOD.serve) throw new Error('serve.js 未加载')
  if (!studio.hub) studio.hub = MOD.serve.createHub({ log: studio.log })
  return studio.hub
}
function resolveRoot(args) {
  const d = studio.designs.get(args.designId)
  if (d) return d
  if (args.target) {
    const abs = path.resolve(args.target)
    const s = fs.statSync(abs)
    return { origin: null, kind: args.kind || 'web', root: s.isDirectory() ? abs : path.dirname(abs) }
  }
  return null
}

async function toolPreview(args) {
  if (!MOD.serve) return { content: [{ type: 'text', text: 'serve.js 未加载' }] }
  const target = args.target
  const kind = args.kind || 'web'
  const designId = args.designId || crypto.randomUUID().slice(0, 8)

  let parsed
  if (/^\d+$/.test(target)) parsed = { kind: 'proxy', port: Number(target) }
  else if (target.startsWith('http://') || target.startsWith('https://')) {
    const u = new URL(target); if (!u.port) throw new Error('URL 需带端口')
    parsed = { kind: 'proxy', port: Number(u.port) }
  } else {
    const abs = path.resolve(target); let stat
    try { stat = fs.statSync(abs) } catch { throw new Error(`路径不存在: ${abs}`) }
    parsed = { kind: 'file', root: stat.isDirectory() ? abs : path.dirname(abs) }
  }

  const hub = getHub()
  const r = await hub.open(parsed)
  studio.designs.set(designId, { origin: r.origin, kind, target, root: parsed.root })

  // 存 history
  if (studio.history && parsed.kind === 'file') {
    try { studio.history.snapshot(parsed.root, 'preview') } catch { /* 还没文件，正常 */ }
  }

  const panelHtml = renderPanelFrame(r.origin, kind, studio.httpPort)
  return { content: [
    { type: 'text', text: `✅ 预览已启动\n  designId: ${designId}\n  origin: ${r.origin}\n  picker HTTP: 127.0.0.1:${studio.httpPort}/__pick__\n\n👉 PureShowWidget 打开 panel，用下面的 panel_html。用户在 panel 里点选元素后，用 design_poll_selection 拿。` },
    { type: 'text', text: `--- panel_html ---\n${panelHtml}\n--- panel_html end ---` },
  ]}
}

function toolPoll() {
  const sel = studio.pendingSelections.pop()
  if (!sel) return { content: [{ type: 'text', text: `还没选。让用户在右侧 panel 里点一下那个要改的元素，然后再调 design_poll_selection。` }] }
  const lines = ['--- 用户选了 ---']
  for (const k of ['kind','selector','name','text','tag','attr','source','href','rect','elements','viewport']) {
    if (sel[k] !== undefined) lines.push(`  ${k}: ${JSON.stringify(sel[k]).slice(0, 300)}`)
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

async function toolCheck(args) {
  const r = resolveRoot(args)
  if (!r) return { content: [{ type: 'text', text: '需要 designId 或 target' }] }
  if (!MOD.browser) return { content: [{ type: 'text', text: 'browser.js 未加载' }] }
  const origin = r.origin || args.target
  if (!origin) return { content: [{ type: 'text', text: '没有可用的页面地址' }] }

  // 懒创建 browser
  if (!studio.browser) studio.browser = MOD.browser.createBrowser({ log: studio.log })

  // look.js 里 measureAll 需要浏览器已开 session
  // 简化版：先开一页，然后调 measureAll
  if (!MOD.look) return { content: [{ type: 'text', text: 'look.js 未加载' }] }
  try {
    const result = await MOD.look.measureAll(studio.browser, [{ url: origin, kind: r.kind || 'web' }])
    const lines = result.map(p => {
      const issues = (p.issues || []).map(i => `  · [${i.level || '!'}] ${i.text || i.msg || JSON.stringify(i).slice(0, 200)}`).join('\n')
      return `\n📄 ${p.url}\n${issues || '  （无问题）'}`
    }).join('\n')
    return { content: [{ type: 'text', text: `✅ 设计体检完成 (${result.length} 屏)\n${lines}` }] }
  } catch (e) {
    return { content: [{ type: 'text', text: `设计体检出错: ${e.message}\n（需要本机 Chrome 或 Edge；可先跳过体检直接写）` }] }
  }
}

async function toolLook(args) {
  const r = resolveRoot(args)
  if (!r) return { content: [{ type: 'text', text: '需要 designId 或 target' }] }
  const origin = r.origin || args.target
  if (!origin) return { content: [{ type: 'text', text: '没有可用的页面地址' }] }
  if (!MOD.browser) return { content: [{ type: 'text', text: 'browser.js 未加载' }] }
  if (!studio.browser) studio.browser = MOD.browser.createBrowser({ log: studio.log })
  if (!MOD.look) return { content: [{ type: 'text', text: 'look.js 未加载' }] }
  try {
    // shootAll 返回 [{ url, shots: [{ name, png: Buffer }] }]
    const result = await MOD.look.shootAll(studio.browser, [{ url: origin, kind: r.kind || 'web' }])
    const parts = []
    for (const p of result) {
      for (const s of (p.shots || [])) {
        if (s.png && Buffer.isBuffer(s.png)) {
          parts.push({ type: 'image', mimeType: 'image/png', data: s.png.toString('base64'), text: `截图: ${s.name || 'shot'}` })
        }
      }
    }
    if (!parts.length) return { content: [{ type: 'text', text: '截图未返回图片数据' }] }
    return { content: parts }
  } catch (e) {
    return { content: [{ type: 'text', text: `截图出错: ${e.message}` }] }
  }
}

function toolHistory(args) {
  const r = studio.designs.get(args.designId)
  if (!r || !r.root) return { content: [{ type: 'text', text: 'designId 没找到或不是本地文件设计' }] }
  if (!studio.history) return { content: [{ type: 'text', text: 'history.js 未加载' }] }
  const root = r.root
  if (args.action === 'list') {
    const list = studio.history.list(root)
    const lines = list.map(v => `${v.n}. [${new Date(v.at).toLocaleString()}] ${v.label || ''}`).join('\n')
    return { content: [{ type: 'text', text: `📜 历史版本 (${list.length})\n${lines || '（还没有版本）'}` }] }
  }
  if (args.action === 'save') {
    const v = studio.history.snapshot(root, args.label || `手动存 ${new Date().toLocaleTimeString()}`)
    return { content: [{ type: 'text', text: v ? `✅ 存了一版 #${v.n}` : '（没改动，没存）' }] }
  }
  if (args.action === 'restore') {
    const v = studio.history.restore(root, args.version)
    return { content: [{ type: 'text', text: v ? `✅ 回到 #${v.n}` : '（版本号不对或恢复失败）' }] }
  }
  return { content: [{ type: 'text', text: `未知 action: ${args.action}` }] }
}

function toolExport(args) {
  const r = studio.designs.get(args.designId)
  if (!r || !r.root) return { content: [{ type: 'text', text: 'designId 没找到或不是本地文件设计' }] }
  if (!MOD.doc) return { content: [{ type: 'text', text: 'doc.js 未加载' }] }
  if (args.format !== 'pdf') return { content: [{ type: 'text', text: `${args.format} 导出暂时只做 PDF，后续补 PNG/PPTX` }] }
  // PDF 需要 pages: [{ jpg: base64, w, h, title, links }]
  // 简化：先列目录里的 HTML 文件，等 browser.js 打通后截图再导出
  let htmlFiles
  try { htmlFiles = fs.readdirSync(r.root).filter(f => f.endsWith('.html')).sort() }
  catch { return { content: [{ type: 'text', text: `读不到目录 ${r.root}` }] } }
  return { content: [{ type: 'text', text: `📤 PDF 导出准备中\n  设计目录: ${r.root}\n  发现 ${htmlFiles.length} 个 HTML 文件: ${htmlFiles.join(', ')}\n\n（完整 PDF 导出需要 browser.js 截图 → 正在打通）` }] }
}

function toolClose() {
  if (studio.hub) { studio.hub.closeAll(); studio.hub = null }
  studio.designs.clear()
  return { content: [{ type: 'text', text: '✅ 预览已全部关闭' }] }
}

// ---------- Panel HTML 模板 ----------
/** 给 PureShowWidget(panel) 的完整 HTML */
function renderPanelFrame(origin, kind, pickerPort) {
  const sizes = {
    web:       { w: '96%',  h: '85vh',  frame: false, dev: '' },
    app:       { w: '390px',h: '844px', frame: true,  dev: 'iphone' },
    miniprogram:{ w: '375px',h: '812px', frame: true,  dev: 'mini' },
    tablet:    { w: '820px',h: '1180px',frame: true,  dev: 'ipad' },
    desktop:   { w: '1280px',h:'800px', frame: true,  dev: 'mac' },
    poster:    { w: '390px',h: '520px', frame: true,  dev: 'iphone' },
    slides:    { w: '960px',h: '540px', frame: true,  dev: 'slides' },
    email:     { w: '600px',h: '900px', frame: false, dev: '' },
    diagram:   { w: '1000px',h:'625px', frame: false, dev: '' },
  }
  const s = sizes[kind] || sizes.web
  const pickerHook = pickerPort ? pickerInjector(pickerPort) : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🎨 trae-design-studio · ${kind}</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:20px;background:#f5f6f8;font-family:-apple-system,Segoe UI,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;gap:16px}
.hd{width:${s.frame?'auto':'100%'};display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#888;font-family:monospace}
.hd b{color:#444;font-family:-apple-system,sans-serif;font-weight:600;font-size:13px}
.eb{border:1px solid #e1e1e4;border-radius:8px;background:#fff;overflow:hidden;width:${s.w};height:${s.h}}
.eb iframe{width:100%;height:100%;border:0;display:block;background:#fff}
/* iPhone */
.iphone{background:#1a1a1a;border-radius:48px;padding:10px;box-shadow:0 20px 60px rgba(0,0,0,.15);width:${s.w};height:${s.h};position:relative}
.iphone::before{content:"";position:absolute;top:12px;left:50%;transform:translateX(-50%);width:120px;height:30px;background:#000;border-radius:0 0 20px 20px;z-index:2}
.iphone iframe{border-radius:36px}
/* Mac */
.mac{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.15);width:${s.w};height:${s.h}}
.macbar{height:30px;background:#ececec;display:flex;align-items:center;padding-left:12px;gap:6px}
.macbar span{width:12px;height:12px;border-radius:50%;display:inline-block}
.macbar .r{background:#ff5f57}.macbar .y{background:#febc2e}.macbar .g{background:#28c840}
.macbody{border-top:1px solid #e1e1e4;height:calc(100% - 30px)}
/* 小程序 */
.mini{background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.15);position:relative;width:${s.w};height:${s.h}}
.mini::after{content:"";position:absolute;top:8px;right:12px;width:76px;height:26px;border-radius:13px;border:1px solid #000;z-index:2}
/* iPad */
.ipad{background:#1a1a1a;border-radius:40px;padding:12px;box-shadow:0 20px 60px rgba(0,0,0,.15);width:${s.w};height:${s.h}}
.ipad::before{content:"";position:absolute;bottom:14px;left:50%;transform:translateX(-50%);width:120px;height:4px;background:#333;border-radius:2px;z-index:2}
.ipad iframe{border-radius:28px}
/* slides */
.slides{width:${s.w};height:${s.h};border:1px solid #e1e1e4;border-radius:6px;background:#fff;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.08)}
</style>
</head>
<body>
  <div class="hd"><b>🎨 设计工作台 · ${kind}</b><span>${origin}</span></div>
  ${frameHtml(origin, kind, s)}
${pickerHook}
</body></html>`
}

function frameHtml(origin, kind, s) {
  if (kind === 'app' || kind === 'poster') return `<div class="iphone"><iframe src="${origin}"></iframe></div>`
  if (kind === 'miniprogram') return `<div class="mini"><iframe src="${origin}"></iframe></div>`
  if (kind === 'desktop') return `<div class="mac"><div class="macbar"><span class="r"></span><span class="y"></span><span class="g"></span></div><div class="macbody"><iframe src="${origin}" style="width:100%;height:100%;border:0"></iframe></div></div>`
  if (kind === 'tablet') return `<div class="ipad"><iframe src="${origin}"></iframe></div>`
  if (kind === 'slides') return `<div class="slides"><iframe src="${origin}"></iframe></div>`
  return `<div class="eb"><iframe src="${origin}"></iframe></div>`
}

/**
 * 注入到 panel HTML 的 script：把 picker.js 发来的 postMessage 转发到 MCP HTTP endpoint。
 * picker.js 在 iframe 里 postMessage({ dshDesign: 1, type: 'picked', payload })
 * panel 外层 window 收到 → fetch 给 MCP server
 */
function pickerInjector(pickerPort) {
  return `<script>
// trae-design-studio picker bridge
const __mcpPickUrl = 'http://127.0.0.1:${pickerPort}/__pick__';
addEventListener('message', async (e) => {
  if (!e.data || !e.data.dshDesign) return;
  try {
    await fetch(__mcpPickUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(e.data),
    });
  } catch {}
});
// 点一下启动 picker（picker.js 已在 iframe 里，但它在 iframe 内部监听 click）
// panel 外层不需要额外做什么；用户直接点 iframe 里的元素就行
</script>`
}

process.stderr.write('[trae-design-studio] MCP server ready\n')
process.stderr.write(`[trae-design-studio] serve=${!!MOD.serve} browser=${!!MOD.browser} look=${!!MOD.look} history=${!!MOD.history} doc=${!!MOD.doc}\n`)
