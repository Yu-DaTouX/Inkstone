import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoBackgroundOperations, backgroundFinishedNotice, backgroundSeconds, createHostChannel } from '../resources/pi-extensions/shell-background.js'
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
const ok = (condition, label) => assert.ok(condition, label)

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

  notices.length = 0
  let seenTimeout
  const timeoutOps = autoBackgroundOperations(fakeBase(async (_c, _d, options) => {
    seenTimeout = options.timeout
    options.onData(Buffer.from('start\n'))
    await sleep(400)
    return { exitCode: 0 }
  }), { seconds: 0.15, notify: (text) => notices.push(text), dir })
  const withTimeout = await timeoutOps.exec('slow', dir, { timeout: 5, onData: () => {} })
  assert.equal(withTimeout.exitCode, 0)
  assert.equal(seenTimeout, 5, '带 timeout 的调用把超时原样交给底层命令')
  assert.equal(notices.length, 0, '带 timeout 的调用返回时还没结束，不通知')
  await sleep(500)
  assert.equal(notices.length, 1, '带 timeout 的调用同样转后台，结束后通知')

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
  const makeHost = (script) => {
    const calls = { watch: [], end: [] }
    return {
      calls,
      watch: async (info, signal) => {
        calls.watch.push(info)
        return script.watch(info, signal, calls.watch.length)
      },
      end: async (info) => {
        calls.end.push(info)
        return script.end ? script.end(info) : false
      }
    }
  }
  const abortable = (signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('watch aborted')), { once: true }))
  const longBase = () => fakeBase(async (_command, _cwd, options) => {
    options.onData(Buffer.from('start\n'))
    if (options.signal.aborted) throw new Error('aborted')
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    return { exitCode: 0 }
  })

  {
    const notified = []
    let release
    const stopNow = new Promise((resolve) => {
      release = resolve
    })
    const host = makeHost({ watch: async (_info, signal, n) => (n === 1 ? false : (await stopNow, true)), end: () => true })
    const stoppable = autoBackgroundOperations(longBase(), { seconds: 0.05, notify: (text) => notified.push(text), dir, host, retryMs: 1 })
    await stoppable.exec('npm run dev', dir, { onData: () => {} })
    await sleep(30)
    ok(host.calls.watch.length === 2 && host.calls.watch[0].command === 'npm run dev' && /^[0-9a-f]{16}$/.test(host.calls.watch[0].id), '转后台后向宿主登记并持续监视，命令与编号带上')
    ok(host.calls.watch[0].id === host.calls.watch[1].id && host.calls.watch[0].logFile.startsWith(dir), '续订监视沿用同一个编号并附上日志路径')
    release()
    await sleep(60)
    ok(host.calls.end.length === 1, '宿主要求停止后命令被结束并回报宿主')
    ok(host.calls.end[0].notice.includes('状态：stopped') && host.calls.end[0].notice.includes('用户停止了这条命令'), '回报给宿主的通知标明用户已停止')
    ok(parseHostTextNotice(host.calls.end[0].notice)?.state === 'stopped', '通知能被界面识别为已停止')
    ok(notified.length === 0, '用户停掉的命令扩展自己不发通知，不叫醒模型')
  }

  {
    const notified = []
    let finish
    const base = fakeBase(async (_c, _d, options) => {
      options.onData(Buffer.from('start\n'))
      await new Promise((resolve) => {
        finish = resolve
      })
      options.onData(Buffer.from('end\n'))
      return { exitCode: 0 }
    })
    const host = makeHost({ watch: (_info, signal) => abortable(signal), end: () => false })
    const natural = autoBackgroundOperations(base, { seconds: 0.05, notify: (text) => notified.push(text), dir, host, retryMs: 1 })
    await natural.exec('slow', dir, { onData: () => {} })
    await sleep(20)
    finish()
    await sleep(60)
    ok(host.calls.end.length === 1 && notified.length === 1, '自己结束的后台命令照旧通知模型，同时告知宿主')
    ok(notified[0].includes('状态：completed') && host.calls.watch.length === 1, '自然结束的通知状态不变，监视随之取消')
  }

  {
    const notified = []
    let finish
    const base = fakeBase(async (_c, _d, options) => {
      options.onData(Buffer.from('start\n'))
      await new Promise((resolve) => {
        finish = resolve
      })
      return { exitCode: 0 }
    })
    const host = makeHost({ watch: () => null, end: () => false })
    const unavailable = autoBackgroundOperations(base, { seconds: 0.05, notify: (text) => notified.push(text), dir, host, retryMs: 1 })
    await unavailable.exec('x', dir, { onData: () => {} })
    await sleep(20)
    finish()
    await sleep(40)
    ok(host.calls.watch.length === 1 && notified.length === 1, '宿主不开放这个命令时不再重试，行为与以前一致')
  }

  {
    const notified = []
    let finish
    const base = fakeBase(async (_c, _d, options) => {
      options.onData(Buffer.from('start\n'))
      await new Promise((resolve) => {
        finish = resolve
      })
      return { exitCode: 0 }
    })
    const host = makeHost({ watch: async () => {
      throw new Error('down')
    }, end: () => {
      throw new Error('down')
    } })
    const failing = autoBackgroundOperations(base, { seconds: 0.05, notify: (text) => notified.push(text), dir, host, retryMs: 1 })
    await failing.exec('x', dir, { onData: () => {} })
    await sleep(80)
    ok(host.calls.watch.length === 5, '宿主连不上时最多尝试五次就放弃')
    finish()
    await sleep(40)
    ok(notified.length === 1, '宿主连不上时仍按原样通知模型')
  }

  {
    const notified = []
    let finish
    const base = fakeBase(async (_c, _d, options) => {
      options.onData(Buffer.from('start\n'))
      await new Promise((resolve) => {
        finish = resolve
      })
      return { exitCode: 0 }
    })
    const host = makeHost({ watch: (_info, signal) => abortable(signal), end: () => true })
    const raced = autoBackgroundOperations(base, { seconds: 0.05, notify: (text) => notified.push(text), dir, host, retryMs: 1 })
    await raced.exec('x', dir, { onData: () => {} })
    await sleep(20)
    finish()
    await sleep(40)
    ok(notified.length === 0, '宿主表示这条已被用户停止时，扩展不再自己通知')
  }

  {
    const requests = []
    const fakeFetch = async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) })
      return { json: async () => ({ ok: true, summary: { stop: requests.length === 1, stopped: true } }) }
    }
    ok(createHostChannel({}, fakeFetch) === null, '没有宿主通道环境变量时不启用')
    const env = { YAN_CLI_URL: 'http://127.0.0.1:1/rpc', YAN_CLI_TOKEN: 'tok', YAN_SESSION_ID: 's1', YAN_PROJECT_ID: 'p1' }
    const channel = createHostChannel(env, fakeFetch)
    ok((await channel.watch({ id: 'abcd1234', command: 'c' }, undefined)) === true, '监视返回宿主的停止结果')
    ok(requests[0].body.command === 'shell.background' && requests[0].body.params.action === 'watch' && requests[0].body.sessionId === 's1' && requests[0].init.headers.authorization === 'Bearer tok', '请求带上命令名、身份与令牌')
    ok((await channel.end({ id: 'abcd1234' })) === true && requests[1].body.params.action === 'end', '结束请求返回宿主是否已按停止处理')
    const refused = createHostChannel(env, async () => ({ json: async () => ({ ok: false, error: 'unknown_command' }) }))
    ok((await refused.watch({ id: 'abcd1234' })) === null, '宿主拒绝时按不可用处理')
  }

  {
    const { EventEmitter } = await import('node:events')
    const written = []
    let blockWrites = true
    const log = Object.assign(new EventEmitter(), {
      write: (chunk) => {
        written.push(chunk.toString())
        return !blockWrites
      },
      end: () => {
        log.ended = true
      }
    })
    const source = { pauses: 0, resumes: 0, pause() { this.pauses++ }, resume() { this.resumes++ } }
    let onData
    let finish
    const base = fakeBase(async (_c, _d, options) => {
      onData = options.onData
      onData.call(source, Buffer.from('early\n'))
      await new Promise((resolve) => {
        finish = resolve
      })
      return { exitCode: 0 }
    })
    const pressured = autoBackgroundOperations(base, { seconds: 0.05, notify: () => {}, dir, openLog: () => log })
    await pressured.exec('big', dir, { onData: () => {} })
    onData.call(source, Buffer.from('b1'))
    ok(source.pauses === 1 && source.resumes === 0, '日志写入返回 false 时暂停上游读取')
    onData.call(source, Buffer.from('b2'))
    ok(source.pauses === 1, '同一路上游不重复暂停')
    log.emit('drain')
    ok(source.resumes === 1, '日志 drain 后恢复读取')
    ok(written.join('') === 'early\nb1b2', '背压期间不丢数据、不改顺序')
    onData.call(source, Buffer.from('b3'))
    ok(source.pauses === 2, '再次积压时可再次暂停')
    log.emit('error', new Error('disk full'))
    ok(source.resumes === 2, '日志出错时恢复读取，不让命令卡死')
    onData.call(source, Buffer.from('b4'))
    ok(source.pauses === 2 && !written.join('').includes('b4'), '日志坏了之后不再写也不再暂停')
    blockWrites = false
    finish()
    await sleep(30)
    ok(log.ended === true, '命令结束后关闭日志')
  }

  {
    const { PassThrough } = await import('node:stream')
    const { once } = await import('node:events')
    const source = new PassThrough({ highWaterMark: 1024 })
    let pauses = 0
    source.on('pause', () => {
      pauses++
    })
    const total = 40
    const chunkSize = 256 * 1024
    const base = fakeBase(async (_c, _d, options) => {
      source.on('data', options.onData)
      await sleep(80)
      for (let i = 0; i < total; i++) {
        const chunk = Buffer.alloc(chunkSize, 97 + (i % 26))
        if (!source.write(chunk)) await once(source, 'drain')
      }
      source.end()
      await once(source, 'end')
      return { exitCode: 0 }
    })
    const notified = []
    const real = autoBackgroundOperations(base, { seconds: 0.02, notify: (text) => notified.push(text), dir })
    await real.exec('flood', dir, { onData: () => {} })
    for (let i = 0; i < 200 && notified.length === 0; i++) await sleep(50)
    ok(notified.length === 1, '大量输出的后台命令正常结束并通知')
    ok(pauses > 0, '真实流上用 this 暂停过上游')
    const logFile = /完整输出：(.+)$/m.exec(notified[0])[1]
    const content = await readFile(logFile)
    let intact = content.length === total * chunkSize
    for (let i = 0; intact && i < total; i++) intact = content[i * chunkSize] === 97 + (i % 26) && content[(i + 1) * chunkSize - 1] === 97 + (i % 26)
    ok(intact, '日志完整、未截断、顺序不乱')
  }

  console.log('shell-background: ok')
} finally {
  await sleep(500)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
