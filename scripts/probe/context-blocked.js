/**
 * 「整理失败停下 + 一键出口」（第 2 项）的界面回归网。
 *
 * 要修的问题：整理失败后，用户消息**能发出去**，但会在下一次请求前被
 * `ctx.abort()` 掐断 —— 表现为「消息发出去了、没有回复」，而且每轮都白跑一次。
 * 用户看不到任何「为什么」，也没有出口，只能自己手动去抬软线。
 *
 * 探针职责（真实 Electron + 真实主进程 IPC；现场由 Node 侧种好）：
 *   ① 整理停在 `needs_action`，且确定性失败标成「不可直接重试」；
 *   ② 新消息在**发出去之前**就被拦下，理由里给出三个出口
 *      （不是「发出去了没回复」—— 那是修之前的行为）；
 *   ③ 界面上明说会被拦下，并且三个出口按钮都在；
 *   ④ 点「降档」逐档下降，且把那笔停住的整理标成 `superseded`
 *      —— 只改档位不销账，阻塞不会解除，所以这两件事必须一起验。
 *
 * cost 0：消息被拦下了，不会真的发出去；全程不调模型。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const button = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (button) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(600)

  /* ---- 1. 切到种子会话：那笔「停住」的整理挂在它身上 ---- */
  out.push('=== 1. 整理停在待处理 ===')
  const target = (S().sessions ?? []).find((s) => /yan-plain-fixture/.test(String(s.path ?? s.file ?? '')))
  ok(!!target, '找到种子会话', String(target?.path ?? ''))
  if (target) {
    await S().switchSession(target.path)
    await sleep(2500)
  }
  ok(!!S().session?.sessionId, '切换后当前会话可用', String(S().session?.sessionId ?? ''))

  const op = await window.yan.contextBudgetMaintenanceStatusV1().catch(() => null)
  ok(op?.state === 'needs_action', '整理停在 needs_action', op ? `state=${op.state} code=${op.failureCode}` : '没有记录')
  ok(op?.retryable === false, '确定性失败标成「不可直接重试」，不让用户白点一次')

  /* ---- 2. 拦下发生在「发送之前」 ---- */
  out.push('')
  out.push('=== 2. 拦下发生在发送之前 ===')
  const send = await window.yan.send('这条消息应该被拦下，不会真的发出去。')
  ok(send?.ok === false, 'send 被拒绝（修之前是「发出去了、没回复」）', String(send?.error ?? ''))
  ok(
    /重试整理|临时抬软线|降档/.test(String(send?.error ?? '')),
    '拒绝理由里给出三个出口，而不只是「不能发」',
    String(send?.error ?? '')
  )

  /* ---- 3. 界面：明说会被拦下 + 三个出口都在 ---- */
  out.push('')
  out.push('=== 3. 界面给出三个出口 ===')
  /*
   * 走真实用户路径：设置窗口 → 上下文页。
   * 注意别把「右侧面板的上下文分区」（`rp-context`，看的是 ContextDetails）
   * 当成 ContextTab —— 三个出口在**设置页**里。
   */
  S().openSettings?.('context')
  await sleep(800)
  let panelReady = false
  for (let i = 0; i < 20; i++) {
    if (q('[data-testid="ctx-budget-v1-maintenance"]')) {
      panelReady = true
      break
    }
    await sleep(500)
  }
  ok(panelReady, '上下文设置页已渲染出整理状态块')
  ok(!!q('[data-testid="ctx-budget-v1-blocked"]'), '界面明说「新消息会被拦下」')
  ok(!!q('[data-testid="ctx-budget-v1-maintenance-retry"]'), '有「重试整理」出口')
  ok(!!q('[data-testid="ctx-budget-v1-exit-raise"]'), '有「临时抬软线」出口')
  ok(!!q('[data-testid="ctx-budget-v1-exit-lower"]'), '有「降档」出口')
  ok(!!q('[data-testid="ctx-background-usage"]'), '后台调用用量栏位也在这一页（第 1 项的界面入口）')

  /* ---- 4. 点「临时抬软线」：写的是临时覆盖 + 那笔整理作废 ---- */
  out.push('')
  out.push('=== 4. 点「临时抬软线」：临时覆盖 + 销账 ===')
  const before = await window.yan.contextBudgetV1()
  const beforePhase = before?.phases?.[before.activePhaseId]
  q('[data-testid="ctx-budget-v1-exit-raise"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(2500 /* 主进程要写覆盖 + 迁移那笔记录，界面再回读刷新 */)

  const after = await window.yan.contextBudgetV1()
  const afterPhase = after?.phases?.[after.activePhaseId]
  ok(
    afterPhase?.temporaryBudgetOverride?.selectedBudget === 500_000,
    '抬线写进临时覆盖（300K → 500K，逐档）',
    `override=${afterPhase?.temporaryBudgetOverride?.selectedBudget ?? 'null'}`
  )
  ok(
    afterPhase?.selectedBudget === beforePhase?.selectedBudget,
    '基础档**没被动过**（到期才知道要回落）',
    `${beforePhase?.selectedBudget} → ${afterPhase?.selectedBudget}`
  )
  ok((afterPhase?.temporaryBudgetOverride?.expiresAt ?? 0) > Date.now(), '带一个未来的到期时间（会自动回落）')
  ok(!!q('[data-testid="ctx-budget-v1-temporary-raise"]'), '界面显示「临时抬线中 + 到期时间」')

  const afterOp = await window.yan.contextBudgetMaintenanceStatusV1().catch(() => null)
  ok(afterOp?.state === 'superseded', '停住的那笔整理被标成 superseded（销账）', afterOp ? `state=${afterOp.state}` : 'null')
  ok(
    afterOp?.state !== 'needs_action',
    '阻塞判定的依据已消失（不再有 needs_action 的记录挡着新消息）'
  )
  ok(!q('[data-testid="ctx-budget-v1-blocked"]'), '界面上的阻塞提示随之消失')

  /* ---- 5. 降档是持久的，并把临时抬线一起取消 ---- */
  out.push('')
  out.push('=== 5. 降档：有效档降一档，取消临时抬线 ===')
  const lowered = await window.yan.contextBudgetMaintenanceExitV1({
    action: 'lower-tier',
    expectedRevision: after.revision
  })
  ok(lowered?.ok === true, '降档调用成功', String(lowered?.error ?? ''))
  await sleep(800)
  const settled = await window.yan.contextBudgetV1()
  const settledPhase = settled?.phases?.[settled.activePhaseId]
  ok(
    settledPhase?.selectedBudget === 300_000,
    '基础档落在 500K 的下一档（300K）',
    `base=${settledPhase?.selectedBudget}`
  )
  ok(!settledPhase?.temporaryBudgetOverride, '临时抬线被取消（不留一条超过基础档的覆盖）')

  return out.join('\n')
})()
