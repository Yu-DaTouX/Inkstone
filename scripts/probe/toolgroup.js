/** 命令块表：短组逐行可见，七步及以上默认只留失败步骤，点开查看完整历史。 */
;(async () => {
  const out = []
  const ok = (condition, label) => { out.push((condition ? '  ✓ ' : '  ✗ ') + label); return !!condition }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const qa = (selector) => [...document.querySelectorAll(selector)]
  const click = (element) => element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  /* 过程入口默认折叠时工具行**不在 DOM 里**，断言之前先铺开（见 toolrow.js 里的说明）。 */
  const openProcess = async () => {
    for (let i = 0; i < 25; i++) {
      const toggle = q('[data-testid="turn-process-toggle"]')
      if (toggle) {
        if (toggle.getAttribute('aria-expanded') === 'false') {
          click(toggle)
          await sleep(300)
        }
        return !!q('.trow')
      }
      await sleep(200)
    }
    return false
  }
  const tool = (id, status) => ({ id, name: 'bash', args: { command: `echo ${id}` }, status, output: `${id}: done` })
  const inject = async (tools, suffix) => {
    store.setState({
      messages: [
        { id: `u-group-${suffix}`, role: 'user', text: '运行命令' },
        { id: `a-group-${suffix}`, role: 'assistant', text: '', toolCalls: tools }
      ],
      streamingId: tools.some((item) => item.status === 'running') ? `a-group-${suffix}` : undefined
    })
    await sleep(350)
    await openProcess()
    return q('[data-testid="tool-group"]')
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 40 && (!q('.stream') || !store.getState().settings); i++) await sleep(200)
    await store.getState().patchSettings({ toolDetail: false, toolDetailExplicit: true })

    out.push('=== 短组：命令块表直接展示 ===')
    const short = await inject([tool('one', 'ok'), tool('two', 'error'), tool('three', 'running')], 'short')
    ok(!!short, '工具组存在')
    ok(qa('.tgroup .trow').length === 3, '短组三条都逐行可见')
    ok(!q('[data-testid="tool-group-toggle"]'), '短组不再需要额外展开')
    ok(!!q('.tgroup .trow[data-state="running"] .ui-run-dot'), '运行行使用静态 RunDot')
    ok(!q('.tgroup .ui-spin'), '工具表没有第二个方点阵')

    out.push('\n=== 长组：默认只留失败步骤 ===')
    const many = [tool('m1', 'error'), ...Array.from({ length: 6 }, (_, index) => tool(`m${index + 2}`, 'ok'))]
    const long = await inject(many, 'long')
    ok(!!long && long.dataset.count === '7', '工具组记录七步')
    ok(qa('.tgroup .trow').length === 1, '默认只显示失败步骤')
    const fold = q('[data-testid="tool-group-toggle"]')
    ok(fold?.getAttribute('aria-expanded') === 'false', '较早步骤默认收起')
    ok(!!q('.trow[data-state="error"]'), '失败步骤始终可见')
    click(fold)
    await sleep(250)
    ok(qa('.tgroup .trow').length === 7, '展开后七步可逐行查看')
    click(q('[data-testid="tool-group-collapse"]'))
    await sleep(250)
    ok(qa('.tgroup .trow').length === 1, '收起后保留失败步骤')

    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
