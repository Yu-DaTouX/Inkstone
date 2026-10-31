import { build } from 'esbuild'
import { readdir } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'

export async function assertMainRuntimeImports(projectDir, filePatterns) {
  const mainDir = join(projectDir, 'out', 'main')
  const entryPoints = (await readdir(mainDir, { recursive: true }))
    .filter(file => file.endsWith('.js'))
    .map(file => join(mainDir, file))
  if (!entryPoints.length) throw new Error('Main process build is missing')
  const result = await build({
    entryPoints,
    outdir: join(projectDir, '.tmp', 'main-runtime-imports'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    metafile: true,
    write: false,
    logLevel: 'silent'
  })
  const imports = [...new Set(Object.values(result.metafile.inputs).flatMap(input =>
    input.imports.filter(item => item.external && item.path !== 'electron' && !isBuiltin(item.path)).map(item => item.path)
  ))]
  const missing = imports.filter(specifier => {
    const parts = specifier.split('/')
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    return !filePatterns.includes(`node_modules/${name}/**`)
  })
  if (missing.length) throw new Error(`Main runtime imports are neither bundled nor included in the package: ${missing.join(', ')}`)
  return imports
}
