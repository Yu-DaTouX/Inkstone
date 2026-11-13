#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-stream-projection-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_ATTACHMENTS_DIR = join(root, 'attachments')
const work = join(root, 'work')
await mkdir(work, { recursive: true })

const frozenSource = join('scripts', 'fixtures', 'agent-stream-before.ts')
const outDir = join(process.cwd(), 'out', 'test', 'stream-projection')
await mkdir(outDir, { recursive: true })

let checks = 0
const ok = (condition, label, detail = '') => {
  assert.ok(condition, detail ? `${label}: ${detail}` : label)
  checks += 1
  console.log(`  ✓ ${label}`)
}

const electronStub = {
  name: 'stream-projection-electron',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stream-electron' }))
    builder.onLoad({ filter: /.*/, namespace: 'stream-electron' }, () => ({
      contents: `
        export class BrowserWindow { constructor() { throw new Error('no electron') } }
        export const session = { fromPartition() { throw new Error('no electron') } }
        export const app = { getLocale: () => 'zh-CN', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0.0.0', isPackaged: false }
        export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }
        export const safeStorage = { isEncryptionAvailable: () => false }
      `,
      loader: 'js'
    }))
  }
}

async function bundle(name, contents, resolveDir) {
  const outfile = join(outDir, `${name}.mjs`)
  await build({
    stdin: { contents, resolveDir, loader: 'ts', sourcefile: `${name}.ts` },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    plugins: [electronStub],
    logLevel: 'silent'
  })
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

function installClock() {
  const real = { now: Date.now, perf: performance.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  const wall0 = 1_800_000_000_000
  const mono0 = 50_000
  let offset = 0
  let seq = 1
  const timers = new Map()
  Date.now = () => wall0 + offset
  performance.now = () => mono0 + offset
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = seq++
    const handle = { id, unref: () => handle, ref: () => handle, hasRef: () => true, refresh: () => handle, [Symbol.toPrimitive]: () => id }
    const delay = Number(ms)
    timers.set(id, { at: offset + (delay >= 1 ? Math.floor(delay) : 1), fn, args })
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    if (handle == null) return
    timers.delete(typeof handle === 'object' ? handle.id : Number(handle))
  }
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    elapsed: () => offset,
    realWait: (ms) => new Promise((resolve) => real.setTimeout(resolve, ms)),
    settle,
    async advance(ms) {
      const target = offset + ms
      for (;;) {
        let next
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (!next || timer.at < next[1].at || (timer.at === next[1].at && id < next[0])) next = [id, timer]
        }
        if (!next) break
        timers.delete(next[0])
        offset = next[1].at
        next[1].fn(...next[1].args)
        await settle()
      }
      offset = target
      await settle()
    },
    pending: () => timers.size,
    restore() {
      Date.now = real.now
      performance.now = real.perf
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
    }
  }
}

const digest = (lines) => lines.map((line) => {
  const space = line.indexOf(' ')
  return `${line.slice(0, space)} ${createHash('sha256').update(line.slice(space + 1)).digest('hex').slice(0, 24)}`
})

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function normalizer(sessionId) {
  const rootJson = JSON.stringify(root).slice(1, -1)
  const rootUrl = root.replace(/\\/g, '/')
  return (text) => text.split(rootJson).join('<root>').split(rootUrl).join('<root>').split(sessionId).join('<session>').replace(UUID, '<uuid>')
    .replace(/\b[0-9a-f]{32}\b/g, '<hash>').replace(/yan-image-[0-9a-f]{8}/g, 'yan-image-<hex>')
}

const usage = (output, input = 100) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
const assistantEnd = (extra = {}) => ({ role: 'assistant', content: [], usage: usage(40), model: 'fake-model', stopReason: 'stop', timestamp: 1_800_000_000_500, ...extra })
const delta = (type, extra = {}) => ({ type: 'message_update', assistantMessageEvent: { type, ...extra } })
const textChunks = (count, base = '字') => Array.from({ length: count }, (_, i) => `${base}${i}${i % 7 === 0 ? '\n\n' : ' '}`)

