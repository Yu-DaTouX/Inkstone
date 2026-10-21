#!/usr/bin/env node
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const report = { pass: 0, fail: 0 }
function ok(cond, label, detail) {
  if (cond) {
    report.pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    report.fail += 1
    console.error(`  ✗ ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

const temp = await mkdtemp(join(tmpdir(), 'yan-session-tail-'))
const outfile = join(temp, 'session-tail.mjs')
await build({
  entryPoints: ['src/main/session-tail.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { sessionTailState, readSessionTail, tailTurnInterrupted } = await import(pathToFileURL(outfile).href)

const header = JSON.stringify({ type: 'session', version: 3, id: 'sess-1', timestamp: '2026-10-22T04:00:00.000Z', cwd: 'C:/w' })
const user = (at, text = '写个脚本') =>
  JSON.stringify({
    type: 'message',
    id: `u-${at}`,
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: at }
  })
const assistant = (at, stopReason, text = '') =>
  JSON.stringify({
    type: 'message',
    id: `a-${at}`,
    timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }], stopReason, timestamp: at }
  })
const system = (at) =>
  JSON.stringify({ type: 'message', id: `s-${at}`, timestamp: new Date(at).toISOString(), message: { role: 'system', content: '' } })

const T = Date.parse('2026-10-22T04:00:00.000Z')

console.log('\n## 尾行判定：区分正常完成、用户停止与被打断')
{
  const done = [header, user(T), assistant(T + 1000, 'stop', '好了')].join('\n')
  ok(sessionTailState(done).lastRole === 'assistant', '正常完成时最后一条是 assistant')
  ok(tailTurnInterrupted(sessionTailState(done)) === false, '正常完成的回合不算被打断')

  const answered = [header, user(T), assistant(T + 1000, 'aborted', ''), user(T + 5000)].join('\n')
  ok(tailTurnInterrupted(sessionTailState(answered)) === true, '最后一条是 user（没等到回答）算被打断')

  const aborted = [header, user(T), assistant(T + 1000, 'aborted', '')].join('\n')
  ok(sessionTailState(aborted).stopReason === 'aborted', '读到 aborted 的 stopReason')
  ok(tailTurnInterrupted(sessionTailState(aborted)) === true, '没有回合记录时，尾行 aborted 算被打断')

  ok(tailTurnInterrupted(sessionTailState(aborted), T + 500) === true, 'aborted 比最后一条已结算回合更新时算被打断')
  ok(tailTurnInterrupted(sessionTailState(aborted), T + 9999) === false, 'aborted 属于已结算的旧回合时不算（用户早就点过停止）')
}

console.log('\n## 容错：坏行、非 message 条目与 system 尾巴')
{
  const broken = [header, user(T), assistant(T + 1000, 'aborted'), '{"type":"message","message":{"role":"assi'].join('\n')
  ok(tailTurnInterrupted(sessionTailState(broken)) === true, '末尾半截行跳过，仍按上一条 message 判定')

  const garbage = [header, user(T), assistant(T + 1000, 'stop', '好'), 'not-json', ''].join('\n')
  ok(sessionTailInterruptedSafe(garbage) === false, '非 JSON 行不影响判定')

  const withSystem = [header, user(T), assistant(T + 1000, 'aborted'), system(T + 2000)].join('\n')
  ok(sessionTailState(withSystem).lastRole === 'assistant', '跳过非 user/assistant 的 message 条目')

  ok(tailTurnInterrupted(sessionTailState('')) === false, '空文件不算被打断')
  ok(tailTurnInterrupted(sessionTailState(header)) === false, '只有会话头不算被打断')
  ok(tailTurnInterrupted(sessionTailState('{"type":"message","message":{"role":"toolResult"}}')) === false, '只有工具结果不算被打断')
}

function sessionTailInterruptedSafe(text) {
  return tailTurnInterrupted(sessionTailState(text))
}

console.log('\n## 磁盘读取：只读尾部，不解析整份会话')
{
  const file = join(temp, 'session.jsonl')
  const filler = Array.from({ length: 4000 }, (_, i) => user(T + i * 10, `填充 ${i} `.repeat(20)))
  await writeFile(file, [header, ...filler, user(T + 100000), assistant(T + 101000, 'aborted', '')].join('\n'), 'utf8')
  const tail = await readSessionTail(file)
  ok(tail.stopReason === 'aborted' && tail.lastRole === 'assistant', '从大文件尾部读到最后一条 assistant', JSON.stringify(tail))
  ok(tail.lastAt === T + 101000, '时间戳解析为毫秒', JSON.stringify(tail.lastAt))

  const empty = join(temp, 'empty.jsonl')
  await writeFile(empty, '', 'utf8')
  ok((await readSessionTail(empty)).lastRole === undefined, '空文件返回空结果')
  ok((await readSessionTail(join(temp, 'missing.jsonl'))).lastRole === undefined, '文件不存在不抛错')
}

console.log(`\n${report.fail === 0 ? 'PASS' : 'FAIL'}: ${report.pass} passed, ${report.fail} failed`)
if (report.fail > 0) process.exitCode = 1
