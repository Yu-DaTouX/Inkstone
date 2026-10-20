import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/diff/separators.ts', import.meta.url))
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const { hunkSeparators, unifiedLineNumber } = mod
const label = (count) => `${count} unmodified lines`

const hunk = (oldStart, oldCount, newStart, newCount, header = '') => ({
  header,
  oldStart,
  oldCount,
  newStart,
  newCount,
  section: '',
  lines: []
})

const first = hunk(1, 3, 1, 4, '@@ -1,3 +1,4 @@')
const second = hunk(10, 2, 11, 2, '@@ -10,2 +11,2 @@')
const third = hunk(20, 1, 21, 1, '@@ -20,1 +21,1 @@')

assert.deepEqual(hunkSeparators([first], label), [null])
assert.deepEqual(hunkSeparators([first, second], label), [null, { kind: 'lines', text: '6 unmodified lines', count: 6 }])
assert.deepEqual(hunkSeparators([first, third], label)[1], { kind: 'lines', text: '16 unmodified lines', count: 16 })
assert.equal(hunkSeparators([first, second, third], label)[2].count, 8)

const mismatched = hunk(10, 2, 30, 2, '@@ -10,2 +30,2 @@')
assert.deepEqual(hunkSeparators([first, mismatched], label)[1], {
  kind: 'metadata',
  text: '@@ -10,2 +30,2 @@',
  count: 0
})

const overlapping = hunk(2, 2, 2, 2, '@@ -2,2 +2,2 @@')
assert.equal(hunkSeparators([first, overlapping], label)[1].kind, 'metadata')

assert.equal(unifiedLineNumber({ kind: 'add', text: '', raw: '', oldLine: null, newLine: 7 }), 7)
assert.equal(unifiedLineNumber({ kind: 'del', text: '', raw: '', oldLine: 3, newLine: null }), 3)
assert.equal(unifiedLineNumber({ kind: 'context', text: '', raw: '', oldLine: 9, newLine: 11 }), 11)
assert.equal(unifiedLineNumber({ kind: 'context', text: '', raw: '', oldLine: null, newLine: null }), null)

const zeroCount = hunk(0, 0, 1, 0, '@@ -0,0 +1,0 @@')
assert.equal(hunkSeparators([zeroCount], label)[0].kind, 'metadata')

console.log('test-diff-separators ok')
