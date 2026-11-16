import './lib/test-isolate.mjs'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const fsStub = {
  name: 'backup-fs-hook',
  setup(build) {
    build.onResolve({ filter: /^node:fs\/promises$/ }, ({ path }) => ({ path, namespace: 'backup-fs' }))
    build.onLoad({ filter: /.*/, namespace: 'backup-fs' }, () => ({
      loader: 'js',
      contents: `const real = process.getBuiltinModule('node:fs/promises')
export const { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } = real
export async function copyFile(source, dest, mode) {
  await real.copyFile(source, dest, mode)
  await globalThis.__afterBackupCopy?.(source, dest)
}`
    }))
  }
}

const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

await runSuite(import.meta.url, async (ok, compile) => {
  const backup = await compile('src/main/data-backup.ts', { plugins: [fsStub] })
  const root = mkdtempSync(join(tmpdir(), 'inkstone-backup-limits-'))
  try {
    const sessions = join(root, 'src', 'sessions')
    const yan = join(root, 'src', 'yan')
    const out = join(root, 'out')
    mkdirSync(out)
    for (const name of ['a', 'b', 'c']) put(join(sessions, 'p', `${name}.jsonl`), `{"type":"session","id":"${name}"}\n`)
    for (const name of ['1', '2', '3', '4']) put(join(yan, 'attachments', `${name}.png`), `image-${name}`)
    put(join(yan, 'artifacts', 's-one', 'page.html'), '<p>x</p>')
    put(join(yan, 'desktop.json'), '{"theme":"dark"}')
    const created = (options) => backup.createDataBackup(out, sessions, yan, options)

    const full = await created()
    ok(full.files === 9 && !full.skipped && !full.changed, '未超限时全部备份，没有跳过和变化记录', JSON.stringify(full))

    const tooMany = await created({ limits: { maxFiles: 6 } }).then(() => null, (error) => error)
    ok(tooMany?.name === 'BackupTooLargeError', '超过文件数上限时抛出可识别的超限错误，而不是笼统失败', String(tooMany))
    const info = tooMany.info
    ok(info.suggested.join() === 'attachments' && info.maxFiles === 6, '建议只跳过最大的那一部分（附件）', JSON.stringify(info))
    ok(info.parts.find((item) => item.part === 'attachments')?.files === 4 && info.parts.find((item) => item.part === 'sessions')?.files === 3, '错误里带各部分的文件数，便于告诉用户哪些太大', JSON.stringify(info.parts))
    ok(readdirSync(out).length === 1, '超限失败时不留半成品备份目录')

    const partial = await created({ limits: { maxFiles: 6 }, skipParts: info.suggested })
    const manifest = JSON.parse(readFileSync(join(partial.path, 'manifest.json'), 'utf8'))
    ok(partial.files === 5 && partial.skipped?.length === 1 && partial.skipped[0].part === 'attachments' && partial.skipped[0].files === 4, '跳过后继续备份，结果里写明跳过了哪部分', JSON.stringify(partial))
    ok(!manifest.files.some((item) => item.path.startsWith('yan/attachments/')) && manifest.files.some((item) => item.path === 'yan/desktop.json'), '跳过的部分不进备份，必备元数据仍在')
    const verified = await backup.verifyDataBackup(partial.path)
    ok(verified.skipped?.[0]?.part === 'attachments', '校验备份时仍能看到跳过记录')

    const byBytes = await created({ limits: { maxBytes: 60 } }).then(() => null, (error) => error)
    ok(byBytes?.name === 'BackupTooLargeError' && byBytes.info.suggested.length >= 1, '超过体积上限同样给出可跳过的部分')
    const auto = await created({ limits: { maxFiles: 6 }, autoSkipLarge: true })
    ok(auto.skipped?.[0]?.part === 'attachments' && auto.files === 5, '无人值守（升级前自动备份）自动跳过超限部分而不是整次失败')
    const impossible = await created({ limits: { maxFiles: 0 } }).then(() => null, (error) => error)
    ok(impossible && impossible.name !== 'BackupTooLargeError', '必备元数据本身就超限时仍明确失败')

    const busy = join(sessions, 'p', 'busy.jsonl')
    const vanished = join(sessions, 'p', 'gone.jsonl')
    put(busy, '{"type":"session","id":"busy"}\n')
    put(vanished, '{"type":"session","id":"gone"}\n')
    let appended = 0
    globalThis.__afterBackupCopy = (source) => {
      if (source === busy) {
        appended++
        appendFileSync(busy, `{"n":${appended}}\n`)
      }
      if (source === vanished) rmSync(vanished, { force: true })
    }
    const changing = await created()
    delete globalThis.__afterBackupCopy
    const entry = JSON.parse(readFileSync(join(changing.path, 'manifest.json'), 'utf8')).files.find((item) => item.path === 'sessions/p/busy.jsonl')
    ok(changing.changed?.some((item) => item.path === 'sessions/p/busy.jsonl' && item.kind === 'modified') && changing.changedTotal === 2, '备份期间一直在变的文件不让整次失败，而是列入变化清单', JSON.stringify(changing.changed))
    ok(changing.changed?.some((item) => item.path === 'sessions/p/gone.jsonl' && item.kind === 'removed'), '备份期间被删除的文件列为已移除')
    const copied = readFileSync(join(changing.path, 'sessions', 'p', 'busy.jsonl'), 'utf8')
    ok(copied.trimEnd().split('\n').length === 3 && entry.size === Buffer.byteLength(copied), '变化文件按最后一次读到的内容记录，清单大小与备份文件一致', copied)
    ok(!existsSync(join(changing.path, 'sessions', 'p', 'gone.jsonl')), '已移除的文件不留在备份里')
    ok((await backup.verifyDataBackup(changing.path)).files === changing.files, '含变化文件的备份逐文件校验仍通过')

    let once = 0
    globalThis.__afterBackupCopy = (source) => {
      if (source === busy && once++ === 0) appendFileSync(busy, '{"late":true}\n')
    }
    const settled = await created()
    delete globalThis.__afterBackupCopy
    ok(!settled.changed?.some((item) => item.path === 'sessions/p/busy.jsonl'), '只变化一次的文件重试后稳定，不算变化', JSON.stringify(settled.changed))
    ok(readFileSync(join(settled.path, 'sessions', 'p', 'busy.jsonl'), 'utf8').includes('late'), '重试后备份的是稳定的最新内容')

    const fresh = join(sessions, 'p', 'fresh.jsonl')
    let madeFresh = false
    globalThis.__afterBackupCopy = () => {
      if (!madeFresh) {
        madeFresh = true
        writeFileSync(fresh, '{"type":"session","id":"fresh"}\n')
      }
    }
    const withNew = await created()
    delete globalThis.__afterBackupCopy
    ok(withNew.changed?.some((item) => item.path === 'sessions/p/fresh.jsonl' && item.kind === 'added'), '备份期间新建的文件不收录，但在结尾比对中列为「新建」', JSON.stringify(withNew.changed))
    ok(!existsSync(join(withNew.path, 'sessions', 'p', 'fresh.jsonl')), '新建的文件没有进备份')
  } finally {
    delete globalThis.__afterBackupCopy
    rmSync(root, { recursive: true, force: true })
  }
})
