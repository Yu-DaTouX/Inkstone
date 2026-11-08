import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoBackgroundOperations, backgroundFinishedNotice, backgroundSeconds } from '../resources/pi-extensions/shell-background.js'
import { readFile as readText } from 'node:fs/promises'
import { transform } from 'esbuild'

const noticeSource = await transform(await readText(new URL('../src/shared/host-notice-text.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' })
const { parseHostTextNotice } = await import(`data:text/javascript;base64,${Buffer.from(noticeSource.code).toString('base64')}`)

assert.equal(backgroundSeconds({}), 120)
assert.equal(backgroundSeconds({ YAN_BASH_BACKGROUND_SECONDS: '0' }), 0)
assert.equal(backgroundSeconds({ YAN_BASH_BACKGROUND_SECONDS: '5' }), 5)
assert.equal(backgroundSeconds({ YAN_BASH_BACKGROUND_SECONDS: 'x' }), 120)

const dir = await mkdtemp(join(tmpdir(), 'yan-bg-test-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fakeBase = (run) => ({ exec: async (command, cwd, options) => run(command, cwd, options) })
const chunks = (list) => list.map((chunk) => chunk.toString()).join('')

try {
  const baseOps = fakeBase(async (command, _cwd, options) => {
    options.onData(Buffer.from('start\n'))
    await sleep(command === 'fast' ? 20 : 400)
    options.onData(Buffer.from('end\n'))
    return { exitCode: command === 'fail' ? 3 : 0 }
  })
  const notices = []
  const ops = autoBackgroundOperations(baseOps, { seconds: 0.15, notify: (text) => notices.push(text), dir })

  const out = []
  const fast = await ops.exec('fast', dir, { onData: (c) => out.push(c) })
  assert.equal(fast.exitCode, 0)
  assert.equal(chunks(out), 'start\nend\n')
  await sleep(250)
  assert.equal(notices.length, 0, '前台跑完的命令不通知')

  const slowOut = []
  const slow = await ops.exec('slow', dir, { onData: (c) => slowOut.push(c) })
  assert.equal(slow.exitCode, 0)
  const text = chunks(slowOut)
  assert.ok(text.startsWith('start\n') && text.includes('已转入后台') && !text.includes('end\n'), '转后台时先返回已有输出与说明')
  assert.equal(notices.length, 0, '返回时还没结束，不通知')
  await sleep(500)
  assert.equal(notices.length, 1, '后台结束后通知一次')
  assert.ok(notices[0].includes('end\n') && notices[0].includes('退出码 0'))
  const parsed = parseHostTextNotice(notices[0])
  assert.deepEqual(parsed, { kind: 'terminal', command: 'slow', state: 'completed' }, '通知能被界面识别为后台终端命令')
  const logFile = /完整输出：(.+)$/m.exec(notices[0])[1]
  assert.equal(await readFile(logFile, 'utf8'), 'start\n' + 'end\n', '日志文件含转后台前后的全部输出')
  assert.ok(text.includes(logFile))

  notices.length = 0
  await ops.exec('fail', dir, { onData: () => {} })
  await sleep(600)
  assert.ok(notices[0].includes('退出码 3'), '非零退出码写进通知')

  const withTimeout = await ops.exec('slow', dir, { timeout: 5, onData: () => {} })
  assert.equal(withTimeout.exitCode, 0)
  assert.equal(notices.length, 1, '带 timeout 的调用保持原行为，不转后台')

  const controller = new AbortController()
  const aborted = ops.exec('slow', dir, { signal: controller.signal, onData: () => {} })
  const abortedBase = autoBackgroundOperations(fakeBase(async (_c, _d, options) => {
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  }), { seconds: 5, notify: () => {}, dir })
  const abortCtl = new AbortController()
  const pending = abortedBase.exec('x', dir, { signal: abortCtl.signal, onData: () => {} })
  abortCtl.abort()
  await assert.rejects(pending, /aborted/, '前台阶段中止会传给底层命令')
  await aborted

  assert.equal(autoBackgroundOperations(baseOps, { seconds: 0, notify: () => {} }), baseOps, '关闭时原样返回')

  const fence = backgroundFinishedNotice({ command: 'c', seconds: 1, exitCode: 0, tail: 'a```b', logFile: 'f' })
  assert.ok(fence.includes('````'), '输出里有围栏时加长围栏')
  console.log('shell-background: ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
