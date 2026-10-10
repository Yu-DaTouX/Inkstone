import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const tag = process.argv.includes('--after') ? 'after' : 'before'
const file = resolve(`out/test/turn-stream-${tag}.mjs`)
await build({ entryPoints: ['src/shared/turns.ts'], outfile: file, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const module = await import(pathToFileURL(file))
const project = tag === 'after' ? module.createTurnProjector() : module.groupIntoTurns
const messages = []
for (let i = 0; i < 1000; i++) {
  messages.push({ id: `u${i}`, role: 'user', text: `Question ${i}` })
  messages.push({ id: `a${i}`, role: 'assistant', text: ('Historical paragraph ' + i + ' abcdefghijklmnopqrstuvwxyz\n\n').repeat(20) })
}
messages.push({ id: 'current-user', role: 'user', text: 'Stream current answer' })
let rows = [...messages, { id: 'current', role: 'assistant', text: '' }]
let previous = project(rows, 'current'), reused = 0
const samples = []
for (let i = 0; i < 200; i++) {
  rows = [...messages, { id: 'current', role: 'assistant', text: 'Streaming text\n\n'.repeat(i + 1) }]
  const start = performance.now(), next = project(rows, 'current')
  samples.push(performance.now() - start)
  if (next[1] === previous[1]) reused++
  previous = next
}
samples.sort((a, b) => a - b)
const result = { tag, messages: rows.length, updates: samples.length, medianMs: samples[100], p95Ms: samples[190], stableHistoryReused: reused }
await writeFile(resolve(`.local-docs/evidence/turn-stream-${tag}-${Date.now()}.json`), JSON.stringify(result, null, 2))
console.log(result)
