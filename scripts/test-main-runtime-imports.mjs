import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertMainRuntimeImports } from './lib/main-runtime-imports.mjs'

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
  console.log('✓ main runtime imports：静态和动态依赖缺件会阻止打包，内置模块和明确随包的依赖通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
