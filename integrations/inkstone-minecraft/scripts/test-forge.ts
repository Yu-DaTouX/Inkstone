import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { detectLoader } from '../src/core/instances.ts'
import { forgeArtifactVersion, forgeInstallerUrl, forgeLoaderVersion, forgeMirrorUrl, listForgeLoaders, listNeoForgeLoaders, neoForgeMinecraft, neoForgeProject, parseMavenMetadata } from '../src/core/install/forge-meta.ts'
import { downloadWithForgeMirror, libraryFilesExact, mergeLoaderJson } from '../src/core/install/forge-install.ts'
import { installNeoForge } from '../src/core/install/neoforge.ts'
import { installForge } from '../src/core/install/forge.ts'
import { currentPlatform } from '../src/core/install/meta.ts'
import { libraryDiskPath, mavenFilePath, parseInstallProfile, resolveProcessors, runProcessors } from '../src/core/install/processors.ts'
import { storedZip } from './zip-fixture.ts'

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

async function rejects(name: string, run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await test(name, async () => {
    let message = ''
    try {
      await run()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert.ok(message, '没有抛出错误')
    assert.match(message, pattern)
  })
}

function throwsWith(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex')

interface Route {
  body: Buffer
  status: number
  hits: number
}

const routes = new Map<string, Route>()

function route(path: string, body: string | Buffer, status = 200): Route {
  const entry: Route = { body: Buffer.isBuffer(body) ? body : Buffer.from(body), status, hits: 0 }
  routes.set(path, entry)
  return entry
}

const server: Server = createServer((request, response) => {
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
  const entry = routes.get(decodeURIComponent(parsed.pathname))
  if (!entry) {
    response.writeHead(404)
    response.end('Not Found')
    return
  }
  entry.hits += 1
  response.writeHead(entry.status, { 'content-length': String(entry.body.length) })
  response.end(entry.body)
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port

const rewriteFetch = (): typeof fetch => {
  return async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init)
  }
}

const forgeMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>net.minecraftforge</groupId>
  <artifactId>forge</artifactId>
  <versioning>
    <latest>26.3-66.1.0</latest>
    <release>26.3-66.1.0</release>
    <versions>
      <version>26.3-66.1.0</version>
      <version>1.20.1-47.4.28</version>
      <version>1.20.1-47.2.0</version>
      <version>1.12.2-14.23.5.2860</version>
      <version>1.7.10-10.13.4.1614-1.7.10</version>
      <version>1.8-11.14.4.1563</version>
    </versions>
  </versioning>
</metadata>`

const staleForgeMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<metadata><versioning><latest>1.18-38.0.17</latest><release>1.18-38.0.17</release><versions><version>1.18-38.0.17</version></versions></versioning></metadata>`

const neoForgeMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <versioning>
    <latest>26.3.0.97</latest>
    <release>26.3.0.97</release>
    <versions>
      <version>26.3.0.97</version>
      <version>26.1.2.122</version>
      <version>21.1.264</version>
      <version>21.1.1-beta</version>
      <version>21.0.167</version>
      <version>20.4.253</version>
      <version>0.25w14craftmine.5-beta</version>
    </versions>
  </versioning>
</metadata>`

const neoForgeLegacyMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<metadata><versioning><latest>1.20.1-47.1.106</latest><release>1.20.1-47.1.106</release><versions><version>1.20.1-47.1.106</version></versions></versioning></metadata>`

route('/net/minecraftforge/forge/maven-metadata.xml', forgeMetadata)
route('/maven/net/minecraftforge/forge/maven-metadata.xml', staleForgeMetadata)
route('/net/minecraftforge/forge/promotions_slim.json', JSON.stringify({ promos: { '1.20.1-recommended': '47.2.0', '1.20.1-latest': '47.4.28', '1.12.2-recommended': '14.23.5.2859' } }))
route('/releases/net/neoforged/neoforge/maven-metadata.xml', neoForgeMetadata)
route('/maven/net/neoforged/neoforge/maven-metadata.xml', neoForgeMetadata)
route('/releases/net/neoforged/forge/maven-metadata.xml', neoForgeLegacyMetadata)
route('/maven/net/neoforged/forge/maven-metadata.xml', neoForgeLegacyMetadata)
const buildsRoute = route('/forge/minecraft/1.20.1', JSON.stringify([{ version: '47.4.28', mcversion: '1.20.1' }, { version: '47.2.0', mcversion: '1.20.1' }]))

const fetchImpl = rewriteFetch()
const scratch = mkdtempSync(join(tmpdir(), 'inkstone-forge-'))

await test('parseMavenMetadata 解析版本与 latest/release', () => {
  const metadata = parseMavenMetadata(forgeMetadata)
  assert.equal(metadata.latest, '26.3-66.1.0')
  assert.equal(metadata.release, '26.3-66.1.0')
  assert.equal(metadata.versions.length, 6)
  assert.ok(metadata.versions.includes('1.12.2-14.23.5.2860'))
})

await test('listForgeLoaders 使用官方元数据并推荐 recommended', async () => {
  const listing = await listForgeLoaders('1.20.1', { fetchImpl, source: 'auto' })
  assert.deepEqual(listing.loaders.map((loader) => loader.version).sort(), ['47.2.0', '47.4.28'])
  assert.equal(listing.recommended, '47.2.0')
  assert.equal(listing.reason, null)
  assert.ok(listing.loaders.every((loader) => loader.stable))
})

await test('listForgeLoaders 官方元数据优先于 BMCLAPI 旧元数据', async () => {
  const official = routes.get('/net/minecraftforge/forge/maven-metadata.xml')!
  const before = official.hits
  const auto = await listForgeLoaders('1.20.1', { fetchImpl, source: 'auto' })
  assert.ok(auto.loaders.some((loader) => loader.version === '47.4.28'))
  assert.equal(auto.reason, null)
  assert.ok(official.hits > before)
  const mirroredOnly = await listForgeLoaders('1.20.1', { fetchImpl, source: 'bmclapi' })
  assert.ok(mirroredOnly.loaders.some((loader) => loader.version === '47.4.28'))
  assert.match(mirroredOnly.reason ?? '', /BMCLAPI/)
})

await test('listForgeLoaders 官方元数据失败时回退 BMCLAPI 构建列表', async () => {
  const official = routes.get('/net/minecraftforge/forge/maven-metadata.xml')!
  official.status = 500
  try {
    const listing = await listForgeLoaders('1.20.1', { fetchImpl, retries: 0 })
    assert.deepEqual(listing.loaders.map((loader) => loader.version).sort(), ['47.2.0', '47.4.28'])
    assert.match(listing.reason ?? '', /BMCLAPI/)
    assert.ok(buildsRoute.hits > 0)
  } finally {
    official.status = 200
  }
})

await test('listForgeLoaders 没有版本时给出原因', async () => {
  const listing = await listForgeLoaders('1.5.2', { fetchImpl })
  assert.deepEqual(listing.loaders, [])
  assert.equal(listing.recommended, null)
  assert.match(listing.reason ?? '', /没有 Forge 版本/)
})

await test('forgeArtifactVersion 处理 1.7.10、1.8 与新版命名', () => {
  const artifacts = ['1.7.10-10.13.4.1614-1.7.10', '1.8-11.14.4.1563', '1.20.1-47.2.0']
  assert.equal(forgeArtifactVersion('1.7.10', '10.13.4.1614-1.7.10', artifacts), '1.7.10-10.13.4.1614-1.7.10')
  assert.equal(forgeArtifactVersion('1.7.10', '10.13.4.1614', artifacts), '1.7.10-10.13.4.1614-1.7.10')
  assert.equal(forgeArtifactVersion('1.8', '11.14.4.1563', artifacts), '1.8-11.14.4.1563')
  assert.equal(forgeArtifactVersion('1.20.1', '47.2.0', artifacts), '1.20.1-47.2.0')
  assert.equal(forgeArtifactVersion('1.20.1', '1.20.1-47.2.0', artifacts), '1.20.1-47.2.0')
  assert.equal(forgeLoaderVersion('1.20.1', '1.20.1-47.2.0'), '47.2.0')
  assert.equal(forgeInstallerUrl('1.20.1-47.4.28'), 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.28/forge-1.20.1-47.4.28-installer.jar')
  assert.equal(forgeMirrorUrl('https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar'), 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar')
  assert.equal(forgeMirrorUrl('https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.209/neoforge-21.1.209-installer.jar'), 'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/21.1.209/neoforge-21.1.209-installer.jar')
  assert.equal(forgeMirrorUrl('https://libraries.minecraft.net/a/b.jar'), null)
})

await test('neoForgeMinecraft 版本号到 MC 的映射', () => {
  assert.equal(neoForgeMinecraft('21.1.264'), '1.21.1')
  assert.equal(neoForgeMinecraft('21.0.167'), '1.21')
  assert.equal(neoForgeMinecraft('20.4.253'), '1.20.4')
  assert.equal(neoForgeMinecraft('26.3.0.97'), '26.3')
  assert.equal(neoForgeMinecraft('26.1.2.122'), '26.1.2')
  assert.equal(neoForgeMinecraft('1.20.1-47.1.106'), '1.20.1')
  assert.equal(neoForgeMinecraft('0.25w14craftmine.5-beta'), null)
  assert.equal(neoForgeProject('1.20.1-47.1.106'), 'forge')
  assert.equal(neoForgeProject('21.1.209'), 'neoforge')
})

await test('listNeoForgeLoaders 排除 beta 并按 MC 分组', async () => {
  const listing = await listNeoForgeLoaders('1.21.1', { fetchImpl })
  assert.deepEqual(listing.loaders.map((loader) => loader.version).sort(), ['21.1.1-beta', '21.1.264'])
  assert.equal(listing.recommended, '21.1.264')
  assert.equal(listing.loaders.find((loader) => loader.version === '21.1.1-beta')?.stable, false)
  const newest = await listNeoForgeLoaders('26.3', { fetchImpl })
  assert.equal(newest.recommended, '26.3.0.97')
  const legacy = await listNeoForgeLoaders('1.20.1', { fetchImpl })
  assert.deepEqual(legacy.loaders.map((loader) => loader.version), ['1.20.1-47.1.106'])
})

await test('listNeoForgeLoaders 只有测试版时不给推荐', async () => {
  const metadata = routes.get('/releases/net/neoforged/neoforge/maven-metadata.xml')!
  const original = metadata.body
  metadata.body = Buffer.from(`<metadata><versioning><versions><version>21.9.16-beta</version></versions></versioning></metadata>`)
  try {
    const listing = await listNeoForgeLoaders('1.21.9', { fetchImpl })
    assert.equal(listing.recommended, null)
    assert.match(listing.reason ?? '', /测试版/)
  } finally {
    metadata.body = original
  }
})

await test('parseInstallProfile 解析旧式 versionInfo 与 install.filePath', () => {
  const profile = parseInstallProfile({
    install: { profileName: 'Forge', target: '1.7.10-Forge10.13.4.1614-1.7.10', path: 'net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10', filePath: 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar' },
    versionInfo: { id: '1.7.10-Forge10.13.4.1614-1.7.10', inheritsFrom: '1.7.10', mainClass: 'net.minecraft.launchwrapper.Launch', libraries: [{ name: 'net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10' }] }
  })
  assert.equal(profile.minecraft, '1.7.10')
  assert.equal(profile.filePath, 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar')
  assert.equal(profile.versionInfo?.mainClass, 'net.minecraft.launchwrapper.Launch')
  assert.equal(profile.processors.length, 0)
})

await test('parseInstallProfile 缺 minecraft 时从 install.target 之外的字段留空', () => {
  const empty = parseInstallProfile({})
  assert.equal(empty.minecraft, '')
  assert.equal(empty.jsonPath, 'version.json')
  assert.equal(empty.versionInfo, null)
})

await test('maven 坐标解析出附件与扩展名', () => {
  assert.equal(mavenFilePath('net.minecraftforge:forge:1.20.1-47.4.0:clientdata@lzma'), 'net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-clientdata.lzma')
  assert.equal(mavenFilePath('de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip'), 'de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip')
  assert.equal(libraryDiskPath('C:/game', 'org.ow2.asm:asm:9.6').endsWith(join('libraries', 'org', 'ow2', 'asm', 'asm', '9.6', 'asm-9.6.jar')), true)
  assert.match(throwsWith(() => mavenFilePath('broken')), /无法解析 maven 坐标/)
})

const mirrorJar = Buffer.from('forge-maven-from-bmclapi')
const officialJar = Buffer.from('forge-maven-from-official')
const mirrorRoute = route('/maven/net/minecraftforge/forge/9.9.9/demo-9.9.9.jar', mirrorJar)
const officialRoute = route('/net/minecraftforge/forge/9.9.9/demo-9.9.9.jar', officialJar)

await test('downloadWithForgeMirror 在 auto 下优先 BMCLAPI', async () => {
  const dest = join(scratch, 'mirror-first.jar')
  const officialBefore = officialRoute.hits
  const report = await downloadWithForgeMirror([{ url: 'https://maven.minecraftforge.net/net/minecraftforge/forge/9.9.9/demo-9.9.9.jar', dest, sha1: null, size: null }], { fetchImpl, source: 'auto' })
  assert.equal(readFileSync(dest).toString(), mirrorJar.toString())
  assert.equal(report.downloaded, 1)
  assert.ok(mirrorRoute.hits > 0)
  assert.equal(officialRoute.hits, officialBefore)
})

await test('downloadWithForgeMirror 在 BMCLAPI 失败后回退官方', async () => {
  const dest = join(scratch, 'mirror-fallback.jar')
  mirrorRoute.status = 500
  try {
    await downloadWithForgeMirror([{ url: 'https://maven.minecraftforge.net/net/minecraftforge/forge/9.9.9/demo-9.9.9.jar', dest, sha1: null, size: null }], { fetchImpl, source: 'auto', retries: 0 })
    assert.equal(readFileSync(dest).toString(), officialJar.toString())
    assert.ok(officialRoute.hits > 0)
  } finally {
    mirrorRoute.status = 200
  }
})

await test('libraryFilesExact 按 artifact.path 落盘并补默认仓库', () => {
  const folder = join(scratch, 'libraries-exact')
  const platform = currentPlatform()
  const files = libraryFilesExact(
    folder,
    [
      {
        name: 'de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip',
        downloads: { artifact: { path: 'de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip', url: 'https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip', sha1: 'a'.repeat(40), size: 12 } }
      },
      { name: 'net.minecraft:launchwrapper:1.12' },
      { name: 'net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10', url: 'https://maven.minecraftforge.net/' },
      {
        name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.1',
        natives: { windows: 'natives-windows' },
        downloads: { classifiers: { 'natives-windows': { path: 'org/lwjgl/lwjgl/lwjgl-platform/2.9.1/lwjgl-platform-2.9.1-natives-windows.jar', url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl-platform/2.9.1/lwjgl-platform-2.9.1-natives-windows.jar', sha1: 'b'.repeat(40), size: 3 } } }
      }
    ],
    platform
  )
  const byPath = new Map(files.map((file) => [file.dest, file]))
  const mcp = join(folder, 'libraries', 'de', 'oceanlabs', 'mcp', 'mcp_config', '1.20.1-20230612.114412', 'mcp_config-1.20.1-20230612.114412.zip')
  assert.equal(byPath.get(mcp)?.url, 'https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip')
  assert.equal(byPath.get(mcp)?.sha1, 'a'.repeat(40))
  assert.ok(byPath.has(join(folder, 'libraries', 'net', 'minecraft', 'launchwrapper', '1.12', 'launchwrapper-1.12.jar')))
  assert.equal(byPath.get(join(folder, 'libraries', 'net', 'minecraft', 'launchwrapper', '1.12', 'launchwrapper-1.12.jar'))?.url, 'https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar')
  assert.equal(byPath.get(join(folder, 'libraries', 'net', 'minecraftforge', 'forge', '1.7.10-10.13.4.1614-1.7.10', 'forge-1.7.10-10.13.4.1614-1.7.10.jar'))?.url, 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10.jar')
  assert.equal(files.filter((file) => file.dest.endsWith(`lwjgl-platform-2.9.1.jar`)).length, 0)
  const natives = files.filter((file) => file.dest.includes('natives'))
  assert.equal(natives.length, platform.os === 'windows' ? 1 : 0)
})

const profileSource = {
  minecraft: '1.20.1',
  version: '1.20.1-forge-47.4.0',
  json: '/version.json',
  data: {
    MAPPINGS: { client: '[de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412:mappings@txt]', server: '[de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412:mappings@txt]' },
    PATCHED_SHA: { client: "'b268fd6fb2c4829a72e8d0d6c75b7fefbec8479c'", server: "'62f6102e4b5d61a10281410cf5957a876a127e6b'" },
    PATCHED: { client: '[net.minecraftforge:forge:1.20.1-47.4.0:client]', server: '[net.minecraftforge:forge:1.20.1-47.4.0:server]' },
    ROOTED: { client: '{ROOT}/data/client.lzma', server: '{ROOT}/data/server.lzma' },
    BINPATCH: { client: '/data/client.lzma', server: '/data/server.lzma' }
  },
  processors: [
    {
      sides: ['server'],
      jar: 'net.minecraftforge:installertools:1.4.1',
      classpath: ['net.sf.jopt-simple:jopt-simple:6.0-alpha-3'],
      args: ['--task', 'EXTRACT_FILES', '--archive', '{INSTALLER}', '--to', '{ROOT}/run.sh']
    },
    {
      jar: 'net.minecraftforge:jarsplitter:1.1.4',
      classpath: ['net.sf.jopt-simple:jopt-simple:5.0.4', 'net.minecraftforge:srgutils:0.4.3'],
      args: ['--input', '{MINECRAFT_JAR}', '--slim', '{MC_SLIM}', '--side', '{SIDE}', '--config', '[de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip]'],
      outputs: { '{PATCHED}': '{PATCHED_SHA}' }
    }
  ]
}

const lzmaPath = join(scratch, 'client.lzma')

await test('resolveProcessors 替换 data 变量与 maven 参数', () => {
  const profile = parseInstallProfile({ ...profileSource, data: { ...profileSource.data, MC_SLIM: { client: '[net.minecraftforge:forge:1.20.1-47.4.0:client]', server: '[net.minecraftforge:forge:1.20.1-47.4.0:server]' } } })
  const processors = resolveProcessors(profile, { folder: scratch, minecraft: '1.20.1', side: 'client', installer: join(scratch, 'installer.jar'), clientLzma: lzmaPath })
  assert.equal(processors.length, 1)
  const processor = processors[0]
  assert.equal(processor.jarPath, join(scratch, 'libraries', 'net', 'minecraftforge', 'jarsplitter', '1.1.4', 'jarsplitter-1.1.4.jar'))
  assert.deepEqual(processor.args, [
    '--input',
    join(scratch, 'versions', '1.20.1', '1.20.1.jar'),
    '--slim',
    join(scratch, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.0', 'forge-1.20.1-47.4.0-client.jar'),
    '--side',
    'client',
    '--config',
    join(scratch, 'libraries', 'de', 'oceanlabs', 'mcp', 'mcp_config', '1.20.1-20230612.114412', 'mcp_config-1.20.1-20230612.114412.zip')
  ])
  assert.deepEqual(processor.outputs, [{ path: join(scratch, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.0', 'forge-1.20.1-47.4.0-client.jar'), sha1: 'b268fd6fb2c4829a72e8d0d6c75b7fefbec8479c' }])
})

await test('resolveProcessors 用解出的 client.lzma 覆盖 BINPATCH', () => {
  const withLzma = parseInstallProfile(profileSource)
  withLzma.processors[1].args = ['--apply', '{BINPATCH}']
  const resolved = resolveProcessors(withLzma, { folder: scratch, minecraft: '1.20.1', side: 'client', installer: join(scratch, 'installer.jar'), clientLzma: lzmaPath })
  assert.deepEqual(resolved[0].args, ['--apply', lzmaPath])
  assert.equal(resolved[0].classpathPaths.length, 2)
  const withoutLzma = parseInstallProfile(profileSource)
  withoutLzma.processors[1].args = ['--apply', '{BINPATCH}']
  const plain = resolveProcessors(withoutLzma, { folder: scratch, minecraft: '1.20.1', side: 'client', installer: join(scratch, 'installer.jar'), clientLzma: null })
  assert.deepEqual(plain[0].args, ['--apply', '/data/client.lzma'])
})

await test('resolveProcessors 未知变量与循环引用报错', () => {
  const unknown = parseInstallProfile({ ...profileSource, data: { ...profileSource.data, MC_SLIM: { client: '[net.minecraftforge:forge:1.20.1-47.4.0:client]', server: '[net.minecraftforge:forge:1.20.1-47.4.0:server]' } } })
  unknown.processors[1].args = ['--input', '{NOT_A_VARIABLE}']
  assert.match(throwsWith(() => resolveProcessors(unknown, { folder: scratch, minecraft: '1.20.1', side: 'client', installer: 'x', clientLzma: null })), /没有变量 NOT_A_VARIABLE/)
  const loop = parseInstallProfile({ ...profileSource, data: { A: { client: '{B}', server: '{B}' }, B: { client: '{A}', server: '{A}' } } })
  loop.processors[1].args = ['--input', '{A}']
  assert.match(throwsWith(() => resolveProcessors(loop, { folder: scratch, minecraft: '1.20.1', side: 'client', installer: 'x', clientLzma: null })), /循环引用/)
})

const manifest = (mainClass: string): string => `Manifest-Version: 1.0\r\nMain-Class: ${mainClass}\r\n\r\n`

function fakeSpawn(calls: string[][], onSpawn?: (index: number) => void): typeof spawn {
  const spawnImpl = (file: string, args: string[]): ChildProcess => {
    calls.push([file, ...args])
    onSpawn?.(calls.length)
    const child = new EventEmitter() as ChildProcess
    child.stdout = new EventEmitter() as ChildProcess['stdout']
    child.stderr = new EventEmitter() as ChildProcess['stderr']
    setTimeout(() => child.emit('close', 0), 0)
    return child
  }
  return spawnImpl as unknown as typeof spawn
}

await test('runProcessors 按顺序运行并校验 outputs', async () => {
  const folder = join(scratch, 'run-order')
  const tools = join(folder, 'libraries', 'demo', 'tool')
  mkdirSync(tools, { recursive: true })
  const jarOne = join(tools, 'tool-1.jar')
  const jarTwo = join(tools, 'tool-2.jar')
  const library = join(tools, 'lib-1.jar')
  writeFileSync(jarOne, storedZip({ 'META-INF/MANIFEST.MF': manifest('demo.ToolOne') }))
  writeFileSync(jarTwo, storedZip({ 'META-INF/MANIFEST.MF': manifest('demo.ToolTwo') }))
  writeFileSync(library, Buffer.from('lib'))
  const outOne = join(folder, 'out-one.jar')
  const outTwo = join(folder, 'out-two.jar')
  const payloadOne = Buffer.from('patched-one')
  const payloadTwo = Buffer.from('patched-two')
  const calls: string[][] = []
  const spawnImpl = fakeSpawn(calls, (index) => {
    writeFileSync(index === 1 ? outOne : outTwo, index === 1 ? payloadOne : payloadTwo)
  })
  const processors = [
    { jar: 'demo:tool:1', jarPath: jarOne, classpath: [], classpathPaths: [library], args: ['--one'], outputs: [{ path: outOne, sha1: sha1(payloadOne) }] },
    { jar: 'demo:tool:2', jarPath: jarTwo, classpath: [], classpathPaths: [], args: ['--two'], outputs: [{ path: outTwo, sha1: sha1(payloadTwo) }] }
  ]
  const result = await runProcessors(processors, { javaPath: 'java', cwd: folder, spawnImpl })
  assert.equal(result.ran, 2)
  assert.equal(result.outputs, 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'java')
  assert.equal(calls[0][1], '-cp')
  assert.equal(calls[0][2], [library, jarOne].join(delimiter))
  assert.equal(calls[0][3], 'demo.ToolOne')
  assert.equal(calls[0][4], '--one')
  assert.equal(calls[1][2], jarTwo)
  assert.equal(calls[1][3], 'demo.ToolTwo')
  assert.equal(calls[1][4], '--two')
})

await rejects(
  'runProcessors 在 outputs sha1 不符时报错',
  async () => {
    const folder = join(scratch, 'run-bad')
    mkdirSync(folder, { recursive: true })
    const jar = join(folder, 'tool.jar')
    writeFileSync(jar, storedZip({ 'META-INF/MANIFEST.MF': manifest('demo.Bad') }))
    const out = join(folder, 'out.jar')
    writeFileSync(out, Buffer.from('wrong'))
    const calls: string[][] = []
    return runProcessors([{ jar: 'demo:tool:1', jarPath: jar, classpath: [], classpathPaths: [], args: [], outputs: [{ path: out, sha1: sha1(Buffer.from('right')) }] }], { javaPath: 'java', cwd: folder, spawnImpl: fakeSpawn(calls) })
  },
  /产物 sha1 不符/
)

await rejects(
  'runProcessors 在 outputs 缺失时报错',
  async () => {
    const folder = join(scratch, 'run-missing')
    mkdirSync(folder, { recursive: true })
    const jar = join(folder, 'tool.jar')
    writeFileSync(jar, storedZip({ 'META-INF/MANIFEST.MF': manifest('demo.Missing') }))
    const calls: string[][] = []
    return runProcessors([{ jar: 'demo:tool:1', jarPath: jar, classpath: [], classpathPaths: [], args: [], outputs: [{ path: join(folder, 'absent.jar'), sha1: sha1(Buffer.from('x')) }] }], { javaPath: 'java', cwd: folder, spawnImpl: fakeSpawn(calls) })
  },
  /产物缺失/
)

await test('mergeLoaderJson 保留旧式 minecraftArguments', () => {
  const base = { id: '1.12.2', minecraftArguments: '--username ${auth_player_name} --versionType release', assets: '1.12', downloads: { client: { url: 'https://example/client.jar', sha1: 'a', size: 1 } } }
  const loader = {
    id: '1.12.2-forge-14.23.5.2860',
    inheritsFrom: '1.12.2',
    mainClass: 'net.minecraft.launchwrapper.Launch',
    minecraftArguments: '--username ${auth_player_name} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker',
    libraries: [{ name: 'net.minecraftforge:forge:1.12.2-14.23.5.2860' }]
  }
  const merged = mergeLoaderJson(base, loader, '1.12.2-Forge 14.23.5.2860')
  assert.equal(merged.id, '1.12.2-Forge 14.23.5.2860')
  assert.equal(merged.clientVersion, '1.12.2')
  assert.equal(merged.inheritsFrom, undefined)
  assert.equal(merged.arguments, undefined)
  assert.match(String(merged.minecraftArguments ?? ''), /FMLTweaker/)
  assert.equal(Array.isArray(merged.libraries) ? merged.libraries.length : -1, 1)
  assert.equal(merged.downloads?.client?.sha1, 'a')
})

await test('mergeLoaderJson 合并新式 arguments', () => {
  const base = { id: '1.20.1', arguments: { game: ['--username', '${auth_player_name}'], jvm: ['-Djava.library.path=${natives_directory}'] }, javaVersion: { majorVersion: 17 } }
  const loader = { mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', arguments: { game: ['--launchTarget', 'forgeclient'], jvm: [] }, libraries: [{ name: 'net.minecraftforge:fmlloader:1.20.1-47.4.0' }] }
  const merged = mergeLoaderJson(base, loader, '1.20.1-Forge 47.4.0')
  assert.deepEqual(merged.arguments, { game: ['--username', '${auth_player_name}', '--launchTarget', 'forgeclient'], jvm: ['-Djava.library.path=${natives_directory}'] })
  assert.equal(merged.minecraftArguments, undefined)
  assert.equal(merged.javaVersion?.majorVersion, 17)
})

await test('detectLoader 识别 Forge 1.20.1 与旧式 Forge', () => {
  const modern = detectLoader({
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [{ name: 'net.minecraftforge:fmlloader:1.20.1-47.4.0' }, { name: 'net.minecraftforge:forge:1.20.1-47.4.0:universal' }],
    arguments: { game: ['--fml.forgeVersion', '47.4.0', '--fml.mcVersion', '1.20.1'] }
  })
  assert.deepEqual(modern, { loader: 'forge', loaderVersion: '47.4.0' })
  const legacy = detectLoader({ mainClass: 'net.minecraft.launchwrapper.Launch', libraries: [{ name: 'net.minecraftforge:forge:1.12.2-14.23.5.2860' }] })
  assert.deepEqual(legacy, { loader: 'forge', loaderVersion: '1.12.2-14.23.5.2860' })
  const byMainClass = detectLoader({ mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', libraries: [] })
  assert.deepEqual(byMainClass, { loader: 'forge', loaderVersion: null })
})

await test('detectLoader 识别 NeoForge 前缀与主类', () => {
  const neoforge = detectLoader({
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [{ name: 'net.neoforged.fancymodloader:earlydisplay:4.0.41' }, { name: 'net.neoforged:accesstransformers:10.0.1' }],
    arguments: { game: ['--fml.neoForgeVersion', '21.1.209', '--fml.mcVersion', '1.21.1'] }
  })
  assert.deepEqual(neoforge, { loader: 'neoforge', loaderVersion: '21.1.209' })
  const byPrefix = detectLoader({ mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', libraries: [{ name: 'net.neoforged:bus:8.0.5' }] })
  assert.deepEqual(byPrefix, { loader: 'neoforge', loaderVersion: null })
  const byForgeGeneric = detectLoader({ mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', libraries: [{ name: 'net.minecraftforge:eventbus:6.0.5' }] })
  assert.deepEqual(byForgeGeneric, { loader: 'forge', loaderVersion: null })
  const generic = detectLoader({ mainClass: 'net.neoforged.bootstrap.Main', libraries: [] })
  assert.deepEqual(generic, { loader: 'neoforge', loaderVersion: null })
})

await rejects(
  'installForge 拒绝 1.5 及以下',
  async () => installForge({ folder: scratch, minecraft: '1.5.2' }),
  /1\.5 及以下/
)

await rejects(
  'installForge 拒绝列表里没有的版本',
  async () => installForge({ folder: scratch, minecraft: '1.20.1', loader: '9.9.9', fetchImpl }),
  /没有 Forge 9\.9\.9/
)

await rejects(
  'installNeoForge 拒绝列表里没有的版本',
  async () => installNeoForge({ folder: scratch, minecraft: '1.21.1', loader: '21.1.999', fetchImpl }),
  /没有 NeoForge 21\.1\.999/
)

server.close()
console.log(`inkstone-minecraft forge: ${passed} 项通过`)
