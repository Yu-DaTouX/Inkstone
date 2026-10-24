import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import { clampConcurrency, downloadFiles, fetchJson, isAbortError } from '../src/core/download/download.ts'
import { candidateUrls, mirrorUrl, SourceStats } from '../src/core/download/sources.ts'
import { currentPlatform } from '../src/core/install/meta.ts'
import { listFabricLoaders, listMinecraftVersions, listQuiltLoaders } from '../src/core/install/list.ts'
import { repairInstance, quickCheck } from '../src/core/install/repair.ts'
import { installFabric, installQuilt } from '../src/core/install/loaders.ts'
import { installVanilla } from '../src/core/install/vanilla.ts'

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

const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex')
const platform = currentPlatform()

interface Route {
  body: Buffer
  status: number
  delayMs: number
  failFor: string | null
  failFirst: number
  corruptFirst: number
  hits: number
}

const routes = new Map<string, Route>()

function route(path: string, body: string | Buffer, init: Partial<Route> = {}): Buffer {
  const value: Route = { body: Buffer.isBuffer(body) ? body : Buffer.from(body), status: 200, delayMs: 0, failFor: null, failFirst: 0, corruptFirst: 0, hits: 0, ...init }
  routes.set(path, value)
  return value.body
}

let lastAgent = ''
const server: Server = createServer((request, response) => {
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
  const exact = decodeURIComponent(parsed.pathname + parsed.search)
  const key = routes.has(exact) ? exact : decodeURIComponent(parsed.pathname)
  const entry = routes.get(key)
  lastAgent = String(request.headers['user-agent'] ?? '')
  const origin = String(request.headers['x-test-origin'] ?? 'official')
  if (!entry) {
    response.writeHead(404)
    response.end('Not Found')
    return
  }
  entry.hits += 1
  if (entry.failFor === origin) {
    response.writeHead(500)
    response.end('source down')
    return
  }
  if (entry.failFirst && entry.hits <= entry.failFirst) {
    response.writeHead(500)
    response.end('flaky')
    return
  }
  const body = Buffer.from(entry.body)
  if (entry.corruptFirst && entry.hits <= entry.corruptFirst && body.length) body[body.length - 1] ^= 0xff
  const send = (): void => {
    response.writeHead(entry.status, { 'content-length': String(body.length) })
    response.end(body)
  }
  if (entry.delayMs) setTimeout(send, entry.delayMs)
  else send()
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port
const origin = `http://127.0.0.1:${port}`

const rewriteFetch = (): typeof fetch => {
  return async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const headers = new Headers(init?.headers)
    headers.set('x-test-origin', target.host.includes('bmclapi') ? 'bmclapi' : 'official')
    return fetch(`${origin}${target.pathname}${target.search}`, { ...init, headers })
  }
}

const MC = '1.21.1'
const clientJar = Buffer.from('client-jar-'.repeat(200))
const asmJar = Buffer.from('asm-'.repeat(120))
const nativesWindowsJar = Buffer.from('natives-windows-'.repeat(40))
const nativesLinuxJar = Buffer.from('natives-linux-'.repeat(40))
const nativesOsxJar = Buffer.from('natives-osx-'.repeat(40))
const osxOnlyJar = Buffer.from('osx-only-'.repeat(30))
const fabricLoaderJar = Buffer.from('fabric-loader-'.repeat(60))
const quiltLoaderJar = Buffer.from('quilt-loader-'.repeat(60))
const fabricApiJar = Buffer.from('fabric-api-'.repeat(90))
const qslJar = Buffer.from('qsl-'.repeat(70))
const assetOne = Buffer.from('{"asset":1}')
const assetTwo = Buffer.from('{"asset":2}')
const assetOneHash = sha1(assetOne)
const assetTwoHash = sha1(assetTwo)
const assetIndexBody = Buffer.from(
  JSON.stringify({
    objects: {
      'demo/one.json': { hash: assetOneHash, size: assetOne.length },
      'demo/two.json': { hash: assetTwoHash, size: assetTwo.length }
    }
  })
)
const indexSha = sha1(assetIndexBody)
const versionBody = Buffer.from(
  JSON.stringify({
    id: MC,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'demo',
    javaVersion: { majorVersion: 21 },
    assetIndex: { id: 'demo', sha1: indexSha, size: assetIndexBody.length, url: `https://piston-meta.mojang.com/v1/packages/${indexSha}/demo.json` },
    downloads: { client: { sha1: sha1(clientJar), size: clientJar.length, url: `https://piston-data.mojang.com/v1/objects/${sha1(clientJar)}/client.jar` } },
    libraries: [
      { name: 'org.ow2.asm:asm:9.7', downloads: { artifact: { url: `https://libraries.minecraft.net/org/ow2/asm/asm/9.7/asm-9.7.jar`, sha1: sha1(asmJar), size: asmJar.length } } },
      {
        name: 'org.lwjgl:lwjgl:3.3.3',
        natives: { windows: 'natives-windows', linux: 'natives-linux', osx: 'natives-osx' },
        downloads: {
          classifiers: {
            'natives-windows': { url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar', sha1: sha1(nativesWindowsJar), size: nativesWindowsJar.length },
            'natives-linux': { url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar', sha1: sha1(nativesLinuxJar), size: nativesLinuxJar.length },
            'natives-osx': { url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-osx.jar', sha1: sha1(nativesOsxJar), size: nativesOsxJar.length }
          }
        }
      },
      { name: 'example:osx-only:1.0', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { url: 'https://libraries.minecraft.net/example/osx-only/1.0/osx-only-1.0.jar', sha1: sha1(osxOnlyJar), size: osxOnlyJar.length } } }
    ]
  })
)
const versionSha = sha1(versionBody)
const manifestEntry = { url: `https://piston-meta.mojang.com/v1/packages/${versionSha}/${MC}.json`, sha1: versionSha, size: versionBody.length }
const manifestBody = Buffer.from(
  JSON.stringify({
    latest: { release: MC, snapshot: '26.4-snapshot' },
    versions: [
      { id: MC, type: 'release', ...manifestEntry, releaseTime: '2024-08-08T12:24:00+00:00' },
      { id: '26.4-snapshot', type: 'snapshot', ...manifestEntry, releaseTime: '2026-10-01T00:00:00+00:00' },
      { id: 'b1.7.3', type: 'old_beta', ...manifestEntry, releaseTime: '2011-07-08T00:00:00+00:00' }
    ]
  })
)

route('/mc/game/version_manifest_v2.json', manifestBody)
route(`/v1/packages/${versionSha}/${MC}.json`, versionBody)
route(`/v1/packages/${indexSha}/demo.json`, assetIndexBody)
route(`/v1/objects/${sha1(clientJar)}/client.jar`, clientJar)
route('/maven/org/ow2/asm/asm/9.7/asm-9.7.jar', asmJar)
route('/maven/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar', nativesWindowsJar)
route('/maven/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar', nativesLinuxJar)
route('/maven/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-osx.jar', nativesOsxJar)
route('/maven/example/osx-only/1.0/osx-only-1.0.jar', osxOnlyJar)
route(`/${assetOneHash.slice(0, 2)}/${assetOneHash}`, assetOne)
route(`/${assetTwoHash.slice(0, 2)}/${assetTwoHash}`, assetTwo)
route(`/assets/${assetOneHash.slice(0, 2)}/${assetOneHash}`, assetOne)
route(`/assets/${assetTwoHash.slice(0, 2)}/${assetTwoHash}`, assetTwo)
route('/fabric-meta/v2/versions/loader/1.21.1', JSON.stringify([
  { loader: { version: '0.21.0-beta.1', stable: false } },
  { loader: { version: '0.20.1', stable: true } },
  { loader: { version: '0.19.9', stable: true } }
]))
route('/fabric-meta/v2/versions/loader/1.21.1/0.20.1/profile/json', JSON.stringify({
  id: 'fabric-loader-0.20.1-1.21.1',
  inheritsFrom: MC,
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
  libraries: [{ name: 'net.fabricmc:fabric-loader:0.20.1', url: 'https://maven.fabricmc.net/', sha1: sha1(fabricLoaderJar), size: fabricLoaderJar.length }]
}))
route('/maven/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar', fabricLoaderJar)
route('/fabric-meta/v2/versions/loader/1.2.3-nope', '[]', { status: 400 })
route('/v3/versions/loader/1.21.1', JSON.stringify([
  { loader: { version: '0.20.0-beta.9' } },
  { loader: { version: '0.22.0' } },
  { loader: { version: '0.21.0-beta.1' } }
]))
route('/v3/versions/loader/1.21.1/0.22.0/profile/json', JSON.stringify({
  id: 'quilt-loader-0.22.0-1.21.1',
  inheritsFrom: MC,
  mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient',
  arguments: { game: [], jvm: [] },
  libraries: [{ name: 'org.quiltmc:quilt-loader:0.22.0', url: 'https://maven.quiltmc.org/repository/release/', sha1: sha1(quiltLoaderJar), size: quiltLoaderJar.length }]
}))
route('/maven/org/quiltmc/quilt-loader/0.22.0/quilt-loader-0.22.0.jar', quiltLoaderJar)
route('/v2/project/fabric-api/version', JSON.stringify([
  { version_number: '0.116.17+1.21.1', game_versions: [MC], date_published: '2024-11-01T00:00:00Z', files: [{ primary: true, url: 'https://cdn.modrinth.com/data/fabric-api/versions/abc/fabric-api-0.116.17.jar', filename: 'fabric-api-0.116.17.jar', size: fabricApiJar.length, hashes: { sha1: sha1(fabricApiJar) } }] }
]))
route('/data/fabric-api/versions/abc/fabric-api-0.116.17.jar', fabricApiJar)
route('/v2/project/qsl/version?loaders=["quilt"]&game_versions=["1.21.1"]', '[]')
route('/v2/project/qsl/version', JSON.stringify([
  { version_number: '11.0.0-alpha.3+0.102.0-1.21', game_versions: ['1.21'], date_published: '2024-08-01T00:00:00Z', files: [{ primary: true, url: 'https://cdn.modrinth.com/data/qsl/versions/q1/qsl-11.0.0.jar', filename: 'qsl-11.0.0.jar', size: qslJar.length, hashes: { sha1: sha1(qslJar) } }] },
  { version_number: '7.6.0+0.92.2-1.20.1', game_versions: ['1.20.1'], date_published: '2024-01-01T00:00:00Z', files: [{ primary: true, url: 'https://cdn.modrinth.com/data/qsl/versions/q0/qsl-7.6.0.jar', filename: 'qsl-7.6.0.jar', size: 10, hashes: { sha1: '0'.repeat(40) } }] }
]))
route('/data/qsl/versions/q1/qsl-11.0.0.jar', qslJar)

const root = mkdtempSync(join(tmpdir(), 'inkstone-mc-install-'))

function partFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...partFiles(full))
    else if (entry.name.endsWith('.part')) found.push(full)
  }
  return found
}

