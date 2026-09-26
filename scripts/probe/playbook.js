/**
 * 办事模板（实施-25 P14）—— 真实窗口里走「看模板 → 摊开范围 → 填范围 → 只填不发」。
 *
 * 盯住三件事：
 *   · **写步骤没范围就拒掉**（存新模板与复用两个入口都要挡住）；
 *   · **复用前把范围摊开**：占位没换掉时「填到输入框」不可点；
 *   · **只填不发**：点完只把说明放进输入框，不发送、不执行、不写任何文件。
 *
 * cost 0：全程不发模型消息（点「填到输入框」只写 store 的待插入槽）。
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
  const yan = window.yan

  const setInput = (el, value) => {
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 24; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  log('=== 1. 空间概览里的办事模板 ===')
  const modeSwitch = q('[data-testid="mode-switch"]')
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  const space = await S().createSpace('探针空间（模板）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  click(q('[data-testid="view-space"]'))
  await sleep(500)
  ok(!!q('[data-testid="space-ov-playbook-card"]'), '空间概览里有「办事模板」卡')
  await sleep(600)
  ok(!!q('[data-testid="space-pb-item-pb_seed_files"]'), '三个起步模板在列表里（整理文件）')
  ok(!!q('[data-testid="space-pb-item-pb_seed_digest"]'), '起步模板：汇总材料')
  ok(!!q('[data-testid="space-pb-item-pb_seed_rewrite"]'), '起步模板：改写内容')
  ok(S().playbooks.length >= 3 && S().playbooks.every((p) => p.seeded), '列表里的模板都标着「起步模板」')

  log('=== 2. 复用前把范围摊开（T14-3） ===')
  click(q('[data-testid="space-pb-item-pb_seed_files"]'))
  await sleep(1200)
  ok(!!q('[data-testid="space-pb-zone-pb_seed_files"]'), '点开模板展开确认区')
  const confirm = q('[data-testid="space-pb-confirm"]')
  ok(!!confirm && /会改东西 2 步/.test(String(confirm.textContent ?? '')), '说明会改几步', String(confirm?.textContent ?? ''))
  ok(/确认之前不会动任何东西/.test(String(confirm?.textContent ?? '')), '说明写明「确认之前不动」')
  ok(!!q('[data-testid="space-pb-step-0"]'), '列出全部步骤（含只读）')
  ok(!!q('[data-testid="space-pb-unanswered"]'), '占位还没换掉：如实说「还有 N 步没写清范围」')
  ok(q('[data-testid="space-pb-use"]')?.disabled === true, '范围没填完时「填到输入框」不可点')

  /* 范围组数与需要确认的步骤数对不上：宿主报错，不猜 */
  const badScope = await yan.playbook.plan({ id: 'pb_seed_files', scopes: [['docs']] })
  ok(badScope?.ok === false && badScope.code === 'bad_scope', '少给范围组：报错而不是猜', String(badScope?.error))

  log('=== 3. 填上真实范围 → 才能用 ===')
  ok(!!q('[data-testid="space-pb-scope-0"]'), '确认区里有范围输入框')
  setInput(q('[data-testid="space-pb-scope-0"]'), 'docs/notes')
  await sleep(200)
  setInput(q('[data-testid="space-pb-scope-1"]'), '变更记录成果')
  await sleep(200)
  click(q('[data-testid="space-pb-recheck"]'))
  await sleep(1200)
  ok(!q('[data-testid="space-pb-unanswered"]'), '填完范围后不再报「没写清」')
  const filled = q('[data-testid="space-pb-confirm"]')
  ok(/docs\/notes/.test(String(filled?.textContent ?? '')), '确认文案换成用户给的真实范围', String(filled?.textContent ?? ''))
  ok(q('[data-testid="space-pb-use"]')?.disabled !== true, '「填到输入框」现在可点')

  log('=== 4. 只填不发 ===')
  const messagesBefore = (S().messages ?? []).length
  click(q('[data-testid="space-pb-use"]'))
  await sleep(800)
  /*
   * Composer 已挂载，所以待插入槽会被立刻消费并清空 ——
   * 证据要看**输入框里真的出现了那段说明**。
   */
  const box = q('[data-testid="composer"]')
  const boxText = String(box?.value ?? '')
  ok(/按这个模板做/.test(boxText), '说明被填进了输入框（只填）', boxText.slice(0, 40))
  ok(/只动这几处/.test(boxText) && /docs\/notes/.test(boxText), '说明里写清了边界与范围')
  ok(S().composerInsert === null, '待插入槽已被消费（不会重复插入）')
  ok(!!S().playbooks.find((p) => p.id === 'pb_seed_files')?.runs, '记了一次「开始用」', String(S().playbooks.find((p) => p.id === 'pb_seed_files')?.runs))
  ok((S().messages ?? []).length === messagesBefore, '没有发出任何消息（只填不发）')
  ok(S().session?.isStreaming !== true, '也没有把它变成一轮生成')

  log('=== 5. 模型侧存模板：没有范围的写步骤一律拒掉 ===')
  const noScope = await yan.playbook.save({
    kind: 'custom',
    title: '没写范围的模板',
    goal: '不该被存下来',
    steps: [{ title: '改文件', effect: 'write' }]
  })
  ok(noScope?.ok === false && noScope.code === 'missing_scope', '写步骤没范围：拒掉（不会变成模板）', String(noScope?.error))
  const noSource = await yan.playbook.save({
    kind: 'custom',
    title: '从任务存的模板',
    goal: '缺来源',
    origin: 'from-task',
    steps: [{ title: '读材料', effect: 'read' }]
  })
  ok(noSource?.ok === false && noSource.code === 'missing_source', '说「从任务存的」却没来源：拒掉（不替用户回忆）')

  log('=== 6. 自己写一个（三行文字）+ 删掉 ===')
  click(q('[data-testid="space-pb-new"]'))
  await sleep(400)
  setInput(q('[data-testid="space-pb-new-title"]'), '每周整理下载目录')
  setInput(q('[data-testid="space-pb-new-goal"]'), '把下载目录里的文件归类')
  setInput(q('[data-testid="space-pb-new-steps"]'), '列目录\n移动文件 | 会改')
  await sleep(200)
  click(q('[data-testid="space-pb-new-save"]'))
  await sleep(1200)
  const err = q('[data-testid="space-pb-new-error"]')
  ok(!!err && /作用范围/.test(String(err.textContent ?? '')), '文本里只写「会改」不给范围：给出可读错误', String(err?.textContent ?? ''))

  setInput(q('[data-testid="space-pb-new-steps"]'), '列目录\n移动文件 | 会改 | 下载目录')
  await sleep(200)
  click(q('[data-testid="space-pb-new-save"]'))
  await sleep(1500)
  const mine = S().playbooks.find((p) => p.title === '每周整理下载目录')
  ok(!!mine, '自己写的模板存下来了', mine?.id)
  ok(!!mine && !mine.seeded, '自己写的不算起步模板')
  if (mine) {
    ok(!!q(`[data-testid="space-pb-item-${mine.id}"]`), '列表里能看到它')
    /* 点开它：范围已写清，所以直接可用；删除按钮也只在展开区里 */
    click(q(`[data-testid="space-pb-item-${mine.id}"]`))
    await sleep(1200)
    ok(!!q(`[data-testid="space-pb-zone-${mine.id}"]`), '自己存的模板也能展开确认区')
    ok(q('[data-testid="space-pb-use"]')?.disabled !== true, '范围写清的模板点开即可用')
    ok(!!q('[data-testid="space-pb-remove"]'), '自己存的可以删')
    click(q('[data-testid="space-pb-remove"]'))
    await sleep(1200)
    ok(!S().playbooks.some((p) => p.id === mine.id), '删掉了')
  }

  /* 清理：用过一次的起步模板会落盘（计数），一并收拾 */
  for (const pb of S().playbooks.filter((p) => p.id.startsWith('pb_seed') || p.title === '每周整理下载目录')) {
    await yan.playbook.remove(pb.id)
  }
  await S().refreshPlaybooks(space.id)
  ok(!S().playbooks.some((p) => p.title === '每周整理下载目录'), '清理完成（自己写的删掉了）')
  /* 起步模板删掉落盘那份后，列表里又回到「没用过」的初始形态（这是设计） */
  ok((S().playbooks.find((p) => p.id === 'pb_seed_files')?.runs ?? -1) === 0, '起步模板回到没用过的初始状态')
  return out.join('\n')
})()
