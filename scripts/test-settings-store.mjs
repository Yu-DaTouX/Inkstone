const ELECTRON_STUB = `
export const app = {
  getLocale: () => 'zh-CN',
  getPath: () => process.env.YAN_TEST_DOCS_PATH
}
`

export async function runSettingsStoreTests(ok) {
  const { mkdtemp, mkdir, readFile, writeFile, rename, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, parse } = await import('node:path')
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
  const { getSettings, patchSettings, validateRendererSettingsPatch, updateSettings } = await import(pathToFileURL(outfile).href)

  const FILE = join(temp, 'data', 'desktop.json')

  const first = await patchSettings({ theme: 'light' })
  ok(first.theme === 'light', '正常写入返回新值')
  const onDisk = JSON.parse(await readFile(FILE, 'utf8'))
  ok(onDisk.theme === 'light', '磁盘上真的落了新值')
  ok((await getSettings()).theme === 'light', '后续读取拿到新值')

  await rename(FILE, `${FILE}.backup`)
  await mkdir(FILE, { recursive: true })
  let failed = false
  try {
    await patchSettings({ projectNames: { '/probe': 'failing-name' } })
  } catch {
    failed = true
  }
  ok(failed, '写盘失败时 patchSettings 如实抛错（不再假装成功）')
  let readRejected = false
  try { await getSettings() } catch { readRejected = true }
  ok(readRejected, '设置路径是目录等非 ENOENT 读取错误时明确拒绝，不降级为空设置')
  let whitelistRejected = false
  try { validateRendererSettingsPatch({ piBin: 'evil' }) } catch { whitelistRejected = true }
  ok(whitelistRejected, '渲染补丁拒绝 piBin')
  for (const key of ['guardAllowRoots', 'unknown', '__proto__']) {
    let rejected = false
    try { validateRendererSettingsPatch({ [key]: [] }) } catch { rejected = true }
    ok(rejected, `渲染补丁拒绝 ${key}`)
  }

  await rm(FILE, { recursive: true, force: true })
  await rename(`${FILE}.backup`, FILE)
  const broken = JSON.parse(await readFile(FILE, 'utf8'))
  ok(broken.theme === 'light', '磁盘上的旧值没被半截写入破坏', broken.theme)
  const again = await patchSettings({ theme: 'dark' })
  ok(again.theme === 'dark' && JSON.parse(await readFile(FILE, 'utf8')).theme === 'dark', '一次失败不影响后续写入')

  const normalized = await patchSettings({ theme: 'invalid', remoteAccess: { enabled: 'yes', port: -1 }, showSpaces: 'yes' })
  ok(normalized.theme === 'dark' && normalized.remoteAccess.enabled === false && normalized.showSpaces === undefined, '读写共用清洗，不持久化非法 UI 值与已退役的 showSpaces')
  const detached = await getSettings()
  detached.profile.name = 'must-not-mutate-cache'
  ok((await getSettings()).profile.name !== detached.profile.name, '设置快照不泄露嵌套缓存引用')
  ok(!!validateRendererSettingsPatch({ lastMainModel: { provider: 'fixture', id: 'model' }, modelFavorites: [] }), '白名单保留模型选择和收藏入口')
  const allowed = join(temp, 'allowed'); await mkdir(allowed)
  const roots = (await patchSettings({ guardAllowRoots: [parse(temp).root, 'relative', allowed] })).guardAllowRoots
  ok(roots.length === 1 && roots[0] === allowed, '允许普通绝对目录，拒绝磁盘根及相对路径')
  await Promise.all([
    updateSettings((current) => ({ projectNames: { ...current.projectNames, one: 'One' } })),
    updateSettings((current) => ({ projectNames: { ...current.projectNames, two: 'Two' } }))
  ])
  const concurrent = await getSettings()
  ok(concurrent.projectNames.one === 'One' && concurrent.projectNames.two === 'Two', '串行读改写保留并发字段更新')
  const saved = await readFile(FILE, 'utf8')
  for (const content of ['{broken', 'null', '[]']) {
    await writeFile(FILE, content)
    let refused = false
    try { await patchSettings({ theme: 'light' }) } catch { refused = true }
    ok(refused && await readFile(FILE, 'utf8') === content, '损坏 JSON 或结构保留原文件并拒绝覆盖')
  }
  await writeFile(FILE, saved)
  await patchSettings({ theme: 'dark' })
  await rm(temp, { recursive: true, force: true })
}
