import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, type Dirent } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  compareSaveVersion,
  compareVersionNames,
  createSnapshot,
  dataVersionFor,
  deleteSnapshot,
  describeVersion,
  formatBytes,
  importWorld,
  levelFromNbt,
  listSnapshots,
  listWorlds,
  readLevel,
  restoreSnapshot,
  snapshotId,
  snapshotLabel,
  snapshotTime,
  SNAPSHOT_DIR
} from '../src/core/dev/worlds.ts'
import { readNbt } from '../src/core/dev/nbt.ts'
import { createWorldTools } from '../mcp/tools-world.ts'
import { USER_IN_CONTROL } from '../mcp/tools.ts'
import type { DevProject } from '../src/core/dev/runner.ts'
import type { DevSessionInfo } from '../src/shared/dev-api.ts'
import type { ToolResult } from '../mcp/protocol.ts'

let passed = 0
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}

const root = mkdtempSync(join(tmpdir(), 'inkstone-worlds-test-'))

const TAG_END = 0
const TAG_BYTE = 1
const TAG_INT = 3
const TAG_LONG = 4
const TAG_STRING = 8
const TAG_LIST = 9
const TAG_COMPOUND = 10

interface Tag {
  type: number
  value: unknown
}

const intTag = (value: number): Tag => ({ type: TAG_INT, value })
const longTag = (value: number): Tag => ({ type: TAG_LONG, value })
const byteTag = (value: number): Tag => ({ type: TAG_BYTE, value })
const stringTag = (value: string): Tag => ({ type: TAG_STRING, value })
const compoundTag = (entries: Array<[string, Tag]>): Tag => ({ type: TAG_COMPOUND, value: entries })
const listTag = (values: Tag[]): Tag => ({ type: TAG_LIST, value: values })

function utf(value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  const head = Buffer.alloc(2)
  head.writeUInt16BE(body.length, 0)
  return Buffer.concat([head, body])
}

function payload(tag: Tag): Buffer {
  switch (tag.type) {
    case TAG_BYTE: {
      const buffer = Buffer.alloc(1)
      buffer.writeInt8(tag.value as number, 0)
      return buffer
    }
    case TAG_INT: {
      const buffer = Buffer.alloc(4)
      buffer.writeInt32BE(tag.value as number, 0)
      return buffer
    }
    case TAG_LONG: {
      const buffer = Buffer.alloc(8)
      buffer.writeBigInt64BE(BigInt(tag.value as number), 0)
      return buffer
    }
    case TAG_STRING:
      return utf(tag.value as string)
    case TAG_LIST: {
      const items = tag.value as Tag[]
      const head = Buffer.alloc(5)
      head.writeUInt8(items.length ? items[0].type : TAG_END, 0)
      head.writeInt32BE(items.length, 1)
      return Buffer.concat([head, ...items.map(payload)])
    }
    case TAG_COMPOUND: {
      const entries = tag.value as Array<[string, Tag]>
      return Buffer.concat([...entries.map(([name, item]) => Buffer.concat([Buffer.from([item.type]), utf(name), payload(item)])), Buffer.from([TAG_END])])
    }
    default:
      throw new Error(`测试编码器不支持标签 ${tag.type}`)
  }
}

interface LevelFixture {
  dataVersion: number
  versionName: string
  levelName?: string
  lastPlayed?: number
  gameType?: number
  hardcore?: boolean
  extra?: Array<[string, Tag]>
  compressed?: boolean
}

function levelDatBytes(fixture: LevelFixture): Buffer {
  const version = compoundTag([
    ['Id', intTag(fixture.dataVersion)],
    ['Name', stringTag(fixture.versionName)],
    ['Series', stringTag('main')],
    ['Snapshot', byteTag(0)]
  ])
  const data = compoundTag([
    ['DataVersion', intTag(fixture.dataVersion)],
    ['Version', version],
    ['LevelName', stringTag(fixture.levelName ?? '测试世界')],
    ['LastPlayed', longTag(fixture.lastPlayed ?? 1792830491667)],
    ['GameType', intTag(fixture.gameType ?? 1)],
    ['Difficulty', byteTag(0)],
    ['hardcore', byteTag(fixture.hardcore ? 1 : 0)],
    ['raining', byteTag(0)],
    ['ServerBrands', listTag([stringTag('fabric')])],
    ...(fixture.extra ?? [])
  ])
  const rootTag = Buffer.concat([Buffer.from([TAG_COMPOUND]), utf(''), payload(compoundTag([['Data', data]]))])
  return fixture.compressed === false ? rootTag : gzipSync(rootTag)
}

