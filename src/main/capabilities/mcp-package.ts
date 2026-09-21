/**
 * 受管 npm MCP 包（实施-04 S6b-2）。
 *
 * MCP 包不需要安装成 pi 扩展：固定 npm 制品先进入 operation 专属 staging，
 * 只接受 package.json 的普通 bin 入口，用可信 Node 可执行文件启动，再由宿主
 * 通过同一套 MCP SDK 做 `tools/list` 冒烟。通过后登记项目范围的 stdio 配置；
 * 未随 tarball 提供的依赖、入口不明确或包含链接的包一律 fail-closed。
 */
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mcpServerIdOf } from '../../shared/mcp-registration'
import type { McpServerConfig, McpToolDescriptor } from '../../shared/mcp'
import { McpConnectionManager } from '../mcp/connection-manager'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function within(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child))
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function safeEntry(root: string, raw: string): string {
  const value = raw.trim().replace(/^[.][\\/]/, '')
  if (!value || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`MCP 包 bin 入口不是安全的相对路径：${raw}`)
  }
  const parts = value.split(/[\\/]/)
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`MCP 包 bin 入口不能穿越目录：${raw}`)
  }
  const entry = resolve(root, value)
  if (!within(root, entry)) throw new Error(`MCP 包 bin 入口逃出包目录：${raw}`)
  return entry
}

function binEntryOf(manifest: JsonObject, packageName: string): string {
  const bin = manifest.bin
  if (typeof bin === 'string') return bin
  const map = object(bin)
  if (map) {
    const preferred = map[packageName]
    if (typeof preferred === 'string') return preferred
    const shortName = packageName.split('/').at(-1) ?? packageName
    if (typeof map[shortName] === 'string') return map[shortName] as string
    const entries = Object.keys(map).filter((key) => typeof map[key] === 'string')
    if (entries.length === 1) return map[entries[0]] as string
    if (entries.length > 1) {
      throw new Error('MCP npm 包有多个 bin 入口且没有 package-name 入口；不会猜测要启动哪一个')
    }
  }
  throw new Error('MCP npm 包没有明确的 bin 入口；不会猜测 main 或执行任意字段')
}

export type ResolvedMcpPackage = {
  config: McpServerConfig
  packageRoot: string
  packageName: string
  packageVersion: string
  entryPath: string
}

/** 从已核验 staging 的 package.json 解析唯一、可复核的 Node stdio 入口。 */
export async function resolveMcpPackage(input: {
  packageRoot: string
  candidateId: string
  title: string
  expectedName: string
  expectedVersion: string
}): Promise<ResolvedMcpPackage> {
  const packageRoot = resolve(input.packageRoot)
  const manifest = object(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')))
  if (!manifest) throw new Error('MCP 包 package.json 不是对象')
  if (manifest.name !== input.expectedName || manifest.version !== input.expectedVersion) {
    throw new Error('MCP 包 package.json 的名称或版本与 prepare 固定值不一致')
  }
  const packageName = manifest.name as string
  const packageVersion = manifest.version as string
  const entryPath = safeEntry(packageRoot, binEntryOf(manifest, packageName))
  const entryInfo = await lstat(entryPath)
  if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new Error('MCP 包 bin 入口不是普通文件')
  const serverId = mcpServerIdOf(input.candidateId, `stdio://${packageName}@${packageVersion}`)
  return {
    packageRoot,
    packageName,
    packageVersion,
    entryPath,
    config: {
      id: serverId,
      title: input.title,
      transport: 'stdio',
      command: process.execPath,
      args: [entryPath],
      effect: 'unknown',
      enabled: true
    }
  }
}

/** 只执行无副作用的握手与工具枚举，不调用任何业务工具。 */
export async function smokeMcpPackage(input: {
  config: McpServerConfig
  timeoutMs?: number
}): Promise<{ ok: boolean; tools: McpToolDescriptor[]; problems: string[] }> {
  const manager = new McpConnectionManager([input.config], input.timeoutMs ?? 20_000)
  try {
    const tools = await manager.listTools(input.config.id)
    return { ok: true, tools, problems: [] }
  } catch (error) {
    return {
      ok: false,
      tools: [],
      problems: [error instanceof Error ? error.message : String(error)]
    }
  } finally {
    await manager.close().catch(() => undefined)
  }
}
