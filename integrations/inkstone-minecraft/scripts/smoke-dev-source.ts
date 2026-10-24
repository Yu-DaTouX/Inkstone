import { createTools, McpContext } from '../mcp/tools.ts'

const [projectDir, action = 'search', ...rest] = process.argv.slice(2)
if (!projectDir) {
  console.error('用法：node scripts/smoke-dev-source.ts <项目目录> <gen_sources|search|read> [查询或类名] [path_filter|start]')
  process.exit(2)
}
const tools = createTools(new McpContext({ runtimesDir: '', javaPaths: [], maxMemoryMb: 4096, log: (line) => console.error(line) }))
const source = tools.find((tool) => tool.name === 'mc_source')!
const args: Record<string, unknown> = { project: projectDir, action }
if (action === 'search') Object.assign(args, { query: rest[0], path_filter: rest[1], limit: 60 })
if (action === 'read') Object.assign(args, { target: rest[0], start: Number(rest[1] ?? 1), lines: Number(rest[2] ?? 200) })
const started = Date.now()
const result = await source.run(args)
for (const part of result.content) if (part.type === 'text') console.log(part.text)
console.error(`[${action}] ${Date.now() - started}ms${result.isError ? ' 失败' : ''}`)
