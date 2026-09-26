/**
 * 内部 agent 分工（实施-25 P15）—— 会话上方的子代理卡片上的
 * 「任务输入」与「结果汇总」两行。
 *
 * 盯住三件事：
 *   · 派活时写清的三样（要交回什么 / 依据什么 / 不许做什么）在卡片上看得见；
 *   · 回来时给主 agent 的摘要与来源 / 成果计数看得见；
 *   · 还没结束的任务**不显示摘要**（不制造「它已经有结论了」的错觉）。
 *
 * cost 0：不启动真实子代理（那会花额度），这里走的是渲染端真实渲染路径，
 * 数据用注入的 run —— 汇总本身的规则由 `test:unit` 的纯函数断言钉住。
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

  log('=== 1. 派活时写清任务输入（T15-1） ===')
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
      base({ id: 'sub-probe-running', task: '把设置页的说明整理一遍', latestActivity: '正在读文件' })
    ]
  })
  await sleep(600)

  ok(!!q('[data-testid="subagent-notes"]'), '会话里有子代理卡片')
  const briefEl = q('[data-testid="subagent-note-brief-sub-probe-summary"]')
  ok(!!briefEl, '看得到「要交回什么」')
  ok(/一段结论/.test(String(briefEl?.textContent ?? '')), '交付物内容在', String(briefEl?.textContent ?? ''))
  ok(/src\/main\/agent\.ts/.test(String(briefEl?.title ?? '')), '来源写进了 title（悬停可看全）')

  log('=== 2. 结果汇总（T15-4） ===')
  const summaryEl = q('[data-testid="subagent-note-summary-sub-probe-summary"]')
  ok(!!summaryEl, '看得到给主 agent 的摘要')
  ok(/两处读法不一致/.test(String(summaryEl?.textContent ?? '')), '摘要内容在', String(summaryEl?.textContent ?? '').slice(0, 30))
  ok(/agent\.ts/.test(String(summaryEl?.title ?? '')), 'title 上有摘要全文（卡片上只显示一行）')
  const metaEl = q('[data-testid="subagent-note-result-sub-probe-summary"]')
  ok(!!metaEl, '看得到来源 / 成果计数')
  ok(/2/.test(String(metaEl?.textContent ?? '')) && /1/.test(String(metaEl?.textContent ?? '')), '计数是 2 个来源 / 1 个成果', String(metaEl?.textContent ?? ''))

  log('=== 3. 还在跑的任务不显示摘要 ===')
  ok(!q('[data-testid="subagent-note-summary-sub-probe-running"]'), '运行中的子代理没有摘要行（不制造「已经有结论了」的错觉）')

  /* 清理：把注入的卡片拿掉，别把假数据留给下一个场景 */
  window.__yanStore.setState({ subagents: [] })
  await sleep(300)
  ok(!q('[data-testid="subagent-notes"]'), '清掉注入后卡片消失')
  return out.join('\n')
})()
