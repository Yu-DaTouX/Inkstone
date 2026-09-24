/**
 * pi 插件包管理（方案 §9 的 P2）。
 *
 * ── 三条边界（改动这个文件前先读）──
 *
 * 1. **不直接改生成的 pi-runtime。** 包管理只做两件事：改 pi 自己的
 *    `settings.json` 的 `packages` 数组、让 **pi 自己的 CLI** 去装/卸/更新。
 *    `resources/pi-runtime/` 是生成物（Git 忽略），手动改它会在下次
 *    `npm run upgrade:pi` 时无声消失。
 *
 * 2. **作用域跟着 pi 的目录走。** agent 目录取 `PI_AGENT_DIR`（= 传给 pi 的
 *    `PI_CODING_AGENT_DIR`），**不是**拼 `~/.pi/agent` —— 便携版与 `YAN_PI_DIR`
 *    下两者不是一个地方（同 compaction.ts 的说明）。项目作用域是 `<cwd>/.pi/settings.json`
 *    （对应 `pi install -l`）。
 *
 * 3. **扩展会执行代码。** 界面上必须说明来源与实际影响，**不宣称沙箱隔离**
 *    （方案 §9 的原话）。这里也不做任何"安全扫描"的暗示 —— 我们只如实转述
 *    `pi` 自己的输出。
 *
 * 生效时机：pi 在**启动时**加载扩展，所以装完/卸完不影响已经在跑的实例。
 * 有任务在跑时直接**拒绝**（不排队、不偷偷重启）—— 那正是方案要求的
 * "安排安全的生效时机"，代价是用户要多点一下。
 */
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PI_AGENT_DIR } from './paths'

/** 一个已登记的包在 settings.json 里的样子（`packages` 数组的元素） */
export interface PackageEntry {
  /** 原始 source 字符串，例如 `npm:pi-zh-cn` */
  source: string
  scope: 'user' | 'project'
  /** 从 source 解析出的包名（npm:pi-zh-cn → pi-zh-cn） */
  name: string
  /** node_modules 里能读到 package.json 时的元信息 */
  version: string | null
  description: string | null
  repository: string | null
  license: string | null
  /** 磁盘上真的在（settings 里登记着但没装上 = false，那是一个要显示出来的异常） */
  installed: boolean
  path: string | null
}

export interface PackageListing {
  ok: boolean
  /** pi 的 agent 目录（界面上要能告诉用户「装到哪了」） */
  agentDir: string
  /** 用户级 settings.json 路径 */
  userSettings: string
  /** 项目级 settings.json 路径 */
  projectSettings: string
  entries: PackageEntry[]
  error?: string
}

/** `npm:@scope/name` / `npm:name@1.2.3` / `git:...` / 本地路径 → 包名 */
export function packageNameOf(source: string): string {
  const raw = String(source ?? '').trim()
  if (!raw) return ''
  const body = raw.replace(/^(npm|git|https?|ssh):/, '')
  if (/^\.{1,2}[\\/]/.test(body) || /^[a-zA-Z]:[\\/]/.test(body)) {
    /* 本地路径：包名取最后一段目录名 */
    return body.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? body
  }
  if (raw.startsWith('git:') || /^https?:|^ssh:/.test(raw)) {
    /* git 源：仓库名（去掉 .git） —— 实际包名可能与目录名不同，读 package.json 时以它为准 */
    return body.replace(/\.git$/, '').split('/').pop()?.split(':').pop() ?? body
  }
  /* npm 源：去掉版本后缀；@scope/name 要保住 scope */
  const noVersion = body.replace(/@[^@/]+$/, '')
  return noVersion
}

