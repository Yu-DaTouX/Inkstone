import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BrowserLoginImportProfile } from '../../shared/ipc'
import { parseBridgeCookies, type BridgeCookie } from './cookie-bridge'

const MAX_FIREFOX_COOKIES = 20_000
const EXPIRY_MS_THRESHOLD = 1e11

export interface FirefoxProfileRecord extends BrowserLoginImportProfile {
  dir: string
}

export interface FirefoxDiscoveryOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

interface IniSection {
  name: string
  values: Record<string, string>
}

function parseIni(raw: string): IniSection[] {
  const sections: IniSection[] = []
  let current: IniSection | null = null
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      current = { name: trimmed.slice(1, -1).trim(), values: {} }
      sections.push(current)
      continue
    }
    if (!current) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    current.values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return sections
}

function canonicalDir(path: string, platform: NodeJS.Platform): string {
  const norm = normalize(resolve(path)).replace(/[\\/]+$/, '')
  return platform === 'win32' || platform === 'darwin' ? norm.toLowerCase() : norm
}

function profileIdOf(dir: string, platform: NodeJS.Platform): string {
  return `ff-${createHash('sha256').update(canonicalDir(dir, platform)).digest('hex').slice(0, 12)}`
}

export function firefoxRoots(options: FirefoxDiscoveryOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const override = env.YAN_FIREFOX_PROFILES_DIR?.trim()
  if (override) return [override]
  if (platform === 'win32') {
    const roots = [join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox')]
    const packages = join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Packages')
    try {
      for (const entry of readdirSync(packages)) {
        if (!entry.startsWith('Mozilla.Firefox_')) continue
        roots.push(join(packages, entry, 'LocalCache', 'Roaming', 'Mozilla', 'Firefox'))
      }
    } catch { }
    return roots
  }
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Firefox')]
  return [join(home, '.mozilla', 'firefox')]
}

function readIniSafe(file: string): IniSection[] {
  try { return parseIni(readFileSync(file, 'utf8')) } catch { return [] }
}

function cookieFileMtime(dir: string): number {
  let latest = 0
  for (const name of ['cookies.sqlite', 'cookies.sqlite-wal']) {
    try {
      const mtime = statSync(join(dir, name)).mtimeMs
      if (mtime > latest) latest = mtime
    } catch { }
  }
  return latest
}

function resolveProfileDir(root: string, rawPath: string, isRelative: boolean): string {
  return isRelative ? resolve(root, rawPath) : resolve(rawPath)
}

export function discoverFirefoxProfiles(options: FirefoxDiscoveryOptions = {}): FirefoxProfileRecord[] {
  const platform = options.platform ?? process.platform
  const candidates: Array<{ id: string; name: string; dir: string; installDefault: boolean; profileDefault: boolean; mtime: number }> = []
  const seen = new Set<string>()

  const addCandidate = (dir: string, name: string, installDefault: boolean, profileDefault: boolean): void => {
    const key = canonicalDir(dir, platform)
    if (seen.has(key)) return
    const cookieFile = join(dir, 'cookies.sqlite')
    if (!existsSync(cookieFile)) return
    seen.add(key)
    candidates.push({
      id: profileIdOf(dir, platform),
      name: name.trim() || dir.split(/[\\/]/).filter(Boolean).at(-1) || 'default',
      dir,
      installDefault,
      profileDefault,
      mtime: cookieFileMtime(dir)
    })
  }

  for (const root of firefoxRoots(options)) {
    if (!existsSync(root)) continue
    const installDefaults = new Set<string>()
    for (const section of [...readIniSafe(join(root, 'installs.ini')), ...readIniSafe(join(root, 'profiles.ini')).filter((s) => /^Install/i.test(s.name))]) {
      const def = section.values.Default
      if (!def) continue
      installDefaults.add(canonicalDir(resolve(root, def), platform))
      installDefaults.add(canonicalDir(resolve(def), platform))
    }
    const profilesIni = readIniSafe(join(root, 'profiles.ini'))
    for (const section of profilesIni) {
      if (!/^Profile/i.test(section.name)) continue
      const rawPath = section.values.Path
      if (!rawPath) continue
      const isRelative = section.values.IsRelative !== '0'
      const dir = resolveProfileDir(root, rawPath, isRelative)
      const key = canonicalDir(dir, platform)
      addCandidate(dir, section.values.Name || '', installDefaults.has(key), section.values.Default === '1')
    }
    const profilesSubdir = join(root, 'Profiles')
    try {
      for (const entry of readdirSync(profilesSubdir)) {
        const dir = join(profilesSubdir, entry)
        try {
          if (!statSync(dir).isDirectory()) continue
        } catch { continue }
        const key = canonicalDir(dir, platform)
        addCandidate(dir, entry, installDefaults.has(key), false)
      }
    } catch { }
  }

  candidates.sort((a, b) =>
    Number(b.installDefault) - Number(a.installDefault) ||
    Number(b.profileDefault) - Number(a.profileDefault) ||
    b.mtime - a.mtime
  )

  return candidates.map((item, index) => ({
    id: item.id,
    name: item.name,
    dir: item.dir,
    isDefault: index === 0
  }))
}

export function listFirefoxProfiles(options: FirefoxDiscoveryOptions = {}): BrowserLoginImportProfile[] {
  return discoverFirefoxProfiles(options).map(({ id, name, isDefault }) => ({ id, name, isDefault }))
}

interface ParsedOriginAttrs {
  skip: boolean
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }
}

