#!/usr/bin/env node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { describableStdioEntry, instructionSummary, fillNativeMcpDescriptions } = await compile('src/main/mcp/native-describe.ts', { packages: 'external' })

  ok(describableStdioEntry({ command: 'codegraph', args: ['serve', '--mcp'] }, 'C:/home')?.cwd === 'C:/home', '默认 codemode 的 stdio 服务需要补描述')
  ok(describableStdioEntry({ command: 'x', toolExposure: { a: 'deferred' }, exposure: 'direct' }) !== null, '有工具走 deferred 也会进入 MCP 段落')
  ok(describableStdioEntry({ command: 'x', exposure: 'direct' }) === null, '全部 direct 的服务不进 MCP 段落，不处理')
  ok(describableStdioEntry({ command: 'x', description: 'set' }) === null && describableStdioEntry({ command: 'x', description: '' }) === null, '已有 description（包括空串）不覆盖')
  ok(describableStdioEntry({ command: 'x', enabled: false }) === null, '停用的服务不启动')
  ok(describableStdioEntry({ url: 'https://example.com/mcp' }) === null && describableStdioEntry({ type: 'http', command: 'x' }) === null, '远程服务不探测')
  ok(describableStdioEntry({ command: 'x', env: { TOKEN: '${SECRET}' } }) === null && describableStdioEntry({ command: 'x', args: ['!cmd'] }) === null && describableStdioEntry({ command: '$BIN' }) === null, '含 pi 配置模板或命令取值的条目不解析，直接跳过')
  ok(describableStdioEntry({ enabled: false }) === null && describableStdioEntry({ exposure: 'codemode' }) === null, '只有覆盖项的条目跳过')

  ok(instructionSummary('  # Codegraph — code intelligence  \nmore lines') === '# Codegraph — code intelligence', '摘要与 pi 一致：取第一行并去首尾空白')
  ok(instructionSummary(undefined) === '' && instructionSummary('\nsecond') === '', '没有说明或首行为空时不写')

  const dir = mkdtempSync(join(tmpdir(), 'yan-mcp-describe-'))
  const file = join(dir, 'mcp.json')
  writeFileSync(file, `${JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph', args: ['serve'] }, quiet: { command: 'quiet' }, broken: { command: 'broken' }, done: { command: 'done', description: 'kept' }, off: { command: 'off', enabled: false } }, other: 1 }, null, 4)}\n`)
  const probed = []
  const probe = async (config) => {
    probed.push(config.command)
    if (config.command === 'broken') throw new Error('spawn failed')
    return config.command === 'codegraph' ? '# Codegraph — graph\nUse explore first.' : undefined
  }
  const filled = await fillNativeMcpDescriptions(file, probe)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  ok(filled.join() === 'codegraph' && after.mcpServers.codegraph.description === '# Codegraph — graph', '连上后把说明首行写成 description')
  ok(probed.sort().join() === 'broken,codegraph,quiet', '只探测缺描述且启用的服务；单个失败不影响其他')
  ok(after.mcpServers.done.description === 'kept' && after.mcpServers.off.enabled === false && after.other === 1 && after.mcpServers.codegraph.args[0] === 'serve', '其他字段原样保留')
  ok(readFileSync(file, 'utf8').startsWith('{\n    "mcpServers"'), '保留原文件缩进')
  const before = readFileSync(file, 'utf8')
  ok((await fillNativeMcpDescriptions(file, probe)).length === 0 && readFileSync(file, 'utf8') === before, '再次运行不改文件')
  ok((await fillNativeMcpDescriptions(join(dir, 'missing.json'), probe)).length === 0, '没有配置文件时什么也不做')

  writeFileSync(file, `${JSON.stringify({ mcpServers: { slow: { command: 'slow' } } })}\n`)
  let threw = false
  await fillNativeMcpDescriptions(file, async () => {
    writeFileSync(file, `${JSON.stringify({ mcpServers: { slow: { command: 'slow' }, added: { command: 'y' } } })}\n`)
    return 'Slow server'
  }).catch(() => { threw = true })
  ok(threw && JSON.parse(readFileSync(file, 'utf8')).mcpServers.added && !JSON.parse(readFileSync(file, 'utf8')).mcpServers.slow.description, '探测期间文件被外部改动时拒绝写入，不覆盖别人的修改')
})
