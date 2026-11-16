import './lib/test-isolate.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

await runSuite(import.meta.url, async (ok, compile) => {
  const entry = "export * from './src/main/data-backup.ts'; export * from './src/main/data-restore.ts'; export * from './src/main/restore-incomplete.ts'"
  const m = await compile(null, { stdin: { contents: entry, resolveDir: process.cwd() } })
  const root = mkdtempSync(join(tmpdir(), 'inkstone-restore-incomplete-'))
  try {
    const sessions = join(root, 'src', 'sessions')
    const yan = join(root, 'src', 'yan')
    const out = join(root, 'out')
    const registry = join(root, 'incomplete-restores.json')
    mkdirSync(out)
    put(join(sessions, 'p', 'a.jsonl'), '{"type":"session","id":"a"}\n')
    put(join(yan, 'desktop.json'), '{broken json')
    const bad = await m.createDataBackup(out, sessions, yan)
    const hooks = { started: (path) => m.registerIncompleteRestore(registry, path), finished: (path) => m.forgetIncompleteRestore(registry, path) }

    const failure = await m.restoreDataBackup(bad.path, out, [], hooks).then(() => null, (error) => error)
    ok(failure instanceof Error && /Incomplete restore retained: /.test(failure.message), '恢复中途失败时仍报告保留了未完成目录', String(failure))
    const dir = failure.message.split('Incomplete restore retained: ')[1].trim()
    const marker = JSON.parse(readFileSync(join(dir, 'restore-incomplete.json'), 'utf8'))
    ok(marker.format === 'inkstone-restore-incomplete' && marker.source === bad.path && typeof marker.error === 'string' && marker.error.length > 0, '失败目录里有明确的不完整标记，写明来源和原因', JSON.stringify(marker))
    ok(!existsSync(join(dir, 'restored.json')), '失败目录没有完成标记 restored.json')
    const listed = await m.listIncompleteRestores(registry)
    ok(listed.length === 1 && listed[0].path === dir && listed[0].error === marker.error, '失败的目录登记到未完成清单，下次进入设置页可以列出')

    let good2
    const fine = mkdtempSync(join(tmpdir(), 'inkstone-restore-fine-src-'))
    try {
      const goodYan = join(fine, 'yan')
      put(join(fine, 'sessions', 'p', 'a.jsonl'), '{"type":"session","id":"a"}\n')
      put(join(goodYan, 'desktop.json'), '{"theme":"dark"}')
      const good = await m.createDataBackup(out, join(fine, 'sessions'), goodYan)
      good2 = good
      const restored = await m.restoreDataBackup(good.path, out, [], hooks)
      ok(existsSync(join(restored.path, 'restored.json')) && !existsSync(join(restored.path, 'restore-incomplete.json')), '成功的恢复没有不完整标记，写了完成标记')
      ok((await m.listIncompleteRestores(registry)).length === 1, '成功的恢复不进未完成清单，也不影响已有记录')
    } finally {
      rmSync(fine, { recursive: true, force: true })
    }

    const warnings = []
    const flaky = await m.restoreDataBackup(good2.path, out, [], { started: async () => { throw new Error('登记表写不进去') }, finished: async () => { throw new Error('清单更新失败') }, warn: (message) => warnings.push(message) })
    ok(existsSync(join(flaky.path, 'restored.json')) && !existsSync(join(flaky.path, 'restore-incomplete.json')), '登记或收尾钩子失败不会让恢复失败，也不会把已完成的恢复标成未完成')
    ok(warnings.length === 2 && /started/.test(warnings[0]) && /finished/.test(warnings[1]), '钩子失败只记录警告', JSON.stringify(warnings))

    const running = join(out, 'Inkstone-restored-running')
    mkdirSync(running)
    await m.writeIncompleteMarker(running, { source: bad.path, startedAt: new Date().toISOString() })
    await m.registerIncompleteRestore(registry, running)
    const runningTrash = []
    ok(!(await m.listIncompleteRestores(registry)).some((item) => item.path === running), '恢复还在进行的目录不列为未完成')
    ok(!(await m.trashIncompleteRestore(registry, running, async (path) => { runningTrash.push(path) })) && runningTrash.length === 0 && existsSync(running), '恢复还在进行的目录不能移到回收站')
    await m.writeIncompleteMarker(running, { source: bad.path, startedAt: new Date().toISOString(), error: '模拟失败' })
    ok((await m.listIncompleteRestores(registry)).some((item) => item.path === running && item.error === '模拟失败'), '恢复失败后立即列为未完成')
    await m.clearIncompleteMarker(running)
    await m.listIncompleteRestores(registry)

    const crashed = join(out, 'Inkstone-restored-crash')
    mkdirSync(crashed)
    writeFileSync(join(crashed, 'restore-incomplete.json'), JSON.stringify({ format: 'inkstone-restore-incomplete', version: 1, source: bad.path, startedAt: new Date().toISOString() }))
    await m.registerIncompleteRestore(registry, crashed)
    ok((await m.listIncompleteRestores(registry)).some((item) => item.path === crashed && item.error === undefined), '进程中途退出留下的目录（只有开始标记）同样会被列出')

    const trashed = []
    const trash = async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }) }
    ok(!(await m.trashIncompleteRestore(registry, out, trash)) && trashed.length === 0, '不在清单里的目录不会被移到回收站（哪怕是上一级）')
    ok(!(await m.trashIncompleteRestore(registry, join(dir, 'pi-agent'), trash)) && trashed.length === 0, '清单目录的子目录也不处理')
    ok(await m.trashIncompleteRestore(registry, dir, trash) && trashed.join() === dir && !existsSync(dir), '用户确认后把未完成目录交给回收站函数')
    ok((await m.listIncompleteRestores(registry)).map((item) => item.path).join() === crashed, '处理过的目录从清单里去掉，其余保留')
    ok(existsSync(bad.path), '备份本身不受影响')

    await m.clearIncompleteMarker(crashed)
    ok(!(await m.trashIncompleteRestore(registry, crashed, trash)) && existsSync(crashed), '标记已清除（已不是未完成）的目录拒绝处理')
    ok((await m.listIncompleteRestores(registry)).length === 0, '没有标记的目录从清单里剔除')
    rmSync(dir, { recursive: true, force: true })
    await m.registerIncompleteRestore(registry, join(out, 'gone-dir'))
    ok((await m.listIncompleteRestores(registry)).length === 0, '已被手动删除的目录自动从清单剔除')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
