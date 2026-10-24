import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommunityClient } from '../src/core/download/community.ts'
import { cleanupCancelledInstall } from '../src/core/install/cleanup.ts'
import { pickInstallerJava } from '../src/core/install/forge-install.ts'
import { importModpack, inspectModpack, parseModpackIndex, sanitizeVersionName } from '../src/core/install/mrpack.ts'
import { MANIFEST_URL } from '../src/core/download/sources.ts'
import { storedZip } from './zip-fixture.ts'

let passed = 0

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await Promise.resolve(run()).then(
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

function throwsMessage(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex')

const root = mkdtempSync(join(tmpdir(), 'inkstone-mc-download-'))
const gameFolder = join(root, 'game')
mkdirSync(join(gameFolder, 'versions'), { recursive: true })

const clientJar = Buffer.from('client jar bytes')
const modFile = Buffer.from('fake mod jar')
const manifest = {
  latest: { release: '1.21.1', snapshot: '26.4-snapshot-5' },
  versions: [{ id: '1.21.1', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/aa/1.21.1.json', sha1: null, size: null, releaseTime: '2024-08-08T00:00:00+00:00' }]
}
const versionJson = {
  id: '1.21.1',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  downloads: { client: { url: 'https://piston-data.mojang.com/v1/objects/aa/client.jar', sha1: sha1(clientJar), size: clientJar.length } },
  libraries: []
}

const routes = new Map<string, Buffer>()
routes.set(MANIFEST_URL, Buffer.from(JSON.stringify(manifest)))
routes.set('https://piston-meta.mojang.com/v1/packages/aa/1.21.1.json', Buffer.from(JSON.stringify(versionJson)))
routes.set('https://piston-data.mojang.com/v1/objects/aa/client.jar', clientJar)
routes.set('https://cdn.modrinth.com/data/pack/mods/example.jar', modFile)

let requests: string[] = []

const stubFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  requests.push(url)
  const body = routes.get(url)
  if (!body) return new Response('not found', { status: 404 })
  return new Response(body, { status: 200 })
}) as typeof fetch

function mrpackFile(files: Record<string, Buffer | string>): string {
  const path = join(root, `pack-${Math.random().toString(16).slice(2)}.mrpack`)
  writeFileSync(path, storedZip(files))
  return path
}

const packIndex = {
  formatVersion: 1,
  game: 'minecraft',
  versionId: '1.0.0',
  name: '测试整合包',
  summary: '小包',
  files: [
    { path: 'mods/example.jar', hashes: { sha1: sha1(modFile) }, fileSize: modFile.length, downloads: ['https://cdn.modrinth.com/data/pack/mods/example.jar'], env: { client: 'required', server: 'optional' } },
    { path: 'mods/server-only.jar', hashes: { sha1: 'a'.repeat(40) }, fileSize: 4, downloads: ['https://cdn.modrinth.com/data/pack/mods/server.jar'], env: { client: 'unsupported' } }
  ],
  dependencies: { minecraft: '1.21.1' }
}

await test('parseModpackIndex 读 Minecraft 版本与文件，跳过客户端不支持的文件', () => {
  const index = parseModpackIndex(packIndex)
  assert.equal(index.minecraft, '1.21.1')
  assert.equal(index.loader, 'vanilla')
  assert.equal(index.files.length, 1)
  assert.equal(index.skippedFiles, 1)
  assert.equal(index.files[0].path, 'mods/example.jar')
  assert.equal(index.files[0].sha1, sha1(modFile))
})

await test('parseModpackIndex 识别四种加载器', () => {
  const fabric = parseModpackIndex({ ...packIndex, dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' } })
  assert.equal(fabric.loader, 'fabric')
  assert.equal(fabric.loaderVersion, '0.16.9')
  const quilt = parseModpackIndex({ ...packIndex, dependencies: { minecraft: '1.21.1', 'quilt-loader': '0.30.1' } })
  assert.equal(quilt.loader, 'quilt')
  const forge = parseModpackIndex({ ...packIndex, dependencies: { minecraft: '1.20.1', forge: '47.4.28' } })
  assert.equal(forge.loader, 'forge')
  assert.equal(forge.loaderVersion, '47.4.28')
  const neoforge = parseModpackIndex({ ...packIndex, dependencies: { minecraft: '1.21.1', neoforge: '21.1.264' } })
  assert.equal(neoforge.loader, 'neoforge')
  assert.equal(neoforge.loaderVersion, '21.1.264')
})

await test('parseModpackIndex 拒绝错误格式、缺版本与越界路径', () => {
  assert.match(throwsMessage(() => parseModpackIndex({ ...packIndex, formatVersion: 2 })), /不支持的整合包格式/)
  assert.match(throwsMessage(() => parseModpackIndex({ ...packIndex, dependencies: {} })), /没有写 Minecraft 版本/)
  const escaping = { ...packIndex, files: [{ path: '../evil.jar', hashes: {}, downloads: ['https://cdn.modrinth.com/evil.jar'] }] }
  assert.match(throwsMessage(() => parseModpackIndex(escaping)), /路径不安全/)
  const noDownload = { ...packIndex, files: [{ path: 'mods/a.jar', hashes: {}, downloads: [] }] }
  assert.match(throwsMessage(() => parseModpackIndex(noDownload)), /没有可用的下载地址/)
})

await test('sanitizeVersionName 去掉非法字符', () => {
  assert.equal(sanitizeVersionName('a/b:c*?"<>|'), 'a b c')
  assert.equal(sanitizeVersionName('  多  空格  '), '多 空格')
})

const packPath = mrpackFile({
  'modrinth.index.json': JSON.stringify(packIndex),
  'overrides/config/example.toml': 'a = 1\n',
  'client-overrides/options.txt': 'lang:zh_cn\n'
})

await test('inspectModpack 读出名称、文件数与覆盖文件数', async () => {
  const summary = await inspectModpack(packPath)
  assert.equal(summary.minecraft, '1.21.1')
  assert.equal(summary.loader, 'vanilla')
  assert.equal(summary.name, '测试整合包')
  assert.equal(summary.versionId, '1.0.0')
  assert.equal(summary.files, 1)
  assert.equal(summary.overrides, 2)
})

await test('importModpack 装好原版、下载文件、解 overrides', async () => {
  const steps: string[] = []
  const result = await importModpack({
    folder: gameFolder,
    path: packPath,
    name: 'Pack Test',
    fetchImpl: stubFetch,
    onProgress: (progress, detail) => steps.push(`${progress.unit}:${progress.done}/${progress.total}${detail ? ` ${detail}` : ''}`)
  })
  assert.equal(result.name, 'Pack Test')
  assert.equal(result.loader, 'vanilla')
  assert.equal(result.files, 1)
  assert.equal(result.downloaded, 1)
  assert.equal(result.skipped, 0)
  assert.equal(result.overrides, 2)
  const versionDir = join(gameFolder, 'versions', 'Pack Test')
  assert.ok(existsSync(join(versionDir, 'Pack Test.json')))
  assert.ok(existsSync(join(versionDir, 'Pack Test.jar')))
  assert.equal(readFileSync(join(versionDir, 'mods', 'example.jar'), 'utf8'), modFile.toString())
  assert.equal(readFileSync(join(versionDir, 'config', 'example.toml'), 'utf8'), 'a = 1\n')
  assert.equal(readFileSync(join(versionDir, 'options.txt'), 'utf8'), 'lang:zh_cn\n')
  assert.ok(steps.some((line) => line.startsWith('steps:4/4')), `缺少解压阶段进度：${steps.join(' | ')}`)
  assert.ok(!existsSync(join(versionDir, 'mods', 'server-only.jar')))
})

await rejects('importModpack 同名版本拒绝重复导入', () => importModpack({ folder: gameFolder, path: packPath, name: 'Pack Test', fetchImpl: stubFetch }), /已存在/)

await test('importModpack 已装过的文件跳过下载', async () => {
  requests = []
  const result = await importModpack({ folder: gameFolder, path: packPath, name: 'Pack Again', fetchImpl: stubFetch })
  assert.equal(result.files, 1)
  assert.equal(result.downloaded, 1)
  assert.ok(requests.includes('https://cdn.modrinth.com/data/pack/mods/example.jar'))
})

await test('cleanupCancelledInstall 删掉 .part 与半成品版本目录，保留完整版本', async () => {
  const folder = join(root, 'cleanup-game')
  mkdirSync(join(folder, 'libraries', 'net', 'fabricmc'), { recursive: true })
  mkdirSync(join(folder, 'assets', 'objects', 'ab'), { recursive: true })
  mkdirSync(join(folder, 'versions', 'Half', 'mods'), { recursive: true })
  mkdirSync(join(folder, 'versions', 'Done'), { recursive: true })
  writeFileSync(join(folder, 'libraries', 'net', 'fabricmc', 'loader.jar.part'), 'x')
  writeFileSync(join(folder, 'assets', 'objects', 'ab', 'abcdef.part'), 'x')
  writeFileSync(join(folder, 'versions', 'Half', 'mods', 'a.jar.part'), 'x')
  writeFileSync(join(folder, 'versions', 'Done', 'Done.json'), '{}')
  writeFileSync(join(folder, 'versions', 'Done', 'Done.jar'), 'jar')
  const report = await cleanupCancelledInstall({ folder, name: 'Half' })
  assert.equal(report.removedParts, 3)
  assert.equal(report.removedDirs, 1)
  assert.equal(report.cleaned, 4)
  assert.ok(!existsSync(join(folder, 'libraries', 'net', 'fabricmc', 'loader.jar.part')))
  assert.ok(!existsSync(join(folder, 'assets', 'objects', 'ab', 'abcdef.part')))
  assert.ok(!existsSync(join(folder, 'versions', 'Half')))
  assert.ok(existsSync(join(folder, 'versions', 'Done', 'Done.json')))
  const again = await cleanupCancelledInstall({ folder, name: 'Done' })
  assert.equal(again.cleaned, 0)
  assert.ok(existsSync(join(folder, 'versions', 'Done', 'Done.jar')))
})

function fakeJava(home: string, version: string): string {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  const exe = join(bin, process.platform === 'win32' ? 'java.exe' : 'java')
  writeFileSync(exe, '')
  writeFileSync(join(home, 'release'), `JAVA_VERSION="${version}"\n`)
  return exe
}

await test('pickInstallerJava 从额外路径里按安装器要求的版本挑 Java', async () => {
  const j17 = fakeJava(join(root, 'java17'), '17.0.2')
  const j21 = fakeJava(join(root, 'java21'), '21.0.1')
  assert.equal(await pickInstallerJava([j17, j21], 17, 'Forge'), j17)
  assert.equal(await pickInstallerJava([j17, j21], 21, 'NeoForge'), j21)
  assert.equal(await pickInstallerJava([j17, j21], 8, 'Forge'), j17)
  const message = await pickInstallerJava([j17, j21], 99, 'NeoForge').then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
  assert.match(message, /需要 Java 99/)
  assert.match(message, /设置 → Java/)
})

await test('CommunityClient.search 带上项目类型、分类与游戏版本 facet', async () => {
  const seen: string[] = []
  const client = new CommunityClient({
    apiBase: 'https://api.modrinth.com/v2',
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return new Response(
        JSON.stringify({
          hits: [
            {
              project_id: 'abc',
              slug: 'abc',
              title: '资源包',
              description: '一个资源包',
              author: 'someone',
              downloads: 1234,
              follows: 1,
              date_modified: '2024-08-08T00:00:00Z',
              categories: ['realistic'],
              icon_url: 'https://cdn.modrinth.com/icon.png'
            }
          ],
          total_hits: 1,
          offset: 0,
          limit: 20
        }),
        { status: 200 }
      )
    }) as typeof fetch
  })
  const result = await client.search({ projectType: 'resourcepack', query: 'pack', category: 'realistic', loader: 'fabric', minecraft: '1.21.1', sort: 'downloads', limit: 20, offset: 0 })
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].title, '资源包')
  const url = new URL(seen[0])
  const facets = JSON.parse(url.searchParams.get('facets') ?? '[]') as string[][]
  assert.deepEqual(
    facets,
    [['project_type:resourcepack'], ['categories:realistic'], ['versions:1.21.1']]
  )
  assert.equal(url.searchParams.get('index'), 'downloads')
})

