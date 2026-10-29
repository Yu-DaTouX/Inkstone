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

  await mkdir(join(temp, 'data'), { recursive: true })
  const legacy = JSON.stringify({ cwd: temp, desktopPet: { autoStart: true }, desktopPetModel: 'old/model', comfyui: { url: 'http://127.0.0.1:8188' }, comfyModel: 'old' })
  await writeFile(FILE, legacy)
  const loadedLegacy = await getSettings()
  ok(!Object.keys(loadedLegacy).some(key => /^(desktopPet|comfy)/i.test(key)), '旧桌宠和 ComfyUI 设置读入即丢弃')
  ok(await readFile(FILE, 'utf8') === legacy, '读取旧插件设置不改写或删除用户磁盘文件')

  const first = await patchSettings({ theme: 'light' })
  ok(first.theme === 'light', '正常写入返回新值')
  const onDisk = JSON.parse(await readFile(FILE, 'utf8'))
  ok(onDisk.theme === 'light', '磁盘上真的落了新值')
  ok((await getSettings()).theme === 'light', '后续读取拿到新值')

  ok(validateRendererSettingsPatch({ streamWidth: 960 }).streamWidth === 960, '渲染补丁允许消息流宽度')
  await patchSettings({ streamWidth: 960 })
  ok((await getSettings()).streamWidth === 960 && JSON.parse(await readFile(FILE, 'utf8')).streamWidth === 960, '消息流宽度写盘后读回一致')
  ok((await patchSettings({ streamWidth: 1 })).streamWidth === 480 && (await patchSettings({ streamWidth: 9999 })).streamWidth === 1440, '消息流宽度夹在有效范围内')
  await patchSettings({ streamWidth: undefined })
  ok((await getSettings()).streamWidth === undefined && !('streamWidth' in JSON.parse(await readFile(FILE, 'utf8'))), '恢复默认移除宽度覆盖')

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

  const normalized = await patchSettings({ theme: 'invalid', remoteAccess: { enabled: 'yes', port: -1 } })
  ok(normalized.theme === 'dark' && normalized.remoteAccess.enabled === false, '读写共用清洗，不持久化非法 UI 值')
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
    const { readdir } = await import('node:fs/promises')
    const { dirname, basename } = await import('node:path')
    const before = new Set(await readdir(dirname(FILE)))
    let healed = false
    try { healed = (await patchSettings({ theme: 'light' })).theme === 'light' } catch { healed = false }
    const backups = (await readdir(dirname(FILE))).filter((name) => !before.has(name) && name.startsWith(`${basename(FILE)}.corrupt-`))
    const kept = backups.length === 1 && await readFile(join(dirname(FILE), backups[0]), 'utf8') === content
    ok(healed && kept && JSON.parse(await readFile(FILE, 'utf8')).theme === 'light', '损坏 JSON 或结构先备份原文件，再用默认设置继续')
  }
  await writeFile(FILE, saved)
  await patchSettings({ theme: 'dark' })
  await writeFile(FILE, JSON.stringify({ cwd: temp, permissionMode: 'danger' }))
  await patchSettings({ theme: 'dark' })
  ok((await getSettings()).guardOutsideWrites === true, '新设置文件没有该项时，写入项目之外默认确认')
  await writeFile(FILE, JSON.stringify({ cwd: temp, permissionMode: 'danger', guardOutsideWrites: false }))
  await patchSettings({ theme: 'dark' })
  ok((await getSettings()).guardOutsideWrites === false, '老用户已存的关闭值保持不变')

  const sealOut = join(temp, 'guard-seal.mjs')
  await build({ entryPoints: ['src/main/settings-guard-seal.ts'], outfile: sealOut, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'seal-electron-stub', setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'seal-stub' })); b.onLoad({ filter: /.*/, namespace: 'seal-stub' }, () => ({ contents: ELECTRON_STUB, loader: 'js' })) } }] })
  const { trustedGuardFields, electronGuardSealStore } = await import(pathToFileURL(sealOut).href)
  const sealed = { permissionMode: 'all', guardOutsideWrites: true, guardAllowRoots: ['/a'] }
  const same = trustedGuardFields(sealed, sealed)
  ok(same.permissionMode === 'all' && same.guardOutsideWrites && same.guardAllowRoots.join() === '/a', '封签与文件一致时原样采用')
  const weakened = trustedGuardFields({ permissionMode: 'all', guardOutsideWrites: false, guardAllowRoots: ['/a', '/b'] }, { ...sealed, permissionMode: 'danger' })
  ok(weakened.permissionMode === 'danger' && weakened.guardOutsideWrites && weakened.guardAllowRoots.join() === '/a', '文件被改宽松时按封签恢复')
  const stricter = trustedGuardFields({ permissionMode: 'danger', guardOutsideWrites: true, guardAllowRoots: [] }, { permissionMode: 'all', guardOutsideWrites: false, guardAllowRoots: ['/a'] })
  ok(stricter.permissionMode === 'danger' && stricter.guardOutsideWrites && stricter.guardAllowRoots.length === 0, '文件被改得更严格时接受')
  const unsealed = trustedGuardFields({ permissionMode: 'all', guardOutsideWrites: false, guardAllowRoots: ['/a'] }, null)
  ok(unsealed.permissionMode === 'danger' && unsealed.guardOutsideWrites === false && unsealed.guardAllowRoots.join() === '/a', '没有封签时不信任「不受限制」，其余沿用')
  ok(await electronGuardSealStore() === null, '没有系统加密时不启用封签')
  await rm(temp, { recursive: true, force: true })
}