async function makeSave(dir: string, fixture: LevelFixture, files: Record<string, string> = {}): Promise<string> {
  await mkdir(join(dir, 'region'), { recursive: true })
  await writeFile(join(dir, 'level.dat'), levelDatBytes(fixture))
  await writeFile(join(dir, 'session.lock'), Buffer.from([1, 2, 3, 4]))
  await writeFile(join(dir, 'region', 'r.0.0.mca'), `region:${fixture.dataVersion}`)
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
  return dir
}

async function digest(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries: Dirent[] = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        hash.update(`d:${prefix}${entry.name}\n`)
        await walk(full, `${prefix}${entry.name}/`)
        continue
      }
      const info = await stat(full)
      hash.update(`f:${prefix}${entry.name}:${info.size}:${await readFile(full).then((bytes) => createHash('sha256').update(bytes).digest('hex'))}\n`)
    }
  }
  await walk(dir, '')
  return hash.digest('hex')
}

function toolOf(tools: ReturnType<typeof createWorldTools>, name: string) {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found, `找不到工具 ${name}`)
  return found
}

function bodyOf(result: ToolResult): string {
  return result.content
    .map((item) => item.text ?? '')
    .filter(Boolean)
    .join('\n')
}

const baseSession: DevSessionInfo = {
  projectDir: root,
  pid: 4321,
  state: 'running',
  startedAt: 1700000000000,
  javaPath: 'java',
  jbr: false,
  enhancedRedefinition: false,
  mixinHotswap: false,
  minecraftVersion: '1.21.1',
  jdwpPort: 5005,
  companionPort: 5006,
  companionReady: true,
  world: 'inkstone-test',
  logFile: null,
  exitCode: null,
  crashReport: null,
  message: null
}

interface StubOptions {
  projectDir: string
  owner?: 'agent' | 'user'
  running?: boolean
  world?: string
  calls: string[]
}

function stubProject(options: StubOptions): DevProject {
  const running = options.running !== false
  const session = (): DevSessionInfo => ({ ...baseSession, projectDir: options.projectDir, state: running ? 'running' : 'exited', pid: running ? 4321 : null, control: { owner: options.owner ?? 'agent', changedAt: 1700000000000, changedBy: 'agent' } })
  return {
    projectDir: options.projectDir,
    readSpec: async () => ({ workingDir: join(options.projectDir, 'run') }),
    status: async () => session(),
    control: async () => session().control ?? null,
    companion: async (path: string) => {
      options.calls.push(path)
      return path === '/snapshot-begin' ? { ok: true, lease: 'fixture-lease', worldPath: join(options.projectDir, 'run', 'saves', options.world ?? 'inkstone-test') } : { ok: true }
    },
    command: async (command: string) => {
      options.calls.push(`command:${command}`)
      return { command, ok: true, output: ['已保存'], error: null }
    },
    stop: async () => {
      options.calls.push('stop')
      return session()
    },
    launch: async () => {
      options.calls.push('launch')
      return session()
    }
  } as unknown as DevProject
}

function stubContext(project: DevProject, minecraft: string | null = '1.21.1') {
  return {
    options: { runtimesDir: root, javaPaths: [], maxMemoryMb: 4096, log: () => undefined },
    project: () => project,
    minecraft: async () => minecraft
  }
}

