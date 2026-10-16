import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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

export async function runTerminalStatusTests() {
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
      PROGRAM_STATUS_QUERY,
      PROGRAM_STATUS_REPLY,
      PI_PROGRAM_STATUS_QUERY,
      MAX_SEQUENCE_BYTES,
      MAX_MESSAGE_BYTES
    } = mod

    {
      const scanner = new TerminalStatusScanner()
      eq(scanner.write('\x1b]750'), [], '未成帧的 OSC 片段不产出事件')
      eq(scanner.write('1;?\x1b\\'), [{ kind: 'query' }], '查询帧被切开也能识别')
      ok(scanner.programStatusSeen, '查询也算程序在用 7501')
      eq(PROGRAM_STATUS_QUERY, '\x1b]7501;?1\x1b\\', '终端回复带最小 payload（真实 pi 可接受的形态）')
      eq(PROGRAM_STATUS_REPLY, PROGRAM_STATUS_QUERY, '能力回复的规范名与 terminal.ts 写回帧一致')
      eq(PI_PROGRAM_STATUS_QUERY, '\x1b]7501;?\x1b\\', 'pi 查询帧与 pi 源码 PROGRAM_STATUS_QUERY 同值')
      eq(isTerminalStatusQuery('7501;?'), true, '只认精确 7501;?')
      eq(isTerminalStatusQuery('7501;?1'), false, '带 payload 的能力回复不是查询')
      eq(isTerminalStatusQuery('7501;?something long'), false, '详细回显不是查询')
      eq(PROGRAM_STATUS_QUERY.endsWith('\x1b\\'), true, '回复用 ST 终止')
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runTerminalStatusTests()
