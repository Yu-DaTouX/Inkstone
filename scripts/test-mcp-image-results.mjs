import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../node_modules/esbuild/lib/main.js'

let failed = 0
const ok = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failed++
    console.log(`  ✗ ${label}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-image-'))
try {
  await build({
    entryPoints: ['src/main/mcp/tool-service.ts'],
    outfile: 'out/test/mcp-image-tool.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    logLevel: 'silent'
  })
  await build({
    entryPoints: ['src/shared/mcp.ts'],
    outfile: 'out/test/mcp-image-shared.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
  await build({
    entryPoints: ['resources/pi-extensions/capability-guide.js'],
    outfile: 'out/test/mcp-image-guide.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const toolService = await import('../out/test/mcp-image-tool.mjs')
  const shared = await import('../out/test/mcp-image-shared.mjs')
  const guide = await import('../out/test/mcp-image-guide.mjs')

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const fakeManager = (result) => {
    const tools = ['Screenshot', 'Snapshot'].map((name) => ({ name, inputSchema: { type: 'object', properties: {} } }))
    return {
      listTools: async () => tools,
      listToolsCached: async () => tools,
      callTool: async () => result
    }
  }

  console.log('toolResultText 兼容')
  const plain = { content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }
  ok(shared.toolResultText(plain) === 'a\n[图片 image/png]', '不传参数：图片仍是原占位文字')
  ok(shared.classifyMcpResult(plain).text === 'a\n[图片 image/png]', 'classifyMcpResult 不传参数行为不变')
  ok(shared.toolResultText(plain, { image: (part) => `<${part.index}:${part.mimeType}>` }) === 'a\n<1:image/png>', '传回调：图片按回调替换，带下标与 mime')
  ok(shared.toolResultText({ content: [{ type: 'image', mimeType: 'image/png' }] }, { image: () => 'x' }) === '[图片 image/png]', '没有 data 的图片不走回调')

  console.log('图片落盘')
  const resultsDir = join(root, 'results')
  const outcome = await toolService.callMcpTool(
    fakeManager({ content: [{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }),
    'windows-mcp',
    'Screenshot',
    {},
    { resultsDir }
  )
  ok(Array.isArray(outcome.images) && outcome.images.length === 1, 'images 列出保存的路径')
  const file = outcome.images?.[0] ?? ''
  ok(file.startsWith(resultsDir) && file.endsWith('.png'), '文件落在 resultsDir，扩展名按 mime')
  ok(existsSync(file) && Buffer.compare(await readFile(file), png) === 0, '文件内容是解码后的原始字节')
  ok(outcome.text.includes(file) && outcome.text.includes('read 工具') && outcome.text.includes('use_vision=false'), '文字里带路径与引导')
  ok(!outcome.text.includes(png.toString('base64')), '文字里没有 base64')
  ok(outcome.bytes === Buffer.byteLength(outcome.text, 'utf8') && !outcome.resultFile, '字节数只算文字，小结果不落 .txt')

  const types = [['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif'], ['image/x-unknown', 'bin']]
  for (const [mimeType, ext] of types) ok(toolService.imageExtensionOf(mimeType) === ext, `扩展名：${mimeType} -> .${ext}`)

  const many = await toolService.callMcpTool(
    fakeManager({
      content: [
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
        { type: 'image', mimeType: 'image/jpeg', data: png.toString('base64') }
      ]
    }),
    'windows-mcp',
    'Snapshot',
    {},
    { resultsDir }
  )
  ok(many.images?.length === 2 && new Set(many.images).size === 2 && many.images[1].endsWith('.jpg'), '多张图片各自一个文件')

  const text = await toolService.callMcpTool(fakeManager({ content: [{ type: 'text', text: 'plain' }] }), 'windows-mcp', 'Snapshot', {}, { resultsDir })
  ok(text.text === 'plain' && text.images === undefined, '没有图片时不带 images 字段')

  console.log('大文字结果仍落 .txt，图片不计入')
  const big = await toolService.callMcpTool(
    fakeManager({ content: [{ type: 'text', text: 'x'.repeat(5000) }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }),
    'windows-mcp',
    'Snapshot',
    {},
    { resultsDir, maxInlineBytes: 1000 }
  )
  ok(Boolean(big.resultFile) && big.images?.length === 1 && big.bytes < 5400, '文字超限落 .txt，同时保留 images，bytes 不含 base64')

  console.log('落盘失败回退')
  const blocker = join(root, 'blocker')
  await writeFile(blocker, 'file')
  const failedOutcome = await toolService.callMcpTool(
    fakeManager({ content: [{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }),
    'windows-mcp',
    'Screenshot',
    {},
    { resultsDir: join(blocker, 'sub') }
  )
  ok(failedOutcome.images === undefined, '失败时没有 images')
  ok(failedOutcome.text.startsWith('ok\n[图片 image/png，未能保存：') && !failedOutcome.toolError, '失败时退回占位并附原因，不抛错')
  const emptyData = await toolService.callMcpTool(
    fakeManager({ content: [{ type: 'image', mimeType: 'image/png', data: '' }] }),
    'windows-mcp',
    'Screenshot',
    {},
    { resultsDir }
  )
  ok(emptyData.images === undefined && emptyData.text.includes('未能保存'), '空图片数据退回占位')

  console.log('computerUseGuide')
  const textGuide = guide.computerUseGuide({ input: ['text'] })
  const visionGuide = guide.computerUseGuide({ input: ['text', 'image'] })
  const unknownGuide = guide.computerUseGuide(undefined)
  ok(textGuide !== visionGuide, '纯文字模型与支持图片的模型文本不同')
  ok(/never call Screenshot/.test(textGuide) && /use_vision=false/.test(textGuide) && /switch to a model/.test(textGuide), '纯文字模型：只用 Snapshot，建议换模型')
  ok(!/read tool/.test(textGuide), '纯文字模型：不提 read 打开图片')
  ok(/read tool/.test(visionGuide) && /python/.test(visionGuide) && /saved as files/.test(visionGuide), '支持图片：用 read 打开保存的文件')
  ok(unknownGuide === visionGuide && guide.COMPUTER_USE_GUIDE === visionGuide, '拿不到 model 时按支持图片处理，常量保持兼容')
  ok(guide.computerUseGuide({ input: [] }) === textGuide, 'input 为空数组视为纯文字')

  console.log('扩展按 ctx.model 注入')
  const serversFile = join(root, 'mcp-servers.json')
  await writeFile(serversFile, JSON.stringify({ servers: [{ id: 'windows-mcp', enabled: true }] }))
  process.env.YAN_MCP_SERVERS_FILE = serversFile
  let hook
  guide.default({ on: (name, fn) => { if (name === 'before_agent_start') hook = fn } })
  const sectionsText = {}
  const resultText = hook({ systemPrompt: 'BASE', systemPromptOptions: { sections: sectionsText } }, { model: { input: ['text'] } })
  ok(sectionsText.inkstone_computer_use === textGuide && resultText === undefined, '纯文字模型：只写具名分区，不再改系统提示')
  const sectionsVision = {}
  const resultVision = hook({ systemPrompt: 'BASE', systemPromptOptions: { sections: sectionsVision } }, { model: { input: ['text', 'image'] } })
  ok(sectionsVision.inkstone_computer_use === visionGuide && resultVision === undefined, '支持图片的模型：分区用截图文件引导')
  const flat = hook({ systemPrompt: 'BASE' }, { model: { input: ['text'] } })
  ok(flat?.systemPrompt.startsWith('BASE') && flat.systemPrompt.includes(textGuide), '没有分区时退回拼接系统提示')
} finally {
  await rm(root, { recursive: true, force: true })
}

if (failed > 0) {
  console.log(`\n✗ ${failed} 项失败`)
  process.exit(1)
}
console.log('\n✓ MCP 图片结果测试全部通过')
