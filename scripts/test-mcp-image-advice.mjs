import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail === undefined ? '' : `: ${detail}`}`)
  checks++
}

const built = await build({
  entryPoints: ['src/main/mcp/tool-service.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  logLevel: 'silent'
})
const toolService = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-image-advice-'))
try {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const result = { content: [{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }
  const manager = (tools, failList = false) => ({
    listTools: async () => tools,
    listToolsCached: async () => {
      if (failList) throw new Error('list unavailable')
      return tools
    },
    callTool: async () => result
  })
  const tool = (name) => ({ name, inputSchema: { type: 'object', properties: {} } })

  {
    const outcome = await toolService.callMcpTool(manager([tool('take_picture'), tool('Snapshot')]), 'other-mcp', 'take_picture', {}, { resultsDir: join(root, 'a') })
    const file = outcome.images?.[0] ?? ''
    ok(Boolean(file), '其他服务的图片同样保存')
    ok(outcome.text.includes(file) && outcome.text.includes('read tool'), '通用建议带保存路径与 read tool', outcome.text)
    ok(!/Snapshot|use_vision/.test(outcome.text), '其他服务不出现 windows-mcp 专属建议', outcome.text)
  }

  {
    const outcome = await toolService.callMcpTool(manager([tool('Screenshot')]), 'windows-mcp', 'Screenshot', {}, { resultsDir: join(root, 'b') })
    ok(outcome.text.includes('read tool') && !/Snapshot|use_vision/.test(outcome.text), 'windows-mcp 但没有 Snapshot 能力时不出现专属建议', outcome.text)
  }

  {
    const outcome = await toolService.callMcpTool(manager([tool('Screenshot'), tool('Snapshot')]), 'windows-mcp', 'Screenshot', {}, { resultsDir: join(root, 'c') })
    ok(outcome.text.includes('read tool'), 'windows-mcp 图片仍给通用读取方式', outcome.text)
    ok(/Snapshot \(use_vision=false\)/.test(outcome.text), 'windows-mcp 且存在 Snapshot 时才给专属建议', outcome.text)
  }

  {
    let listCalls = 0
    const flaky = {
      listTools: async () => [tool('Screenshot')],
      listToolsCached: async () => {
        listCalls++
        if (listCalls === 1) return [tool('Screenshot')]
        throw new Error('list unavailable')
      },
      callTool: async () => result
    }
    const outcome = await toolService.callMcpTool(flaky, 'windows-mcp', 'Screenshot', {}, { resultsDir: join(root, 'd') })
    ok(Boolean(outcome.images?.[0]) && !/use_vision/.test(outcome.text), '列工具失败时退回通用建议且不影响图片保存', outcome.text)
  }

  console.log(`mcp-image-advice: ${checks} assertions passed (fake manager, temp results)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
