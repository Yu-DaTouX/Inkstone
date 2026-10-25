import type { CodegraphStatus, MarketSearchResult, PluginExportResult } from '../shared/plugin-market'
import { buildNativeMcpDocument } from '../shared/mcp-native-import'
import { execFile, spawn } from 'node:child_process'
import { killProcessTree } from './git-service'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const CODEGRAPH_MCP_NAME = 'codegraph'
export const CODEGRAPH_MCP_SERVER = { command: 'codegraph', args: ['serve', '--mcp'] }
export const CODEGRAPH_INSTALL = 'npm i -g @colbymchenry/codegraph'

export function commandOnPath(command: string): Promise<boolean> {
  return new Promise(done => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [command], { windowsHide: true, timeout: 5000 },
      error => done(!error))
  })
}

export async function addCodegraphMcp(agentDir: string, installed: (command: string) => Promise<boolean> = commandOnPath): Promise<PluginExportResult> {
  if (!await installed(CODEGRAPH_MCP_SERVER.command)) return { ok: false, error: `没有找到 codegraph 命令，先运行 ${CODEGRAPH_INSTALL}` }
  const path = join(agentDir, 'mcp.json')
  let text: string | null = null
  try { text = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: String(error) } }
  let existing: unknown
  if (text !== null) {
    try { existing = JSON.parse(text) }
    catch { return { ok: false, error: `${path} 不是合法 JSON，未改动` } }
  }
  const merged = buildNativeMcpDocument({ existing, name: CODEGRAPH_MCP_NAME, server: { ...CODEGRAPH_MCP_SERVER, args: [...CODEGRAPH_MCP_SERVER.args] } })
  if (!merged.ok) return merged.code === 'name_conflict' ? { ok: true, path, existed: true } : { ok: false, error: merged.reason }
  await mkdir(agentDir, { recursive: true })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(merged.document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, path }
}

export async function codegraphStatus(
  agentDir: string,
  cwd: string,
  installed: (command: string) => Promise<boolean> = commandOnPath
): Promise<CodegraphStatus> {
  let configured = false
  try {
    const root = JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, { enabled?: unknown } | undefined> }
    const entry = root?.mcpServers?.[CODEGRAPH_MCP_NAME]
    configured = Boolean(entry) && entry?.enabled !== false
  } catch {
  }
  const project = cwd.trim() ? resolve(cwd) : ''
  return {
    cliInstalled: await installed(CODEGRAPH_MCP_SERVER.command),
    configured,
    ...(project ? { cwd: project, indexed: await stat(join(project, '.codegraph')).then((s) => s.isDirectory(), () => false) } : {})
  }
}

export async function indexCodegraphProject(cwd: string): Promise<{ ok: boolean; error?: string; log?: string }> {
  const project = cwd.trim() ? resolve(cwd) : ''
  if (!project || !(await stat(project).then((s) => s.isDirectory(), () => false))) return { ok: false, error: '项目目录不存在' }
  if (!await commandOnPath(CODEGRAPH_MCP_SERVER.command)) return { ok: false, error: `没有找到 codegraph 命令，先运行 ${CODEGRAPH_INSTALL}` }
  return new Promise((done) => {
    let log = ''
    const keep = (chunk: Buffer): void => { log = (log + chunk.toString('utf8')).slice(-4000) }
    const child = spawn(CODEGRAPH_MCP_SERVER.command, ['init', '--yes', '.'], {
      cwd: project,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' }
    })
    const timer = setTimeout(() => killProcessTree(child), 15 * 60_000)
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (error) => { clearTimeout(timer); done({ ok: false, error: error.message, log }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tail = log.trim().split('\n').slice(-8).join('\n')
      done(code === 0 ? { ok: true, log: tail } : { ok: false, error: `codegraph init 退出码 ${code ?? '?'}`, log: tail })
    })
  })
}

export const HERMES_PLUGIN_FILES = ['plugin.yaml', '__init__.py', 'client.py', 'approvals.py', 'connect.py']

export async function exportHermesPlugin(source: string, parent: string): Promise<string> {
  const target = join(parent, 'inkstone')
  try { await mkdir(target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标目录已有 inkstone，请选择其他目录，避免覆盖现有插件')
    throw error
  }
  try {
    for (const file of HERMES_PLUGIN_FILES) await copyFile(join(source, file), join(target, file))
    return target
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function httpsLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined
  try {
    const url = new URL(value.replace(/^git\+/, '').replace(/\.git$/, ''))
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

const cache = new Map<string, { expires: number; result: MarketSearchResult }>()
const NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/

export async function searchPiPackages(query: string, offset = 0, request: typeof fetch = fetch): Promise<MarketSearchResult> {
  const text = query.trim().slice(0, 100)
  const from = Math.max(0, Math.min(10000, Math.floor(offset)))
  const key = `${text}:${from}`
  const hit = cache.get(key)
  if (request === fetch && hit && hit.expires > Date.now()) return hit.result
  try {
    const url = new URL('https://registry.npmjs.org/-/v1/search')
    url.searchParams.set('text', `keywords:pi-package ${text}`)
    url.searchParams.set('size', '24')
    url.searchParams.set('from', String(from))
    const response = await request(url, { signal: AbortSignal.timeout(12000), redirect: 'error' })
    if (!response.ok) throw new Error(`npm HTTP ${response.status}`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty catalog response')
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Catalog response too large') }
      chunks.push(value)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!Array.isArray(body.objects) || !Number.isFinite(body.total)) throw new Error('Invalid catalog response')
    const entries = body.objects.slice(0, 24).flatMap((item: { package?: Record<string, unknown> }) => {
      const pkg = item?.package
      if (!pkg || typeof pkg.name !== 'string' || !NAME.test(pkg.name) || pkg.name.length > 214 ||
          !Array.isArray(pkg.keywords) || !pkg.keywords.includes('pi-package')) return []
      const publisher = pkg.publisher as { username?: unknown } | undefined
      const links = (pkg.links ?? {}) as { homepage?: unknown; repository?: unknown }
      const homepage = httpsLink(links.repository) ?? httpsLink(links.homepage)
      return [{ name: pkg.name, source: `npm:${pkg.name}`, version: String(pkg.version ?? '').slice(0, 80),
        description: String(pkg.description ?? '').slice(0, 1000), publisher: String(publisher?.username ?? '').slice(0, 100),
        npmUrl: `https://www.npmjs.com/package/${pkg.name}`, ...(homepage ? { homepage } : {}) }]
    })
    const result = { ok: true, entries, total: Math.max(0, body.total) }
    if (request === fetch) {
      if (cache.size >= 20) cache.delete(cache.keys().next().value!)
      cache.set(key, { result, expires: Date.now() + 300000 })
    }
    return result
  } catch (error) {
    return { ok: false, entries: [], total: 0, error: error instanceof Error ? error.message : String(error) }
  }
}