function fakeRpc(hold) {
  return {
    running: true,
    on() {},
    async command(type, payload, options) {
      if (hold?.[type]) return hold[type](payload, options)
      return { success: true, data: {} }
    },
    async close() {}
  }
}

const scenarios = {
  async 纯文字流({ ev, tick }) {
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    await tick(120)
    ev({ type: 'message_start', message: { role: 'assistant' } })
    await tick(300)
    let n = 0
    for (const chunk of textChunks(60)) {
      ev(delta('text_delta', { delta: chunk }), { usage: usage(++n) })
      await tick([3, 9, 17, 1, 25, 40][n % 6])
    }
    ev(delta('text_delta', { delta: '' }))
    await tick(5)
    ev(delta('text_delta', { delta: '尾' }), { usage: usage(60, 500) })
    await tick(16)
    ev({ type: 'message_end', message: assistantEnd({ usage: usage(61) }) })
    await tick(50)
    ev({ type: 'turn_end' })
    ev({ type: 'agent_end', messages: [] })
    ev({ type: 'agent_settled' })
    await tick(200)
  },

  async 带思考({ ev, tick }) {
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    await tick(80)
    ev({ type: 'message_start', message: { role: 'assistant' } })
    await tick(10)
    ev(delta('thinking_start', { contentIndex: 0 }))
    await tick(400)
    for (let i = 0; i < 30; i += 1) {
      ev(delta('thinking_delta', { contentIndex: 0, delta: `想${i}，` }), { usage: usage(i + 1) })
      await tick(i % 3 === 0 ? 2 : 13)
    }
    ev(delta('thinking_delta', { contentIndex: 0, delta: '' }))
    ev(delta('thinking_end', { contentIndex: 0 }))
    await tick(7)
    ev(delta('text_start', { contentIndex: 1 }))
    for (let i = 0; i < 20; i += 1) {
      ev(delta('text_delta', { contentIndex: 1, delta: `答${i}` }), { usage: usage(31 + i) })
      await tick(i % 4 === 0 ? 30 : 4)
    }
    ev(delta('text_end', { contentIndex: 1 }))
    await tick(3)
    ev({ type: 'message_end', message: assistantEnd({ usage: usage(55) }) })
    ev({ type: 'turn_end' })
    ev({ type: 'agent_end', messages: [] })
    ev({ type: 'agent_settled' })
    await tick(100)
  },

  async 多工具并行({ ev, tick }) {
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    await tick(50)
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('text_delta', { contentIndex: 0, delta: '我同时查三处。' }))
    await tick(5)
    const calls = [
      { id: 'call-read', toolName: 'read', args: '{"path":"README.md"}' },
      { id: 'call-bash', toolName: 'job_runner', args: '{"command":"ls -la"}' },
      { id: 'call-write', toolName: 'write', args: `{"path":"page.html","content":"${'<p>x</p>'.repeat(40)}"}` }
    ]
    for (const [index, call] of calls.entries()) {
      const contentIndex = index + 1
      ev(delta('toolcall_start', { contentIndex, id: call.id, toolName: call.toolName }))
      await tick(4)
      const parts = call.args.match(/.{1,24}/g)
      for (const part of parts) {
        ev(delta('toolcall_delta', { contentIndex, delta: part }))
        await tick(call.toolName === 'write' ? 90 : 6)
      }
      ev(delta('toolcall_end', { contentIndex, toolCall: { type: 'toolCall', id: call.id, name: call.toolName, arguments: JSON.parse(call.args) } }))
      await tick(3)
    }
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'toolUse' }) })
    ev({ type: 'tool_execution_start', toolCallId: 'call-read', toolName: 'read', args: { path: 'README.md' } })
    ev({ type: 'tool_execution_start', toolCallId: 'call-bash', toolName: 'job_runner', args: { command: 'ls -la' } })
    ev({ type: 'tool_execution_start', toolCallId: 'call-write', toolName: 'write', args: { path: join(work, 'page.html'), content: '<p>x</p>' } })
    await tick(10)
    let bashOut = ''
    for (let i = 0; i < 12; i += 1) {
      bashOut += `file-${i}\n`
      ev({ type: 'tool_execution_update', toolCallId: 'call-bash', partialResult: { content: [{ type: 'text', text: bashOut }] } })
      if (i === 4) ev({ type: 'tool_execution_update', toolCallId: 'call-read', partialResult: { content: [{ type: 'text', text: '# README' }] } })
      await tick(i % 2 ? 7 : 21)
    }
    ev({ type: 'tool_execution_end', toolCallId: 'call-read', result: { content: [{ type: 'text', text: '# README\n内容' }] }, isError: false })
    await tick(2)
    ev({ type: 'tool_execution_end', toolCallId: 'call-write', result: { content: [{ type: 'text', text: 'wrote' }] }, isError: false })
    ev({ type: 'tool_execution_update', toolCallId: 'call-bash', partialResult: { content: [{ type: 'text', text: bashOut + 'tail\n' }] } })
    ev({ type: 'tool_execution_end', toolCallId: 'call-bash', result: { content: [{ type: 'text', text: bashOut + 'tail\n' }] }, isError: false })
    await tick(40)
    ev({ type: 'turn_end' })
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('text_delta', { delta: '三处都看完了。' }))
    ev({ type: 'tool_execution_update', toolCallId: 'call-read', partialResult: { content: [{ type: 'text', text: '# README\n内容\n迟到的输出' }] } })
    await tick(20)
    ev({ type: 'message_end', message: assistantEnd() })
    ev({ type: 'agent_end', messages: [] })
    ev({ type: 'agent_settled' })
    await tick(100)
  },

  async 工具更新密集({ ev, tick }) {
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('toolcall_start', { contentIndex: 0, id: 'call-dense', toolName: 'job_runner' }))
    ev(delta('toolcall_delta', { contentIndex: 0, delta: '{"command":"npm test"}' }))
    ev(delta('toolcall_end', { contentIndex: 0, toolCall: { type: 'toolCall', id: 'call-dense', name: 'job_runner', arguments: { command: 'npm test' } } }))
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'toolUse' }) })
    ev({ type: 'tool_execution_start', toolCallId: 'call-dense', toolName: 'job_runner', args: { command: 'npm test' } })
    let out = ''
    for (let i = 0; i < 200; i += 1) {
      out += `line ${i} ${'.'.repeat(i % 9)}\n`
      const shown = i === 120 ? '[truncated]\n' + out.slice(-200) : out
      if (i === 120) out = shown
      ev({ type: 'tool_execution_update', toolCallId: 'call-dense', partialResult: { content: [{ type: 'text', text: shown }], details: { lines: i } } })
      if (i === 60) ev({ type: 'tool_execution_update', toolCallId: 'call-dense', partialResult: { content: [{ type: 'text', text: out }], details: { lines: i } } })
      await tick(i % 10 === 0 ? 0 : [1, 2, 3, 5, 8][i % 5])
    }
    ev({ type: 'tool_execution_update', toolCallId: 'missing-call', partialResult: { content: [{ type: 'text', text: 'x' }] } })
    await tick(30)
    ev({ type: 'tool_execution_end', toolCallId: 'call-dense', result: { content: [{ type: 'text', text: out + 'done\n' }] }, isError: true })
    await tick(20)
    ev({ type: 'agent_end', messages: [] })
    ev({ type: 'agent_settled' })
    await tick(60)
  },

  async 中途报错({ ev, tick }) {
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('thinking_start'))
    ev(delta('thinking_delta', { delta: '先想想' }))
    await tick(9)
    ev(delta('text_delta', { delta: '写到一半' }), { usage: usage(3) })
    await tick(4)
    ev(delta('text_delta', { delta: '，然后' }))
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'error', errorMessage: '529 overloaded_error: Overloaded', content: [{ type: 'text', text: '写到一半，然后' }] }) })
    await tick(20)
    ev({ type: 'agent_end', messages: [] })
    ev({ type: 'agent_settled' })
    await tick(80)
  },

  async 中止({ ev, tick, ctl }) {
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('text_delta', { delta: '开始跑命令' }))
    ev(delta('toolcall_start', { contentIndex: 1, id: 'call-long', toolName: 'job_runner' }))
    ev(delta('toolcall_delta', { contentIndex: 1, delta: '{"command":"sleep 60"}' }))
    ev(delta('toolcall_end', { contentIndex: 1, toolCall: { type: 'toolCall', id: 'call-long', name: 'job_runner', arguments: { command: 'sleep 60' } } }))
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'toolUse' }) })
    ev({ type: 'tool_execution_start', toolCallId: 'call-long', toolName: 'job_runner', args: { command: 'sleep 60' } })
    ev({ type: 'tool_execution_update', toolCallId: 'call-long', partialResult: { content: [{ type: 'text', text: 'tick 1\n' }] } })
    await tick(5)
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('thinking_start'))
    ev(delta('thinking_delta', { delta: '还在想' }))
    ev(delta('text_delta', { delta: '流到一半被停' }))
    await tick(3)
    ctl.rpc = fakeRpc()
    const stopped = ctl.abortCurrent()
    await tick(1)
    await stopped
    await tick(10)
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'aborted', errorMessage: 'Request aborted' }) })
    ev({ type: 'agent_end', messages: [] })
    ev({ type: 'agent_settled', aborted: true })
    await tick(50)
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('text_delta', { delta: '模型自己中止' }))
    await tick(8)
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'aborted' }) })
    ev({ type: 'agent_end', messages: [] })
    ev({ type: 'agent_settled', aborted: true })
    await tick(50)
    ctl.rpc = null
  },

  async 图片生成进度({ ev, tick, ctl }) {
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('text_delta', { delta: '我来画一张。' }))
    const result = await ctl.runImageCommand({ prompt: '一只猫', provider: 'mock' }).catch((error) => ({ error: String(error?.message ?? error) }))
    await tick(5)
    ev(delta('toolcall_start', { contentIndex: 1, id: 'call-image', toolName: 'job_runner' }))
    ev(delta('toolcall_end', { contentIndex: 1, toolCall: { type: 'toolCall', id: 'call-image', name: 'job_runner', arguments: { command: 'yan image generate --prompt cat' } } }))
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'toolUse' }) })
    ev({ type: 'tool_execution_start', toolCallId: 'call-image', toolName: 'job_runner', args: { command: 'yan image generate --prompt cat' } })
    await tick(3)
    ev({ type: 'tool_execution_update', toolCallId: 'call-image', partialResult: { content: [{ type: 'text', text: '正在生成…\n' }] } })
    await tick(12)
    ev({ type: 'tool_execution_update', toolCallId: 'call-image', partialResult: { content: [{ type: 'text', text: `正在生成…\n完成 ${result?.summary ? 'ok' : 'fail'}\n` }] } })
    ev({ type: 'tool_execution_end', toolCallId: 'call-image', result: { content: [{ type: 'text', text: 'done' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }] }, isError: false })
    await tick(16)
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('text_delta', { delta: '画好了。' }))
    await tick(16)
    ev({ type: 'message_end', message: assistantEnd() })
    ev({ type: 'agent_end', messages: [] })
    ev({ type: 'agent_settled' })
    await tick(40)
  },

  async 用户命令输出({ ev, tick, ctl, realWait }) {
    let finish
    ctl.rpc = fakeRpc({ bash: () => new Promise((resolve) => { finish = resolve }) })
    const running = ctl.runBash('npm run build')
    await tick(1)
    let out = ''
    for (let i = 0; i < 40; i += 1) {
      const chunk = `${'x'.repeat(i * 400)}\n`
      out += chunk
      ev({ type: 'bash_execution_update', delta: chunk })
      await tick([1, 30, 70, 130][i % 4])
    }
    for (let i = 0; !finish && i < 500; i += 1) await realWait(20)
    finish({ success: true, data: { output: out, exitCode: 0 } })
    await tick(1)
    await running
    await tick(200)
    ctl.rpc = null
  },

  async 流式防护({ ev, tick, ctl }) {
    ctl.rpc = fakeRpc({ clear_queue: async () => ({ success: true, data: { steering: [], followUp: [] } }) })
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    const line = '同一句话反复出现在输出里，模型陷入了循环。'
    ev(delta('toolcall_start', { contentIndex: 0, id: 'call-open', toolName: 'read' }))
    for (let i = 0; i < 40; i += 1) {
      ev(delta('text_delta', { contentIndex: 1, delta: line }))
      await tick(i % 3 ? 2 : 11)
    }
    ev(delta('toolcall_end', { contentIndex: 0, toolCall: { type: 'toolCall', id: 'call-open', name: 'read', arguments: { path: 'x' } } }))
    for (let i = 0; i < 40; i += 1) {
      ev(delta('thinking_delta', { contentIndex: 2, delta: line }))
      await tick(i % 4 ? 3 : 17)
    }
    for (let i = 0; i < 60; i += 1) {
      ev(delta('text_delta', { contentIndex: 3, delta: line }))
      await tick(i % 3 ? 1 : 19)
    }
    await tick(30)
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'aborted' }) })
    await tick(30)
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    for (let i = 0; i < 60; i += 1) {
      ev(delta('text_delta', { delta: `${line}${i % 2 ? '' : '……'}` }))
      await tick(i % 5 ? 2 : 23)
    }
    await tick(30)
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'aborted' }) })
    await tick(30)
    ctl.rpc = null
  },

  async 流中关闭({ ev, tick, ctl }) {
    ctl.rpc = fakeRpc()
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('text_delta', { delta: '第一段' }))
    await tick(20)
    ev(delta('text_delta', { delta: '还没刷出去' }))
    ev(delta('toolcall_start', { contentIndex: 1, id: 'call-x', toolName: 'job_runner' }))
    ev(delta('toolcall_end', { contentIndex: 1, toolCall: { type: 'toolCall', id: 'call-x', name: 'job_runner', arguments: {} } }))
    ev({ type: 'tool_execution_start', toolCallId: 'call-x', toolName: 'job_runner', args: {} })
    ev({ type: 'tool_execution_update', toolCallId: 'call-x', partialResult: { content: [{ type: 'text', text: 'pending' }] } })
    ev(delta('text_delta', { contentIndex: 2, delta: '关闭前的尾巴' }))
    const stopping = ctl.stop()
    await tick(1)
    await stopping
    await tick(100)
    ev(delta('text_delta', { delta: '关闭后的事件' }))
    ev({ type: 'tool_execution_update', toolCallId: 'call-x', partialResult: { content: [{ type: 'text', text: 'pending more' }] } })
    await tick(100)
  },

  async 用户消息与续写({ ev, tick }) {
    ev({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '帮我总结' }], timestamp: 1_800_000_000_000 } })
    ev({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '帮我总结' }] } })
    ev({ type: 'agent_start' })
    ev({ type: 'turn_start' })
    await tick(30)
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('toolcall_start', { contentIndex: 0, id: 'call-a', toolName: 'read' }))
    ev(delta('text_delta', { contentIndex: 1, delta: '工具块开着时的文字' }))
    await tick(20)
    ev(delta('toolcall_end', { contentIndex: 0, toolCall: { type: 'toolCall', id: 'call-a', name: 'read', arguments: { path: 'a' } } }))
    ev(delta('text_delta', { contentIndex: 2, delta: '收尾' }))
    await tick(1)
    ev({ type: 'message_end', message: assistantEnd({ stopReason: 'length' }) })
    ev({ type: 'agent_end', willRetry: true, messages: [] })
    ev({ type: 'agent_start' })
    ev({ type: 'message_start', message: { role: 'assistant' } })
    ev(delta('text_delta', { delta: '重试后的内容' }))
    await tick(16)
    ev({ type: 'message_end', message: assistantEnd() })
    ev({ type: 'agent_end', messages: [] })
    ev({ type: 'agent_settled' })
    await tick(40)
  }
}

