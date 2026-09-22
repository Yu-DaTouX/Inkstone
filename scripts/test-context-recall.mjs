/**
 * 宿主侧归档回读（`yan context recall` → `src/main/context-recall.ts`）的确定性覆盖。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组断言从哪来
 * ══════════════════════════════════════════════════════════════════
 * 归档回读以前是薄层里的一个模型工具（`context_recall`），它的确定性覆盖写在同一份
 * `test-context-transform.mjs` 里（直接调工具的 `execute`）。实施-01 S5 收口时把回读
 * 入口迁到宿主 CLI，薄层不再注册任何模型工具 —— **能力边界不变，执行者变了**：
 *   · 原文仍来自当前会话的原始 JSONL（不是归档副本）；
 *   · 单次 / 累计预算仍然拒绝并解释，不静默截断；
 *   · 召回量与回合号仍记进同一份账本，成功 / 拒绝仍写审计；
 *   · 包装头仍是 `[Recalled context] turn=<n> ref=<ref>` —— 薄层的 TTL 钩子按它清理。
 * 所以这里覆盖的正是「迁到宿主后这几条还在不在」，而不是复述实现。
 *
 * ══════════════════════════════════════════════════════════════════
 * 刻意不 mock 的东西
 * ══════════════════════════════════════════════════════════════════
 * 会话文件、归档元数据、账本、审计都是真文件（隔离在 mkdtemp 目录里）——这条链路的
 * 价值就在于「跨进程读盘的身份与边界」，全换成内存假对象就什么都没验到。
 * 唯一的替身是 `request.stateDir`（生产态是 `YAN_DATA_DIR/context-state`）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION_ID = 'recall01'
const BIG = `原文-${'A'.repeat(4000)}-尾部`
const RECALL_HEAD = '[Recalled context] turn='

export async function runContextRecallTests(ok, { recall, store }) {
  const root = await mkdtemp(join(tmpdir(), 'yan-context-recall-'))
  const stateDir = join(root, 'context-state')
  const sessionId = SESSION_ID
  const sessionFile = join(root, `${sessionId}.jsonl`)
  const ledgerFile = join(stateDir, `${sessionId}.recall.json`)
  const auditFile = join(stateDir, `${sessionId}.recall.jsonl`)
  const envBefore = process.env.YAN_CONTEXT_POLICY

  const writeSession = async (headerId = sessionId) => {
    const lines = [
      JSON.stringify({ type: 'session', id: headerId, ts: 1 }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '读一下大文件' }] } }),
      JSON.stringify({ type: 'message', id: 'm2', message: { role: 'toolResult', content: [{ type: 'text', text: BIG }] } }),
      JSON.stringify({ type: 'message', id: 'm3', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } })
    ]
    await writeFile(sessionFile, `${lines.join('\n')}\n`, 'utf8')
  }

  const archiveEntry = (ref, over = {}) => ({
    ref,
    kind: 'tool',
    label: 'read',
    createdAt: Date.now(),
    tokens: 1000,
    recallable: 'agent',
    sourceRange: { from: 'm2', to: 'm2' },
    watermark: { entryCount: 3, lastEntryId: 'm3' },
    contentStored: false,
    ...over
  })

  const writeArchive = async (entries) => {
    await store.saveArchive({ schemaVersion: 1, sessionId, updatedAt: Date.now(), entries }, { dir: stateDir })
  }

  const call = (over = {}) =>
    recall.recallArchivedContext({ sessionId, sessionFile, ref: 'ctx://tool/m2', stateDir, ...over })

  const failure = async (fn) => {
    try {
      await fn()
      return null
    } catch (error) {
      return error
    }
  }

  const readAudits = async () => {
    const text = await readFile(auditFile, 'utf8')
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }

  try {
    await writeSession()
    await writeArchive([archiveEntry('ctx://tool/m2')])

    /* ---------------- A. 正常召回：原文来自会话本身 ---------------- */
    const first = await call({ reason: '需要那段输出的细节' })
    ok(first.resultText.startsWith(`${RECALL_HEAD}1 ref=ctx://tool/m2`), '召回包装头是薄层 TTL 认得的形状', JSON.stringify(first.resultText.slice(0, 60)))
    ok(first.resultText.includes(BIG.slice(0, 40)), '返回的是会话里的原文（不是归档副本）')
    ok(first.summary.tokens > 0 && first.summary.turn === 1, '摘要给出 token 与回合号', JSON.stringify(first.summary))

    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'))
    ok(ledger.activeTokens === first.summary.tokens && ledger.turn === 1, '召回量计入活动账本', JSON.stringify(ledger))

    const audits = await readAudits()
    ok(
      audits.length === 1 && audits[0].result === 'ok' && audits[0].by === 'agent' && audits[0].ref === 'ctx://tool/m2',
      '成功召回写审计（时间 / 大小 / 发起方 / ref）',
      JSON.stringify(audits[0])
    )
    ok(audits[0].reason === '需要那段输出的细节', '审计保留调用方给的理由（可追溯到为什么读）')

    /* ---------------- B. 非法 ref / 缺条目 / 三态 / 过期 ---------------- */
    ok((await failure(() => call({ ref: 'not-a-ref' })))?.code === 'context_recall_invalid_ref', '非法 ref 被拒')
    ok((await failure(() => call({ ref: 'ctx://tool/nope' })))?.code === 'context_recall_missing', '归档里没有的 ref 被拒')

    await writeArchive([archiveEntry('ctx://tool/m2', { recallable: 'manual' })])
    ok((await failure(call))?.code === 'context_recall_forbidden', 'recallable=manual 时模型不能取回（三态语义）')

    await writeArchive([archiveEntry('ctx://tool/m2', { expiresAt: Date.now() - 1000 })])
    ok((await failure(call))?.code === 'context_recall_expired', '过期的归档不可召回')

    /* ---------------- C. 预算：拒绝而不是截断 ---------------- */
    await writeArchive([archiveEntry('ctx://tool/m2')])
    await rm(ledgerFile, { force: true })
    await rm(auditFile, { force: true })

    process.env.YAN_CONTEXT_POLICY = JSON.stringify({ recall: { maxTokensPerCall: 10 } })
    const tooLarge = await failure(call)
    ok(tooLarge?.code === 'context_recall_rejected' && tooLarge.message.includes('10'), '超单次上限 → 拒绝并给出上限数字', tooLarge?.message)
    ok(!String(tooLarge?.message ?? '').includes(BIG.slice(0, 40)), '拒绝时不泄漏半份原文（也不静默截断）')
    const rejected = await readAudits()
    ok(
      rejected.length === 1 && rejected[0].result === 'rejected' && rejected[0].reason === 'too-large',
      '拒绝也写审计（否则「一直被拒」看不见）',
      JSON.stringify(rejected[0])
    )
    const rejectedLedger = await failure(() => readFile(ledgerFile, 'utf8'))
    ok(rejectedLedger !== null, '被拒绝的召回不预扣账本额度（账本不会被写出来）')

    process.env.YAN_CONTEXT_POLICY = JSON.stringify({ recall: { maxActiveRecallTokens: 1 } })
    ok((await failure(call))?.code === 'context_recall_rejected', '累计超限 → 拒绝')
    delete process.env.YAN_CONTEXT_POLICY

    /* ---------------- D. 账本累加与并发串行 ---------------- */
    await rm(ledgerFile, { force: true })
    const [a, b] = await Promise.all([call(), call()])
    const after = JSON.parse(await readFile(ledgerFile, 'utf8'))
    ok(a.summary.tokens === b.summary.tokens, '两次召回读到的是同一份原文尺寸', `${a.summary.tokens} / ${b.summary.tokens}`)
    ok(
      after.activeTokens === a.summary.tokens * 2,
      '并发召回串行落账本，累计额度不丢（各读各的旧值就会只加一次）',
      JSON.stringify(after)
    )

    /* ---------------- E. 身份与原文入口都不能由调用方指定 ---------------- */
    ok((await failure(() => call({ sessionFile: join(root, 'nope.jsonl') })))?.code === 'context_session_unreadable', '原始记录不可读 → 拒绝')
    await writeSession('another-session')
    ok((await failure(call))?.code === 'context_session_mismatch', '会话文件身份与请求会话不一致 → 拒绝')
    await writeSession()

    await writeArchive([archiveEntry('ctx://tool/zzz')])
    ok((await failure(() => call({ ref: 'ctx://tool/zzz' })))?.code === 'context_entry_missing', '归档有元数据但原始记录里找不到 → 不返回半份正文')

    /* ---------------- F. 归档元数据缺失 / 损坏 ---------------- */
    await rm(join(stateDir, `${sessionId}.archive.json`), { force: true })
    ok((await failure(call))?.code === 'context_archive_missing', '没有归档元数据 → 拒绝（不猜）')
  } finally {
    if (envBefore === undefined) delete process.env.YAN_CONTEXT_POLICY
    else process.env.YAN_CONTEXT_POLICY = envBefore
    await rm(root, { recursive: true, force: true })
  }
}
