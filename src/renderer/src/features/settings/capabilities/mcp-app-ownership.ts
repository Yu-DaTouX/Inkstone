import type {
  McpAppOwnershipView,
  McpAppSwitchCommitResult,
  McpAppSwitchDirection,
  McpAppSwitchEntrySummary,
  McpAppSwitchPreview
} from '../../../../../shared/mcp-app-switch'

export interface McpAppSwitchLabels {
  groupTitle: string
  groupDesc: string
  note: string
  loadFailed: string
  empty: string
  managed: string
  piNative: string
  inkstoneConnection: string
  scopeGlobal: string
  scopeProject: string
  nativeName: string
  holders: (count: number) => string
  switchToPi: string
  switchToInkstone: string
  previewing: string
  switchConfirmTitle: string
  switchConfirmBody: string
  switchConfirmLabel: string
  previewTitle: string
  direction: string
  directionToInkstone: string
  directionToPi: string
  server: string
  targetPath: string
  hostConfigFile: string
  scope: string
  entry: string
  fieldDescription: string
  fieldTransport: string
  fieldCommand: string
  fieldArgs: string
  fieldEnvKeys: string
  fieldUrl: string
  warnings: string
  blocked: string
  resultTitle: string
  stepNative: string
  stepHost: string
  stepVerify: string
  stepDisconnect: string
  remediation: string
  unsupported: string
  missingRecord: string
  scopeChanged: string
  failed: string
}

const ZH: McpAppSwitchLabels = {
  groupTitle: '归属与迁移',
  groupDesc: '每个 MCP 服务只由一方连接：pi 原生或砚托管。切换是一次带指纹校验的两文件事务。',
  note: '预览只读取配置、不写盘、不连接；要再点一次确认才会真正切换。切换前后会有会话实例变动，请先让相关任务空闲。',
  loadFailed: '读取失败',
  empty: '当前运行实例看不到可切换的 MCP 服务。',
  managed: '砚托管',
  piNative: 'pi 原生',
  inkstoneConnection: '砚连接',
  scopeGlobal: '全局',
  scopeProject: '项目',
  nativeName: '原生名',
  holders: (count) => `${count} 个已加载实例可能持有`,
  switchToPi: '交回 pi 原生',
  switchToInkstone: '由砚托管',
  previewing: '正在预览…',
  switchConfirmTitle: '确认切换归属',
  switchConfirmBody: '这会改写 pi 与砚的两份 MCP 配置。原条目会逐字保存/写回，任一失败会如实报告。',
  switchConfirmLabel: '确认切换',
  previewTitle: '切换预览',
  direction: '方向',
  directionToInkstone: 'pi 原生 → 砚托管',
  directionToPi: '砚托管 → pi 原生',
  server: '服务',
  targetPath: 'pi 配置文件',
  hostConfigFile: '砚配置文件',
  scope: '范围',
  entry: '原生条目（脱敏）',
  fieldDescription: '说明',
  fieldTransport: '传输方式',
  fieldCommand: '命令',
  fieldArgs: '参数个数',
  fieldEnvKeys: '环境变量（仅键名）',
  fieldUrl: '服务地址（仅来源）',
  warnings: '注意',
  blocked: '已加载实例仍可能持有该服务，首版不自动重启；请先退出相关会话。',
  resultTitle: '切换结果',
  stepNative: 'pi 配置',
  stepHost: '砚配置',
  stepVerify: 'pi 侧复核',
  stepDisconnect: '断开砚连接',
  remediation: '补救',
  unsupported: '首版不支持托管',
  missingRecord: '缺少 appHost 回退记录',
  scopeChanged: '运行实例在确认前后发生了变化，本次切换未执行；请重新预览。',
  failed: '切换失败'
}

const EN: McpAppSwitchLabels = {
  groupTitle: 'Ownership & migration',
  groupDesc: 'Each MCP server connects from exactly one side: pi native or Inkstone-managed. Switching is a two-file, fingerprint-checked transaction.',
  note: 'Preview only reads config — no writes, no connections. A second explicit confirm performs the switch. Sessions may need to be idle first.',
  loadFailed: 'Load failed',
  empty: 'No switchable MCP servers are visible to the current runner.',
  managed: 'Inkstone-managed',
  piNative: 'pi native',
  inkstoneConnection: 'Inkstone connection',
  scopeGlobal: 'Global',
  scopeProject: 'Project',
  nativeName: 'Native name',
  holders: (count) => `${count} loaded runner(s) may still hold it`,
  switchToPi: 'Hand back to pi native',
  switchToInkstone: 'Manage with Inkstone',
  previewing: 'Previewing…',
  switchConfirmTitle: 'Confirm ownership switch',
  switchConfirmBody: 'This rewrites both the pi and Inkstone MCP configs. The original entry is preserved/restored verbatim; any failure is reported honestly.',
  switchConfirmLabel: 'Confirm switch',
  previewTitle: 'Switch preview',
  direction: 'Direction',
  directionToInkstone: 'pi native → Inkstone-managed',
  directionToPi: 'Inkstone-managed → pi native',
  server: 'Server',
  targetPath: 'pi config file',
  hostConfigFile: 'Inkstone config file',
  scope: 'Scope',
  entry: 'Native entry (redacted)',
  fieldDescription: 'Description',
  fieldTransport: 'Transport',
  fieldCommand: 'Command',
  fieldArgs: 'Argument count',
  fieldEnvKeys: 'Environment keys (names only)',
  fieldUrl: 'Server URL (origin only)',
  warnings: 'Notes',
  blocked: 'Loaded runners may still hold this server and v1 never auto-restarts; exit related sessions first.',
  resultTitle: 'Switch result',
  stepNative: 'pi config',
  stepHost: 'Inkstone config',
  stepVerify: 'pi-side check',
  stepDisconnect: 'Inkstone connection',
  remediation: 'Remediation',
  unsupported: 'Not supported in v1',
  missingRecord: 'Missing appHost fallback record',
  scopeChanged: 'The runner changed during confirmation; nothing was written. Preview again.',
  failed: 'Switch failed'
}

