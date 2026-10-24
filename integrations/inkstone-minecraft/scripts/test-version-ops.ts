import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm, stat } from 'node:fs/promises'
import {
  copyInstance,
  formatResourcePackList,
  instanceIconOptions,
  InstanceIconStore,
  listResourcePacks,
  listSaves,
  listScreenshots,
  listShaderPacks,
  listTrashedInstances,
  normalizeServerAddress,
  parseNbt,
  parseResourcePackList,
  readIconOption,
  readServers,
  renameInstance,
  restoreTrashedInstance,
  serverArgs,
  toggleResourcePack,
  trashInstance,
  trashResource,
  uniqueInstanceName,
  validInstanceName,
  validResourceName
} from '../src/core/version-ops.ts'
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

function png(width = 1, height = 1): Buffer {
  const head = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return Buffer.concat([head, Buffer.from('rest')])
}

function nbtName(value: string): Buffer {
  const text = Buffer.from(value, 'utf8')
  const head = Buffer.alloc(2)
  head.writeUInt16BE(text.length)
  return Buffer.concat([head, text])
}

function nbtCompound(entries: Array<[number, string, Buffer]>): Buffer {
  const parts: Buffer[] = []
  for (const [type, name, payload] of entries) parts.push(Buffer.from([type]), nbtName(name), payload)
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function nbtRoot(compound: Buffer): Buffer {
  return Buffer.concat([Buffer.from([10]), nbtName(''), compound])
}

function nbtString(value: string): Buffer {
  return nbtName(value)
}

function nbtLong(value: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64BE(BigInt(value))
  return buffer
}

function nbtList(itemType: number, items: Buffer[]): Buffer {
  const head = Buffer.alloc(5)
  head[0] = itemType
  head.writeInt32BE(items.length, 1)
  return Buffer.concat([head, ...items])
}

const root = mkdtempSync(join(tmpdir(), 'inkstone-mc-l4-'))
const game = join(root, 'game')
const data = join(root, 'data')

function writeVersion(id: string, options: { jar?: boolean; pcl?: boolean; json?: string | null } = {}): void {
  const dir = join(game, 'versions', id)
  mkdirSync(dir, { recursive: true })
  if (options.json !== null) writeFileSync(join(dir, `${id}.json`), options.json ?? JSON.stringify({ id, inheritsFrom: '1.20.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient' }), 'utf8')
  if (options.jar !== false) writeFileSync(join(dir, `${id}.jar`), Buffer.from('jar'))
  if (options.pcl !== false) {
    mkdirSync(join(dir, 'PCL'), { recursive: true })
    writeFileSync(join(dir, 'PCL', 'Setup.ini'), 'VersionOriginal:1.20.1\n', 'utf8')
  }
}

try {
  mkdirSync(join(game, 'versions'), { recursive: true })
  writeVersion('demo')

  await test('版本名与文件名：挡住路径分隔符与控制字符', () => {
    assert.equal(validInstanceName('demo-L4'), true)
    assert.equal(validInstanceName('a/b'), false)
    assert.equal(validInstanceName('..'), false)
    assert.equal(validInstanceName('  '), false)
    assert.equal(validResourceName('pack.zip'), true)
    assert.equal(validResourceName('../pack.zip'), false)
    assert.equal(validResourceName('.hidden.zip'), false)
    assert.equal(uniqueInstanceName('demo', ['demo']), 'demo 2')
    assert.equal(uniqueInstanceName('demo', ['demo', 'demo 2']), 'demo 3')
    assert.equal(uniqueInstanceName('demo', []), 'demo')
  })

  await test('重命名：文件夹、json、jar 与 PCL 子目录一起改，json 里的 id 跟着改', async () => {
    const result = await renameInstance(game, 'demo', 'demo-L4')
    assert.equal(result.id, 'demo-L4')
    assert.equal(result.jarRenamed, true)
    const dir = join(game, 'versions', 'demo-L4')
    assert.ok(readdirSync(dir).includes('demo-L4.json'))
    assert.ok(readdirSync(dir).includes('demo-L4.jar'))
    assert.ok(readdirSync(join(dir, 'PCL')).includes('Setup.ini'))
    const json = JSON.parse(readFileSync(join(dir, 'demo-L4.json'), 'utf8')) as { id: string; inheritsFrom: string }
    assert.equal(json.id, 'demo-L4')
    assert.equal(json.inheritsFrom, '1.20.1')
    assert.equal(readdirSync(join(game, 'versions')).includes('demo'), false)
  })

  await test('重命名：同名、重名与非法字符都拒绝，目录保持原样', async () => {
    await assert.rejects(() => renameInstance(game, 'demo-L4', 'demo-L4'), /一样/)
    writeVersion('另一位')
    await assert.rejects(() => renameInstance(game, 'demo-L4', '另一位'), /已经有叫/)
    await assert.rejects(() => renameInstance(game, 'demo-L4', 'a:b'), /不能为空/)
    assert.ok(readdirSync(join(game, 'versions')).includes('demo-L4'))
  })

  await test('复制为新版本：json 名与 id 换成新名字，重名时自动加序号', async () => {
    const first = await copyInstance(game, 'demo-L4')
    assert.equal(first.id, 'demo-L4-副本')
    assert.ok(first.size > 0)
    const dir = join(game, 'versions', 'demo-L4-副本')
    assert.ok(readdirSync(dir).includes('demo-L4-副本.json'))
    assert.ok(readdirSync(dir).includes('demo-L4-副本.jar'))
    const json = JSON.parse(readFileSync(join(dir, 'demo-L4-副本.json'), 'utf8')) as { id: string }
    assert.equal(json.id, 'demo-L4-副本')
    const second = await copyInstance(game, 'demo-L4')
    assert.equal(second.id, 'demo-L4-副本 2')
    const named = await copyInstance(game, 'demo-L4', '自己做主')
    assert.equal(named.id, '自己做主')
  })

  await test('复制缺 json 的版本时说明原因', async () => {
    writeVersion('坏的', { json: null })
    await assert.rejects(() => copyInstance(game, '坏的'), /缺少 坏的.json/)
  })

  let trashId = ''
  await test('删除到回收站：版本离开 versions，可以在回收站里看到并恢复', async () => {
    const record = await trashInstance(game, '自己做主')
    trashId = record.id
    assert.equal(record.versionId, '自己做主')
    assert.equal(readdirSync(join(game, 'versions')).includes('自己做主'), false)
    const list = await listTrashedInstances(game)
    assert.deepEqual(list.map((item) => item.versionId), ['自己做主'])
    const restored = await restoreTrashedInstance(game, trashId)
    assert.equal(restored, '自己做主')
    assert.ok(readdirSync(join(game, 'versions')).includes('自己做主'))
    assert.deepEqual(await listTrashedInstances(game), [])
  })

  await test('回收站记录不合法时拒绝恢复', async () => {
    await assert.rejects(() => restoreTrashedInstance(game, '../escape'), /不合法/)
  })

  const modsDir = join(game, 'mods')
  mkdirSync(modsDir, { recursive: true })
  writeFileSync(
    join(modsDir, 'demo-mod.jar'),
    storedZip({
      'fabric.mod.json': JSON.stringify({ id: 'demo', name: '演示 Mod', version: '1.0.0', icon: 'assets/icon.png' }),
      'assets/icon.png': png(64, 64)
    })
  )

  const packsDir = join(game, 'resourcepacks')
  mkdirSync(packsDir, { recursive: true })
  writeFileSync(
    join(packsDir, 'folder-pack.zip'),
    storedZip({ 'pack.mcmeta': JSON.stringify({ pack: { pack_format: 34, description: '文件夹包' } }), 'pack.png': png(32, 32) })
  )
  mkdirSync(join(packsDir, 'dir-pack'), { recursive: true })
  writeFileSync(join(packsDir, 'dir-pack', 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 15 } }), 'utf8')
  writeFileSync(join(packsDir, 'dir-pack', 'pack.png'), png(16, 16))
  writeFileSync(join(game, 'options.txt'), 'version:3465\nfov:0.0\nresourcePacks:["vanilla"]\nlanguage:zh_cn\n', 'utf8')

  await test('资源包：读 zip 与文件夹的 pack.mcmeta，启停只改 resourcePacks 那一行', async () => {
    const packs = await listResourcePacks(game)
    assert.deepEqual(packs.map((pack) => pack.file), ['dir-pack', 'folder-pack.zip'])
    assert.equal(packs.find((pack) => pack.file === 'folder-pack.zip')?.format, 34)
    assert.equal(packs.find((pack) => pack.file === 'folder-pack.zip')?.description, '文件夹包')
    assert.ok(packs.find((pack) => pack.file === 'folder-pack.zip')?.icon?.startsWith('data:image/png;base64,'))
    const enabled = await toggleResourcePack(game, 'folder-pack.zip', true)
    assert.equal(enabled.find((pack) => pack.file === 'folder-pack.zip')?.enabled, true)
    const options = readFileSync(join(game, 'options.txt'), 'utf8')
    assert.match(options, /resourcePacks:\["vanilla","file\/folder-pack.zip"\]/)
    assert.match(options, /language:zh_cn/)
    const disabled = await toggleResourcePack(game, 'folder-pack.zip', false)
    assert.equal(disabled.find((pack) => pack.file === 'folder-pack.zip')?.enabled, false)
    assert.match(readFileSync(join(game, 'options.txt'), 'utf8'), /resourcePacks:\["vanilla"\]/)
  })

  await test('资源包：没有 options.txt 时新建一行 resourcePacks', async () => {
    const fresh = join(root, 'fresh-game')
    mkdirSync(join(fresh, 'resourcepacks'), { recursive: true })
    writeFileSync(join(fresh, 'resourcepacks', 'x.zip'), storedZip({ 'pack.mcmeta': JSON.stringify({ pack: { pack_format: 22 } }) }))
    await toggleResourcePack(fresh, 'x.zip', true)
    assert.equal(readFileSync(join(fresh, 'options.txt'), 'utf8').trim(), 'resourcePacks:["vanilla","file/x.zip"]')
    assert.deepEqual(parseResourcePackList('["vanilla","file/x.zip"]'), ['vanilla', 'file/x.zip'])
    assert.equal(formatResourcePackList(['vanilla']), 'resourcePacks:["vanilla"]')
    assert.deepEqual(parseResourcePackList('坏数据'), ['vanilla'])
  })

  await test('资源包：删除移到 .trash 并同步从启用列表去掉', async () => {
    await toggleResourcePack(game, 'dir-pack', true)
    await trashResource(game, 'resourcepacks', 'dir-pack')
    assert.equal(readdirSync(packsDir).includes('dir-pack'), false)
    assert.equal(readFileSync(join(game, 'options.txt'), 'utf8').includes('dir-pack'), false)
    const trashed = readdirSync(join(game, '.trash', 'resourcepacks'))
    assert.equal(trashed.length, 1)
    assert.match(trashed[0]!, /^[0-9]+-dir-pack$/)
  })

  const shadersDir = join(game, 'shaderpacks')
  mkdirSync(shadersDir, { recursive: true })
  writeFileSync(join(shadersDir, 'demo-shader.zip'), Buffer.from('zip'))
  mkdirSync(join(shadersDir, 'shader-dir'))

  await test('光影：列表包含 zip 与文件夹', async () => {
    const packs = await listShaderPacks(game)
    assert.deepEqual(packs.map((pack) => pack.name), ['demo-shader', 'shader-dir'])
    await trashResource(game, 'shaderpacks', 'demo-shader.zip')
    assert.equal(readdirSync(shadersDir).includes('demo-shader.zip'), false)
  })

  const worldDir = join(game, 'saves', '世界一')
  mkdirSync(worldDir, { recursive: true })
  const level = nbtRoot(
    nbtCompound([
      [
        10,
        'Data',
        nbtCompound([
          [8, 'LevelName', nbtString('世界一')],
          [4, 'LastPlayed', nbtLong(1735689600000)],
          [10, 'Version', nbtCompound([[8, 'Name', nbtString('1.21.1')]])]
        ])
      ]
    ])
  )
  writeFileSync(join(worldDir, 'level.dat'), gzipSync(level))
  writeFileSync(join(worldDir, 'icon.png'), png(64, 64))
  mkdirSync(join(game, 'saves', '空存档'), { recursive: true })

  await test('存档：从 level.dat 读名称、游戏版本与最后游玩，带 icon.png', async () => {
    const saves = await listSaves(game)
    assert.equal(saves[0]?.folder, '世界一')
    assert.equal(saves[0]?.name, '世界一')
    assert.equal(saves[0]?.gameVersion, '1.21.1')
    assert.equal(saves[0]?.lastPlayed, 1735689600000)
    assert.ok(saves[0]?.icon?.startsWith('data:image/png;base64,'))
    assert.equal(saves[1]?.name, '空存档')
    assert.equal(saves[1]?.icon, null)
    await trashResource(game, 'saves', '空存档')
    assert.equal(readdirSync(join(game, 'saves')).includes('空存档'), false)
  })

  const shotsDir = join(game, 'screenshots')
  mkdirSync(shotsDir, { recursive: true })
  writeFileSync(join(shotsDir, '2026-01-01_10.00.00.png'), png(1920, 1080))
  writeFileSync(join(shotsDir, '2026-01-02_10.00.00.png'), png(2560, 1440))
  utimesSync(join(shotsDir, '2026-01-01_10.00.00.png'), new Date('2026-01-01T10:00:00Z'), new Date('2026-01-01T10:00:00Z'))
  utimesSync(join(shotsDir, '2026-01-02_10.00.00.png'), new Date('2026-01-02T10:00:00Z'), new Date('2026-01-02T10:00:00Z'))
  writeFileSync(join(shotsDir, 'note.txt'), '不是截图', 'utf8')

  await test('截图：新到旧排序，读 PNG 头里的宽高，跳过非 png', async () => {
    const shots = await listScreenshots(game)
    assert.equal(shots.length, 2)
    assert.equal(shots[0]?.file.endsWith('2026-01-02_10.00.00.png'), true)
    assert.equal(shots[0]?.width, 2560)
    assert.equal(shots[0]?.height, 1440)
    assert.ok(shots[0]?.dataUrl.startsWith('data:image/png;base64,'))
  })

  const servers = nbtRoot(
    nbtCompound([
      [
        9,
        'servers',
        nbtList(10, [
          nbtCompound([
            [8, 'name', nbtString('测试服')],
            [8, 'ip', nbtString('play.example.com:25565')],
            [8, 'icon', nbtString(`data:image/png;base64,${png(64, 64).toString('base64')}`)]
          ]),
          nbtCompound([
            [8, 'name', nbtString('无图标服')],
            [8, 'ip', nbtString('mc.example.net')]
          ])
        ])
      ]
    ])
  )
  writeFileSync(join(game, 'servers.dat'), servers)

  await test('servers.dat：解析服务器名称、地址与图标，未压缩与 gzip 都能读', async () => {
    const list = await readServers(game)
    assert.deepEqual(list.map((item) => item.ip), ['play.example.com:25565', 'mc.example.net'])
    assert.equal(list[0]?.name, '测试服')
    assert.ok(list[0]?.icon?.startsWith('data:image/png;base64,'))
    assert.equal(list[1]?.icon, null)
    writeFileSync(join(root, 'gzip-servers.dat'), gzipSync(servers))
    const rootData = parseNbt(gzipSync(servers))
    assert.ok(Array.isArray(rootData.servers))
  })

  await test('实例图标：Mod jar、存档、服务器三种来源都能读，自定义图标写入后能读回、能清除', async () => {
    const options = await instanceIconOptions(game)
    const kinds = new Set(options.map((option) => option.kind))
    assert.equal(kinds.has('mod'), true)
    assert.equal(kinds.has('save'), true)
    assert.equal(kinds.has('server'), true)
    const fromMod = await readIconOption(game, 'mod', 'demo-mod.jar')
    assert.ok(fromMod && fromMod.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    assert.equal(await readIconOption(game, 'mod', '../escape.jar'), null)
    assert.equal(await readIconOption(game, 'save', '世界一') !== null, true)
    const fromServer = await readIconOption(game, 'server', 'play.example.com:25565')
    assert.ok(fromServer)

    const store = new InstanceIconStore(data)
    assert.equal(await store.customPath(game, 'demo-L4'), null)
    const written = await store.set(game, 'demo-L4', png(64, 64))
    assert.ok(written.endsWith('.png'))
    assert.equal((await stat(written)).isFile(), true)
    assert.equal(await store.customPath(game, 'demo-L4'), written)
    await store.clear(game, 'demo-L4')
    assert.equal(await store.customPath(game, 'demo-L4'), null)
    await assert.rejects(() => store.set(game, 'demo-L4', Buffer.from('not png')), /PNG/)
  })

  await test('自动进服参数：1.21.1 用 quickPlay，1.12.2 与未知版本用 --server', () => {
    assert.deepEqual(serverArgs('1.21.1', 'play.example.com'), ['--quickPlayMultiplayer', 'play.example.com'])
    assert.deepEqual(serverArgs('1.20', 'play.example.com:25566'), ['--quickPlayMultiplayer', 'play.example.com:25566'])
    assert.deepEqual(serverArgs('1.12.2', 'play.example.com:25566'), ['--server', 'play.example.com', '--port', '25566'])
    assert.deepEqual(serverArgs('1.12.2', 'play.example.com'), ['--server', 'play.example.com'])
    assert.deepEqual(serverArgs(null, 'play.example.com'), ['--server', 'play.example.com'])
    assert.deepEqual(serverArgs('1.21.1', ''), [])
    assert.deepEqual(serverArgs('1.21.1', null), [])
    assert.deepEqual(serverArgs('26.3', 'play.example.com'), ['--quickPlayMultiplayer', 'play.example.com'])
    assert.deepEqual(serverArgs('1.21.1', '[::1]:25565'), ['--quickPlayMultiplayer', '[::1]:25565'])
  })

  await test('服务器地址规范化：去协议与结尾斜杠，空白地址视为没填', () => {
    assert.equal(normalizeServerAddress('minecraft://play.example.com/'), 'play.example.com')
    assert.equal(normalizeServerAddress('  mc.example.net:25565  '), 'mc.example.net:25565')
    assert.equal(normalizeServerAddress('a b'), null)
    assert.equal(normalizeServerAddress(''), null)
  })

  await test('PNG 尺寸头读不出来时宽度留空，坏图不影响列表', async () => {
    writeFileSync(join(shotsDir, '2026-01-03_10.00.00.png'), PNG_STUB)
    const shots = await listScreenshots(game)
    const stub = shots.find((shot) => shot.file.startsWith('2026-01-03'))
    assert.ok(stub)
    assert.equal(stub?.width, null)
  })

  await test('删除版本时缺文件夹给出说明', async () => {
    await assert.rejects(() => trashInstance(game, '不存在'), /找不到/)
    await rm(join(game, 'versions', '坏的'), { recursive: true, force: true })
    await assert.rejects(() => trashInstance(game, '坏的'), /找不到/)
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`inkstone-minecraft version-ops: ${passed} 项通过`)
