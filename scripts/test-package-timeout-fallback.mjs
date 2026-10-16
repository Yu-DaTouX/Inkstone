import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { sliceDeclaration } from './lib/source-slice.mjs'
const source = await readFile('src/main/packages.ts', 'utf8')
const snippet = sliceDeclaration(source, 'function runPi(')
const { code } = await transform(snippet + '\nglobalThis.runPi=runPi', { loader: 'ts' })
let timer, finish, killed = false
const killer = new EventEmitter()
killer.unref = () => {}
const context = {
 ctx: { bin: () => 'fixture-pi' }, process: { platform: 'win32', execPath: 'fixture-node', env: {} },
 agentDirNow: () => 'fixture', setTimeout: callback => { timer = callback; return 1 }, clearTimeout: () => {},
 spawn: (_file, args) => { assert.equal(args.includes('/T'), true); return killer },
 execFile: (_file, _args, _options, callback) => {
  finish = callback
  return { pid: 42, kill: () => { killed = true; finish(new Error('fixture timeout'), '', ''); return true } }
 }
}
runInNewContext(code, context)
const result = context.runPi([], 'fixture')
timer()
assert.equal(killer.listenerCount('error'), 1)
killer.emit('error', new Error('fixture taskkill missing'))
assert.equal(killed, true)
const reply = await result
assert.equal(reply.ok, false)
assert.match(reply.output, /操作超时/)
assert.match(reply.output, /仍可能有未能结束/)
console.log('package-timeout-fallback: 6 assertions passed')
