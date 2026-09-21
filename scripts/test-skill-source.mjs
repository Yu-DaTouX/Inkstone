import { createHash } from 'node:crypto'
import { build } from '../node_modules/esbuild/lib/main.js'

await build({
  entryPoints: ['src/main/capabilities/skill-source.ts'],
  outfile: 'out/test/skill-source.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})

const { fetchSkillFiles, SkillSourceError } = await import('../out/test/skill-source.mjs')
const path = 'skills/read-excel/SKILL.md'
const url = 'https://raw.githubusercontent.com/example/read-excel/v1.2.3/skills/read-excel/SKILL.md'
const content = Buffer.from('---\ndescription: read workbook\n---\n# Read Excel\n')
const sha256 = createHash('sha256').update(content).digest('hex')

const response = () => new Response(content, { status: 200, headers: { 'content-length': String(content.byteLength) } })
const base = {
  fileUrls: { [path]: url },
  expectedHashes: { [path]: sha256 },
  allowedOrigins: ['https://raw.githubusercontent.com'],
  fetchImpl: async (requested) => {
    if (requested !== url) throw new Error(`unexpected URL: ${requested}`)
    return response()
  }
}

const files = await fetchSkillFiles(base)
if (files.length !== 1 || files[0].path !== path || files[0].sha256 !== sha256) throw new Error('固定 Skill 文件读取结果不正确')

let mismatch = false
try { await fetchSkillFiles({ ...base, expectedHashes: { [path]: 'a'.repeat(64) } }) } catch (error) { mismatch = error instanceof SkillSourceError && error.code === 'hash-mismatch' }
if (!mismatch) throw new Error('Skill hash 漂移没有 fail-closed')

let crossOrigin = false
const redirected = response()
Object.defineProperty(redirected, 'url', { value: 'https://evil.example/skill.md' })
try { await fetchSkillFiles({ ...base, fetchImpl: async () => redirected }) } catch (error) { crossOrigin = error instanceof SkillSourceError && error.code === 'redirect-origin' }
if (!crossOrigin) throw new Error('Skill 跨来源跳转没有被拒绝')

let manifestMismatch = false
try { await fetchSkillFiles({ ...base, expectedHashes: {} }) } catch (error) { manifestMismatch = error instanceof SkillSourceError && error.code === 'hash-manifest' }
if (!manifestMismatch) throw new Error('Skill URL / hash manifest 不一致没有被拒绝')

console.log('skill-source tests: ok')
