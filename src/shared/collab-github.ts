import { validateBranchName } from './git-actions'
import type { GhPrListItemJson, GithubBranchRef } from './github'

export type CollabChannel = 'peer' | 'github'

export interface CollabChannelPeerBranch {
  name: string
  author: string
  fetched: boolean
}

export interface CollabChannelRow {
  name: string
  channels: CollabChannel[]
  owner: string | null
  ownerSource: 'manual' | 'inferred' | null
  pr: { number: number; title: string; url: string; isDraft: boolean; author: string } | null
  peerAuthor: string | null
  peerFetched: boolean
}

export interface PrRef {
  repo: string
  number: number
  url?: string
}

const LOGIN_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i
const REPO_PATTERN = /^[A-Za-z0-9][\w.-]{0,99}\/[\w.-]{1,100}$/
export const PR_REFS_MAX = 20
export const PEER_LOGINS_MAX = 100

export function isGithubLogin(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('--') && LOGIN_PATTERN.test(value)
}

export function sanitizePeerLogins(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [peerId, login] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= PEER_LOGINS_MAX) break
    if (!/^[\w.-]{1,80}$/.test(peerId) || peerId === '__proto__' || !isGithubLogin(login)) continue
    out[peerId] = login
  }
  return Object.keys(out).length ? out : undefined
}

export function topicSlug(value: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/\.{2,}/g, '.')
    .replace(/-+/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
    .slice(0, 80)
    .replace(/\.lock$/, '')
  return cleaned.replace(/^[-./]+|[-./]+$/g, '')
}

export function githubBranchName(login: string, peerBranch: string): string {
  const owner = login.trim().toLowerCase()
  const withoutOwner = peerBranch.startsWith(`${owner}/`) ? peerBranch.slice(owner.length + 1) : peerBranch
  const topic = topicSlug(withoutOwner) || 'work'
  return `${owner}/${topic}`
}

export function isPublishBranchName(name: unknown, login: unknown): name is string {
  if (typeof name !== 'string' || typeof login !== 'string' || !LOGIN_PATTERN.test(login)) return false
  if (name !== name.trim() || validateBranchName(name)) return false
  const prefix = `${login.toLowerCase()}/`
  return name.startsWith(prefix) && name.length > prefix.length
}

export function ownerOfBranch(name: string, pulls: GhPrListItemJson[], githubNames: ReadonlySet<string>): string | null {
  const pull = pulls.find((item) => item.headRefName === name)
  const author = pull?.author?.login
  if (typeof author === 'string' && LOGIN_PATTERN.test(author)) return author
  const slash = name.indexOf('/')
  if (slash > 0 && githubNames.has(name)) {
    const prefix = name.slice(0, slash)
    if (LOGIN_PATTERN.test(prefix)) return prefix
  }
  return null
}

export function mergeChannels(
  peerBranches: CollabChannelPeerBranch[],
  githubBranches: GithubBranchRef[],
  pulls: GhPrListItemJson[],
  manualLogin: string | null = null
): CollabChannelRow[] {
  const githubNames = new Set(githubBranches.map((branch) => branch.name))
  const rows = new Map<string, CollabChannelRow>()
  const ensure = (name: string): CollabChannelRow => {
    let row = rows.get(name)
    if (!row) {
      row = { name, channels: [], owner: null, ownerSource: null, pr: null, peerAuthor: null, peerFetched: false }
      rows.set(name, row)
    }
    return row
  }
  for (const branch of peerBranches) {
    const row = ensure(branch.name)
    row.channels.push('peer')
    row.peerAuthor = branch.author || null
    row.peerFetched = branch.fetched
  }
  for (const name of githubNames) {
    const row = ensure(name)
    row.channels.push('github')
  }
  for (const pull of pulls) {
    const name = pull.headRefName
    if (typeof name !== 'string' || !name || typeof pull.number !== 'number') continue
    const row = ensure(name)
    if (!row.channels.includes('github')) row.channels.push('github')
    row.pr = {
      number: pull.number,
      title: String(pull.title ?? ''),
      url: String(pull.url ?? ''),
      isDraft: pull.isDraft === true,
      author: String(pull.author?.login ?? '')
    }
  }
  const manual = isGithubLogin(manualLogin) ? manualLogin : null
  for (const row of rows.values()) {
    const inferred = ownerOfBranch(row.name, pulls, githubNames)
    if (manual && row.channels.includes('peer')) {
      row.owner = manual
      row.ownerSource = 'manual'
    } else {
      row.owner = inferred
      row.ownerSource = inferred ? 'inferred' : null
    }
  }
  return [...rows.values()].sort((a, b) => {
    const peer = Number(b.channels.includes('peer')) - Number(a.channels.includes('peer'))
    return peer || Number(!!b.pr) - Number(!!a.pr) || a.name.localeCompare(b.name)
  })
}

export function sanitizePrRefs(value: unknown): PrRef[] {
  if (!Array.isArray(value)) return []
  const out: PrRef[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.repo !== 'string' || !REPO_PATTERN.test(raw.repo)) continue
    if (typeof raw.number !== 'number' || !Number.isInteger(raw.number) || raw.number < 1 || raw.number > 9_999_999) continue
    const ref: PrRef = { repo: raw.repo, number: raw.number }
    if (typeof raw.url === 'string' && raw.url.length <= 500) {
      try {
        const url = new URL(raw.url)
        if (url.protocol === 'https:' && !url.username && !url.password) ref.url = url.toString()
      } catch {
        delete ref.url
      }
    }
    if (!out.some((existing) => existing.repo === ref.repo && existing.number === ref.number)) out.push(ref)
    if (out.length >= PR_REFS_MAX) break
  }
  return out
}
