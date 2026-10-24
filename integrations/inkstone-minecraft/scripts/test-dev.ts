import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'
import { COMPANION_VARIANTS, CompanionError, companionControl, companionSupports, companionVariant, findCompanionJar, installCompanion, parseCompanionControl } from '../src/core/dev/companion.ts'
import { createFabricProject, exampleSupported, modClassName, renderTemplate, templatePath, validateModId, validatePackageName } from '../src/core/dev/create-project.ts'
import {
  compareVersions,
  javaReleaseFor,
  loomPluginId,
  parseMavenVersions,
  pickFabricApi,
  pickLatestStable,
  pickLoader,
  pickYarn,
  resolveFabricVersions,
  type FetchText
} from '../src/core/dev/fabric-meta.ts'
import { cleanGradleOutput, parseGradleErrors, wrapperCommand, wrapperProperties } from '../src/core/dev/gradle.ts'
import { hotswapClasses } from '../src/core/dev/hotswap.ts'
import { isJbrRelease } from '../src/core/dev/jbr.ts'
import { classSignature, encodeCommand, JdwpClient, PacketReader, PacketWriter } from '../src/core/dev/jdwp.ts'
import { filterLog, groupLogEntries, summarizeCrash } from '../src/core/dev/logs.ts'
import { classifyResources, diffManifest, isMixinClass, langRegistrationCandidates, mixinPackagesFrom, registrationCandidates, scanManifest } from '../src/core/dev/manifest.ts'
import { buildTable, formatMapping, lookupMapping, parseProguard, parseTiny, proguardTypeToDescriptor } from '../src/core/dev/mappings.ts'
import { createImage, decodePng, encodePng, pixel, scaleDown, setPixel } from '../src/core/dev/png.ts'
import { argFileText, splitLaunchArgs, findMixinAgent, mergeOptions, parseOptions, prepareRunDir, stripJvmArgs, withWindowSize, agentWindowJvmArgs, agentWindowTitle } from '../src/core/dev/session.ts'
import { extractSources, pickMinecraftSourceJars, readSource, searchSources, sourceJarKind } from '../src/core/dev/sources.ts'
import { loadTexture, texturePathFromId, textureWriteDir } from '../src/core/dev/texture-lookup.ts'
import { analyzePalette, imageFromGrid, parseHexColor, renderTextureView } from '../src/core/dev/texture.ts'
import { ZipReader } from '../src/core/dev/zip.ts'
import { handleMessage, text, type ToolResult } from '../mcp/protocol.ts'
import { createTools, createToolsWithExtras, formatApply, loadExtraTools, USER_IN_CONTROL } from '../mcp/tools.ts'
import { DevProject, environmentCommands } from '../src/core/dev/runner.ts'
import type { DevSessionInfo } from '../src/shared/dev-api.ts'

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

const root = mkdtempSync(join(tmpdir(), 'inkstone-dev-test-'))

