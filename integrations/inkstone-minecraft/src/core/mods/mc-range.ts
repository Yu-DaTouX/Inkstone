export interface VersionParts {
  numbers: number[]
  suffix: string
}

export function parseVersion(raw: string): VersionParts {
  const text = String(raw ?? '').trim()
  const match = /^(\d+(?:\.\d+)*)(.*)$/.exec(text)
  if (!match) return { numbers: [], suffix: text }
  return { numbers: match[1].split('.').map((part) => Number(part) || 0), suffix: match[2] }
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left.numbers.length > 0 && right.numbers.length > 0) {
    const length = Math.max(left.numbers.length, right.numbers.length)
    for (let index = 0; index < length; index += 1) {
      const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)
      if (diff !== 0) return diff > 0 ? 1 : -1
    }
    if (left.suffix === right.suffix) return 0
    if (!left.suffix) return 1
    if (!right.suffix) return -1
    return left.suffix < right.suffix ? -1 : 1
  }
  if (left.suffix === right.suffix) return 0
  return left.suffix < right.suffix ? -1 : 1
}

function segmentsOf(raw: string): string[] {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .split(/[.-]/)
    .filter((part) => part.length > 0)
}

function matchesPrefix(range: string, version: string): boolean {
  const wanted = segmentsOf(range)
  const actual = segmentsOf(version)
  if (wanted.length === 0) return true
  if (wanted.length > actual.length) return false
  for (let index = 0; index < wanted.length; index += 1) {
    const part = wanted[index]
    if (part === 'x' || part === '*') return actual.length >= index
    if (part !== actual[index]) return false
  }
  return true
}

const WILDCARD = /^[xX*]$/

function compareWildcard(actual: string, wanted: string, comparator: string): boolean {
  const wantedParts = segmentsOf(wanted)
  const actualParts = segmentsOf(actual)
  for (let index = 0; index < wantedParts.length; index += 1) {
    const part = wantedParts[index]
    if (WILDCARD.test(part)) return true
    const left = Number(actualParts[index] ?? 0)
    const right = Number(part)
    if (!Number.isFinite(right)) return compareVersions(actual, wanted) >= 0
    if (left === right) continue
    return comparator.startsWith('>') ? left > right : left < right
  }
  if (comparator === '>' || comparator === '>=') {
    const more = actualParts.length > wantedParts.length
    if (more) return compareVersions(actual, wanted) >= 0
    return comparator === '>=' && compareVersions(actual, wanted) === 0
  }
  return comparator === '<=' ? compareVersions(actual, wanted) === 0 : false
}

function tildeRange(wanted: string, version: string): boolean {
  const parts = segmentsOf(wanted)
  if (parts.length <= 1) return matchesPrefix(wanted, version) && compareVersions(version, wanted) >= 0
  const prefix = parts.slice(0, parts.length - 1).join('.')
  return matchesPrefix(prefix, version) && compareVersions(version, wanted) >= 0
}

function caretRange(wanted: string, version: string): boolean {
  const parts = segmentsOf(wanted).map((part) => Number(part) || 0)
  if (compareVersions(version, wanted) < 0) return false
  const index = parts.findIndex((value) => value !== 0)
  if (index < 0) return true
  const next = [...parts.slice(0, index + 1)]
  next[index] += 1
  for (let rest = index + 1; rest < parts.length; rest += 1) next.push(0)
  return compareVersions(version, next.join('.')) < 0
}

function unaryMatch(token: string, version: string): boolean {
  if (!token || token === '*' || token === 'x') return true
  const comparator = /^(>=|<=|>|<|=|~|\^)/.exec(token)?.[1] ?? ''
  const body = comparator ? token.slice(comparator.length).trim() : token
  if (!body) return true
  if (!comparator) {
    if (/[xX*]/.test(body)) return matchesPrefix(body, version)
    return compareVersions(version, body) === 0 || matchesPrefix(body, version)
  }
  if (comparator === '~') return tildeRange(body, version)
  if (comparator === '^') return caretRange(body, version)
  if (comparator === '=') return compareVersions(version, body) === 0
  if (/[xX*]/.test(body) && (comparator === '>' || comparator === '>=')) return compareWildcard(version, body, comparator)
  const diff = compareVersions(version, body)
  if (comparator === '>=') return diff >= 0
  if (comparator === '>') return diff > 0
  if (comparator === '<=') return diff <= 0
  return diff < 0
}

function mavenRange(range: string, version: string): boolean {
  const groups = range.match(/[\[(][^\])]*[\])]/g)
  if (!groups) return true
  return groups.some((group) => {
    const open = group[0] === '['
    const close = group[group.length - 1] === ']'
    const inner = group.slice(1, -1)
    const parts = inner.split(',').map((part) => part.trim())
    if (parts.length === 1) return parts[0] !== '' && compareVersions(version, parts[0]) === 0
    const [low, high] = parts
    if (low) {
      const diff = compareVersions(version, low)
      if (open ? diff < 0 : diff <= 0) return false
    }
    if (high) {
      const diff = compareVersions(version, high)
      if (close ? diff > 0 : diff >= 0) return false
    }
    return true
  })
}

export function matchesVersionRange(range: string | null | undefined, version: string | null | undefined): boolean {
  const target = String(version ?? '').trim()
  if (!target) return true
  const text = String(range ?? '').trim()
  if (!text || text === '*' || text === 'any') return true
  if (/[\[(]/.test(text)) return mavenRange(text, target)
  return text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .every((token) => unaryMatch(token, target))
}
