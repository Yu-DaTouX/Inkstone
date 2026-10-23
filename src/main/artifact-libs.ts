import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inlineArtifactLibs, type ArtifactLibName } from '../shared/html-artifact-libs'

const LIB_FILES: Record<ArtifactLibName, string> = { three: 'three.min.js' }
const loaded = new Map<ArtifactLibName, string | null>()

function vendorDir(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return [
    process.resourcesPath ? join(process.resourcesPath, 'yan-skills', 'artifact', 'vendor') : '',
    join(here, '..', '..', 'resources', 'skills', 'artifact', 'vendor'),
    join(process.cwd(), 'resources', 'skills', 'artifact', 'vendor')
  ].find((dir) => dir && existsSync(dir))
}

function readArtifactLib(name: ArtifactLibName): string | null {
  if (!loaded.has(name)) {
    const dir = vendorDir()
    let code: string | null = null
    try {
      code = dir ? readFileSync(join(dir, LIB_FILES[name]), 'utf8') : null
    } catch {
      code = null
    }
    loaded.set(name, code)
  }
  return loaded.get(name) ?? null
}

export function withBundledLibs(html: string): string {
  return inlineArtifactLibs(html, readArtifactLib)
}
