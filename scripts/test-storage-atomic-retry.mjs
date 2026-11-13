#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const report = { pass: 0, fail: 0 }
async function check(message, fn) {
  try {
    await fn()
    report.pass += 1
    process.stdout.write(`  ✓ ${message}\n`)
  } catch (error) {
    report.fail += 1
    process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const stub = `
const real = process.getBuiltinModule('fs/promises')
export const lstat = (...a) => real.lstat(...a)
export const mkdir = (...a) => real.mkdir(...a)
export const open = (...a) => real.open(...a)
export const rm = (...a) => real.rm(...a)
export const writeFile = (...a) => real.writeFile(...a)
export async function rename(from, to) {
  const plan = globalThis.__atomicFailPlan ?? []
  const step = plan[0]
  globalThis.__atomicRenameCount = (globalThis.__atomicRenameCount ?? 0) + 1
  if (step && step.match(from, to)) {
    plan.shift()
    if (step.code) {
      const error = new Error('stub ' + step.code)
      error.code = step.code
      throw error
    }
  }
  return real.rename(from, to)
}
`

const buildResult = await build({
  entryPoints: ['src/main/atomic-write.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'fs-failure-stub',
      setup(builder) {
        builder.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'fs-promises-stub', namespace: 'stub' }))
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub, loader: 'js' }))
      }
    }
  ]
})
const code = buildResult.outputFiles[0].text
const { atomicWriteFile } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const leftovers = (names) => names.filter((name) => name.endsWith('.tmp') || name.endsWith('.bak'))
async function clearLeftovers() {
  for (const name of await readdir(root)) {
    if (name.endsWith('.tmp') || name.endsWith('.bak')) await rm(join(root, name), { force: true })
  }
}
const plan = (...steps) => {
  globalThis.__atomicFailPlan = steps
  globalThis.__atomicRenameCount = 0
}
const failRename = (code, match) => ({ code, match })
const toTarget = (file) => (from, to) => from.endsWith('.tmp') && to === file
const toBackup = (file) => (from, to) => from === file && to.endsWith('.bak')
const fromBackup = (file) => (from, to) => from.endsWith('.bak') && to === file

const root = await mkdtemp(join(tmpdir(), 'yan-atomic-retry-'))
try {
  process.stdout.write('\n▌原子写：EBUSY 退避仍然保留\n')
  const target = join(root, 'index.json')
  await writeFile(target, 'old')

  await check('目标被短暂占用时继续重试，写入成功且不留临时文件', async () => {
    plan(failRename('EBUSY', toTarget(target)), failRename('EBUSY', toTarget(target)))
    await atomicWriteFile(target, 'new')
    assert.equal(await readFile(target, 'utf8'), 'new')
    assert.equal(globalThis.__atomicRenameCount, 3, '两次失败后第三次成功')
    assert.deepEqual(leftovers(await readdir(root)), [])
  })

  await check('EBUSY 一直失败时共尝试 9 次再走回退', async () => {
    await writeFile(target, 'old2')
    const alwaysFail = () => failRename('EBUSY', toTarget(target))
    plan(alwaysFail(), alwaysFail(), alwaysFail(), alwaysFail(), alwaysFail(), alwaysFail(), alwaysFail(), alwaysFail(), alwaysFail(), alwaysFail())
    await atomicWriteFile(target, 'new2').catch(() => undefined)
    assert.ok(globalThis.__atomicRenameCount >= 9, `至少 9 次 rename，实际 ${globalThis.__atomicRenameCount}`)
  })

  process.stdout.write('\n▌原子写：EPERM 回退分支\n')
  await check('EPERM 时先备份原文件再放新内容，成功后不留 .bak', async () => {
    await writeFile(target, 'orig')
    await rm(join(root, 'x'), { force: true }).catch(() => undefined)
    for (const name of await readdir(root)) if (name.endsWith('.bak')) await rm(join(root, name), { force: true })
    const planSteps = []
    for (let i = 0; i < 9; i += 1) planSteps.push(failRename('EPERM', toTarget(target)))
    plan(...planSteps)
    await atomicWriteFile(target, 'replaced')
    assert.equal(await readFile(target, 'utf8'), 'replaced')
    assert.deepEqual(leftovers(await readdir(root)), [])
  })

  await check('回退也失败时原内容留在 .bak 里，不被删除', async () => {
    await writeFile(target, 'keep-me')
    for (const name of await readdir(root)) if (name.endsWith('.bak')) await rm(join(root, name), { force: true })
    const planSteps = []
    for (let i = 0; i < 9; i += 1) planSteps.push(failRename('EPERM', toTarget(target)))
    for (let i = 0; i < 9; i += 1) planSteps.push(failRename('EPERM', toTarget(target)))
    for (let i = 0; i < 9; i += 1) planSteps.push(failRename('EBUSY', fromBackup(target)))
    plan(...planSteps)
    let failure = null
    try {
      await atomicWriteFile(target, 'lost')
    } catch (error) {
      failure = error
    }
    assert.ok(failure, '写入应当失败')
    const names = await readdir(root)
    const backups = names.filter((name) => name.endsWith('.bak'))
    assert.equal(backups.length, 1, `应保留唯一备份，实际 ${JSON.stringify(names)}`)
    assert.equal(await readFile(join(root, backups[0]), 'utf8'), 'keep-me', '备份里是原内容')
    assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), [], '不留下临时文件')
    assert.ok(!names.includes('index.json'), '回滚失败时目标文件暂时不存在')
    await clearLeftovers()
  })

  process.stdout.write('\n▌原子写：目标是目录时不误删内容\n')
  await check('目标为目录时立即失败，不写 .bak、不长时间重试', async () => {
    const dir = join(root, 'dir-target')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'inner.txt'), 'keep')
    await clearLeftovers()
    globalThis.__atomicFailPlan = []
    globalThis.__atomicRenameCount = 0
    const started = Date.now()
    let failure = null
    try {
      await atomicWriteFile(dir, 'x')
    } catch (error) {
      failure = error
    }
    const elapsed = Date.now() - started
    assert.ok(failure, '写入目录应失败')
    assert.equal(await readFile(join(dir, 'inner.txt'), 'utf8'), 'keep')
    assert.deepEqual(leftovers(await readdir(root)), [])
    assert.ok(elapsed < 1500, `目录目标不应等满退避，实际 ${elapsed}ms`)
  })

  process.stdout.write('\n▌原子写：成功路径\n')
  await check('新文件与替换都正常，不留临时文件', async () => {
    globalThis.__atomicFailPlan = []
    const fresh = join(root, 'fresh.json')
    await atomicWriteFile(fresh, 'one')
    assert.equal(await readFile(fresh, 'utf8'), 'one')
    await atomicWriteFile(fresh, 'two')
    assert.equal(await readFile(fresh, 'utf8'), 'two')
    assert.deepEqual(leftovers(await readdir(root)), [])
  })
} finally {
  delete globalThis.__atomicFailPlan
  delete globalThis.__atomicRenameCount
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 原子写退避：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
