/* Native context presentation: unknown usage, model identity, breakdown and busy controls. */
;(async () => {
  const out = [], store = window.__yanStore
  const ok = (v, label) => out.push(`  ${v ? '✓' : '✗'} ${label}`)
  const q = s => document.querySelector(s)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const original = { session: store.getState().session, stats: store.getState().stats, messages: store.getState().messages }
  try {
    localStorage.setItem('yan.onboarded', '1')
    store.getState().closeSettings()
    store.setState({ session: { ...original.session, model: { ...original.session.model, contextWindow: 262144 }, isStreaming: false, isAgentRunning: false }, messages: [{ id: 'ctx-user', role: 'user', text: 'Context fixture' }] })
    const usage = tokens => store.setState({ stats: { ...original.stats, contextUsage: { tokens, contextWindow: 262144, percent: tokens === null ? null : tokens/262144*100 } } })
    usage(null); await sleep(200)
    q('[data-testid="composer-context"]')?.click(); await sleep(200)
    ok(!!q('[role="dialog"].ui-detail-popover'), '上下文圆环打开真实详情浮层')
    ok(q('[data-testid="ctx-tokens"]')?.textContent === '—', '压缩后未知用量显示—，不冒充0')
    ok(!!q('[data-testid="ctx-unknown"]'), '压缩后提示下一次消息重新统计')
    usage(128000); await sleep(200)
    const text = q('[data-testid="ctx-tokens"]')?.textContent ?? ''
    ok(text.includes('128k') && text.includes('262.1k') && text.includes('49%'), '总量与百分比使用原生模型窗口')
    ok(q('[data-testid="ctx-main"]')?.dataset.mode === 'window', '使用窗口视角')
    ok(!q('[data-testid="ctx-unknown"]'), '已知用量不显示压缩后未知提示')
    ok(!!q('[data-testid="ctx-breakdown"] .free'), '分类图例包含剩余空间')
    ok(!!q('.ui-usage-bar[aria-label="已用 49%"]'), '用量条提供可读数值')
    store.setState({ session: { ...store.getState().session, contextPolicy: { enabled: true, budget: { workingSet: 183501 } } } }); await sleep(150)
    ok(q('[data-testid="ctx-main"]')?.dataset.mode === 'window', '旧会话宿主预算字段不改变原生窗口分母')
    ok(!q('[data-testid="ctx-working-set-line"]') && !q('[data-testid="ctx-stage-mark"]'), '退役工作集与宿主阶段刻度不再出现')
    store.setState({ stats: { ...store.getState().stats, contextUsage: { tokens: 128000, contextWindow: 262144, modelKey: 'other/model' } } }); await sleep(150)
    ok(q('[data-testid="ctx-tokens"]')?.textContent === '—', '其他模型的迟到用量不能投影到当前模型')
    store.setState({ session: { ...store.getState().session, isCompacting: true } }); await sleep(150)
    ok(q('[data-testid="rp-compact-now"]')?.disabled === true, '正在压缩时不能重复启动手动压缩')
    store.setState({ session: { ...store.getState().session, isCompacting: false } }); await sleep(150)
    ok(q('[data-testid="rp-compact-now"]')?.disabled === false, '空闲会话可手动压缩')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(150)
    ok(!q('[role="dialog"].ui-detail-popover'), 'Escape关闭详情')
  } catch (error) { ok(false, error.stack ?? String(error)) }
  finally { store.setState(original) }
  return out.join('\n')
})()
