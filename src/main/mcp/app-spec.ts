/**
 * MCP Apps 规范字段与形状的**唯一集中点**。
 *
 * ⚠️ 待按稳定版规范核对：本机 `@modelcontextprotocol/sdk` 1.32.1 不含 MCP Apps 扩展，
 * 开发期又禁止联网，所以下列常量与形状来自设计稿与公开草案（能力声明、`_meta.ui`
 * 字段、visibility 缺省、`ui/*` 方法名、csp 字段）。规范定稿后只改这一个模块；
 * 合成服务器（`scripts/fixtures/mcp-app-server.mjs`）也从这里取值，避免两处漂移。
 *
 * 缺省一律最严：
 *   · 缺 `visibility` → 只给模型，**不对 App 开放**；
 *   · 缺注解（annotations）→ 按“要询问”处理（判定在共享纯函数里）；
 *   · 缺 `csp` → 用与现有离线成果一致的严格默认档（CSP 推导在渲染层）。
 *
 * 本模块只放常量与纯形状判断，不做 IO，也不 import 任何运行时模块。
 */
import type { McpServerConfig } from '../../shared/mcp'
import { MCP_APP_METHODS } from '../../shared/mcp-app-methods'

/* 方法名的唯一来源在 `shared/mcp-app-methods.ts`；这里 re-export，保持主进程既有
 * `import { MCP_APP_METHODS } from './app-spec'` 调用点不变，且渲染端引用同一份定义。 */
export { MCP_APP_METHODS }

/** MCP Apps 扩展标识。 */
export const MCP_APP_EXTENSION_ID = 'io.modelcontextprotocol/ui'

/** App 资源的 MIME；允许带参数（如 `;charset=utf-8`），判定时拆参数比较。 */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

/** 单份 App 资源默认上限 2 MiB；超限不渲染、给文本回退。 */
export const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024

/** `_meta` 里承载 MCP Apps 声明的键与字段名。 */
export const MCP_APP_META_UI = 'ui'
export const MCP_APP_META_RESOURCE_URI = 'resourceUri'
export const MCP_APP_META_CSP = 'csp'
export const MCP_APP_META_VISIBILITY = 'visibility'
export const MCP_APP_META_PREFERS_BORDER = 'prefersBorder'

/** 工具可见性取值。 */
export type McpAppVisibility = 'model' | 'app'
export const MCP_APP_VISIBILITIES: readonly McpAppVisibility[] = ['model', 'app']

/** 缺省可见性：最严 —— 只给模型，不对 App 开放。 */
export const MCP_APP_DEFAULT_VISIBILITY: readonly McpAppVisibility[] = ['model']

