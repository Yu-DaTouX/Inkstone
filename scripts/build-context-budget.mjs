import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const sourcePath = resolve(root, 'src/shared/context-budget-v1.ts')
const outputPath = resolve(root, 'resources/pi-extensions/generated/context-budget-v1.mjs')
const checkOnly = process.argv.includes('--check')

const source = await readFile(sourcePath, 'utf8')
const sourceHash = createHash('sha256').update(source).digest('hex')
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    removeComments: false
  },
  fileName: 'context-budget-v1.ts'
}).outputText
const expected = `/* Generated from src/shared/context-budget-v1.ts. Do not edit.\n * source-sha256: ${sourceHash}\n */\n${transpiled}`

if (checkOnly) {
  let current
  try {
    current = await readFile(outputPath, 'utf8')
  } catch {
    process.stderr.write('context-budget-v1 generated resource is missing; run npm run build:context-budget\n')
    process.exit(1)
  }
  if (current !== expected) {
    process.stderr.write('context-budget-v1 generated resource is stale; run npm run build:context-budget\n')
    process.exit(1)
  }
  process.stdout.write('context-budget-v1 generated resource matches its TypeScript source\n')
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, expected, 'utf8')
  process.stdout.write(`Generated ${outputPath}\n`)
}
