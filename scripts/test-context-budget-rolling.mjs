/** Historical archive search remains available after host maintenance retirement. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runContextArchiveFindTests(ok, { recall }) {
  const dir = mkdtempSync(join(tmpdir(), 'yan-cb-rolling-'))
  const prevDataDir = process.env.YAN_DATA_DIR
  process.env.YAN_DATA_DIR = dir
  try {
    const sessionId = 'rolling-session'
    /* ---- 4. 归档检索 ---- */
    const stateDir = join(dir, 'context-state')
    mkdirSync(stateDir, { recursive: true })
    const now = Date.now()
    const entry = (id, label, extra = {}) => ({
      ref: `ctx://tool/${id}`,
      kind: 'tool',
      label,
      createdAt: now - Number(id.replace(/\D/g, '')) * 1000,
      tokens: 100,
      recallable: 'agent',
      sourceRange: { from: id, to: id },
      watermark: { entryCount: 1, lastEntryId: id },
      contentStored: false,
      ...extra
    })
    writeFileSync(join(stateDir, `${sessionId}.archive.json`), JSON.stringify({
      schemaVersion: 1,
      sessionId,
      updatedAt: now,
      entries: [
        entry('e1', 'tool result: npm run build failed with TS2322 in agent.ts'),
        entry('e2', 'decided to keep pi RPC as the execution core'),
        entry('e3', 'tool result: npm run build passed'),
        entry('e4', 'expired build log', { expiresAt: now - 1 }),
        entry('e5', 'manual-only build note', { recallable: 'manual' })
      ]
    }))
    const found = await recall.findArchivedContext({ sessionId, query: 'build npm', stateDir })
    const refs = found.data.matches.map((match) => match.ref)
    ok(refs.length === 2 && refs.includes('ctx://tool/e1') && refs.includes('ctx://tool/e3'), `关键词全部命中才算匹配（${refs.join(', ')}）`)
    ok(!refs.includes('ctx://tool/e4') && !refs.includes('ctx://tool/e5'), '过期与不允许模型回读的条目不出现')
    ok(refs[0] === 'ctx://tool/e1', '结果按时间倒序')
    ok(Array.isArray(found.summary.matches) && found.summary.matches[0].includes('ctx://tool/e1'), 'stdout 摘要直接带上结果')
    const recent = await recall.findArchivedContext({ sessionId, stateDir, limit: 1 })
    ok(recent.data.matches.length === 1 && recent.data.total === 3, '省略 --query 时列出最近归档（受 limit 约束）')
    const missing = await recall.findArchivedContext({ sessionId: 'no-archive', stateDir })
    ok(missing.data.matches.length === 0 && missing.data.archived === 0, '没有归档时返回空结果而不是报错')
  } finally {
    if (prevDataDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = prevDataDir
    rmSync(dir, { recursive: true, force: true })
  }
}
