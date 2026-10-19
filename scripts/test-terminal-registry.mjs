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

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