try {
  await test('NBT：读 gzip 的 level.dat', async () => {
    const dir = await makeSave(join(root, 'nbt-a'), { dataVersion: 3955, versionName: '1.21.1', levelName: '你好世界' })
    const level = await readLevel(dir)
    assert.equal(level.dataVersion, 3955)
    assert.equal(level.versionName, '1.21.1')
    assert.equal(level.levelName, '你好世界')
    assert.equal(level.lastPlayed, 1792830491667)
    assert.equal(level.gameType, 1)
    assert.equal(level.hardcore, false)
  })

  await test('NBT：未压缩的 level.dat 也读得出', async () => {
    const dir = await makeSave(join(root, 'nbt-b'), { dataVersion: 3465, versionName: '1.20.1', compressed: false })
    const level = await readLevel(dir)
    assert.equal(level.dataVersion, 3465)
    assert.equal(level.versionName, '1.20.1')
  })

  await test('NBT：嵌套 compound、list、数组和根下直接放 Data 都能读', async () => {
    const nested = gzipSync(
      Buffer.concat([
        Buffer.from([TAG_COMPOUND]),
        utf(''),
        payload(
          compoundTag([
            ['DataVersion', intTag(4325)],
            ['Version', compoundTag([['Name', stringTag('1.21.5')]])],
            ['WorldGenSettings', compoundTag([['dimensions', compoundTag([['minecraft:overworld', compoundTag([['generator', compoundTag([['type', stringTag('minecraft:flat')]])]])]])]])],
            ['ServerBrands', listTag([stringTag('fabric'), stringTag('inkstone')])]
          ])
        )
      ])
    )
    const rootless = levelFromNbt(readNbt(nested))
    assert.equal(rootless.dataVersion, 4325)
    assert.equal(rootless.versionName, '1.21.5')
    assert.equal(rootless.levelName, null)
  })

  await test('NBT：坏文件报出可读错误', async () => {
    const dir = join(root, 'nbt-bad')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'level.dat'), gzipSync(Buffer.from([TAG_COMPOUND, 0, 1])))
    await assert.rejects(() => readLevel(dir), /level\.dat 解析失败/)
    await assert.rejects(() => readLevel(join(root, 'nbt-missing')), /缺少 level\.dat/)
  })

  await test('NBT：真实存档 fixture（设了 INKSTONE_MC_SAVE 才跑）', async () => {
    const fixture = process.env.INKSTONE_MC_SAVE
    if (!fixture) return
    const level = await readLevel(fixture)
    assert.ok(level.dataVersion && level.dataVersion > 0, '真实存档应该有 DataVersion')
    assert.ok(level.versionName, '真实存档应该有 Version.Name')
  })

  await test('项目版本表：常用版本有 DataVersion', () => {
    assert.equal(dataVersionFor('1.21.1'), 3955)
    assert.equal(dataVersionFor('1.21'), 3953)
    assert.equal(dataVersionFor('v1.20.4'), 3700)
    assert.equal(dataVersionFor('26.1.2'), 4790)
    assert.equal(dataVersionFor('27.0'), null)
    assert.equal(dataVersionFor(null), null)
  })

  await test('版本比较：两边都有 DataVersion 时用它', () => {
    const newer = compareSaveVersion({ dataVersion: 4082, versionName: '1.21.3' }, { dataVersion: 3955, versionName: '1.21.1' })
    assert.equal(newer.order, 'newer')
    assert.equal(newer.basis, 'data-version')
    assert.match(newer.detail, /DataVersion 4082/)
    assert.equal(compareSaveVersion({ dataVersion: 3465, versionName: '1.20.1' }, { dataVersion: 3955, versionName: '1.21.1' }).order, 'older')
    assert.equal(compareSaveVersion({ dataVersion: 3955, versionName: '1.21.1' }, { dataVersion: 3955, versionName: '1.21.1' }).order, 'same')
    const crossVersion = compareSaveVersion({ dataVersion: 4790, versionName: '26.1.2' }, { dataVersion: dataVersionFor('1.21.1'), versionName: '1.21.1' })
    assert.equal(crossVersion.order, 'newer')
    assert.equal(crossVersion.basis, 'data-version')
  })

  await test('版本比较：版本表里没有时按版本号比较', () => {
    assert.equal(compareVersionNames('1.21.1', '1.21.3'), -1)
    assert.equal(compareVersionNames('26.1.2', '1.21.1'), 1)
    assert.equal(compareVersionNames('1.21', '1.21.0'), 0)
    assert.equal(compareVersionNames('snapshot', '1.21'), null)
    const compare = compareSaveVersion({ dataVersion: null, versionName: '1.20.1' }, { dataVersion: null, versionName: '26.1.2' })
    assert.equal(compare.order, 'older')
    assert.equal(compare.basis, 'name')
  })

  await test('版本比较：判断不了先后时报 unknown', () => {
    const compare = compareSaveVersion({ dataVersion: 4000, versionName: null }, { dataVersion: null, versionName: null })
    assert.equal(compare.order, 'unknown')
    assert.equal(compare.basis, 'none')
    assert.match(compare.detail, /无法判断/)
  })

  await test('导入：复制成副本、写导入标记、源存档一个字节都不变', async () => {
    const project = join(root, 'p-import')
    const source = await makeSave(join(root, 'ext-saves', '我的世界'), { dataVersion: 3465, versionName: '1.20.1', levelName: '老存档' }, { 'icon.png': 'icon-bytes' })
    const before = await digest(source)
    const result = await importWorld({ runDir: join(project, 'run'), source, projectVersion: '1.21.1' })
    assert.equal(result.world, '我的世界')
    assert.equal(result.dir, join(project, 'run', 'saves', '我的世界'))
    assert.equal(result.compare.order, 'older')
    assert.ok(result.warnings.some((line) => /会被升级/.test(line)), `warnings=${result.warnings.join('|')}`)
    assert.equal(await digest(source), before)
    assert.equal(await readFile(join(result.dir, 'region', 'r.0.0.mca'), 'utf8'), 'region:3465')
    const mark = JSON.parse(await readFile(join(result.dir, '.inkstone-import.json'), 'utf8')) as { source: string; dataVersion: number }
    assert.equal(mark.source, source)
    assert.equal(mark.dataVersion, 3465)
    assert.equal(result.renamedFrom, null)
    assert.ok(result.files >= 4)
    assert.equal(existsSync(join(result.dir, 'session.lock')), false)
    assert.equal(existsSync(join(source, 'session.lock')), true)
  })

  await test('导入：重名自动加后缀，name 可以指定名字', async () => {
    const project = join(root, 'p-import')
    const runDir = join(project, 'run')
    const source = await makeSave(join(root, 'ext-saves', '我的世界'), { dataVersion: 3955, versionName: '1.21.1' })
    const second = await importWorld({ runDir, source, projectVersion: '1.21.1' })
    assert.equal(second.world, '我的世界-2')
    assert.equal(second.renamedFrom, '我的世界')
    const third = await importWorld({ runDir, source, projectVersion: '1.21.1', name: 'baseline' })
    assert.equal(third.world, 'baseline')
    assert.deepEqual((await listWorlds(runDir)).map((entry) => entry.name).sort(), ['baseline', '我的世界', '我的世界-2'])
  })

  await test('导入：存档比项目新时拒绝，且不留半成品', async () => {
    const project = join(root, 'p-newer')
    const source = await makeSave(join(root, 'ext-newer', '新世界'), { dataVersion: 4325, versionName: '1.21.5' })
    await assert.rejects(
      () => importWorld({ runDir: join(project, 'run'), source, projectVersion: '1.21.1' }),
      (error: Error) => /已拒绝导入/.test(error.message) && /降级会损坏/.test(error.message) && /1\.21\.5/.test(error.message) && /1\.21\.1/.test(error.message)
    )
    assert.equal(existsSync(join(project, 'run', 'saves', '新世界')), false)
    const saved = await makeSave(join(root, 'ext-newer-name'), { dataVersion: 3953, versionName: '1.21' })
    const ok = await importWorld({ runDir: join(project, 'run'), source: saved, projectVersion: '1.21.1' })
    assert.equal(ok.compare.order, 'older')
  })

  await test('导入：源存档在开发 saves 里、指向 saves 目录、缺 level.dat 分别报错', async () => {
    const project = join(root, 'p-bad')
    const runDir = join(project, 'run')
    const inside = await makeSave(join(runDir, 'saves', '已存在'), { dataVersion: 3955, versionName: '1.21.1' })
    await assert.rejects(() => importWorld({ runDir, source: inside, projectVersion: '1.21.1' }), /已经在开发存档目录里/)
    await assert.rejects(() => importWorld({ runDir, source: join(root, 'ext-saves'), projectVersion: '1.21.1' }), /这是 saves 目录/)
    const empty = join(root, 'ext-empty')
    await mkdir(empty, { recursive: true })
    await assert.rejects(() => importWorld({ runDir, source: empty, projectVersion: '1.21.1' }), /缺少 level\.dat/)
    await assert.rejects(() => importWorld({ runDir, source: join(root, 'nope'), projectVersion: '1.21.1' }), /源存档不存在/)
    const levelFile = join(root, 'ext-one-file.txt')
    await writeFile(levelFile, 'x')
    await assert.rejects(() => importWorld({ runDir, source: levelFile, projectVersion: '1.21.1' }), /必须是世界文件夹/)
  })

  await test('列表：正在用的存档排最前，带导入来源和版本', async () => {
    const project = join(root, 'p-import')
    const runDir = join(project, 'run')
    const worlds = await listWorlds(runDir, '我的世界-2')
    assert.equal(worlds[0].name, '我的世界-2')
    assert.equal(worlds[0].active, true)
    assert.equal(worlds[0].level?.dataVersion, 3955)
    assert.match(describeVersion(worlds[0].level ?? { dataVersion: null, versionName: null }), /1\.21\.1（DataVersion 3955）/)
    const imported = worlds.find((entry) => entry.name === '我的世界')
    assert.ok(imported?.imported)
    assert.ok((imported?.files ?? 0) >= 4)
    await mkdir(join(runDir, 'saves', 'not-a-world'), { recursive: true })
    const withBroken = await listWorlds(runDir)
    const broken = withBroken.find((entry) => entry.name === 'not-a-world')
    assert.equal(broken?.level, null)
    assert.match(broken?.error ?? '', /缺少 level\.dat/)
    assert.deepEqual(await listWorlds(join(root, 'p-none', 'run')), [])
  })

  await test('快照：创建、列表、恢复、删', async () => {
    const project = join(root, 'p-snap')
    const runDir = join(project, 'run')
    const world = await makeSave(join(runDir, 'saves', 'inkstone-test'), { dataVersion: 3955, versionName: '1.21.1' }, { 'marker.txt': 'baseline' })
    const at = new Date(2026, 9, 24, 19, 1, 17).getTime()
    const snapshot = await createSnapshot({ runDir, projectDir: project, world: 'inkstone-test', label: 'baseline', at })
    assert.equal(snapshot.id, '20261024-190117-baseline')
    assert.equal(snapshotLabel(snapshot.id), 'baseline')
    assert.equal(snapshotTime(snapshot.id), at)
    assert.equal(snapshot.label, 'baseline')
    assert.equal(snapshot.dir, join(project, SNAPSHOT_DIR, 'inkstone-test', '20261024-190117-baseline'))
    assert.equal(snapshot.files, 3)
    assert.equal(existsSync(join(snapshot.dir, 'session.lock')), false)
    await writeFile(join(world, 'marker.txt'), 'changed')
    await writeFile(join(world, 'new-file.txt'), 'new')
    const restored = await restoreSnapshot({ runDir, projectDir: project, world: 'inkstone-test', id: snapshot.id })
    assert.equal(restored.replaced, true)
    assert.equal(await readFile(join(world, 'marker.txt'), 'utf8'), 'baseline')
    assert.equal(existsSync(join(world, 'new-file.txt')), false)
    assert.ok(restored.backup, '恢复前应该自动备份')
    assert.match(restored.backup?.id ?? '', /-before-restore$/)
    assert.equal(await readFile(join(restored.backup?.dir ?? '', 'marker.txt'), 'utf8'), 'changed')
    const listed = await listSnapshots(project, 'inkstone-test')
    assert.equal(listed.length, 2)
    assert.equal(listed[0].label, 'before-restore')
    await deleteSnapshot(project, 'inkstone-test', restored.backup?.id ?? '')
    assert.equal((await listSnapshots(project, 'inkstone-test')).length, 1)
    const all = await listSnapshots(project)
    assert.equal(all.length, 1)
    assert.equal(all[0].world, 'inkstone-test')
  })

  await test('快照：复制期间不可恢复，屏障失效不留下可恢复半成品', async () => {
    const project = join(root, 'p-snapshot-barrier')
    const runDir = join(project, 'run')
    await makeSave(join(runDir, 'saves', 'w'), { dataVersion: 3955, versionName: '1.21.1' })
    await assert.rejects(createSnapshot({ runDir, projectDir: project, world: 'w', beforePublish: async () => {
      assert.equal((await listSnapshots(project, 'w')).length, 0)
      throw new Error('lease expired')
    } }), /lease expired/)
    assert.equal((await listSnapshots(project, 'w')).length, 0)
    const result = await createSnapshot({ runDir, projectDir: project, world: 'w', beforePublish: async () => { assert.equal((await listSnapshots(project, 'w')).length, 0) } })
    assert.equal((await listSnapshots(project, 'w'))[0].id, result.id)
  })

  await test('快照：同秒重名加序号、同标签不重名、backup=false 不备份', async () => {
    const project = join(root, 'p-snap2')
    const runDir = join(project, 'run')
    const world = await makeSave(join(runDir, 'saves', 'w'), { dataVersion: 3955, versionName: '1.21.1' })
    const at = new Date(2026, 9, 24, 20, 0, 0).getTime()
    const first = await createSnapshot({ runDir, projectDir: project, world: 'w', at })
    const second = await createSnapshot({ runDir, projectDir: project, world: 'w', at })
    assert.equal(first.id, '20261024-200000')
    assert.equal(second.id, '20261024-200000-2')
    await writeFile(join(world, 'marker.txt'), 'later')
    const restored = await restoreSnapshot({ runDir, projectDir: project, world: 'w', id: first.id, backup: false })
    assert.equal(restored.backup, null)
    assert.equal(existsSync(join(world, 'marker.txt')), false)
  })

  await test('快照：id 和存档名校验挡路径穿越，缺 level.dat 报错', async () => {
    const project = join(root, 'p-snap3')
    const runDir = join(project, 'run')
    await makeSave(join(runDir, 'saves', 'w'), { dataVersion: 3955, versionName: '1.21.1' })
    await assert.rejects(() => deleteSnapshot(project, 'w', '../w'), /不合法/)
    await assert.rejects(() => deleteSnapshot(project, '..', 'x'), /不合法/)
    await assert.rejects(() => restoreSnapshot({ runDir, projectDir: project, world: 'w', id: '../w' }), /不合法/)
    await assert.rejects(() => createSnapshot({ runDir, projectDir: project, world: '../escape' }), /不合法/)
    await assert.rejects(() => createSnapshot({ runDir, projectDir: project, world: 'nope' }), /不存在/)
    await assert.rejects(() => restoreSnapshot({ runDir, projectDir: project, world: 'w', id: '20261024-200000' }), /没有 level\.dat/)
    await mkdir(join(project, SNAPSHOT_DIR, 'w', '20261024-200000'), { recursive: true })
    await assert.rejects(() => restoreSnapshot({ runDir, projectDir: project, world: 'w', id: '20261024-200000' }), /没有 level\.dat/)
  })

  await test('快照 id：中文标签保留，空标签只用时间戳', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime()
    assert.equal(snapshotId(at), '20260102-030405')
    assert.equal(snapshotId(at, '  '), '20260102-030405')
    assert.equal(snapshotId(at, '测试前'), '20260102-030405-测试前')
    assert.equal(snapshotId(at, 'a/b c'), '20260102-030405-a-b-c')
  })

  await test('MCP：list 报出存档目录和正在用的存档', async () => {
    const project = join(root, 'p-mcp-list')
    const runDir = join(project, 'run')
    await makeSave(join(runDir, 'saves', 'inkstone-test'), { dataVersion: 3955, versionName: '1.21.1' })
    await importWorld({ runDir, source: await makeSave(join(root, 'ext-list', '外面的'), { dataVersion: 3465, versionName: '1.20.1' }), projectVersion: '1.21.1' })
    const calls: string[] = []
    const tools = createWorldTools(stubContext(stubProject({ projectDir: project, calls })))
    const listed = await toolOf(tools, 'mc_world').run({ action: 'list' })
    assert.equal(listed.isError, undefined)
    assert.match(bodyOf(listed), /开发存档 2 个/)
    assert.match(bodyOf(listed), /正在用 inkstone-test/)
    assert.match(bodyOf(listed), /▶ inkstone-test  Minecraft 1\.21\.1（DataVersion 3955）/)
    assert.match(bodyOf(listed), /外面的  Minecraft 1\.20\.1（DataVersion 3465）/)
    assert.match(bodyOf(listed), /导入自/)
    const empty = createWorldTools(stubContext(stubProject({ projectDir: join(root, 'p-empty'), calls })))
    assert.match(bodyOf(await toolOf(empty, 'mc_world').run({ action: 'list' })), /还是空的/)
    assert.deepEqual(calls, [])
  })

  await test('MCP：import 成功给结论和下一步，被拒绝时 isError 且第一行是原因', async () => {
    const project = join(root, 'p-mcp-import')
    const calls: string[] = []
    const tools = createWorldTools(stubContext(stubProject({ projectDir: project, calls })))
    const source = await makeSave(join(root, 'ext-mcp', '外部世界'), { dataVersion: 3465, versionName: '1.20.1' })
    const imported = await toolOf(tools, 'mc_world').run({ action: 'import', source })
    assert.equal(imported.isError, undefined)
    const body = bodyOf(imported)
    assert.match(body.split('\n')[0], /已导入 外部世界/)
    assert.match(body, /会被升级/)
    assert.match(body, /原存档只读、未写入/)
    assert.match(body, /mc_run action=start world=外部世界/)
    const newer = await makeSave(join(root, 'ext-mcp-newer', '新的'), { dataVersion: 4325, versionName: '1.21.5' })
    const rejected = await toolOf(tools, 'mc_world').run({ action: 'import', source: newer })
    assert.equal(rejected.isError, true)
    assert.match(bodyOf(rejected).split('\n')[0], /已拒绝导入/)
    const missing = await toolOf(tools, 'mc_world').run({ action: 'import' })
    assert.equal(missing.isError, true)
    assert.match(bodyOf(missing), /需要 source/)
  })

  await test('MCP：运行中快照持有保存屏障，复制后释放，用户接管时拒绝', async () => {
    const project = join(root, 'p-mcp-snap')
    await makeSave(join(project, 'run', 'saves', 'inkstone-test'), { dataVersion: 3955, versionName: '1.21.1' })
    const calls: string[] = []
    const tools = createWorldTools(stubContext(stubProject({ projectDir: project, calls })))
    const created = await toolOf(tools, 'mc_world').run({ action: 'snapshot', world: 'inkstone-test', label: 'before-test' })
    assert.equal(created.isError, undefined)
    assert.match(bodyOf(created).split('\n')[0], /已创建快照 \d{8}-\d{6}-before-test/)
    assert.match(bodyOf(created), /同步保存并完成复制屏障/)
    assert.deepEqual(calls, ['/snapshot-begin', '/snapshot-end'])

    const takenCalls: string[] = []
    const taken = createWorldTools(stubContext(stubProject({ projectDir: project, owner: 'user', calls: takenCalls })))
    const refused = await toolOf(taken, 'mc_world').run({ action: 'snapshot', world: 'inkstone-test' })
    assert.equal(refused.isError, true)
    assert.equal(bodyOf(refused), USER_IN_CONTROL)
    assert.deepEqual(takenCalls, [])
  })

  await test('MCP：运行中恢复＝停→恢复→启动，restart=false 时只提示', async () => {
    const project = join(root, 'p-mcp-restore')
    const world = await makeSave(join(project, 'run', 'saves', 'inkstone-test'), { dataVersion: 3955, versionName: '1.21.1' }, { 'marker.txt': 'baseline' })
    const snapshot = await createSnapshot({ runDir: join(project, 'run'), projectDir: project, world: 'inkstone-test', label: 'gate' })
    await writeFile(join(world, 'marker.txt'), 'changed')
    const calls: string[] = []
    const tools = createWorldTools(stubContext(stubProject({ projectDir: project, calls })))
    const refused = await toolOf(tools, 'mc_world').run({ action: 'restore', world: 'inkstone-test', snapshot: snapshot.id, restart: false })
    assert.equal(refused.isError, true)
    assert.match(bodyOf(refused), /恢复需要先停游戏/)
    assert.deepEqual(calls, [])
    const restored = await toolOf(tools, 'mc_world').run({ action: 'restore', world: 'inkstone-test', snapshot: snapshot.id })
    assert.equal(restored.isError, undefined)
    const body = bodyOf(restored)
    assert.match(body.split('\n')[0], new RegExp(`已恢复存档 inkstone-test 到快照 ${snapshot.id}`))
    assert.match(body, /恢复前的状态已存成快照/)
    assert.match(body, /已重新启动游戏并进入 inkstone-test/)
    assert.deepEqual(calls, ['stop', 'launch'])
    assert.equal(await readFile(join(world, 'marker.txt'), 'utf8'), 'baseline')
  })

  await test('MCP：游戏停着时恢复不启动游戏，用户接管时拒绝恢复', async () => {
    const project = join(root, 'p-mcp-idle')
    const world = await makeSave(join(project, 'run', 'saves', 'w'), { dataVersion: 3955, versionName: '1.21.1' }, { 'marker.txt': 'baseline' })
    const snapshot = await createSnapshot({ runDir: join(project, 'run'), projectDir: project, world: 'w' })
    await writeFile(join(world, 'marker.txt'), 'changed')
    const calls: string[] = []
    const idle = createWorldTools(stubContext(stubProject({ projectDir: project, running: false, calls })))
    const restored = await toolOf(idle, 'mc_world').run({ action: 'restore', world: 'w', snapshot: snapshot.id })
    assert.equal(restored.isError, undefined)
    assert.match(bodyOf(restored), /游戏没在运行，下次 mc_run action=start/)
    assert.deepEqual(calls, [])
    await writeFile(join(world, 'marker.txt'), 'changed-again')
    const takenCalls: string[] = []
    const taken = createWorldTools(stubContext(stubProject({ projectDir: project, owner: 'user', calls: takenCalls })))
    const refused = await toolOf(taken, 'mc_world').run({ action: 'restore', world: 'w', snapshot: snapshot.id })
    assert.equal(refused.isError, true)
    assert.equal(bodyOf(refused), USER_IN_CONTROL)
    assert.equal(await readFile(join(world, 'marker.txt'), 'utf8'), 'changed-again')
    assert.deepEqual(takenCalls, [])
  })

  await test('MCP：snapshots 列表与 delete_snapshot 走通', async () => {
    const project = join(root, 'p-mcp-del')
    await makeSave(join(project, 'run', 'saves', 'w'), { dataVersion: 3955, versionName: '1.21.1' })
    const calls: string[] = []
    const tools = createWorldTools(stubContext(stubProject({ projectDir: project, calls, world: 'w' })))
    assert.match(bodyOf(await toolOf(tools, 'mc_world').run({ action: 'snapshots', world: 'w' })), /还没有快照/)
    const created = await toolOf(tools, 'mc_world').run({ action: 'snapshot', world: 'w', label: 'baseline' })
    const id = /已创建快照 (\S+)（/.exec(bodyOf(created))?.[1] ?? ''
    assert.ok(id, bodyOf(created))
    const listed = await toolOf(tools, 'mc_world').run({ action: 'snapshots' })
    assert.match(bodyOf(listed), /共 1 个快照/)
    assert.match(bodyOf(listed), new RegExp(id))
    const removed = await toolOf(tools, 'mc_world').run({ action: 'delete_snapshot', world: 'w', snapshot: id })
    assert.equal(removed.isError, undefined)
    assert.match(bodyOf(removed), /已删除快照/)
    assert.match(bodyOf(removed), /该存档已没有快照/)
    const missing = await toolOf(tools, 'mc_world').run({ action: 'delete_snapshot', world: 'w', snapshot: id })
    assert.equal(missing.isError, true)
    assert.match(bodyOf(missing), /没有快照/)
    const unknown = await toolOf(tools, 'mc_world').run({ action: 'wat' })
    assert.equal(unknown.isError, true)
    assert.match(bodyOf(unknown), /不支持的 action/)
    assert.deepEqual(calls, ['/snapshot-begin', '/snapshot-end'])
  })

  await test('工具描述写清参数', () => {
    const tools = createWorldTools(stubContext(stubProject({ projectDir: root, calls: [] })))
    const tool = toolOf(tools, 'mc_world')
    assert.equal(tool.name, 'mc_world')
    const properties = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties
    for (const key of ['action', 'world', 'source', 'name', 'label', 'snapshot', 'restart', 'backup']) {
      assert.ok(properties[key]?.description, `参数 ${key} 缺描述`)
    }
    assert.equal(formatBytes(2048), '2.0 KB')
  })

  console.log(`✓ ${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
