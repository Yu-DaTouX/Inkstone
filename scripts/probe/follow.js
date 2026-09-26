/**
 * 持续关注与提醒（实施-25 P16）—— 真实窗口里走「建关注 → 只填不发 → 提议 → 启用 → 回报」。
 *
 * 盯住四件事：
 *   · 卡片上写明「关注只在砚开着的时候看」（不承诺已跟进）；
 *   · 「现在看一下」**只填不发**（不自动开始做，也不自动代学）；
 *   · 模型提议的关注**不启用**就不出现在到点里；
 *   · 回报之后能看到上次结果，且运行记录落盘。
 *
 * cost 0：全程不发模型消息（点关注只写输入框）。
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
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
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

  log('=== 1. 空间概览里的持续关注 ===')
  const modeSwitch = null /* 左栏拨杆已移除（实施-27 B3）：模式入口在设置 · 工作区 */
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  const space = await S().createSpace('探针空间（关注）')
  ok(!!space, '建空间成功', space?.id)
  if (!space) return out.join('\n')

  click(q('[data-testid="view-space"]'))
  await sleep(600)
  ok(!!q('[data-testid="space-ov-follow-card"]'), '空间概览里有「持续关注」卡')
  const note = q('[data-testid="space-follow-note"]')
  ok(!!note && /应用没开/.test(String(note.textContent ?? '')), '卡上写明「应用没开的那段时间不会被跟进」', String(note?.textContent ?? '').slice(0, 40))
  ok(!/已跟进/.test(String(note?.textContent ?? '')), '没有「已跟进」这种承诺')

  log('=== 2. 自己建一个关注 ===')
  /* 先清掉可能残留的关注（本探针自己建的） */
  for (const w of await yan.follow.list(space.id)) {
    if (w.title.startsWith('探针') || w.title.startsWith('看 README')) await yan.follow.remove(w.id)
  }
  await S().refreshFollows(space.id)
  await sleep(300)

  click(q('[data-testid="space-follow-new"]'))
  await sleep(400)
  setInput(q('[data-testid="space-follow-new-title"]'), '看 README 有没有变')
  await sleep(150)
  setInput(q('[data-testid="space-follow-new-kind"]'), 'files')
  await sleep(150)
  setInput(q('[data-testid="space-follow-new-every"]'), '1440')
  await sleep(150)
  setInput(q('[data-testid="space-follow-new-place"]'), '写到成果：项目变更')
  await sleep(150)
  click(q('[data-testid="space-follow-new-save"]'))
  await sleep(1200)
  const mine = (await yan.follow.list(space.id)).find((w) => w.title === '看 README 有没有变')
  ok(!!mine, '关注建好了', mine?.id)
  if (!mine) return out.join('\n') + '\n✗ 关注没建上'
  ok(mine.enabled === true, '用户自己建的关注是启用的')
  ok(!!q(`[data-testid="space-follow-${mine.id}"]`), '列表里能看到它')
  ok(/下次/.test(String(q(`[data-testid="space-follow-status-${mine.id}"]`)?.textContent ?? '')), '状态显示「下次 …」', String(q(`[data-testid="space-follow-status-${mine.id}"]`)?.textContent ?? ''))

  log('=== 3. 点关注只把「该看什么」填进输入框 ===')
  const before = (S().messages ?? []).length
  click(q(`[data-testid="space-follow-open-${mine.id}"]`))
  await sleep(800)
  const box = String(q('[data-testid="composer"]')?.value ?? '')
  ok(/按这个关注看一遍/.test(box), '输入框里出现「按这个关注看一遍」', box.slice(0, 30))
  ok(/结果记到：写到成果/.test(box), '说明里带上结果记到哪')
  ok(/应用没开/.test(box), '说明里带上「应用没开不跟进」')
  ok(/没有变化 \/ 有变化 \/ 需要我定 \/ 没看成/.test(box), '要求回报四种结局之一')
  ok((S().messages ?? []).length === before && S().session?.isStreaming !== true, '没有发出任何消息（只填不发）')

  log('=== 4. 模型提议的关注：不启用就不进到点 ===')
  const proposed = await yan.follow.save({
    title: '探针提议：上游有没有新版本',
    kind: 'sources',
    cadence: 'once',
    resultPlace: '概览里记一笔',
    origin: 'agent',
    enabled: false
  })
  ok(proposed?.ok === true && proposed.watch?.enabled === false, '提议存下来是未启用', JSON.stringify(proposed?.watch?.enabled))
  await S().refreshFollows(space.id)
  await sleep(500)
  ok(!!q(`[data-testid="space-follow-proposed-${proposed.watch.id}"]`), '卡片上标出「这是 agent 提的，还没启用」')
  const dueIds = (await yan.follow.due()).map((w) => w.id)
  ok(!dueIds.includes(proposed.watch.id), '它不在到点列表里（用户没启用）')
  ok(!!q(`[data-testid="space-follow-enable-${proposed.watch.id}"]`), '有「开始关注」按钮')

  log('=== 5. 启用后才到点，回报之后看得到上次结果 ===')
  click(q(`[data-testid="space-follow-enable-${proposed.watch.id}"]`))
  await sleep(1200)
  ok((await yan.follow.list(space.id)).find((w) => w.id === proposed.watch.id)?.enabled === true, '启用成功')
  ok((await yan.follow.due()).some((w) => w.id === proposed.watch.id), '一次性关注启用后就在到点里（还没看过）')

  const reported = await yan.follow.report({
    watchId: proposed.watch.id,
    outcome: 'needs-decision',
    summary: '上游发了 v2，改了三处接口',
    changed: ['接口 A 的返回多了 status 字段'],
    decisions: ['要不要跟到 v2']
  })
  ok(reported?.ok === true, '回报一次结果', reported?.error)
  await S().refreshFollows(space.id)
  await sleep(600)
  const lastText = String(q(`[data-testid="space-follow-last-${proposed.watch.id}"]`)?.textContent ?? '')
  ok(/需要你定/.test(lastText) && /上游发了 v2/.test(lastText), '卡片上显示上次结果', lastText)
  ok(/等你定/.test(lastText), '把「需要你定」的事列出来')
  ok(!(await yan.follow.due()).some((w) => w.id === proposed.watch.id), '看过之后不再到点（一次性关注结束）')
  ok((await yan.follow.runs({ watchId: proposed.watch.id })).length === 1, '运行记录落盘')

  log('=== 6. 停用 / 删掉 ===')
  click(q(`[data-testid="space-follow-pause-${mine.id}"]`))
  await sleep(1200)
  ok((await yan.follow.list(space.id)).find((w) => w.id === mine.id)?.enabled === false, '停用成功')
  click(q(`[data-testid="space-follow-remove-${mine.id}"]`))
  await sleep(1200)
  await yan.follow.remove(proposed.watch.id)
  await S().refreshFollows(space.id)
  await sleep(400)
  ok(!(await yan.follow.list(space.id)).some((w) => w.id === mine.id || w.id === proposed.watch.id), '两个关注都删掉了')
  return out.join('\n')
})()
