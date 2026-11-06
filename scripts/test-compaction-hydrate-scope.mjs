#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-hydrate-scope-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_ATTACHMENTS_DIR = join(root, 'attachments')

const outfile = join(process.cwd(), 'out', 'test', 'compaction-hydrate-scope.mjs')
await mkdir(dirname(outfile), { recursive: true })
await build({
  stdin: { contents: "export { AgentController } from './src/main/agent'", resolveDir: process.cwd(), loader: 'ts' },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{
    name: 'hydrate-scope-electron-boundary',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'hydrate-electron' }))
      builder.onLoad({ filter: /.*/, namespace: 'hydrate-electron' }, () => ({
        loader: 'js',
        contents: `
          export class BrowserWindow {}
          export const session = { fromPartition() {} }
          export const app = { getLocale: () => 'zh-CN', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0.0.0', isPackaged: false }
          export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }
          export const safeStorage = { isEncryptionAvailable: () => false }
        `
      }))
    }
  }],
  logLevel: 'silent'
})
const { AgentController } = await import(pathToFileURL(outfile).href)

const history = (text) => ({ messages: [{ id: 'history:1', role: 'user', text, createdAt: 1 }], contextFrom: undefined })

function controller({ pushed, reportedSession, onRead }) {
  const ctl = new AgentController({ push: (event) => pushed.push(event), cwd: process.cwd() })
  ctl.state = { sessionId: 'a', sessionFile: join(root, 'a.jsonl'), cwd: process.cwd(), isStreaming: false, isCompacting: false }
  ctl.messages = [{ id: 'history:0', role: 'user', text: 'a 的旧内容', createdAt: 0 }]
  ctl.rpc = {
    running: true,
    command: async (type) => {
      if (type === 'get_state') return { success: true, data: { sessionId: reportedSession, sessionFile: join(root, `${reportedSession}.jsonl`), cwd: process.cwd() } }
      return { success: false }
    }
  }
  ctl.readHistoryOf = async () => {
    await onRead?.(ctl)
    return history('压缩后的内容')
  }
  ctl.reclaimSavedQueue = async () => {}
  ctl.refreshTodos = async () => {}
  ctl.maybeGenerateTitle = async () => {}
  return ctl
}

const syncs = (pushed) => pushed.filter((event) => event.ch === 'sync' || event.ch === 'sync-delta')
let checks = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
  console.log(`✓ ${message}`)
}

{
  const pushed = []
  const ctl = controller({ pushed, reportedSession: 'a' })
  await ctl.hydrate({ sessionId: 'a', sessionFile: join(root, 'a.jsonl') })
  check(ctl.messages[0]?.text === '压缩后的内容', '会话没变：压缩后的历史照常回填')
  check(syncs(pushed).length > 0, '会话没变：推送同步')
}

{
  const pushed = []
  const ctl = controller({ pushed, reportedSession: 'b' })
  await ctl.hydrate({ sessionId: 'a', sessionFile: join(root, 'a.jsonl') })
  check(ctl.messages[0]?.text === 'a 的旧内容', 'pi 已经切到别的会话：不回填、不覆盖当前消息')
  check(ctl.state.sessionId === 'a' && syncs(pushed).length === 0, '切会话时不改状态、不推送同步')
}

{
  const pushed = []
  const ctl = controller({
    pushed,
    reportedSession: 'a',
    onRead: (c) => {
      c.state = { ...c.state, sessionId: 'c', sessionFile: join(root, 'c.jsonl') }
      c.messages = [{ id: 'history:9', role: 'user', text: 'c 的内容', createdAt: 9 }]
    }
  })
  await ctl.hydrate({ sessionId: 'a', sessionFile: join(root, 'a.jsonl') })
  check(ctl.messages[0]?.text === 'c 的内容', '读历史期间切到别的会话：旧会话的历史不写回')
  check(syncs(pushed).length === 0, '读历史期间切会话：不推送旧会话的同步')
}

await rm(root, { recursive: true, force: true })
console.log(`\n压缩后回填归属：${checks} 项通过`)