/** `_meta.ui.csp` 的声明形状；推导与收紧在渲染层。 */
export interface McpAppCsp {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

/**
 * `initialize` 声明的客户端能力（砚作为 MCP Apps 宿主）。
 *
 * 待按稳定版规范核对：目前按公开草案声明 `extensions[扩展标识].mimeTypes`。
 */
export function mcpAppClientCapabilities(): { extensions: Record<string, { mimeTypes: string[] }> } {
  return { extensions: { [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } }
}

/** 取出 `_meta.ui` 对象；缺省或形状不对返回 null。 */
function uiMetaOf(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const ui = (meta as Record<string, unknown>)[MCP_APP_META_UI]
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return null
  return ui as Record<string, unknown>
}

/** 从 `_meta` 读 App 资源 URI；缺省 / 非字符串 / 空串都返回 null。 */
export function mcpAppResourceUriOf(meta: unknown): string | null {
  const uri = uiMetaOf(meta)?.[MCP_APP_META_RESOURCE_URI]
  return typeof uri === 'string' && uri.trim() ? uri : null
}

/**
 * 读 `_meta.ui.visibility`。
 *
 * 缺省、非数组、空数组或全是坏值都退回最严的 `['model']` ——
 * 让「服务没说」和「服务说不给 App」得到同一个结果，绝不放宽。
 */
export function mcpAppVisibilityOf(meta: unknown): McpAppVisibility[] {
  const raw = uiMetaOf(meta)?.[MCP_APP_META_VISIBILITY]
  if (!Array.isArray(raw)) return [...MCP_APP_DEFAULT_VISIBILITY]
  const values = raw.filter((value): value is McpAppVisibility => value === 'model' || value === 'app')
  return values.length ? [...new Set(values)] : [...MCP_APP_DEFAULT_VISIBILITY]
}

export function mcpAppIsAppVisible(meta: unknown): boolean {
  return mcpAppVisibilityOf(meta).includes('app')
}

export function mcpAppIsModelVisible(meta: unknown): boolean {
  return mcpAppVisibilityOf(meta).includes('model')
}

/** 读 `_meta.ui.csp`；只保留已知的四个域名列表，未知字段丢弃。 */
export function mcpAppCspOf(meta: unknown): McpAppCsp | null {
  const raw = uiMetaOf(meta)?.[MCP_APP_META_CSP]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const list = (key: string): string[] | undefined => {
    const value = source[key]
    if (!Array.isArray(value)) return undefined
    const domains = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return domains.length ? domains : undefined
  }
  const csp: McpAppCsp = {}
  const connect = list('connectDomains')
  if (connect) csp.connectDomains = connect
  const resource = list('resourceDomains')
  if (resource) csp.resourceDomains = resource
  const frame = list('frameDomains')
  if (frame) csp.frameDomains = frame
  const baseUri = list('baseUriDomains')
  if (baseUri) csp.baseUriDomains = baseUri
  return Object.keys(csp).length ? csp : null
}

/** App 资源 MIME 判定：基础类型必须 text/html，且带 `profile=mcp-app` 参数。 */
export function isMcpAppMimeType(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== 'string') return false
  const parts = mimeType.split(';')
  const base = parts.shift()?.trim().toLowerCase()
  if (base !== 'text/html') return false
  return parts.some((part) => part.trim().toLowerCase() === 'profile=mcp-app')
}

/* ------------------------------------------------------------------ */
/* 砚侧归属与托管声明（不是 MCP 规范，但同属 MCP Apps 宿主的数据形状） */
/* ------------------------------------------------------------------ */

/**
 * 一个 MCP 服务只归一方连接：pi 原生（默认）或砚托管。
 * 缺省 `pi` 是最严档：没写 `inkstone` 就绝不连接。
 */
export type McpAppOwnership = 'pi' | 'inkstone'

/** 砚托管时逐字保存的原 pi 条目，供回退时原样写回。 */
export interface McpAppNativeEntry {
  /** pi 侧配置文件路径。 */
  path: string
  /** pi 侧的服务名（当前与砚 id 相同，留字段以兼容改名）。 */
  name: string
  /** 原样保存的配置条目；时钟之外的任何内容都不裁剪。 */
  entry: unknown
  /** 保存时的配置指纹。 */
  fingerprint: string
}

/** 写在砚配置条目上的托管声明。 */
export interface McpAppHostConfig {
  at: string
  natives: McpAppNativeEntry[]
}

/** 砚配置里带 MCP Apps 归属字段的条目。 */
export interface McpAppServerConfig extends McpServerConfig {
  ownedBy?: McpAppOwnership
  appHost?: McpAppHostConfig
}

/**
 * 是否有资格由砚宿主连接。
 *
 * 三道都过才连：显式 `ownedBy:'inkstone'`、带 `appHost` 托管声明、未被禁用。
 * 任何一项缺失都按「未托管」处理 —— 宁可不连，也不在没有回退记录时接管。
 */
export function isInkstoneManaged(config: {
  ownedBy?: McpAppOwnership
  appHost?: McpAppHostConfig
  enabled?: boolean
}): boolean {
  return config.ownedBy === 'inkstone' && config.appHost !== undefined && config.enabled !== false
}
