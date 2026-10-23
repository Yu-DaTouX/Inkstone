import { execFileSync, execSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const VERSION = '0.186.1'
const FONT_TAG = 'r186'
const FONT_NAME = 'helvetiker_bold.typeface.json'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'resources', 'skills', 'artifact', 'vendor')

async function download(url, target) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  await writeFile(target, Buffer.from(await response.arrayBuffer()))
}

const work = await mkdtemp(join(tmpdir(), 'yan-vendor-three-'))
try {
  const tarball = execSync(`npm pack three@${VERSION} --silent`, { cwd: work, encoding: 'utf8' }).trim().split(/\r?\n/).pop()
  execFileSync('tar', ['-xzf', tarball], { cwd: work })
  const pkg = join(work, 'package')
  const fontsBase = `https://raw.githubusercontent.com/mrdoob/three.js/${FONT_TAG}/examples/fonts`
  await download(`${fontsBase}/${FONT_NAME}`, join(work, FONT_NAME))
  await download(`${fontsBase}/LICENSE`, join(work, 'fonts-LICENSE'))

  const entry = [
    "export * from 'three'",
    "export { TextGeometry } from './package/examples/jsm/geometries/TextGeometry.js'",
    "export { FontLoader, Font } from './package/examples/jsm/loaders/FontLoader.js'",
    "export { RoomEnvironment } from './package/examples/jsm/environments/RoomEnvironment.js'",
    `import helvetikerBold from './${FONT_NAME}'`,
    'export const fonts = { helvetikerBold }'
  ].join('\n')

  await mkdir(OUT_DIR, { recursive: true })
  const outfile = join(OUT_DIR, 'three.min.js')
  await build({
    stdin: { contents: entry, resolveDir: work, loader: 'js' },
    bundle: true,
    format: 'iife',
    globalName: 'THREE',
    minify: true,
    target: 'chrome120',
    legalComments: 'inline',
    plugins: [{ name: 'three-core', setup: (b) => b.onResolve({ filter: /^three$/ }, () => ({ path: join(pkg, 'build', 'three.module.js') })) }],
    banner: { js: `/*! three.js ${VERSION} (MIT) with TextGeometry, FontLoader, RoomEnvironment; ${FONT_NAME} from MgOpen fonts (see LICENSE-mgopen-fonts.txt) */` },
    outfile,
    logLevel: 'warning'
  })
  const code = await readFile(outfile, 'utf8')
  if (/<\/script/i.test(code)) await writeFile(outfile, code.replace(/<\/script/gi, '<\\/script'))
  await copyFile(join(pkg, 'LICENSE'), join(OUT_DIR, 'LICENSE-three.txt'))
  await copyFile(join(work, 'fonts-LICENSE'), join(OUT_DIR, 'LICENSE-mgopen-fonts.txt'))
  console.log(`three ${VERSION} -> ${outfile} (${((await stat(outfile)).size / 1024).toFixed(0)} KB)`)
} finally {
  await rm(work, { recursive: true, force: true })
}