await test('CommunityClient.installTo 下载到目标目录，重复安装跳过', async () => {
  const dir = join(root, 'resourcepack-target')
  const data = Buffer.from('zip bytes here')
  const client = new CommunityClient({
    apiBase: 'https://api.modrinth.com/v2',
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/version/v1')) {
        return new Response(
          JSON.stringify({
            id: 'v1',
            project_id: 'pack',
            name: 'v1',
            version_number: '1.0',
            game_versions: ['1.21.1'],
            loaders: ['minecraft'],
            date_published: '2024-08-08T00:00:00Z',
            downloads: 1,
            files: [{ url: 'https://cdn.modrinth.com/data/pack/pack.zip', filename: 'pack.zip', size: data.length, primary: true, hashes: { sha1: sha1(data) } }],
            dependencies: []
          }),
          { status: 200 }
        )
      }
      return new Response(data, { status: 200 })
    }) as typeof fetch
  })
  const first = await client.installTo(dir, 'v1')
  assert.equal(first.file, 'pack.zip')
  assert.equal(first.skipped, false)
  assert.equal(readFileSync(join(dir, 'pack.zip')).length, data.length)
  const second = await client.installTo(dir, 'v1')
  assert.equal(second.skipped, true)
})

rmSync(root, { recursive: true, force: true })
console.log(`download: ${passed} 项通过`)
