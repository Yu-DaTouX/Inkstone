import { glob, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PiRpc, resolvePi } from '../protocol'
import { stagingDirOf, type AcquisitionService } from './acquisition-service'
import type { PiPackageCheck } from './pi-package-scheduler'

type JsonObject = Record<string, unknown>

export type PiPackageSmokeResources = {
  extensions: string[]
  skills: string[]
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function safePackagePath(packageRoot: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('pi 包资源路径必须是非空字符串')
  const entry = value.trim()
  if (isAbsolute(entry) || /^[a-zA-Z]:/.test(entry) || /^!/.test(entry) || /[*?{}\[\]]/.test(entry)) {
    throw new Error(`pi 包资源路径不是普通相对路径：${entry}`)
  }
  const full = resolve(packageRoot, entry)
  if (!within(packageRoot, full)) throw new Error(`pi 包资源路径越界：${entry}`)
  return full
}

function safePackagePattern(packageRoot: string, value: unknown): { pattern: string; exclude: boolean } {
  if (typeof value !== 'string' || !value.trim()) throw new Error('pi 包资源路径必须是非空字符串')
  const raw = value.trim()
  const exclude = raw.startsWith('!')
  const pattern = (exclude ? raw.slice(1) : raw).replace(/^\.\//, '')
  if (!pattern || isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.includes('\0') ||
      pattern.split(/[\\/{},]/).includes('..')) {
    throw new Error(`pi 包资源 glob 越界或无效：${value}`)
  }
  const staticPrefix = pattern.split(/[*?{[\]]/, 1)[0] ?? ''
  if (staticPrefix) {
    const prefixPath = resolve(packageRoot, staticPrefix)
    if (!within(packageRoot, prefixPath)) throw new Error(`pi 包资源 glob 越界：${value}`)
  }
  return { pattern, exclude }
}

async function expandPackagePaths(packageRoot: string, values: unknown[]): Promise<string[]> {
  const included = new Set<string>()
  const excluded = new Set<string>()
  for (const value of values) {
    const { pattern, exclude } = safePackagePattern(packageRoot, value)
    const hasMagic = /[*?{}\[\]]/.test(pattern)
    const matches: string[] = []
    if (hasMagic) {
      for await (const match of glob(pattern, { cwd: packageRoot })) {
        matches.push(resolve(packageRoot, match))
        if (matches.length > 2048) throw new Error('pi 包资源 glob 命中超过 2048 项，拒绝冒烟')
      }
      matches.sort(lexical)
    } else {
      const path = safePackagePath(packageRoot, pattern)
      if (!exclude) {
        matches.push(path)
      } else {
        try {
          await lstat(path)
          matches.push(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    for (const path of matches) {
      if (!within(packageRoot, path)) throw new Error(`pi 包资源 glob 越界：${value}`)
      if (exclude) excluded.add(resolve(path))
      else included.add(resolve(path))
    }
  }
  const excludedPaths = new Set(excluded)
  return [...included].filter((path) => {
    let current = resolve(path)
    for (;;) {
      if (excludedPaths.has(current)) return false
      if (current === resolve(packageRoot)) return true
      const parent = dirname(current)
      if (parent === current || !within(packageRoot, parent)) return true
      current = parent
    }
  }).sort(lexical)
}

async function rejectSymlinkPath(root: string, path: string): Promise<void> {
  const rel = relative(resolve(root), resolve(path))
  let current = resolve(root)
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`pi 包资源包含符号链接：${part}`)
  }
}

async function extensionFiles(packageRoot: string, entry: string): Promise<string[]> {
  await rejectSymlinkPath(packageRoot, entry)
  const info = await lstat(entry)
  if (info.isFile()) {
    if (!['.js', '.mjs', '.cjs', '.ts'].includes(extname(entry).toLowerCase())) {
      throw new Error(`扩展文件类型尚不支持：${extname(entry) || '(无扩展名)'}`)
    }
    return [entry]
  }
  if (!info.isDirectory()) throw new Error('扩展资源必须是普通文件或目录')

  const found: string[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error('扩展目录层级超过 8 层')
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => lexical(a.name, b.name))
    for (const item of entries) {
      if (item.name === 'node_modules' || item.name.startsWith('.')) continue
      const path = join(dir, item.name)
      if (item.isSymbolicLink()) throw new Error(`扩展目录包含符号链接：${item.name}`)
      if (item.isDirectory()) {
        await visit(path, depth + 1)
      } else if (item.isFile() && ['.js', '.mjs', '.cjs', '.ts'].includes(extname(item.name).toLowerCase())) {
        found.push(path)
        if (found.length > 256) throw new Error('扩展文件超过 256 个，暂不自动冒烟')
      }
    }
  }
  await visit(entry, 0)
  if (found.length === 0) throw new Error('扩展目录中没有可加载的 JavaScript 文件')
  return found
}

/** Expand the package's in-root Pi resource paths/globs before running the offline smoke. */
export async function resolvePiPackageSmokeResources(
  packageRoot: string,
  manifest: unknown
): Promise<PiPackageSmokeResources> {
  const pkg = object(manifest)
  const pi = object(pkg?.pi)
  if (!pkg) throw new Error('package.json 格式无效')

  const bundled = new Set<string>()
  for (const value of [pkg.bundledDependencies, pkg.bundleDependencies]) {
    if (Array.isArray(value)) for (const name of value) if (typeof name === 'string') bundled.add(name)
    if (value === true && object(pkg.dependencies)) {
      for (const name of Object.keys(object(pkg.dependencies)!)) bundled.add(name)
    }
  }
  const dependencies = object(pkg.dependencies) ?? {}
  for (const name of Object.keys(dependencies)) {
    if (!bundled.has(name)) throw new Error(`依赖 ${name} 未声明为随包提供；当前版本不运行候选安装来补依赖`)
    const dependencyPath = resolve(packageRoot, 'node_modules', ...name.split('/'))
    if (!within(packageRoot, dependencyPath)) throw new Error(`依赖路径越界：${name}`)
    await rejectSymlinkPath(packageRoot, dependencyPath)
    const dependencyInfo = await lstat(dependencyPath).catch(() => null)
    if (!dependencyInfo?.isDirectory()) throw new Error(`随包依赖 ${name} 不存在或不是普通目录`)
  }

  const rawExtensions = pi
    ? (pi.extensions ?? [])
    : (await lstat(join(packageRoot, 'extensions')).then(() => ['extensions']).catch(() => []))
  const rawSkills = pi
    ? (pi.skills ?? [])
    : (await lstat(join(packageRoot, 'skills')).then(() => ['skills']).catch(() => []))
  if (!Array.isArray(rawExtensions) || !Array.isArray(rawSkills)) {
    throw new Error('pi.extensions 与 pi.skills 必须是字符串路径数组')
  }
  const extensionEntries = await expandPackagePaths(packageRoot, rawExtensions)
  const skills = await expandPackagePaths(packageRoot, rawSkills)
  if (extensionEntries.length > 256 || skills.length > 256) {
    throw new Error('Pi 包资源入口超过 256 项，拒绝冒烟')
  }
  if (extensionEntries.length === 0 && skills.length === 0) {
    throw new Error('package.json 没有声明可验证的 pi.extensions 或 pi.skills')
  }

  const extensions = [...new Set((await Promise.all(extensionEntries.map((entry) => extensionFiles(packageRoot, entry)))).flat())]
  if (extensions.length > 256) throw new Error('扩展文件超过 256 个，暂不自动冒烟')
  for (const skill of skills) {
    await rejectSymlinkPath(packageRoot, skill)
    const info = await lstat(skill)
    if (!info.isFile() && !info.isDirectory()) throw new Error('Skill 资源必须是普通文件或目录')
  }
  return { extensions, skills }
}

function smokeEnvironment(agentDir: string, dataDir: string, marker: string): NodeJS.ProcessEnv {
  const allow = [
    'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'PROGRAMDATA', 'ComSpec', 'PATHEXT'
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of allow) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return {
    ...env,
    PI_CODING_AGENT_DIR: agentDir,
    YAN_DATA_DIR: dataDir,
    YAN_SMOKE_MARKER: marker,
    PI_OFFLINE: '1'
  }
}

async function waitForMarker(marker: string, errors: string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (errors.length) return false
    try {
      await lstat(marker)
      return true
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25))
    }
  }
  return false
}

/**
 * Start exact staged resources with a credential-clean, offline, no-session Pi.
 * This is process isolation only; candidate code still runs with the desktop user's OS permissions.
 */
export async function smokeStagedPiPackage(input: {
  root: string
  operationId: string
  piBin?: string
  timeoutMs?: number
}): Promise<PiPackageCheck> {
  const packageRoot = join(stagingDirOf(input.root, input.operationId), 'payload', 'package')
  let rpc: PiRpc | null = null
  let tempRoot = ''
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as unknown
    const resources = await resolvePiPackageSmokeResources(packageRoot, manifest)
    const probe = resolvePi(input.piBin ? { override: input.piBin } : {})
    const piBin = probe.args.at(-1)
    if (!probe.ok || !piBin) throw new Error(probe.error ?? 'Pi 可执行入口不可用')

    tempRoot = await mkdtemp(join(tmpdir(), 'yan-pi-package-smoke-'))
    const cwd = join(tempRoot, 'workspace')
    const agentDir = join(tempRoot, 'pi-agent')
    const dataDir = join(tempRoot, 'yan-data')
    const marker = join(tempRoot, 'session-start.marker')
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(dataDir)])
    const sentinel = join(tempRoot, 'sentinel.mjs')
    await writeFile(sentinel, [
      "import { writeFileSync } from 'node:fs';",
      'export default function (pi) {',
      "  pi.on('session_start', () => writeFileSync(process.env.YAN_SMOKE_MARKER, 'started'));",
      '};',
      ''
    ].join('\n'), 'utf8')

    const args = [
      '--no-session', '--offline', '--no-tools', '--no-context-files', '--no-extensions', '--no-skills',
      ...resources.extensions.flatMap((path) => ['--extension', path]),
      ...resources.skills.flatMap((path) => ['--skill', path]),
      '--extension', sentinel
    ]
    const failures: string[] = []
    rpc = new PiRpc({ cwd, piBin, args, env: smokeEnvironment(agentDir, dataDir, marker), inheritEnv: false })
    rpc.on('event', (event: Record<string, unknown>) => {
      if (event.type === 'extension_error') failures.push('Pi 报告扩展加载错误')
    })
    rpc.on('stderr', () => {
      /* Candidate stderr may contain arbitrary content; do not copy it into user-facing diagnostics. */
    })
    rpc.spawn()
    const commands = await rpc.command<{ commands?: unknown[] }>('get_commands', {}, { timeoutMs: input.timeoutMs ?? 20_000 })
    if (!commands.success) throw new Error('Pi RPC 未能完成 get_commands 握手')
    if (!(await waitForMarker(marker, failures, input.timeoutMs ?? 20_000))) {
      throw new Error(failures.length ? failures[0] : '临时 Pi 未触发 session_start 冒烟哨兵')
    }
    if (failures.length) throw new Error(failures[0])
    return { ok: true, problems: [] }
  } catch (error) {
    return {
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)]
    }
  } finally {
    if (rpc) await rpc.close().catch(() => undefined)
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/** Adapter for the scheduler, kept free of any candidate-specific test behavior. */
export function stagedPiPackageSmokePort(input: {
  root: string
  piBin?: string
  service: AcquisitionService
}): (tx: { operationId: string }) => Promise<PiPackageCheck> {
  return async (tx) => {
    const staged = await input.service.verifyStaged(tx.operationId)
    if (!staged.ok) return { ok: false, problems: staged.problems }
    return smokeStagedPiPackage({
      root: input.root,
      operationId: tx.operationId,
      ...(input.piBin ? { piBin: input.piBin } : {})
    })
  }
}
