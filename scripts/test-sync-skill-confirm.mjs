#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const built = await build({
  entryPoints: ['src/main/sync/service.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { SyncService } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const work = await mkdtemp(join(process.cwd(), '.tmp', 'sync-confirm-'))
const root = join(work, 'shared')
const dirA = join(work, 'device-a')
const dirB = join(work, 'device-b')
for (const dir of [root, dirA, dirB]) await mkdir(dir, { recursive: true })

const state = { decision: false, onConfirm: null, seen: [] }
const a = new SyncService({ dataDir: dirA, syncRoot: root, deviceId: 'device-a', deviceName: 'A' })
const b = new SyncService({
  dataDir: dirB,
  syncRoot: root,
  deviceId: 'device-b',
  deviceName: 'B',
  confirmImport: async (candidate) => {
    state.seen.push(candidate)
    if (state.onConfirm) await state.onConfirm(candidate)
    return state.decision
  }
})
const writeSkill = async (dir, name, text) => {
  await mkdir(join(dir, 'skills', name), { recursive: true })
  await writeFile(join(dir, 'skills', name, 'SKILL.md'), text)
}
const readSkill = (dir, name) => readFile(join(dir, 'skills', name, 'SKILL.md'), 'utf8')
const exists = (file) => readFile(file).then(() => true, () => false)

try {
  process.stdout.write('\n▌同步来的技能必须逐项确认（E3）\n')
  await writeSkill(dirA, 'demo', 'A 第一版\n')
  await a.sync()

  await check('没确认时不写入本机技能', async () => {
    state.decision = false
    state.seen.length = 0
    const result = await b.sync()
    assert.equal(await exists(join(dirB, 'skills', 'demo', 'SKILL.md')), false, '不应落盘')
    assert.equal(state.seen.length, 1, '应当问过一次')
    assert.equal(state.seen[0].name, 'demo')
    assert.equal(state.seen[0].previous, undefined, '新技能没有旧内容')
    assert.ok(result.skipped.some((note) => note.includes('技能')), JSON.stringify(result))
  })

  await check('确认后才写入，内容与同步来源一致', async () => {
    state.decision = true
    state.seen.length = 0
    await b.sync()
    assert.equal(await readSkill(dirB, 'demo'), 'A 第一版\n')
    assert.equal(state.seen.length, 1)
  })

  await check('内容相同就不重复询问也不重写', async () => {
    state.seen.length = 0
    await b.sync()
    assert.equal(state.seen.length, 0, '没有变化时不问')
  })

  await check('等待确认期间本机被改过时保留本机内容并跳过', async () => {
    await writeSkill(dirA, 'demo', 'A 第二版\n')
    await a.sync()
    state.decision = true
    state.seen.length = 0
    state.onConfirm = async () => {
      await writeSkill(dirB, 'demo', '本机刚改的\n')
    }
    const result = await b.sync()
    state.onConfirm = null
    assert.equal(await readSkill(dirB, 'demo'), '本机刚改的\n', '不能被旧同步值覆盖')
    assert.equal(state.seen.length, 1, '确认过程确实发生了')
    assert.ok(result.skipped.some((note) => note.includes('被改过')), JSON.stringify(result))
  })

  await check('之后再同步按冲突处理，不自动覆盖本机', async () => {
    state.decision = true
    const result = await b.sync()
    assert.equal(await readSkill(dirB, 'demo'), '本机刚改的\n')
    assert.equal(result.conflicts.length >= 1, true, JSON.stringify(result))
  })

  process.stdout.write('\n▌同步来的提示词模板同样要确认\n')
  await mkdir(join(dirA, 'prompts'), { recursive: true })
  await writeFile(join(dirA, 'prompts', 'weekly.md'), 'A 模板\n')
  await a.sync()

  await check('模板没确认时不写入', async () => {
    state.decision = false
    state.seen.length = 0
    const result = await b.sync()
    assert.equal(await exists(join(dirB, 'prompts', 'weekly.md')), false)
    assert.ok(state.seen.some((candidate) => candidate.kind === 'prompt'), '应当按模板询问')
    assert.ok(result.skipped.some((note) => note.includes('模板')), JSON.stringify(result))
  })

  await check('模板确认后写入', async () => {
    state.decision = true
    await b.sync()
    assert.equal(await readFile(join(dirB, 'prompts', 'weekly.md'), 'utf8'), 'A 模板\n')
  })

  await check('没有注入确认入口时（后台自动同步）一律不落盘', async () => {
    const dirC = join(work, 'device-c')
    await mkdir(dirC, { recursive: true })
    const c = new SyncService({ dataDir: dirC, syncRoot: root, deviceId: 'device-c', deviceName: 'C' })
    const result = await c.sync()
    assert.equal(await exists(join(dirC, 'skills', 'demo', 'SKILL.md')), false)
    assert.ok(result.skipped.length >= 1, JSON.stringify(result))
  })

  process.stdout.write('\n▌冲突副本不覆盖已有文件\n')
  await check('解析冲突时保留副本只写新文件，已存在就失败', async () => {
    const { LocalStore } = await import(
      `data:text/javascript;base64,${Buffer.from((await build({ entryPoints: ['src/main/sync/local-store.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })).outputFiles[0].text).toString('base64')}`
    )
    const store = new LocalStore({ settingsFile: join(work, 'x.json'), promptsDir: join(work, 'prompts'), skillsDir: join(dirB, 'skills'), interactionStateDir: join(work, 'state') })
    await assert.rejects(() => store.applyCopy({ key: 'skill:demo', kind: 'skill', payload: '覆盖？', modifiedAt: 1 }))
    assert.equal(await readSkill(dirB, 'demo'), '本机刚改的\n')
    const copy = await store.applyCopy({ key: 'skill:copy-only', kind: 'skill', payload: '副本\n', modifiedAt: 1 })
    assert.equal(copy, undefined)
    assert.equal(await readSkill(dirB, 'copy-only'), '副本\n')
  })
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 同步技能确认：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
