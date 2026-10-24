import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export type FileManifest = Record<string, string>

export interface ManifestDiff {
  changed: string[]
  added: string[]
  removed: string[]
}

async function walkFiles(root: string, dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(root, full, out)
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'))
  }
}

export async function scanManifest(roots: string[], filter: (path: string) => boolean = () => true): Promise<FileManifest> {
  const manifest: FileManifest = {}
  for (const root of roots) {
    if (!existsSync(root)) continue
    const files: string[] = []
    await walkFiles(root, root, files)
    await Promise.all(
      files.filter(filter).map(async (path) => {
        manifest[path] = createHash('sha1').update(await readFile(join(root, path))).digest('hex')
      })
    )
  }
  return manifest
}

export function diffManifest(before: FileManifest, after: FileManifest): ManifestDiff {
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const [path, hash] of Object.entries(after)) {
    if (!(path in before)) added.push(path)
    else if (before[path] !== hash) changed.push(path)
  }
  for (const path of Object.keys(before)) if (!(path in after)) removed.push(path)
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() }
}

export function isClassFile(path: string): boolean {
  return path.endsWith('.class')
}

export function classNameOf(path: string): string {
  return path.replace(/\.class$/, '')
}

export function findInRoots(roots: string[], path: string): string | null {
  for (const root of roots) {
    const full = join(root, path)
    if (existsSync(full)) return full
  }
  return null
}

export const METADATA_FILES = [/^fabric\.mod\.json$/, /\.mixins\.json$/, /\.accesswidener$/, /\.classtweaker$/, /^META-INF\//]

export interface ResourceChanges {
  assets: string[]
  data: string[]
  metadata: string[]
  other: string[]
}

export function classifyResources(paths: string[]): ResourceChanges {
  const result: ResourceChanges = { assets: [], data: [], metadata: [], other: [] }
  for (const path of paths) {
    if (METADATA_FILES.some((pattern) => pattern.test(path))) result.metadata.push(path)
    else if (path.startsWith('assets/')) result.assets.push(path)
    else if (path.startsWith('data/')) result.data.push(path)
    else result.other.push(path)
  }
  return result
}

const REGISTRATION_ASSETS: Array<{ pattern: RegExp; registry: 'item' | 'block' }> = [
  { pattern: /^assets\/([a-z0-9_.-]+)\/items\/([a-z0-9_./-]+)\.json$/, registry: 'item' },
  { pattern: /^assets\/([a-z0-9_.-]+)\/models\/item\/([a-z0-9_./-]+)\.json$/, registry: 'item' },
  { pattern: /^assets\/([a-z0-9_.-]+)\/blockstates\/([a-z0-9_./-]+)\.json$/, registry: 'block' }
]

export function registrationCandidates(addedPaths: string[]): Array<{ registry: 'item' | 'block'; id: string }> {
  const found = new Map<string, { registry: 'item' | 'block'; id: string }>()
  for (const path of addedPaths) {
    for (const { pattern, registry } of REGISTRATION_ASSETS) {
      const match = pattern.exec(path)
      if (!match || match[1] === 'minecraft') continue
      const id = `${match[1]}:${match[2]}`
      found.set(`${registry}|${id}`, { registry, id })
    }
  }
  return [...found.values()]
}

const LANG_FILE = /^assets\/[a-z0-9_.-]+\/lang\/[a-z_]+\.json$/
const LANG_REGISTRATION_KEY = /^(item|block)\.([a-z0-9_-]+)\.([a-z0-9_/]+)$/

export function isLangFile(path: string): boolean {
  return LANG_FILE.test(path)
}

export function langRegistrationCandidates(before: Iterable<string>, after: Iterable<string>): Array<{ registry: 'item' | 'block'; id: string }> {
  const known = new Set(before)
  const found = new Map<string, { registry: 'item' | 'block'; id: string }>()
  for (const key of after) {
    if (known.has(key)) continue
    const match = LANG_REGISTRATION_KEY.exec(key)
    if (!match || match[2] === 'minecraft') continue
    const registry = match[1] as 'item' | 'block'
    const id = `${match[2]}:${match[3]}`
    found.set(`${registry}|${id}`, { registry, id })
  }
  return [...found.values()]
}

export function mixinPackagesFrom(configs: Array<{ package?: unknown }>): string[] {
  return configs.map((config) => (typeof config.package === 'string' ? config.package.replaceAll('.', '/') + '/' : '')).filter(Boolean)
}

export function isMixinClass(className: string, packages: string[]): boolean {
  return packages.some((prefix) => className.startsWith(prefix))
}
