import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertMainRuntimeImports, collectRuntimeRequires, findRuntimeRequires, missingFromPackage } from './lib/main-runtime-imports.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-imports-'))
const main = join(root, 'out', 'main')
await mkdir(main, { recursive: true })
try {
  await writeFile(join(main, 'index.js'), "import 'electron'; import 'node:fs'; import 'path'; import './worker.js'")
  await writeFile(join(main, 'worker.js'), "export const load = () => import('@example/reader/worker')")
  await assert.rejects(assertMainRuntimeImports(root, []), /@example\/reader\/worker/)
  const imports = await assertMainRuntimeImports(root, ['node_modules/@example/reader/**'])
  assert.deepEqual(imports, ['@example/reader/worker'])
  await writeFile(join(main, 'worker.js'), "import '@example/core'; export const load = () => import('pdfjs-dist/legacy/build/pdf.mjs')")
  await assert.rejects(assertMainRuntimeImports(root, ['!node_modules/**']), error =>
    error.message.includes('@example/core') && error.message.includes('pdfjs-dist/legacy/build/pdf.mjs')
  )
  await assert.rejects(assertMainRuntimeImports(root, ['node_modules/@example/core/**']), /pdfjs-dist/)
  assert.deepEqual((await assertMainRuntimeImports(root, ['node_modules/@example/core/**', 'node_modules/pdfjs-dist/**'])).sort(), ['@example/core', 'pdfjs-dist/legacy/build/pdf.mjs'])

  await writeFile(join(main, 'worker.js'), [
    "import { createRequire } from 'node:module'",
    'const requireModule = createRequire(import.meta.url)',
    "export const render = () => requireModule('@xterm/headless')",
    "export const builtin = () => requireModule('node:fs') && requireModule('./local.cjs') && requireModule('electron')",
    "export const pdf = () => createRequire(import.meta.url).resolve('pdfjs-dist/package.json')",
    "export const other = (require) => require('not-from-create-require')"
  ].join('\n'))
  assert.deepEqual(findRuntimeRequires(await readFile(join(main, 'worker.js'), 'utf8')).sort(), ['@xterm/headless', 'pdfjs-dist/package.json'])
  await assert.rejects(assertMainRuntimeImports(root, ['node_modules/pdfjs-dist/**']), /@xterm\/headless/)
  assert.deepEqual((await assertMainRuntimeImports(root, ['node_modules/@xterm/headless/**', 'node_modules/pdfjs-dist/**'])).sort(), ['@xterm/headless', 'pdfjs-dist/package.json'])
  assert.deepEqual(findRuntimeRequires("const req$1 = createRequire(pathToFileURL(file).href); req$1('a-dep'); req$1.resolve(`b-dep`); other('c-dep')").sort(), ['a-dep', 'b-dep'])
  assert.deepEqual(findRuntimeRequires("const dynamic = createRequire(import.meta.url); dynamic(name)"), [])

  const builder = await readFile('electron-builder.yml', 'utf8')
  const block = builder.split(/^files:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
  const patterns = [...block.matchAll(/^\s+-\s+'?([^'\r\n]+?)'?\s*$/gm)].map(match => match[1])
  assert.ok(patterns.includes('node_modules/node-pty/**'), '应能从 electron-builder.yml 读到 files 白名单')
  const sourceRequires = await collectRuntimeRequires('src/main', ['.ts'])
  assert.ok(sourceRequires.includes('@xterm/headless'), '源码里 createRequire 动态加载的 @xterm/headless 应被扫描到')
  assert.ok(sourceRequires.includes('node-pty'))
  assert.deepEqual(missingFromPackage(sourceRequires, patterns), [], '源码里 createRequire 动态加载的依赖都要在 electron-builder files 白名单里')
  console.log('✓ main runtime imports：静态、动态与 createRequire 加载的依赖缺件会阻止打包，内置模块和明确随包的依赖通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
