#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`)
  }
}

const data = await mkdtemp(join(tmpdir(), 'yan-cp-refs-data-'))
process.env.YAN_DATA_DIR = data
const SMALL = 5

const built = await build({
  entryPoints: ['src/main/checkpoints.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'small-max-records',
    setup(b) {
      b.onLoad({ filter: /main[\\/]checkpoints\.ts$/ }, async (args) => {
        const text = await readFile(args.path, 'utf8')
        assert.ok(text.includes('const MAX_RECORDS = 400'), 'MAX_RECORDS 常量仍是 400')
        return { contents: text.replace('const MAX_RECORDS = 400', `const MAX_RECORDS = ${SMALL}`), loader: 'ts' }
      })
    }
  }]
})
const cp = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const git = (args) => execFileSync('git', args, { encoding: 'utf8' })
const refsOf = (repo) => git(['--git-dir', repo, 'for-each-ref', '--format=%(refname)', 'refs/cp/']).split('\n').filter(Boolean)
async function projectDirOf(cwd) {
  for (const name of await readdir(join(data, 'checkpoints')).catch(() => [])) {
    const dir = join(data, 'checkpoints', name)
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8').catch(() => 'null') ?? 'null')
    if (index?.cwd && index.cwd.replace(/\\/g, '/').toLowerCase() === cwd.replace(/\\/g, '/').toLowerCase()) return dir
  }
  return null
}
const readIndexOf = async (dir) => JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function snapshots(proj, session, count, label) {
  for (let i = 0; i < count; i += 1) {
    await writeFile(join(proj, 'a.txt'), `${label} ${i} ${Math.random()}\n`)
    assert.ok(await cp.captureCheckpoint(proj, session, `${label}-${i}`), `第 ${i} 次快照应成功`)
  }
}

