/**
 * 活动档案（实施-25 P01）—— 真实窗口里的切换链路。
 *
 * 为什么必须有这个场景：单元测试能证明「宿主写出的快照正确」「扩展读快照会
 * 注入什么角色」，但证明不了「界面上点得到、点了真的落盘、再读回来还是它」。
 * 这里走 UI → IPC → store → 快照文件的完整链路（cost 0，不发模型请求）。
 *
 * 真角色的差异由注入文本决定，那部分在单测里钉；本场景钉的是**入口与存储**。
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
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(500)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 24; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  /*
   * 入口在「设置 → 工作区」的分段控件里（输入区工具栏上的按钮已撤下）。
   * 选中态用 .sel，档案值在 data-profile。
   */
  log('=== 1. 入口存在且默认是自动 ===')
  S().openSettings?.('workspace')
  await sleep(700)
  const seg = () => q('[data-testid="set-agent-profile"]')
  const opt = (k) => seg()?.querySelector(`[data-profile="${k}"]`)
  if (!seg()) return '✗ 找不到活动档案控件（设置 → 工作区）'
  ok(opt('auto')?.classList.contains('sel'), '默认档案是 auto（由 agent 自行判断）')
  ok(!!opt('auto')?.getAttribute('title'), '选项带说明（title）')

  log('=== 2. 选项 ===')
  const options = ['auto', 'coding', 'answer', 'research', 'compose', 'organize', 'learn']
  ok(
    options.every((k) => !!opt(k)),
    '七个选项都在（自动 + 代码 + 五个日常活动）',
    options.join(',')
  )
  ok(options.every((k) => opt(k)?.tagName === 'BUTTON'), '选项都是真按钮（键盘可达）')

  log('=== 3. 切到「研究」：UI → IPC → 落盘 ===')
  click(opt('research'))
  await sleep(450)
  ok(S().agentProfile?.activity === 'research', 'store 变成 research', JSON.stringify(S().agentProfile))
  const viaIpc = await window.yan.getAgentProfile()
  ok(
    viaIpc.activity === 'research' && viaIpc.revision > 0,
    'IPC 回读一致（提交真的落了盘）',
    JSON.stringify(viaIpc)
  )
  ok(opt('research')?.classList.contains('sel'), '选中态跟着变到「研究」')

  log('=== 4. 切回代码：日常活动被记住 ===')
  click(opt('coding'))
  await sleep(450)
  const back = await window.yan.getAgentProfile()
  ok(back.profile === 'coding', '切回代码档案', JSON.stringify(back))
  ok(back.activity === 'research', '切回代码后上次的日常活动被保留（不用重选）')
  ok(opt('coding')?.classList.contains('sel'), '选中态回到代码')

  return out
})()
