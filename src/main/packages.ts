import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PI_AGENT_DIR } from './paths'

export interface PackageEntry {
  source: string
  scope: 'user' | 'project'
  name: string
  version: string | null
  description: string | null
  repository: string | null
  license: string | null
  installed: boolean
  path: string | null
}

export interface PackageListing {
  ok: boolean
  agentDir: string
  userSettings: string
  projectSettings: string
  entries: PackageEntry[]
  error?: string
}

export function packageNameOf(source: string): string {
  const raw = String(source ?? '').trim()
  if (!raw) return ''
  const body = raw.replace(/^(npm|git|https?|ssh):/, '')
  if (/^\.{1,2}[\\/]/.test(body) || /^[a-zA-Z]:[\\/]/.test(body)) {
    return body.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? body
  }
  if (raw.startsWith('git:') || /^https?:|^ssh:/.test(raw)) {
    return body.replace(/(?:\.git)?(?:[#@][^/#@]+)?$/, '').split('/').pop()?.split(':').pop() ?? body
  }
  const noVersion = body.replace(/@[^@/]+$/, '')
  return noVersion
}

export function versionOf(source: string): string | null {
  const raw = String(source ?? '').trim()
  if (!raw.startsWith('npm:')) return null
  const m = /@([^@/]+)$/.exec(raw)
  return m ? m[1] : null
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`无法读取或解析 ${path}：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function readPackageSources(settingsPath: string): string[] {
  const json = readJson<{ packages?: unknown }>(settingsPath)
  if (json === null) return []
  const list = json?.packages
  if (!Array.isArray(list)) return []
  const valid = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._-]*)?$/i
  return list.flatMap((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) return []
    const source = entry.trim()
    const safe = source.startsWith('npm:')
      ? valid.test(source.slice(4))
      : /^(?:git:|https?:|ssh:)/.test(source)
        ? !source.slice(source.indexOf(':') + 1).startsWith('-')
        : /^(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/])/.test(source)
    if (!safe) throw new Error(`packages 中有无效来源「${source}」：${settingsPath}`)
    return [source]
  })
}

export function packageDirOf(agentDir: string, source: string, settingsDir?: string): string | null {
  const raw = String(source ?? '').trim()
  if (!raw) return null
  if (/^\.{1,2}[\\/]/.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return resolve(settingsDir ?? agentDir, raw)
  }
  const name = packageNameOf(raw)
  if (!name) return null
  return join(agentDir, 'npm', 'node_modules', ...name.split('/'))
}

export function describePackage(
  agentDir: string,
  source: string,
  scope: 'user' | 'project',
  settingsDir?: string
): PackageEntry {
  const name = packageNameOf(source)
  const dir = packageDirOf(agentDir, source, settingsDir) ?? join(agentDir, 'npm', 'node_modules', ...name.split('/'))
  const meta = readJson<{ name?: string; version?: string; description?: string; repository?: { url?: string } | string; license?: string }>(
    join(dir, 'package.json')
  )
  return {
    source,
    scope,
    name: typeof meta?.name === 'string' && meta.name ? meta.name : name,
    version: typeof meta?.version === 'string' ? meta.version : versionOf(source),
    description: typeof meta?.description === 'string' ? meta.description : null,
    repository:
      typeof meta?.repository === 'string'
        ? meta.repository
        : typeof meta?.repository?.url === 'string'
          ? meta.repository.url
          : null,
    license: typeof meta?.license === 'string' ? meta.license : null,
    installed: !!meta,
    path: meta ? dir : null
  }
}

export function listPackages(cwd: string, agentDirOverride?: string): PackageListing {
  const agentDir = agentDirOverride ?? agentDirNow()
  const userSettings = join(agentDir, 'settings.json')
  const projectSettings = join(String(cwd ?? ''), '.pi', 'settings.json')
  const projectSettingsDir = join(String(cwd ?? ''), '.pi')
  try {
    const entries: PackageEntry[] = []
    for (const src of readPackageSources(userSettings)) entries.push(describePackage(agentDir, src, 'user', agentDir))
    if (cwd && existsSync(projectSettings)) {
      for (const src of readPackageSources(projectSettings)) {
        entries.push(describePackage(agentDir, src, 'project', projectSettingsDir))
      }
    }
    return { ok: true, agentDir, userSettings, projectSettings, entries }
  } catch (error) {
    return {
      ok: false,
      agentDir,
      userSettings,
      projectSettings,
      entries: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function projectPackageDirs(cwd: string, agentDirOverride?: string): string[] {
  const agentDir = agentDirOverride ?? agentDirNow()
  if (!cwd) return []
  const settingsDir = join(cwd, '.pi')
  const seen = new Set<string>()
  const out: string[] = []
  for (const src of readPackageSources(join(settingsDir, 'settings.json'))) {
    const dir = packageDirOf(agentDir, src, settingsDir)
    if (!dir) continue
    const resolved = resolve(dir)
    if (seen.has(resolved)) continue
    const meta = readJson<{ pi?: unknown }>(join(resolved, 'package.json'))
    if (!meta || !meta.pi || typeof meta.pi !== 'object') continue
    seen.add(resolved)
    out.push(resolved)
  }
  return out
}

export type PackageActionKind = 'install' | 'remove' | 'update'

export interface PackageActionRequest {
  kind: PackageActionKind
  source: string
  local?: boolean
  cwd: string
}

export interface PackageActionResult {
  ok: boolean
  output?: string
  detail?: string
  error?: string
  listing?: PackageListing
}

export function validatePackageSource(source: string): string | null {
  const s = String(source ?? '').trim()
  if (!s) return '请填一个包名或来源'
  if (s.startsWith('-')) return '来源不能以 - 开头（那会被当成命令行选项）'
  if (/\s/.test(s)) return '来源里不能有空格'
  const ok =
    /^npm:[^\s]+$/.test(s) ||
    /^git:[^\s]+$/.test(s) ||
    /^https?:\/\/[^\s]+$/.test(s) ||
    /^ssh:\/\/[^\s]+$/.test(s) ||
    /^\.{1,2}[\\/][^\s]*$/.test(s) ||
    /^[a-zA-Z]:[\\/][^\s]*$/.test(s)
  if (!ok) return '只接受 npm: / git: / https:// / ssh:// 或本地路径'
  if (s.startsWith('ssh://')) {
    try {
      const url = new URL(s)
      if (!url.hostname || url.hostname.startsWith('-')) return 'SSH 来源必须使用有效主机名，不能以 - 开头'
    } catch {
      return 'SSH 来源 URL 无效'
    }
  }
  const body = s.replace(/^(?:npm|git|https?|ssh):/, '')
  if (body.startsWith('-')) return '来源内容不能以 - 开头（那会被当成命令行选项）'
  if (s.startsWith('npm:') && !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[^\s]+)?$/i.test(body)) {
    return 'npm 来源必须是有效的包名，可选版本号'
  }
  return null
}

export interface PackageContext {
  hasRunningTask?: (cwd: string) => boolean
  isProjectTrusted?: (cwd: string) => boolean | Promise<boolean>
  bin?: () => string | null
  agentDir?: () => string
}

function agentDirNow(): string {
  return ctx.agentDir?.() ?? PI_AGENT_DIR
}

let ctx: PackageContext = {}
export function configurePackageContext(next: PackageContext): void {
  ctx = next
}

function runPi(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {}
): Promise<{ ok: boolean; output: string }> {
  const bin = ctx.bin?.() ?? null
  if (!bin) {
    return Promise.resolve({ ok: false, output: '找不到 pi 的可执行入口（resolvePi 没解析出来）' })
  }
  return new Promise((resolve) => {
    let timedOut = false
    let settled = false
    let child: ReturnType<typeof execFile>
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill('SIGKILL'))
        killer.unref()
      } else child.kill('SIGKILL')
    }, 180_000)
    child = execFile(
      process.execPath,
      [bin, ...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...envOverrides,
          PI_CODING_AGENT_DIR: agentDirNow(),
          ELECTRON_RUN_AS_NODE: '1',
          GIT_TERMINAL_PROMPT: '0'
        }
      },
      (error, stdout, stderr) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const out = `${String(stdout ?? '')}${String(stderr ?? '')}`.trim()
        resolve({ ok: !error, output: timedOut ? `${out}${out ? '\n' : ''}操作超时；Windows 已尝试结束 pi/npm/git 进程树，仍可能有未能结束的外部进程。` : out })
      }
    )
  })
}

export async function installManagedPiPackage(request: {
  sourceDir: string
  managedRoot: string
  cwd: string
  name: string
  version: string
  allowLifecycleScripts: boolean
}): Promise<PackageActionResult> {
  const sourceDir = resolve(String(request.sourceDir ?? ''))
  const managedRoot = resolve(String(request.managedRoot ?? ''))
  const rel = relative(managedRoot, sourceDir)
  if (!isAbsolute(request.sourceDir) || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, error: '受管包路径无效（来源必须位于该事务的 staging 目录内）' }
  }
  try {
    if (lstatSync(sourceDir).isSymbolicLink() || !lstatSync(sourceDir).isDirectory()) {
      return { ok: false, error: '受管包目录必须是普通目录，拒绝符号链接' }
    }
    const realRoot = realpathSync(managedRoot)
    const realSource = realpathSync(sourceDir)
    const realRel = relative(realRoot, realSource)
    if (!realRel || realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      return { ok: false, error: '受管包目录真实路径逃出了 staging 根' }
    }
    const manifestPath = join(realSource, 'package.json')
    const manifestInfo = lstatSync(manifestPath)
    const manifest = readJson<{ name?: unknown; version?: unknown }>(manifestPath)
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || manifest?.name !== request.name || manifest.version !== request.version) {
      return { ok: false, error: 'staging 内 package.json 与已固定的包名 / 版本不一致' }
    }
    const cwd = String(request.cwd ?? '')
    if (!cwd) return { ok: false, error: '缺少当前项目目录，拒绝改为用户级安装' }
    if (ctx.hasRunningTask?.(cwd)) {
      return {
        ok: false,
        error: '这个目录仍有会话在运行，等待安全边界后再安装',
        detail: 'pi 包在启动时加载；不能在该项目任何 runner 忙碌时更改项目包配置。'
      }
    }
    if (!(await ctx.isProjectTrusted?.(cwd))) {
      return {
        ok: false,
        error: '当前项目尚未获 Pi 项目信任；请先在环境菜单中由你显式信任该目录，再重试安装',
        detail: '拒绝用 --approve 临时扩大本次命令的信任范围。Pi 安装命令只允许在 trust.json 已明确包含该项目时修改项目级包配置。'
      }
    }
    const env: Record<string, string | undefined> = {
      npm_config_ignore_scripts: request.allowLifecycleScripts ? 'false' : 'true'
    }
    const installed = await runPi(['install', realSource, '-l'], cwd, env)
    if (!installed.ok) return { ok: false, error: 'pi 项目级包安装失败', detail: installed.output }
    const listing = listPackages(cwd)
    const match = listing.entries.find(
      (entry) => entry.scope === 'project' && entry.name === request.name && entry.version === request.version && entry.installed
    )
    if (!listing.ok || !match) {
      return {
        ok: false,
        error: 'pi 返回成功，但当前项目清单未确认到固定版本的已安装包',
        detail: installed.output,
        listing
      }
    }
    return { ok: true, output: installed.output || 'ok', listing }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function runPackageAction(request: PackageActionRequest): Promise<PackageActionResult> {
  const cwd = String(request.cwd ?? '')
  const source = String(request.source ?? '').trim()
  const invalid = validatePackageSource(source)
  if (invalid) return { ok: false, error: invalid }

  if (ctx.hasRunningTask?.(cwd)) {
    return {
      ok: false,
      error: '这个目录有任务正在运行，等它跑完再改插件',
      detail: '扩展是在 pi 启动时加载的，装/卸/更新只对新开的实例生效 —— 现在动手不会有任何即时效果，还会让正在跑的回合与磁盘状态对不上'
    }
  }

  const local = request.local === true
  if (local && !cwd) return { ok: false, error: '缺少当前项目目录，拒绝改为项目级安装' }
  if (local && !(await ctx.isProjectTrusted?.(cwd))) {
    return { ok: false, error: '当前项目尚未获 Pi 项目信任；请先显式信任该目录，再重试安装' }
  }
  const asArg =
    request.kind === 'install'
      ? source
      : /^\.{1,2}[\\/]/.test(source) || /^[a-zA-Z]:[\\/]/.test(source)
        ? (packageDirOf(agentDirNow(), source, local ? join(cwd, '.pi') : agentDirNow()) ?? source)
        : source
  const args =
    request.kind === 'install'
      ? ['install', ...(local ? ['-l'] : []), asArg]
      : request.kind === 'remove'
        ? ['remove', ...(local ? ['-l'] : []), asArg]
        : ['update', asArg]

  const res = await runPi(args, cwd || process.cwd())
  if (!res.ok) {
    return {
      ok: false,
      error: `${request.kind === 'install' ? '安装' : request.kind === 'remove' ? '卸载' : '更新'}失败`,
      detail: res.output
    }
  }
  return { ok: true, output: res.output || 'ok', listing: listPackages(cwd) }
}
