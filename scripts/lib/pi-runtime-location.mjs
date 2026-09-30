import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function selectedPiRuntime(root) {
  const manifest = join(root, 'current.json')
  if (!existsSync(manifest)) return root
  const { generation } = JSON.parse(readFileSync(manifest, 'utf8'))
  if (typeof generation !== 'string' || !/^versions\/[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(generation)) {
    throw new Error('pi runtime current.json contains an invalid generation')
  }
  return join(root, generation)
}