function rawPng(width: number, height: number, bitDepth: number, colorType: number, rows: Buffer[], extra: Array<[string, Buffer]> = []): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = bitDepth
  header[9] = colorType
  const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...extra.map(([type, data]) => chunk(type, data)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const compressed = deflateRawSync(data)
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + compressed.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const fakeMeta: FetchText = async (url) => {
  if (url.includes('/versions/loader/')) return JSON.stringify([{ loader: { version: '0.21.0-beta', stable: false } }, { loader: { version: '0.20.1', stable: true } }])
  if (url.includes('/versions/yarn/')) return JSON.stringify([{ version: '1.21.1+build.2', build: 2 }, { version: '1.21.1+build.3', build: 3 }])
  if (url.includes('fabric-api/maven-metadata.xml')) return '<versions><version>0.116.9+1.21.1</version><version>0.116.17+1.21.1</version><version>0.116.10+1.21.1</version><version>0.130.0+1.21.7</version></versions>'
  if (url.includes('fabric-loom-remap.gradle.plugin')) return '<versions><version>1.19.0-alpha.7</version><version>1.19.3</version><version>1.19-SNAPSHOT</version><version>1.19.10</version></versions>'
  if (url.includes('services.gradle.org/versions/current')) return JSON.stringify({ version: '9.8.2' })
  throw new Error(`unexpected ${url}`)
}

try {
  await test('版本比较与 Maven 元数据挑选', () => {
    assert.ok(compareVersions('1.19.10', '1.19.3') > 0)
    assert.ok(compareVersions('0.116.17', '0.116.9') > 0)
    assert.deepEqual(parseMavenVersions('<version>1</version><version> 2 </version>'), ['1', '2'])
    assert.equal(pickLatestStable(['1.19.0-alpha.7', '1.19.3', '1.19-SNAPSHOT', '1.19.10']), '1.19.10')
    assert.equal(pickFabricApi(['0.116.9+1.21.1', '0.116.17+1.21.1', '0.130.0+1.21.7'], '1.21.1'), '0.116.17+1.21.1')
    assert.equal(pickFabricApi(['0.1+1.21.10'], '1.21.1'), null)
    assert.equal(pickLoader([{ loader: { version: 'x', stable: false } }, { loader: { version: 'y', stable: true } }]), 'y')
    assert.equal(pickYarn([{ version: 'a', build: 1 }, { version: 'b', build: 7 }]), 'b')
  })

  await test('MC 版本对应的 Java 与 Loom 插件', () => {
    assert.equal(javaReleaseFor('1.21.1'), 21)
    assert.equal(javaReleaseFor('1.20.5'), 21)
    assert.equal(javaReleaseFor('1.20.4'), 17)
    assert.equal(javaReleaseFor('26.1'), 25)
    assert.equal(loomPluginId('1.21.1'), 'net.fabricmc.fabric-loom-remap')
    assert.equal(loomPluginId('26.1.2'), 'net.fabricmc.fabric-loom')
  })

  await test('resolveFabricVersions 汇总官方元数据', async () => {
    const seen: string[] = []
    const versions = await resolveFabricVersions('1.21.1', { fetchText: (url) => (seen.push(url), fakeMeta(url)) })
    assert.deepEqual(versions, { minecraft: '1.21.1', loader: '0.20.1', yarn: '1.21.1+build.3', fabricApi: '0.116.17+1.21.1', loom: '1.19.10', loomPlugin: 'net.fabricmc.fabric-loom-remap', gradle: '9.8.2', javaRelease: 21 })
    assert.ok(seen.some((url) => url === 'https://maven.fabricmc.net/net/fabricmc/fabric-loom-remap/net.fabricmc.fabric-loom-remap.gradle.plugin/maven-metadata.xml'))
    const mojmap = await resolveFabricVersions('1.21.1', { mappings: 'mojmap', fetchText: fakeMeta })
    assert.equal(mojmap.yarn, null)
    await assert.rejects(resolveFabricVersions('1.21.1', { fetchText: async (url) => (url.includes('fabric-api') ? '<versions></versions>' : fakeMeta(url)) }), /Fabric API/)
  })

  await test('mod id、包名与类名校验', () => {
    assert.equal(validateModId('inkdemo'), null)
    assert.match(validateModId('Ink') ?? '', /小写/)
    assert.match(validateModId('fabricthing') ?? '', /fabric/)
    assert.equal(validatePackageName('dev.inkstone.demo'), null)
    assert.match(validatePackageName('dev.class.demo') ?? '', /关键字/)
    assert.match(validatePackageName('demo') ?? '', /两段/)
    assert.equal(modClassName('my_cool-mod'), 'MyCoolMod')
    assert.equal(exampleSupported('1.21.1'), true)
    assert.equal(exampleSupported('1.21.7'), false)
    assert.throws(() => renderTemplate('{{missing}}', {}), /missing/)
    assert.equal(templatePath('src/main/java/__package_path__/__ModClass__.java', { packageName: 'a.b', modClass: 'X', modId: 'x' }), 'src/main/java/a/b/X.java')
    assert.equal(templatePath('gitignore', { packageName: 'a.b', modClass: 'X', modId: 'x' }), '.gitignore')
  })

  await test('createFabricProject 生成 yarn 项目（含示例物品）', async () => {
    const dir = join(root, 'yarn-project')
    const result = await createFabricProject({ minecraftVersion: '1.21.1', modId: 'ruby_mod', packageName: 'com.example.ruby', targetDir: dir, modName: 'Ruby "Mod"' }, { fetchText: fakeMeta, skipWrapper: true, javaPaths: [] })
    assert.equal(result.example, true)
    assert.ok(result.files.includes('src/main/java/com/example/ruby/RubyMod.java'))
    assert.ok(result.files.includes('src/main/resources/assets/ruby_mod/textures/item/example_item.png'))
    const build = await readFile(join(dir, 'build.gradle'), 'utf8')
    assert.match(build, /id 'net\.fabricmc\.fabric-loom-remap' version "\$\{loom_version\}"/)
    assert.match(build, /mappings "net\.fabricmc:yarn:\$\{project\.yarn_mappings\}:v2"/)
    assert.match(build, /options\.release = 21/)
    const props = await readFile(join(dir, 'gradle.properties'), 'utf8')
    assert.match(props, /yarn_mappings=1\.21\.1\+build\.3/)
    assert.match(props, /loom_version=1\.19\.10/)
    const mod = JSON.parse((await readFile(join(dir, 'src/main/resources/fabric.mod.json'), 'utf8')).replace('${version}', '0.1.0')) as Record<string, unknown>
    assert.equal(mod.name, 'Ruby "Mod"')
    assert.deepEqual((mod.entrypoints as Record<string, string[]>).client, ['com.example.ruby.RubyModClient'])
    const lang = JSON.parse(await readFile(join(dir, 'src/main/resources/assets/ruby_mod/lang/zh_cn.json'), 'utf8')) as Record<string, string>
    assert.equal(lang['item.ruby_mod.example_item'], '示例物品')
    const main = await readFile(join(dir, 'src/main/java/com/example/ruby/RubyMod.java'), 'utf8')
    assert.match(main, /ModItems\.register\(\);/)
    assert.match(await readFile(join(dir, 'src/main/java/com/example/ruby/ModItems.java'), 'utf8'), /Identifier\.of/)
    const texture = decodePng(await readFile(join(dir, 'src/main/resources/assets/ruby_mod/textures/item/example_item.png')))
    assert.equal(texture.width, 16)
    await assert.rejects(createFabricProject({ minecraftVersion: '1.21.1', modId: 'ruby_mod', packageName: 'com.example.ruby', targetDir: dir }, { fetchText: fakeMeta, skipWrapper: true }), /不是空目录/)
  })

  await test('createFabricProject 生成 mojmap 与无示例版本', async () => {
    const moj = join(root, 'moj-project')
    await createFabricProject({ minecraftVersion: '1.21.1', modId: 'mojdemo', packageName: 'com.example.moj', targetDir: moj, mappings: 'mojmap' }, { fetchText: fakeMeta, skipWrapper: true })
    assert.match(await readFile(join(moj, 'build.gradle'), 'utf8'), /loom\.officialMojangMappings\(\)/)
    assert.doesNotMatch(await readFile(join(moj, 'gradle.properties'), 'utf8'), /yarn_mappings/)
    assert.match(await readFile(join(moj, 'src/main/java/com/example/moj/ModItems.java'), 'utf8'), /ResourceLocation\.fromNamespaceAndPath/)
    const plain = join(root, 'plain-project')
    const fetch177: FetchText = async (url) => (url.includes('fabric-api') ? '<versions><version>0.130.0+1.21.7</version></versions>' : fakeMeta(url))
    const result = await createFabricProject({ minecraftVersion: '1.21.7', modId: 'plain', packageName: 'com.example.plain', targetDir: plain }, { fetchText: fetch177, skipWrapper: true })
    assert.equal(result.example, false)
    assert.ok(!existsSync(join(plain, 'src/main/java/com/example/plain/ModItems.java')))
    JSON.parse(await readFile(join(plain, 'src/main/resources/assets/plain/lang/en_us.json'), 'utf8'))
  })

  await test('PNG 编解码：RGBA、调色板 + tRNS、灰度、2 位深度', () => {
    const image = createImage(3, 2)
    setPixel(image, 0, 0, [255, 0, 0, 255])
    setPixel(image, 2, 1, [1, 2, 3, 128])
    const back = decodePng(encodePng(image))
    assert.deepEqual(pixel(back, 0, 0), [255, 0, 0, 255])
    assert.deepEqual(pixel(back, 2, 1), [1, 2, 3, 128])
    const palette = rawPng(2, 1, 8, 3, [Buffer.from([0, 1])], [['PLTE', Buffer.from([10, 20, 30, 40, 50, 60])], ['tRNS', Buffer.from([0])]])
    const decoded = decodePng(palette)
    assert.deepEqual(pixel(decoded, 0, 0), [10, 20, 30, 0])
    assert.deepEqual(pixel(decoded, 1, 0), [40, 50, 60, 255])
    const gray = decodePng(rawPng(4, 1, 2, 0, [Buffer.from([0b00011011])]))
    assert.deepEqual([0, 1, 2, 3].map((x) => pixel(gray, x, 0)[0]), [0, 85, 170, 255])
    assert.throws(() => decodePng(Buffer.from('nope')), /PNG/)
    const big = createImage(8, 4, [100, 100, 100, 255])
    const small = scaleDown(big, 4)
    assert.equal(small.width, 4)
    assert.equal(small.height, 2)
  })

  await test('贴图视图：放大、调色板、像素字符图与绘制', () => {
    const image = imageFromGrid(['.AB.', 'AABB'], { A: '#ff0000', B: '#00ff0080' })
    assert.deepEqual(pixel(image, 2, 0), [0, 255, 0, 128])
    const { palette, transparent } = analyzePalette(image)
    assert.equal(transparent, 2)
    assert.equal(palette[0].count, 3)
    assert.equal(palette[0].hex, '#00ff0080')
    const view = renderTextureView(image)
    assert.equal(view.cell, 32)
    assert.deepEqual(view.grid, ['.BA.', 'BBAA'])
    assert.match(view.text, /#00ff0080 ×3/)
    assert.ok(decodePng(view.png).width > 4 * 32)
    assert.throws(() => imageFromGrid(['AB', 'A'], { A: '#000000', B: '#ffffff' }), /长度/)
    assert.throws(() => imageFromGrid(['AC'], { A: '#000000' }), /调色板/)
    assert.throws(() => parseHexColor('red'), /颜色/)
  })

  await test('文件清单差异与资源分类', async () => {
    const dir = join(root, 'classes')
    await mkdir(join(dir, 'a'), { recursive: true })
    await writeFile(join(dir, 'a', 'X.class'), 'one')
    await writeFile(join(dir, 'a', 'Y.class'), 'two')
    const before = await scanManifest([dir])
    await writeFile(join(dir, 'a', 'X.class'), 'changed')
    await writeFile(join(dir, 'a', 'Z.class'), 'new')
    const after = await scanManifest([dir], (path) => path !== 'a/Y.class')
    assert.deepEqual(diffManifest(before, after), { changed: ['a/X.class'], added: ['a/Z.class'], removed: ['a/Y.class'] })
    assert.deepEqual(classifyResources(['assets/m/textures/a.png', 'data/m/recipe/r.json', 'fabric.mod.json', 'm.mixins.json', 'm.accesswidener', 'pack.mcmeta']), {
      assets: ['assets/m/textures/a.png'],
      data: ['data/m/recipe/r.json'],
      metadata: ['fabric.mod.json', 'm.mixins.json', 'm.accesswidener'],
      other: ['pack.mcmeta']
    })
    assert.deepEqual(registrationCandidates(['assets/thepit/items/coin_pouch.json', 'assets/thepit/models/item/coin_pouch.json', 'assets/thepit/blockstates/vault.json', 'assets/minecraft/items/stick.json', 'assets/thepit/lang/en_us.json']), [
      { registry: 'item', id: 'thepit:coin_pouch' },
      { registry: 'block', id: 'thepit:vault' }
    ])
    assert.deepEqual(langRegistrationCandidates(['item.thepit.old', 'block.thepit.old'], ['item.thepit.old', 'block.thepit.old', 'block.thepit.coin_jar', 'item.thepit.coin_jar.tooltip', 'item.minecraft.stick', 'gui.thepit.title']), [
      { registry: 'block', id: 'thepit:coin_jar' }
    ])
    const packages = mixinPackagesFrom([{ package: 'com.example.mixin' }, {}])
    assert.equal(isMixinClass('com/example/mixin/client/FooMixin', packages), true)
    assert.equal(isMixinClass('com/example/Foo', packages), false)
  })

  await test('JDWP 数据包编解码', () => {
    const packet = encodeCommand(7, 1, 2, new PacketWriter().string('La;').build())
    assert.equal(packet.readUInt32BE(0), 11 + 7)
    assert.equal(packet[9], 1)
    assert.equal(packet[10], 2)
    const reader = new PacketReader(new PacketWriter().int(-5).byte(3).id(0x1234567890n, 8).string('中').build())
    assert.equal(reader.int(), -5)
    assert.equal(reader.byte(), 3)
    assert.equal(reader.id(8), 0x1234567890n)
    assert.equal(reader.string(), '中')
    assert.equal(classSignature('dev.ink.Foo$Bar'), 'Ldev/ink/Foo$Bar;')
  })

  await test('热替换：假 JDWP 服务器上替换、跳过未加载、结构改动与 Mixin', async () => {
    const loaded: Record<string, bigint> = { 'Ldev/demo/Hud;': 11n, 'Ldev/demo/Schema;': 22n, 'Ldev/demo/mixin/HudMixin;': 33n }
    const redefined: bigint[][] = []
    const server = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0)
      let handshaken = false
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        if (!handshaken) {
          if (buffer.length < 14) return
          buffer = buffer.subarray(14)
          handshaken = true
          socket.write('JDWP-Handshake')
        }
        while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE(0)) {
          const length = buffer.readUInt32BE(0)
          const id = buffer.readUInt32BE(4)
          const set = buffer[9]
          const command = buffer[10]
          const body = buffer.subarray(11, length)
          buffer = buffer.subarray(length)
          let error = 0
          let data: Buffer = Buffer.alloc(0)
          if (set === 1 && command === 7) data = new PacketWriter().int(8).int(8).int(8).int(8).int(8).build()
          else if (set === 1 && command === 2) {
            const signature = new PacketReader(body).string()
            const writer = new PacketWriter().int(loaded[signature] ? 1 : 0)
            if (loaded[signature]) writer.byte(1).id(loaded[signature], 8).int(7)
            data = writer.build()
          } else if (set === 1 && command === 18) {
            const reader = new PacketReader(body)
            const count = reader.int()
            const ids: bigint[] = []
            for (let index = 0; index < count; index++) {
              ids.push(reader.id(8))
              const size = reader.int()
              for (let skip = 0; skip < size; skip++) reader.byte()
            }
            if (ids.includes(22n)) error = 63
            else redefined.push(ids)
          }
          const reply = Buffer.alloc(11)
          reply.writeUInt32BE(11 + data.length, 0)
          reply.writeUInt32BE(id, 4)
          reply[8] = 0x80
          reply.writeUInt16BE(error, 9)
          socket.write(Buffer.concat([reply, data]))
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const classes = join(root, 'swap')
    await mkdir(join(classes, 'dev', 'demo', 'mixin'), { recursive: true })
    for (const name of ['Hud', 'Schema', 'Lazy', 'mixin/HudMixin']) await writeFile(join(classes, 'dev', 'demo', `${name}.class`), name)
    try {
      const result = await hotswapClasses({
        jdwpPort: port,
        classRoots: [classes],
        diff: { changed: ['dev/demo/Hud.class', 'dev/demo/Schema.class', 'dev/demo/Lazy.class', 'dev/demo/mixin/HudMixin.class'], added: ['dev/demo/New.class'], removed: [] },
        mixinPackages: ['dev/demo/mixin/']
      })
      assert.deepEqual(result.swapped, ['dev/demo/Hud'])
      assert.deepEqual(result.skippedNotLoaded, ['dev/demo/Lazy'])
      assert.deepEqual(result.added, ['dev/demo/New'])
      assert.equal(result.restartNeeded, true)
      assert.deepEqual(result.restartReasons.map((item) => item.reason).sort(), ['mixin', 'schema-change'])
      assert.deepEqual(result.failedPaths.sort(), ['dev/demo/Schema.class', 'dev/demo/mixin/HudMixin.class'])
      assert.deepEqual(redefined, [[11n]])
      redefined.length = 0
      const withAgent = await hotswapClasses({
        jdwpPort: port,
        classRoots: [classes],
        diff: { changed: ['dev/demo/Hud.class', 'dev/demo/mixin/HudMixin.class'], added: [], removed: [] },
        mixinPackages: ['dev/demo/mixin/'],
        mixinHotswap: true
      })
      assert.deepEqual(withAgent.swapped.sort(), ['dev/demo/Hud', 'dev/demo/mixin/HudMixin'])
      assert.equal(withAgent.restartNeeded, false)
      assert.deepEqual(redefined, [[11n, 33n]])
      const client = await JdwpClient.connect(port)
      assert.equal((await client.idSizes()).referenceTypeId, 8)
      await client.dispose()
    } finally {
      server.close()
    }
    const offline = await hotswapClasses({ jdwpPort: 1, classRoots: [classes], diff: { changed: ['dev/demo/Hud.class'], added: [], removed: [] }, mixinPackages: [] }, async () => {
      throw new Error('refused')
    })
    assert.equal(offline.restartReasons[0].reason, 'jdwp-unavailable')
  })

  await test('启动参数文件、options.txt 与 JVM 参数清理', () => {
    assert.equal(argFileText(['-Dx=C:\\a b', 'say "hi"']), '"-Dx=C:\\\\a b"\n"say \\"hi\\""\n')
    assert.equal(mergeOptions('version:3955\npauseOnLostFocus:true\n', { pauseOnLostFocus: 'false', narrator: '0' }), 'version:3955\npauseOnLostFocus:false\nnarrator:0\n')
    assert.deepEqual(stripJvmArgs(['-Xmx2G', '-agentlib:jdwp=x', '-Dinkstone.companion.port=1', '-XX:+AllowEnhancedClassRedefinition', '-javaagent:C:/m/sponge-mixin-0.17.5.jar', '-Dfabric.dli.env=client']), ['-Dfabric.dli.env=client'])
    assert.equal(findMixinAgent(['C:/a/fabric-loader-0.16.jar', 'C:/b/sponge-mixin-0.17.5+mixin.0.8.7.jar']), 'C:/b/sponge-mixin-0.17.5+mixin.0.8.7.jar')
    assert.equal(findMixinAgent(['C:/a/mixinextras-0.4.jar']), null)
  })

  await test('日志分组过滤与崩溃摘要', () => {
    const log = [
      '[16:00:00] [Render thread/INFO] (Minecraft) hello',
      '[16:00:01] [Render thread/ERROR] (inkdemo) boom',
      'java.lang.IllegalStateException: x',
      '\tat dev.demo.Foo.bar(Foo.java:1)',
      '[16:00:02] [Render thread/WARN] (Minecraft) careful'
    ].join('\n')
    assert.equal(groupLogEntries(log).length, 3)
    assert.deepEqual(filterLog(log, { levels: ['ERROR'] }), log.split('\n').slice(1, 4))
    assert.deepEqual(filterLog(log, { filter: 'careful' }), [log.split('\n')[4]])
    assert.deepEqual(filterLog(log, { filter: '[bad' }), [])
    const crash = summarizeCrash(
      ['---- Minecraft Crash Report ----', 'Description: Unexpected error', '', 'java.lang.IllegalStateException: test', '\tat knot//dev.demo.Hud.render(Hud.java:1)', '\tat knot//net.minecraft.client.Main.main(Main.java:1)', '\tat java.base/java.lang.Thread.run(Thread.java:1)'].join('\n'),
      'crash.txt',
      1
    )
    assert.equal(crash.description, 'Unexpected error')
    assert.equal(crash.exception, 'java.lang.IllegalStateException: test')
    assert.deepEqual(crash.suspectFrames, ['dev.demo.Hud'])
  })

  await test('映射：tiny v2、ProGuard 与四种命名空间互查', () => {
    const intermediary = parseTiny(['tiny\t2\t0\tofficial\tintermediary', 'c\ta\tnet/minecraft/class_1', '\tm\t()La;\tb\tmethod_10', '\tf\tI\tc\tfield_20'].join('\n'))
    const yarn = parseTiny(['tiny\t2\t0\tofficial\tintermediary\tnamed', 'c\ta\tnet/minecraft/class_1\tnet/minecraft/client/MinecraftClient', '\tm\t()Lnet/minecraft/class_1;\tb\tmethod_10\tgetInstance', '\tf\tI\tc\tfield_20\tfps'].join('\n'))
    const moj = parseProguard(['# comment', 'net.minecraft.client.Minecraft -> a:', '    int fps -> c', '    1:3:net.minecraft.client.Minecraft getInstance() -> b'].join('\n'))
    assert.equal(proguardTypeToDescriptor('java.lang.String[][]', (name) => name), '[[Ljava/lang/String;')
    const table = buildTable('1.21.1', intermediary, yarn, moj, { yarn: 'y', mojmap: 'm' })
    const byClass = lookupMapping(table, 'MinecraftClient')
    assert.equal(byClass.classes[0].names.mojmap, 'net/minecraft/client/Minecraft')
    const method = lookupMapping(table, 'Minecraft#getInstance')
    assert.equal(method.members[0].names.intermediary, 'method_10')
    assert.equal(method.members[0].names.official, 'b')
    assert.equal(lookupMapping(table, 'field_20').members[0].names.mojmap, 'fps')
    assert.match(formatMapping(byClass, table), /yarn\s+net\/minecraft\/client\/MinecraftClient/)
    assert.match(formatMapping(lookupMapping(table, 'Nope'), table), /没有找到/)
  })

  await test('zip 读取与源码搜索、读取', async () => {
    const jar = join(root, 'minecraft-test-sources.jar')
    await writeFile(jar, makeZip({ 'net/minecraft/item/Item.java': 'package net.minecraft.item;\npublic class Item {\n  public void use() {}\n}\n', 'META-INF/MANIFEST.MF': 'x' }))
    const zip = await ZipReader.open(jar)
    assert.equal((await zip.read('META-INF/MANIFEST.MF'))?.toString(), 'x')
    assert.equal(await zip.read('missing'), null)
    const out = await extractSources(jar, join(root, 'extracted'))
    assert.ok(existsSync(join(out, 'net', 'minecraft', 'item', 'Item.java')))
    assert.ok(!existsSync(join(out, 'META-INF')))
    const cache = 'C:/p/.gradle/loom-cache/minecraftMaven/net/minecraft'
    const global = 'C:/u/.gradle/caches/fabric-loom/minecraftMaven/net/minecraft'
    assert.deepEqual(pickMinecraftSourceJars([`${cache}/minecraft-clientOnly-ab-26.1.2-sources.jar`, `${cache}/minecraft-common-ab-26.1.2-sources.jar`, `${cache}/minecraft-common-old-26.1.2-sources.jar`, `${global}/minecraft-merged-1.21.1-sources.jar`]), [`${cache}/minecraft-clientOnly-ab-26.1.2-sources.jar`, `${cache}/minecraft-common-ab-26.1.2-sources.jar`])
    assert.equal(sourceJarKind('x/minecraft-merged-cd-1.21.1-sources.jar'), 'merged')
    const roots = [{ scope: 'minecraft' as const, dir: out, label: 'mc' }]
    const found = await searchSources(roots, 'void use(', {})
    assert.deepEqual(found.matches.map((match) => `${match.file}:${match.line}`), ['net/minecraft/item/Item.java:3'])
    assert.equal((await searchSources(roots, 'use', { pathFilter: 'net.minecraft.block' })).matches.length, 0)
    assert.equal((await readSource(roots, 'net.minecraft.item.Item', { start: 2, lines: 1 }))?.text, '    2  public class Item {')
    assert.equal((await readSource(roots, 'Item'))?.total, 5)
  })

  await test('伴随 mod jar 选择与安装', async () => {
    const libs = join(root, 'libs')
    await mkdir(libs, { recursive: true })
    for (const name of ['inkstone-companion-0.1.0.jar', 'inkstone-companion-0.10.0.jar', 'inkstone-companion-0.10.0-sources.jar', 'inkstone-companion-mc26-0.1.0.jar', 'inkstone-companion-mc26-0.2.0.jar']) await writeFile(join(libs, name), name)
    const jar = await findCompanionJar([libs, join(root, 'nope')])
    assert.ok(jar?.endsWith('inkstone-companion-0.10.0.jar'))
    const mods = join(root, 'run', 'mods')
    await mkdir(mods, { recursive: true })
    await writeFile(join(mods, 'inkstone-companion-0.0.1.jar'), 'old')
    await writeFile(join(mods, 'other.jar'), 'keep')
    await installCompanion(jar!, mods)
    assert.deepEqual((await readdir(mods)).sort(), ['inkstone-companion-0.10.0.jar', 'other.jar'])
    assert.equal(companionSupports('1.21.1'), true)
    assert.equal(companionSupports('1.21.4'), false)
    assert.equal(companionVariant('26.1.2')?.subdir, 'mc26')
    assert.equal(companionVariant('26.1')?.id, '26.1')
    assert.equal(companionVariant('26.2'), null)
    assert.ok((await findCompanionJar([libs], COMPANION_VARIANTS[1]))?.endsWith('inkstone-companion-mc26-0.2.0.jar'))
    assert.ok((await findCompanionJar([libs], companionVariant('1.21.1')!))?.endsWith('inkstone-companion-0.10.0.jar'))
  })

  await test('贴图引用解析与项目资源查找', async () => {
    assert.equal(texturePathFromId('mymod:item/ruby'), 'assets/mymod/textures/item/ruby.png')
    assert.equal(texturePathFromId('minecraft:textures/block/stone.png'), 'assets/minecraft/textures/block/stone.png')
    assert.equal(texturePathFromId('not an id'), null)
    const mainRes = join(root, 'split', 'src', 'main', 'resources')
    const clientRes = join(root, 'split', 'src', 'client', 'resources')
    assert.equal(textureWriteDir([clientRes, mainRes], 'pit'), mainRes)
    await mkdir(join(clientRes, 'assets', 'pit'), { recursive: true })
    assert.equal(textureWriteDir([mainRes, clientRes], 'pit'), clientRes)
    const resources = join(root, 'res')
    await mkdir(join(resources, 'assets', 'mymod', 'textures', 'item'), { recursive: true })
    await writeFile(join(resources, 'assets', 'mymod', 'textures', 'item', 'ruby.png'), encodePng(createImage(16, 16)))
    await writeFile(join(resources, 'assets', 'mymod', 'textures', 'item', 'ruby.png.mcmeta'), '{"animation":{}}')
    const found = await loadTexture('mymod:item/ruby', { projectDir: root, resourceDirs: [resources], minecraft: null })
    assert.equal(found.mcmeta, '{"animation":{}}')
    await assert.rejects(loadTexture('mymod:item/none', { projectDir: root, resourceDirs: [resources], minecraft: null }), /没找到/)
  })

  await test('Gradle 输出解析与 wrapper 命令', () => {
    const output = 'WARNING: A restricted method in java.lang.System has been called\r\nE:\\p\\src\\Foo.java:12: error: cannot find symbol\r\n    foo();\r\n    ^\r\nFAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed\n\n* Try:\n> x'
    const errors = parseGradleErrors(output)
    assert.match(errors[0], /Foo\.java:12: error: cannot find symbol/)
    assert.match(errors[1], /What went wrong/)
    assert.doesNotMatch(cleanGradleOutput(output), /restricted method/)
    assert.match(wrapperProperties('9.8.2'), /gradle-9\.8\.2-bin\.zip/)
    assert.deepEqual(wrapperCommand('P', 'java', ['build']).args.slice(-2), ['org.gradle.wrapper.GradleWrapperMain', 'build'])
    assert.equal(isJbrRelease('IMPLEMENTOR="JetBrains s.r.o."'), true)
    assert.equal(isJbrRelease('IMPLEMENTOR="Azul Systems, Inc."'), false)
  })

  await test('MCP 协议：初始化、列工具、调用与错误', async () => {
    const tools = [{ name: 'echo', title: 'Echo', description: 'd', inputSchema: { type: 'object' }, run: async (args: Record<string, unknown>) => text(String(args.value)) }, { name: 'bad', title: 'Bad', description: 'd', inputSchema: { type: 'object' }, run: async () => { throw new Error('炸了') } }]
    const info = { name: 'x', version: '1', instructions: 'i' }
    const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, tools, info)
    assert.equal((init?.result as { protocolVersion: string }).protocolVersion, '2025-06-18')
    const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools, info)
    assert.deepEqual(Object.keys((list?.result as { tools: Record<string, unknown>[] }).tools[0]).sort(), ['description', 'inputSchema', 'name', 'title'])
    const call = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hi' } } }, tools, info)
    assert.deepEqual(call?.result, { content: [{ type: 'text', text: 'hi' }] })
    const bad = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bad' } }, tools, info)
    assert.equal((bad?.result as { isError: boolean }).isError, true)
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, info), null)
    assert.equal(((await handleMessage({ jsonrpc: '2.0', id: 5, method: 'nope' }, tools, info))?.error as { code: number }).code, -32601)
  })

  await test('MCP 工具标注只读与破坏性提示', () => {
    const hints = Object.fromEntries(createTools({ options: { dataDir: root, javaPaths: [] } } as unknown as Parameters<typeof createTools>[0]).map((tool) => [tool.name, tool.annotations]))
    assert.equal(Object.keys(hints).length, 12)
    assert.equal(hints.mc_options?.readOnlyHint, false)
    assert.equal(hints.mc_logs?.readOnlyHint, true)
    assert.equal(hints.mc_command?.destructiveHint, true)
    assert.equal(hints.mc_apply?.readOnlyHint, false)
  })

  await test('mc_apply 结果文案', () => {
    const textOut = formatApply({
      build: { ok: true, durationMs: 1300, tasks: [':classes'], output: '', errors: [] },
      hotswap: { swapped: ['dev/demo/Hud'], added: [], removed: [], skippedNotLoaded: [], restartNeeded: true, restartReasons: [{ reason: 'schema-change', detail: 'dev/demo/Foo：新增了方法' }] },
      resourcesReloaded: true,
      dataReloaded: false,
      changedAssets: ['assets/x.png'],
      changedData: [],
      restartNeeded: true,
      restarted: false,
      notes: []
    })
    assert.match(textOut, /已热替换：dev\/demo\/Hud/)
    assert.match(textOut, /资源已重载/)
    assert.match(textOut, /mc_run action=restart/)
    const sided = formatApply(
      {
        build: { ok: true, durationMs: 900, tasks: [':classes'], output: '', errors: [] },
        hotswap: { swapped: ['com/demo/client/Hud', 'com/demo/ModItems'], added: ['com/demo/client/NewThing'], removed: [], skippedNotLoaded: [], restartNeeded: false, restartReasons: [] },
        resourcesReloaded: false,
        dataReloaded: false,
        changedAssets: [],
        changedData: [],
        restartNeeded: false,
        restarted: false,
        notes: []
      },
      (path) => (path.includes('/client/') ? 'client' : path.includes('ModItems') ? 'main' : null)
    )
    assert.match(sided, /已热替换：com\/demo\/client\/Hud（client）、com\/demo\/ModItems（main）/) 
    assert.match(sided, /新类（首次用到时加载）：com\/demo\/client\/NewThing（client）/)
  })

  await test('开发客户端启动参数：Agent 窗口属性与宽高去重', () => {
    assert.equal(agentWindowTitle('E:\\work\\demo'), 'Inkstone Agent · demo')
    assert.deepEqual(agentWindowJvmArgs('E:/work/demo'), [
      '-Dinkstone.window.title=Inkstone Agent · demo',
      '-Dinkstone.window.placement=corner',
      '-Dinkstone.control=agent',
      '-Dinkstone.input=background'
    ])
    assert.deepEqual(withWindowSize(['--username', 'Dev', '--gameDir', '.']), ['--username', 'Dev', '--gameDir', '.', '--width', '960', '--height', '540'])
    assert.deepEqual(withWindowSize(['--width', '1280', '--height', '720', '--username', 'Dev']), ['--username', 'Dev', '--width', '960', '--height', '540'])
    assert.deepEqual(withWindowSize(['--width=1920', '--quickPlaySingleplayer', 'inkstone-test']), ['--quickPlaySingleplayer', 'inkstone-test', '--width', '960', '--height', '540'])
    assert.deepEqual(splitLaunchArgs(['-Xmx4096m', ...agentWindowJvmArgs('E:/work/坑')]), {
      fileArgs: ['-Xmx4096m', '-Dinkstone.window.placement=corner', '-Dinkstone.control=agent', '-Dinkstone.input=background'],
      commandArgs: ['-Dinkstone.window.title=Inkstone Agent · 坑']
    })
    assert.deepEqual(stripJvmArgs(['-Dinkstone.window.title=Old', '-Dinkstone.window.placement=normal', '-Dinkstone.control=user', '-Dother=1']), ['-Dother=1'])
  })

  await test('伴随 mod 控制方：查询、切换与非法返回', async () => {
    const seen: Array<Record<string, unknown>> = []
    const server = createHttpServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += String(chunk)
      })
      request.on('end', () => {
        const parsed = (body ? JSON.parse(body) : {}) as Record<string, unknown>
        seen.push(parsed)
        const owner = typeof parsed.owner === 'string' ? parsed.owner : 'user'
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ owner, changedAt: 1700000000000, changedBy: typeof parsed.owner === 'string' ? 'agent' : 'user' }))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const query = await companionControl({ port, token: 'token' })
      assert.deepEqual(query, { owner: 'user', changedAt: 1700000000000, changedBy: 'user' })
      const switched = await companionControl({ port, token: 'token' }, 'agent')
      assert.deepEqual(switched, { owner: 'agent', changedAt: 1700000000000, changedBy: 'agent' })
      assert.deepEqual(seen, [{}, { owner: 'agent' }])
      assert.equal(parseCompanionControl({ owner: 'nope' }), null)
      assert.equal(parseCompanionControl(null), null)
    } finally {
      server.close()
    }
  })

  const baseSession: DevSessionInfo = {
    projectDir: root,
    pid: 4321,
    state: 'running',
    startedAt: 1,
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
  const shotPng = encodePng(createImage(4, 4, [20, 30, 40, 255]))
  const stubProject = (owner: 'agent' | 'user', calls: string[]): DevProject => {
    const session = (next: 'agent' | 'user'): DevSessionInfo => ({ ...baseSession, control: { owner: next, changedAt: 1700000000000, changedBy: 'user' } })
    return {
      projectDir: root,
      control: async () => ({ owner, changedAt: 1700000000000, changedBy: 'user' as const }),
      setControl: async (next: 'agent' | 'user') => {
        calls.push(`setControl:${next}`)
        return session(next)
      },
      status: async () => session(owner),
      command: async (command: string) => {
        calls.push(`command:${command}`)
        return { command, ok: true, output: ['已执行'], error: null }
      },
      apply: async (options: { autoRestart?: boolean } = {}) => {
        calls.push(`apply:${options.autoRestart === true}`)
        return {
          build: { ok: true, durationMs: 10, tasks: [':classes'], output: '', errors: [] },
          hotswap: null,
          resourcesReloaded: false,
          dataReloaded: false,
          changedAssets: [],
          changedData: [],
          restartNeeded: true,
          restarted: false,
          notes: ['需要重启才能生效：改父类']
        }
      },
      stop: async () => {
        calls.push('stop')
        return session(owner)
      },
      restart: async () => {
        calls.push('restart')
        return session(owner)
      },
      launch: async () => {
        calls.push('launch')
        return session(owner)
      },
      image: async (path: string) => {
        calls.push(`image:${path}`)
        return shotPng
      },
      logs: async () => ['[12:00:00] 日志行'],
      companion: async (path: string) => {
        calls.push(`companion:${path}`)
        return { playing: true }
      }
    } as unknown as DevProject
  }
  const stubTools = (project: DevProject) => createTools({ options: { runtimesDir: root, javaPaths: [], maxMemoryMb: 4096, log: () => undefined }, project: () => project } as unknown as Parameters<typeof createTools>[0])
  const toolOf = (tools: ReturnType<typeof createTools>, name: string) => {
    const found = tools.find((tool) => tool.name === name)
    assert.ok(found, `找不到工具 ${name}`)
    return found
  }
  const bodyOf = (result: ToolResult): string => result.content.map((item) => item.text ?? '').filter(Boolean).join('\n')

  await test('MCP：用户接管时拒绝写操作、放行只读', async () => {
    const calls: string[] = []
    const tools = stubTools(stubProject('user', calls))
    for (const [name, args] of [
      ['mc_command', { command: '/give @s stone' }],
      ['mc_run', { action: 'stop' }],
      ['mc_run', { action: 'restart' }],
      ['mc_options', { set: { lang: 'zh_cn' } }]
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await toolOf(tools, name).run(args)
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} 应该被拒绝`)
      assert.match(bodyOf(result), /用户正在操作开发客户端/)
      assert.equal(bodyOf(result).includes(USER_IN_CONTROL), true)
    }
    assert.deepEqual(calls, [])
    const applied = await toolOf(tools, 'mc_apply').run({ restart_if_needed: true })
    assert.equal(applied.isError, undefined)
    assert.deepEqual(calls, ['apply:false'])
    assert.match(bodyOf(applied), /没有自动重启/)
    const viewed = await toolOf(tools, 'mc_view').run({ target: 'screen' })
    assert.equal(viewed.isError, undefined)
    assert.match(bodyOf(viewed), /画面可能已被改变/)
    assert.equal(viewed.content[0]?.type, 'image')
    const inspected = await toolOf(tools, 'mc_inspect').run({ what: 'status' })
    assert.equal(inspected.isError, undefined)
    assert.match(bodyOf(inspected), /控制方：用户/)
    const logged = await toolOf(tools, 'mc_logs').run({})
    assert.equal(logged.isError, undefined)
    assert.match(bodyOf(logged), /日志行/)
    const status = await toolOf(tools, 'mc_run').run({ action: 'status' })
    assert.match(bodyOf(status), /控制方：用户/)
    const taken = await toolOf(tools, 'mc_run').run({ action: 'take_control' })
    assert.equal(taken.isError, undefined)
    assert.match(bodyOf(taken), /已收回控制权/)
    assert.match(bodyOf(taken), /控制方：Agent/)
    assert.deepEqual(calls, ['apply:false', 'image:/screenshot', 'companion:/status', 'companion:/status', 'companion:/perf', 'companion:/command', 'setControl:agent'])
  })

  await test('MCP：控制方为 Agent 时照常执行', async () => {
    const calls: string[] = []
    const tools = stubTools(stubProject('agent', calls))
    const commanded = await toolOf(tools, 'mc_command').run({ command: '/time set day' })
    assert.equal(commanded.isError, undefined)
    assert.match(bodyOf(commanded), /已执行/)
    const applied = await toolOf(tools, 'mc_apply').run({ restart_if_needed: true })
    assert.match(bodyOf(applied), /需要重启才能生效/)
    const stopped = await toolOf(tools, 'mc_run').run({ action: 'stop' })
    assert.equal(stopped.isError, undefined)
    assert.match(bodyOf(stopped), /控制方：Agent/)
    const viewed = await toolOf(tools, 'mc_view').run({ target: 'screen' })
    assert.equal(bodyOf(viewed).includes('画面可能已被改变'), false)
    assert.deepEqual(calls, ['companion:/chat', 'command:/time set day', 'apply:true', 'companion:/command', 'stop', 'companion:/status', 'image:/screenshot'])
    assert.match(bodyOf(viewed), /已存原图：.*shots.*-view-screen\.png/)
  })

  await test('MCP：服务端命令没有回显时读执行期间的新聊天', async () => {
    const calls: string[] = []
    const base = stubProject('agent', calls)
    const project = {
      ...base,
      command: async (command: string) => ({ command, ok: true, output: [], error: null }),
      companion: async (path: string, body: Record<string, unknown> = {}) => {
        calls.push(`companion:${path}:${body.since ?? '-'}`)
        if (path !== '/chat') return { playing: true }
        return body.since === 7 ? { latest: 8, messages: [{ seq: 8, time: 1700000000000, kind: 'system', text: '天赋栏 1：空' }] } : { latest: 7, messages: [] }
      }
    } as unknown as DevProject
    const commanded = await toolOf(stubTools(project), 'mc_command').run({ command: '/pit perks' })
    assert.equal(commanded.isError, undefined)
    assert.match(bodyOf(commanded), /命令来源没有回显/)
    assert.match(bodyOf(commanded), /天赋栏 1：空/)
    assert.deepEqual(calls, ['companion:/chat:-', 'companion:/chat:7'])
  })

  await test('MCP：并发的服务端命令排队执行，兜底消息不串到别的命令', async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const chat: Array<{ seq: number; time: number; kind: string; text: string }> = []
    const project = {
      ...stubProject('agent', []),
      command: async (command: string) => {
        await sleep(30)
        if (command.includes('show')) chat.push({ seq: chat.length + 1, time: 1700000000000, kind: 'system', text: '正在展示物品' })
        await sleep(30)
        return { command, ok: true, output: [], error: null }
      },
      companion: async (path: string, body: Record<string, unknown> = {}) => {
        if (path !== '/chat') return { playing: true }
        const since = typeof body.since === 'number' ? body.since : chat.length
        return { latest: chat.length, messages: chat.filter((message) => message.seq > since) }
      }
    } as unknown as DevProject
    const tool = toolOf(stubTools(project), 'mc_command')
    const [shown, perks] = await Promise.all([tool.run({ command: '/show' }), tool.run({ command: '/pit perks' })])
    assert.match(bodyOf(shown), /正在展示物品/)
    assert.doesNotMatch(bodyOf(perks), /正在展示物品/)
    assert.match(bodyOf(perks), /没有输出/)
  })

  const specOf = (projectDir: string, workingDir: string): string =>
    JSON.stringify({ project: 'demo', projectDir, mainClass: 'a.B', classpath: [], jvmArgs: [], args: [], workingDir, environment: {}, javaLauncher: null, minecraftVersion: '1.21.1', gradleVersion: null, sourceSets: [] })

  const projectWithRun = async (name: string, optionsText: string): Promise<{ project: DevProject; workingDir: string }> => {
    const projectDir = join(root, name)
    const workingDir = join(root, `${name}-run`)
    await mkdir(join(projectDir, '.inkstone', 'dev'), { recursive: true })
    await mkdir(workingDir, { recursive: true })
    await writeFile(join(projectDir, '.inkstone', 'dev', 'launch-spec.json'), specOf(projectDir, workingDir))
    if (optionsText) await writeFile(join(workingDir, 'options.txt'), optionsText)
    return { project: new DevProject(projectDir, { runtimesDir: root, javaPaths: [] }), workingDir }
  }

  await test('启动环境参数：进世界后的命令与启动前的 options 覆盖', async () => {
    assert.deepEqual(environmentCommands({}), [])
    assert.deepEqual(environmentCommands({ lang: 'zh_cn' }), [])
    assert.deepEqual(environmentCommands({ difficulty: 'normal', gamemode: 'survival', time: 'noon', weather: 'clear' }), ['difficulty normal', 'gamemode survival', 'time set noon', 'weather clear'])
    const dir = join(root, 'prepare-run')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'options.txt'), 'version:3955\nlang:en_us\npauseOnLostFocus:true\n')
    await prepareRunDir(dir, { lang: 'zh_cn' })
    const merged = parseOptions(await readFile(join(dir, 'options.txt'), 'utf8'))
    assert.equal(merged.lang, 'zh_cn')
    assert.equal(merged.version, '3955')
    assert.equal(merged.pauseOnLostFocus, 'false')
    assert.equal(merged.tutorialStep, 'none')
  })

  await test('客户端选项：读写 run/options.txt', async () => {
    const { project, workingDir } = await projectWithRun('opt', 'version:3955\nlang:en_us\n')
    const read = await project.clientOptions()
    assert.equal(read.file, join(workingDir, 'options.txt'))
    assert.equal(read.values.lang, 'en_us')
    const written = await project.saveClientOptions({ lang: 'zh_cn', guiScale: '3' })
    assert.equal(written.values.lang, 'zh_cn')
    assert.equal(written.values.guiScale, '3')
    assert.equal(parseOptions(await readFile(join(workingDir, 'options.txt'), 'utf8')).version, '3955')
  })

  await test('mc_view 连拍：张数、时间戳与 hideHud/crop 转发', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const project = {
      projectDir: root,
      control: async () => ({ owner: 'agent', changedAt: 0, changedBy: 'agent' }),
      image: async (path: string, body: Record<string, unknown> = {}) => {
        bodies.push({ path, ...body })
        return shotPng
      }
    } as unknown as DevProject
    const result = await toolOf(stubTools(project), 'mc_view').run({ target: 'screen', count: 3, intervalMs: 0, hideHud: true, crop: [0, 0, 320, 180] })
    assert.equal(result.content.filter((item) => item.type === 'image').length, 3)
    assert.equal(bodies.length, 3)
    assert.equal(bodies[0].hideHud, true)
    assert.deepEqual(bodies[0].crop, [0, 0, 320, 180])
    const stamps = result.content.filter((item) => item.type === 'text').map((item) => item.text ?? '')
    assert.equal(stamps.filter((line) => /^#\d\/3 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}（第 [\d.]+s）4×4$/.test(line)).length, 3)
    assert.match(stamps.join('\n'), /连拍 3 张，间隔 0ms/)
  })

  await test('mc_view：旧伴随 mod 不支持 hideHud 时退回完整画面', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const project = {
      projectDir: root,
      control: async () => ({ owner: 'agent', changedAt: 0, changedBy: 'agent' }),
      image: async (path: string, body: Record<string, unknown> = {}) => {
        bodies.push({ path, ...body })
        if (body.hideHud) throw new CompanionError(400, 'unknown field hideHud')
        return shotPng
      }
    } as unknown as DevProject
    const result = await toolOf(stubTools(project), 'mc_view').run({ target: 'screen', hideHud: true })
    assert.equal(result.content.filter((item) => item.type === 'image').length, 1)
    assert.match(bodyOf(result), /还没有支持 hideHud/)
    assert.equal(bodies.length, 2)
    assert.equal(bodies[1].hideHud, undefined)
  })

  await test('mc_command：check 只解析、via=chat 从聊天读结果', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const project = {
      projectDir: join(root, 'chat-project'),
      control: async () => ({ owner: 'agent', changedAt: 0, changedBy: 'agent' }),
      companion: async (path: string, body: Record<string, unknown> = {}) => {
        bodies.push({ path, ...body })
        if (path === '/command') return body.check ? { valid: false, error: 'Unknown command', cursor: 3, suggestions: ['give', 'gamemode'] } : { sent: true }
        return { latest: 7, messages: [{ seq: 7, time: 1700000000000, kind: 'system', text: '给了 你 一个钻石' }] }
      },
      command: async () => {
        throw new Error('check 不应该执行命令')
      }
    } as unknown as DevProject
    const tools = stubTools(project)
    const checked = await toolOf(tools, 'mc_command').run({ command: '/giv @s stone', check: true })
    assert.equal(checked.isError, true)
    assert.match(bodyOf(checked), /命令无法解析：\/giv @s stone/)
    assert.match(bodyOf(checked), /Unknown command（第 3 个字符处）/)
    assert.match(bodyOf(checked), /补全建议：give、gamemode/)
    assert.equal(bodies[0].check, true)
    assert.equal(bodies[0].command, 'giv @s stone')
    const chatted = await toolOf(tools, 'mc_command').run({ command: 'give @s stone', via: 'chat' })
    assert.match(bodyOf(chatted), /已从聊天发送：\/give @s stone/)
    assert.match(bodyOf(chatted), /system: 给了 你 一个钻石/)
    assert.equal(bodies.length, 3)
    assert.equal(bodies[1].via, 'chat')
    assert.equal(bodies[2].path, '/chat')
  })

  await test('mc_inspect player：玩家状态摘要与 target 别名', async () => {
    const project = {
      projectDir: root,
      control: async () => ({ owner: 'agent', changedAt: 0, changedBy: 'agent' }),
      companion: async () => ({
        name: 'Dev',
        uuid: 'u-1',
        pos: [1.4, 64, -3.6],
        rot: [90, 0],
        dimension: 'minecraft:overworld',
        health: 20,
        maxHealth: 20,
        absorption: 2,
        food: 17,
        saturation: 3.2,
        xp: { level: 5, progress: 0.5 },
        gamemode: 'creative',
        invulnerable: false,
        onGround: true,
        effects: [{ id: 'minecraft:speed', amplifier: 1, duration: 200 }],
        selectedSlot: 2,
        inventory: [{ slot: 0, item: { id: 'minecraft:stone', count: 3 } }],
        armor: [],
        offhand: null,
        lookingAt: { type: 'block', pos: [1, 64, -4] }
      })
    } as unknown as DevProject
    const tools = stubTools(project)
    const body = bodyOf(await toolOf(tools, 'mc_inspect').run({ what: 'player' }))
    assert.match(body, /Dev（creative）/) 
    assert.match(body, /位置：1, 64, -4（minecraft:overworld）/) 
    assert.match(body, /生命 20.0\/20\+2.0 吸收/) 
    assert.match(body, /饥饿 17\/20（饱和 3.2）/) 
    assert.match(body, /等级 5（50%），快捷栏第 3 格/) 
    assert.match(body, /minecraft:speed 2 级 10s/) 
    assert.match(body, /背包：0: minecraft:stone×3/) 
    assert.match(body, /不临时改游戏模式/)
    assert.match(bodyOf(await toolOf(tools, 'mc_inspect').run({ target: 'player' })), /Dev（creative）/) 
  })

  await test('mc_options：运行时走伴随 mod /options', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const project = {
      projectDir: root,
      control: async () => ({ owner: 'agent', changedAt: 0, changedBy: 'agent' }),
      status: async () => ({ ...baseSession }),
      companion: async (path: string, body: Record<string, unknown> = {}) => {
        bodies.push({ path, ...body })
        return { values: { lang: 'zh_cn', guiScale: '4' }, applied: ['guiScale'], needsRestart: ['fov'] }
      }
    } as unknown as DevProject
    const body = bodyOf(await toolOf(stubTools(project), 'mc_options').run({ get: ['lang'], set: { lang: 'zh_cn', guiScale: '4' } }))
    assert.match(body, /lang = zh_cn/)
    assert.match(body, /已当场生效：guiScale/)
    assert.match(body, /需要重启才生效：fov/)
    assert.deepEqual(bodies, [{ path: '/options', get: ['lang'], set: { lang: 'zh_cn', guiScale: '4' } }])
  })

  await test('mc_options：游戏没在运行时读写 run/options.txt', async () => {
    const { project, workingDir } = await projectWithRun('opt-tool', 'lang:en_us\n')
    const tools = stubTools(project)
    const read = bodyOf(await toolOf(tools, 'mc_options').run({ get: ['lang', 'foo'] }))
    assert.match(read, /游戏没在运行/)
    assert.match(read, /lang = en_us/)
    assert.match(read, /foo = （文件里没有这个键）/)
    const written = bodyOf(await toolOf(tools, 'mc_options').run({ set: { lang: 'zh_cn' } }))
    assert.match(written, /下次启动生效/)
    assert.equal(parseOptions(await readFile(join(workingDir, 'options.txt'), 'utf8')).lang, 'zh_cn')
    assert.equal((await toolOf(tools, 'mc_options').run({})).isError, true)
  })

  await test('新路由联调（假伴随 mod）：env/perf/options/check/chat/player/截图参数', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown>; auth: string | undefined }> = []
    const server = createHttpServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += String(chunk)
      })
      request.on('end', () => {
        const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>
        const path = request.url ?? ''
        requests.push({ path, body: parsed, auth: request.headers.authorization })
        const reply = (value: unknown) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        if (path === '/screenshot') {
          response.writeHead(200, { 'content-type': 'image/png' })
          response.end(shotPng)
          return
        }
        if (path === '/status')
          return reply({
            playing: true,
            world: 'inkstone-test',
            env: { world: 'inkstone-test', version: '1.21.1', difficulty: 'peaceful', gamemode: 'creative', lang: 'en_us', pos: [0.4, 64, 0], dimension: 'minecraft:overworld', paused: false }
          })
        if (path === '/perf') return reply({ fps: 120, mspt: 4.5, tps: 20, memory: { used: 800, max: 4096 }, entities: 3, chunks: 25 })
        if (path === '/options') return reply({ values: { lang: 'zh_cn', guiScale: '4' }, applied: ['guiScale'], needsRestart: [] })
        if (path === '/command') return reply(parsed.check === true ? { valid: true, suggestions: ['creative', 'survival'] } : { sent: true })
        if (path === '/chat') return reply({ latest: 12, messages: [{ seq: 12, time: 1700000000000, kind: 'chat', text: '你 变成创造模式' }] })
        if (path === '/player') return reply({ name: 'Dev', uuid: 'u', pos: [0.4, 64, 0], rot: [90, 0], dimension: 'minecraft:overworld', health: 20, maxHealth: 20, absorption: 0, food: 20, saturation: 5, xp: { level: 0, progress: 0 }, gamemode: 'creative', invulnerable: false, onGround: true, effects: [], selectedSlot: 0, inventory: [], armor: [], offhand: null, lookingAt: null })
        if (path === '/control') return reply({ owner: 'agent', changedAt: 1700000000000, changedBy: 'agent' })
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no route' }))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const projectDir = join(root, 'live-project')
      const workingDir = join(root, 'live-run')
      await mkdir(join(projectDir, '.inkstone', 'dev'), { recursive: true })
      await mkdir(workingDir, { recursive: true })
      await writeFile(join(projectDir, '.inkstone', 'dev', 'launch-spec.json'), specOf(projectDir, workingDir))
      await writeFile(
        join(projectDir, '.inkstone', 'dev', 'session.json'),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          startedAt: Date.now(),
          javaPath: 'java',
          jbr: false,
          enhanced: false,
          mixinAgent: true,
          jdwpPort: 5005,
          companionPort: port,
          token: 'tok',
          world: 'inkstone-test',
          logFile: join(workingDir, 'client.log'),
          minecraftVersion: '1.21.1',
          owner: process.pid,
          exitCode: null,
          stoppedAt: null,
          message: null,
          jbrHint: null
        })
      )
      const tools = stubTools(new DevProject(projectDir, { runtimesDir: root, javaPaths: [] }))
      const status = bodyOf(await toolOf(tools, 'mc_run').run({ action: 'status' }))
      assert.match(status, /状态：running/)
      assert.match(status, /环境：世界 inkstone-test \/ 版本 1.21.1 \/ 维度 minecraft:overworld \/ 模式 creative \/ 难度 peaceful \/ 语言 en_us \/ 坐标 0, 64, 0/)
      assert.match(status, /性能：TPS 20.0 \/ MSPT 4.5 \/ FPS 120 \/ 内存 800\/4096MB \/ 实体 3 \/ 区块 25/)
      assert.match(status, /控制方：Agent/)
      assert.equal(requests.every((item) => item.auth === 'Bearer tok'), true)
      const options = bodyOf(await toolOf(tools, 'mc_options').run({ set: { lang: 'zh_cn' } }))
      assert.match(options, /已当场生效：guiScale/)
      assert.deepEqual(requests.find((item) => item.path === '/options')?.body, { set: { lang: 'zh_cn' } })
      const checked = bodyOf(await toolOf(tools, 'mc_command').run({ command: 'gamemode creative', check: true }))
      assert.match(checked, /命令可解析：\/gamemode creative/)
      assert.match(checked, /补全建议：creative、survival/)
      const chatted = bodyOf(await toolOf(tools, 'mc_command').run({ command: 'gamemode creative', via: 'chat' }))
      assert.match(chatted, /chat: 你 变成创造模式/)
      assert.match(bodyOf(await toolOf(tools, 'mc_inspect').run({ what: 'player' })), /Dev（creative）/)
      const shots = await toolOf(tools, 'mc_view').run({ target: 'screen', count: 2, intervalMs: 0, crop: [0, 0, 320, 180] })
      assert.equal(shots.content.filter((item) => item.type === 'image').length, 2)
      assert.deepEqual(requests.filter((item) => item.path === '/screenshot').map((item) => item.body), [{ crop: [0, 0, 320, 180] }, { crop: [0, 0, 320, 180] }])
    } finally {
      server.close()
    }
  })

  await test('注册 T1–T3 的工具：tools/list 能看到全部', async () => {
    const logs: string[] = []
    const context = { options: { runtimesDir: root, javaPaths: [], maxMemoryMb: 4096, log: (line: string) => logs.push(line) }, project: () => stubProject('agent', []) } as unknown as Parameters<typeof createToolsWithExtras>[0]
    const tools = await createToolsWithExtras(context)
    const names = tools.map((tool) => tool.name)
    for (const name of ['mc_test', 'mc_world', 'mc_input', 'mc_ui', 'mc_chat', 'mc_script', 'mc_perf']) assert.ok(names.includes(name), `缺少 ${name}（当前：${names.join(', ')}）`)
    assert.equal(new Set(names).size, names.length)
    const emptyDir = join(root, 'no-modules')
    await mkdir(emptyDir, { recursive: true })
    assert.deepEqual(await loadExtraTools(context, emptyDir), [])
    assert.equal(logs.length, 4)
  })

  console.log(`✓ ${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
