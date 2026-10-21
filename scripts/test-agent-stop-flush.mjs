#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-agent-stop-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_ATTACHMENTS_DIR = join(root, 'attachments')

let checks = 0
const check = (condition, message, extra) => {
  assert.ok(condition, extra === undefined ? message : `${message}（${extra}）`)
  checks += 1
  console.log(`✓ ${message}`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const outfile = join(process.cwd(), 'out', 'test', 'agent-stop-flush.mjs')
await mkdir(dirname(outfile), { recursive: true })
await build({
  stdin: {
    contents: `
      export { AgentController } from './src/main/agent'
      export { buildSubagentNotice } from './src/shared/subagent-notice'
      export { QUEUE_RECOVERY_DIR, saveQueue } from './src/main/queue-persistence'
    `,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [
    {
      name: 'agent-stop-electron-boundary',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stop-electron' }))
        builder.onLoad({ filter: /.*/, namespace: 'stop-electron' }, () => ({
          contents: `
            export class BrowserWindow { constructor() { throw new Error('Native browser requires an Electron integration test') } }
            export const session = { fromPartition() { throw new Error('Native session requires an Electron integration test') } }
            export const app = { getLocale: () => 'en-US', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0.0.0', isPackaged: false }
            export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }
            export const safeStorage = { isEncryptionAvailable: () => false }
          `,
          loader: 'js'
        }))
      }
    }
  ],
  logLevel: 'silent'
})

const { AgentController, buildSubagentNotice, QUEUE_RECOVERY_DIR } = await import(pathToFileURL(outfile).href)

function controller() {
  const pushes = []
  const ctl = new AgentController({ push: (msg) => pushes.push(msg), cwd: process.cwd() })
  ctl.state = { sessionId: 'session-flush', sessionFile: join(root, 'sessions', 'flush.jsonl'), cwd: process.cwd() }
  return { ctl, pushes }
}

function fakeRpc({ reply = true, onCommand } = {}) {
  const calls = []
  const rpc = {
    running: true,
    command: async (type, _payload, opts) => {
      calls.push(type)
      onCommand?.(type)
      if (!reply) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`${type} 未回执`)), opts?.timeoutMs ?? 60_000)
        })
      }
      return { success: true, data: {} }
    },
    close: async () => {
      calls.push('close')
    }
  }
  return { rpc, calls }
}

const queueFile = join(QUEUE_RECOVERY_DIR, 'session-flush.json')

console.log('\n--- 1. 退出前先等 pi 写完：abort → close ---')
{
  const { ctl } = controller()
  const { rpc, calls } = fakeRpc()
  ctl.rpc = rpc
  ctl.agentRunning = true
  ctl.turn.terminal = 'completed'
  await ctl.stop()
  check(calls[0] === 'abort', '在跑的回合退出时先发 abort', JSON.stringify(calls))
  check(calls.at(-1) === 'close', 'abort 回执后才关闭 rpc', JSON.stringify(calls))
  check(ctl.turn.terminal === 'stopped', '被退出中断的回合记成 stopped，不是 completed', ctl.turn.terminal)
}

console.log('\n--- 2. 有 bash 时才补 abort_bash ---')
{
  const { ctl } = controller()
  const { rpc, calls } = fakeRpc()
  ctl.rpc = rpc
  ctl.bash = { reqId: 'bash-1', msgId: 'bash-1', command: 'sleep 30', output: '' }
  await ctl.stop()
  check(calls.includes('abort') && calls.includes('abort_bash'), '跑着命令时 abort 后再 abort_bash', JSON.stringify(calls))
  check(calls.indexOf('abort') < calls.indexOf('abort_bash'), 'abort 先于 abort_bash', JSON.stringify(calls))
}

console.log('\n--- 3. 空闲退出不发 abort，退出不额外变慢 ---')
{
  const { ctl } = controller()
  const { rpc, calls } = fakeRpc()
  ctl.rpc = rpc
  const startedAt = Date.now()
  await ctl.stop()
  check(!calls.includes('abort'), '空闲时退出不发 abort', JSON.stringify(calls))
  check(Date.now() - startedAt < 1000, '空闲退出即刻返回', `${Date.now() - startedAt}ms`)
}

console.log('\n--- 4. abort 不回执也不会卡住退出 ---')
{
  const { ctl } = controller()
  const { rpc, calls } = fakeRpc({ reply: false })
  ctl.rpc = rpc
  ctl.agentRunning = true
  const startedAt = Date.now()
  await ctl.stop()
  const elapsed = Date.now() - startedAt
  check(calls.includes('abort') && calls.at(-1) === 'close', 'abort 超时后仍然关闭 rpc', JSON.stringify(calls))
  check(elapsed < 8_000, 'abort 有上限，退出最坏在秒级', `${elapsed}ms`)
}

