import assert from 'node:assert/strict'
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-pi-settings-eperm-'))
try {
  const outfile = join(root, 'helper.mjs')
  await build({ entryPoints: ['src/main/native-compaction-line.ts'], outfile, bundle: true, platform: 'node', format: 'esm' })
  const { writeAtomic, modifyPiSettings } = await import(pathToFileURL(outfile).href)

  const normalFile = join(root, 'normal.json')
  await writeAtomic(normalFile, { a: 1 })
  assert.deepEqual(JSON.parse(await readFile(normalFile, 'utf8')), { a: 1 })
  console.log('pi-settings-eperm-retry: writeAtomic 正常写入通过')

  const modifyNormalFile = join(root, 'modify-normal.json')
  await writeFile(modifyNormalFile, JSON.stringify({ foreign: 'kept' }), 'utf8')
  const normalResult = await modifyPiSettings(modifyNormalFile, (settings) => ({
    next: { ...settings, mine: 'done' },
    result: { ok: true }
  }))
  assert.deepEqual(normalResult, { ok: true })
  assert.deepEqual(JSON.parse(await readFile(modifyNormalFile, 'utf8')), { foreign: 'kept', mine: 'done' })
  console.log('pi-settings-eperm-retry: modifyPiSettings 无冲突时正常读改写通过')

  if (process.platform === 'win32') {
    await assert.rejects(
      (async () => {
        const blockedFile = join(root, 'writeatomic-no-retry.json')
        await writeFile(blockedFile, JSON.stringify({ a: 0 }), 'utf8')
        const handle = await open(blockedFile, 'r+')
        try {
          await writeAtomic(blockedFile, { a: 1 })
        } finally {
          await handle.close()
        }
      })(),
      { code: 'EPERM' }
    )
    console.log('pi-settings-eperm-retry: writeAtomic 本身不重试，撞到占用立即抛出，通过')

    const conflictFile = join(root, 'conflict.json')
    await writeFile(conflictFile, JSON.stringify({ foreign: 'old' }), 'utf8')
    const conflictHandle = await open(conflictFile, 'r+')
    const foreignWrite = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      await conflictHandle.writeFile(JSON.stringify({ foreign: 'new' }), 'utf8')
      await conflictHandle.close()
    })()
    const conflictResult = await modifyPiSettings(conflictFile, (settings) => ({
      next: { ...settings, mine: 'done' },
      result: { ok: true }
    }))
    await foreignWrite
    assert.deepEqual(conflictResult, { ok: true })
    assert.deepEqual(JSON.parse(await readFile(conflictFile, 'utf8')), { foreign: 'new', mine: 'done' })
    console.log('pi-settings-eperm-retry: 写入冲突期间另一进程改了别的字段，重试后两边改动都保留，通过')

    const giveUpFile = join(root, 'giveup.json')
    await writeFile(giveUpFile, JSON.stringify({ a: 0 }), 'utf8')
    const blockingHandle = await open(giveUpFile, 'r+')
    try {
      await assert.rejects(
        modifyPiSettings(giveUpFile, (settings) => ({ next: { ...settings, mine: 'done' }, result: { ok: true } })),
        { code: 'EPERM' }
      )
    } finally {
      await blockingHandle.close()
    }
    assert.deepEqual(JSON.parse(await readFile(giveUpFile, 'utf8')), { a: 0 })
    const leftover = await readdir(root)
    assert.ok(!leftover.some((name) => name.startsWith('giveup.json.') && name.endsWith('.tmp')), '重试耗尽后应清理临时文件')
    console.log('pi-settings-eperm-retry: 重试耗尽后仍抛出 EPERM，目标文件不变且清理了临时文件，通过')
  } else {
    console.log('pi-settings-eperm-retry: 非 Windows 平台，跳过占用文件冲突场景')
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
