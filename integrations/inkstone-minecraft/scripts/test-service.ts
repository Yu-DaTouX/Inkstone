import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CraftService } from '../src/core/service.ts'
import type { InstallKind, TaskInfo } from '../src/shared/api.ts'

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

const FORGE_METADATA = `<metadata><versioning><versions>
<version>1.20.1-47.3.0</version>
<version>1.20.1-47.4.28</version>
<version>1.21.1-52.0.1</version>
</versions></versioning></metadata>`

const FORGE_PROMOTIONS = JSON.stringify({ promos: { '1.20.1-recommended': '47.4.28', '1.21.1-recommended': '52.0.1', '1.5.2-latest': '7.8.1' } })

const NEOFORGE_METADATA = `<metadata><versioning><versions>
<version>21.1.100-beta</version>
<version>21.1.264</version>
<version>21.2.9</version>
<version>26.1.2.122</version>
</versions></versioning></metadata>`

const NEOFORGE_LEGACY_METADATA = `<metadata><versioning><versions>
<version>1.20.1-47.1.106</version>
</versions></versioning></metadata>`

interface Route {
  prefix: string
  body: string
}

const ROUTES: Route[] = [
  { prefix: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', body: FORGE_METADATA },
  { prefix: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', body: FORGE_PROMOTIONS },
  { prefix: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', body: NEOFORGE_METADATA },
  { prefix: 'https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml', body: NEOFORGE_LEGACY_METADATA }
]

const hits = new Map<string, number>()
const originalFetch = globalThis.fetch

globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  hits.set(url, (hits.get(url) ?? 0) + 1)
  const route = ROUTES.find((item) => url.startsWith(item.prefix))
  if (!route) return new Response('not found', { status: 404 })
  return new Response(route.body, { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const root = mkdtempSync(join(tmpdir(), 'inkstone-mc-service-'))
const dataDir = join(root, 'data')
const folder = join(root, 'game')
mkdirSync(dataDir, { recursive: true })
mkdirSync(join(folder, 'versions'), { recursive: true })

const service = new CraftService({ dataDir, pclLauncherDirs: [] })
const events: TaskInfo[] = []
const changed: string[] = []
service.tasks.on('task', (task: TaskInfo) => events.push(task))
service.on('instances-changed', (path: string) => changed.push(path))

function taskOf(id: string): TaskInfo[] {
  return events.filter((task) => task.id === id)
}

async function waitSettled(id: string, timeoutMs: number): Promise<TaskInfo> {
  const startedAt = Date.now()
  for (;;) {
    const last = taskOf(id).at(-1)
    if (last && last.state !== 'running' && last.state !== 'queued') return last
    if (Date.now() - startedAt > timeoutMs) throw new Error(`任务 ${id} 在 ${timeoutMs}ms 内没有结束`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

try {
  await service.updateSettings({ folders: [{ name: 'l1-game', path: folder }], selectedFolder: folder })

  await test('Forge 1.20.1 版本列表与推荐', async () => {
    const listing = await service.loaderVersions('forge', '1.20.1')
    assert.equal(listing.minecraft, '1.20.1')
    assert.deepEqual(
      listing.loaders.map((entry) => entry.version),
      ['47.4.28', '47.3.0']
    )
    assert.equal(listing.recommended, '47.4.28')
    const before = hits.get('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml')
    await service.loaderVersions('forge', '1.20.1')
    assert.equal(hits.get('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'), before)
  })

  await test('NeoForge 1.21.1 版本列表取最新正式版', async () => {
    const listing = await service.loaderVersions('neoforge', '1.21.1')
    assert.deepEqual(
      listing.loaders.map((entry) => entry.version),
      ['21.1.264', '21.1.100-beta']
    )
    assert.equal(listing.recommended, '21.1.264')
    assert.equal(listing.loaders[1].stable, false)
  })

  await test('Forge 1.20.1 没有正式版时给原因', async () => {
    const listing = await service.loaderVersions('forge', '1.20.2')
    assert.deepEqual(listing.loaders, [])
    assert.match(listing.reason ?? '', /没有 Forge 版本/)
  })

  await test('安装 Forge 立即返回任务，进度按步骤上报，失败写进任务', async () => {
    const id = await service.install({ folder, kind: 'forge', minecraft: '1.20.1' })
    assert.ok(id)
    const first = taskOf(id)[0]
    assert.equal(first.title, '安装 1.20.1-Forge 47.4.28')
    assert.equal(first.kind, 'install')
    assert.equal(first.target, `${folder}|1.20.1-Forge 47.4.28`)
    const done = await waitSettled(id, 20000)
    assert.equal(done.state, 'failed')
    assert.match(done.error ?? '', /404/)
    const steps = taskOf(id).filter((task) => task.progress?.unit === 'steps')
    assert.ok(steps.length > 0)
    assert.deepEqual({ ...steps[0].progress }, { done: 1, total: 6, unit: 'steps' })
    assert.match(steps[0].detail ?? '', /安装原版 1\.20\.1/)
    assert.deepEqual(changed, [])
  })

  await test('安装 NeoForge 用推荐版本起任务', async () => {
    const id = await service.install({ folder, kind: 'neoforge', minecraft: '1.21.1' })
    const first = taskOf(id)[0]
    assert.equal(first.title, '安装 1.21.1-NeoForge 21.1.264')
    await waitSettled(id, 20000)
  })

  await test('取消安装把任务标成已取消', async () => {
    const id = await service.install({ folder, kind: 'forge', minecraft: '1.20.1', name: '取消示例' })
    service.tasks.cancel(id)
    const done = await waitSettled(id, 20000)
    assert.equal(done.state, 'cancelled')
  })

  await rejects('不在列表里的加载器版本被拒绝', () => service.install({ folder, kind: 'neoforge', minecraft: '1.21.1', loader: '9.9.9' }), /1\.21\.1 没有 NeoForge 9\.9\.9/)
  await rejects('没有 Forge 版本的 MC 用列表原因拒绝', () => service.install({ folder, kind: 'forge', minecraft: '1.5.2' }), /1\.5\.2 没有 Forge 版本/)
  await rejects('游戏目录不在列表里时拒绝安装', () => service.install({ folder: join(root, 'other'), kind: 'forge', minecraft: '1.20.1' }), /这个游戏目录不在列表里/)
  await rejects('没有选 MC 版本时拒绝取列表', () => service.loaderVersions('forge' as Extract<InstallKind, 'forge'>, '  '), /先选一个 Minecraft 版本/)

  console.log(`inkstone-minecraft service: ${passed} 项通过`)
} finally {
  globalThis.fetch = originalFetch
  service.dispose()
  rmSync(root, { recursive: true, force: true })
}
