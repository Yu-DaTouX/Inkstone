import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'review2-models-'))
const compiled = await mkdtemp(join(tmpdir(), 'review2-models-build-'))
const oldEnv = { ...process.env }
let checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++ }
try {
  process.env.YAN_DATA_DIR = join(root, 'data')
  process.env.YAN_PI_DIR = join(root, 'pi')
  process.env.YAN_LOCAL_INSTALL_SCAN = 'off'
  const outfile = join(compiled, 'models.mjs')
  await build({
    stdin: { contents: "export * from './src/main/image-generation.ts'; export * from './src/main/image-store.ts'; export * from './src/main/local-models.ts';", resolveDir: process.cwd(), sourcefile: 'review-models.ts' },
    outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(outfile))
  const imageDir = join(root, 'images')
  const base64 = Buffer.from('<svg/>').toString('base64')
  mod.localizeImage(imageDir, 'image/svg+xml', base64)
  const imagePath = join(imageDir, `${(await import('node:crypto')).createHash('sha1').update(base64).digest('hex')}.bin`)
  await writeFile(imagePath, 'corrupt cache')
  mod.localizeImage(imageDir, 'image/svg+xml', base64)
  check((await readFile(imagePath)).equals(Buffer.from(base64, 'base64')), 'corrupt localized image cache is replaced with expected bytes')

  check(mod.comfyCandidates([{ name: 'fallback.json', kind: 'text-to-image' }], 'missing.json', false)[0]?.name === 'fallback.json', 'missing named workflow falls back to compatible candidates')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => String(url).includes('/models?pageSize=200')
    ? Response.json({ models: [{ name: 'models/gemini-2.8-flash-image', supportedGenerationMethods: ['generateContent'] }] })
    : Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('image').toString('base64') } }] } }] })
  try {
    process.env.GOOGLE_API_KEY = 'fixture'
    process.env.YAN_IMAGE_GOOGLE_BASE = 'https://fixture.invalid'
    const response = await mod.generateImage({ provider: 'google', prompt: 'test' }, {
      cwd: root, artifactDir: join(root, 'artifacts'), sessionFile: join(root, 'session.jsonl'), messageId: 'm',
      availability: { codex: false, openai: false, compatible: false, google: true, doubao: false, local: null },
      credentials: { secret: async () => 'fixture' }
    })
    check(response.model === 'gemini-2.8-flash-image', 'Google model discovery uses mocked local response')
  } finally { globalThis.fetch = originalFetch }

  const cfg = join(root, 'data', 'local-models.json')
  await mod.saveLocalModelUrls(['http://127.0.0.1:1234'])
  check((await readFile(cfg, 'utf8')).includes('127.0.0.1:1234'), 'local-model URLs persist via replacement')
  await writeFile(cfg, '{broken')
  let rejected = false
  try { await mod.readLocalModelUrls() } catch { rejected = true }
  check(rejected && (await readFile(cfg, 'utf8')) === '{broken', 'malformed local-model configuration is preserved and rejected')
  check(!(await readdir(imageDir)).some(name => name.endsWith('.tmp')), 'image localization leaves no temp file')
  console.log(`test-review2-models: ${checks} checks passed`)
} finally {
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
  Object.assign(process.env, oldEnv)
  await rm(root, { recursive: true, force: true })
  await rm(compiled, { recursive: true, force: true })
}
