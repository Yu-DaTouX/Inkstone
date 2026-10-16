import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PiModelCatalog } from '../shared/custom-provider'

const FILE = join('generated', 'pi-model-catalog.json')
let cached: Promise<PiModelCatalog> | undefined

function catalogPath(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return [
    process.resourcesPath ? join(process.resourcesPath, 'yan-thin', FILE) : '',
    join(here, '..', '..', 'resources', 'pi-extensions', FILE),
    join(process.cwd(), 'resources', 'pi-extensions', FILE)
  ].find((path) => path && existsSync(path))
}

export function readPiModelCatalog(): Promise<PiModelCatalog> {
  cached ??= (async () => {
    const path = catalogPath()
    if (!path) return {}
    try {
      const json = JSON.parse(await readFile(path, 'utf8')) as { models?: PiModelCatalog }
      return json.models ?? {}
    } catch {
      return {}
    }
  })()
  return cached
}
