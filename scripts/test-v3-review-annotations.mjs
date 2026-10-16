/**
 * 评审批注存储单测（WP-50）。
 *
 * 用 esbuild 现场编译 `src/main/review/annotations.ts`，在隔离临时目录里跑，
 * **不启动 Electron、不写用户数据目录、不碰真实仓库**。可独立执行：
 *
 *   node scripts/test-v3-review-annotations.mjs
 *
 * 覆盖：
 *   · 原子串行持久：并发写入全部落盘，版本号连续、无丢失；
 *   · scope / 目录校验：文件名非法拒绝；已建立文档后换 scopeKey 拒绝（迟到写防错归属）；
 *   · 上限：正文过长、路径穿越（`..` / 绝对路径）、行号倒置都被拒；
 *   · 坏条目读盘容错：坏 JSON 条目丢弃，不让整份文档失败。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return outfile
}

let step = 0
function ok(label) {
  step += 1
  console.log(`  ok ${step}. ${label}`)
}

const repoRoot = join(process.cwd(), 'src', 'main', 'review', 'annotations.ts')
const outDir = await mkdtemp(join(tmpdir(), 'yan-review-ann-'))
const dataRoot = await mkdtemp(join(tmpdir(), 'yan-review-ann-data-'))

try {
  const mod = await import(pathToFileURL(await compile(repoRoot, join(outDir, 'annotations.mjs'))).href)
  const { ReviewAnnotationStore, annotationFileName } = mod

  const base = {
    changeSetId: 'uncommitted-abc12345',
    scopeKey: 'uncommitted|/repo|/repo|',
    path: 'src/a.ts',
    lineStart: 10,
    body: '这里要兼容旧 token'
  }

  // 1. 文件名与基本写入
  assert.equal(annotationFileName('uncommitted-abc12345'), 'uncommitted-abc12345.json')
  assert.equal(annotationFileName('../evil'), null)
  assert.equal(annotationFileName('a/b'), null)
  ok('变更集 id → 安全文件名，非法字符拒绝')

  const store = new ReviewAnnotationStore({ root: dataRoot })
  const created = await store.create(base)
  assert.equal(created.ok, true)
  assert.equal(created.revision, 1)
  assert.ok(created.annotation?.id)
  ok('创建批注成功，revision=1')

  const listed = await store.list(base.changeSetId, base.scopeKey)
  assert.equal(listed.ok, true)
  assert.equal(listed.annotations.length, 1)
  assert.equal(listed.annotations[0].path, 'src/a.ts')
  assert.equal(listed.annotations[0].lineEnd, 10)
  ok('list 读回同一条批注')

  // 2. scope 不匹配（迟到写防错归属）
  const wrongScope = await store.create({ ...base, path: 'src/b.ts', scopeKey: 'session|/repo|/repo|s1' })
  assert.equal(wrongScope.ok, false)
  assert.match(wrongScope.error, /归属/)
  const listedAfter = await store.list(base.changeSetId, base.scopeKey)
  assert.equal(listedAfter.annotations.length, 1)
  ok('换 scopeKey 的迟到写被拒，原批注不受影响')

  // 3. 上限与路径校验
  assert.equal((await store.create({ ...base, body: '' })).ok, false)
  assert.equal((await store.create({ ...base, body: 'x'.repeat(8001) })).ok, false)
  assert.equal((await store.create({ ...base, path: '../etc/passwd' })).ok, false)
  assert.equal((await store.create({ ...base, path: 'C:\\Windows\\system32' })).ok, false)
  assert.equal((await store.create({ ...base, lineStart: 100, lineEnd: 50 })).ok, false)
  assert.equal((await store.create({ ...base, lineStart: 100, lineEnd: 200000 })).ok, false)
  ok('正文 / 路径穿越 / 行号倒置与超跨度全部拒绝')

  // 4. 更新 / 删除 / 清空
  const id = created.annotation.id
  const updated = await store.update(base.changeSetId, base.scopeKey, id, { body: '改成新的批注' })
  assert.equal(updated.ok, true)
  assert.equal(updated.annotation.body, '改成新的批注')
  const removed = await store.remove(base.changeSetId, base.scopeKey, id)
  assert.equal(removed.ok, true)
  assert.equal((await store.list(base.changeSetId, base.scopeKey)).annotations.length, 0)
  ok('update / remove 生效且持久')

  // 5. 并发原子串行：20 条同时写，版本连续、全部落盘
  const many = new ReviewAnnotationStore({ root: dataRoot })
  const jobs = []
  for (let i = 0; i < 20; i++) {
    jobs.push(many.create({ ...base, changeSetId: 'session-concurrent', scopeKey: 'session|/r|/r|s1', path: `src/f${i}.ts`, body: `第 ${i} 条` }))
  }
  const results = await Promise.all(jobs)
  assert.equal(results.every((r) => r.ok), true)
  const finalList = await many.list('session-concurrent', 'session|/r|/r|s1')
  assert.equal(finalList.annotations.length, 20)
  assert.equal(finalList.revision, 20)
  const revisions = results.map((r) => r.revision).sort((a, b) => a - b)
  assert.deepEqual(revisions, Array.from({ length: 20 }, (_, i) => i + 1))
  ok('20 条并发写入串行落盘，版本 1..20 连续且无丢失')

  // 6. 落盘文件真的是 JSON 且带 scopeKey
  const raw = JSON.parse(await readFile(join(dataRoot, 'review', 'annotations', 'session-concurrent.json'), 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.scopeKey, 'session|/r|/r|s1')
  assert.equal(raw.annotations.length, 20)
  ok('落盘文档结构正确（version / scopeKey / annotations）')

  // 7. 坏条目读盘容错
  const badStore = new ReviewAnnotationStore({ root: dataRoot })
  await badStore.create({ changeSetId: 'corrupt-doc', scopeKey: 'k', path: 'a.ts', lineStart: 1, body: 'ok' })
  const corruptPath = join(dataRoot, 'review', 'annotations', 'corrupt-doc.json')
  const doc = JSON.parse(await readFile(corruptPath, 'utf8'))
  doc.annotations.push({ id: 'bad', path: 'x.ts' }) // 缺 body / 行号
  const { writeFile } = await import('node:fs/promises')
  await writeFile(corruptPath, JSON.stringify(doc))
  const reloaded = new ReviewAnnotationStore({ root: dataRoot })
  const reloadList = await reloaded.list('corrupt-doc', 'k')
  assert.equal(reloadList.ok, true)
  assert.equal(reloadList.annotations.length, 1)
  ok('坏条目在重新读盘时被丢弃，不拖垮整份文档')

  console.log('\n评审批注存储：全部通过')
} finally {
  await rm(outDir, { recursive: true, force: true })
  await rm(dataRoot, { recursive: true, force: true })
}
