import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideIsolation, detectLoader, listInstances } from '../src/core/instances.ts'
import { parseJavaVersion, pickJava } from '../src/core/java.ts'
import { useOwnVersionJar } from '../src/core/launch.ts'
import { javaFromSelection, parseJavaList, parseKeyValueLines, parseLaunchFolders, parseProfiles, readPclSnapshot } from '../src/core/pcl-import.ts'
import { accountFromPcl, mergeAccounts, offlineAccount, validOfflineName } from '../src/core/accounts.ts'
import { normalizeSettings } from '../src/core/settings.ts'
import { defaultSlim, parseTextures, SkinCache } from '../src/core/skins.ts'
import { iconFromMcmodInfo, iconFromToml, jarIcon, pickIconPath } from '../src/core/jar-icon.ts'
import { mavenPath, pclLogoPath, readInstanceIcon } from '../src/core/instance-icons.ts'
import { TaskCenter } from '../src/core/tasks.ts'
import type { TaskInfo } from '../src/shared/api.ts'
import { PNG_STUB, storedZip } from './zip-fixture.ts'

let passed = 0
function test(name: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(run()).then(
    () => {
      passed += 1
    },
    (error: unknown) => {
      console.error(`✗ ${name}`)
      throw error
    }
  )
}

const root = mkdtempSync(join(tmpdir(), 'inkstone-mc-test-'))
try {
  await test('PCL 键值行：值里的冒号和盘符保留', () => {
    const map = parseKeyValueLines('\uFEFFLaunchFolderSelect: F:\\MC\\主版本\\\nVersion:整合包\n# 注释\n')
    assert.equal(map.get('LaunchFolderSelect'), 'F:\\MC\\主版本\\')
    assert.equal(map.get('Version'), '整合包')
  })

  await test('PCL 游戏目录列表：名称>路径，用 | 分隔', () => {
    assert.deepEqual(parseLaunchFolders('主版本>F:\\MC\\主版本\\|备用>D:\\mc'), [
      { name: '主版本', path: 'F:\\MC\\主版本' },
      { name: '备用', path: 'D:\\mc' }
    ])
  })

  await test('PCL Java 列表：跳过停用项与坏数据', () => {
    assert.deepEqual(parseJavaList('[{"Path":"a.exe","IsEnable":true},{"Path":"b.exe","IsEnable":false},{"x":1}]'), ['a.exe'])
    assert.deepEqual(parseJavaList('not json'), [])
  })

  await test('PCL 版本 Java 选择：bin 目录补全 java.exe', () => {
    assert.equal(javaFromSelection('{"Path":"F:\\\\Java\\\\bin\\\\"}'), join('F:\\Java\\bin\\', 'java.exe'))
    assert.equal(javaFromSelection(''), null)
  })

  await test('PCL 账号：只取类型、用户名、UUID 和皮肤站，不带任何令牌或密码', () => {
    const accounts = parseProfiles(
      JSON.stringify({
        profiles: [
          { type: 'microsoft', username: 'Steve', uuid: 'u1', accessToken: 'secret-a', refreshToken: 'secret-r' },
          { type: 'authlib', username: 'Alex', uuid: 'u2', server: 'https://littleskin.cn/api/yggdrasil', serverName: 'LittleSkin', password: 'pw', clientToken: 'ct' },
          { type: 'weird', uuid: 'no-name' }
        ]
      })
    )
    assert.equal(accounts.length, 2)
    assert.deepEqual(accounts[1], { type: 'authlib', username: 'Alex', uuid: 'u2', server: 'https://littleskin.cn/api/yggdrasil', serverName: 'LittleSkin' })
    assert.ok(!JSON.stringify(accounts).includes('secret'))
    assert.ok(!JSON.stringify(accounts).includes('pw'))
  })

  await test('加载器识别：Fabric 库名与主类', () => {
    assert.deepEqual(detectLoader({ libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.10' }] }), { loader: 'fabric', loaderVersion: '0.16.10' })
    assert.deepEqual(detectLoader({ mainClass: 'net.minecraft.client.main.Main', libraries: [] }), { loader: 'vanilla', loaderVersion: null })
  })

  await test('版本隔离：版本目录已有 mods 时隔离，原版无标记时不隔离', () => {
    const modded = join(root, 'modded')
    mkdirSync(join(modded, 'mods'), { recursive: true })
    assert.equal(decideIsolation(modded, new Map(), 'vanilla'), true)
    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    assert.equal(decideIsolation(plain, new Map(), 'vanilla'), false)
    assert.equal(decideIsolation(plain, new Map([['VersionArgumentIndieV2', 'True']]), 'vanilla'), true)
  })

  await test('Java 选择：优先完全匹配，其次最小的更高版本，偏好不够新时不用', () => {
    const list = [
      { path: 'j25', version: '25', majorVersion: 25 },
      { path: 'j21', version: '21', majorVersion: 21 },
      { path: 'j8', version: '1.8', majorVersion: 8 }
    ]
    assert.equal(pickJava(list, 21)?.path, 'j21')
    assert.equal(pickJava(list, 17)?.path, 'j21')
    assert.equal(pickJava(list, 21, 'j8')?.path, 'j21')
    assert.equal(pickJava(list, 8, 'j25')?.path, 'j25')
    assert.equal(pickJava(list, 26), undefined)
  })

  await test('Java 版本解析：release 文件、-version 输出、旧式 1.8', () => {
    assert.deepEqual(parseJavaVersion('IMPLEMENTOR="Azul"\nJAVA_VERSION="21.0.6"\n'), { version: '21.0.6', majorVersion: 21 })
    assert.deepEqual(parseJavaVersion('openjdk version "25.0.1" 2025-10-21'), { version: '25.0.1', majorVersion: 25 })
    assert.deepEqual(parseJavaVersion('java version "1.8.0_51"'), { version: '1.8.0_51', majorVersion: 8 })
    assert.equal(parseJavaVersion('garbage'), null)
  })

  await test('设置：坏值回落默认，离线名校验', () => {
    const settings = normalizeSettings({ offlineName: '中文名', maxMemoryMb: 10, folders: [{ path: 'F:\\mc' }, { name: 'x' }] })
    assert.deepEqual(settings.accounts, [])
    assert.equal(settings.selectedAccountId, null)
    assert.equal(settings.maxMemoryMb, 4096)
    assert.deepEqual(settings.folders, [{ name: 'F:\\mc', path: 'F:\\mc' }])
    assert.equal(validOfflineName('Steve_01'), true)
    assert.equal(validOfflineName('ab'), false)
  })

  await test('设置：旧字段迁移成账号列表，选中项无效时回落第一个', () => {
    const settings = normalizeSettings({
      offlineName: 'Steve',
      importedAccounts: [{ type: 'microsoft', username: 'Alex', uuid: '0123456789abcdef0123456789abcdef', server: null, serverName: null }],
      selectedAccountId: 'missing'
    })
    assert.deepEqual(settings.accounts.map((account) => account.kind), ['offline', 'microsoft'])
    assert.equal(settings.selectedAccountId, settings.accounts[0].id)
    assert.equal(settings.accounts[1].signedIn, false)
  })

  await test('账号：离线 UUID 与官方算法一致，PCL 账号去重，第三方只收 https 皮肤站', () => {
    const steve = offlineAccount('Steve')
    assert.equal(steve.uuid, '5627dd98e6be3c21b8a8e92344183641')
    assert.equal(steve.id, 'offline:5627dd98e6be3c21b8a8e92344183641')
    const little = accountFromPcl({ type: 'authlib', username: 'Alex', uuid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', server: 'https://littleskin.cn/api/yggdrasil', serverName: 'LittleSkin' })
    assert.equal(little?.id, 'yggdrasil:littleskin.cn:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.equal(accountFromPcl({ type: 'authlib', username: 'Alex', uuid: 'a'.repeat(32), server: 'http://evil.example', serverName: null }), null)
    assert.equal(mergeAccounts([steve], [offlineAccount('Steve'), little!]).length, 2)
    assert.throws(() => offlineAccount('中文'))
  })

  await test('皮肤：解析 textures 属性，http 官方材质升级为 https，其他 http 拒绝', () => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64')
    const profile = (url: string, model?: string): unknown => ({ properties: [{ name: 'textures', value: encode({ textures: { SKIN: { url, ...(model ? { metadata: { model } } : {}) } } }) }] })
    assert.deepEqual(parseTextures(profile('http://textures.minecraft.net/texture/abc', 'slim')), { url: 'https://textures.minecraft.net/texture/abc', slim: true })
    assert.deepEqual(parseTextures(profile('https://littleskin.cn/textures/x')), { url: 'https://littleskin.cn/textures/x', slim: false })
    assert.equal(parseTextures(profile('http://evil.example/x.png')), null)
    assert.equal(parseTextures({ properties: [] }), null)
    assert.equal(defaultSlim('0'.repeat(32)), false)
    assert.equal(defaultSlim('0'.repeat(31) + '1'), true)
    assert.equal(defaultSlim('not-a-uuid'), false)
  })

  await test('皮肤缓存：下载后写缓存，离线账号不联网，坏 PNG 回落默认', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('skin')])
    const textures = Buffer.from(JSON.stringify({ textures: { SKIN: { url: 'https://textures.minecraft.net/texture/abc', metadata: { model: 'slim' } } } })).toString('base64')
    const calls: string[] = []
    let body = png
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      if (String(url).includes('sessionserver')) return new Response(JSON.stringify({ properties: [{ name: 'textures', value: textures }] }))
      return new Response(body)
    }) as typeof fetch
    const account = accountFromPcl({ type: 'microsoft', username: 'Alex', uuid: 'a'.repeat(32), server: null, serverName: null })!
    const skins = new SkinCache(join(root, 'skins'), fakeFetch)
    const first = await skins.get(account)
    assert.equal(first.slim, true)
    assert.equal(first.dataUrl, `data:image/png;base64,${png.toString('base64')}`)
    assert.equal(calls.length, 2)
    assert.deepEqual(await skins.get(account), first)
    assert.equal(calls.length, 2)
    assert.deepEqual(await skins.get(offlineAccount('Steve')), { dataUrl: null, slim: defaultSlim(offlineAccount('Steve').uuid) })
    body = Buffer.from('not png')
    const other = accountFromPcl({ type: 'microsoft', username: 'Bob', uuid: 'b'.repeat(32), server: null, serverName: null })!
    assert.equal((await new SkinCache(join(root, 'skins2'), fakeFetch).get(other)).dataUrl, null)
  })

  await test('PCL 快照：全局配置 + 账号 + 游戏目录 PCL.ini 选中版本', async () => {
    const appData = join(root, 'appdata')
    const game = join(root, 'game')
    mkdirSync(join(appData, 'PCLCE'), { recursive: true })
    mkdirSync(join(appData, '.pclce'), { recursive: true })
    mkdirSync(game, { recursive: true })
    writeFileSync(join(appData, 'PCLCE', 'config.v1.json'), JSON.stringify({ LaunchFolders: `主>${game}\\`, LaunchArgumentJavaUser: '[{"Path":"j.exe","IsEnable":true}]' }))
    writeFileSync(join(appData, '.pclce', 'profiles.json'), JSON.stringify({ profiles: [{ type: 'microsoft', username: 'Steve', uuid: 'u', refreshToken: 'secret' }] }))
    writeFileSync(join(game, 'PCL.ini'), 'Version:我的整合包\r\nCardCount:1\r\n')
    const snapshot = await readPclSnapshot({ appData })
    assert.equal(snapshot.found, true)
    assert.equal(snapshot.selectedFolder, game)
    assert.equal(snapshot.selectedVersion, '我的整合包')
    assert.deepEqual(snapshot.javaPaths, ['j.exe'])
    assert.equal(snapshot.accounts[0].username, 'Steve')
    assert.ok(!JSON.stringify(snapshot).includes('secret'))
  })

  await test('版本 jar：PCL 合并版 JSON 用版本自己目录下的 jar，原版布局保持不变', () => {
    const game = join(root, 'game-jar')
    mkdirSync(join(game, 'versions', 'pack'), { recursive: true })
    writeFileSync(join(game, 'versions', 'pack', 'pack.jar'), '')
    const resolved = { minecraftVersion: '1.21.1', inheritances: ['pack'] } as unknown as Parameters<typeof useOwnVersionJar>[1]
    assert.equal(useOwnVersionJar(game, resolved).minecraftVersion, 'pack')
    mkdirSync(join(game, 'versions', '1.21.1'), { recursive: true })
    writeFileSync(join(game, 'versions', '1.21.1', '1.21.1.jar'), '')
    assert.equal(useOwnVersionJar(game, resolved).minecraftVersion, '1.21.1')
  })

  await test('PCL 快照：没装 PCL 时 found=false', async () => {
    const snapshot = await readPclSnapshot({ appData: join(root, 'nothing') })
    assert.equal(snapshot.found, false)
    assert.deepEqual(snapshot.folders, [])
  })

  await test('实例列表：识别 Fabric、版本隔离与 mod 数，坏 JSON 给出错误', async () => {
    const game = join(root, 'game2')
    const fabric = join(game, 'versions', 'fab')
    mkdirSync(join(fabric, 'mods'), { recursive: true })
    writeFileSync(join(fabric, 'mods', 'a.jar'), '')
    writeFileSync(join(fabric, 'mods', 'b.jar'), '')
    writeFileSync(join(fabric, 'fab.json'), JSON.stringify({ id: 'fab', inheritsFrom: '1.21', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5' }] }))
    const broken = join(game, 'versions', 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'broken.json'), '{')
    const list = await listInstances(game)
    assert.deepEqual(list.map((item) => item.id), ['broken', 'fab'])
    const fab = list[1]
    assert.equal(fab.loader, 'fabric')
    assert.equal(fab.loaderVersion, '0.19.5')
    assert.equal(fab.isolated, true)
    assert.equal(fab.gameDir, fabric)
    assert.equal(fab.modCount, 2)
    assert.equal(fab.minecraftVersion, '1.21')
    assert.ok(list[0].error)
  })
  await test('Mod 元数据图标字段：Fabric 尺寸表取最接近 64，mods.toml 与 mcmod.info 读 logoFile', () => {
    assert.equal(pickIconPath({ '16': 'a16.png', '128': 'a128.png', '48': 'a48.png' }), 'a48.png')
    assert.equal(pickIconPath('icon.png'), 'icon.png')
    assert.equal(pickIconPath(null), null)
    assert.equal(iconFromToml('modLoader="javafml"\n[[mods]]\nmodId="x"\nlogoFile="logo.png"\n'), 'logo.png')
    assert.equal(iconFromToml('modId="x"'), null)
    assert.equal(iconFromMcmodInfo('[{"modid":"x","logoFile":"/assets/x/logo.png"}]'), '/assets/x/logo.png')
    assert.equal(iconFromMcmodInfo('{"modListVersion":2,"modList":[{"logoFile":"l.png"}]}'), 'l.png')
  })

  await test('jar 图标：按 Fabric / Quilt / NeoForge 元数据取 PNG，不是 PNG 的跳过', async () => {
    const fabric = join(root, 'fabric.jar')
    writeFileSync(fabric, storedZip({ 'fabric.mod.json': JSON.stringify({ id: 'x', icon: 'assets/x/icon.png' }), 'assets/x/icon.png': PNG_STUB }))
    assert.deepEqual(await jarIcon(fabric), PNG_STUB)
    const quilt = join(root, 'quilt.jar')
    writeFileSync(quilt, storedZip({ 'quilt.mod.json': JSON.stringify({ quilt_loader: { metadata: { icon: { '32': 'q.png' } } } }), 'q.png': PNG_STUB }))
    assert.deepEqual(await jarIcon(quilt), PNG_STUB)
    const neo = join(root, 'neo.jar')
    writeFileSync(neo, storedZip({ 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="n"\nlogoFile="n.png"\n', 'n.png': PNG_STUB }))
    assert.deepEqual(await jarIcon(neo), PNG_STUB)
    const fake = join(root, 'fake.jar')
    writeFileSync(fake, storedZip({ 'fabric.mod.json': JSON.stringify({ icon: 'x.png' }), 'x.png': 'not png' }))
    assert.equal(await jarIcon(fake), null)
    assert.equal(await jarIcon(join(root, 'missing.jar')), null)
  })

  await test('实例图标：PCL 自定义 Logo 优先，其次加载器 jar，再次原版草方块；PCL 内置图标与越界路径不用', async () => {
    assert.equal(mavenPath('net.fabricmc:fabric-loader:0.19.5'), join('net', 'fabricmc', 'fabric-loader', '0.19.5', 'fabric-loader-0.19.5.jar'))
    const versionDir = join(root, 'icons', 'versions', 'v')
    assert.equal(pclLogoPath(versionDir, new Map([['LogoCustom', 'True'], ['Logo', 'pack://application:,,,/x.png']])), null)
    assert.equal(pclLogoPath(versionDir, new Map([['LogoCustom', 'True'], ['Logo', '..\\..\\evil.png']])), null)
    assert.equal(pclLogoPath(versionDir, new Map([['LogoCustom', 'True'], ['Logo', 'PCL\\Logo.png']])), join(versionDir, 'PCL', 'Logo.png'))

    const game = join(root, 'icons')
    const loaderPng = Buffer.concat([PNG_STUB, Buffer.from('loader')])
    const grassPng = Buffer.concat([PNG_STUB, Buffer.from('grass')])
    const logoPng = Buffer.concat([PNG_STUB, Buffer.from('logo')])
    mkdirSync(join(game, 'versions', '1.21'), { recursive: true })
    writeFileSync(join(game, 'versions', '1.21', '1.21.json'), JSON.stringify({ id: '1.21', libraries: [] }))
    writeFileSync(join(game, 'versions', '1.21', '1.21.jar'), storedZip({ 'assets/minecraft/textures/block/grass_block_side.png': grassPng }))
    mkdirSync(join(game, 'versions', 'fab'), { recursive: true })
    writeFileSync(join(game, 'versions', 'fab', 'fab.json'), JSON.stringify({ id: 'fab', inheritsFrom: '1.21', libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5' }] }))
    const loaderJar = join(game, 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.19.5')
    mkdirSync(loaderJar, { recursive: true })
    writeFileSync(join(loaderJar, 'fabric-loader-0.19.5.jar'), storedZip({ 'fabric.mod.json': '{"id":"fabricloader"}', 'assets/fabricloader/icon.png': loaderPng }))

    assert.deepEqual(await readInstanceIcon(game, '1.21'), grassPng)
    assert.deepEqual(await readInstanceIcon(game, 'fab'), loaderPng)
    mkdirSync(join(game, 'versions', 'fab', 'PCL'), { recursive: true })
    writeFileSync(join(game, 'versions', 'fab', 'PCL', 'Setup.ini'), 'LogoCustom:True\r\nLogo:PCL\\Logo.png\r\n')
    writeFileSync(join(game, 'versions', 'fab', 'PCL', 'Logo.png'), logoPng)
    assert.deepEqual(await readInstanceIcon(game, 'fab'), logoPng)
  })

  await test('任务中心：进度事件、同一版本互斥、取消后失败记为已取消', () => {
    const center = new TaskCenter()
    const events: TaskInfo[] = []
    center.on('task', (task: TaskInfo) => events.push(task))
    const task = center.start('install', '安装 1.21', 'F:\\mc|fab')
    task.progress({ done: 3, total: 10, unit: 'files' }, '下载库文件')
    assert.throws(() => center.start('repair', '修复', 'F:\\mc|fab'))
    task.succeed()
    assert.equal(center.list()[0].state, 'done')
    assert.equal(events.find((item) => item.progress)?.detail, '下载库文件')
    const second = center.start('repair', '修复', 'F:\\mc|fab')
    center.cancel(second.id)
    assert.equal(second.signal.aborted, true)
    second.fail(new Error('aborted'))
    assert.equal(center.list().find((item) => item.id === second.id)?.state, 'cancelled')
    center.clearFinished()
    assert.equal(center.list().length, 0)
  })

  await test('设置：下载源、并发与主题非法值回落默认', () => {
    const settings = normalizeSettings({ downloadSource: 'ftp', downloadConcurrency: 1000, theme: 'pink' })
    assert.equal(settings.downloadSource, 'auto')
    assert.equal(settings.downloadConcurrency, 16)
    assert.equal(settings.theme, 'system')
    assert.equal(normalizeSettings({ downloadSource: 'bmclapi', downloadConcurrency: 32, theme: 'dark' }).downloadConcurrency, 32)
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`inkstone-minecraft core: ${passed} 项通过`)
