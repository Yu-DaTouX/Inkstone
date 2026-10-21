const STORAGE_KEY = 'inkstone.workspace.owners.v1'
const LIMIT = 400

let cache: Record<string, string> | null = null

function load(): Record<string, string> {
  if (cache) return cache
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {}
  } catch {
    try {
      const broken = localStorage.getItem(STORAGE_KEY)
      if (broken) localStorage.setItem(`${STORAGE_KEY}.broken.${Date.now()}`, broken)
    } catch {
    }
    cache = {}
  }
  return cache
}

const sameRecord = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => b[key] === a[key])
}

function save(map: Record<string, string>): void {
  const entries = Object.entries(map)
  const kept = entries.length > LIMIT ? Object.fromEntries(entries.slice(entries.length - LIMIT)) : map
  if (cache && sameRecord(cache, kept)) return
  cache = kept
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(kept)) } catch { }
}

export function resourceOwner(resource: string): string | undefined {
  const map = load()
  const owner = map[resource]
  if (owner !== undefined) {
    delete map[resource]
    map[resource] = owner
    cache = map
  }
  return owner
}

export function claimResource(resource: string, owner: string): string {
  const map = load()
  const current = map[resource]
  if (current) return current
  save({ ...map, [resource]: owner })
  return owner
}

export function releaseResource(resource: string): void {
  const map = load()
  if (!(resource in map)) return
  const next = { ...map }
  delete next[resource]
  save(next)
}
