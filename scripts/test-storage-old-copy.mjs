import { existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const root = mkdtempSync(join(tmpdir(), 'inkstone-old-copy-'))
  const saved = { ...process.env }
  try {
    const home = join(root, 'home')
    const appdata = join(root, 'appdata')
    const from = join(home, '.pi', 'agent')
    const target = join(root, 'target')
    mkdirSync(from, { recursive: true })
    mkdirSync(join(appdata, 'yan-desktop'), { recursive: true })
    writeFileSync(join(from, 'note.txt'), 'old data')
    writeFileSync(join(from, 'more.txt'), 'x'.repeat(2048))
    for (const key of Object.keys(process.env)) if (/^(YAN|PI)_|^PORTABLE_EXECUTABLE_DIR$/.test(key)) delete process.env[key]
    process.env.APPDATA = appdata
    process.env.USERPROFILE = home
    process.env.HOME = home

    const pathsStub = {
      name: 'paths-stub',
      setup(build) {
        build.onResolve({ filter: /^\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ loader: 'js', contents: `export const PI_AGENT_DIR = ${JSON.stringify(from)}` }))
      }
    }
    const move = await compile('src/main/storage-move.ts', { plugins: [pathsStub] })

    ok(move.storageInfo().oldCopy === undefined, '迁移前没有旧数据副本可提示')
    ok((await move.scheduleStorageMove(target)).ok, '预约迁移')
    const result = await move.runPendingStorageMove()
    ok(result?.ok === true && !!result.leftover, '迁移成功，旧数据作为迁移前备份保留', JSON.stringify(result))
    const info = move.storageInfo()
    ok(info.relocated && info.oldCopy === result.leftover, '迁移成功后设置页能拿到旧数据的位置', JSON.stringify(info))
    ok(await move.storageSize(info.oldCopy) === 8 + 2048, '旧数据大小可统计')

    const decoyFile = join(home, '.pi', 'agent.迁移前备份-99999999999999-file')
    const decoyLink = join(home, '.pi', 'agent.迁移前备份-99999999999999-link')
    writeFileSync(decoyFile, 'not a folder')
    symlinkSync(target, decoyLink, 'junction')
    ok(move.storageInfo().oldCopy === info.oldCopy, '名字像旧数据的文件或链接不会被当作旧数据目录')
    const decoyRefused = await move.trashOldStorageCopy(decoyLink, async () => { throw new Error('不该调用') })
    ok(!decoyRefused.ok, '指向别处的联接不会被移到回收站')
    rmSync(decoyLink, { recursive: false, force: true })
    rmSync(decoyFile, { force: true })

    const trashed = []
    const trash = async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }) }
    for (const wrong of [from, info.realDir, target, join(info.oldCopy, '..'), '', join(info.oldCopy, 'note.txt')]) {
      const refused = await move.trashOldStorageCopy(wrong, trash)
      ok(!refused.ok && trashed.length === 0 && existsSync(info.oldCopy), `拒绝处理旧数据以外的路径：${wrong || '（空）'}`)
    }
    ok(readFileSync(join(target, 'note.txt'), 'utf8') === 'old data', '新位置的数据不受影响')

    const done = await move.trashOldStorageCopy(info.oldCopy, trash)
    ok(done.ok && trashed.join() === info.oldCopy && !existsSync(info.oldCopy), '用户确认后把旧数据交给回收站函数')
    ok(move.storageInfo().oldCopy === undefined && move.storageInfo().relocated, '处理后不再提示旧数据，新位置仍生效')
    ok(readFileSync(join(from, 'note.txt'), 'utf8') === 'old data', '联接指向的当前数据仍可读')

    const failing = await move.trashOldStorageCopy(info.oldCopy, async () => { throw new Error('回收站不可用') })
    ok(!failing.ok, '旧数据已不存在时不再重复处理')
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    rmSync(join(root, 'home', '.pi', 'agent'), { recursive: false, force: true, maxRetries: 2 })
    rmSync(root, { recursive: true, force: true })
  }
})