console.log('\n--- 5. 排队消息随退出落盘 ---')
{
  const { ctl } = controller()
  ctl.publishQueue(['补充要求：先跑类型检查'], ['再说下一步'])
  await ctl.queueWrite
  check(existsSync(queueFile), '队列变化即落盘（不依赖退出钩子）')
  const saved = JSON.parse(await readFile(queueFile, 'utf8'))
  check(saved.version === 1 && saved.sessionId === 'session-flush', '落盘记录带版本与会话 id', JSON.stringify(saved))
  check(saved.steering.length === 1 && saved.followUp.length === 1, '插话与排队分别保存', JSON.stringify(saved))

  const { rpc } = fakeRpc()
  ctl.rpc = rpc
  await ctl.stop()
  const afterStop = JSON.parse(await readFile(queueFile, 'utf8'))
  check(afterStop.steering[0] === '补充要求：先跑类型检查', '正常退出后队列文件仍在（stop 先写后清内存）', afterStop.steering[0])
}

console.log('\n--- 6. 重启后回填到输入框并清掉文件 ---')
{
  const { ctl, pushes } = controller()
  await ctl.reclaimSavedQueue()
  const reclaimed = pushes.filter((msg) => msg.ch === 'queue-reclaimed')
  check(reclaimed.length === 1, '启动后推一条 queue-reclaimed', String(reclaimed.length))
  check(reclaimed[0]?.payload.sessionId === 'session-flush', '恢复推送带会话 id')
  check(reclaimed[0]?.payload.steering[0] === '补充要求：先跑类型检查', '插话内容回填', JSON.stringify(reclaimed[0]?.payload))
  check(reclaimed[0]?.payload.followUp[0] === '再说下一步', '排队内容回填')
  check(!existsSync(queueFile), '回填后删除恢复文件，不会重复提示')

  await ctl.reclaimSavedQueue()
  check(pushes.filter((msg) => msg.ch === 'queue-reclaimed').length === 1, '再调一次不会重复回填')
}

console.log('\n--- 7. 队列为空时清掉恢复文件 ---')
{
  const { ctl } = controller()
  ctl.publishQueue(['临时一条'], [])
  await ctl.queueWrite
  check(existsSync(queueFile), '先有队列文件')
  ctl.publishQueue([], [])
  await ctl.queueWrite
  check(!existsSync(queueFile), '队列清空后恢复文件被删除')
  const names = await readdir(QUEUE_RECOVERY_DIR).catch(() => [])
  check(!names.some((name) => name.includes('session-flush')), '恢复目录不留残留文件', JSON.stringify(names))
}

console.log('\n--- 8. 子代理完成通知不进恢复队列 ---')
{
  const { ctl } = controller()
  const notice = buildSubagentNotice({
    id: 'sub-1',
    task: '检查登录流程',
    status: 'done',
    isolation: 'controlled-cwd',
    model: 'gpt-x',
    result: { summary: '完成' }
  })
  ctl.publishQueue([notice], [])
  await ctl.queueWrite
  check(!existsSync(queueFile), '内部通知不落盘（重启后不该回填成用户输入）')
}

console.log('\n--- 9. 强杀后重启：只回填最新一次队列快照 ---')
{
  const { ctl } = controller()
  ctl.publishQueue(['第一条'], [])
  await ctl.queueWrite
  ctl.publishQueue(['第一条', '第二条'], [])
  await ctl.queueWrite

  const { ctl: restarted, pushes } = controller()
  await restarted.reclaimSavedQueue()
  const payload = pushes.find((msg) => msg.ch === 'queue-reclaimed')?.payload
  check(payload?.steering.length === 2, '回填的是最近一次快照（两条）', JSON.stringify(payload))
}

console.log('\n--- 10. 强杀（无退出钩子）也能留住最近的排队 ---')
{
  const child = join(root, 'kill-writer.mjs')
  const marker = join(root, 'exit-handler-ran.txt')
  await writeFile(
    child,
    [
      "const { saveQueue } = await import(process.argv[2])",
      "const { writeFileSync } = await import('node:fs')",
      "await saveQueue({ sessionId: 'session-killed', steering: ['强杀前排队的插话'], followUp: [] })",
      "process.on('exit', () => writeFileSync(process.argv[3], 'exit-handler-ran'))",
      "process.kill(process.pid, 'SIGKILL')"
    ].join('\n')
  )
  const killed = spawnSync(process.execPath, [child, pathToFileURL(outfile).href, marker], { env: process.env })
  check(killed.status !== 0, '子进程未正常结束（被强杀）', `status=${killed.status} signal=${killed.signal}`)
  check(!existsSync(marker), '强杀时退出钩子没有执行（不依赖退出钩子也能落盘）')

  const { ctl, pushes } = controller()
  ctl.state = { sessionId: 'session-killed', sessionFile: join(root, 'sessions', 'killed.jsonl'), cwd: process.cwd() }
  await ctl.reclaimSavedQueue()
  const payload = pushes.find((msg) => msg.ch === 'queue-reclaimed')?.payload
  check(payload?.steering[0] === '强杀前排队的插话', '强杀后重启仍能回填排队内容', JSON.stringify(payload))
}

console.log(`\n退出落盘与排队恢复：${checks} 项通过`)
