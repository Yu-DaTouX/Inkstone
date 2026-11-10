import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-virtual-cache-'))
let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }
try {
  const outfile = join(dir, 'cache.mjs')
  await build({ entryPoints: [resolve('src/renderer/src/features/session/virtual-cache.ts')], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'error' })
  const { readVirtualCache, saveVirtualCache, virtualizeSession } = await import(pathToFileURL(outfile).href)
  const ids = ['a', 'b', 'c']
  const cache = [[100, 240, 300], 240]
  check('相同会话、行序列和宽度复用测量', () => {
    saveVirtualCache('session', ids, 800, cache)
    assert.equal(readVirtualCache('session', [...ids], 800), cache)
  })
  check('宽度变化或行身份变化时不复用旧尺寸', () => {
    assert.equal(readVirtualCache('session', ids, 600), undefined)
    assert.equal(readVirtualCache('session', ['a', 'b'], 800), undefined)
    assert.equal(readVirtualCache('session', ['a', 'x', 'c'], 800), undefined)
    assert.equal(readVirtualCache('other', ids, 800), undefined)
  })
  check('拒绝空列表和长度不一致的快照', () => {
    saveVirtualCache('empty', [], 800, [[], 240])
    saveVirtualCache('wrong', ids, 800, [[100], 240])
    assert.equal(readVirtualCache('empty', [], 800), undefined)
    assert.equal(readVirtualCache('wrong', ids, 800), undefined)
  })
  check('测量快照数量有界', () => {
    for (let i = 0; i < 17; i++) saveVirtualCache(`bounded-${i}`, ids, 800, cache)
    assert.equal(readVirtualCache('bounded-0', ids, 800), undefined)
    assert.equal(readVirtualCache('bounded-16', ids, 800), cache)
  })
  check('虚拟列表进入阈值不变，退出留出滞回区间', () => {
    assert.equal(virtualizeSession(false, 80, 200), false)
    assert.equal(virtualizeSession(false, 81, 100), true)
    assert.equal(virtualizeSession(false, 70, 201), true)
    assert.equal(virtualizeSession(true, 80, 200), true)
    assert.equal(virtualizeSession(true, 65, 160), true)
    assert.equal(virtualizeSession(true, 64, 160), false)
  })
  console.log(`virtual-cache: ${passed} 项通过`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
