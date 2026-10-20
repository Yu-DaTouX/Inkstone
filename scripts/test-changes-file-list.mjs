import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/changes/file-list.ts', import.meta.url))
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const {
  FILE_LIST_WIDTH,
  LARGE_DIFF_FILES,
  LARGE_DIFF_LINES,
  buildFileTree,
  canFitFileList,
  clampFileListWidth,
  compareFilePaths,
  createLimitedQueue,
  fileListLimit,
  flattenFileTree,
  isLargeDiff,
  sortChangeItems
} = mod

assert.deepEqual({ ...FILE_LIST_WIDTH }, { DEFAULT: 240, MIN: 160, MAX: 640 })
assert.equal(clampFileListWidth(Number.NaN), 240)
assert.equal(clampFileListWidth(100), 160)
assert.equal(clampFileListWidth(900), 640)
assert.equal(clampFileListWidth(321.4), 321)
assert.equal(clampFileListWidth(900, 300), 300)
assert.equal(clampFileListWidth(100, 120), 160)

assert.equal(fileListLimit(800), 640)
assert.equal(fileListLimit(500), 340)
assert.equal(fileListLimit(400), 240)
assert.equal(fileListLimit(100), 160)
assert.equal(fileListLimit(0), 160)

assert.equal(canFitFileList(0), true)
assert.equal(canFitFileList(399), false)
assert.equal(canFitFileList(400), true)

const file = (path, added = 0, removed = 0) => ({ path, status: 'M', untracked: false, added, removed })
assert.equal(isLargeDiff([file('a', 2500, 2500)]), false)
assert.equal(isLargeDiff([file('a', 2500, 2501)]), true)
assert.equal(isLargeDiff(Array.from({ length: LARGE_DIFF_FILES }, (_, i) => file(`f${i}.ts`))), false)
assert.equal(isLargeDiff(Array.from({ length: LARGE_DIFF_FILES + 1 }, (_, i) => file(`f${i}.ts`))), true)
assert.equal(isLargeDiff([{ path: 'a' }]), false)

assert.ok(LARGE_DIFF_LINES === 5000)

assert.equal(compareFilePaths('src/a.ts', 'src/b.ts') < 0, true)
assert.equal(compareFilePaths('file2.ts', 'file10.ts') < 0, true)
assert.equal(compareFilePaths('src/a.ts', 'a.ts') < 0, true)
assert.equal(compareFilePaths('a.ts', 'a.ts'), 0)
assert.equal(compareFilePaths('a/b/c.ts', 'a/b.ts') < 0, true)

const sorted = sortChangeItems([file('b.ts'), file('src/b.ts'), file('src/a.ts'), file('a.ts')])
assert.deepEqual(sorted.map((item) => item.path), ['src/a.ts', 'src/b.ts', 'a.ts', 'b.ts'])

const tree = buildFileTree([file('README.md'), file('src/a.ts'), file('src/lib/b.ts'), file('style.css')])
assert.deepEqual(tree.map((node) => `${node.kind}:${node.name}`), ['dir:src', 'file:README.md', 'file:style.css'])
const src = tree[0]
assert.equal(src.children.length, 2)
assert.equal(src.children[0].kind, 'dir')
assert.equal(src.children[0].name, 'lib')
assert.equal(src.children[1].kind, 'file')
assert.equal(src.children[1].name, 'a.ts')

const compacted = buildFileTree([file('src/lib/a.ts'), file('src/lib/b.ts')])
assert.equal(compacted.length, 1)
assert.equal(compacted[0].name, 'src/lib')
assert.equal(compacted[0].children.length, 2)

const rows = flattenFileTree(tree, new Set())
assert.deepEqual(rows.map((row) => `${row.depth}:${row.kind}:${row.name}`), [
  '0:dir:src',
  '1:dir:lib',
  '2:file:b.ts',
  '1:file:a.ts',
  '0:file:README.md',
  '0:file:style.css'
])
const collapsedRows = flattenFileTree(tree, new Set(['src']))
assert.deepEqual(collapsedRows.map((row) => row.name), ['src', 'README.md', 'style.css'])

const queue = createLimitedQueue(2)
let active = 0
let peak = 0
const order = []
const jobs = Array.from({ length: 6 }, (_, index) =>
  queue(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 20 : 4))
    active -= 1
    order.push(index)
    return index
  })
)
const values = await Promise.all(jobs)
assert.deepEqual(values, [0, 1, 2, 3, 4, 5])
assert.equal(peak, 2)
assert.equal(order.length, 6)

await assert.rejects(
  queue(async () => {
    throw new Error('boom')
  }),
  /boom/
)

console.log('test-changes-file-list ok')
