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
  const rpc = new PiRpc({ cwd: process.cwd(), runtime: { kind: 'node', executable: process.execPath, cli: 'unused' } })
  const events = []
  rpc.on('stderr', (line) => events.push(line))
  for (const chunk of chunks) rpc.feedStderr(chunk)
  if (flush) rpc.flushStderr()
  return events
}

const isMark = (l) => l === MARK

console.log('ER7 stderr boundary:')

{
  const ev = collect([`${'A'.repeat(MAX + 200)}\nnext-1\n`])
  ok(ev.length === 2 && isMark(ev[0]) && ev[1] === 'next-1', '单块超长含 LF：整行省略，仅一条 marker，下一行恢复')
  ok(!ev.some((l) => l.includes('AAAA')), '单块超长：不喷出任何行长内容（不保留头）')
}

{
  const ev = collect([`${'X'.repeat(9000)}`, `${'Y'.repeat(9000)}\nrecovered\n`])
  ok(ev.length === 2 && isMark(ev[0]) && ev[1] === 'recovered', '跨 chunk 超长：仅一条 marker，LF 后恢复')
  ok(!ev.some((l) => /[XY]/.test(l)), '跨 chunk 超长：头尾都不残留')
}

{
  const ev = collect([`${'Z'.repeat(MAX)}`, 'Z\nnext-3\n'])
  ok(ev.length === 2 && isMark(ev[0]) && ev[1] === 'next-3', '边界切分（MAX + 1）：整行省略，下一行恢复')
}

{
  const line = 'K'.repeat(MAX)
  const ev = collect([`${line}\n`])
  ok(ev.length === 1 && ev[0] === line, '整行恰好 16KB：上限内，原样保留')
}

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

{
  const ev = collect([`${'Q'.repeat(MAX + 77)}`], { flush: true })
  ok(ev.length === 1 && isMark(ev[0]), '结束 flush：被省略段不补发，只留一条 marker')
}

{
  const ev = collect(['short-tail'], { flush: true })
  ok(ev.length === 1 && ev[0] === 'short-tail', '无 LF 短尾：flush 原样保留')
}

{
  const ev = collect(['one\n', 'two\n', 'three\n'])
  ok(ev.join('|') === 'one|two|three', '普通短行逐条原样保留')
}

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

{
  const t = lateCase()
  t.rpc.finishExit(0, null)
  ok(t.rpc.running === false, 'finishExit 后 running 立即为 false')
  t.rpc.feed('{"type":"__late__"}\nnot-json-late\npartial-no-lf')
  t.rpc.finishExit(1, null)
  ok(t.events.length === 0 && t.stds.length === 0, 'finished 后 stdout 迟到块：不发 event，也不发 [非 JSON 输出] stderr')
  ok(t.exitCount() === 1, 'finished 后重复收口：exit 仍只发一次')
}

{
  const t = lateCase()
  t.rpc.feedStderr('before-finish-line\n')
  t.rpc.finishExit(0, null)
  t.rpc.feedStderr('late-line-1\nlate-line-2\n')
  ok(JSON.stringify(t.stds) === JSON.stringify(['before-finish-line']), 'finished 后 stderr 迟到块：不发 stderr，宽限内数据不受影响')
}

{
  const secret = 'sk-ER8-FAKE-9f2c7a61b0d4e835c0de'
  const t = lateCase()
  t.rpc.feedStderr(`{"label":"api_key","value":"${secret.slice(0, 8)}`)
  t.rpc.feedStderr(`${secret.slice(8)}","pad":"${'p'.repeat(MAX + 64)}`)
  t.rpc.finishExit(0, null)
  t.rpc.feedStderr(`${secret} late-tail\n`)
  ok(t.stds.length === 1 && isMark(t.stds[0]), '超长 drop → finish：只留一条 marker，flush 不补发')
  ok(
    t.stds.every((l) => !l.includes(secret)) && t.events.every((e) => !JSON.stringify(e).includes(secret)),
    '超长 drop → finish → 迟到片段：fake secret 不泄露'
  )
}

{
  const t = lateCase()
  t.rpc.feedStderr('grace-tail-no-lf')
  t.rpc.finishExit(0, null)
  ok(JSON.stringify(t.stds) === JSON.stringify(['grace-tail-no-lf']), '宽限短尾：finishExit 恰好 flush 一次')
  t.rpc.flushStderr()
  ok(t.stds.length === 1, '短尾 flush 后缓冲已清，不重复补发')
}

await rm(tmp, { recursive: true, force: true })

if (failures.length) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
