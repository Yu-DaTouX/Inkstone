/**
 * 设置的落盘语义（O06 回归）。
 *
 * 隔离目录（`YAN_PI_DIR` 指向临时目录）+ electron 桩，不碰真实 desktop.json。
 *
 * 回归本体：写盘失败时不能「更新缓存 + 返回新设置」假装成功 —— 否则界面显示
 * 已保存、重启后变回旧值，调用方没有任何办法发现。
 */
const ELECTRON_STUB = `
export const app = {
  getLocale: () => 'zh-CN',
  getPath: () => process.env.YAN_TEST_DOCS_PATH
}
`

export async function runSettingsStoreTests(ok) {
  const { mkdtemp, mkdir, readFile, rename, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const temp = await mkdtemp(join(tmpdir(), 'yan-settings-store-'))
  process.env.YAN_PI_DIR = join(temp, 'pi')
  process.env.YAN_DATA_DIR = join(temp, 'data')
  process.env.YAN_TEST_DOCS_PATH = join(temp, 'documents')
  await mkdir(process.env.YAN_TEST_DOCS_PATH, { recursive: true })

  const { build } = await import('../node_modules/esbuild/lib/main.js')
  const outfile = join(temp, 'settings.mjs')
  await build({
    entryPoints: ['src/main/settings.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'settings-electron-stub',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'settings-stub' }))
          b.onLoad({ filter: /.*/, namespace: 'settings-stub' }, () => ({ contents: ELECTRON_STUB, loader: 'js' }))
        }
      }
    ]
  })
  const { getSettings, patchSettings } = await import(pathToFileURL(outfile).href)

  /* 桌面设置落在 YAN_DIR（由 YAN_DATA_DIR 覆盖），不是 pi 目录 */
  const FILE = join(temp, 'data', 'desktop.json')

  /* ---- 正常写入：返回值与磁盘一致 ---- */
  const first = await patchSettings({ theme: 'light' })
  ok(first.theme === 'light', '正常写入返回新值')
  const onDisk = JSON.parse(await readFile(FILE, 'utf8'))
  ok(onDisk.theme === 'light', '磁盘上真的落了新值')
  ok((await getSettings()).theme === 'light', '后续读取拿到新值')

  /* ---- 写盘失败：如实抛错，且不把那次改动留在内存/磁盘 ---- */
  await rename(FILE, `${FILE}.backup`)
  await mkdir(FILE, { recursive: true })
  let failed = false
  try {
    await patchSettings({ projectNames: { '/probe': 'failing-name' } })
  } catch {
    failed = true
  }
  ok(failed, '写盘失败时 patchSettings 如实抛错（不再假装成功）')
  const during = await getSettings()
  ok(
    !(during.projectNames ?? {})['/probe'],
    '失败后缓存里没有留下那次改动（没有返回一个没保存成功的新值）',
    JSON.stringify(during.projectNames)
  )

  /* ---- 恢复文件：磁盘上仍是旧值，队列也没被毒化 ---- */
  await rm(FILE, { recursive: true, force: true })
  await rename(`${FILE}.backup`, FILE)
  /*
   * 这里直接看磁盘（不走 getSettings）：文件被换成目录期间读盘本身会失败，
   * getSettings 会降级成默认值并缓存 —— 那是读盘的既定降级，不是本次回归对象。
   */
  const broken = JSON.parse(await readFile(FILE, 'utf8'))
  ok(broken.theme === 'light', '磁盘上的旧值没被半截写入破坏', broken.theme)
  const again = await patchSettings({ theme: 'dark' })
  ok(again.theme === 'dark' && JSON.parse(await readFile(FILE, 'utf8')).theme === 'dark', '一次失败不影响后续写入')

  await rm(temp, { recursive: true, force: true })
}
