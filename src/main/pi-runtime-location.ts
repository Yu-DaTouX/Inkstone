import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Immutable generations keep an upgrade from replacing a running pi's lazy imports. */
export function selectedPiRuntime(root: string): string {
  const manifest = join(root, 'current.json')
  if (!existsSync(manifest)) return root
  const value = JSON.parse(readFileSync(manifest, 'utf8')) as { generation?: unknown }
  if (typeof value.generation !== 'string' || !/^versions\/[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value.generation)) {
    throw new Error('pi runtime current.json contains an invalid generation')
  }
  return join(root, value.generation)
}
