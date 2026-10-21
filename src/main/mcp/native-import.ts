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

const MAX_PENDING_IMPORTS = 32

export interface NativeMcpImportProject {
  id: string
  cwd: string
}

export interface NativeMcpImportOwner {
  id: string
  label?: string
}

export interface NativeMcpImportHost {
  agentDir: string
  hostConfigFile?: string
  projects: readonly NativeMcpImportProject[]
  verify?: (input: NativeMcpImportVerifyInput) => Promise<NativeMcpImportVerifyResult>
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
  if (config.ownedBy === 'inkstone') {
    throw new NativeMcpImportError(
      'inkstone_managed',
      `服务 ${id} 由砚托管，请改用「切换」流程；直接导入会让砚宿主与 pi 原生同时建立连接`
    )
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

export async function commitNativeMcpImport(input: {
  host: NativeMcpImportHost
  token: string
  owner: NativeMcpImportOwner
}): Promise<NativeMcpImportCommitResult> {
  const { host, token, owner } = input

  return serializedWrite(async (): Promise<NativeMcpImportCommitResult> => {
    const nowMs = (host.now ?? Date.now)()
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
    pendingImports.delete(token)

    const writeText = host.writeText ?? atomicWrite
    const base = {
      serverId: pending.serverId,
      nativeName: pending.nativeName,
      targetPath: pending.targetPath,
      warnings: pending.warnings
    }

    const precheck = async (): Promise<void> => {
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