try {
  await test('替换表：auto 先 BMCLAPI 再官方，Quilt meta 与 Modrinth 不镜像，镜像主机可覆盖', () => {
    const manifest = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    assert.deepEqual(candidateUrls(manifest, 'auto').map((item) => item.source), ['bmclapi', 'official'])
    assert.equal(candidateUrls(manifest, 'bmclapi')[0].url, 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json')
    assert.deepEqual(candidateUrls(manifest, 'official'), [{ url: manifest, source: 'official', mirrored: false }])
    assert.equal(mirrorUrl('https://libraries.minecraft.net/org/ow2/asm/asm/9.7/asm-9.7.jar').url, 'https://bmclapi2.bangbang93.com/maven/org/ow2/asm/asm/9.7/asm-9.7.jar')
    assert.equal(mirrorUrl(`https://resources.download.minecraft.net/ab/${'a'.repeat(38)}ab`).url, `https://bmclapi2.bangbang93.com/assets/ab/${'a'.repeat(38)}ab`)
    assert.equal(mirrorUrl('https://meta.fabricmc.net/v2/versions/loader/1.21.1').url, 'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.21.1')
    assert.equal(mirrorUrl('https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar').url, 'https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar')
    assert.equal(mirrorUrl('https://meta.quiltmc.org/v3/versions/loader/1.21.1').mirrored, false)
    assert.equal(mirrorUrl('https://cdn.modrinth.com/data/x/versions/1/a.jar').mirrored, false)
    assert.equal(mirrorUrl('https://example.com/a.jar').mirrored, false)
    assert.equal(candidateUrls('https://meta.quiltmc.org/v3/versions/loader/1.21.1', 'bmclapi')[0].source, 'official')
    assert.equal(candidateUrls(manifest, 'auto', 'http://127.0.0.1:1')[0].url, 'http://127.0.0.1:1/mc/game/version_manifest_v2.json')
  })

  await test('下载器：真实 fetch 下载本地文件，校验 sha1 与大小，User-Agent 带包版本，不留临时文件', async () => {
    const dir = join(root, 'download-ok')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'asm.jar')
    const report = await downloadFiles([{ url: `${origin}/maven/org/ow2/asm/asm/9.7/asm-9.7.jar`, dest: file, sha1: sha1(asmJar), size: asmJar.length }], { concurrency: 4 })
    assert.equal(report.downloaded, 1)
    assert.equal(report.bytes, asmJar.length)
    assert.deepEqual(readFileSync(file), asmJar)
    assert.equal(lastAgent, `Yu-DaTouX/inkstone-minecraft/${pkg.version}`)
    assert.deepEqual(partFiles(dir), [])
    assert.equal(report.sources.official.rate, 1)
  })

  await test('下载器：sha1 不符重试后成功，进度 done/total 到齐', async () => {
    const dir = join(root, 'download-sha1')
    mkdirSync(dir, { recursive: true })
    const flaky = route('/flaky/asm.jar', asmJar, { corruptFirst: 1 })
    const progress: Array<{ done: number; total: number; unit: string }> = []
    const file = join(dir, 'asm.jar')
    const report = await downloadFiles(
      [{ url: `${origin}/flaky/asm.jar`, dest: file, sha1: sha1(flaky), size: flaky.length }],
      { onProgress: (value) => progress.push(value) }
    )
    assert.deepEqual(readFileSync(file), asmJar)
    assert.equal(routes.get('/flaky/asm.jar')?.hits, 2)
    assert.equal(report.sources.official.failed, 1)
    assert.equal(report.sources.official.ok, 1)
    assert.deepEqual(progress.at(-1), { done: 1, total: 1, unit: 'files' })
  })

  await test('下载器：auto 在 BMCLAPI 失败时换官方，并按源记录成功率', async () => {
    const dir = join(root, 'download-mirror')
    mkdirSync(dir, { recursive: true })
    const entry = route('/maven/mirror/asm.jar', asmJar, { failFor: 'bmclapi' })
    route('/mirror/asm.jar', entry)
    const stats = new SourceStats()
    const file = join(dir, 'asm.jar')
    const report = await downloadFiles([{ url: 'https://libraries.minecraft.net/mirror/asm.jar', dest: file, sha1: sha1(entry), size: entry.length }], { source: 'auto', retries: 0, stats, fetchImpl: rewriteFetch() })
    assert.deepEqual(readFileSync(file), asmJar)
    assert.equal(stats.snapshot().bmclapi.failed, 1)
    assert.equal(stats.snapshot().official.ok, 1)
    assert.equal(report.sources.official.ok, 1)
    assert.equal(routes.get('/maven/mirror/asm.jar')?.hits, 1)
    assert.equal(routes.get('/mirror/asm.jar')?.hits, 1)
  })

  await test('下载器：取消后抛 AbortError，目标与临时文件都不留', async () => {
    const dir = join(root, 'download-cancel')
    mkdirSync(dir, { recursive: true })
    const slow = route('/slow/asm.jar', asmJar, { delayMs: 400 })
    const controller = new AbortController()
    const file = join(dir, 'asm.jar')
    const pending = downloadFiles([{ url: `${origin}/slow/asm.jar`, dest: file, sha1: sha1(slow) }], { signal: controller.signal })
    setTimeout(() => controller.abort(), 60)
    await assert.rejects(pending, (error: unknown) => isAbortError(error))
    assert.deepEqual(partFiles(dir), [])
  })

  await test('安装原版：写入版本 JSON、客户端 jar、库与素材，预建 mods 目录，重名抛错', async () => {
    const folder = join(root, 'game')
    const result = await installVanilla({ folder, version: MC, fetchImpl: rewriteFetch(), concurrency: 4 })
    assert.equal(result.name, MC)
    assert.equal(result.loader, 'vanilla')
    assert.equal(result.isolated, true)
    assert.equal(result.downloaded, result.total)
    assert.ok(result.total >= 6)
    assert.ok(statSync(join(folder, 'versions', MC, `${MC}.json`)).size > 0)
    assert.deepEqual(readFileSync(join(folder, 'versions', MC, `${MC}.jar`)), clientJar)
    assert.deepEqual(readFileSync(join(folder, 'libraries', 'org', 'ow2', 'asm', 'asm', '9.7', 'asm-9.7.jar')), asmJar)
    assert.deepEqual(readFileSync(join(folder, 'libraries', 'org', 'lwjgl', 'lwjgl', '3.3.3', `lwjgl-3.3.3-natives-${platform.os}.jar`)), platform.os === 'windows' ? nativesWindowsJar : platform.os === 'osx' ? nativesOsxJar : nativesLinuxJar)
    assert.deepEqual(readFileSync(join(folder, 'assets', 'objects', assetOneHash.slice(0, 2), assetOneHash)), assetOne)
    assert.ok(statSync(join(folder, 'assets', 'indexes', 'demo.json')).size > 0)
    assert.equal(statSync(join(folder, 'versions', MC, 'mods')).isDirectory(), true)
    const osxOnly = join(folder, 'libraries', 'example', 'osx-only', '1.0', 'osx-only-1.0.jar')
    assert.equal(readdirSync(join(folder, 'libraries')).includes('example'), platform.os === 'osx')
    if (platform.os === 'osx') assert.deepEqual(readFileSync(osxOnly), osxOnlyJar)
    await assert.rejects(installVanilla({ folder, version: MC, fetchImpl: rewriteFetch() }), /已存在/)
    assert.deepEqual(partFiles(folder), [])
  })

  await test('安装 Fabric：合并加载器 JSON、复用客户端 jar、装 Fabric API、默认名与隔离', async () => {
    const folder = join(root, 'game')
    const result = await installFabric({ folder, version: MC, fetchImpl: rewriteFetch(), concurrency: 4 })
    assert.equal(result.name, `${MC}-Fabric 0.20.1`)
    assert.equal(result.loaderVersion, '0.20.1')
    assert.deepEqual(result.mods, ['fabric-api-0.116.17.jar'])
    const dir = join(folder, 'versions', result.name)
    const json = JSON.parse(readFileSync(join(dir, `${result.name}.json`), 'utf8')) as { id: string; inheritsFrom?: string; mainClass: string; libraries: Array<{ name: string }>; arguments: { jvm: string[] } }
    assert.equal(json.id, result.name)
    assert.equal(json.inheritsFrom, undefined)
    assert.equal(json.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient')
    assert.ok(json.libraries.some((library) => library.name === 'org.ow2.asm:asm:9.7'))
    assert.ok(json.libraries.some((library) => library.name === 'net.fabricmc:fabric-loader:0.20.1'))
    assert.ok(json.arguments.jvm.includes('-DFabricMcEmu= net.minecraft.client.main.Main '))
    assert.deepEqual(readFileSync(join(dir, `${result.name}.jar`)), clientJar)
    assert.deepEqual(readFileSync(join(dir, 'mods', 'fabric-api-0.116.17.jar')), fabricApiJar)
    assert.deepEqual(readFileSync(join(folder, 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.20.1', 'fabric-loader-0.20.1.jar')), fabricLoaderJar)
    assert.equal(statSync(join(dir, 'mods')).isDirectory(), true)
    await assert.rejects(installFabric({ folder, version: MC, fetchImpl: rewriteFetch() }), /已存在/)
  })

  await test('安装 Quilt：推荐最新非 beta，QSL 没有对应 MC 版本时跳过并说明', async () => {
    const folder = join(root, 'game')
    const result = await installQuilt({ folder, version: MC, fetchImpl: rewriteFetch(), concurrency: 4 })
    assert.equal(result.name, `${MC}-Quilt 0.22.0`)
    assert.equal(result.loaderVersion, '0.22.0')
    assert.deepEqual(result.mods, [])
    assert.equal(result.note, 'QSL 没有 1.21.1 版本，已跳过')
    const dir = join(folder, 'versions', result.name)
    assert.deepEqual(readdirSync(join(dir, 'mods')), [])
    assert.equal(routes.get('/data/qsl/versions/q1/qsl-11.0.0.jar')?.hits, 0)
    const json = JSON.parse(readFileSync(join(dir, `${result.name}.json`), 'utf8')) as { mainClass: string; libraries: Array<{ name: string }> }
    assert.equal(json.mainClass, 'org.quiltmc.loader.impl.launch.knot.KnotClient')
    assert.ok(json.libraries.some((library) => library.name === 'org.quiltmc:quilt-loader:0.22.0'))
    assert.deepEqual(readFileSync(join(dir, `${result.name}.jar`)), clientJar)
  })

  await test('修复：quickCheck 只比存在与大小且不联网，repairInstance 补回缺失与 sha1 不符的文件', async () => {
    const folder = join(root, 'game')
    const name = `${MC}-Fabric 0.20.1`
    const asm = join(folder, 'libraries', 'org', 'ow2', 'asm', 'asm', '9.7', 'asm-9.7.jar')
    const asset = join(folder, 'assets', 'objects', assetTwoHash.slice(0, 2), assetTwoHash)
    rmSync(asm)
    writeFileSync(asset, Buffer.from('{"asset":3}'))
    const quick = await quickCheck({ folder, name })
    assert.equal(quick.missing, 1)
    assert.deepEqual(quick.files, ['libraries/org/ow2/asm/asm/9.7/asm-9.7.jar'])
    assert.equal(quick.total, 7)
    const repaired = await repairInstance({ folder, name, fetchImpl: rewriteFetch(), concurrency: 4 })
    assert.equal(repaired.repaired, 2)
    assert.deepEqual(repaired.files.sort(), [`assets/objects/${assetTwoHash.slice(0, 2)}/${assetTwoHash}`, 'libraries/org/ow2/asm/asm/9.7/asm-9.7.jar'].sort())
    assert.deepEqual(readFileSync(asm), asmJar)
    assert.deepEqual(readFileSync(asset), assetTwo)
    const again = await repairInstance({ folder, name, fetchImpl: rewriteFetch(), concurrency: 4 })
    assert.equal(repaired.repaired, 2)
    assert.equal(again.repaired, 0)
    const after = await quickCheck({ folder, name })
    assert.equal(after.missing, 0)
  })

  await test('并发参数：默认 16，限制在 4–64', () => {
    assert.equal(clampConcurrency(undefined), 16)
    assert.equal(clampConcurrency(0), 16)
    assert.equal(clampConcurrency(1), 4)
    assert.equal(clampConcurrency(32), 32)
    assert.equal(clampConcurrency(1000), 64)
  })

  await test('版本列表：区分版本类型、标出最新正式版并给出推荐的加载器', async () => {
    const list = await listMinecraftVersions({ fetchImpl: rewriteFetch() })
    assert.equal(list.latest.release, MC)
    assert.equal(list.latest.snapshot, '26.4-snapshot')
    assert.deepEqual(list.versions.map((version) => [version.id, version.group, version.latest]), [
      [MC, 'release', true],
      ['26.4-snapshot', 'snapshot', false],
      ['b1.7.3', 'old', false]
    ])
    const fabric = await listFabricLoaders(MC, { fetchImpl: rewriteFetch() })
    assert.equal(fabric.recommended, '0.20.1')
    assert.deepEqual(fabric.loaders.map((loader) => loader.version), ['0.21.0-beta.1', '0.20.1', '0.19.9'])
    assert.equal(fabric.reason, null)
    const quilt = await listQuiltLoaders(MC, { fetchImpl: rewriteFetch() })
    assert.equal(quilt.recommended, '0.22.0')
  })

  await test('版本列表：没有加载器时返回空列表和原因文本', async () => {
    const fabric = await listFabricLoaders('1.2.3-nope', { fetchImpl: rewriteFetch() })
    assert.deepEqual(fabric.loaders, [])
    assert.equal(fabric.recommended, null)
    assert.equal(fabric.reason, '1.2.3-nope 没有 Fabric 版本')
    const quilt = await listQuiltLoaders('1.20.4', { fetchImpl: rewriteFetch() })
    assert.deepEqual(quilt.loaders, [])
    assert.equal(quilt.reason, '1.20.4 没有 Quilt 版本')
  })

  await test('修复：版本 JSON 带 inheritsFrom 链时沿链核对父版本文件', async () => {
    const folder = join(root, 'game')
    const name = 'PCL 合并包'
    const dir = join(folder, 'versions', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ id: name, inheritsFrom: MC, mainClass: 'net.minecraft.client.main.Main', libraries: [] }))
    const clean = await quickCheck({ folder, name })
    assert.equal(clean.missing, 0)
    assert.equal(clean.total, 6)
    const asm = join(folder, 'libraries', 'org', 'ow2', 'asm', 'asm', '9.7', 'asm-9.7.jar')
    rmSync(asm)
    const missing = await quickCheck({ folder, name })
    assert.deepEqual(missing.files, ['libraries/org/ow2/asm/asm/9.7/asm-9.7.jar'])
    const repaired = await repairInstance({ folder, name, fetchImpl: rewriteFetch(), concurrency: 4 })
    assert.equal(repaired.repaired, 1)
    assert.deepEqual(readFileSync(asm), asmJar)
    assert.equal((await quickCheck({ folder, name })).missing, 0)
  })

  await test('元数据请求：JSON 解析失败与 HTTP 404 都报错，auto 会试两个源', async () => {
    const cache = new Map<string, number>()
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input)
      cache.set(url, (cache.get(url) ?? 0) + 1)
      if (url.includes('bmclapi')) return new Response('not found', { status: 404 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const value = await fetchJson<Record<string, never>>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { fetchImpl: fakeFetch, retries: 0 })
    assert.deepEqual(value, {})
    assert.equal([...cache.keys()].length, 2)
    const bad = (async () => new Response('<html>', { status: 200 })) as typeof fetch
    await assert.rejects(fetchJson('https://example.com/x.json', { fetchImpl: bad }), /不是 JSON/)
  })
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

console.log(`inkstone-minecraft install: ${passed} 项通过`)
