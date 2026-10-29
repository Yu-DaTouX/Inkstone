export const PROJECT_SCRIPT_ICONS = ['play', 'test', 'build', 'lint', 'server'] as const

export type ProjectScriptIcon = (typeof PROJECT_SCRIPT_ICONS)[number]

export interface ProjectScript {
  id: string
  name: string
  command: string
  icon?: ProjectScriptIcon
  previewUrl?: string
}

export type ProjectScriptsByProject = Record<string, ProjectScript[]>

export const MAX_PROJECT_SCRIPTS = 24

const MAX_ID_LENGTH = 64
const MAX_NAME_LENGTH = 40
const MAX_COMMAND_LENGTH = 400
const MAX_PREVIEW_URL_LENGTH = 300

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isProjectScriptIcon(value: unknown): value is ProjectScriptIcon {
  return typeof value === 'string' && (PROJECT_SCRIPT_ICONS as readonly string[]).includes(value)
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function cleanPreviewUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().slice(0, MAX_PREVIEW_URL_LENGTH) : ''
  if (!raw) return ''
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(raw)?.[1].toLowerCase()
  if (scheme && scheme !== 'http' && scheme !== 'https') return ''
  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw.replace(/^\/+/, '')}`
  return /^https?:\/\/[^\s]+$/i.test(candidate) ? candidate : ''
}

export function sanitizeProjectScript(value: unknown): ProjectScript | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, MAX_ID_LENGTH) : ''
  const name = cleanText(raw.name, MAX_NAME_LENGTH)
  const command = typeof raw.command === 'string' ? raw.command.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_COMMAND_LENGTH) : ''
  if (!id || !name || !command) return null
  const previewUrl = cleanPreviewUrl(raw.previewUrl)
  return {
    id,
    name,
    command,
    ...(isProjectScriptIcon(raw.icon) ? { icon: raw.icon } : {}),
    ...(previewUrl ? { previewUrl } : {})
  }
}

export function sanitizeProjectScripts(value: unknown): ProjectScriptsByProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: ProjectScriptsByProject = {}
  for (const [projectId, list] of Object.entries(value as Record<string, unknown>)) {
    if (!projectId || RESERVED_KEYS.has(projectId) || !Array.isArray(list)) continue
    const scripts: ProjectScript[] = []
    const seen = new Set<string>()
    for (const item of list) {
      const script = sanitizeProjectScript(item)
      if (!script || seen.has(script.id)) continue
      seen.add(script.id)
      scripts.push(script)
      if (scripts.length >= MAX_PROJECT_SCRIPTS) break
    }
    if (scripts.length > 0) out[projectId] = scripts
  }
  return out
}

export type PackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun'

export const PACKAGE_MANAGER_LOCK_FILES: Record<Exclude<PackageManagerId, 'npm'>, readonly string[]> = {
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lockb', 'bun.lock']
}

export interface PackageScript {
  name: string
  command: string
}

export type ProjectPackageScripts =
  | { ok: true; manager: PackageManagerId; scripts: PackageScript[] }
  | { ok: false; error: string }

export function packageManagerOf(files: readonly string[]): PackageManagerId {
  const lower = new Set(files.map((file) => file.toLowerCase()))
  for (const manager of ['pnpm', 'yarn', 'bun'] as const) {
    if (PACKAGE_MANAGER_LOCK_FILES[manager].some((lock) => lower.has(lock))) return manager
  }
  return 'npm'
}

export function packageScriptCommand(manager: PackageManagerId, name: string): string {
  return `${manager} run ${name}`
}

export function packageScriptsFromManifest(manifest: unknown, manager: PackageManagerId): PackageScript[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return []
  const scripts = (manifest as { scripts?: unknown }).scripts
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return []
  const out: PackageScript[] = []
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    const clean = cleanText(name, MAX_NAME_LENGTH)
    if (!clean || typeof body !== 'string' || !body.trim()) continue
    out.push({ name: clean, command: packageScriptCommand(manager, clean) })
  }
  return out
}
