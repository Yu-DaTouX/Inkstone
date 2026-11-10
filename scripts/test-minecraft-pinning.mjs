import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
const crc32 = (data) => {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const zipArchive = (files) => {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name)
    const dataBytes = Buffer.from(text)
    const crc = crc32(dataBytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(dataBytes.length, 18)
    local.writeUInt32LE(dataBytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, dataBytes)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x800, 8)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(dataBytes.length, 20)
    entry.writeUInt32LE(dataBytes.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + dataBytes.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail === undefined ? '' : `: ${detail}`}`)
  checks++
}
const pinFor = (body, version = '0.1.0') => {
  const bytes = Buffer.from(body)
  return { version, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

const built = await build({
  entryPoints: ['src/main/minecraft-plugin.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const mc = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const root = await mkdtemp(join(tmpdir(), 'yan-mc-pin-'))
try {
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  const paths = {
    pluginDir: join(root, 'yan', 'plugins', 'inkstone-minecraft'),
    skillsDir: join(root, 'yan', 'skills'),
    agentDir,
    runtime: 'C:/Inkstone/Inkstone.exe',
    tempDir: join(root, 'yan', 'tmp')
  }
  ok(mc.MINECRAFT_PLUGIN_PIN.version === '0.1.1', '固定版本与已核验发布一致')
  ok(mc.MINECRAFT_PLUGIN_PIN.size === 1_392_640, '固定包大小与已核验发布一致')
  ok(mc.MINECRAFT_PLUGIN_PIN.sha256 === '09b1caa5b07442884ddab2578a4c025089af6a8b863d9634d1eeb8cfd043a9f4', '固定摘要与已核验发布元数据一致')
  ok(mc.MINECRAFT_PLUGIN_ARCHIVE === 'https://github.com/Yu-DaTouX/inkstone-minecraft-plugin/releases/download/v0.1.1/inkstone-minecraft-plugin.zip', '默认下载地址指向固定版本，而不是 latest')

  const seen = []
  const serve = (body, status = 200, headers = {}) => async (url) => {
    seen.push(url)
    return new Response(body, { status, headers })
  }
  const has = (name) => readFile(join(paths.pluginDir, name), 'utf8').then(() => true, () => false)
  const archive = zipArchive(Object.entries({
    'package.json': JSON.stringify({ name: 'inkstone-minecraft-plugin', version: '0.1.0' }),
    'mcp/server.ts': 'server',
    'skills/inkstone-fabric-dev/SKILL.md': 'skill'
  }))

  {
    const result = await mc.installMinecraftPlugin(paths, { fetch: serve(archive, 404) })
    ok(!result.ok && seen.at(-1) === mc.MINECRAFT_PLUGIN_ARCHIVE && /HTTP 404/.test(result.error), '默认安装只请求固定版本地址', result.error)
    ok(!result.status.installed, '下载失败不留下插件目录')
  }

  {
    const result = await mc.installMinecraftPlugin(paths, { fetch: serve(archive), pin: pinFor(archive) })
    ok(result.ok, '摘要正确时合成包安装成功', result.error)
    ok(seen.at(-1) === 'https://github.com/Yu-DaTouX/inkstone-minecraft-plugin/releases/download/v0.1.0/inkstone-minecraft-plugin.zip', '安装地址由固定版本决定')
    ok(await has('mcp/server.ts'), '摘要通过后解包出插件文件')
    ok((await readdir(paths.tempDir)).length === 0, '安装完清理临时目录')
  }

  {
    const result = await mc.installMinecraftPlugin(paths, { fetch: serve(archive), pin: { ...pinFor(archive), sha256: '0'.repeat(64) } })
    ok(!result.ok && /摘要与固定版本不一致/.test(result.error), '摘要错误时拒绝安装', result.error)
    ok((await readFile(join(paths.pluginDir, 'mcp', 'server.ts'), 'utf8')) === 'server', '摘要错误不覆盖已装文件')
    ok(result.status.installed === true, '摘要错误时已装状态保持')
  }

  {
    const result = await mc.installMinecraftPlugin(paths, { fetch: serve(archive), pin: { ...pinFor(archive), size: archive.length + 1 } })
    ok(!result.ok && /大小与固定版本不一致/.test(result.error), '包大小与固定值不一致时拒绝安装', result.error)
    ok((await readFile(join(paths.pluginDir, 'mcp', 'server.ts'), 'utf8')) === 'server', '大小不符不覆盖已装文件')
  }

  {
    const result = await mc.installMinecraftPlugin(paths, { fetch: serve(archive, 200, { 'content-length': String(archive.length + 10) }), pin: pinFor(archive) })
    ok(!result.ok && /大小与固定版本不一致/.test(result.error), '声明的长度与固定值不一致时提前拒绝', result.error)
  }

  {
    const result = await mc.installMinecraftPlugin(paths, { fetch: serve(new Uint8Array()), pin: pinFor(new Uint8Array()) })
    ok(!result.ok && /空的/.test(result.error), '空下载内容按空包拒绝', result.error)
  }

  {
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
    const result = await mc.installMinecraftPlugin(paths, { fetch: serve(archive), pin: { ...pinFor(archive), version: '9.9.9' } })
    ok(result.ok && seen.at(-1).includes('/download/v9.9.9/'), '升级固定版本时地址随固定版本变化', result.error)
    ok(JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8')).mcpServers['inkstone-minecraft'], '成功后登记 MCP 服务')
  }

  console.log(`minecraft-pinning: ${checks} assertions passed (synthetic archives, no network)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
