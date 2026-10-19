import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { evidenceDir, localDay, outputDir } from './lib/evidence-dir.mjs'

const root = resolve('repo-root')
const day = new Date(2026, 9, 20, 23, 59)

assert.equal(localDay(day), '2026-10-20')
assert.equal(localDay(new Date(2026, 0, 5)), '2026-01-05')
assert.equal(evidenceDir(root, 'memory-audit', day), join(root, '.local-docs', 'evidence', '2026-10-20-memory-audit'))
assert.equal(evidenceDir(root, '工作区清点', day), join(root, '.local-docs', 'evidence', '2026-10-20-工作区清点'))
assert.throws(() => evidenceDir(root, '../escape', day))
assert.throws(() => evidenceDir(root, '', day))

assert.equal(outputDir(['--report'], root, 'workspace-audit', day), join(root, '.local-docs', 'evidence', '2026-10-20-workspace-audit'))
assert.equal(outputDir(['--out', 'custom/dir'], root, 'x', day), resolve(root, 'custom/dir'))
const absolute = resolve('elsewhere', 'out')
assert.equal(outputDir(['--report', '--out', absolute], root, 'x', day), absolute)
assert.throws(() => outputDir(['--out'], root, 'x', day))
assert.throws(() => outputDir(['--out', '--report'], root, 'x', day))

for (const file of ['scripts/audit/workspace.mjs', 'scripts/design/showcase/render.mjs', 'scripts/measure-memory.mjs']) {
  const source = readFileSync(file, 'utf8')
  assert.ok(source.includes('evidence-dir.mjs'), `${file} 用 evidence 目录`)
  assert.ok(!/workspace-audits|showcase-2026-09-29|memory-audit-20261012/.test(source), `${file} 不再写 .local-docs 根下的固定子目录`)
}

console.log('test-evidence-dir: ok')
