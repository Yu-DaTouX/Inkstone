import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const checks = []
function ok(value, label) {
  assert.ok(value, label)
  checks.push(label)
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label)
  checks.push(label)
}

const EXITED_LIMIT = (400 * 1024) / 8
const children = []
let spawnFailure = null

globalThis.__terminalFakePty = {
  spawn(shell, args, options) {
    if (spawnFailure) {
      const error = spawnFailure
      spawnFailure = null
      throw error
    }
    const child = {
      shell,
      args,
      options,
      dataHandlers: [],
      exitHandlers: [],
      written: [],
      killed: 0,
      resized: [],
      onData(handler) {
        this.dataHandlers.push(handler)
      },
      onExit(handler) {
        this.exitHandlers.push(handler)
      },
      write(data) {
        this.written.push(data)
      },
      resize(cols, rows) {
        this.resized.push([cols, rows])
      },
      kill() {
        this.killed += 1
      },
      emitData(data) {
        for (const handler of this.dataHandlers) handler(data)
      },
      emitExit(exitCode) {
        for (const handler of this.exitHandlers) handler({ exitCode })
      }
    }
    children.push(child)
    return child
  }
}

function start(mod, options, label) {
  const snapshot = mod.startTerminal(options)
  ok(snapshot && snapshot.alive, label)
  return snapshot
}

function rejected(mod, options, label) {
  const before = children.length
  eq(mod.startTerminal(options), null, label)
  eq(children.length, before, `${label}（未拉起 PTY）`)
}

const dir = await mkdtemp(join(tmpdir(), 'inkstone-terminal-sessions-'))
try {
  const outfile = join(dir, 'terminal.cjs')
  await build({
    entryPoints: ['src/main/terminal.ts'],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'fake-pty-loader',
        setup(builder) {
          builder.onResolve({ filter: /^node:module$/ }, () => ({ path: 'fake-pty-loader', namespace: 'fixture' }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export const createRequire = () => () => globalThis.__terminalFakePty',
            loader: 'js'
          }))
        }
      }
    ]
  })
  const mod = createRequire(import.meta.url)(outfile)

  ok(mod.terminalAvailable(), '假 PTY 模块可用')
  eq(mod.terminalLoadError(), null, '加载成功时 terminalLoadError 为 null')

  spawnFailure = new Error('temporary shell failure')
  rejected(mod, { cwd: process.cwd() }, '壳启动失败返回 null')
  eq(mod.terminalLoadError(), null, '壳启动失败不写进 terminalLoadError（A8-15）')
  mod.disposeTerminals()

  for (let i = 0; i < 12; i += 1) start(mod, { owner: 'cap-owner' }, `同 owner 第 ${i + 1} 个终端可建`)
  rejected(mod, { owner: 'cap-owner' }, '同 owner 第 13 个终端被拒绝')
  eq(mod.terminalLoadError(), null, '达 owner 上限后 terminalLoadError 仍为 null（A8-15）')
  eq(mod.listTerminals().length, 12, '达上限后仍只有 12 个终端')
  mod.disposeTerminals()

  for (let i = 0; i < 24; i += 1) start(mod, {}, `无 owner 第 ${i + 1} 个终端可建`)
  rejected(mod, {}, '无 owner 第 25 个终端被拒绝（A8-16）')
  eq(mod.listTerminals().length, 24, '无 owner 上限为 24（A8-16）')
  mod.disposeTerminals()

  {
    const started = start(mod, { owner: 'exit-owner' }, '退出测试终端可建')
    const child = children.at(-1)
    const payload = 'x'.repeat(120 * 1024)
    child.emitData(payload)
    eq(mod.readTerminal(started.id).buffer.length, payload.length, '退出前回放缓冲保留全部输出')
    child.emitExit(3)
    const after = mod.readTerminal(started.id)
    ok(after.buffer.length <= EXITED_LIMIT, '退出后回放缓冲截到 1/8 上限（A8-16）')
    ok(after.buffer.endsWith('x'.repeat(1000)), '退出后保留尾部输出')
    eq(after.alive, false, '退出后 alive 为 false')
    eq(after.exitCode, 3, '退出码保留')
    eq(mod.attachTerminal(started.id)?.buffer.length, after.buffer.length, '重新 attach 拿到截短后的缓冲')
    mod.disposeTerminals()
  }

  {
    const first = start(mod, { owner: 'D:\\work\\Session-A' }, '路径 owner 终端可建')
    const second = start(mod, { owner: 'd:/work/session-a' }, '同路径不同大小写与分隔符视为同 owner')
    start(mod, { owner: 'Other' }, '其他 owner 终端可建')
    ok(mod.writeTerminal(first.id, 'ls'), '按 owner 关闭前仍可写入')
    eq(mod.writeTerminal(second.id, 'pwd'), true, '同 owner 第二个终端可写入')
    eq(mod.closeTerminalsForOwner('d:/WORK/session-a'), 2, '按 owner 关闭（大小写与分隔符归一，V1-S）')
    eq(mod.listTerminals().map((terminal) => terminal.owner), ['Other'], '只关闭匹配 owner 的终端')
    eq(children.at(-1).killed, 0, '不误 kill 其他 owner 的 PTY')
    eq(mod.closeTerminalsForOwner(''), 0, '空 owner 不关闭任何终端')
    eq(mod.closeTerminalsForOwner('nobody'), 0, '没有匹配 owner 时返回 0')
    eq(mod.killTerminal(first.id), false, '已关闭的终端不再可 kill')
    mod.disposeTerminals()
  }

  eq(children.every((child) => child.killed > 0), true, 'dispose 关闭所有 PTY')

  console.log(`test-terminal-sessions: ${checks.length} 项断言通过`)
} finally {
  delete globalThis.__terminalFakePty
  await rm(dir, { recursive: true, force: true })
}
