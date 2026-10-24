import pkg from '../../../package.json' with { type: 'json' }
import type { DownloadSource } from '../../shared/api.ts'

export const USER_AGENT = `Yu-DaTouX/inkstone-minecraft/${pkg.version}`
export const MIRROR_ORIGIN = 'https://bmclapi2.bangbang93.com'
export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
export const FABRIC_META = 'https://meta.fabricmc.net/v2'
export const QUILT_META = 'https://meta.quiltmc.org/v3'
export const MODRINTH_API = 'https://api.modrinth.com/v2'

export type SourceId = 'official' | 'bmclapi'

export interface UrlCandidate {
  url: string
  source: SourceId
  mirrored: boolean
}

interface MirrorRule {
  origin: string
  mirrorPath: string | null
}

const MIRROR_RULES: MirrorRule[] = [
  { origin: 'https://piston-meta.mojang.com', mirrorPath: '' },
  { origin: 'https://piston-data.mojang.com', mirrorPath: '' },
  { origin: 'https://launchermeta.mojang.com', mirrorPath: '' },
  { origin: 'https://launcher.mojang.com', mirrorPath: '' },
  { origin: 'https://libraries.minecraft.net', mirrorPath: '/maven' },
  { origin: 'https://resources.download.minecraft.net', mirrorPath: '/assets' },
  { origin: 'https://meta.fabricmc.net', mirrorPath: '/fabric-meta' },
  { origin: 'https://maven.fabricmc.net', mirrorPath: '/maven' },
  { origin: 'https://maven.quiltmc.org/repository/release', mirrorPath: '/maven' },
  { origin: 'https://meta.quiltmc.org', mirrorPath: null },
  { origin: 'https://cdn.modrinth.com', mirrorPath: null },
  { origin: 'https://api.modrinth.com', mirrorPath: null }
]

export function mirrorUrl(url: string, mirrorOrigin = MIRROR_ORIGIN): { url: string; mirrored: boolean } {
  for (const rule of MIRROR_RULES) {
    if (!url.startsWith(rule.origin)) continue
    const rest = url.slice(rule.origin.length)
    if (rest && !rest.startsWith('/')) continue
    if (rule.mirrorPath === null) return { url, mirrored: false }
    return { url: `${mirrorOrigin}${rule.mirrorPath}${rest}`, mirrored: true }
  }
  return { url, mirrored: false }
}

export function candidateUrls(url: string, source: DownloadSource = 'auto', mirrorOrigin = MIRROR_ORIGIN): UrlCandidate[] {
  const mirror = mirrorUrl(url, mirrorOrigin)
  if (!mirror.mirrored) return [{ url, source: 'official', mirrored: false }]
  if (source === 'bmclapi') return [{ url: mirror.url, source: 'bmclapi', mirrored: true }]
  if (source === 'official') return [{ url, source: 'official', mirrored: false }]
  return [
    { url: mirror.url, source: 'bmclapi', mirrored: true },
    { url, source: 'official', mirrored: false }
  ]
}

export interface SourceRecord {
  ok: number
  failed: number
  rate: number | null
}

export class SourceStats {
  private readonly records = new Map<SourceId, { ok: number; failed: number }>()

  note(source: SourceId, ok: boolean): void {
    const record = this.records.get(source) ?? { ok: 0, failed: 0 }
    if (ok) record.ok += 1
    else record.failed += 1
    this.records.set(source, record)
  }

  rate(source: SourceId): number | null {
    const record = this.records.get(source)
    if (!record || record.ok + record.failed === 0) return null
    return record.ok / (record.ok + record.failed)
  }

  snapshot(): Record<SourceId, SourceRecord> {
    const official = this.records.get('official') ?? { ok: 0, failed: 0 }
    const bmclapi = this.records.get('bmclapi') ?? { ok: 0, failed: 0 }
    return {
      official: { ...official, rate: this.rate('official') },
      bmclapi: { ...bmclapi, rate: this.rate('bmclapi') }
    }
  }

  reset(): void {
    this.records.clear()
  }
}
