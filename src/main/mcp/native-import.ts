/**
 * 旧宿主 MCP 导入 pi 原生的落地实现。
 *
 * prepare 只读预览并发放绑定调用者身份的短效令牌；commit 在串行锁内核对令牌/
 * 身份/宿主后写原生、校验，再停用旧条目。每一步失败都如实回报（含 nativeWritten:true
 * 的部分结果），不自动回滚、不重启 runner、不主动连接真实服务。
 *
 * 安全边界：旧配置与目标文件都当作可被外部改动的输入，写入前后用 SHA256 指纹核对；
 * 校验只针对本次已确认写入的那一条内容。校验由宿主注入；缺省时不会停用旧条目，
 * 结果标注 `verification: 'unavailable'`，不假装通过。
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpMigratedToNativeMark } from '../../shared/mcp'
import type {
  NativeMcpImportCommitResult,
  NativeMcpImportPreview,
  NativeMcpImportVerification,
  NativeMcpImportVerifyInput,
  NativeMcpImportVerifyResult
} from '../../shared/mcp-native-import'
import {
  applyMigratedMark,
  buildNativeMcpDocument,
  convertMcpServerToNative,
  migratedMcpCommandNotice,
  nativeMcpServerName,
  WINDOWS_MCP_SERVER_ID
} from '../../shared/mcp-native-import'
import { mcpServersFile, parseMcpServersDocument } from './config'
import { serializedWrite } from './write-queue'

export class NativeMcpImportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NativeMcpImportError'
  }
}

/**
 * 提交前后的运行实例身份。`prepare` 时冻结，`commit` 前重新取一份比对：
 * runner、generation、项目目录或项目身份任一变化都视为换了实例，令牌作废。
 */
export interface NativeMcpImportRuntimeIdentity {
  runnerId: string
  generation: number
  cwd: string
  projectId: string | null
}

export function sameNativeMcpImportRuntime(
  before: NativeMcpImportRuntimeIdentity,
  after: NativeMcpImportRuntimeIdentity
): boolean {
  return (
    before.runnerId === after.runnerId &&
    before.generation === after.generation &&
    before.cwd === after.cwd &&
    before.projectId === after.projectId
  )
}

/** 同时待确认的导入上限：防止反复 preview 只生成令牌而不确认。 */
const MAX_PENDING_IMPORTS = 32

/** 受信项目登记：`projectId → cwd` 只由宿主提供，不按目录反推，也不接受模型指定目录。 */
export interface NativeMcpImportProject {
  id: string
  cwd: string
}

/** 调用者身份：主会话从受信 runner / 宿主上下文传入，模型不能自报。 */
export interface NativeMcpImportOwner {
  id: string
  label?: string
}

export interface NativeMcpImportHost {
  /** pi 的 agent 目录（`PI_AGENT_DIR`）：全局 `mcp.json` 落在这里。 */
  agentDir: string
  /** 旧砚 MCP 配置路径；缺省用 `YAN_MCP_SERVERS_FILE` / `YAN_DIR/mcp-servers.json`。 */
  hostConfigFile?: string
  /** 受信项目登记。 */
  projects: readonly NativeMcpImportProject[]
  /**
   * 写入原生配置后的校验回调（主会话接真实 `pi mcp list --json`，见 native-verify.ts）。
   * 缺省表示尚未接线：本次不会停用旧条目，结果里如实标注 `verification: 'unavailable'`。
   */
  verify?: (input: NativeMcpImportVerifyInput) => Promise<NativeMcpImportVerifyResult>
  /**
   * 落盘实现（默认排他临时文件 + fsync + rename 前指纹核对）；测试可注入故障或记录。
   * `expectedFingerprint` 是写入前目标文件的指纹，调用方实现相符核对可收窄外部竞争窗口。
   */
  writeText?: (path: string, text: string, expectedFingerprint?: string) => Promise<void>
  now?: () => number
  generateToken?: () => string
  tokenTtlMs?: number
}


interface PendingImport {
  ownerId: string
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  projectId?: string
  projectCwd?: string
  targetPath: string
  hostConfigFile: string
  agentDir: string
  content: string
  warnings: string[]
  requiresReauth: boolean
  sourceFingerprint: string
  targetFingerprint: string
  expiresAt: number
}