try {
  console.log('\n▌超过记录上限后回收被丢弃记录的 ref（E-03）')
  const proj = await mkdtemp(join(tmpdir(), 'yan-cp-refs-proj-'))
  await check(`上限缩到 ${SMALL} 后，ref 数不超过索引条数`, async () => {
    await snapshots(proj, 's1', SMALL + 4, 'trim')
    const dir = await projectDirOf(proj)
    const index = await readIndexOf(dir)
    assert.equal(index.records.length, SMALL)
    const refs = refsOf(join(dir, 'repo.git'))
    assert.ok(refs.length <= index.records.length, `refs=${refs.length} records=${index.records.length}`)
    const alive = new Set(index.records.map((r) => `refs/cp/${r.sha}`))
    for (const ref of refs) assert.ok(alive.has(ref), `多余的 ref ${ref}`)
  })

  await check('存活记录对应的 ref 都还在', async () => {
    const dir = await projectDirOf(proj)
    const index = await readIndexOf(dir)
    const refs = new Set(refsOf(join(dir, 'repo.git')))
    for (const record of index.records) assert.ok(refs.has(`refs/cp/${record.sha}`))
    const list = await cp.listCheckpoints(proj, 's1')
    assert.equal(list.length, SMALL)
  })

  await check('内容没变时多条记录共用同一个 sha，丢弃旧记录不会删掉仍在使用的 ref', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'yan-cp-refs-shared-'))
    try {
      await writeFile(join(shared, 'a.txt'), 'same\n')
      for (let i = 0; i < SMALL + 3; i += 1) assert.ok(await cp.captureCheckpoint(shared, 's-shared', `same-${i}`))
      const dir = await projectDirOf(shared)
      const index = await readIndexOf(dir)
      const shas = new Set(index.records.map((r) => r.sha))
      assert.equal(shas.size, 1)
      const refs = refsOf(join(dir, 'repo.git'))
      assert.deepEqual(refs, [`refs/cp/${[...shas][0]}`])
    } finally {
      await rm(shared, { recursive: true, force: true })
    }
  })

  console.log('\n▌索引损坏重置时不删 ref')
  await check('索引损坏被重置后，旧 ref 全部保留，旧索引留有备份', async () => {
    const dir = await projectDirOf(proj)
    const before = refsOf(join(dir, 'repo.git'))
    assert.ok(before.length >= SMALL)
    await writeFile(join(dir, 'index.json'), '{ not json')
    await writeFile(join(proj, 'a.txt'), `after corrupt ${Math.random()}\n`)
    assert.ok(await cp.captureCheckpoint(proj, 's1', 'after-corrupt'))
    const index = await readIndexOf(dir)
    assert.equal(index.records.length, 1)
    const after = new Set(refsOf(join(dir, 'repo.git')))
    for (const ref of before) assert.ok(after.has(ref), `被误删：${ref}`)
    assert.ok((await readdir(dir)).some((name) => name.startsWith('index.json.corrupt-')))
  })

  await check('有损坏备份的项目，prune 不把索引外的 ref 当孤儿回收', async () => {
    const dir = await projectDirOf(proj)
    const before = refsOf(join(dir, 'repo.git')).length
    await cp.pruneCheckpoints(Date.now())
    assert.equal(refsOf(join(dir, 'repo.git')).length, before)
  })

  console.log('\n▌prune 回收孤儿 ref 与过期记录的 ref（E-03）')
  const proj2 = await mkdtemp(join(tmpdir(), 'yan-cp-refs-proj2-'))
  await check('索引可信时，prune 回收索引之外的历史遗留 ref', async () => {
    await snapshots(proj2, 's2', 3, 'orphan')
    const dir = await projectDirOf(proj2)
    const repo = join(dir, 'repo.git')
    const index = await readIndexOf(dir)
    const orphan = index.records[0].sha
    const dropped = { ...index, records: index.records.slice(1) }
    await writeFile(join(dir, 'index.json'), JSON.stringify(dropped))
    assert.equal(refsOf(repo).length, 3)
    await cp.pruneCheckpoints(Date.now())
    const refs = refsOf(repo)
    assert.equal(refs.length, 2)
    assert.ok(!refs.includes(`refs/cp/${orphan}`))
    for (const record of dropped.records) assert.ok(refs.includes(`refs/cp/${record.sha}`))
  })

  await check('prune 剔除过期记录时同步删除它们的 ref，保留未过期的', async () => {
    const dir = await projectDirOf(proj2)
    const repo = join(dir, 'repo.git')
    const index = await readIndexOf(dir)
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000
    index.records[0].at = old
    await writeFile(join(dir, 'index.json'), JSON.stringify(index))
    const expiredSha = index.records[0].sha
    await cp.pruneCheckpoints(Date.now())
    const refs = refsOf(repo)
    assert.ok(!refs.includes(`refs/cp/${expiredSha}`))
    assert.ok(refs.includes(`refs/cp/${index.records[1].sha}`))
    assert.equal((await readIndexOf(dir)).records.length, 1)
  })

  console.log('\n▌prune 占锁期间 capture 被跳过时留下明确状态（E-11）')
  const proj3 = await mkdtemp(join(tmpdir(), 'yan-cp-refs-proj3-'))
  await check('gc 占锁时 capture 返回 null、记录 skip 状态并输出日志', async () => {
    for (let i = 0; i < 120; i += 1) await writeFile(join(proj3, `f${i}.txt`), `file ${i}\n`)
    await snapshots(proj3, 's3', 3, 'gc')
    const dir = await projectDirOf(proj3)
    const index = await readIndexOf(dir)
    index.records[0].at = Date.now() - 40 * 24 * 60 * 60 * 1000
    await writeFile(join(dir, 'index.json'), JSON.stringify(index))
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => { warnings.push(args.join(' ')) }
    let sawMaintenance = false
    try {
      const pruning = cp.pruneCheckpoints(Date.now())
      for (let i = 0; i < 400 && !sawMaintenance; i += 1) {
        const result = await cp.captureCheckpoint(proj3, 's3', 'during-gc', 5)
        if (result === null && cp.checkpointSkipState(proj3)?.reason === 'maintenance') sawMaintenance = true
        await sleep(2)
      }
      await pruning
    } finally {
      console.warn = originalWarn
    }
    assert.ok(sawMaintenance, '应该观察到 gc 占锁导致的跳过')
    assert.ok(warnings.some((line) => /checkpoint skipped.*held by gc/.test(line)), warnings.join('\n'))
    assert.ok(cp.checkpointSkipState(proj3).count >= 1)
  })

  await check('gc 结束后 capture 恢复正常', async () => {
    await writeFile(join(proj3, 'f0.txt'), `after gc ${Math.random()}\n`)
    assert.ok(await cp.captureCheckpoint(proj3, 's3', 'after-gc'))
  })
} finally {
  await rm(data, { recursive: true, force: true }).catch(() => undefined)
}

console.log(`\ncheckpoint-refs: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
