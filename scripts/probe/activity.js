/**
 * 活动行为与上下文装配（实施-25 P05 / T05-3）—— 真实窗口里走一遍。
 *
 * 覆盖核心验收：**研究结论的引用能跳回原文**。链路：
 *   日常 + 研究 → 导入一份资料 → 加入对话 → 读本轮装配结果
 *   → 引用带 sourceId + version + 字符区间 → 按区间取回原文字节一致。
 *
 * 同时钉住两条边界：
 *   · 没加入对话的资料**不进**上下文（不凭空带资料）；
 *   · 切回 `coding` 后装配为空（不残留日常的来源片段），与「coding 不注入角色」同源。
 *
 * ⚠️ 这里用的是「与扩展快照同源的装配结果」（`yan:context:current`），
 * 快照本体的写读往返由 `test-context-assembly.mjs` 钉住。
 * 真实模型是否照着引用写结论需要额度，本场景为 cost 0，不跑模型。
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

  log('=== 1. 日常 + 研究活动 ===')
  const modeSwitch = null /* 左栏拨杆已移除（实施-27 B3）：模式入口在设置 · 工作区 */
  const dailyBtn = [...(modeSwitch?.querySelectorAll('button') ?? [])].find((b) => /日常/.test(b.textContent))
  if (dailyBtn) {
    click(dailyBtn)
    await sleep(600)
  }
  window.__yanStore.setState({ workspaceMode: 'daily' })
  await sleep(300)
  ok(S().workspaceMode === 'daily', '已切到日常模式', String(S().workspaceMode))

  const profileBtn = q('[data-testid="agent-profile-button"]')
  if (profileBtn) {
    click(profileBtn)
    await sleep(250)
    click(q('[data-testid="agent-profile-option-research"]'))
    await sleep(450)
  }
  ok(S().agentProfile?.profile === 'daily' && S().agentProfile?.activity === 'research', '活动 = 日常 · 研究', JSON.stringify(S().agentProfile))

  log('=== 2. 导入一份资料并加入对话 ===')
  const body = '第一节：预算按字符计。\n第二节：引用必须绑定版本。\n第三节：结论要能回到原文。'
  const imported = await S().importToLibrary({
    kind: 'text',
    ref: 'p05-probe-note',
    title: 'P05 探针笔记',
    content: body
  })
  ok(imported?.ok === true && !!imported.sourceId, '导入成功', JSON.stringify(imported))
  if (!imported?.ok || !imported.sourceId) return out.join('\n')
  const ref = { sourceId: imported.sourceId, version: imported.version }
  const joined = await S().joinLibraryRef(ref)
  ok(joined === true, '加入对话（登记会话引用）')

  log('=== 3. 本轮装配带上来源，且引用可回到原文 ===')
  const assembly = await S().currentContext()
  ok(!!assembly, '拿到本轮装配结果')
  if (!assembly) return out.join('\n')
  const sourceFragments = assembly.fragments.filter((f) => f.section === 'sources')
  ok(sourceFragments.length >= 1, '装配出「来源片段」', String(sourceFragments.length))
  const citation = assembly.citations.find((c) => c.sourceId === ref.sourceId)
  ok(!!citation, '引用指向刚加入的那份资料')
  if (citation) {
    ok(citation.version === ref.version, '引用绑定的是登记的那一版', String(citation.version))
    ok(!!citation.locator, '引用带字符区间（否则跳不回原文）')
    const opened = await S().openLibraryRef(ref, 100_000)
    const sliced = (opened?.text ?? '').slice(citation.locator.start, citation.locator.end)
    const fragmentText = assembly.fragments.find((f) => f.section === 'sources')?.text ?? ''
    ok(sliced !== '' && sliced === fragmentText, '按引用区间取回的正文与注入片段逐字一致（「跳回原文」）', `${sliced.length} vs ${fragmentText.length}`)
  }

  log('=== 4. 没加入对话的资料不进上下文 ===')
  const other = await S().importToLibrary({
    kind: 'text',
    ref: 'p05-probe-unjoined',
    title: '未加入对话的资料',
    content: '这份资料没有登记为会话引用，不应该出现在上下文里。'
  })
  if (other?.ok) {
    const after = await S().currentContext()
    const leaked = after?.citations.some((c) => c.sourceId === other.sourceId)
    ok(!leaked, '没有登记的引用不会被带进上下文')
  } else {
    log('  · 第二份资料导入失败，跳过该断言')
  }

  log('=== 5. 切回 coding：装配为空（不残留日常上下文） ===')
  if (profileBtn) {
    click(profileBtn)
    await sleep(250)
    click(q('[data-testid="agent-profile-option-coding"]'))
    await sleep(450)
  }
  ok(S().agentProfile?.profile === 'coding', '切回代码档案')
  const codingAssembly = await S().currentContext()
  ok((codingAssembly?.citations.length ?? 0) === 0, 'coding 会话不注入来源片段', JSON.stringify(codingAssembly?.citations))
  ok((codingAssembly?.fragments.length ?? 0) === 0, 'coding 会话装配为空（保持 pi 原生行为）')

  return out.join('\n')
})()
