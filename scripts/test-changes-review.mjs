#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

const fakeStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value))
  }
}

const outdir = join('.tmp', 'changes-review')
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
try {
  await build({
    entryPoints: [
      'src/renderer/src/features/changes/test-files.ts',
      'src/renderer/src/features/changes/viewed-files.ts',
      'src/renderer/src/features/diff/patch-files.ts',
      'src/renderer/src/features/diff/annotation-keys.ts'
    ],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['@pierre/diffs'],
    logLevel: 'silent'
  })
  const tests = await import(pathToFileURL(join(outdir, 'changes', 'test-files.js')).href)
  const viewed = await import(pathToFileURL(join(outdir, 'changes', 'viewed-files.js')).href)
  const patchFiles = await import(pathToFileURL(join(outdir, 'diff', 'patch-files.js')).href)
  const keys = await import(pathToFileURL(join(outdir, 'diff', 'annotation-keys.js')).href)
  const pierre = await import('@pierre/diffs')

  for (const path of [
    'src/foo.test.ts',
    'src/foo.spec.tsx',
    'src/foo.e2e.ts',
    'src/__tests__/helper.ts',
    'src/__test__/helper.ts',
    'test/a.js',
    'tests/a.py',
    'spec/a.rb',
    'specs/a.ts',
    'e2e/login.ts',
    'cypress/e2e/a.ts',
    'playwright/a.ts',
    'src/a_test.go',
    'src/a_spec.rb',
    'scripts/test_utils.py',
    'conftest.py',
    'src/FooTest.java',
    'src/FooTests.kt',
    'src/FooSpec.scala'
  ]) {
    ok(tests.isTestFilePath(path), `识别测试文件：${path}`)
  }

  for (const path of [
    'src/contest.py',
    'src/testing/a.ts',
    'src/latest.ts',
    'src/Latest.java',
    'src/index.ts',
    'README.md',
    'scripts/test-unit.mjs',
    'docs/tests.md',
    ''
  ]) {
    ok(!tests.isTestFilePath(path), `不算测试文件：${path || '空路径'}`)
  }

  ok(tests.isTestFilePath('src\\tests\\a.ts'), 'Windows 分隔符同样识别')
  ok(tests.countTestFiles(['a.test.ts', 'b.ts', 'tests/c.ts']) === 2, '统计测试文件数量')
  ok(
    JSON.stringify(tests.withoutTestFiles([{ path: 'a.test.ts' }, { path: 'b.ts' }]).map((item) => item.path)) === '["b.ts"]',
    '按对象列表过滤测试文件'
  )

  const store = fakeStorage()
  ok(tests.readHideTestFiles(store) === false, '默认不隐藏测试文件')
  tests.writeHideTestFiles(true, store)
  ok(store.getItem(tests.HIDE_TEST_FILES_KEY) === '1', '开关写入 localStorage 键')
  ok(tests.readHideTestFiles(store) === true, '隐藏状态可读回')
  tests.writeHideTestFiles(false, store)
  ok(tests.readHideTestFiles(store) === false, '关闭后读回 false')
  const hostile = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    }
  }
  ok(tests.readHideTestFiles(hostile) === false, '读取抛错时安全回退')
  assert.doesNotThrow(() => tests.writeHideTestFiles(true, hostile), '写入抛错时不影响界面')

  const hashA = viewed.patchHash('diff --git a/x b/x\n+one\n')
  const hashA2 = viewed.patchHash('diff --git a/x b/x\n+one\n')
  const hashB = viewed.patchHash('diff --git a/x b/x\n+two\n')
  ok(hashA === hashA2, '同一 patch 的哈希稳定')
  ok(hashA !== hashB, 'patch 变化后哈希不同')
  ok(/^[0-9a-f]+$/.test(hashA), '哈希是十六进制字符串')
  ok(viewed.patchHash('') === viewed.patchHash(''), '空 patch 也能取哈希')

  ok(viewed.VIEWED_FILES_KEY === 'inkstone.changes.viewedFiles.v1', '已读状态存储键带版本')
  ok(viewed.viewedEntryKey('E:\\repo\\', 'src\\a.ts') === 'E:/repo/src/a.ts', '仓库根与文件路径归一化')
  ok(viewed.viewedEntryKey('/repo', '/src/a.ts') === '/repo/src/a.ts', '去掉文件路径开头的分隔符')

  assert.deepEqual(viewed.parseViewedFiles(null), {}, '没有记录时返回空表')
  assert.deepEqual(viewed.parseViewedFiles('{oops'), {}, '坏 JSON 安全回退')
  assert.deepEqual(viewed.parseViewedFiles('[1,2]'), {}, '数组回退为空表')
  assert.deepEqual(viewed.parseViewedFiles(JSON.stringify({ '/r/a.ts': 'ab', '/r/b.ts': 3 })), { '/r/a.ts': 'ab' }, '丢弃非字符串值')
  const roundTrip = { '/r/a.ts': 'ab' }
  assert.deepEqual(viewed.parseViewedFiles(viewed.serializeViewedFiles(roundTrip)), roundTrip, '序列化后可原样读回')

  const root = 'E:/repo'
  ok(viewed.isFileViewed({}, root, 'a.ts', 'ab') === false, '没有记录时未读')
  ok(viewed.isFileViewed({ 'E:/repo/a.ts': 'ab' }, root, 'a.ts', 'ab') === true, '哈希一致算已读')
  ok(viewed.isFileViewed({ 'E:/repo/a.ts': 'ab' }, root, 'a.ts', 'cd') === false, '哈希不一致算未读')
  ok(viewed.isFileViewed({ 'E:/repo/a.ts': '' }, root, 'a.ts', 'ab') === true, '记录时没有 patch 的已读保持已读')
  ok(viewed.isFileViewed({ 'E:/repo/a.ts': 'ab' }, root, 'a.ts', null) === true, '拿不到 patch 时不推翻已读')

  const empty = {}
  const marked = viewed.withFileViewed(empty, root, 'a.ts', 'ab', true)
  assert.deepEqual(marked, { 'E:/repo/a.ts': 'ab' }, '标记已读写入哈希')
  assert.equal(empty['E:/repo/a.ts'], undefined, '不修改原对象')
  ok(viewed.withFileViewed(marked, root, 'a.ts', 'ab', true) === marked, '重复标记返回同一对象')
  assert.deepEqual(viewed.withFileViewed(marked, root, 'a.ts', 'ab', false), {}, '取消已读删掉记录')
  ok(viewed.withFileViewed(empty, root, 'a.ts', 'ab', false) === empty, '取消未标记的文件不产生新对象')
  assert.deepEqual(viewed.withFileViewed(empty, root, 'a.ts', null, true), { 'E:/repo/a.ts': '' }, '未知哈希时记空串')

  const stale = { 'E:/repo/a.ts': 'ab', 'E:/repo/b.ts': 'cd', 'E:/other/a.ts': 'zz' }
  const reconciled = viewed.reconcileViewedFiles(stale, root, [
    { path: 'a.ts', hash: 'cd' },
    { path: 'b.ts', hash: 'cd' }
  ])
  assert.deepEqual(reconciled, { 'E:/other/a.ts': 'zz', 'E:/repo/b.ts': 'cd' }, 'patch 变化的已读失效，其他仓库不受影响')
  ok(viewed.reconcileViewedFiles(stale, root, [{ path: 'b.ts', hash: 'cd' }]) === stale, '没有变化时返回同一对象')
  ok(viewed.reconcileViewedFiles(stale, root, []) === stale, '没有候选时不动状态')
  assert.deepEqual(
    viewed.reconcileViewedFiles({ 'E:/repo/a.ts': '' }, root, [{ path: 'a.ts', hash: 'ef' }]),
    { 'E:/repo/a.ts': 'ef' },
    '补上记录时缺失的哈希'
  )

  const progress = viewed.viewedProgress(
    { 'E:/repo/a.ts': 'ab' },
    root,
    [
      { path: 'a.ts', hash: 'ab' },
      { path: 'b.ts', hash: 'cd' },
      { path: 'c.ts', hash: null }
    ]
  )
  assert.deepEqual(progress, { viewed: 1, total: 3 }, '已读进度按当前文件列表统计')
  assert.deepEqual([...viewed.viewedPathsOf({ 'E:/repo/a.ts': 'ab' }, root, [{ path: 'a.ts', hash: 'ab' }])], ['a.ts'], '已读文件集合')

  const viewedStore = fakeStorage()
  viewed.writeViewedFiles({ 'E:/repo/a.ts': 'ab' }, viewedStore)
  assert.deepEqual(viewed.readViewedFiles(viewedStore), { 'E:/repo/a.ts': 'ab' }, '已读状态写入并可读回')
  assert.deepEqual(viewed.readViewedFiles(fakeStorage({ [viewed.VIEWED_FILES_KEY]: 'broken' })), {}, '坏记录回退为空表')
  assert.deepEqual(viewed.readViewedFiles(hostile), {}, '读取抛错时安全回退')
  assert.doesNotThrow(() => viewed.writeViewedFiles({}, hostile), '写入抛错时不影响界面')

  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
  const after = before.slice()
  after[4] = 'line 5 changed'
  after.splice(20, 1)
  const beforeText = `${before.join('\n')}\n`
  const afterText = `${after.join('\n')}\n`
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -4,3 +4,3 @@',
    ' line 4',
    '-line 5',
    '+line 5 changed',
    ' line 6',
    '@@ -20,3 +20,2 @@',
    ' line 20',
    '-line 21',
    ' line 22',
    ''
  ].join('\n')
  const parsed = patchFiles.patchFiles(patch, 'src/a.ts', 'test')
  ok(parsed.kind === 'files' && parsed.files.length === 1, '补丁解析成单文件')
  const file = parsed.files[0]
  ok(patchFiles.canExpandContext(file), '只有补丁的修改文件可以补全上下文')
  ok(patchFiles.contentsMatchPatch(file, { before: beforeText, after: afterText }), '新旧全文与补丁一致时可展开')
  ok(
    patchFiles.contentsMatchPatch(file, { before: beforeText.replace(/\n/g, '\r\n'), after: afterText.replace(/\n/g, '\r\n') }),
    'CRLF 全文按 LF 比对'
  )
  ok(!patchFiles.contentsMatchPatch(file, { before: beforeText, after: afterText.replace('line 5 changed', 'line 5 again') }), '工作区已变化时拒绝展开')
  ok(!patchFiles.contentsMatchPatch(file, { before: 'x\n', after: 'y\n' }), '全文过短时拒绝展开')
  const added = patchFiles.patchFiles('diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n', 'n.ts', 'test')
  ok(!patchFiles.canExpandContext(added.files[0]), '新增文件不需要补全上下文')

  const hydrated = pierre.hydratePartialDiff('clone', file, patchFiles.loadedFiles(file, { before: beforeText, after: afterText }))
  ok(hydrated.isPartial === false, 'pierre 用全文把补丁补成完整 diff')
  ok(file.isPartial === true, 'clone 模式不改原补丁对象')
  ok(hydrated.hunks[0].collapsedBefore === 3, '首个分隔条前有 3 行未改动')
  ok(hydrated.hunks[1].collapsedBefore === 13, '两段改动之间有 13 行未改动')
  const lastEnd = hydrated.hunks[1].additionStart + hydrated.hunks[1].additionCount - 1
  ok(after.length - lastEnd === 8, '末段之后还有 8 行未改动')
  const expanded = patchFiles.annotationRange(hydrated, { start: 10, end: 11, side: 'additions', endSide: 'additions' })
  ok(expanded?.code === 'line 10\nline 11', '展开后的未改动行也能取到批注代码')

  const lines = patchFiles.keyboardLines([file])
  assert.deepEqual(
    lines.map((line) => `${line.kind}:${line.side}:${line.lineNumber}`),
    [
      'context:additions:4',
      'deletion:deletions:5',
      'addition:additions:5',
      'context:additions:6',
      'context:additions:20',
      'deletion:deletions:21',
      'context:additions:21'
    ],
    '键盘行序与统一视图一致'
  )
  checks++
  ok(lines[2].text === 'line 5 changed', '键盘行带代码文本')
  let cursor = patchFiles.moveKeyCursor(lines, null, 1, false)
  ok(cursor.focus === 1 && cursor.anchor === 1, '首次按方向键落在第一处改动')
  cursor = patchFiles.moveKeyCursor(lines, cursor, 1, false)
  ok(cursor.focus === 2, '方向键下移一行')
  ok(patchFiles.moveKeyCursor(lines, cursor, -99, false).focus === 0, '上移不越过首行')
  ok(patchFiles.moveKeyCursor(lines, cursor, 99, false).focus === lines.length - 1, '下移不越过末行')
  const extended = patchFiles.moveKeyCursor(lines, { anchor: 2, focus: 2 }, 1, true)
  ok(extended.anchor === 2 && extended.focus === 3, 'Shift 扩选保持锚点')
  ok(patchFiles.moveKeyCursor(lines, { anchor: 3, focus: 3 }, 2, true).focus === 3, '扩选不跨过未显示的折叠区')
  const skipDeletion = patchFiles.moveKeyCursor(lines, { anchor: 4, focus: 4 }, 2, true)
  ok(skipDeletion.focus === 6, '从新文件一侧扩选时跳过删除行')
  const range = patchFiles.keyCursorRange(lines, skipDeletion)
  assert.deepEqual(
    { side: range.side, start: range.start, end: range.end, count: range.count },
    { side: 'additions', start: 20, end: 21, count: 2 },
    '扩选范围按同一侧行号计算'
  )
  checks++
  const fromDeletion = patchFiles.moveKeyCursor(lines, { anchor: 1, focus: 1 }, 2, true)
  ok(fromDeletion.focus === 3, '从删除行扩选跳过新增行、包含未改动行')
  const oldRange = patchFiles.keyCursorRange(lines, fromDeletion)
  assert.deepEqual(
    { side: oldRange.side, start: oldRange.start, end: oldRange.end },
    { side: 'deletions', start: 5, end: 6 },
    '旧文件一侧的未改动行按旧行号计算'
  )
  checks++
  ok(
    patchFiles.annotationRange(file, { start: 5, end: 6, side: 'deletions', endSide: 'deletions' })?.code === 'line 5\nline 6',
    '旧文件一侧的扩选可生成批注代码'
  )
  const single = patchFiles.keyCursorRange(lines, { anchor: 1, focus: 1 })
  ok(single.side === 'deletions' && single.start === 5 && single.end === 5, '删除行选择落在旧文件一侧')
  const resolved = patchFiles.annotationRange(file, { start: single.start, end: single.end, side: single.side, endSide: single.side })
  ok(resolved?.code === 'line 5', '键盘选择可直接生成批注代码')
  ok(patchFiles.moveKeyCursor([], null, 1, false) === null, '没有可选行时不建光标')

  ok(keys.annotationKeyAction({ key: 'Enter', shiftKey: false }) === 'submit', 'Enter 发送批注')
  ok(keys.annotationKeyAction({ key: 'Enter', shiftKey: true }) === null, 'Shift+Enter 换行')
  ok(keys.annotationKeyAction({ key: 'Escape', shiftKey: false }) === 'cancel', 'Esc 取消批注')
  ok(keys.annotationKeyAction({ key: 'Enter', shiftKey: false, isComposing: true }) === null, '输入法组字时 Enter 不发送')
  ok(keys.annotationKeyAction({ key: 'Enter', shiftKey: false, keyCode: 229 }) === null, '输入法 keyCode 229 不发送')
  ok(keys.annotationKeyAction({ key: 'Escape', shiftKey: false, isComposing: true }) === null, '输入法组字时 Esc 不取消')
} finally {
  await rm(outdir, { recursive: true, force: true })
}

console.log(`\ntest-changes-review: ${checks} checks passed`)
