import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const dir = await mkdtemp(join(tmpdir(), 'yan-pi-respond-'))
const outfile = join(dir, 'protocol.mjs')
await build({ entryPoints: ['src/main/protocol.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { PiRpc } = await import(pathToFileURL(outfile.replace(/\\/g, '/')).href)
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

let pass = 0
function ok(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  pass += 1
  console.log(`  ✓ ${label}`)
}

function fakeRpc(write) {
  const rpc = new PiRpc({ cwd: process.cwd() })
  rpc.child = { stdin: { destroyed: false, writable: true, write } }
  return rpc
}

console.log('▌PiRpc 答复写回调：任务写入成功才回执')
{
  const lines = []
  const rpc = fakeRpc((line, encoding, callback) => {
    lines.push(line)
    setImmediate(() => callback(null))
    return true
  })
  const delivered = await rpc.respondUi({ id: 'q1', value: 'A' })
  ok(delivered === true, '写入回调成功后返回 true')
  ok(lines.length === 1 && lines[0].includes('extension_ui_response'), '写入一条 extension_ui_response')

  const failing = fakeRpc((line, encoding, callback) => {
    setImmediate(() => callback(new Error('EPIPE')))
    return true
  })
  const lost = await failing.respondUi({ id: 'q1', value: 'A' })
  ok(lost === false, 'write 返回后异步回调 EPIPE 时返回 false，不谎报送达')

  const throwing = fakeRpc(() => {
    throw new Error('stdin closed')
  })
  const thrown = await throwing.respondUi({ id: 'q1', value: 'A' })
  ok(thrown === false, 'write 同步抛错时返回 false')

  const closed = fakeRpc((line, encoding, callback) => callback(null))
  closed.child.stdin.destroyed = true
  ok((await closed.respondUi({ id: 'q1' })) === false, 'stdin 已销毁时不写入')

  const stopped = fakeRpc((line, encoding, callback) => callback(null))
  stopped.closed = true
  ok((await stopped.respondUi({ id: 'q1' })) === false, 'RPC 已关闭时不写入')
}

console.log(`PiRpc 答复写回调：${pass} 项通过`)