export function mcpAppSwitchLabels(lang: string): McpAppSwitchLabels {
  return lang === 'en-US' ? EN : ZH
}

export type McpAppOwnershipParseResult =
  | { ok: true; views: McpAppOwnershipView[] }
  | { ok: false; code: 'ownership_response_invalid' | 'backend_error'; error: string }

export function parseMcpAppOwnershipResponse(raw: unknown): McpAppOwnershipParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'ownership_response_invalid', error: '主进程没有返回归属视图对象' }
  }
  const record = raw as { servers?: unknown; error?: unknown }
  if (typeof record.error === 'string' && record.error.trim()) {
    return { ok: false, code: 'backend_error', error: record.error.trim() }
  }
  if (!Array.isArray(record.servers)) {
    return { ok: false, code: 'ownership_response_invalid', error: '归属视图响应缺少 servers 数组' }
  }
  const views: McpAppOwnershipView[] = []
  for (const item of record.servers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, code: 'ownership_response_invalid', error: '归属视图条目不是对象' }
    }
    const view = item as { serverId?: unknown; ownedBy?: unknown; managed?: unknown }
    if (typeof view.serverId !== 'string' || view.serverId.trim() === '') {
      return { ok: false, code: 'ownership_response_invalid', error: '归属视图条目缺少 serverId' }
    }
    if (view.ownedBy !== 'pi' && view.ownedBy !== 'inkstone') {
      return { ok: false, code: 'ownership_response_invalid', error: '归属视图条目缺少 ownedBy' }
    }
    if (typeof view.managed !== 'boolean') {
      return { ok: false, code: 'ownership_response_invalid', error: '归属视图条目缺少 managed' }
    }
    views.push(item as McpAppOwnershipView)
  }
  return { ok: true, views }
}

export function mcpAppDirectionLabel(direction: McpAppSwitchDirection, labels: McpAppSwitchLabels): string {
  return direction === 'to-inkstone' ? labels.directionToInkstone : labels.directionToPi
}

function entryLines(summary: McpAppSwitchEntrySummary, labels: McpAppSwitchLabels): string[] {
  const lines: string[] = []
  if (summary.description) lines.push(`${labels.fieldDescription}: ${summary.description}`)
  lines.push(`${labels.fieldTransport}: ${summary.transport}`)
  if (summary.command) lines.push(`${labels.fieldCommand}: ${summary.command}`)
  if (summary.argCount > 0) lines.push(`${labels.fieldArgs}: ${summary.argCount}`)
  if (summary.envKeys.length > 0) lines.push(`${labels.fieldEnvKeys}: ${summary.envKeys.join(', ')}`)
  if (summary.urlOrigin) lines.push(`${labels.fieldUrl}: ${summary.urlOrigin}`)
  return lines
}

export function formatMcpAppSwitchPreview(
  preview: McpAppSwitchPreview,
  labels: McpAppSwitchLabels,
  title: string
): string {
  const lines = [
    `${labels.server}: ${title} (${preview.serverId})`,
    `${labels.direction}: ${mcpAppDirectionLabel(preview.direction, labels)}`,
    `${labels.scope}: ${preview.scope === 'project' ? labels.scopeProject : labels.scopeGlobal}`,
    `${labels.nativeName}: ${preview.nativeName}`,
    `${labels.targetPath}: ${preview.targetPath}`,
    `${labels.hostConfigFile}: ${preview.hostConfigFile}`,
    '',
    `${labels.entry}:`,
    ...entryLines(preview.entry, labels)
  ]
  if (preview.warnings.length > 0) {
    lines.push('', `${labels.warnings}:`, ...preview.warnings.map((warning) => `- ${warning}`))
  }
  return lines.join('\n')
}

function stepState(state: string, labels: McpAppSwitchLabels): string {
  switch (state) {
    case 'removed':
      return 'removed'
    case 'written':
      return 'written'
    case 'enrolled':
      return 'enrolled'
    case 'released':
      return 'released'
    case 'passed':
      return 'passed'
    case 'failed':
      return labels.failed
    case 'disconnected':
      return 'disconnected'
    case 'unavailable':
      return 'unavailable'
    case 'skipped':
      return 'skipped'
    case 'not-needed':
      return 'not-needed'
    default:
      return state
  }
}

export function formatMcpAppSwitchResult(result: McpAppSwitchCommitResult, labels: McpAppSwitchLabels): string[] {
  return [
    `${labels.stepNative}: ${stepState(result.steps.native, labels)}`,
    `${labels.stepHost}: ${stepState(result.steps.host, labels)}`,
    `${labels.stepVerify}: ${stepState(result.steps.verify, labels)}`,
    `${labels.stepDisconnect}: ${stepState(result.steps.hostDisconnect, labels)}`,
    `${labels.remediation}: ${result.remediation}`
  ]
}
