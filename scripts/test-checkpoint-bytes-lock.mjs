#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

const data = await mkdtemp(join(tmpdir(), 'yan-cp-bytes-data-'))
const proj = await mkdtemp(join(tmpdir(), 'yan-cp-bytes-proj-'))
process.env.YAN_DATA_DIR = data

const built = await build({
  entryPoints: ['src/main/checkpoints.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const cp = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const git = (args) => execFileSync('git', args, { encoding: 'utf8' })
async function checkpointDirs() {
  return (await readdir(join(data, 'checkpoints')).catch(() => [])).map((name) => join(data, 'checkpoints', name, 'repo.git'))
}
async function projectRepo(cwd) {
  for (const repo of await checkpointDirs()) {
    const index = await readFile(join(repo, '..', 'index.json'), 'utf8').catch(() => '')
    if (!index) continue
    const parsed = JSON.parse(index)
    if (parsed?.cwd && parsed.cwd.replace(/\\/g, '/').toLowerCase() === cwd.replace(/\\/g, '/').toLowerCase()) return repo
  }
  return null
}
const bytesOf = (file) => readFile(file)

try {
  process.stdout.write('\n▌检查点：恢复原始字节（B11a）\n')
  const marker = join(proj, 'filter-ran.txt')
  await writeFile(join(proj, '.gitattributes'), '* text eol=lf\n*.dat filter=upper\n')
  await writeFile(join(proj, 'a.txt'), 'line1\r\nline2\r\n')
  await writeFile(join(proj, 'data.dat'), 'hello world\r\n')
  const first = await cp.captureCheckpoint(proj, 'sess-bytes', '原始字节')
  assert.ok(first, '第一次抓快照应成功')

  const repo = await projectRepo(proj)
  assert.ok(repo, '能找到影子仓库')
  const attributes = await readFile(join(repo, 'info', 'attributes'), 'utf8').catch(() => '')
  assert.match(attributes, /-text/, '影子仓库写了属性覆盖')
  git(['--git-dir', repo, 'config', 'filter.upper.clean', `sh -c 'echo ran >> ${marker.replace(/\\/g, '/')}; tr a-z A-Z'`])

  await writeFile(join(proj, 'a.txt'), 'changed\n')
  await writeFile(join(proj, 'data.dat'), 'changed again\n')
  const second = await cp.captureCheckpoint(proj, 'sess-bytes', '改过之后')
  assert.ok(second, '第二次抓快照应成功')

  await check('抓快照时不执行项目 .gitattributes 里的过滤器', async () => {
    assert.equal(existsSync(marker), false, '过滤器不应被调用')
  })

  await check('恢复后 CRLF 原样保留，不按 Git 属性转成 LF', async () => {
    const restored = await cp.restoreCheckpoint(proj, first.id, 'sess-bytes')
    assert.ok(restored.ok, JSON.stringify(restored))
    assert.deepEqual(await bytesOf(join(proj, 'a.txt')), Buffer.from('line1\r\nline2\r\n'))
  })

  await check('恢复后内容不被过滤器改写，字节一致', async () => {
    assert.deepEqual(await bytesOf(join(proj, 'data.dat')), Buffer.from('hello world\r\n'))
    assert.equal(existsSync(marker), false, '回退过程中过滤器同样不应被调用')
  })

  process.stdout.write('\n▌检查点：遗留 index.lock 回收（B1）\n')
  const lock = join(repo, 'index.lock')
  const aged = (minutes = 5) => {
    const old = new Date(Date.now() - minutes * 60_000)
    return utimes(lock, old, old)
  }

  await check('没有本进程 Git 退出的证据时不删锁：即使锁很旧', async () => {
    await writeFile(lock, 'lock')
    await aged()
    const blocked = await cp.captureCheckpoint(proj, 'sess-bytes', '被锁住')
    assert.equal(blocked, null, '不能凭 mtime 删除未知来源的锁')
    assert.ok(existsSync(lock), '锁保留')
    assert.equal((await cp.listCheckpoints(proj, 'sess-bytes')).length >= 1, true, '已有检查点不受影响')
  })

  await check('确认本进程 Git 已退出后，才回收它留下的锁', async () => {
    const killedAt = Date.now()
    await writeFile(lock, 'lock')
    await aged()
    cp.noteCheckpointGitKilled(proj, killedAt)
    const recovered = await cp.captureCheckpoint(proj, 'sess-bytes', '回收遗锁后')
    assert.ok(recovered, '有退出证据后应清理并继续')
    assert.equal(existsSync(lock), false, '遗锁已被清掉')
  })

  await check('证据之后才出现的锁不当作上次遗留', async () => {
    cp.noteCheckpointGitKilled(proj, Date.now() - 60_000)
    await writeFile(lock, 'lock')
    const blocked = await cp.captureCheckpoint(proj, 'sess-bytes', '新锁')
    assert.equal(blocked, null)
    assert.ok(existsSync(lock), '比证据新的锁保留')
    await rm(lock, { force: true })
  })

  await check('证据只用一次，用完后旧锁仍然保留', async () => {
    cp.noteCheckpointGitKilled(proj, Date.now())
    await writeFile(lock, 'lock')
    await aged()
    assert.ok(await cp.captureCheckpoint(proj, 'sess-bytes', '第一次'))
    await writeFile(lock, 'lock2')
    await aged()
    const blocked = await cp.captureCheckpoint(proj, 'sess-bytes', '第二次')
    assert.equal(blocked, null, '没有新的退出证据就不再清锁')
    assert.ok(existsSync(lock))
    await rm(lock, { force: true })
  })

  await check('超过 10 分钟的锁走既有残留清理（私有影子仓库，仍保留）', async () => {
    await writeFile(lock, 'lock')
    await aged(15)
    const recovered = await cp.captureCheckpoint(proj, 'sess-bytes', '旧锁')
    assert.ok(recovered, '超过 10 分钟未被触碰的锁仍由原有清理处理')
    assert.equal(existsSync(lock), false)
  })

  await check('遗锁回收后预览仍能读到当前状态', async () => {
    const list = await cp.listCheckpoints(proj, 'sess-bytes')
    const preview = await cp.previewCheckpoint(proj, list[0].id)
    assert.ok(preview.ok, JSON.stringify(preview))
  })

  process.stdout.write('\n▌检查点：损坏索引的回退\n')
  await check('索引损坏时列表降级为空，抓快照修好并只备份一次坏文件', async () => {
    const indexFile = join(repo, '..', 'index.json')
    await writeFile(indexFile, '{not json')
    assert.deepEqual(await cp.listCheckpoints(proj, 'sess-bytes'), [], '列表查询降级为空')
    const repaired = await cp.captureCheckpoint(proj, 'sess-bytes', '修好索引')
    assert.ok(repaired, '抓快照时重建索引')
    const backups = (await readdir(join(repo, '..'))).filter((name) => name.includes('.corrupt-'))
    assert.equal(backups.length, 1, '坏索引备份一次')
    await cp.captureCheckpoint(proj, 'sess-bytes', '再存一次')
    const again = (await readdir(join(repo, '..'))).filter((name) => name.includes('.corrupt-'))
    assert.equal(again.length, 1, '修好后不再生成新备份')
  })
} finally {
  await rm(data, { recursive: true, force: true }).catch(() => undefined)
  await rm(proj, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 检查点原始字节与遗锁：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
