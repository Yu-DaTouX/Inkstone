import type { Session, WebContents } from 'electron'

export interface SessionPermissionRequest {
  permission: string
  webContentsId?: number
  origin: string
  requestingUrl: string
  isMainFrame: boolean
  securityOrigin?: string
  embeddingOrigin?: string
}

export type SessionPermissionTrust = (request: SessionPermissionRequest) => boolean

export interface SessionPermissionRules {
  allow?: readonly string[]
  trust?: SessionPermissionTrust
}

export interface TrustedFrameOptions {
  isTrustedContents?: (webContentsId: number | undefined) => boolean
  origins?: readonly string[]
  isTrustedRequest?: (request: SessionPermissionRequest) => boolean
}

const EMPTY: readonly string[] = []

export function permissionOriginKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol === 'file:') return 'file://'
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export const mainFrameOnly: SessionPermissionTrust = (request) => request.isMainFrame

export function trustedFrameTrust(options: TrustedFrameOptions = {}): SessionPermissionTrust {
  const origins = new Set((options.origins ?? []).map(permissionOriginKey).filter((value): value is string => Boolean(value)))
  return (request) => {
    if (!request.isMainFrame) return false
    if (options.isTrustedContents && !options.isTrustedContents(request.webContentsId)) return false
    if (origins.size) {
      const keys = [
        permissionOriginKey(request.origin),
        permissionOriginKey(request.requestingUrl),
        permissionOriginKey(request.securityOrigin)
      ].filter((value): value is string => Boolean(value))
      if (!keys.length || keys.some((key) => !origins.has(key))) return false
    }
    return options.isTrustedRequest ? options.isTrustedRequest(request) : true
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function contentsId(contents: WebContents | null): number | undefined {
  if (!contents || contents.isDestroyed?.()) return undefined
  return contents.id
}

function requestContext(
  permission: unknown,
  contents: WebContents | null,
  details: unknown,
  fallbackOrigin: string
): SessionPermissionRequest {
  const info = details && typeof details === 'object' ? (details as Record<string, unknown>) : {}
  const securityOrigin = readString(info.securityOrigin)
  const requestingUrl = readString(info.requestingUrl) ?? fallbackOrigin
  return {
    permission: String(permission),
    webContentsId: contentsId(contents),
    origin: readString(fallbackOrigin) ?? securityOrigin ?? requestingUrl,
    requestingUrl,
    isMainFrame: info.isMainFrame === true,
    ...(securityOrigin ? { securityOrigin } : {}),
    ...(readString(info.embeddingOrigin) ? { embeddingOrigin: readString(info.embeddingOrigin) as string } : {})
  }
}

export function installSessionPermissionBoundary(ses: Session, rules: SessionPermissionRules = {}): void {
  const allowed = new Set((rules.allow ?? EMPTY).map((name) => name.toLowerCase()))
  const decide = (request: SessionPermissionRequest): boolean => {
    if (!allowed.has(request.permission.toLowerCase())) return false
    return rules.trust ? rules.trust(request) : true
  }
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(decide(requestContext(permission, contents, details, contents?.getURL?.() ?? '')))
  })
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return decide(requestContext(permission, contents, details, requestingOrigin))
  })
}