function sameSiteHost(cookieHost: string, siteHostname: string): boolean {
  const a = cookieHost.replace(/^\./, '').toLowerCase()
  const b = siteHostname.toLowerCase()
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

export function parseFirefoxOriginAttributes(raw: unknown, cookieHost: string): ParsedOriginAttrs {
  if (typeof raw !== 'string' || !raw) return { skip: false }
  const cleaned = raw.startsWith('^') ? raw.slice(1) : raw
  let partitionKey: ParsedOriginAttrs['partitionKey']
  for (const part of cleaned.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if ((key === 'privateBrowsingId' || key === 'userContextId') && value !== '' && value !== '0') {
      return { skip: true }
    }
    if (key === 'partitionKey') {
      const match = value.match(/^\((https?),([^,)]+)(?:,(\d+))?\)$/)
      if (!match) return { skip: true }
      const [, scheme, hostPart, port] = match
      const site = `${scheme}://${hostPart}${port ? `:${port}` : ''}`
      try {
        const parsed = new URL(site)
        if (parsed.origin !== site) return { skip: true }
        partitionKey = { topLevelSite: site, hasCrossSiteAncestor: !sameSiteHost(cookieHost, parsed.hostname) }
      } catch {
        return { skip: true }
      }
    }
  }
  return { skip: false, partitionKey }
}

function mapFirefoxSameSite(raw: unknown, secure: boolean): BridgeCookie['sameSite'] {
  if (raw === 1) return 'lax'
  if (raw === 2) return 'strict'
  if (raw === 0) return secure ? 'no_restriction' : 'unspecified'
  return 'unspecified'
}

export async function readFirefoxCookies(profileDir: string, nowSec = Date.now() / 1000): Promise<{ cookies: BridgeCookie[]; skipped: number }> {
  const sourceDb = join(profileDir, 'cookies.sqlite')
  if (!existsSync(sourceDb)) throw new Error('Firefox cookies database not found')
  const tempDir = await mkdtemp(join(tmpdir(), 'inkstone-ff-cookies-'))
  let db: DatabaseSync | null = null
  try {
    const tempDb = join(tempDir, 'cookies.sqlite')
    await copyFile(sourceDb, tempDb)
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${sourceDb}${suffix}`
      if (existsSync(sidecar)) {
        try { await copyFile(sidecar, `${tempDb}${suffix}`) } catch { }
      }
    }
    db = new DatabaseSync(tempDb)
    const columns = new Set(
      (db.prepare('PRAGMA table_info(moz_cookies)').all() as Array<{ name?: unknown }>)
        .map((row) => (typeof row.name === 'string' ? row.name : ''))
        .filter(Boolean)
    )
    if (!columns.has('name') || !columns.has('value') || !columns.has('host')) {
      throw new Error('Unexpected Firefox cookies schema')
    }
    const selectCols = [
      'name',
      'value',
      'host',
      columns.has('path') ? 'path' : "'/' AS path",
      columns.has('expiry') ? 'expiry' : '0 AS expiry',
      columns.has('isSecure') ? 'isSecure' : '0 AS isSecure',
      columns.has('isHttpOnly') ? 'isHttpOnly' : '0 AS isHttpOnly',
      columns.has('sameSite') ? 'sameSite' : '3 AS sameSite',
      columns.has('originAttributes') ? 'originAttributes' : "'' AS originAttributes"
    ]
    const orderBy = columns.has('lastAccessed') ? ' ORDER BY lastAccessed DESC' : ''
    const rows = db
      .prepare(`SELECT ${selectCols.join(', ')} FROM moz_cookies${orderBy} LIMIT ${MAX_FIREFOX_COOKIES}`)
      .all() as Array<Record<string, unknown>>

    let skipped = 0
    const rawCookies: BridgeCookie[] = []
    for (const row of rows) {
      const host = typeof row.host === 'string' ? row.host : ''
      const attrs = parseFirefoxOriginAttributes(row.originAttributes, host)
      if (attrs.skip) { skipped++; continue }
      const rawExpiry = typeof row.expiry === 'number' && Number.isFinite(row.expiry) ? row.expiry : 0
      const session = rawExpiry <= 0
      const expirationDate = session ? undefined : (rawExpiry > EXPIRY_MS_THRESHOLD ? Math.floor(rawExpiry / 1000) : Math.floor(rawExpiry))
      if (!session && expirationDate! <= nowSec) { skipped++; continue }
      const secure = Boolean(row.isSecure)
      rawCookies.push({
        name: typeof row.name === 'string' ? row.name : '',
        value: typeof row.value === 'string' ? row.value : '',
        domain: host,
        hostOnly: !host.startsWith('.'),
        path: typeof row.path === 'string' && row.path.startsWith('/') ? row.path : '/',
        secure,
        httpOnly: Boolean(row.isHttpOnly),
        sameSite: mapFirefoxSameSite(row.sameSite, secure),
        session,
        ...(session ? {} : { expirationDate }),
        ...(attrs.partitionKey ? { partitionKey: attrs.partitionKey } : {})
      })
    }
    const parsed = parseBridgeCookies({ cookies: rawCookies })
    return { cookies: parsed.cookies, skipped: skipped + parsed.skipped }
  } finally {
    try { db?.close() } catch { }
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
