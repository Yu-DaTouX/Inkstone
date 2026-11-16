import './lib/test-isolate.mjs'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { runSuite } from './lib/test-suite.mjs'

function storedZip(files) {
  const locals = []
  const directory = []
  let offset = 0
  for (const [name, body] of files) {
    const data = Buffer.from(body)
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(offset, 42)
    directory.push(header, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

await runSuite(import.meta.url, async (ok) => {
  const root = mkdtempSync(join(tmpdir(), 'yan-voice-input-'))
  const previousRoot = process.env.INKSTONE_DATA_ROOT
  process.env.INKSTONE_DATA_ROOT = root
  const server = createServer((req, res) => {
    const body = Buffer.from('not a real ggml model, same length is enough')
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  try {
    const engine = await import(pathToFileURL(join(process.cwd(), 'integrations', 'voice-input', 'engine.mjs')).href)
    const catalog = await import(pathToFileURL(join(process.cwd(), 'integrations', 'voice-input', 'catalog.mjs')).href)
    const voiceDir = join(root, 'voice')
    const binDir = join(voiceDir, 'bin')

    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'whisper-cli.exe'), 'old')
    for (const version of ['v1', 'v2']) {
      const zipPath = join(voiceDir, `whisper-${version}.zip`)
      writeFileSync(zipPath, storedZip([['Release/whisper-cli.exe', version], ['Release/whisper.dll', `${version}-dll`]]))
      await engine.installBinaryZip(zipPath)
      rmSync(zipPath, { force: true })
    }
    const leftovers = readdirSync(voiceDir).filter((name) => name.startsWith('bin-'))
    ok(readFileSync(join(binDir, 'whisper-cli.exe'), 'utf8') === 'v2', '转写程序更新后 bin 里是新程序')
    ok(leftovers.length === 0, '转写程序更新成功后不留下旧程序目录', JSON.stringify(leftovers))

    ok(catalog.VOICE_MODELS.every((spec) => /^[0-9a-f]{64}$/.test(spec.sha256 ?? '')), '每个语音模型都固定了 SHA-256', JSON.stringify(catalog.VOICE_MODELS.map((spec) => [spec.id, spec.sha256])))
    ok(/\/resolve\/[0-9a-f]{40}\/$/.test(catalog.VOICE_MODEL_BASE_URL), '模型下载地址固定到与哈希对应的仓库提交', catalog.VOICE_MODEL_BASE_URL)

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/ggml-base.bin`
    const spec = catalog.voiceModelSpec('base')
    const destination = join(voiceDir, 'models', spec.file)
    const service = new engine.VoiceService(async () => ({}))
    const bytes = Buffer.byteLength('not a real ggml model, same length is enough')
    const plan = { planId: 'fixture', target: { kind: 'model', id: 'base' }, label: spec.file, url, bytes, sizeKnown: true, destination }
    service.progress = { planId: 'fixture', label: spec.file, received: 0, total: bytes, state: 'running' }
    await service.runDownload(plan, undefined, new AbortController().signal)
    ok(service.progress.state === 'failed' && /SHA-256/.test(service.progress.error ?? ''), '大小对但内容不符的模型下载判为失败', JSON.stringify(service.progress))
    ok(!existsSync(destination) && !existsSync(`${destination}.part`), '校验失败的模型不落成正式文件，临时文件也删掉')
  } finally {
    server.close()
    if (previousRoot === undefined) delete process.env.INKSTONE_DATA_ROOT
    else process.env.INKSTONE_DATA_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
