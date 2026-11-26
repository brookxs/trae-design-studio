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
  trackers: new Map(), // designId → tracker
  hubs: new Map(),     // designId → hub
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
  return { content: [{ type: 'text', text: `Tool ${name} not implemented` }] }
}

async function toolPreview(args) {
  const target = args.target
  const kind = args.kind || 'web'
  const designId = args.designId || crypto.randomUUID().slice(0, 8)

  if (!serveMod) {
    return { content: [{ type: 'text', text: 'Core modules not loaded. Check lib/ files.' }] }
  }

  try {
    // 解析 target 成 dsh-design-studio 能认的格式
    let parsed
    if (target.startsWith('http://') || target.startsWith('https://') || /^\d+$/.test(target)) {
      const port = /^\d+$/.test(target) ? target : new URL(target).port
      parsed = { kind: 'proxy', url: target.startsWith('http') ? target : `http://localhost:${target}`, port: Number(port) }
    } else {
      // 本地路径
      const stat = fs.statSync(target)
      if (stat.isDirectory()) {
        parsed = { kind: 'file', root: target }
      } else {
        parsed = { kind: 'file', root: path.dirname(target) }
      }
    }

    const hub = serveMod.createHub({ log: studio.log })
    const r = await hub.open(parsed)

    studio.hubs.set(designId, hub)

    // 这里返回的 origin 就是预览服务器地址
    // 前端会用这个地址打开 panel，hub 已经自动注入了 picker.js
    return {
      content: [
        { type: 'text', text: `预览服务器已启动\n` +
          `  designId: ${designId}\n` +
          `  预览地址: ${r.origin}\n` +
          `  设计类型: ${kind}\n\n` +
          `请用 PureShowWidget(mode: "panel", widget_code: iframe src="${r.origin}") 打开预览画布。\n` +
          `picker.js 已自动注入，页面元素可点选。` },
      ],
    }
  } catch (e) {
    return { content: [{ type: 'text', text: `启动预览失败: ${e.message}` }] }
  }
}

async function toolCheck(args) {
  return {
    content: [
      { type: 'text', text: '设计体检功能 (design_check) 需要先完成 browser.js + look.js 的适配层。\n' +
        '底层模块已就位，正在打通 MCP ↔ 无头浏览器链路。' },
    ],
  }
}

async function toolLook(args) {
  return {
    content: [
      { type: 'text', text: '截图功能 (design_look) 需要先完成 browser.js + look.js 的适配层。\n' +
        '底层模块已就位，正在打通 MCP ↔ 无头浏览器链路。' },
    ],
  }
}

async function toolHistory(args) {
  return { content: [{ type: 'text', text: `design_history: ${JSON.stringify(args)} (待适配)` }] }
}

async function toolExport(args) {
  return { content: [{ type: 'text', text: `design_export: ${JSON.stringify(args)} (待适配)` }] }
}

// ---------- Bootstrap ----------

function ensureDirs() {
  for (const d of [CACHE_DIR, HISTORY_DIR, REFS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  }
}

ensureDirs()

process.stderr.write('[trae-design-studio] MCP server ready\n')
process.stderr.write(`[trae-design-studio] lib loaded: ${!!serveMod}\n`)
