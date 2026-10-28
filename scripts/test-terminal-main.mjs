import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const ENTRY = 'src/main/terminal-status.ts'
const tempDirs = []

async function loadModule() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-terminal-status-'))
  tempDirs.push(dir)
  const outfile = join(dir, 'terminal-status.mjs')
  const result = await build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    metafile: true,
    logLevel: 'silent'
  })
  assert.deepEqual(Object.keys(result.metafile.inputs), [ENTRY], '终端状态解析应是自包含纯模块')
  return import(pathToFileURL(outfile).href)
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
let checks = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}

async function runTerminalStatusTests() {
  try {
    const mod = await loadModule()
    const {
      TerminalStatusScanner,
      TerminalProgramStatusTracker,
      parseTerminalStatusReport,
      parseLegacyProgress,
      legacyProgressToStatus,
      decodeStatusText,
      isTerminalStatusQuery,
      PROGRAM_STATUS_REPLY,
      MAX_SEQUENCE_BYTES,
      MAX_MESSAGE_BYTES
    } = mod

    {
      const scanner = new TerminalStatusScanner()
      eq(scanner.write('\x1b]750'), [], '未成帧的 OSC 片段不产出事件')
      eq(scanner.write('1;?\x1b\\'), [{ kind: 'query' }], '查询帧被切开也能识别')
      ok(scanner.programStatusSeen, '查询也算程序在用 7501')
      eq(PROGRAM_STATUS_REPLY, '\x1b]7501;?1\x1b\\', '终端回复带最小 payload（真实 pi 可接受的形态）')
      eq(isTerminalStatusQuery('7501;?'), true, '只认精确 7501;?')
      eq(isTerminalStatusQuery('7501;?1'), false, '带 payload 的能力回复不是查询')
      eq(isTerminalStatusQuery('7501;?something long'), false, '详细回显不是查询')
      eq(PROGRAM_STATUS_REPLY.endsWith('\x1b\\'), true, '回复用 ST 终止')
    }

    {
      const tracker = new TerminalProgramStatusTracker()
      eq(tracker.consume(PROGRAM_STATUS_REPLY).queries, 0, '能力回复回显不触发查询')
      eq(tracker.consume('\x1b]7501;?1;2;3\x1b\\').queries, 0, '详细能力回显不触发查询')
      eq(tracker.consume('\x1b]7501;?1\x07').queries, 0, 'BEL 终止的带 payload 回复不算精确查询')
      eq(tracker.consume('\x1b]7501;?\x1b\\').queries, 1, '精确查询仍然触发一次')
    }

    {
      const tracker = new TerminalProgramStatusTracker()
      const encoded = b64('编译中')
      tracker.consume(`\x1b]7501;state=working:msg=${encoded.slice(0, 3)}`)
      eq(tracker.status, undefined, '标题未收全时不落记录')
      const partial = tracker.consume(`${encoded.slice(3)}\x1b`)
      eq(partial.changed, false, '块尾 ESC（未完成 ST）不落记录')
      eq(tracker.status, undefined, '未收到反斜杠前没有记录')
      const settled = tracker.consume('\\')
      eq(settled.changed, true, '补全 ST 后才落记录')
      eq(tracker.status, { state: 'working', title: '编译中' }, '跨块拼接出 working 与标题')
    }

    {
      const frame = `\x1b]7501;state=blocked:kind=permission:progress=42:app=pi:title=${b64('等待')}\x1b\\`
      const expected = { state: 'blocked', kind: 'permission', progress: 42, app: 'pi', title: '等待' }
      for (let i = 0; i <= frame.length; i += 1) {
        const tracker = new TerminalProgramStatusTracker()
        tracker.consume(frame.slice(0, i))
        tracker.consume(frame.slice(i))
        eq(tracker.status, expected, `同帧在第 ${i} 个字符分割等价`)
      }
      const charByChar = new TerminalProgramStatusTracker()
      for (const ch of frame) charByChar.consume(ch)
      eq(charByChar.status, expected, '同帧逐字符输入等价')

      const legacyFrame = '\x1b]9;4;1;42\x07'
      const legacyByChar = new TerminalProgramStatusTracker()
      for (const ch of legacyFrame) legacyByChar.consume(ch)
      eq(legacyByChar.status, { state: 'working', progress: 42 }, '9;4 逐字符输入等价')
    }

    {
      const tracker = new TerminalProgramStatusTracker()
      eq(tracker.consume('\x1b]0;window title\x07').changed, false, '标题等无关 OSC 不产出状态')
    }

    {
      const tracker = new TerminalProgramStatusTracker()
      eq(tracker.consume('\x1b]9;4;1;40\x07').changed, true, '没有 7501 时 9;4 驱动记录')
      eq(tracker.status, { state: 'working', progress: 40 }, '9;4 正常态映射为带进度的 working')
      eq(tracker.consume('\x1b]7501;state=done\x1b\\').changed, true, '7501 覆盖 9;4 记录')
      eq(tracker.consume('\x1b]9;4;1;80\x07').changed, false, '收到 7501 后 9;4 不再驱动')
      eq(tracker.status, { state: 'done' }, '9;4 不再改动 7501 的记录')
    }
    eq(legacyProgressToStatus({ state: 0 }), { state: 'clear' }, '9;4 state 0 = 清除')
    eq(legacyProgressToStatus({ state: 2 }), { state: 'error' }, '9;4 state 2 = 错误')
    eq(legacyProgressToStatus({ state: 3 }), { state: 'working' }, '9;4 state 3 = 不确定进度')
    eq(legacyProgressToStatus({ state: 4 }), { state: 'idle' }, '9;4 state 4 = 暂停（不是等你）')
    eq(legacyProgressToStatus({ state: 9 }), null, '未知 9;4 状态丢弃')

    eq(parseLegacyProgress('9;4;0'), { state: 0 }, '无 progress 合法')
    eq(parseLegacyProgress('9;4;1;0'), { state: 1, value: 0 }, 'progress=0 合法')
    eq(parseLegacyProgress('9;4;4;100'), { state: 4, value: 100 }, 'progress=100 合法')
    eq(parseLegacyProgress('9;4;1;150'), null, '9;4 进度越界丢弃')
    eq(parseLegacyProgress('9;4;1;abc'), null, '9;4 进度非数字丢弃')
    eq(parseLegacyProgress('9;4;5'), null, '9;4 状态越界丢弃')
    eq(parseLegacyProgress('9;4;0x1'), null, '9;4 状态非单个 ASCII 数字丢弃')
    eq(parseLegacyProgress('9;4;'), null, '9;4 缺状态丢弃')
    eq(parseLegacyProgress('9;4'), null, '9;4 段数不足丢弃')
    eq(parseLegacyProgress('9;4;1;'), null, '9;4 空进度丢弃')
    eq(parseLegacyProgress('9;4;1;50;extra'), null, '9;4 多余参数丢弃')

    {
      const tracker = new TerminalProgramStatusTracker()
      tracker.consume('\x1b]9;4;1;40\x07')
      eq(tracker.status, { state: 'working', progress: 40 }, '先有可投影的 9;4 状态')
      eq(tracker.consume('\x1b]9;4;0x1\x07').changed, false, '坏状态不产出投影')
      eq(tracker.status, { state: 'working', progress: 40 }, '坏状态不清记录')
      eq(tracker.consume('\x1b]9;4;0;1;2\x07').changed, false, '多余参数不产出投影')
      eq(tracker.status, { state: 'working', progress: 40 }, '多余参数不清记录')
      eq(tracker.consume('\x1b]9;4;0\x07').changed, true, '合法 state 0 仍可清除')
      eq(tracker.status, undefined, '合法清除生效')
    }

    {
      const tracker = new TerminalProgramStatusTracker()
      tracker.consume('\x1b]7501;state=blocked:kind=permission\x1b\\')
      eq(tracker.status, { state: 'blocked', kind: 'permission' }, 'blocked 记录带 kind')
      eq(tracker.consume('\x1b]7501;state=clear\x1b\\').changed, true, 'clear 清除记录')
      eq(tracker.status, undefined, 'clear 后没有记录')
    }
    eq(parseTerminalStatusReport('7501;state=blocked'), { state: 'blocked' }, 'blocked 可不带 kind')
    eq(parseTerminalStatusReport('7501;state=blocked:kind=question'), { state: 'blocked', kind: 'question' }, 'question 细分')
    eq(parseTerminalStatusReport('7501;state=blocked:kind=auth'), { state: 'blocked', kind: 'auth' }, 'auth 细分')
    eq(parseTerminalStatusReport('7501;state=blocked:kind=bogus'), null, '未知 kind 整条丢弃')
    eq(parseTerminalStatusReport('7501;state=napping'), null, '未知状态整条丢弃')
    eq(parseTerminalStatusReport('9;4;1;50'), null, '9;4 不是 7501 上报')
    eq(parseTerminalStatusReport('7501;state=working:app=pi'), { state: 'working', app: 'pi' }, '合法 app 保留')
    eq(parseTerminalStatusReport('7501;state=working:app=bad app'), null, '非法 app 整条丢弃')

    eq(parseTerminalStatusReport('7501;state=working:state=done'), null, '重复 state 整帧拒绝')
    eq(parseTerminalStatusReport('7501;state=working:progress=1:progress=2'), null, '重复 progress 整帧拒绝')
    eq(parseTerminalStatusReport('7501;state=working:id=a:id=b'), null, '重复 id 整帧拒绝')

    eq(parseTerminalStatusReport('7501;state=done:id=agent-1'), null, '带 id 的上报整条不驱动根')
    {
      const tracker = new TerminalProgramStatusTracker()
      tracker.consume('\x1b]7501;state=working\x1b\\')
      eq(tracker.status, { state: 'working' }, '根记录 working')
      eq(tracker.consume('\x1b]7501;state=done:id=agent-1\x1b\\').changed, false, '带 id 的子记录不驱动根')
      eq(tracker.status, { state: 'working' }, '子记录不覆盖根')
      eq(tracker.consume('\x1b]7501;state=clear:id=agent-1\x1b\\').changed, false, '带 id 的 clear 不清根')
      eq(tracker.status, { state: 'working' }, '根记录仍在')
      eq(tracker.consume('\x1b]9;4;1;40\x07').changed, false, '收到带 id 的 7501 后 9;4 不再驱动')
      eq(tracker.status, { state: 'working' }, '根记录不被 9;4 改动')
    }
    {
      const scanner = new TerminalStatusScanner()
      scanner.write('\x1b]7501;state=done:id=agent-1\x1b\\')
      ok(scanner.programStatusSeen, '带 id 的上报也算程序在用 7501')
    }

    eq(parseTerminalStatusReport('7501;state=working:progress=0'), { state: 'working', progress: 0 }, 'progress=0 合法')
    eq(parseTerminalStatusReport('7501;state=working:progress=100'), { state: 'working', progress: 100 }, 'progress=100 合法')
    eq(parseTerminalStatusReport('7501;state=working:progress=101'), null, 'progress=101 丢弃')
    eq(parseTerminalStatusReport('7501;state=working:progress=-1'), null, 'progress 负数丢弃')
    eq(parseTerminalStatusReport('7501;state=working:progress=abc'), null, 'progress 非数字丢弃')

    eq(parseTerminalStatusReport('7501;state=working:msg=!!!'), null, '非 base64 整条丢弃')
    eq(parseTerminalStatusReport('7501;state=working:msg=a'), null, 'base64 长度非法丢弃')
    eq(parseTerminalStatusReport(`7501;state=working:msg=${b64('a\u0001b')}`), null, '解码后含控制字符整条丢弃')
    eq(parseTerminalStatusReport(`7501;state=working:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`), null, '坏 UTF-8 丢弃')
    eq(parseTerminalStatusReport('7501;state=working:msg=' + b64('ok')), { state: 'working', title: 'ok' }, '规范 base64 保留')
    eq(decodeStatusText(b64('x'.repeat(200))).length, 120, '超长标题截断成短标题')
    eq(parseTerminalStatusReport('7501;state=working\x07'), null, '正文含控制字符整条丢弃')

    {
      const long = 'x'.repeat(119) + '😀' + 'y'
      const decoded = decodeStatusText(b64(long))
      eq(Array.from(decoded).length, 120, '120 个码点，不是 120 个 UTF-16 单元')
      ok(decoded.isWellFormed(), '截断后没有孤立代理')
      ok(decoded.endsWith('😀'), '保留完整的代理对')
      eq(parseTerminalStatusReport(`7501;state=working:msg=${b64(long)}`), { state: 'working', title: decoded }, '含 emoji 的 msg 整条解析')
    }

    {
      eq(MAX_MESSAGE_BYTES, 2048, 'msg 字节上限 2048')
      eq(decodeStatusText(b64('a'.repeat(2048))).length, 120, '恰好 2048 字节仍合法')
      eq(decodeStatusText(b64('a'.repeat(2049))), null, '超过 2048 字节丢弃')
      eq(parseTerminalStatusReport(`7501;state=working:msg=${b64('a'.repeat(2049))}`), null, '超限 msg 整条丢弃')
    }

    {
      eq(parseTerminalStatusReport(`7501;state=blocked:kind=permission:app=pi:msg=${b64('等待')}`), { state: 'blocked', kind: 'permission', app: 'pi', title: '等待' }, '真实冒号字段顺序可任意')
      eq(parseTerminalStatusReport('7501;state=working:app=my.app+v1-2'), { state: 'working', app: 'my.app+v1-2' }, 'app 允许 . + -')
      eq(parseTerminalStatusReport('7501;state=working;app=pi'), null, '字段用分号（私造语法）整条丢弃')
    }

    {
      const tracker = new TerminalProgramStatusTracker()
      const res = tracker.consume('\x1b]7501;state=working\x1bX\x1b]7501;state=done\x1b\\')
      eq(res.changed, true, '裸 ESC 中断的帧被丢弃，后续 OSC 恢复')
      eq(tracker.status, { state: 'done' }, '只落恢复后的那一帧')
    }
    {
      const tracker = new TerminalProgramStatusTracker()
      tracker.consume('\x1b]7501;state=working\x1b')
      eq(tracker.status, undefined, '块尾 ESC 无法判定前不落状态')
      eq(tracker.consume('X\x1b]7501;state=idle\x1b\\').changed, true, 'ESC 后非反斜杠时丢弃并恢复')
      eq(tracker.status, { state: 'idle' }, '恢复后解析下一帧')
    }
    {
      const tracker = new TerminalProgramStatusTracker()
      tracker.consume('\x1b]7501;state=working\x1b')
      eq(tracker.consume(']7501;state=done\x1b\\').changed, true, '块尾 ESC 属于下一条 OSC 时仍能识别')
      eq(tracker.status, { state: 'done' }, '识别下一条 OSC 并落记录')
    }

    {
      const bigB64 = b64('a'.repeat(MAX_SEQUENCE_BYTES))
      const overlong = `\x1b]7501;state=working:msg=${bigB64}\x1b\\`
      const tracker = new TerminalProgramStatusTracker()
      eq(tracker.consume(overlong).changed, false, '单块完整超长帧不落状态')
      eq(tracker.status, undefined, '单块完整超长帧无记录')
      eq(tracker.consume('\x1b]7501;state=done\x1b\\').changed, true, '完整超长帧终止符后恢复')
      eq(tracker.status, { state: 'done' }, '恢复后解析后续帧')

      const sameChunk = new TerminalProgramStatusTracker()
      const res = sameChunk.consume(`${overlong}\x1b]7501;state=idle\x1b\\`)
      eq(res.changed, true, '完整超长帧同块后续帧正常解析')
      eq(sameChunk.status, { state: 'idle' }, '同块后续帧落记录')
    }

    {
      const bigB64 = b64('a'.repeat(MAX_SEQUENCE_BYTES))
      const tracker = new TerminalProgramStatusTracker()
      eq(tracker.consume(`\x1b]7501;state=working:msg=${bigB64}`).changed, false, '分块超长未终止不落状态')
      eq(tracker.consume('\x1b').changed, false, '超限丢弃中末尾 ESC 先到')
      eq(tracker.consume('\\\x1b]7501;state=done\x1b\\').changed, true, '被切开的 ST 补全后丢弃结束并恢复')
      eq(tracker.status, { state: 'done' }, '分块超长恢复后解析')

      const sameChunk = new TerminalProgramStatusTracker()
      eq(sameChunk.consume(`\x1b]7501;state=working:msg=${bigB64}\x1b`).changed, false, '超限块尾 ESC 同块内触发丢弃')
      eq(sameChunk.consume('\\\x1b]7501;state=done\x1b\\').changed, true, '同块保留的 ESC 补全后恢复')
      eq(sameChunk.status, { state: 'done' }, '同块恢复后解析')
    }

    {
      const tracker = new TerminalProgramStatusTracker()
      tracker.consume('\x1b]7501;state=working\x1b\\')
      ok(tracker.exit(), '退出清掉 working')
      eq(tracker.status, undefined, 'working 退出后为无记录')
      const done = new TerminalProgramStatusTracker()
      done.consume('\x1b]7501;state=done\x1b\\')
      eq(done.exit(), false, 'done 在退出时保留')
      eq(done.status, { state: 'done' }, 'done 记录仍在')
      const blocked = new TerminalProgramStatusTracker()
      blocked.consume('\x1b]7501;state=blocked:kind=question\x1b\\')
      ok(blocked.exit(), '退出清掉 blocked')
    }

    {
      const tracker = new TerminalProgramStatusTracker()
      eq(tracker.consume('\x1b]7501;?\x1b\\\x1b]7501;?\x1b\\').queries, 2, '同块两条查询计两次')
    }

    console.log(`terminal-status: ${checks} 项纯解析检查通过`)
  } finally {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
  }
}

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function runTerminalRegistry() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-terminal-registry-'))
  try {
    const reg = await compile('src/main/terminal-registry.ts', join(dir, 'registry.mjs'))

    assert.equal(reg.MAX_TERMINALS_PER_OWNER, 12)
    assert.equal(reg.REPLAY_BUFFER_CHARS, 400 * 1024)
    assert.equal(reg.FLUSH_INTERVAL_MS, 8)

    assert.equal(reg.normalizeOwner('  session-1 '), 'session-1')
    assert.equal(reg.normalizeOwner(''), undefined)
    assert.equal(reg.normalizeOwner(42), undefined)
    assert.equal(reg.normalizeOwner('x'.repeat(300)), undefined)

    const small = reg.appendReplay('abc', 'def', 10, 2)
    assert.equal(small, 'abcdef')
    const line = 'line\n'
    let buffer = ''
    for (let i = 0; i < 100; i += 1) buffer = reg.appendReplay(buffer, line, 100, 20)
    assert.ok(buffer.length <= 120)
    assert.ok(buffer.length >= 95)
    assert.ok(buffer.startsWith('line'))
    const withEscape = reg.appendReplay('x'.repeat(20), 'ab\x1b[31mred', 8, 0)
    assert.ok(!withEscape.startsWith('[31m'))

    const owned = (n, alive = true, owner = 's') => Array.from({ length: n }, (_, i) => ({ id: `${owner}${i}`, owner, alive }))
    assert.deepEqual(reg.planOwnerSlot(owned(11), 's'), { allowed: true, evict: [] })
    assert.deepEqual(reg.planOwnerSlot(owned(12), 's'), { allowed: false, evict: [] })
    const mixed = [...owned(10), { id: 'dead1', owner: 's', alive: false }, { id: 'dead2', owner: 's', alive: false }]
    assert.deepEqual(reg.planOwnerSlot(mixed, 's'), { allowed: true, evict: ['dead1'] })
    assert.deepEqual(reg.planOwnerSlot([...owned(12, true, 'other')], 's'), { allowed: true, evict: [] })

    const emitted = []
    const scheduled = []
    const batcher = new reg.OutputBatcher(
      (id, data) => emitted.push([id, data]),
      (fn) => {
        scheduled.push(fn)
        return scheduled.length
      },
      () => {},
      8,
      10
    )
    batcher.push('a', 'he')
    batcher.push('a', 'llo')
    batcher.push('b', 'x')
    assert.equal(scheduled.length, 1)
    assert.deepEqual(emitted, [])
    scheduled[0]()
    assert.deepEqual(emitted, [['a', 'hello'], ['b', 'x']])
    batcher.push('a', '0123456789')
    assert.deepEqual(emitted.at(-1), ['a', '0123456789'])
    batcher.push('c', 'pending')
    batcher.flush('c')
    assert.deepEqual(emitted.at(-1), ['c', 'pending'])
    batcher.push('d', 'gone')
    batcher.drop('d')
    batcher.flushAll()
    assert.equal(emitted.some(([id]) => id === 'd'), false)

    assert.equal(reg.safeTerminalCut('abcdef\nrest', 2), 7)

    console.log('test-terminal-registry: 全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function runTerminalSessions() {
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
}

await runTerminalRegistry()
await runTerminalSessions()
await runTerminalStatusTests()
