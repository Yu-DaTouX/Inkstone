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
      'src/renderer/src/features/changes/viewed-files.ts'
    ],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const tests = await import(pathToFileURL(join(outdir, 'test-files.js')).href)
  const viewed = await import(pathToFileURL(join(outdir, 'viewed-files.js')).href)

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
} finally {
  await rm(outdir, { recursive: true, force: true })
}

console.log(`\ntest-changes-review: ${checks} checks passed`)
