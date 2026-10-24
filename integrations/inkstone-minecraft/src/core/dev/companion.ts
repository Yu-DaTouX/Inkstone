import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompanionControl, CompanionOwner } from '../../shared/dev-api.ts'
import { compareVersions } from './fabric-meta.ts'

export const COMPANION_MOD_ID = 'inkstone_companion'
export const COMPANION_JAR_PREFIX = 'inkstone-companion-'

export interface CompanionEndpoint {
  port: number
  token: string
}

export class CompanionError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function companionRequest(endpoint: CompanionEndpoint, path: string, body: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const type = response.headers.get('content-type') ?? ''
  if (type.startsWith('image/')) {
    if (!response.ok) throw new CompanionError(response.status, `伴随 mod 返回 HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  const text = await response.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    throw new CompanionError(response.status, `伴随 mod 返回了无法解析的内容：${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    const error = (json as { error?: unknown })?.error
    throw new CompanionError(response.status, typeof error === 'string' ? error : `伴随 mod 返回 HTTP ${response.status}`)
  }
  return json
}

export async function companionImage(endpoint: CompanionEndpoint, path: string, body: Record<string, unknown> = {}): Promise<Buffer> {
  const result = await companionRequest(endpoint, path, body)
  if (!Buffer.isBuffer(result)) throw new Error('伴随 mod 没有返回图片')
  return result
}

export async function companionReachable(endpoint: CompanionEndpoint): Promise<Record<string, unknown> | null> {
  try {
    return (await companionRequest(endpoint, '/status', {}, 3000)) as Record<string, unknown>
  } catch {
    return null
  }
}

export function parseCompanionControl(reply: unknown): CompanionControl | null {
  const raw = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : null
  const owner: CompanionOwner | null = raw?.owner === 'agent' ? 'agent' : raw?.owner === 'user' ? 'user' : null
  if (!owner) return null
  return {
    owner,
    changedAt: typeof raw?.changedAt === 'number' && Number.isFinite(raw.changedAt) ? raw.changedAt : 0,
    changedBy: raw?.changedBy === 'user' ? 'user' : 'agent'
  }
}

export async function companionControl(endpoint: CompanionEndpoint, owner?: CompanionOwner): Promise<CompanionControl | null> {
  const reply = await companionRequest(endpoint, '/control', owner ? { owner } : {}, 5000)
  return parseCompanionControl(reply)
}

export interface CompanionVariant {
  id: string
  subdir: string
  minecraft: RegExp
  jar: RegExp
}

export const COMPANION_VARIANTS: CompanionVariant[] = [
  { id: '1.21', subdir: '', minecraft: /^1\.21(\.1)?$/, jar: /^inkstone-companion-(\d[\w.+-]*)\.jar$/ },
  { id: '26.1', subdir: 'mc26', minecraft: /^26\.1(\.\d+)?$/, jar: /^inkstone-companion-mc26-(\d[\w.+-]*)\.jar$/ }
]

export function companionVariant(minecraft: string | null): CompanionVariant | null {
  return (minecraft && COMPANION_VARIANTS.find((variant) => variant.minecraft.test(minecraft))) || null
}

export async function findCompanionJar(dirs: string[], variant: CompanionVariant = COMPANION_VARIANTS[0]): Promise<string | null> {
  const found: Array<{ path: string; version: string }> = []
  for (const dir of dirs) {
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const match = name.match(variant.jar)
      if (match && !/-(sources|dev)\.jar$/.test(name)) found.push({ path: join(dir, name), version: match[1] })
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version))[0]?.path ?? null
}

export async function installCompanion(jar: string, modsDir: string): Promise<string> {
  await mkdir(modsDir, { recursive: true })
  for (const name of await readdir(modsDir)) {
    if (name.startsWith(COMPANION_JAR_PREFIX) && name.endsWith('.jar')) await rm(join(modsDir, name), { force: true })
  }
  const target = join(modsDir, jar.split(/[\\/]/).pop() ?? 'inkstone-companion.jar')
  await copyFile(jar, target)
  return target
}

export function companionSupports(minecraft: string | null): boolean {
  return !!companionVariant(minecraft)
}

export function companionJarDirs(companionDir: string, extra: string[] = []): string[] {
  return [...extra, join(companionDir, 'build', 'libs'), join(companionDir, 'dist')].filter((dir) => existsSync(dir))
}
