/**
 * 内部 agent 分工 —— 会话流里子代理卡片的信息分层（界面重构后的契约）。
 *
 * 盯住三件事：
 *   · 顺利完成、没有待处理改动的卡片只有主行与元信息，不再铺摘要；
 *   · 需要人处理的卡片（例如待合并）才展开「结论 / 已产出」摘要，悬停可看全文；
 *   · 还没结束的任务**不显示摘要**（不制造「它已经有结论了」的错觉）。
 *
 * cost 0：不启动真实子代理（那会花额度），这里走的是渲染端真实渲染路径，
 * 数据用注入的 run —— 汇总本身的规则由 `test:unit` 的纯函数断言钉住。
 * 「要交回什么 / 来源与成果计数」两行已随界面重构撤下，不再断言。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  await sleep(300)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 24; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  log('=== 1. 卡片的信息分层 ===')
  const sessionId = S().session?.sessionId ?? 'probe-session'
  const startedAt = Date.now() - 90_000
  const base = (over) => ({
    cwd: 'C:/yan-worktrees/sub-probe',
    parentSessionId: sessionId,
    isolation: 'worktree',
    model: 'probe/model',
    status: 'running',
    startedAt,
    review: 'none',
    transcript: [],
    ...over
  })
  window.__yanStore.setState({
    subagents: [
      base({
        id: 'sub-probe-summary',
        task: '查一下两个模块的错误处理是否一致',
        status: 'done',
        endedAt: startedAt - 2_000,
        review: 'none',
        latestActivity: '读完了两个文件',
        brief: {
          goal: '摸清两个模块的错误处理是否一致',
          deliverables: ['一段结论', '不一致的具体位置'],
          sources: ['src/main/agent.ts', 'src/main/index.ts'],
          boundary: '只读，不要改代码'
        },
        result: {
          summary: '两处读法不一致：agent.ts 把错误吞掉只记一行日志，index.ts 直接往上抛。',
          summaryTruncated: false,
          summaryFrom: 'last-message',
          sources: ['src/main/agent.ts', 'src/main/index.ts'],
          artifacts: ['docs/design/preview/error-notes.md'],
          openQuestions: [],
          at: startedAt - 2_000
        }
      }),
      base({
        id: 'sub-probe-review',
        task: '把两个模块的错误处理统一一下',
        status: 'done',
        endedAt: startedAt - 1_000,
        review: 'pending',
        diff: { files: 2, additions: 10, deletions: 3, paths: ['src/a.ts'], patchPath: null, truncated: false },
        result: {
          summary: '已把 agent.ts 的吞错改成向上抛，index.ts 保持不变。',
          summaryTruncated: false,
          summaryFrom: 'last-message',
          sources: [],
          artifacts: [],
          openQuestions: [],
          at: startedAt - 1_000
        }
      }),
      base({ id: 'sub-probe-running', task: '把设置页的说明整理一遍', latestActivity: '正在读文件' })
    ]
  })
  await sleep(600)

  ok(!!q('[data-testid="subagent-group"]'), '会话里有子代理卡片')
  ok(!!q('[data-testid="subagent-note-sub-probe-summary"]'), '顺利完成的子代理有一张卡片')
  ok(/完成/.test(String(q('[data-testid="subagent-note-state-sub-probe-summary"]')?.textContent ?? '')), '状态词是「完成」')
  ok(!q('[data-testid="subagent-note-summary-sub-probe-summary"]'), '顺利完成的卡片不铺摘要（只留主行与元信息）')

  log('=== 2. 需要处理的卡片才展开摘要 ===')
  const summaryEl = q('[data-testid="subagent-note-summary-sub-probe-review"]')
  ok(!!summaryEl, '待合并的卡片显示摘要')
  ok(/向上抛/.test(String(summaryEl?.textContent ?? '')), '摘要内容在', String(summaryEl?.textContent ?? '').slice(0, 30))
  ok(/agent.ts/.test(String(summaryEl?.title ?? '')), 'title 上有摘要全文（卡片上只显示一行）')
  ok(!!q('[data-testid="subagent-note-merge-sub-probe-review"]'), '待合并的卡片给出「合并」')

  log('=== 3. 还在跑的任务不显示摘要 ===')
  ok(!q('[data-testid="subagent-note-summary-sub-probe-running"]'), '运行中的子代理没有摘要行（不制造「已经有结论了」的错觉）')

  /* 清理：把注入的卡片拿掉，别把假数据留给下一个场景 */
  window.__yanStore.setState({ subagents: [] })
  await sleep(300)
  ok(!q('[data-testid="subagent-group"]'), '清掉注入后卡片消失')
  return out.join('\n')
})()