const pendingImports = new Map<string, PendingImport>()

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hostConfigPathOf(host: NativeMcpImportHost): string {
  return host.hostConfigFile ?? mcpServersFile()
}

/** 目标文本的不可变指纹（null 表示文件不存在）；commit 与 verifier 共用同一算法。 */
export function nativeMcpTextFingerprint(text: string | null): string {
  return createHash('sha256').update(text === null ? '\u0000absent' : text).digest('hex')
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 排他临时文件 + fsync + rename：中途失败不会留下半份 JSON。
 *
 * 失败时**连自己的临时文件一起清掉**（write / fsync / close / rename 任一步失败都算）。
 * 传入 `expectedFingerprint` 时，rename 前再读一次目标并核对：这只收窄「预检后、替换前
 * 被外部改掉」的窗口，**不是跨进程 CAS** —— 核对与 rename 之间仍有极短的竞争窗口，
 * 真正的串行保护来自上层写链与调用方预检。
 */
export async function atomicWrite(path: string, text: string, expectedFingerprint?: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
  if (expectedFingerprint !== undefined) {
    try {
      const current = await readTextOrNull(path)
      if (nativeMcpTextFingerprint(current) !== expectedFingerprint) {
        throw new Error('目标文件在替换前发生了变化，已放弃写入')
      }
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function defaultToken(): string {
  return randomBytes(24).toString('base64url')
}

function serializeDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

function pruneExpired(nowMs: number): void {
  for (const [token, pending] of pendingImports) {
    if (pending.expiresAt <= nowMs) pendingImports.delete(token)
  }
}

function targetHasNativeName(text: string | null, name: string): boolean {
  if (text === null) return false
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const servers = (parsed as Record<string, unknown>).mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false
  return Object.prototype.hasOwnProperty.call(servers, name)
}

/** 预览：读源与目标，生成令牌与将写内容；不落盘、不停用、不连接。 */
export async function prepareNativeMcpImport(input: {
  host: NativeMcpImportHost
  serverId: string
  owner: NativeMcpImportOwner
}): Promise<NativeMcpImportPreview> {
  const { host, serverId, owner } = input
  const id = typeof serverId === 'string' ? serverId.trim() : ''
  if (!id) throw new NativeMcpImportError('server_required', '需要明确的服务 id')
  if (!owner || typeof owner.id !== 'string' || !owner.id.trim()) {
    throw new NativeMcpImportError('owner_required', '缺少调用者身份，拒绝生成导入令牌')
  }

  const hostConfigFile = hostConfigPathOf(host)
  let sourceText: string | null
  try {
    sourceText = await readTextOrNull(hostConfigFile)
  } catch (error) {
    throw new NativeMcpImportError('host_config_unreadable', `无法读取砚的 MCP 配置 ${hostConfigFile}：${messageOf(error)}`)
  }
  if (sourceText === null) {
    throw new NativeMcpImportError('host_config_missing', `砚的 MCP 配置不存在：${hostConfigFile}`)
  }
  const parsed = parseMcpServersDocument(sourceText, hostConfigFile)
  /*
   * 旧配置有任何解析问题就整份拒绝：从「部分有效条目」继续导入会把用户没看到的
   * 损坏当作正常状态，还可能导入一条与坏条目同名或冲突的服务。
   */
  if (parsed.error) {
    throw new NativeMcpImportError(
      'host_config_invalid',
      `砚的 MCP 配置存在解析问题，拒绝基于部分有效条目导入：${parsed.error}`
    )
  }
  const config = parsed.servers.find((server) => server.id === id)
  if (!config) throw new NativeMcpImportError('server_unknown', `砚的 MCP 配置里没有 id 为 ${id} 的服务`)
  if (config.migratedToNative) {
    throw new NativeMcpImportError('already_migrated', migratedMcpCommandNotice(id, config.migratedToNative))
  }
  if (config.id === WINDOWS_MCP_SERVER_ID) {
    throw new NativeMcpImportError('windows_mcp_preserved', 'windows-mcp 保留在砚的连接里，不导入 pi 原生')
  }
  if (config.enabled === false) {
    throw new NativeMcpImportError('server_disabled', `服务 ${id} 在旧配置里是停用状态，不导入 pi 原生；先启用或确认是否仍需要它`)
  }

  const conversion = convertMcpServerToNative(config)
  if (!conversion.ok) throw new NativeMcpImportError('convert_failed', conversion.reason)
  const named = nativeMcpServerName(config.id)
  if (!named.ok) throw new NativeMcpImportError('server_name_invalid', named.reason)

  let scope: 'global' | 'project' = 'global'
  let projectId: string | undefined
  let projectCwd: string | undefined
  let targetPath = join(host.agentDir, 'mcp.json')
  if (config.projectScope?.trim()) {
    projectId = config.projectScope.trim()
    const project = host.projects.find((entry) => entry.id === projectId)
    if (!project || typeof project.cwd !== 'string' || !project.cwd.trim()) {
      throw new NativeMcpImportError(
        'unregistered_project',
        `服务 ${id} 的项目范围指向未登记项目 ${projectId}；只认受信项目登记，不按目录反推`
      )
    }
    scope = 'project'
    projectCwd = project.cwd
    targetPath = join(project.cwd, '.pi', 'mcp.json')
  }

  let targetText: string | null
  try {
    targetText = await readTextOrNull(targetPath)
  } catch (error) {
    throw new NativeMcpImportError('target_unreadable', `无法读取 pi 原生配置 ${targetPath}：${messageOf(error)}`)
  }
  let existingDocument: unknown
  if (targetText !== null) {
    try {
      existingDocument = JSON.parse(targetText)
    } catch (error) {
      throw new NativeMcpImportError('target_invalid_json', `pi 原生配置不是合法 JSON（${targetPath}），拒绝改写：${messageOf(error)}`)
    }
  }
  const merged = buildNativeMcpDocument({ existing: existingDocument, name: named.name, server: conversion.server })
  if (!merged.ok) throw new NativeMcpImportError(merged.code, merged.reason)

  const nowMs = (host.now ?? Date.now)()
  pruneExpired(nowMs)
  if (pendingImports.size >= MAX_PENDING_IMPORTS) {
    throw new NativeMcpImportError(
      'too_many_pending',
      `同时待确认的导入已达到上限（${MAX_PENDING_IMPORTS} 个），请先完成或等已过期的令牌释放后重试`
    )
  }
  const token = (host.generateToken ?? defaultToken)()
  const expiresAt = nowMs + (host.tokenTtlMs ?? 2 * 60_000)
  pendingImports.set(token, {
    ownerId: owner.id.trim(),
    serverId: id,
    nativeName: named.name,
    scope,
    ...(projectId ? { projectId } : {}),
    ...(projectCwd ? { projectCwd } : {}),
    targetPath,
    hostConfigFile,
    agentDir: host.agentDir,
    content: serializeDocument(merged.document),
    warnings: conversion.warnings,
    requiresReauth: conversion.requiresReauth,
    sourceFingerprint: nativeMcpTextFingerprint(sourceText),
    targetFingerprint: nativeMcpTextFingerprint(targetText),
    expiresAt
  })

  return {
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    serverId: id,
    nativeName: named.name,
    scope,
    ...(projectId ? { projectId } : {}),
    ...(projectCwd ? { projectCwd } : {}),
    targetPath,
    content: serializeDocument(merged.document),
    serverEntry: conversion.server,
    warnings: conversion.warnings,
    requiresReauth: conversion.requiresReauth,
    ...(conversion.requiresReauth
      ? { reauthNotice: `authRef 凭证不迁移；导入后请在 pi 里重新登录服务 ${named.name}（pi mcp login ${named.name}）` }
      : {})
  }
}

/** 提交：锁内核对令牌/身份/项目后写原生，再按校验结果决定是否停用旧条目。 */
export async function commitNativeMcpImport(input: {
  host: NativeMcpImportHost
  token: string
  owner: NativeMcpImportOwner
}): Promise<NativeMcpImportCommitResult> {
  const { host, token, owner } = input

  return serializedWrite(async (): Promise<NativeMcpImportCommitResult> => {
    const nowMs = (host.now ?? Date.now)()
    /*
     * 令牌必须在锁内核对并「领取一次」：两个并发提交不能同时读到同一条 pending。
     * 领取放在身份核对之后 —— 换身份的失败调用不能消耗掉合法调用者的令牌。
     */
    const pending = pendingImports.get(token)
    if (!pending) throw new NativeMcpImportError('token_invalid', '导入令牌无效或已被使用，请重新预览')
    if (pending.expiresAt <= nowMs) {
      pendingImports.delete(token)
      throw new NativeMcpImportError('token_expired', '导入令牌已过期，请重新预览')
    }
    if (!owner || pending.ownerId !== owner.id) {
      throw new NativeMcpImportError('token_owner_mismatch', '导入令牌与调用者身份不匹配，拒绝执行')
    }
    if (pending.agentDir !== host.agentDir || pending.hostConfigFile !== hostConfigPathOf(host)) {
      throw new NativeMcpImportError('host_mismatch', '导入令牌不是为当前宿主 / 数据目录生成的')
    }
    /* 领取：自此同一令牌不能再用；写入失败也要重新 preview。 */
    pendingImports.delete(token)

    const writeText = host.writeText ?? atomicWrite
    const base = {
      serverId: pending.serverId,
      nativeName: pending.nativeName,
      targetPath: pending.targetPath,
      warnings: pending.warnings
    }

    const precheck = async (): Promise<void> => {
      /* 项目登记可能被移除或目录改变：重新确认真实宿主项目 cwd，而不是只比 agentDir。 */
      if (pending.projectId) {
        const project = host.projects.find((entry) => entry.id === pending.projectId)
        if (!project || typeof project.cwd !== 'string' || !project.cwd.trim() || project.cwd !== pending.projectCwd) {
          throw new NativeMcpImportError(
            'project_changed',
            '预览后项目登记被移除或目录改变，令牌已作废；请重新预览确认'
          )
        }
      }
      let source: string | null
      try {
        source = await readTextOrNull(pending.hostConfigFile)
      } catch (error) {
        throw new NativeMcpImportError('source_unreadable', `无法读取砚的 MCP 配置：${messageOf(error)}`)
      }
      if (nativeMcpTextFingerprint(source) !== pending.sourceFingerprint) {
        throw new NativeMcpImportError('source_changed', '预览后砚的 MCP 配置发生了变化，令牌已作废；请重新预览确认')
      }
      let target: string | null
      try {
        target = await readTextOrNull(pending.targetPath)
      } catch (error) {
        throw new NativeMcpImportError('target_unreadable', `无法读取 pi 原生配置：${messageOf(error)}`)
      }
      if (nativeMcpTextFingerprint(target) !== pending.targetFingerprint) {
        throw new NativeMcpImportError('target_changed', '预览后 pi 原生配置发生了变化，令牌已作废；请重新预览确认')
      }
      if (targetHasNativeName(target, pending.nativeName)) {
        throw new NativeMcpImportError('name_conflict', `pi 原生 mcp.json 已经有同名服务「${pending.nativeName}」，拒绝覆盖`)
      }
    }
    await precheck()

    try {
      await writeText(pending.targetPath, pending.content, pending.targetFingerprint)
    } catch (error) {
      return {
        ...base,
        ok: false,
        nativeWritten: false,
        deactivated: false,
        verified: false,
        verification: 'unavailable',
        steps: { nativeWrite: 'failed', verify: 'skipped', hostDisable: 'skipped' },
        notice: `写入 pi 原生配置失败：${messageOf(error)}；旧条目保持原状，未做任何停用。`
      }
    }

    const writtenFingerprint = nativeMcpTextFingerprint(pending.content)
    let verification: NativeMcpImportVerification = 'unavailable'
    let verifyDetail: string | undefined
    if (host.verify) {
      try {
        const outcome = await host.verify({
          serverId: pending.serverId,
          nativeName: pending.nativeName,
          scope: pending.scope,
          targetPath: pending.targetPath,
          expectedFingerprint: writtenFingerprint,
          ...(pending.projectId ? { projectId: pending.projectId } : {}),
          ...(pending.projectCwd ? { projectCwd: pending.projectCwd } : {})
        })
        verification = outcome.ok ? 'passed' : 'failed'
        verifyDetail = outcome.detail
      } catch (error) {
        verification = 'failed'
        verifyDetail = messageOf(error)
      }
    }

    if (verification !== 'passed') {
      const why =
        verification === 'unavailable'
          ? '尚未接入 pi 原生校验（主会话需要把 `pi mcp list --json` 接到 verify 回调）'
          : `pi 原生校验未通过${verifyDetail ? `：${verifyDetail}` : ''}`
      return {
        ...base,
        ok: false,
        nativeWritten: true,
        deactivated: false,
        verified: false,
        verification,
        steps: { nativeWrite: 'written', verify: verification, hostDisable: 'skipped' },
        notice: `pi 原生配置已写入 ${pending.targetPath}，但${why}；旧条目保持启用，未停用，也不会自动重启 runner。`
      }
    }

    /*
     * 校验期间目标文件可能被外部改写：先核对刚写入的内容仍在。
     * 之后读取/解析旧配置若失败，也是在写盘后如实回报 nativeWritten:true 的部分结果，
     * 不能裸抛异常让用户以为什么都没发生。
     */
    let targetBeforeDisable: string | null
    try {
      targetBeforeDisable = await readTextOrNull(pending.targetPath)
    } catch (error) {
      return {
        ...base,
        ok: false,
        nativeWritten: true,
        deactivated: false,
        verified: true,
        verification: 'passed',
        steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'skipped-external-change' },
        notice: `pi 原生校验通过，但回读原生配置失败：${messageOf(error)}；无法确认本次写入仍在，旧条目保持原状。`
      }
    }
    if (nativeMcpTextFingerprint(targetBeforeDisable) !== writtenFingerprint) {
      return {
        ...base,
        ok: false,
        nativeWritten: true,
        deactivated: false,
        verified: true,
        verification: 'passed',
        steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'skipped-external-change' },
        notice: 'pi 原生校验通过，但校验期间原生配置被外部改动；不确定当前内容是否仍是本次导入，旧条目保持原状，未停用。'
      }
    }

    let sourceBeforeDisable: string | null
    try {
      sourceBeforeDisable = await readTextOrNull(pending.hostConfigFile)
    } catch (error) {
      return {
        ...base,
        ok: false,
        nativeWritten: true,
        deactivated: false,
        verified: true,
        verification: 'passed',
        steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'failed' },
        notice: `pi 原生校验通过，但读取砚的 MCP 配置失败：${messageOf(error)}；旧条目保持启用，未停用。`
      }
    }
    if (nativeMcpTextFingerprint(sourceBeforeDisable) !== pending.sourceFingerprint) {
      return {
        ...base,
        ok: false,
        nativeWritten: true,
        deactivated: false,
        verified: true,
        verification: 'passed',
        steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'skipped-external-change' },
        notice: 'pi 原生校验通过，但砚的 MCP 配置在校验期间被外部改动；未覆盖外部修改，旧条目保持原状。'
      }
    }

    let sourceDocument: unknown
    if (sourceBeforeDisable !== null) {
      const reparsed = parseMcpServersDocument(sourceBeforeDisable, pending.hostConfigFile)
      if (reparsed.error) {
        return {
          ...base,
          ok: false,
          nativeWritten: true,
          deactivated: false,
          verified: true,
          verification: 'passed',
          steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'failed' },
          notice: `pi 原生校验通过，但砚的 MCP 配置解析失败，未停用旧条目：${reparsed.error}`
        }
      }
      sourceDocument = reparsed.document
    }

    const mark: McpMigratedToNativeMark = {
      at: new Date(nowMs).toISOString(),
      targetPath: pending.targetPath,
      nativeName: pending.nativeName
    }
    const patched = applyMigratedMark({ document: sourceDocument, serverId: pending.serverId, mark })
    if (!patched.ok) {
      return {
        ...base,
        ok: false,
        nativeWritten: true,
        deactivated: false,
        verified: true,
        verification: 'passed',
        steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'failed' },
        notice: `无法在旧配置里停用 ${pending.serverId}：${patched.reason}；原生已写入，旧条目保持原状，未做覆盖。`
      }
    }
    try {
      await writeText(pending.hostConfigFile, serializeDocument(patched.document), nativeMcpTextFingerprint(sourceBeforeDisable))
    } catch (error) {
      return {
        ...base,
        ok: false,
        nativeWritten: true,
        deactivated: false,
        verified: true,
        verification: 'passed',
        steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'failed' },
        notice: `pi 原生校验通过，但停用旧条目落盘失败：${messageOf(error)}；原生配置保留，旧条目仍启用，未自动回滚。`
      }
    }

    return {
      ...base,
      ok: true,
      nativeWritten: true,
      deactivated: true,
      verified: true,
      verification: 'passed',
      steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'disabled' },
      notice: `已把 ${pending.serverId} 导入 pi 原生（${pending.targetPath}），并停用旧条目；凭证不迁移，请按需在 pi 里重新登录。`
    }
  })
}
