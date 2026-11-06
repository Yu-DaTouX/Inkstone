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
import { pick } from '../../shared/ui-lang'

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
        throw new Error(pick('目标文件在替换前发生了变化，已放弃写入', 'Target file changed before replacement; write abandoned'))
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
  if (!id) throw new NativeMcpImportError('server_required', pick('需要明确的服务 id', 'A server id is required'))
  if (!owner || typeof owner.id !== 'string' || !owner.id.trim()) {
    throw new NativeMcpImportError('owner_required', pick('缺少调用者身份，拒绝生成导入令牌', 'Missing caller identity; import token refused'))
  }

  const hostConfigFile = hostConfigPathOf(host)
  let sourceText: string | null
  try {
    sourceText = await readTextOrNull(hostConfigFile)
  } catch (error) {
    throw new NativeMcpImportError('host_config_unreadable', pick(`无法读取砚的 MCP 配置 ${hostConfigFile}：${messageOf(error)}`, `Cannot read Inkstone MCP config ${hostConfigFile}: ${messageOf(error)}`))
  }
  if (sourceText === null) {
    throw new NativeMcpImportError('host_config_missing', pick(`砚的 MCP 配置不存在：${hostConfigFile}`, `Inkstone MCP config does not exist: ${hostConfigFile}`))
  }
  const parsed = parseMcpServersDocument(sourceText, hostConfigFile)
  if (parsed.error) {
    throw new NativeMcpImportError(
      'host_config_invalid',
      pick(`砚的 MCP 配置存在解析问题，拒绝基于部分有效条目导入：${parsed.error}`, `Inkstone MCP config has parse problems; refusing to import from partially valid entries: ${parsed.error}`)
    )
  }
  const config = parsed.servers.find((server) => server.id === id)
  if (!config) throw new NativeMcpImportError('server_unknown', pick(`砚的 MCP 配置里没有 id 为 ${id} 的服务`, `Inkstone MCP config has no server with id ${id}`))
  if (config.migratedToNative) {
    throw new NativeMcpImportError('already_migrated', migratedMcpCommandNotice(id, config.migratedToNative))
  }
  if (config.id === WINDOWS_MCP_SERVER_ID) {
    throw new NativeMcpImportError('windows_mcp_preserved', pick('windows-mcp 保留在砚的连接里，不导入 pi 原生', 'windows-mcp stays on the Inkstone connection and is not imported to pi native'))
  }
  if (config.ownedBy === 'inkstone') {
    throw new NativeMcpImportError(
      'inkstone_managed',
      pick(`服务 ${id} 由砚托管，请改用「切换」流程；直接导入会让砚宿主与 pi 原生同时建立连接`, `Server ${id} is hosted by Inkstone; use the "switch" flow. Importing directly would make the host and pi native connect at the same time`)
    )
  }
  if (config.enabled === false) {
    throw new NativeMcpImportError('server_disabled', pick(`服务 ${id} 在旧配置里是停用状态，不导入 pi 原生；先启用或确认是否仍需要它`, `Server ${id} is disabled in the old config and is not imported to pi native; enable it first or confirm you still need it`))
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
        pick(`服务 ${id} 的项目范围指向未登记项目 ${projectId}；只认受信项目登记，不按目录反推`, `Project scope of server ${id} points to unregistered project ${projectId}; only trusted project registrations count, paths are not inferred`)
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
    throw new NativeMcpImportError('target_unreadable', pick(`无法读取 pi 原生配置 ${targetPath}：${messageOf(error)}`, `Cannot read pi native config ${targetPath}: ${messageOf(error)}`))
  }
  let existingDocument: unknown
  if (targetText !== null) {
    try {
      existingDocument = JSON.parse(targetText)
    } catch (error) {
      throw new NativeMcpImportError('target_invalid_json', pick(`pi 原生配置不是合法 JSON（${targetPath}），拒绝改写：${messageOf(error)}`, `pi native config is not valid JSON (${targetPath}); rewrite refused: ${messageOf(error)}`))
    }
  }
  const merged = buildNativeMcpDocument({ existing: existingDocument, name: named.name, server: conversion.server })
  if (!merged.ok) throw new NativeMcpImportError(merged.code, merged.reason)

  const nowMs = (host.now ?? Date.now)()
  pruneExpired(nowMs)
  if (pendingImports.size >= MAX_PENDING_IMPORTS) {
    throw new NativeMcpImportError(
      'too_many_pending',
      pick(`同时待确认的导入已达到上限（${MAX_PENDING_IMPORTS} 个），请先完成或等已过期的令牌释放后重试`, `Too many pending imports (${MAX_PENDING_IMPORTS}); finish one or wait for expired tokens to release, then retry`)
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
      ? { reauthNotice: pick(`authRef 凭证不迁移；导入后请在 pi 里重新登录服务 ${named.name}（pi mcp login ${named.name}）`, `authRef credentials are not migrated; after importing, sign in to ${named.name} again in pi (pi mcp login ${named.name})`) }
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
    if (!pending) throw new NativeMcpImportError('token_invalid', pick('导入令牌无效或已被使用，请重新预览', 'Import token is invalid or already used; preview again'))
    if (pending.expiresAt <= nowMs) {
      pendingImports.delete(token)
      throw new NativeMcpImportError('token_expired', pick('导入令牌已过期，请重新预览', 'Import token expired; preview again'))
    }
    if (!owner || pending.ownerId !== owner.id) {
      throw new NativeMcpImportError('token_owner_mismatch', pick('导入令牌与调用者身份不匹配，拒绝执行', 'Import token does not match the caller; refused'))
    }
    if (pending.agentDir !== host.agentDir || pending.hostConfigFile !== hostConfigPathOf(host)) {
      throw new NativeMcpImportError('host_mismatch', pick('导入令牌不是为当前宿主 / 数据目录生成的', 'Import token was not issued for this host / data folder'))
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
            pick('预览后项目登记被移除或目录改变，令牌已作废；请重新预览确认', 'Project registration was removed or its folder changed after preview; token voided. Preview again')
          )
        }
      }
      let source: string | null
      try {
        source = await readTextOrNull(pending.hostConfigFile)
      } catch (error) {
        throw new NativeMcpImportError('source_unreadable', pick(`无法读取砚的 MCP 配置：${messageOf(error)}`, `Cannot read Inkstone MCP config: ${messageOf(error)}`))
      }
      if (nativeMcpTextFingerprint(source) !== pending.sourceFingerprint) {
        throw new NativeMcpImportError('source_changed', pick('预览后砚的 MCP 配置发生了变化，令牌已作废；请重新预览确认', 'Inkstone MCP config changed after preview; token voided. Preview again'))
      }
      let target: string | null
      try {
        target = await readTextOrNull(pending.targetPath)
      } catch (error) {
        throw new NativeMcpImportError('target_unreadable', pick(`无法读取 pi 原生配置：${messageOf(error)}`, `Cannot read pi native config: ${messageOf(error)}`))
      }
      if (nativeMcpTextFingerprint(target) !== pending.targetFingerprint) {
        throw new NativeMcpImportError('target_changed', pick('预览后 pi 原生配置发生了变化，令牌已作废；请重新预览确认', 'pi native config changed after preview; token voided. Preview again'))
      }
      if (targetHasNativeName(target, pending.nativeName)) {
        throw new NativeMcpImportError('name_conflict', pick(`pi 原生 mcp.json 已经有同名服务「${pending.nativeName}」，拒绝覆盖`, `pi native mcp.json already has a server named "${pending.nativeName}"; overwrite refused`))
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
        notice: pick(`写入 pi 原生配置失败：${messageOf(error)}；旧条目保持原状，未做任何停用。`, `Failed to write pi native config: ${messageOf(error)}. The old entry is unchanged and nothing was disabled.`)
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
          ? pick('尚未接入 pi 原生校验（主会话需要把 `pi mcp list --json` 接到 verify 回调）', 'pi native verification is not connected (the main session must wire `pi mcp list --json` to the verify callback)')
          : pick(`pi 原生校验未通过${verifyDetail ? `：${verifyDetail}` : ''}`, `pi native verification failed${verifyDetail ? `: ${verifyDetail}` : ''}`)
      return {
        ...base,
        ok: false,
        nativeWritten: true,
        deactivated: false,
        verified: false,
        verification,
        steps: { nativeWrite: 'written', verify: verification, hostDisable: 'skipped' },
        notice: pick(`pi 原生配置已写入 ${pending.targetPath}，但${why}；旧条目保持启用，未停用，也不会自动重启 runner。`, `pi native config written to ${pending.targetPath}, but ${why}. The old entry stays enabled and the runner is not restarted automatically.`)
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
        notice: pick(`pi 原生校验通过，但回读原生配置失败：${messageOf(error)}；无法确认本次写入仍在，旧条目保持原状。`, `pi native verification passed, but reading back the native config failed: ${messageOf(error)}. Cannot confirm the write is still present; the old entry is unchanged.`)
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
        notice: pick('pi 原生校验通过，但校验期间原生配置被外部改动；不确定当前内容是否仍是本次导入，旧条目保持原状，未停用。', 'pi native verification passed, but the native config was changed externally during verification. Cannot tell whether it is still this import; the old entry is unchanged and not disabled.')
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
        notice: pick(`pi 原生校验通过，但读取砚的 MCP 配置失败：${messageOf(error)}；旧条目保持启用，未停用。`, `pi native verification passed, but reading the Inkstone MCP config failed: ${messageOf(error)}. The old entry stays enabled.`)
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
        notice: pick('pi 原生校验通过，但砚的 MCP 配置在校验期间被外部改动；未覆盖外部修改，旧条目保持原状。', 'pi native verification passed, but the Inkstone MCP config was changed externally during verification. External changes were not overwritten; the old entry is unchanged.')
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
          notice: pick(`pi 原生校验通过，但砚的 MCP 配置解析失败，未停用旧条目：${reparsed.error}`, `pi native verification passed, but the Inkstone MCP config failed to parse; old entry not disabled: ${reparsed.error}`)
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
        notice: pick(`无法在旧配置里停用 ${pending.serverId}：${patched.reason}；原生已写入，旧条目保持原状，未做覆盖。`, `Cannot disable ${pending.serverId} in the old config: ${patched.reason}. Native config was written; the old entry is unchanged and nothing was overwritten.`)
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
        notice: pick(`pi 原生校验通过，但停用旧条目落盘失败：${messageOf(error)}；原生配置保留，旧条目仍启用，未自动回滚。`, `pi native verification passed, but saving the disabled old entry failed: ${messageOf(error)}. Native config kept, old entry still enabled, no automatic rollback.`)
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
      notice: pick(`已把 ${pending.serverId} 导入 pi 原生（${pending.targetPath}），并停用旧条目；凭证不迁移，请按需在 pi 里重新登录。`, `Imported ${pending.serverId} to pi native (${pending.targetPath}) and disabled the old entry. Credentials are not migrated; sign in again in pi if needed.`)
    }
  })
}
