import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeMods, loaderMismatch } from '../src/core/mods/analyze.ts'
import { collectDependencyNeeds, dependencyVersionLabel, installDependencyNeeds, loaderTags, missingDependencyIds, pickVersionForRange, spacedQueries } from '../src/core/mods/deps.ts'
import { matchesVersionRange } from '../src/core/mods/mc-range.ts'
import { ModsManager, type InstanceContext } from '../src/core/mods/manager.ts'
import { ModrinthClient } from '../src/core/mods/modrinth.ts'
import type { ModEntry, ModrinthVersion } from '../src/shared/mods-api.ts'
import { readJarMod } from '../src/core/mods/metadata.ts'
import { listTrash, moveToTrash, restoreFromTrash } from '../src/core/mods/trash.ts'
import { scanModFiles } from '../src/core/mods/scan.ts'
import { parseToml, tableArray, textOf } from '../src/core/mods/toml.ts'
import { normalizeOverride, directorySize, resolveSettings } from '../src/core/instance-settings.ts'
import { normalizeSettings } from '../src/core/settings.ts'
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

const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex')
const png = (label: string): Buffer => Buffer.concat([PNG_STUB, Buffer.from(label)])
const root = mkdtempSync(join(tmpdir(), 'inkstone-mc-mods-'))
const dataDir = join(root, 'data')
const gameDir = join(root, 'game')
const modsDir = join(gameDir, 'mods')

interface Routed {
  method: string
  url: string
  body: unknown
}

const routes = new Map<string, (body: unknown) => unknown>()

function route(path: string, handler: (body: unknown) => unknown): void {
  routes.set(path, handler)
}

const requests: Routed[] = []

function modEntry(overrides: Partial<ModEntry>): ModEntry {
  return {
    file: 'mod.jar',
    enabled: true,
    size: 1,
    sha1: 'sha-mod',
    modifiedAt: 0,
    kind: 'fabric',
    modId: 'mod',
    name: 'Mod',
    version: '1.0.0',
    description: null,
    icon: null,
    remoteIconUrl: null,
    projectId: null,
    mcRange: null,
    dependencies: [],
    provides: [],
    nestedIds: [],
    issues: [],
    ...overrides
  }
}