async function record(AgentController, name, run, tag) {
  const sessionId = `stream-${tag}-${Object.keys(scenarios).indexOf(name)}`
  const normalize = normalizer(sessionId)
  const clock = installClock()
  const log = []
  try {
    const ctl = new AgentController({
      push: (msg) => log.push(`${clock.elapsed()} ${normalize(JSON.stringify(msg))}`),
      cwd: work
    })
    ctl.state = { sessionId, sessionFile: join(root, 'sessions', `${sessionId}.jsonl`), cwd: work, model: { provider: 'fake', id: 'fake-model' } }
    const ev = (event, extra) => ctl.handleEvent(extra ? { ...event, ...extra } : event)
    await run({ ev, tick: (ms) => clock.advance(ms), ctl, realWait: clock.realWait })
    await clock.advance(1000)
    return log
  } finally {
    clock.restore()
  }
}

console.log('\n--- 模块直测：不起 pi、不起 Electron ---')
{
  const outfile = join(outDir, 'module.mjs')
  const result = await build({
    stdin: {
      contents: `export * from './src/main/stream-projection'\nexport { SessionItemProjector } from './src/main/session-items/projector'`,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    metafile: true,
    logLevel: 'silent'
  })
  const inputs = Object.keys(result.metafile.inputs)
  ok(!inputs.some((path) => /electron|agent\.ts|protocol\.ts/.test(path)), '模块依赖链不含 electron、agent.ts 与 pi 协议', inputs.filter((path) => /electron|agent|protocol/.test(path)).join(', '))
  const mod = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
  const { StreamProjection, SessionItemProjector, FLUSH_MS, MAX_FLUSH_MS, HTML_ARGS_PUSH_MS } = mod

  const harness = (options = {}) => {
    let now = 1000
    const timers = []
    const pushes = []
    const deltas = []
    const items = new SessionItemProjector()
    let backlog = options.backlog ?? 0
    const clock = {
      now: () => now,
      mono: () => now + 0.5,
      setTimer: (run, ms) => { const timer = { run, at: now + ms, ms }; timers.push(timer); return timer },
      clearTimer: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1) }
    }
    const projection = new StreamProjection({
      items,
      push: (message) => pushes.push({ at: now, message: JSON.parse(JSON.stringify(message)) }),
      clock,
      modelId: () => 'm',
      turnStartedAt: () => 900,
      idleBacklog: () => backlog,
      checkDelta: (kind, delta) => deltas.push(`${kind}:${delta}:${pushes.length}`)
    })
    const advance = (ms) => {
      const target = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > target) break
        timers.shift()
        now = next.at
        next.run()
      }
      now = target
    }
    const start = () => {
      const started = items.liveMessageStart({ role: 'assistant' }, now)
      projection.streaming = { id: started.id, responseDetail: 'unknown', startedAt: now, generationStartedMono: now, pushedText: 0, pushedThinking: 0 }
      return started.id
    }
    const update = (type, extra = {}) => projection.messageUpdate({ type: 'message_update', assistantMessageEvent: { type, ...extra } })
    return { projection, items, pushes, deltas, timers, advance, start, update, setBacklog: (n) => { backlog = n } }
  }

  {
    const h = harness()
    const id = h.start()
    h.update('text_delta', { delta: 'a' })
    h.update('text_delta', { delta: 'b' })
    ok(h.timers.length === 1 && h.timers[0].ms === FLUSH_MS, `流式中连续增量只挂一个 ${FLUSH_MS}ms 定时器`)
    ok(h.pushes.length === 0, '定时器到点前不推送')
    ok(h.deltas.join('|') === 'text:a:0|text:b:0', '每个增量先交流式防护检查', h.deltas.join('|'))
    h.advance(FLUSH_MS)
    ok(h.pushes.length === 1 && h.pushes[0].message.payload.id === id && h.pushes[0].message.payload.patch.textDelta === 'ab', '到点合并成一条 textDelta', JSON.stringify(h.pushes))
    h.update('thinking_start')
    h.update('thinking_delta', { delta: '想' })
    h.advance(FLUSH_MS)
    const patch = h.pushes.at(-1).message.payload.patch
    ok(patch.thinkingDelta === '想' && patch.thinkingLive === true && patch.textDelta === undefined, '思考增量独立推送且带实时标记', JSON.stringify(patch))
  }

  {
    const h = harness()
    h.start()
    h.update('text_delta', { delta: '先说一句' })
    h.update('toolcall_start', { contentIndex: 1, id: 'c1', toolName: 'read' })
    ok(h.pushes.map((p) => p.message.ch).join(',') === 'msg-update,tool', '工具块开始时先刷出文字再推工具', JSON.stringify(h.pushes.map((p) => p.message.ch)))
    ok(h.projection.streaming.toolOpen === true, '工具块打开标记写在流式状态上')
    h.advance(100)
    ok(h.pushes.length === 2, '已刷出的内容定时器到点不重复推送')
  }

  {
    const h = harness()
    h.start()
    h.update('toolcall_start', { contentIndex: 0, id: 'w1', toolName: 'write' })
    const before = h.pushes.length
    h.update('toolcall_delta', { contentIndex: 0, delta: '{"path":"a.html","content":"' })
    h.advance(HTML_ARGS_PUSH_MS - 1)
    h.update('toolcall_delta', { contentIndex: 0, delta: '<p>' })
    h.advance(1)
    h.update('toolcall_delta', { contentIndex: 0, delta: 'x' })
    ok(h.pushes.length - before === 2, `HTML 写入参数按 ${HTML_ARGS_PUSH_MS}ms 节流推送`, String(h.pushes.length - before))
  }

  {
    const h = harness()
    const id = h.start()
    const started = h.items.liveToolStart({ toolCallId: 't1', toolName: 'job', args: { a: 1 } }, 1000)
    h.projection.pushTool(started.call)
    h.items.liveToolUpdate('t1', { content: [{ type: 'text', text: 'one\n' }] })
    h.projection.markToolOutput('t1')
    h.items.liveToolUpdate('t1', { content: [{ type: 'text', text: 'one\ntwo\n' }] })
    h.projection.markToolOutput('t1')
    h.advance(FLUSH_MS)
    let last = h.pushes.at(-1).message.payload
    ok(last.msgId === id && last.outputDelta === 'one\ntwo\n' && last.call.output === undefined && last.sameArgs === undefined, '工具输出合并成一条增量，首次带参数', JSON.stringify(last))
    h.items.liveToolUpdate('t1', { content: [{ type: 'text', text: 'one\ntwo\nthree\n' }] })
    h.projection.markToolOutput('t1')
    h.advance(FLUSH_MS)
    last = h.pushes.at(-1).message.payload
    ok(last.outputDelta === 'three\n' && last.sameArgs === true && !('args' in last.call), '参数未变时只发增量并标记 sameArgs', JSON.stringify(last))
    const count = h.pushes.length
    h.items.liveToolUpdate('t1', { content: [{ type: 'text', text: 'one\ntwo\nthree\n' }] })
    h.projection.markToolOutput('t1')
    h.advance(FLUSH_MS)
    ok(h.pushes.length === count, '输出没变不推送')
    h.items.liveToolUpdate('t1', { content: [{ type: 'text', text: '[截断]\nthree\n' }] })
    h.projection.markToolOutput('t1')
    h.advance(FLUSH_MS)
    last = h.pushes.at(-1).message.payload
    ok(last.outputDelta === undefined && last.call.output === '[截断]\nthree\n', '输出被改写时整条替换', JSON.stringify(last))
    h.projection.forgetPushed()
    h.items.liveToolUpdate('t1', { content: [{ type: 'text', text: '[截断]\nthree\nfour\n' }] })
    h.projection.markToolOutput('t1')
    h.advance(FLUSH_MS)
    last = h.pushes.at(-1).message.payload
    ok(last.outputDelta === '[截断]\nthree\nfour\n' && last.sameArgs === undefined, '忘掉已推记录后从头补发并带参数', JSON.stringify(last))
  }

  {
    const h = harness({ backlog: 0 })
    h.items.appendMessage({ id: 'bash-1', role: 'bash', text: 'x', toolCalls: [{ id: 'bash-1', name: 'bash', status: 'running', output: '' }] })
    h.projection.markToolOutput('bash-1')
    ok(h.timers[0].ms === FLUSH_MS, '空闲且积压少时按最短间隔刷新', String(h.timers[0].ms))
    h.advance(FLUSH_MS)
    h.setBacklog(100_000)
    h.projection.markToolOutput('bash-1')
    ok(h.timers[0].ms === 50, '积压 10 万字时间隔拉长到 50ms', String(h.timers[0].ms))
    h.advance(50)
    h.setBacklog(5_000_000)
    h.projection.markToolOutput('bash-1')
    ok(h.timers[0].ms === MAX_FLUSH_MS, `间隔封顶 ${MAX_FLUSH_MS}ms`, String(h.timers[0].ms))
    h.projection.reset()
    ok(h.timers.length === 0, 'reset 取消待发的合并刷新')
  }

  {
    const h = harness()
    h.start()
    h.update('text_delta', { delta: 'x' })
    const s = h.projection.finishMessage()
    ok(s && h.projection.streaming === null, 'finishMessage 交出并清空流式状态')
    h.advance(FLUSH_MS)
    ok(h.pushes.length === 0, '消息结束后到点的定时器不再推流式帧')
    h.projection.messageUpdate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'y' } })
    ok(h.timers.length === 0 && h.pushes.length === 0, '没有流式消息时忽略 message_update')
  }
}

