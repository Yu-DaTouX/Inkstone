#!/usr/bin/env node
/**
 * 本机浏览器/MCP 控制页。
 *
 * 这个服务只绑定 127.0.0.1。它不连接 Electron 的 remote debugging 端口，
 * 而是让每个请求启动一个短命的第二 Electron 实例，由砚已有的
 * `second-instance` 通道把受限命令交给正在运行的主实例。
 *
 * 用法：
 *   node scripts/yan-control.mjs --server
 *   node scripts/yan-control.mjs status
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CONTROL_ARG_PREFIX = '--yan-control='
const CONTROL_DIR = join(tmpdir(), 'yan-control')
const CONTROL_ACTIONS = new Set(['status', 'focus', 'click', 'type', 'key', 'send'])
const MAX_BODY = 64 * 1024
const MAX_TEXT = 20_000
const HOST = '127.0.0.1'
const DEFAULT_PORT = 37_891

function encodeControlCommand(command) {
  return `${CONTROL_ARG_PREFIX}${Buffer.from(JSON.stringify(command), 'utf8').toString('base64url')}`
}

function responsePath(requestId) {
  return join(CONTROL_DIR, `response-${requestId}.json`)
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function waitForResponse(requestId, timeoutMs = 8_000) {
  const path = responsePath(requestId)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path, 'utf8')
      try {
        const parsed = JSON.parse(raw)
        await unlink(path).catch(() => undefined)
        return parsed
      } catch {
        /* Electron 可能还在写文件；下一轮重新读。 */
      }
    } catch {
      /* 响应还没出现。 */
    }
    await sleep(25)
  }
  await unlink(path).catch(() => undefined)
  throw new Error('砚没有在 8 秒内返回控制结果；当前实例可能尚未重启到带控制桥的版本')
}

async function invoke(action, payload = {}) {
  if (!CONTROL_ACTIONS.has(action)) throw new Error(`不支持的控制动作：${action}`)
  const requestId = randomUUID()
  await mkdir(CONTROL_DIR, { recursive: true })
  const command = { requestId, action, ...payload }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', encodeControlCommand(command)], {
    cwd: root,
    env,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  return waitForResponse(requestId)
}

function parseCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
  const action = body.action
  if (typeof action !== 'string' || !CONTROL_ACTIONS.has(action)) throw new Error('控制动作无效')
  const payload = {}
  if (action === 'click') {
    if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) throw new Error('click 需要有限的 x/y')
    payload.x = Number(body.x)
    payload.y = Number(body.y)
  }
  if (action === 'type' || action === 'send') {
    if (typeof body.text !== 'string' || body.text.length > MAX_TEXT) throw new Error('文本为空或超过 20,000 字符')
    payload.text = body.text
  }
  if (action === 'key') {
    if (typeof body.key !== 'string' || body.key.length === 0 || body.key.length > 32) throw new Error('按键名无效')
    payload.key = body.key
  }
  return { action, payload }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>砚 · 本机控制桥</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101214; color: #e6eee9; }
    body { max-width: 760px; margin: 0 auto; padding: 28px; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { color: #aab7b1; line-height: 1.5; }
    section { border: 1px solid #2b3632; border-radius: 8px; padding: 16px; margin: 16px 0; }
    button { color: #e6eee9; background: #1b2823; border: 1px solid #456056; border-radius: 5px; padding: 8px 12px; margin: 4px; cursor: pointer; }
    button:hover, button:focus-visible { background: #294236; outline: 1px solid #7ed8ad; }
    input, textarea { box-sizing: border-box; width: 100%; color: #e6eee9; background: #0b0f0d; border: 1px solid #34453c; border-radius: 5px; padding: 8px; margin: 5px 0 10px; }
    textarea { min-height: 74px; resize: vertical; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row > * { flex: 1; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0b0f0d; padding: 12px; border-radius: 5px; min-height: 60px; }
    .warning { color: #e8c988; }
    .small { font-size: 12px; }
  </style>
</head>
<body>
  <h1>砚 · 本机控制桥</h1>
  <p>浏览器/MCP 通过本机回环地址连接；请求由砚已有的单实例通道转交，不开放 Electron 调试端口。</p>
  <section>
    <button id="status">读取砚状态</button>
    <button id="focus">聚焦砚窗口</button>
    <button id="escape">发送 Escape</button>
    <pre id="output" aria-live="polite">正在读取状态…</pre>
  </section>
  <section>
    <h2>有限界面输入</h2>
    <p class="small">坐标相对于砚内容区域；先读取状态确认尺寸，再执行单次点击。</p>
    <div class="row"><input id="x" type="number" placeholder="x"><input id="y" type="number" placeholder="y"><button id="click">点击</button></div>
    <textarea id="typeText" placeholder="插入到砚当前焦点"></textarea>
    <button id="type">输入文本</button>
  </section>
  <section>
    <h2>发送消息</h2>
    <p class="warning">这会把文字交给砚当前会话，可能触发模型调用；只有明确需要时使用。</p>
    <textarea id="message" placeholder="要发送给砚的消息"></textarea>
    <button id="send">发送给砚</button>
  </section>
  <script>
    const token = new URL(location.href).searchParams.get('token') || '';
    const output = document.getElementById('output');
    async function call(action, payload) {
      output.textContent = '执行中…';
      try {
        const response = await fetch('/api/command?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-yan-control-token': token },
          body: JSON.stringify(Object.assign({ action }, payload || {}))
        });
        output.textContent = JSON.stringify(await response.json(), null, 2);
      } catch (error) {
        output.textContent = String(error);
      }
    }
    document.getElementById('status').addEventListener('click', () => call('status'));
    document.getElementById('focus').addEventListener('click', () => call('focus'));
    document.getElementById('escape').addEventListener('click', () => call('key', { key: 'Escape' }));
    document.getElementById('click').addEventListener('click', () => call('click', { x: Number(document.getElementById('x').value), y: Number(document.getElementById('y').value) }));
    document.getElementById('type').addEventListener('click', () => call('type', { text: document.getElementById('typeText').value }));
    document.getElementById('send').addEventListener('click', () => {
      if (window.confirm('确认把这段文字发送给砚当前会话吗？')) call('send', { text: document.getElementById('message').value });
    });
    call('status');
  </script>
</body>
</html>`

function checkToken(req, url, token) {
  const header = req.headers['x-yan-control-token']
  const query = url.searchParams.get('token')
  return (typeof header === 'string' && header === token) || query === token
}

async function runServer() {
  const token = randomUUID()
  const port = Number(process.env.YAN_CONTROL_PORT || DEFAULT_PORT)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}:${port}`)
      if (!checkToken(req, url, token)) return sendJson(res, 403, { ok: false, error: '控制页令牌无效' })
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
        })
        return res.end(page)
      }
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const { action, payload } = parseCommand(await readBody(req))
        return sendJson(res, 200, await invoke(action, payload))
      }
      sendJson(res, 404, { ok: false, error: '找不到路径' })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, resolvePromise)
  })
  const url = `http://${HOST}:${port}/?token=${encodeURIComponent(token)}`
  console.log(`砚本机控制桥已启动：${url}`)
  const close = () => server.close(() => process.exit(0))
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

const command = process.argv[2]
if (command === '--server') {
  await runServer()
} else if (command) {
  const { payload } = parseCommand({ action: command, ...Object.fromEntries(process.argv.slice(3).map((arg) => arg.split('='))) })
  console.log(JSON.stringify(await invoke(command, payload), null, 2))
} else {
  console.error('用法：node scripts/yan-control.mjs --server | status | focus | key')
  process.exitCode = 1
}
