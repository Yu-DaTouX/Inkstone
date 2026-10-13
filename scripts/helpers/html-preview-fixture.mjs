import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

/** 在 app.ready 前加载真实预览协议；只替换数据根，不放宽 CSP。 */
export function createHtmlPreviewFixture(root) {
  const directory = mkdtempSync(join(tmpdir(), 'yan-matrix-html-'))
  const entry = join(root, 'src/main/html-artifact-preview.ts')
  const source = readFileSync(entry, 'utf8')
  const pathsImport = "import { YAN_DIR } from './paths'"
  if (!source.includes(pathsImport)) throw new Error('HTML preview fixture paths import changed')
  const result = buildSync({
    stdin: { contents: source.replace(pathsImport, `const YAN_DIR = ${JSON.stringify(directory)}`), resolveDir: dirname(entry), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron']
  })
  const modulePath = join(directory, 'preview.cjs')
  writeFileSync(modulePath, result.outputFiles[0].text)
  return createRequire(import.meta.url)(modulePath)
}
