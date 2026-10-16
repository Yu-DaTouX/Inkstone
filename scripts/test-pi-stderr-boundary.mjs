/**
 * stderr 物理行边界的定向回归（真实 PiRpc，不 spawn / 不联网 / 不碰模型）。
 *
 * 只针对 `PiRpc.feedStderr` / `flushStderr` 的 16KB 单物理行上限：
 *   · 单块即含 LF 的超长行 → 整行省略，只发一次固定 marker，不喷头；
 *   · 跨任意 chunk 的超长行 → 同样只在越界时发一次 marker，持续丢到真实 LF；
 *   · 截断点落在 fake secret 标签/值两侧时，完整 secret 不出现在任何 stderr 事件里；
 *   · 下一行恢复、结束 flush 不补发被丢段、短行与无 LF 短尾原样保留；
 *   · 固定 seed 遍历若干 chunk 切点，事件序列与手写期望一致。
 *
 * 这里跑的是编译后的真实类方法，不是复制一份解析逻辑。
 *
 * ER8 追加：实例收口（finished）后 feed / feedStderr 拒收迟到数据，
 * 宽限期短尾仍由 finishExit 补发一次。
 *
 * ER10 主区移植说明：临时转译产物只写 .tmp/v3-ui/ER10-port/build/（不进 out/、
 * 不落系统临时目录）；运行时形状用主区支持的 { kind:'node', executable, cli }
 * —— 本脚本从不 spawn，只做纯行状态机断言。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const MAX = 16 * 1024
const MARK = '[yan] stderr 单行过长，已截断（整行省略，丢弃到下一个换行）'

const BUILD_DIR = join('.tmp', 'v3-ui', 'ER10-port', 'build')
await mkdir(BUILD_DIR, { recursive: true })
const tmp = await mkdtemp(join(BUILD_DIR, 'stderr-boundary-'))
const bundle = join(tmp, 'protocol.mjs')
await build({
  entryPoints: ['src/main/protocol.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron'],
  logLevel: 'silent'
})
const { PiRpc } = await import(pathToFileURL(bundle).href)

const failures = []
function ok(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`)
  else {
    failures.push(msg)
    console.log(`FAIL  ${msg}`)
  }
}

function collect(chunks, { flush = false } = {}) {
  // 显式运行时覆盖：构造 PiRpc 只做纯行状态机断言，不 spawn。
  const rpc = new PiRpc({ cwd: process.cwd(), runtime: { kind: 'node', executable: process.execPath, cli: 'unused' } })
  const events = []
  rpc.on('stderr', (line) => events.push(line))
  for (const chunk of chunks) rpc.feedStderr(chunk)
  if (flush) rpc.flushStderr()
  return events
}

const isMark = (l) => l === MARK

console.log('ER7 stderr boundary:')

// 1. 单块超长行（LF 在同一块）+ 下一行恢复
{
  const ev = collect([`${'A'.repeat(MAX + 200)}\nnext-1\n`])
  ok(ev.length === 2 && isMark(ev[0]) && ev[1] === 'next-1', '单块超长含 LF：整行省略，仅一条 marker，下一行恢复')
  ok(!ev.some((l) => l.includes('AAAA')), '单块超长：不喷出任何行长内容（不保留头）')
}

// 2. 跨 chunk 超长行：越界即丢，直到真实 LF
{
  const ev = collect([`${'X'.repeat(9000)}`, `${'Y'.repeat(9000)}\nrecovered\n`])
  ok(ev.length === 2 && isMark(ev[0]) && ev[1] === 'recovered', '跨 chunk 超长：仅一条 marker，LF 后恢复')
  ok(!ev.some((l) => /[XY]/.test(l)), '跨 chunk 超长：头尾都不残留')
}

// 3. 恰好在边界附近切分：errBuf == MAX 后下一块再多 1 字即越界
{
  const ev = collect([`${'Z'.repeat(MAX)}`, 'Z\nnext-3\n'])
  ok(ev.length === 2 && isMark(ev[0]) && ev[1] === 'next-3', '边界切分（MAX + 1）：整行省略，下一行恢复')
}

// 4. 整行恰好 MAX：仍在上限内，原样保留
{
  const line = 'K'.repeat(MAX)
  const ev = collect([`${line}\n`])
  ok(ev.length === 1 && ev[0] === line, '整行恰好 16KB：上限内，原样保留')
}

// 5. secret 标签/值被分在截断两边：完整 secret 不出现在任何 raw stderr 事件
{
  const secret = 'sk-ER7-FAKE-0123456789abcdef0123456789abcdef'
  const head = `{"label":"api_key","value":"${secret.slice(0, 12)}`
  const tail = `${secret.slice(12)}","pad":"${'p'.repeat(MAX + 64)}"}`
  const ev = collect([`${head}`, `${tail}\nok-5\n`])
  ok(ev.length === 2 && isMark(ev[0]) && ev[1] === 'ok-5', 'secret 跨截断点：整行省略，仅 marker + 下一行')
  ok(ev.every((l) => !l.includes(secret)), 'secret 跨截断点：完整 secret 不出现在任何 stderr 事件')
  ok(ev.every((l) => !l.includes('api_key')), 'secret 跨截断点：标签也不残留（不裁断上下文）')
  ok(ev.filter(isMark).length === 1, 'secret 跨截断点：marker 只有一条')
}

// 6. 结束 flush 不重发被丢段
{
  const ev = collect([`${'Q'.repeat(MAX + 77)}`], { flush: true })
  ok(ev.length === 1 && isMark(ev[0]), '结束 flush：被省略段不补发，只留一条 marker')
}

// 7. 无 LF 短尾原样 flush
{
  const ev = collect(['short-tail'], { flush: true })
  ok(ev.length === 1 && ev[0] === 'short-tail', '无 LF 短尾：flush 原样保留')
}

// 8. 普通短行不设围栏
{
  const ev = collect(['one\n', 'two\n', 'three\n'])
  ok(ev.join('|') === 'one|two|three', '普通短行逐条原样保留')
}

// 9. 多个长 / 短行混排（手写期望，不复刻 parser）
{
  const stream =
    'lead\n' +
    `${'L'.repeat(MAX + 50)}\n` +
    'mid-1\n' +
    `${'M'.repeat(MAX + 1)}\n` +
    'mid-2\n' +
    'tail-no-newline'
  const expected = ['lead', MARK, 'mid-1', MARK, 'mid-2', 'tail-no-newline']
  const ev = collect([stream], { flush: true })
  ok(JSON.stringify(ev) === JSON.stringify(expected), '长/短行混排：事件序列与手写期望一致')
}

// 10. 固定 seed 遍历少量 chunk 切点（同一 stream 任意切分结果不变）
{
  const stream =
    'a\n' +
    `${'L'.repeat(MAX + 50)}\n` +
    'b\n' +
    `${'M'.repeat(MAX + 7)}\n` +
    `${'N'.repeat(MAX * 2)}\n` +
    'c\n' +
    'tail'
  const expected = ['a', MARK, 'b', MARK, MARK, 'c', 'tail']
  // 简单 LCG，seed 固定：切点稳定可复现
  const lcg = (seed) => {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }
  for (const seed of [1, 2, 3, 7, 13]) {
    const rnd = lcg(seed)
    const chunks = []
    let i = 0
    while (i < stream.length) {
      const size = 1 + Math.floor(rnd() * 4096)
      chunks.push(stream.slice(i, i + size))
      i += size
    }
    const ev = collect(chunks, { flush: true })
    ok(JSON.stringify(ev) === JSON.stringify(expected), `seed ${seed}：随机切分 ${chunks.length} 块后事件序列一致`)
  }
}

console.log('\nER8 finished 后迟到 IO 守卫：')

// ER8：直接调编译后的真实收口单点 finishExit（不 spawn），验证
// finished 后 feed / feedStderr 拒收迟到数据，且宽限期短尾仍由收口补发。
function lateCase() {
  const rpc = new PiRpc({ cwd: process.cwd(), runtime: { kind: 'node', executable: process.execPath, cli: 'unused' } })
  const events = []
  const stds = []
  let exits = 0
  rpc.on('event', (e) => events.push(e))
  rpc.on('stderr', (l) => stds.push(l))
  rpc.on('exit', () => {
    exits += 1
  })
  return { rpc, events, stds, exitCount: () => exits }
}

// 20. finished 后 stdout 迟到块：不分帧、不发 event，也不发 [非 JSON 输出] stderr
{
  const t = lateCase()
  t.rpc.finishExit(0, null)
  ok(t.rpc.running === false, 'finishExit 后 running 立即为 false')
  t.rpc.feed('{"type":"__late__"}\nnot-json-late\npartial-no-lf')
  t.rpc.finishExit(1, null)
  ok(t.events.length === 0 && t.stds.length === 0, 'finished 后 stdout 迟到块：不发 event，也不发 [非 JSON 输出] stderr')
  ok(t.exitCount() === 1, 'finished 后重复收口：exit 仍只发一次')
}

// 21. finished 后 stderr 迟到块：不再发 stderr
{
  const t = lateCase()
  t.rpc.feedStderr('before-finish-line\n') // 宽限内（finished 仍 false）正常收
  t.rpc.finishExit(0, null)
  t.rpc.feedStderr('late-line-1\nlate-line-2\n')
  ok(JSON.stringify(t.stds) === JSON.stringify(['before-finish-line']), 'finished 后 stderr 迟到块：不发 stderr，宽限内数据不受影响')
}

// 22. 超长 drop → finish → 后代迟到片段：fake secret 不泄、flush 不补发
{
  const secret = 'sk-ER8-FAKE-9f2c7a61b0d4e835c0de'
  const t = lateCase()
  t.rpc.feedStderr(`{"label":"api_key","value":"${secret.slice(0, 8)}`)
  t.rpc.feedStderr(`${secret.slice(8)}","pad":"${'p'.repeat(MAX + 64)}`) // 越界 → marker + 进入 drop 态
  t.rpc.finishExit(0, null) // 收口 flush 在 drop 态清掉 errDropping，不补发
  // 后代经继承 pipe 迟到：长行剩余片段。无守卫时这里会被当新行发出、泄露 secret。
  t.rpc.feedStderr(`${secret} late-tail\n`)
  ok(t.stds.length === 1 && isMark(t.stds[0]), '超长 drop → finish：只留一条 marker，flush 不补发')
  ok(
    t.stds.every((l) => !l.includes(secret)) && t.events.every((e) => !JSON.stringify(e).includes(secret)),
    '超长 drop → finish → 迟到片段：fake secret 不泄露'
  )
}

// 23. 真实 exit 前宽限内的短尾：由 finishExit 恰好 flush 一次，不重复
{
  const t = lateCase()
  t.rpc.feedStderr('grace-tail-no-lf') // 宽限期内（finished 仍 false）正常入缓冲
  t.rpc.finishExit(0, null) // 收口本身补发短尾一次
  ok(JSON.stringify(t.stds) === JSON.stringify(['grace-tail-no-lf']), '宽限短尾：finishExit 恰好 flush 一次')
  t.rpc.flushStderr() // 迟到的再次 flush 不重复
  ok(t.stds.length === 1, '短尾 flush 后缓冲已清，不重复补发')
}

await rm(tmp, { recursive: true, force: true })

if (failures.length) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
