import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/changes/changes-scope.ts', import.meta.url))
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const { WORKING_SCOPE, commitScope, compareLabel, formatBytes, isImagePath, isValidSha, resolvePatchSource, scopeKey, scopeToRequest, shortSha } = mod

assert.deepEqual(scopeToRequest(WORKING_SCOPE), { kind: 'working' })
assert.deepEqual(scopeToRequest({ kind: 'branch', sha: '' }), { kind: 'branch' })
assert.deepEqual(scopeToRequest({ kind: 'commit', sha: 'ABCD1234' }), { kind: 'commit', sha: 'abcd1234' })
assert.equal(scopeToRequest({ kind: 'commit', sha: '' }), null)
assert.equal(scopeToRequest({ kind: 'commit', sha: 'xyz1' }), null)
assert.equal(scopeToRequest({ kind: 'commit', sha: 'abc' }), null)

assert.equal(isValidSha('abcd'), true)
assert.equal(isValidSha(' ABCDEF0 '), true)
assert.equal(isValidSha('a'.repeat(64)), true)
assert.equal(isValidSha('a'.repeat(65)), false)
assert.equal(isValidSha('abcg'), false)
assert.equal(isValidSha(''), false)

assert.deepEqual(commitScope('0123456789abcdef0123456789abcdef01234567'), { kind: 'commit', sha: '0123456789abcdef0123456789abcdef01234567' })
assert.deepEqual(commitScope(null), { kind: 'commit', sha: '' })
assert.deepEqual(commitScope('zz'), { kind: 'commit', sha: '' })

assert.equal(scopeKey(WORKING_SCOPE), 'working')
assert.equal(scopeKey({ kind: 'commit', sha: 'abcd' }), 'commit:abcd')
assert.equal(shortSha('0123456789abcdef'), '0123456')
assert.equal(shortSha(null), '')

for (const path of ['a.png', 'dir/B.JPG', 'x.jpeg', 'x.gif', 'x.webp', 'x.bmp', 'x.svg', 'x.ico', 'x.avif']) assert.equal(isImagePath(path), true, path)
for (const path of ['a.ts', 'png', 'a.png.txt', 'a.pngx']) assert.equal(isImagePath(path), false, path)

assert.deepEqual(resolvePatchSource('a.ts', { state: 'inline', patch: 'diff' }), { kind: 'inline', patch: 'diff' })
assert.deepEqual(resolvePatchSource('a.ts', { state: 'inline', patch: '' }), { kind: 'inline', patch: '' })
assert.deepEqual(resolvePatchSource('a.ts', { state: 'inline' }), { kind: 'fetch' })
assert.deepEqual(resolvePatchSource('a.ts', { state: 'deferred' }), { kind: 'fetch' })
assert.deepEqual(resolvePatchSource('a.ts', undefined), { kind: 'fetch' })
assert.deepEqual(resolvePatchSource('a.bin', { state: 'binary' }), { kind: 'binary' })
assert.deepEqual(resolvePatchSource('a.ts', { state: 'too-large' }), { kind: 'too-large' })
assert.deepEqual(resolvePatchSource('a.png', { state: 'binary' }), { kind: 'image' })
assert.deepEqual(resolvePatchSource('a.svg', { state: 'inline', patch: 'x' }), { kind: 'image' })

assert.equal(compareLabel(WORKING_SCOPE, { baseRef: 'main' }), '')
assert.equal(compareLabel({ kind: 'branch', sha: '' }, { baseRef: 'origin/main', baseSha: '1234567890' }), 'origin/main')
assert.equal(compareLabel({ kind: 'branch', sha: '' }, { baseRef: null, baseSha: '1234567890' }), '1234567')
assert.equal(compareLabel({ kind: 'commit', sha: 'abcdef0123' }, { baseRef: null, baseSha: null, targetSha: 'fedcba9876' }), 'fedcba9')
assert.equal(compareLabel({ kind: 'commit', sha: 'abcdef0123' }, {}), 'abcdef0')

assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(512), '512 B')
assert.equal(formatBytes(2048), '2.0 KB')
assert.equal(formatBytes(20 * 1024), '20 KB')
assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
assert.equal(formatBytes(-1), '')

console.log('test-v3-changes-scope ok')
