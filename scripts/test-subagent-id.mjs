import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'yan-subagent-id-'))
try {
  const outfile = join(dir, 'id.mjs')
  await build({ entryPoints: ['src/shared/subagent-id.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { normalizeSubagentId } = await import(pathToFileURL(outfile).href)

  assert.equal(normalizeSubagentId('sub-a1b2c3d4'), 'sub-a1b2c3d4')
  assert.equal(normalizeSubagentId('  sub-a1  '), 'sub-a1', '两侧空白去掉')
  assert.equal(normalizeSubagentId('sub-ABC-1'), 'sub-ABC-1', '历史 id 的字母与连字符仍可读')
  assert.equal(normalizeSubagentId('sub/../etc'), null, '不含路径分隔符')
  assert.equal(normalizeSubagentId('sub-..'), null, '不含点号')
  assert.equal(normalizeSubagentId('other-a1'), null, '必须是 sub- 前缀')
  assert.equal(normalizeSubagentId('sub-'), null, '子代理 id 不能只有前缀')
  assert.equal(normalizeSubagentId(''), null)
  assert.equal(normalizeSubagentId(undefined), null)
  assert.equal(normalizeSubagentId(42), null)

  console.log('test-subagent-id: 通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
