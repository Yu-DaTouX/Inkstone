/**
 * 交接事务执行器（实施-05 S5b-3b）。
 *
 * 这一片全是「顺序与失败」：先停源再建目的、链只在会话建好后写、
 * `resumed` 只认磁盘证据、失败回源、崩溃恢复的三种处置。
 * 一个都不能靠「跑一次真 Electron 看看」来验 —— 真链路里
 * 崩在中间的那几个窗口几乎不可能复现，而它们的后果（两侧同时干活）最严重。
 *
 * 用法：npm run test:unit
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runHandoffRunnerTests(ok, runnerModule, transactionService, chainService, handoffShared) {
  console.log('\n--- 实施-05 S5b-3b 交接执行器（顺序 / 失败 / 恢复） ---')

  const SOURCE = 'C:/s/a.jsonl'
  const DEST = 'C:/s/b.jsonl'

  const pkgFor = (over = {}) =>
    handoffShared.sanitizeHandoffPackage(
      { goal: '把导入做快', deliverable: '一个可用的导入', nextActions: ['加批量'], ...over },
      { sourceSession: SOURCE, sourceHead: 'm-1', mode: 'autonomous', model: 'x', now: 5 }
    )

  /**
   * 假依赖的最小实现。
   *
   * `events` 记下**外部动作的顺序** —— 本片的核心断言就是顺序：
   * 停源必须在建目的之前、链必须在目的会话拿到文件之后、send 必须在链之后。
   */
  const harness = async (opts = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'yan-handoff-runner-'))
    const transactions = new transactionService.HandoffTransactionStore({ root })
    const chains = new chainService.SessionChainStore({ root })
    const events = []
    const files = new Map()
    const runFiles = new Map()
    let seq = 0
    const notices = []

    const deps = {
      transactions,
      chains,
      stopRunner: async (id) => {
        events.push(`stop:${id}`)
        runFiles.delete(id)
        return true
      },
      openSession: async (target) => {
        if (opts.openSession) return opts.openSession(target, { events, files, runFiles })
        if (target.sessionFile) {
          const runId = `r-switch-${++seq}`
          events.push(`open:switch:${target.sessionFile}`)
          runFiles.set(runId, target.sessionFile)
          return { ok: true, runId, sessionFile: target.sessionFile }
        }
        const runId = `r-new-${++seq}`
        events.push('open:new')
        runFiles.set(runId, DEST)
        return { ok: true, runId, sessionFile: DEST }
      },
      send: async (runId, text) => {
        events.push(`send:${runId}`)
        if (opts.send) return opts.send(runId, text, { files, runFiles })
        /* 真实 pi 的行为：消息落进会话文件（这里就是“磁盘证据”） */
        const file = runFiles.get(runId)
        if (file) files.set(file, `${files.get(file) ?? ''}\n${text}\n`)
        return { ok: true }
      },
      readSessionText: async (path) => files.get(path) ?? null,
      notify: (message, type) => notices.push({ message, type }),
      /* 实施-14 F3：目的片段建好后、发 resume 之前的继承回调（默认只记顺序） */
      shouldActivate: opts.shouldActivate
        ? (sourceRunId) => {
            events.push(`activate-ask:${sourceRunId}`)
            return opts.shouldActivate(sourceRunId)
          }
        : undefined,
      onDestinationReady: async (info) => {
        events.push(`dest-ready:${info.sessionFile}`)
        if (opts.onDestinationReady) await opts.onDestinationReady(info, { events })
      },
      now: () => 1000,
      /* 默认“立刻拿到证据”：真实链路的轮询由 live 场景覆盖 */
      pollEvidence: opts.pollEvidence ?? (async (probe) => probe())
    }
    const runner = new runnerModule.HandoffRunner(deps)
    return { root, transactions, chains, events, files, runFiles, notices, runner, deps, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  const commitInput = (h, over = {}) => ({
    handoffId: 'h-1',
    sourceRunId: 'r-src',
    sourceSession: SOURCE,
    cwd: 'C:/work',
    projectId: 'p-1',
    pkg: pkgFor(),
    ...over
  })

  for (const boundary of ['before-stop', 'after-open', 'after-inherit']) {
    let allowed = boundary !== 'before-stop'
    const h = await harness({ onDestinationReady: async () => { if (boundary === 'after-inherit') allowed = false } })
    if (boundary === 'after-open') {
      const open = h.deps.openSession
      h.deps.openSession = async (target) => { const result = await open(target); allowed = false; return result }
    }
    try {
      const result = await h.runner.commit(commitInput(h, { canContinue: () => allowed }))
      ok(!result.ok, `用户停止在 ${boundary} 边界使交接失效`)
      ok(!h.events.some((event) => event.startsWith('send:')), `${boundary} 不发送自动续接`)
      if (boundary === 'before-stop') ok(h.events.length === 0, '暂停目标不停止源实例、不创建新会话')
      if (boundary === 'after-open') ok(h.events.includes('stop:r-new-1'), '停止创建中的交接会清理未提交目的实例')
    } finally { await h.cleanup() }
  }

  /* --------------------------------------------------- 1. 成功路径与顺序 */

  {
    const h = await harness()
    try {
      const res = await h.runner.commit(commitInput(h))
      ok(res.ok, '成功路径整体 ok')
      ok(res.stage === 'resumed', `走到底停在 resumed（实际 ${res.stage}）`)
      ok(res.destinationSession === DEST, '返回了目的会话文件')

      const order = h.events.map((e) => e.split(':').slice(0, 2).join(':'))
      ok(order[0] === 'stop:r-src', '第一步是停源实例（释放同 cwd 租约）')
      ok(order[1] === 'open:new', '第二步才是建目的会话（不绕过同 cwd 防线）')
      const iSend = h.events.findIndex((e) => e.startsWith('send:'))
      ok(iSend >= 2, 'resume 在链之后才发（顺序：停源 → 建会话 → 链 → 发）')

      const chain = h.chains.chainOf(SOURCE)
      ok(chain?.segments.length === 2, '会话链有一条、两段（前端据此显示一条会话）')
      ok(chain.segments[1].sessionFile === DEST && chain.segments[1].handoffId === 'h-1', '第二段是目的会话且记了交接 id')

      const tx = h.transactions.get('h-1')
      ok(tx.stage === 'resumed' && tx.destinationSession === DEST, '事务日志也记到了 resumed + 目的会话')
      ok(tx.steps.length === 5, `五个前进步骤都留了日志（实际 ${tx.steps.length}）`)
      ok(tx.steps.every((s, i, all) => i === 0 || all[i - 1].to === s.from), '步骤日志首尾相连，没有跳步')
      /*
       * 文案口径（实施-14 F5）：用户要的是「无感」——不再提「交接」这件事，
       * 只说「上下文已整理，正在继续」。所以断言跟的是这条可读提示，
       * 不是旧版的「交接完成」（旧文案已被有意替换）。
       */
      ok(
        h.notices.some((n) => n.type === 'info' && /上下文已整理/.test(n.message)),
        '给用户留了一句可读的完成提示'
      )
    } finally {
      await h.cleanup()
    }
  }

  /* --------------------------------------------------- 2. 幂等 */

  {
    const h = await harness()
    try {
      const first = await h.runner.commit(commitInput(h))
      const second = await h.runner.commit(commitInput(h))
      ok(first.ok && second.ok, '重放同一 handoffId 仍然 ok')
      ok(h.events.filter((e) => e === 'open:new').length === 1, '重放不会建第二个目的会话')
      ok(h.events.filter((e) => e.startsWith('send:')).length === 1, '重放不会重发 resume')
      ok(h.chains.chainOf(SOURCE).segments.length === 2, '重放不会把链拉长（追加幂等）')
    } finally {
      await h.cleanup()
    }
  }

  /* --------------------------------------------------- 3. 建目的会话失败 → 回源 */

  {
    const h = await harness({
      openSession: async (target, ctx) => {
        if (!target.sessionFile) return { ok: false, error: '同一工作目录已有运行中的会话' }
        ctx.events.push(`open:switch:${target.sessionFile}`)
        return { ok: true, runId: 'r-back', sessionFile: target.sessionFile }
      }
    })
    try {
      const res = await h.runner.commit(commitInput(h))
      ok(!res.ok && res.stage === 'failed', '建目的失败 → 事务 failed')
      ok(h.events.includes(`open:switch:${SOURCE}`), '失败把视图交还源会话（未提交回源）')
      ok(!h.events.some((e) => e.startsWith('send:')), '没有发任何 resume（宁可没交接，也不能两边都在干）')
      ok(h.chains.chainOf(SOURCE) === null, '没写链（目的会话不存在，写了会让侧栏指向空气）')
      ok(h.notices.some((n) => n.type === 'warning' && /交接没有完成/.test(n.message)), '给用户一句可读的失败提示')
    } finally {
      await h.cleanup()
    }
  }

  /* --------------------------------------------------- 4. 链写不成 → 失败且不发 resume */

  {
    const h = await harness()
    try {
      /* 目的会话已经在另一条链上 → `link` 拒绝（返回那条链），必须被认成失败 */
      await h.chains.link('C:/s/other.jsonl', DEST, 'h-other')
      const res = await h.runner.commit(commitInput(h))
      ok(!res.ok && res.stage === 'failed', '链写不成 → failed（不假装提交）')
      ok(!h.events.some((e) => e.startsWith('send:')), '链没成就一定没发 resume')
      ok(h.transactions.get('h-1').error?.includes('会话链'), '事务里记下了可读原因')
    } finally {
      await h.cleanup()
    }
  }

  /* --------------------------------------------------- 5. 发送失败 / 证据未到 → 停在 committed */

  for (const [label, send, pollEvidence, expect] of [
    ['发送失败', async () => ({ ok: false, error: 'pi 未就绪' }), undefined, 'pi 未就绪'],
    ['证据未到', undefined, async () => false, '没在会话文件里看到证据']
  ]) {
    const h = await harness({ send, pollEvidence })
    try {
      const res = await h.runner.commit(commitInput(h))
      ok(!res.ok && res.stage === 'committed', `${label} → 停在 committed（不是 failed）`)
      const tx = h.transactions.get('h-1')
      ok(tx.stage === 'committed', `${label} → 事务日志也停在 committed`)
      ok(h.chains.chainOf(SOURCE).segments.length === 2, `${label}：链已经写了（提交已经发生）`)
      ok(res.error?.includes(expect), `${label}：错误说得清是哪一步（${res.error}）`)
    } finally {
      await h.cleanup()
    }
  }

  /* --------------------------------------------------- 6. 崩溃恢复 */

  {
    const h = await harness()
    try {
      /* ① committed + 有证据 → 补记完成，不重发 */
      await h.transactions.begin({ handoffId: 'h-done', sourceSession: SOURCE, resumeId: 'h-done' })
      await h.transactions.step('h-done', 'snapshot')
      await h.transactions.setPackage('h-done', pkgFor())
      await h.transactions.setDestination('h-done', DEST)
      await h.transactions.step('h-done', 'destination-created')
      await h.transactions.step('h-done', 'committed')
      ok(h.transactions.get('h-done').stage === 'committed', '夹具：h-done 停在 committed')
      h.files.set(DEST, '老内容\n[yan-handoff-resume:h-done]\n')

      /* ② committed + 无证据 → 重发一次 */
      await h.transactions.begin({ handoffId: 'h-resend', sourceSession: 'C:/s/c.jsonl', resumeId: 'h-resend' })
      await h.transactions.step('h-resend', 'snapshot')
      await h.transactions.setPackage('h-resend', pkgFor())
      await h.transactions.setDestination('h-resend', 'C:/s/d.jsonl')
      await h.transactions.step('h-resend', 'destination-created')
      await h.transactions.step('h-resend', 'committed')
      await h.chains.link('C:/s/c.jsonl', 'C:/s/d.jsonl', 'h-resend')

      /* ③ destination-created（没提交）→ 回源 */
      await h.transactions.begin({ handoffId: 'h-early', sourceSession: 'C:/s/e.jsonl', resumeId: 'h-early' })
      await h.transactions.step('h-early', 'snapshot')
      await h.transactions.setPackage('h-early', pkgFor())
      await h.transactions.setDestination('h-early', 'C:/s/f.jsonl')
      await h.transactions.step('h-early', 'destination-created')
      ok(h.transactions.get('h-early').stage === 'destination-created', '夹具：h-early 停在 destination-created')

      /* ④ 已经重发过一次（attempts=2）仍无证据 → 不再自动重发 */
      await h.transactions.begin({ handoffId: 'h-twice', sourceSession: 'C:/s/g.jsonl', resumeId: 'h-twice' })
      await h.transactions.step('h-twice', 'snapshot')
      await h.transactions.setPackage('h-twice', pkgFor())
      await h.transactions.setDestination('h-twice', 'C:/s/h.jsonl')
      await h.transactions.step('h-twice', 'destination-created')
      await h.transactions.step('h-twice', 'committed')
      await h.chains.link('C:/s/g.jsonl', 'C:/s/h.jsonl', 'h-twice')
      await h.transactions.noteResumeAttempt('h-twice')
      await h.transactions.noteResumeAttempt('h-twice')
      ok(h.transactions.get('h-twice').resumeAttempts === 2, '夹具：h-twice 已经发过两次')

      const actions = await h.runner.recover()
      const byId = Object.fromEntries(actions.map((a) => [a.handoffId, a]))
      ok(byId['h-done']?.action === 'complete' && byId['h-done'].stage === 'resumed', '有证据 → 补记 resumed')
      ok(
        byId['h-resend']?.action === 'complete' && byId['h-resend'].stage === 'resumed',
        '没证据 → 重发一次，拿到证据后补记 resumed'
      )
      ok(h.transactions.get('h-resend').resumeAttempts === 1, '重发计入尝试次数（下次不会又当成从没发过）')
      ok(byId['h-early']?.action === 'abandon' && byId['h-early'].stage === 'failed', '没提交 → 记 failed 回源')
      ok(
        byId['h-twice']?.action === 'none' && h.transactions.get('h-twice').stage === 'committed',
        '已重发过一次仍无证据 → 不再自动重发（不盲发两遍）'
      )
      ok(h.transactions.get('h-done').stage === 'resumed', '恢复结果落盘了')
      ok(h.events.filter((e) => e.startsWith('send:')).length === 1, '重发只在没证据的那条上发生一次（消费去重）')
      ok(h.events.includes('open:switch:C:/s/e.jsonl'), '未提交的那条把视图交还源会话')

      /* 终态事务不再被恢复碰 */
      ok(h.transactions.get('h-early').steps.at(-1).to === 'failed', 'failed 是终态')
      const sendsBefore = h.events.filter((e) => e.startsWith('send:')).length
      const again = await h.runner.recover()
      ok(
        h.events.filter((e) => e.startsWith('send:')).length === sendsBefore,
        '第二次恢复不再重发任何 resume（不盲发两遍）'
      )
      ok(
        again.length === 1 && again[0].handoffId === 'h-twice' && again[0].action === 'none',
        '只剩「已重发过、仍在等证据」的那条事务，且它不再动作'
      )
    } finally {
      await h.cleanup()
    }
  }

  /* --------------------------------------------------- 7. 落盘失败 → 抛，不假装成功 */

  {
    const h = await harness()
    try {
      const failing = new transactionService.HandoffTransactionStore({ root: h.root })
      await failing.load()
      /* 让日志文件变成一个目录：rename 一定失败 */
      const { mkdir } = await import('node:fs/promises')
      await mkdir(transactionService.handoffTransactionDocumentPath(h.root), { recursive: true })
      const runner = new runnerModule.HandoffRunner({ ...h.deps, transactions: failing })
      let threw = false
      try {
        await runner.commit(commitInput(h, { handoffId: 'h-bad' }))
      } catch {
        threw = true
      }
      ok(threw, '事务日志落盘失败时抛错（交接宁可停下，也不能「内存里提交了、磁盘没有」）')
    } finally {
      await h.cleanup()
    }
  }

  /* --------------------------- 8. 实施-14 F3：继承时机与「后台不抢视图」 */

  {
    /* 继承必须比 resume 早：晚一步就会让目的片段第一轮按默认档 / 空目标起步 */
    const h = await harness()
    try {
      const res = await h.runner.commit(commitInput(h))
      ok(res.ok === true, 'F3：提交成功（继承时机用例的前置）')
      const iReady = h.events.findIndex((e) => e.startsWith('dest-ready:'))
      const iSend = h.events.findIndex((e) => e.startsWith('send:'))
      ok(iReady >= 0 && iSend >= 0 && iReady < iSend, 'F3：用户级状态在发 resume 之前继承（不是提交之后补写）')
    } finally {
      await h.cleanup()
    }
  }

  {
    /* 后台交接（用户正在看别的会话）不能把当前选中抢过去 */
    const opens = []
    const h = await harness({
      shouldActivate: () => false,
      openSession: async (target, ctx) => {
        opens.push(target.activate === false ? 'false' : 'true')
        const runId = 'r-new-x'
        ctx.runFiles.set(runId, DEST)
        return { ok: true, runId, sessionFile: DEST }
      }
    })
    try {
      const res = await h.runner.commit(commitInput(h))
      ok(res.ok === true, 'F3：后台交接仍然能完成')
      ok(opens[0] === 'false', 'F3：源不是当前选中会话时，目的片段不抢选中（activate: false）')
    } finally {
      await h.cleanup()
    }
  }

  {
    /* 缺省（源就是用户正在看的）：保持旧行为，激活目的片段 */
    const opens = []
    const h = await harness({
      openSession: async (target, ctx) => {
        opens.push(target.activate === false ? 'false' : 'true')
        const runId = 'r-new-y'
        ctx.runFiles.set(runId, DEST)
        return { ok: true, runId, sessionFile: DEST }
      }
    })
    try {
      await h.runner.commit(commitInput(h))
      ok(opens[0] === 'true', 'F3：没有 shouldActivate 时保持原行为（激活目的片段）')
    } finally {
      await h.cleanup()
    }
  }

  {
    /*
     * 顺序：激活判定必须在停源**之前**问。
     * `stopRunner` 之后 `activeRunnerId` 已经不是源了 —— 晚问一步就会
     * 让新建的目的实例永远不被激活（现场：交接后 getGoal/getHandoff 全读到空壳）。
     */
    const h = await harness({ shouldActivate: () => true })
    try {
      await h.runner.commit(commitInput(h))
      const iAsk = h.events.findIndex((e) => e.startsWith('activate-ask:'))
      const iStop = h.events.findIndex((e) => e.startsWith('stop:'))
      ok(iAsk >= 0 && iStop >= 0 && iAsk < iStop, 'F3：激活判定发生在停源之前（否则目的实例永远不被激活）')
    } finally {
      await h.cleanup()
    }
  }

  ok(typeof runnerModule.resumeSummary(pkgFor(), 'rs-1') === 'string', 'resumeSummary 给出一行可读摘要')
}
