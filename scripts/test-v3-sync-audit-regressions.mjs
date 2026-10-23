import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-sync-audit-'))
const bundleFile = join(root, 'sync.mjs')
let passed = 0
let skipped = 0
const check = async (name, run) => {
  await run()
  passed++
  console.log(`PASS ${name}`)
}
const put = async (file, content) => {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, content)
}
try {
  await build({
    stdin: {
      contents: "export * from './src/main/sync/index.ts'; export * from './src/main/sync/local-store.ts'; export * from './src/main/sync/sync-folder.ts'",
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile: bundleFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning'
  })
  const { SyncService, SyncFolder, LocalStore, defaultSyncPaths, importSession, readSessionId } = await import(pathToFileURL(bundleFile).href)
  const fixture = async () => {
    const dir = join(root, randomUUID())
    const cloud = join(dir, 'cloud')
    const aDir = join(dir, 'a')
    const bDir = join(dir, 'b')
    const aFile = join(aDir, 'prompts', 'review.md')
    const bFile = join(bDir, 'prompts', 'review.md')
    await mkdir(cloud, { recursive: true })
    await put(aFile, 'base')
    const a = new SyncService({ dataDir: aDir, syncRoot: cloud, piAgentDir: aDir, deviceId: 'a' })
    const b = new SyncService({ dataDir: bDir, syncRoot: cloud, piAgentDir: bDir, deviceId: 'b' })
    for (const service of [a, b]) assert.equal((await service.sync()).ok, true)
    await writeFile(aFile, 'remote-old')
    await writeFile(bFile, 'local-old')
    await a.sync()
    const report = await b.sync()
    assert.equal(report.conflicts.length, 1)
    return { a, b, aFile, bFile, conflict: report.conflicts[0], folder: new SyncFolder(cloud) }
  }
  for (const resolution of ['local', 'remote', 'both']) {
    for (const changed of ['local', 'remote', 'both', 'deleted-local', 'deleted-remote']) {
      await check(`旧冲突 ${resolution} / ${changed} 拒绝且保留两端`, async () => {
        const f = await fixture()
        const local = changed === 'local' || changed === 'both' ? 'local-new' : 'local-old'
        const remote = changed === 'remote' || changed === 'both' ? 'remote-new' : 'remote-old'
        if (changed === 'deleted-local') await unlink(f.bFile)
        else await writeFile(f.bFile, local)
        if (changed === 'deleted-remote') {
          const files = await readdir(join(f.folder.recordsDir, 'prompt'))
          for (const file of files) await unlink(join(f.folder.recordsDir, 'prompt', file))
        } else if (remote === 'remote-new') {
          await writeFile(f.aFile, remote)
          await f.a.sync()
        }
        assert.equal((await f.b.resolveConflict(f.conflict.id, resolution)).ok, false)
        if (changed === 'deleted-local') assert.equal(existsSync(f.bFile), false)
        else assert.equal(await readFile(f.bFile, 'utf8'), local)
        const record = (await f.folder.readRecords()).records.get('prompt:review')
        assert.equal(record?.payload, changed === 'deleted-remote' ? undefined : remote)
        const conflicts = await f.b.listConflicts()
        assert.equal(conflicts.length, 1)
        if (!changed.startsWith('deleted')) {
          assert.notEqual(conflicts[0].id, f.conflict.id)
          assert.equal(conflicts[0].localPayload, local)
          assert.equal(conflicts[0].remotePayload, remote)
          assert.equal((await f.b.resolveConflict(f.conflict.id, resolution)).ok, false)
          assert.equal((await f.b.resolveConflict(conflicts[0].id, resolution)).ok, true)
        }
      })
    }
    await check(`未变化冲突 ${resolution} 仍可处理`, async () => {
      const f = await fixture()
      assert.equal((await f.b.resolveConflict(f.conflict.id, resolution)).ok, true)
      assert.equal(await readFile(f.bFile, 'utf8'), resolution === 'remote' ? 'remote-old' : 'local-old')
      assert.equal((await f.b.listConflicts()).length, 0)
      if (resolution === 'both') {
        const names = await readdir(join(f.bFile, '..'))
        assert.equal(names.length, 2)
        assert.equal(await readFile(join(f.bFile, '..', names.find(name => name !== 'review.md')), 'utf8'), 'remote-old')
      }
    })
  }
  await check('两端重读异常不应用旧冲突', async () => {
    const f = await fixture()
    await put(join(f.folder.recordsDir, 'prompt', 'broken.json'), '{')
    assert.equal((await f.b.resolveConflict(f.conflict.id, 'remote')).ok, false)
    assert.equal(await readFile(f.bFile, 'utf8'), 'local-old')
    assert.equal((await f.b.listConflicts()).length, 1)
  })
  const skillDir = join(root, 'skill-store')
  const paths = defaultSyncPaths(skillDir)
  const store = new LocalStore(paths)
  const skill = name => ({ key: `skill:${name}`, kind: 'skill', payload: 'incoming', modifiedAt: 1 })
  await put(join(skillDir, 'SKILL.md'), 'parent-safe')
  for (const name of ['.', '..', '../escape', 'x/../../escape', 'x\\..\\escape']) {
    await check(`拒绝技能路径 ${name}`, async () => {
      await assert.rejects(store.apply(skill(name)))
      assert.equal(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), 'parent-safe')
    })
  }
  await check('正常技能仍可创建和读取', async () => {
    await store.apply(skill('normal-skill'))
    assert.equal(await readFile(join(paths.skillsDir, 'normal-skill', 'SKILL.md'), 'utf8'), 'incoming')
    assert.equal((await store.readAll()).records.some(record => record.key === 'skill:normal-skill'), true)
  })
  await check('拒绝目录链接真实路径越界和同前缀兄弟目录', async () => {
    const outside = `${paths.skillsDir}-outside`
    await put(join(outside, 'SKILL.md'), 'outside-safe')
    await symlink(outside, join(paths.skillsDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(store.apply(skill('escape')), /越界/)
    assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), 'outside-safe')
  })
  await check('拒绝悬空目录链接，不在外部创建目录', async () => {
    const outside = join(root, 'missing-outside')
    await symlink(outside, join(paths.skillsDir, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(store.apply(skill('dangling')))
    assert.equal(existsSync(outside), false)
  })
  const externalFile = join(root, 'external-SKILL.md')
  await writeFile(externalFile, 'external-safe')
  await mkdir(join(paths.skillsDir, 'file-link'))
  try {
    await symlink(externalFile, join(paths.skillsDir, 'file-link', 'SKILL.md'), 'file')
    await check('拒绝 SKILL.md 文件链接越界（读和写）', async () => {
      await assert.rejects(store.apply(skill('file-link')), /越界/)
      const result = await store.readAll()
      assert.equal(result.records.some(record => record.key === 'skill:file-link'), false)
      assert.ok(result.skipped.some(item => item.includes('越界')))
      assert.equal(await readFile(externalFile, 'utf8'), 'external-safe')
    })
  } catch (error) {
    if (error.code !== 'EPERM') throw error
    skipped++
    console.log('SKIP 文件符号链接需要系统权限')
  }
  const sessionRoot = join(root, 'sessions')
  const original = join(sessionRoot, 'original.jsonl')
  await put(original, 'original-safe')
  const importContent = async (content, ids = ['original', 'fresh']) => {
    const file = join(root, `session-${randomUUID()}.json`)
    await writeFile(file, JSON.stringify({ v: 1, kind: 'inkstone-session', content }))
    return importSession(file, sessionRoot, { newId: () => ids.shift() ?? randomUUID() })
  }
  for (const header of ['{"type": "session", "id": "original"}', '\t{ "id" : "original", "type"\t:\t"session" }\r', '{"type":"session","id":"original"}']) {
    await check(`合法 JSON 空白改写头 ${JSON.stringify(header)}`, async () => {
      const body = '\n{"type":"message","id":"m1","message":{"role":"user","content":"unchanged"}}\n'
      const id = randomUUID()
      const result = await importContent(`\n${header}${body}`, ['original', id])
      assert.equal(result.ok, true, result.error)
      assert.equal(result.sessionId, id)
      assert.equal(result.renamedFrom, 'original')
      const content = await readFile(result.path, 'utf8')
      assert.equal(readSessionId(content), id)
      assert.ok(content.endsWith(body))
      assert.equal(await readFile(original, 'utf8'), 'original-safe')
    })
  }
  for (const content of [' ', '{"type":"message","id":"original"}', '{"type":"session"}', '{"type":"session","id":"  "}', '{"type":"session","id":42}', '{"type":"session","id":"a"}\n{"type":"session","id":"b"}']) {
    await check(`无有效唯一会话头拒绝 ${content}`, async () => {
      const before = await readdir(sessionRoot)
      assert.equal((await importContent(content)).ok, false)
      assert.deepEqual(await readdir(sessionRoot), before)
    })
  }
  await check('即使源文件不存在也不复用原 ID', async () => {
    const result = await importContent('{"type": "session", "id": "absent-source"}', ['absent-source', 'different-id'])
    assert.equal(result.ok, true, result.error)
    assert.equal(result.sessionId, 'different-id')
  })
  console.log(`同步审查回归：${passed} 通过，${skipped} 跳过`)
} finally {
  await rm(root, { recursive: true, force: true })
}