/** 版本后缀（`npm:foo@1.2.3` → `1.2.3`）；没有就 null */
export function versionOf(source: string): string | null {
  const raw = String(source ?? '').trim()
  if (!raw.startsWith('npm:')) return null
  const m = /@([^@/]+)$/.exec(raw)
  return m ? m[1] : null
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** settings.json 里的 `packages`（空数组是正常状态，文件不存在也是） */
export function readPackageSources(settingsPath: string): string[] {
  const json = readJson<{ packages?: unknown }>(settingsPath)
  const list = json?.packages
  if (!Array.isArray(list)) return []
  return list.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

/**
 * source → 磁盘上的包目录。
 *
 * 三种形态（都是实测出来的）：
 *   · npm 源 → `<agentDir>/npm/node_modules/<name>`（pi 用 npm 装到这里）
 *   · 本地路径 → **不复制**，settings 里存的是**相对「所在 settings 文件」目录**的路径
 *     （pi 文档：Relative local paths resolve from the settings file that contains them）。
 *     用户级 settings 在 agentDir，项目级在 `<cwd>/.pi` —— 两者深度可以不同，
 *     所以调用方必须把对应 settings 目录作为 `settingsDir` 传进来，不能一律按 agentDir 解析。
 *   · git 源 → 也落在 npm/node_modules 下（按包名再兜一次）
 *
 * 读不到就如实标 `installed: false` —— 「settings 里登记着但磁盘上没有」
 * 是一个要显示给用户的异常状态，不能悄悄当成正常。
 */
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

/** 从磁盘上的 package.json 补元信息 —— 这才是「这个包到底是什么」的真源 */
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

/** 列出已登记的包（用户级 + 项目级）。只读。 */
export function listPackages(cwd: string, agentDirOverride?: string): PackageListing {
  const agentDir = agentDirOverride ?? agentDirNow()
  const userSettings = join(agentDir, 'settings.json')
  const projectSettings = join(String(cwd ?? ''), '.pi', 'settings.json')
  /* 项目级本地包的相对源由项目 .pi 目录解析（见 packageDirOf 注释）。 */
  const projectSettingsDir = join(String(cwd ?? ''), '.pi')
  try {
    const entries: PackageEntry[] = []
    for (const src of readPackageSources(userSettings)) entries.push(describePackage(agentDir, src, 'user', agentDir))
    if (cwd && existsSync(projectSettings)) {
      for (const src of readPackageSources(projectSettings)) {
        /* 同名时项目级优先显示（它就是当前会话真正生效的那份） */
        const idx = entries.findIndex((e) => e.source === src)
        const entry = describePackage(agentDir, src, 'project', projectSettingsDir)
        if (idx >= 0) entries[idx] = entry
        else entries.push(entry)
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

/* ── 写操作 ─────────────────────────────────────────────── */

export type PackageActionKind = 'install' | 'remove' | 'update'

export interface PackageActionRequest {
  kind: PackageActionKind
  /** `npm:<包名>[@版本]` / `git:...` / 本地路径 */
  source: string
  /** true = 装到当前项目（`.pi/settings.json`）；false = 用户级 */
  local?: boolean
  cwd: string
}

export interface PackageActionResult {
  ok: boolean
  /** pi 自己的输出（成功也带 —— 用户要能看到它到底做了什么） */
  output?: string
  /** 失败时的原始输出（给「展开」看） */
  detail?: string
  error?: string
  /** 执行后的列表（省一次往返，界面立刻是对的） */
  listing?: PackageListing
}

/**
 * source 的**形状**校验。
 *
 * 这里不做"安全扫描"（我们没那个能力，也不该假装有）。它挡的是**参数注入**：
 * 以 `-` 开头的东西会被 pi 的 CLI 当成选项（`--help`、`--no-approve` 之类），
 * 那等于让渲染端间接控制了命令行。
 */
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
  return null
}

export interface PackageContext {
  /** 这个目录有没有跑着的任务（装/卸会让扩展集合变化，别在有回合时动手） */
  hasRunningTask?: (cwd: string) => boolean
  /** 项目级 pi 包写入前必须已有用户明确保存的项目信任；不能靠 --approve 绕过。 */
  isProjectTrusted?: (cwd: string) => boolean | Promise<boolean>
  /**
   * pi 的 CLI 入口。**必须**由 index.ts 用 resolvePi() 解析后注入 ——
   * 用户可能用设置项 piBin 覆盖或用系统安装，这里不能自己拼内置路径，
   * 否则会出现「装到 A、跑的是 B」这种最难查的问题。
   */
  bin?: () => string | null
  /**
   * pi 的 agent 目录（默认 PI_AGENT_DIR）。
   * 可注入是为了**测试能隔离** —— 测试绝不能碰真实用户目录里的包。
   */
  agentDir?: () => string
}

/** 当前生效的 agent 目录（注入优先） */
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
    execFile(
      process.execPath,
      [bin, ...args],
      {
        cwd,
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...envOverrides,
          /* 与 Yan 启动 pi 时同一个 agent 目录 —— 否则装的是一处、跑的是另一处 */
          PI_CODING_AGENT_DIR: agentDirNow(),
          ELECTRON_RUN_AS_NODE: '1',
          GIT_TERMINAL_PROMPT: '0'
        }
      },
      (error, stdout, stderr) => {
        const out = `${String(stdout ?? '')}${String(stderr ?? '')}`.trim()
        resolve({ ok: !error, output: out })
      }
    )
  })
}

/**
 * 由接入事务调用的精确、本地、项目级 pi 包安装。
 *
 * 与普通设置页安装分开：来源必须位于传入的受管 staging 根内，manifest 身份须与
 * prepare 锁定的一致，参数由宿主构造，并且默认通过 npm 的 ignore-scripts 关闭
 * 生命周期脚本。允许脚本只能来自绑定到候选指纹 + 项目的单独授权记录。
 */
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
      /* npm lifecycle 脚本与是否加载包代码是两件事；默认禁用脚本并不构成沙箱。 */
      npm_config_ignore_scripts: request.allowLifecycleScripts ? 'false' : 'true'
    }
    /* 项目信任已由用户在 trust.json 明确保存；不使用 --approve / --no-approve 覆盖它。 */
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