function mver(versionNumber: string): ModrinthVersion {
  return {
    id: `ver-${versionNumber}`,
    projectId: 'proj-dep',
    projectTitle: null,
    name: versionNumber,
    versionNumber,
    gameVersions: ['1.21.1'],
    loaders: ['fabric'],
    publishedAt: '2026-01-01T00:00:00Z',
    downloads: 0,
    file: { url: `https://cdn.test/${versionNumber}.jar`, fileName: `${versionNumber}.jar`, size: 1, sha1: 'sha-file' },
    dependencies: [],
    existsLocally: false
  }
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = String(init?.method ?? 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
  requests.push({ method, url, body })
  const parsed = new URL(url)
  const handler = [...routes.entries()].find(([key]) => parsed.pathname.endsWith(key))?.[1]
  if (!handler) {
    if (url.startsWith('https://cdn.test/')) {
      const data = downloadBody(parsed.pathname)
      return new Response(data, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  const value = handler(body)
  if (value instanceof Buffer) return new Response(value, { status: 200 })
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

const downloads = new Map<string, Buffer>()

function downloadBody(path: string): Buffer {
  const body = downloads.get(path)
  if (!body) throw new Error(`没有准备下载内容：${path}`)
  return body
}

function modrinthVersion(overrides: Record<string, unknown>): unknown {
  return {
    id: 'ver-1',
    project_id: 'proj-1',
    name: 'Sodium 0.6.0',
    version_number: '0.6.0',
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    date_published: '2026-01-02T00:00:00Z',
    downloads: 1000,
    files: [
      {
        url: 'https://cdn.test/new.jar',
        filename: 'sodium-0.6.0.jar',
        size: 0,
        primary: true,
        hashes: { sha1: sha1(Buffer.from('new-jar')) }
      }
    ],
    dependencies: [],
    ...overrides
  }
}

const ctx: InstanceContext = {
  folder: join(root, 'game'),
  versionId: '1.21.1-Fabric test',
  gameDir,
  loader: 'fabric',
  minecraftVersion: '1.21.1'
}

mkdirSync(modsDir, { recursive: true })

try {
  await test('TOML：数组表、引号键、多行描述与依赖表', () => {
    const table = parseToml(
      [
        'modLoader="javafml"',
        '[[mods]]',
        '    modId="examplemod"',
        '    version="1.2.3"',
        '    displayName="Example"',
        '    logoFile="logo.png"',
        '    description=\'\'\'',
        '    第一行',
        '    第二行',
        '    \'\'\'',
        '[[dependencies.examplemod]]',
        '    modId="minecraft"',
        '    mandatory=true',
        '    versionRange="[1.20.1,1.21)"',
        '[[dependencies.examplemod]]',
        '    modId="jei"',
        '    mandatory=false',
        '    versionRange="[15,)"'
      ].join('\n')
    )
    const mods = tableArray(table.mods)
    assert.equal(mods.length, 1)
    assert.equal(textOf(mods[0].modId), 'examplemod')
    assert.match(textOf(mods[0].description) ?? '', /第一行\n    第二行/)
    const deps = tableArray((table.dependencies as Record<string, unknown>).examplemod as never)
    assert.equal(deps.length, 2)
    assert.equal(textOf(deps[0].modId), 'minecraft')
    assert.equal(textOf(deps[1].versionRange), '[15,)')
  })

  await test('版本范围：Fabric 语义与 Maven 区间', () => {
    assert.equal(matchesVersionRange('>=1.21 <1.22', '1.21.1'), true)
    assert.equal(matchesVersionRange('>=1.21 <1.22', '1.22'), false)
    assert.equal(matchesVersionRange('1.21.x', '1.21.1'), true)
    assert.equal(matchesVersionRange('1.21.x', '1.22.1'), false)
    assert.equal(matchesVersionRange('~1.20.1', '1.20.4'), true)
    assert.equal(matchesVersionRange('~1.20.1', '1.21.0'), false)
    assert.equal(matchesVersionRange('^1.20', '1.21.9'), true)
    assert.equal(matchesVersionRange('[1.20.1,1.21)', '1.20.1'), true)
    assert.equal(matchesVersionRange('[1.20.1,1.21)', '1.21'), false)
    assert.equal(matchesVersionRange('*', '1.21.1'), true)
    assert.equal(matchesVersionRange(null, '1.21.1'), true)
  })

  await test('Fabric 元数据：id、名称、图标、depends 与 breaks', async () => {
    const jar = join(root, 'sodium.jar')
    writeFileSync(
      jar,
      storedZip({
        'fabric.mod.json': JSON.stringify({
          id: 'sodium',
          name: 'Sodium',
          version: '0.5.8',
          description: '渲染优化',
          icon: { 64: 'assets/sodium/icon_64.png', 128: 'assets/sodium/icon_128.png' },
          depends: { minecraft: '>=1.21', 'fabric-api': '*' },
          breaks: { optifine: '*' },
          provides: ['sodium-api']
        }),
        'assets/sodium/icon_64.png': png('sodium64'),
        'assets/sodium/icon_128.png': png('sodium128')
      })
    )
    const info = await readJarMod(jar)
    assert.equal(info.kind, 'fabric')
    assert.equal(info.modId, 'sodium')
    assert.equal(info.name, 'Sodium')
    assert.equal(info.version, '0.5.8')
    assert.equal(info.mcRange, '>=1.21')
    assert.deepEqual(info.provides, ['sodium-api'])
    assert.deepEqual(
      info.dependencies.map((dep) => [dep.modId, dep.kind]),
      [
        ['fabric-api', 'depends'],
        ['optifine', 'breaks']
      ]
    )
    assert.deepEqual(info.icon, png('sodium64'))
  })

  await test('Quilt 元数据：quilt_loader.metadata 与数组式 depends', async () => {
    const jar = join(root, 'quiltmod.jar')
    writeFileSync(
      jar,
      storedZip({
        'quilt.mod.json': JSON.stringify({
          quilt_loader: {
            id: 'qmod',
            version: '2.0.0',
            metadata: { name: 'Quilt Mod', description: '测试', icon: 'icon.png' },
            depends: [
              { id: 'minecraft', versions: '>=1.20' },
              { id: 'qsl', versions: '*' }
            ]
          }
        }),
        'icon.png': png('quilt')
      })
    )
    const info = await readJarMod(jar)
    assert.equal(info.kind, 'quilt')
    assert.equal(info.modId, 'qmod')
    assert.equal(info.name, 'Quilt Mod')
    assert.equal(info.mcRange, '>=1.20')
    assert.deepEqual(info.dependencies.map((dep) => dep.modId), ['qsl'])
    assert.deepEqual(info.icon, png('quilt'))
  })

  await test('Forge 元数据：mods.toml 的 displayName、logoFile 与 mandatory 依赖', async () => {
    const jar = join(root, 'forgemod.jar')
    writeFileSync(
      jar,
      storedZip({
        'META-INF/mods.toml': [
          'modLoader="javafml"',
          '[[mods]]',
          'modId="forgemod"',
          'version="3.1.4"',
          'displayName="Forge Mod"',
          'logoFile="forgemod.png"',
          'description="Forge 测试"',
          '[[dependencies.forgemod]]',
          'modId="minecraft"',
          'mandatory=true',
          'versionRange="[1.20.1,1.21)"',
          '[[dependencies.forgemod]]',
          'modId="jei"',
          'mandatory=true',
          'versionRange="[15,)"',
          '[[dependencies.forgemod]]',
          'modId="embeddium"',
          'mandatory=false',
          'versionRange="[0,)"'
        ].join('\n'),
        'forgemod.png': png('forge')
      })
    )
    const info = await readJarMod(jar)
    assert.equal(info.kind, 'forge')
    assert.equal(info.modId, 'forgemod')
    assert.equal(info.name, 'Forge Mod')
    assert.equal(info.mcRange, '[1.20.1,1.21)')
    assert.equal(info.dependencies.find((dep) => dep.modId === 'jei')?.required, true)
    assert.equal(info.dependencies.find((dep) => dep.modId === 'embeddium')?.required, false)
    assert.deepEqual(info.icon, png('forge'))
  })

  await test('NeoForge 元数据：type=incompatible 记为 breaks', async () => {
    const jar = join(root, 'neomod.jar')
    writeFileSync(
      jar,
      storedZip({
        'META-INF/neoforge.mods.toml': [
          '[[mods]]',
          'modId="neomod"',
          'version="1.0.0"',
          'displayName="Neo Mod"',
          '[[dependencies.neomod]]',
          'modId="minecraft"',
          'type="required"',
          'versionRange="[1.21,1.22)"',
          '[[dependencies.neomod]]',
          'modId="oldmod"',
          'type="incompatible"',
          'versionRange="*"'
        ].join('\n')
      })
    )
    const info = await readJarMod(jar)
    assert.equal(info.kind, 'neoforge')
    assert.equal(info.modId, 'neomod')
    assert.equal(info.mcRange, '[1.21,1.22)')
    assert.equal(info.dependencies[0].kind, 'breaks')
  })

  await test('mcmod.info：旧式 Forge 元数据与 requiredMods', async () => {
    const jar = join(root, 'legacymod.jar')
    writeFileSync(
      jar,
      storedZip({
        'mcmod.info': JSON.stringify([
          { modid: 'legacy', name: 'Legacy Mod', version: '1.0', description: '旧版', logoFile: 'legacy.png', requiredMods: ['forge@[10,)', 'codechickenlib@[3,)'] }
        ]),
        'legacy.png': png('legacy')
      })
    )
    const info = await readJarMod(jar)
    assert.equal(info.kind, 'legacy')
    assert.equal(info.modId, 'legacy')
    assert.deepEqual(info.dependencies.map((dep) => dep.modId), ['forge', 'codechickenlib'])
    assert.deepEqual(info.icon, png('legacy'))
  })

  await test('jar-in-jar：内嵌 Mod 的 id 与图标作为回退', async () => {
    const inner = storedZip({
      'fabric.mod.json': JSON.stringify({ id: 'nestedlib', name: 'Nested', version: '1.0.0', icon: 'nested.png' }),
      'nested.png': png('nested')
    })
    const jar = join(root, 'bundle.jar')
    writeFileSync(jar, storedZip({ 'META-INF/jars/nested.jar': inner, 'pack.png': png('pack') }))
    const info = await readJarMod(jar)
    assert.equal(info.kind, null)
    assert.deepEqual(info.nestedIds, ['nestedlib'])
    assert.deepEqual(info.icon, png('nested'))
  })

  await test('扫描：启用与停用文件、sha1 与文件名', async () => {
    writeFileSync(join(modsDir, 'a.jar'), storedZip({ 'fabric.mod.json': '{"id":"a","name":"A","version":"1"}' }))
    writeFileSync(join(modsDir, 'b.jar.disabled'), storedZip({ 'fabric.mod.json': '{"id":"b","name":"B","version":"1"}' }))
    writeFileSync(join(modsDir, 'notes.txt'), 'x')
    const files = await scanModFiles(gameDir)
    assert.deepEqual(files.map((file) => [file.file, file.enabled]), [
      ['a.jar', true],
      ['b.jar.disabled', false]
    ])
    assert.equal(files[0].sha1.length, 40)
  })

  await test('依赖检查：缺前置、停用前置、版本不符、重复、加载器不符与桥接例外', () => {
    const base = {
      size: 1,
      modifiedAt: 1,
      description: null,
      icon: null,
      remoteIconUrl: null,
      projectId: null,
      issues: []
    }
    const mods = analyzeMods(
      [
        {
          ...base,
          file: 'sodium.jar',
          enabled: true,
          sha1: 's1',
          kind: 'fabric',
          modId: 'sodium',
          name: 'Sodium',
          version: '1',
          mcRange: '>=1.21',
          dependencies: [
            { modId: 'fabric-api', required: true, versionRange: '*', kind: 'depends' },
            { modId: 'optifine', required: false, versionRange: '*', kind: 'breaks' }
          ],
          provides: [],
          nestedIds: []
        },
        {
          ...base,
          file: 'fabric-api.jar.disabled',
          enabled: false,
          sha1: 's2',
          kind: 'fabric',
          modId: 'fabric-api',
          name: 'Fabric API',
          version: '1',
          mcRange: null,
          dependencies: [],
          provides: [],
          nestedIds: []
        },
        {
          ...base,
          file: 'optifine.jar',
          enabled: true,
          sha1: 's3',
          kind: 'fabric',
          modId: 'optifine',
          name: 'OptiFine',
          version: '1',
          mcRange: '<1.20',
          dependencies: [],
          provides: [],
          nestedIds: []
        },
        {
          ...base,
          file: 'optifine-copy.jar',
          enabled: true,
          sha1: 's4',
          kind: 'fabric',
          modId: 'optifine',
          name: 'OptiFine',
          version: '1',
          mcRange: null,
          dependencies: [],
          provides: [],
          nestedIds: []
        }
      ],
      { loader: 'fabric', minecraftVersion: '1.21.1' }
    )
    const sodium = mods.find((mod) => mod.modId === 'sodium')!
    assert.deepEqual(sodium.issues.map((issue) => issue.kind).sort(), ['incompatible', 'missing-dependency'])
    assert.match(sodium.issues[0].text, /已停用/)
    const optifine = mods.find((mod) => mod.file === 'optifine.jar' && mod.enabled)!
    assert.deepEqual(optifine.issues.map((issue) => issue.kind).sort(), ['duplicate', 'mc-mismatch'])
    assert.equal(loaderMismatch('forge', 'fabric', false), true)
    assert.equal(loaderMismatch('forge', 'fabric', true), false)
    assert.equal(loaderMismatch('fabric', 'quilt', false), false)
  })

  await test('启停与回收站：改名、冲突提示、删除后恢复', async () => {
    const manager = new ModsManager({ dataDir, fetchImpl: fakeFetch })
    const list = await manager.list(ctx)
    assert.equal(list.counts.total, 2)
    const disabled = await manager.toggle(ctx, 'a.jar', false)
    assert.equal(disabled.mods.find((mod) => mod.file === 'a.jar.disabled')?.enabled, false)
    assert.equal(existsSync(join(modsDir, 'a.jar.disabled')), true)
    const enabled = await manager.toggle(ctx, 'a.jar.disabled', true)
    assert.equal(enabled.mods.some((mod) => mod.file === 'a.jar' && mod.enabled), true)
    writeFileSync(join(modsDir, 'a.jar.disabled'), 'x')
    await assert.rejects(() => manager.toggle(ctx, 'a.jar', false), /已经有/)
    rmSync(join(modsDir, 'a.jar.disabled'))

    const removed = await manager.remove(ctx, 'a.jar')
    assert.equal(removed.mods.some((mod) => mod.file === 'a.jar'), false)
    assert.equal(removed.trash.length, 1)
    assert.equal(existsSync(join(modsDir, 'a.jar')), false)
    assert.equal(readdirSync(join(gameDir, '.trash')).length, 1)
    const trashEntries = await listTrash(gameDir)
    await restoreFromTrash(gameDir, trashEntries[0].id)
    assert.equal(existsSync(join(modsDir, 'a.jar')), true)

    const trashed = await moveToTrash(gameDir, ctx.versionId, 'a.jar')
    writeFileSync(join(modsDir, 'a.jar'), 'conflict')
    await assert.rejects(() => restoreFromTrash(gameDir, trashed.id), /同名文件/)
    rmSync(join(modsDir, 'a.jar'))
  })

  await test('Modrinth：搜索 facet、更新查询与哈希识别', async () => {
    route('/search', () => ({
      hits: [
        { project_id: 'proj-1', slug: 'sodium', title: 'Sodium', description: '渲染', author: 'jellysquid3', downloads: 100, follows: 1, date_modified: '2026-01-01', categories: ['optimization'], icon_url: 'https://cdn.test/icon.png' }
      ],
      total_hits: 1,
      offset: 0,
      limit: 20
    }))
    route('/version_files', () => ({}))
    route('/version_files/update', () => ({ [sha1(Buffer.from('current-jar'))]: modrinthVersion({ project_id: 'proj-1' }) }))

    const manager = new ModsManager({ dataDir, fetchImpl: fakeFetch, apiBase: 'http://modrinth.test/v2' })
    const search = await manager.search({ query: 'sodium', loader: 'fabric', minecraft: '1.21.1', sort: 'downloads', limit: 20, offset: 0 })
    assert.equal(search.hits.length, 1)
    assert.equal(search.hits[0].title, 'Sodium')
    const searchRequest = requests.find((item) => item.url.includes('/search'))
    assert.match(searchRequest?.url ?? '', /facets=%5B%5B%22project_type%3Amod%22%5D/)
    assert.match(searchRequest?.url ?? '', /categories%3Afabric/)
    assert.match(searchRequest?.url ?? '', /index=downloads/)

    writeFileSync(join(modsDir, 'current.jar'), Buffer.from('current-jar'))
    const check = await manager.checkUpdates(ctx)
    assert.equal(check.error, null)
    assert.equal(check.updates.length, 1)
    assert.equal(check.updates[0].fileName, 'sodium-0.6.0.jar')
    assert.equal(check.updates[0].fileSha1, sha1(Buffer.from('new-jar')))
    const updateRequest = requests.find((item) => item.url.endsWith('/version_files/update'))
    const updateBody = updateRequest?.body as { hashes: string[]; algorithm: string; loaders: string[]; game_versions: string[] }
    assert.equal(updateBody.hashes.includes(sha1(Buffer.from('current-jar'))), true)
    assert.equal(updateBody.algorithm, 'sha1')
    assert.deepEqual(updateBody.loaders, ['fabric'])
    assert.deepEqual(updateBody.game_versions, ['1.21.1'])
  })

  await test('更新：下载新文件、旧文件进回收站', async () => {
    const newJar = Buffer.from('new-jar')
    downloads.set('/newjar.jar', newJar)
    route('/version_files', () => ({}))
    route('/version_files/update', () => ({ [sha1(Buffer.from('current-jar'))]: modrinthVersion({ files: [{ url: 'https://cdn.test/newjar.jar', filename: 'current.jar', size: newJar.length, primary: true, hashes: { sha1: sha1(newJar) } }] }) }))
    const manager = new ModsManager({ dataDir, fetchImpl: fakeFetch, apiBase: 'http://modrinth.test/v2' })
    const check = await manager.checkUpdates(ctx)
    assert.equal(check.updates.length, 1)
    const result = await manager.update(ctx, check.updates)
    assert.deepEqual(result.updated, ['current.jar'])
    assert.deepEqual(result.trashed, ['current.jar'])
    assert.deepEqual(readFileSync(join(modsDir, 'current.jar')), newJar)
    assert.equal((await listTrash(gameDir)).some((item) => item.file === 'current.jar'), true)
  })

  await test('安装：目标文件与必需前置一起下载，重复安装跳过', async () => {
    const targetJar = Buffer.from('installed-mod')
    const depJar = Buffer.from('installed-dep')
    downloads.set('/target.jar', targetJar)
    downloads.set('/dep.jar', depJar)
    route('/version/target-ver', () =>
      modrinthVersion({
        id: 'target-ver',
        project_id: 'proj-target',
        version_number: '1.0.0',
        files: [{ url: 'https://cdn.test/target.jar', filename: 'target-1.0.0.jar', size: targetJar.length, primary: true, hashes: { sha1: sha1(targetJar) } }],
        dependencies: [{ project_id: 'proj-dep', version_id: 'dep-ver', file_name: null, dependency_type: 'required' }]
      })
    )
    route('/versions', () => [
      modrinthVersion({
        id: 'dep-ver',
        project_id: 'proj-dep',
        version_number: '2.0.0',
        files: [{ url: 'https://cdn.test/dep.jar', filename: 'dep-2.0.0.jar', size: depJar.length, primary: true, hashes: { sha1: sha1(depJar) } }],
        dependencies: []
      })
    ])
    route('/project/proj-target', () => ({ id: 'proj-target', slug: 'target', title: 'Target', description: '目标', categories: [], downloads: 1, icon_url: 'https://cdn.test/t.png' }))
    const manager = new ModsManager({ dataDir, fetchImpl: fakeFetch, apiBase: 'http://modrinth.test/v2' })
    const result = await manager.install(ctx, 'target-ver')
    assert.deepEqual(result.installed.sort(), ['dep-2.0.0.jar', 'target-1.0.0.jar'])
    assert.deepEqual(result.dependencies, ['dep-2.0.0.jar'])
    assert.deepEqual(readFileSync(join(modsDir, 'target-1.0.0.jar')), targetJar)
    const again = await manager.install(ctx, 'target-ver')
    assert.equal(again.installed.length, 0)
    assert.equal(again.skipped.length, 2)
  })

  await test('单版本设置：覆盖优先于 PCL 与全局，非法值回落', () => {
    const settings = normalizeSettings({ maxMemoryMb: 4096 })
    const pcl = new Map([
      ['VersionRamCustom', '6144'],
      ['VersionArgumentJavaSelect', '{"Path":"F:\\\\Java\\\\bin\\\\"}']
    ])
    const { effective, source } = resolveSettings({ ...normalizeOverride({}), maxMemoryMb: 8192 }, pcl, settings)
    assert.equal(effective.maxMemoryMb, 8192)
    assert.equal(source.memory, 'instance')
    assert.equal(source.java, 'pcl')
    assert.match(effective.javaPath ?? '', /java\.exe$/)
    const fallback = resolveSettings(normalizeOverride({ maxMemoryMb: 10 }), new Map(), settings)
    assert.equal(fallback.effective.maxMemoryMb, 4096)
    assert.equal(fallback.source.memory, 'global')
    assert.equal(normalizeOverride({ windowWidth: -5, fullscreen: 'true' }).windowWidth, null)
    assert.equal(normalizeOverride({ fullscreen: 'true' }).fullscreen, true)
  })

  await test('目录占用：递归统计文件大小', async () => {
    const dir = join(root, 'size')
    mkdirSync(join(dir, 'inner'), { recursive: true })
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(100))
    writeFileSync(join(dir, 'inner', 'b.bin'), Buffer.alloc(50))
    assert.equal(await directorySize(dir), 150)
  })

  await test('依赖范围：合并声明者的范围与 modid 去重', () => {
    const entries = [
      modEntry({ file: 'sodium-extra.jar', name: 'Sodium Extra', dependencies: [{ modId: 'sodium-extra-api', required: true, versionRange: '>=1.0 <2.0', kind: 'depends' }] }),
      modEntry({ file: 'other.jar', name: 'Other', dependencies: [{ modId: 'sodium-extra-api', required: true, versionRange: '>=1.5', kind: 'depends' }] }),
      modEntry({ file: 'indium.jar', name: 'Indium', dependencies: [{ modId: 'fabric-api', required: true, versionRange: '*', kind: 'depends' }] })
    ]
    const needs = collectDependencyNeeds(entries, ['sodium-extra-api', 'fabric-api', 'minecraft'])
    assert.deepEqual(needs.map((need) => need.modId).sort(), ['fabric-api', 'sodium-extra-api'])
    const sodium = needs.find((need) => need.modId === 'sodium-extra-api')
    assert.deepEqual(sodium?.ranges, ['>=1.0 <2.0', '>=1.5'])
    assert.deepEqual(sodium?.requiredBy.sort(), ['Other', 'Sodium Extra'])
    assert.deepEqual(needs.find((need) => need.modId === 'fabric-api')?.ranges, [])
    assert.deepEqual(missingDependencyIds(entries), [])
  })

  await test('依赖范围：按范围选版本，选不到时给出原因', () => {
    const list = [mver('0.7.0'), mver('0.9.1'), mver('0.8.2')]
    assert.equal(pickVersionForRange(list, '>=0.8 <0.9').version?.versionNumber, '0.8.2')
    assert.equal(pickVersionForRange(list, null).version?.versionNumber, '0.9.1')
    assert.equal(pickVersionForRange(list, '0.7.x').version?.versionNumber, '0.7.0')
    const miss = pickVersionForRange(list, '>=2.0')
    assert.equal(miss.version, null)
    assert.match(miss.reason ?? '', /需要 >=2\.0/)
    assert.match(pickVersionForRange([], null).reason ?? '', /没有适合/)
  })

  await test('依赖范围：带 MC 前缀的版本号先剥前缀再比对', () => {
    const prefixed = [mver('1.21.1-1.5.7.2381'), mver('1.21.1-1.5.17.2426'), mver('mc1.21.1-0.6.0-beta.4-fabric')]
    assert.equal(dependencyVersionLabel(prefixed[0]!), '1.5.7.2381')
    assert.equal(dependencyVersionLabel(prefixed[2]!), '0.6.0-beta.4-fabric')
    const core = pickVersionForRange(prefixed.slice(0, 2), '[1.5.15,)')
    assert.equal(core.version?.versionNumber, '1.21.1-1.5.17.2426')
    const sodium = pickVersionForRange([prefixed[2]!], '>=0.6 <0.7')
    assert.equal(sodium.version?.versionNumber, 'mc1.21.1-0.6.0-beta.4-fabric')
    assert.equal(pickVersionForRange([prefixed[0]!], '[1.5.15,)').version, null)
  })

  await test('依赖范围：Quilt 同时查 Fabric 文件，modid 粘连时按空格重试', () => {
    assert.deepEqual(loaderTags('quilt'), ['quilt', 'fabric'])
    assert.deepEqual(loaderTags('forge'), ['forge'])
    assert.deepEqual(loaderTags('neoforge'), ['neoforge'])
    assert.equal(spacedQueries('sophisticatedcore').includes('sophisticated core'), true)
    assert.equal(spacedQueries('fabric-api').length, 0)
    assert.deepEqual(spacedQueries('abc'), [])
  })

  await test('依赖补全：按范围下载、已存在跳过、选不到说明原因', async () => {
    const inRange = Buffer.from('dependency-in-range')
    downloads.set('/dep-0.8.2.jar', inRange)
    route('/project/dependency-mod/version', () => [
      modrinthVersion({
        id: 'dep-091',
        project_id: 'proj-dependency',
        version_number: '0.9.1',
        files: [{ url: 'https://cdn.test/dep-0.9.1.jar', filename: 'dependency-mod-0.9.1.jar', size: 3, primary: true, hashes: { sha1: sha1(Buffer.from('out-of-range')) } }]
      }),
      modrinthVersion({
        id: 'dep-082',
        project_id: 'proj-dependency',
        version_number: '0.8.2',
        files: [{ url: 'https://cdn.test/dep-0.8.2.jar', filename: 'dependency-mod-0.8.2.jar', size: inRange.length, primary: true, hashes: { sha1: sha1(inRange) } }]
      })
    ])
    const client = new ModrinthClient({ fetchImpl: fakeFetch, apiBase: 'http://modrinth.test/v2' })
    const context = { modsDir, loader: 'fabric', minecraftVersion: '1.21.1' }
    const first = await installDependencyNeeds([{ modId: 'dependency-mod', ranges: ['>=0.8 <0.9'], requiredBy: ['Sodium Extra'] }], context, { client, fetchImpl: fakeFetch })
    assert.deepEqual(first.installed, ['dependency-mod-0.8.2.jar'])
    assert.deepEqual(readFileSync(join(modsDir, 'dependency-mod-0.8.2.jar')), inRange)
    const again = await installDependencyNeeds([{ modId: 'dependency-mod', ranges: ['>=0.8 <0.9'], requiredBy: ['Sodium Extra'] }], context, { client, fetchImpl: fakeFetch })
    assert.deepEqual(again.skipped, ['dependency-mod-0.8.2.jar'])
    assert.equal(again.installed.length, 0)
    const miss = await installDependencyNeeds([{ modId: 'dependency-mod', ranges: ['>=2.0'], requiredBy: [] }], context, { client, fetchImpl: fakeFetch })
    assert.equal(miss.failed.length, 1)
    assert.match(miss.failed[0]?.reason ?? '', /需要 >=2\.0/)
    const unknown = await installDependencyNeeds([{ modId: 'not-on-modrinth', ranges: [], requiredBy: [] }], context, { client, fetchImpl: fakeFetch })
    assert.equal(unknown.failed.length, 1)
  })

  await test('批量：多选启停与删除，失败项带原因', async () => {
    writeFileSync(join(modsDir, 'batch-a.jar'), Buffer.from('batch-a'))
    writeFileSync(join(modsDir, 'batch-b.jar'), Buffer.from('batch-b'))
    const manager = new ModsManager({ dataDir, fetchImpl: fakeFetch })
    const disabled = await manager.toggleMany(ctx, ['batch-a.jar', 'batch-b.jar', 'batch-missing.jar'], false)
    assert.deepEqual(disabled.done.sort(), ['batch-a.jar', 'batch-b.jar'])
    assert.equal(disabled.failed.length, 1)
    assert.match(disabled.failed[0]?.reason ?? '', /找不到/)
    assert.equal(existsSync(join(modsDir, 'batch-a.jar.disabled')), true)
    assert.equal(disabled.list.mods.filter((mod) => !mod.enabled).length >= 2, true)
    const removed = await manager.removeMany(ctx, ['batch-a.jar.disabled', 'batch-b.jar.disabled'])
    assert.deepEqual(removed.done.sort(), ['batch-a.jar.disabled', 'batch-b.jar.disabled'])
    assert.equal(existsSync(join(modsDir, 'batch-a.jar.disabled')), false)
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`inkstone-minecraft mods: ${passed} 项通过`)