console.log('\n--- 录放对拍：改前冻结副本 vs 当前 agent.ts（假时钟，比较推送内容与相对时间）---')
const after = await bundle('agent-after', `export { AgentController } from './agent'`, join(process.cwd(), 'src', 'main'))
const goldenFile = join('scripts', 'fixtures', 'agent-stream-golden.json')
let before
if (existsSync(frozenSource)) {
  before = await bundle('agent-before', await readFile(frozenSource, 'utf8'), join(process.cwd(), 'src', 'main'))
}
const recording = process.argv.includes('--record')
const golden = !recording && existsSync(goldenFile) ? JSON.parse(await readFile(goldenFile, 'utf8')) : null
const recorded = {}
const recordedBefore = {}
for (const [name, run] of Object.entries(scenarios)) {
  const next = await record(after.AgentController, name, run, 'after')
  recorded[name] = next
  ok(next.length > 3, `${name}：录到 ${next.length} 条推送`)
  if (before) {
    const prev = await record(before.AgentController, name, run, 'before')
    recordedBefore[name] = prev
    const at = prev.findIndex((line, i) => line !== next[i])
    ok(prev.length === next.length && at === -1, `${name}：与改前实现逐条一致`, at === -1 ? `条数 ${prev.length} vs ${next.length}` : `第 ${at} 条\n改前 ${prev[at]}\n改后 ${next[at]}`)
  }
  if (golden?.[name]) {
    const hashed = digest(next)
    const at = golden[name].findIndex((line, i) => line !== hashed[i])
    ok(golden[name].length === next.length && at === -1, `${name}：与录制基线一致`, at === -1 ? `条数 ${golden[name].length} vs ${next.length}` : `第 ${at} 条（时间 摘要）\n基线 ${golden[name][at]}\n改后 ${hashed[at]}\n改后原文 ${next[at]}`)
  }
}
ok(recording || !!before || !!golden, '至少有改前副本或录制基线可对拍')

if (recording) {
  const { writeFile } = await import('node:fs/promises')
  const source = before ? recordedBefore : recorded
  const baseline = Object.fromEntries(Object.entries(source).map(([name, lines]) => [name, digest(lines)]))
  await writeFile(goldenFile, `${JSON.stringify(baseline, null, 1)}\n`)
  console.log(`已按${before ? '改前冻结副本' : '当前实现'}写 ${goldenFile}`)
}

if (process.argv.includes('--dump')) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(outDir, 'recorded.json'), JSON.stringify(recorded, null, 1))
  console.log(`已写 ${join(outDir, 'recorded.json')}`)
}

await rm(root, { recursive: true, force: true }).catch(() => undefined)
console.log(`\n${checks}/${checks} 通过`)
