import assert from 'node:assert/strict'
import { mkdtemp, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkflow } from '../integrations/comfyui/raw.mjs'

const base = await mkdtemp(join(tmpdir(), 'comfy-out-'))
const cwd = join(base, 'project')
const outside = join(base, 'outside')
const { mkdir } = await import('node:fs/promises')
await mkdir(cwd); await mkdir(outside)
await symlink(outside, join(cwd, 'link'), 'junction')
const server = { baseUrl: 'http://127.0.0.1:9' }
const prompt = { 1: { class_type: 'X', inputs: {} } }
await assert.rejects(readWorkflow(server, { prompt, outPath: 'link/a.json' }, { cwd }), /项目目录内/)
assert.deepEqual(await readdir(outside), [], '符号链接目标目录里没有被写入')
const ok = await readWorkflow(server, { prompt, outPath: 'sub/a.json' }, { cwd })
assert.ok(ok.savedTo.endsWith('a.json'))
console.log('comfyui outPath ok')
process.exit(0)
