import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-background-tasks-'))
  try {
    const bg = await compile('src/renderer/src/features/workbench/background-tasks.ts', join(dir, 'background-tasks.mjs'))

    assert.equal(bg.TASK_OUTPUT_TAIL, 8000)
    assert.equal(bg.FOLLOW_EDGE_PX, 16)

    assert.deepEqual(bg.tailOutput('short'), { text: 'short', clipped: false })
    const exact = 'x'.repeat(8000)
    assert.deepEqual(bg.tailOutput(exact), { text: exact, clipped: false })
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const tail = bg.tailOutput(lines)
    assert.equal(tail.clipped, true)
    assert.ok(tail.text.length <= 8000)
    assert.ok(tail.text.endsWith('line 1999'))
    assert.match(tail.text, /^line \d+\n/)
    const flat = 'a'.repeat(9000)
    assert.deepEqual(bg.tailOutput(flat), { text: 'a'.repeat(8000), clipped: true })
    assert.deepEqual(bg.tailOutput('abcdef\nghij', 5), { text: 'ghij', clipped: true })
    assert.deepEqual(bg.tailOutput('abcdefghi\n', 4), { text: 'ghi\n', clipped: true })

    assert.equal(bg.isNearBottom({ scrollTop: 484, scrollHeight: 1000, clientHeight: 500 }), true)
    assert.equal(bg.isNearBottom({ scrollTop: 483, scrollHeight: 1000, clientHeight: 500 }), false)
    assert.equal(bg.isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 }), true)
    assert.equal(bg.isNearBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 500 }, 100), true)

    const entries = [
      { id: 'r2', live: true, startedAt: 20, endedAt: null },
      { id: 'f1', live: false, startedAt: 1, endedAt: 50 },
      { id: 'r1', live: true, startedAt: 10, endedAt: null },
      { id: 'f2', live: false, startedAt: 2, endedAt: 90 },
      { id: 'f3', live: false, startedAt: 70, endedAt: null }
    ]
    const sections = bg.sectionTasks(entries)
    assert.deepEqual(sections.running.map((e) => e.id), ['r1', 'r2'])
    assert.deepEqual(sections.finished.map((e) => e.id), ['f2', 'f3', 'f1'])
    assert.deepEqual(bg.sectionTasks([]), { running: [], finished: [] })

    for (const state of ['starting', 'running', 'stopping', 'unknown']) assert.equal(bg.isLiveTaskRow({ state }), true, state)
    for (const state of ['done', 'failed', 'stopped']) assert.equal(bg.isLiveTaskRow({ state }), false, state)

    const transcript = [
      { id: 'u', role: 'user', text: 'task' },
      { id: 'a1', role: 'assistant', text: 'first' },
      { id: 'a2', role: 'assistant', text: '   ' },
      { id: 't', role: 'tool', text: 'tool out' }
    ]
    assert.equal(bg.subagentOutputText({ transcript, result: { summary: 'sum' }, latestActivity: 'act' }), 'first')
    assert.equal(bg.subagentOutputText({ transcript: [], result: { summary: '  sum  ' }, latestActivity: 'act' }), 'sum')
    assert.equal(bg.subagentOutputText({ transcript: [], latestActivity: ' reading a.ts ' }), 'reading a.ts')
    assert.equal(bg.subagentOutputText({ transcript: [] }), '')

    console.log('background-tasks: 通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
