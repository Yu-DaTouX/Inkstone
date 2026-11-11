import { build } from 'esbuild'
import { readdir, readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'

const CREATE_REQUIRE_CALL = String.raw`createRequire\s*\((?:[^()]|\([^()]*\))*\)`
const SPECIFIER = String.raw`\s*\(\s*(['"\x60])([^'"\x60$\\]+)\1`

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findRuntimeRequires(source) {
  if (!source.includes('createRequire')) return []
  const callees = [new RegExp(String.raw`${CREATE_REQUIRE_CALL}\s*(?:\.resolve)?${SPECIFIER}`, 'g')]
  const names = new Set()
  for (const match of source.matchAll(new RegExp(String.raw`([\w$]+)\s*=\s*(?:[\w$]+\.)?${CREATE_REQUIRE_CALL}`, 'g'))) names.add(match[1])
  for (const name of names) callees.push(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(name)}\s*(?:\.resolve)?${SPECIFIER}`, 'g'))
  const found = new Set()
  for (const pattern of callees) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2]
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier === 'electron' || isBuiltin(specifier)) continue
      found.add(specifier)
    }
  }
  return [...found]
}

export function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export function missingFromPackage(imports, filePatterns) {
  return imports.filter(specifier => !filePatterns.includes(`node_modules/${packageNameOf(specifier)}/**`))
}

export async function collectRuntimeRequires(directory, extensions) {
  const files = (await readdir(directory, { recursive: true })).filter(file => extensions.some(extension => file.endsWith(extension)))
  const found = new Set()
  for (const file of files) {
    for (const specifier of findRuntimeRequires(await readFile(join(directory, file), 'utf8'))) found.add(specifier)
  }
  return [...found]
}

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
  const staticImports = Object.values(result.metafile.inputs).flatMap(input =>
    input.imports.filter(item => item.external && item.path !== 'electron' && !isBuiltin(item.path)).map(item => item.path)
  )
  const imports = [...new Set([...staticImports, ...await collectRuntimeRequires(mainDir, ['.js'])])]
  const missing = missingFromPackage(imports, filePatterns)
  if (missing.length) throw new Error(`Main runtime imports are neither bundled nor included in the package: ${missing.join(', ')}`)
  return imports
}