/**
 * 装 / 卸 / 更新一个包。
 *
 * 顺序上先做**所有**能失败的前置检查，再动手 —— 这个函数会改用户磁盘上
 * 真实存在的包目录，没有"撤回到一半"的中间态可言。
 */
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
  /*
   * ⚠️ 卸载/更新时要先把**路径形态的 source 转成绝对路径**。
   *
   * pi 把本地路径源登记成**相对 agent 目录**的一条路径（实测装
   * \`<root>/my-ext\` 得到 \`"..\\my-ext"\`），而 \`pi remove\` 是按 **cwd** 解析
   * 这个相对路径的 —— 两者不是一个基准。界面上用户看到的就是 settings 里
   * 那条字符串，点「卸载」原样传回去必然解析错（第一次跑测试就是这么失败的：
   * 输出里有 "Removing ..\my-ext..." 却没有 "Removed"）。
   *
   * npm: / git: 这类 source 没有路径语义，保持原样。
   */
  const asArg =
    request.kind === 'install'
      ? source
      : /^\.{1,2}[\\/]/.test(source) || /^[a-zA-Z]:[\\/]/.test(source)
        ? (packageDirOf(agentDirNow(), source, local ? join(cwd, '.pi') : agentDirNow()) ?? source)
        : source
  const args =
    request.kind === 'install'
      ? ['install', asArg, ...(local ? ['-l'] : [])]
      : request.kind === 'remove'
        ? ['remove', asArg, ...(local ? ['-l'] : [])]
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

/**
 * 确保 settings.json 的 `packages` 字段存在且是数组。
 *
 * 只由**测试**使用（`pi install` 自己会写这个字段）—— 放在这里是因为
 * 「真源长什么样」这个问题只该在这个文件里回答一次。
 */
export function writePackageSourcesForTest(settingsPath: string, sources: string[]): void {
  const json = readJson<Record<string, unknown>>(settingsPath) ?? {}
  json.packages = sources
  writeFileSync(settingsPath, JSON.stringify(json, null, 2), 'utf8')
}
