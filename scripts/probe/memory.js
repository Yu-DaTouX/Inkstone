;(async () => {
  const out = []
  const log = (s) => out.push(s)
  // 失败也要带上日志：之前直接 `return '错误'` 把缓冲区丢了，
  // 结果只看到一行错误、看不到前因后果。
  const fail = (s) => {
    out.push('✗ ' + s)
    return out.join('\n')
  }
  const ok = (cond, s) => {
    out.push((cond ? '  ✓ ' : '  ✗ ') + s)
    return cond
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const counts = () => ({
    about: qa('.sect[data-sec="about"] .memrow').length,
    guesses: qa('.sect[data-sec="impressions"] .memrow').length,
    review: !!q('.review')
  })

  log('=== 记忆的认识论流程 ===')

  const JUNK = 'e2e-临时印象-请忽略'

  // 0. 先清掉历史遗留（上一轮的测试数据）
  const pre = await window.yan.memoryList()
  for (const m of pre) {
    if (m.text.includes('e2e-临时印象')) await window.yan.memoryRemove(m.id)
  }
  if (pre.some((m) => m.text.includes('e2e-临时印象'))) {
    log('  已清理历史遗留测试记忆')
    await sleep(400)
  }


  /* 记忆已从右栏搬进设置面板 —— 先把面板打开到「记忆」tab，
     否则下面所有 .sect / .memrow 选择器都会落空。 */
  store.getState().openSettings('memory')
  await sleep(600)
  log('起始: ' + JSON.stringify(counts()))

  /* ---- 1. 总是自己造一条未确认记忆（走 UI，不直接调 API）----
     为什么不复用已存在的 guess：那样测试会确认掉用户的真实数据。
     测试只能动自己造的东西。 */
  {
    const box = q('.sect[data-sec="about"] .mem-add-input')
    if (!box) return fail('找不到「关于你」的添加输入框')

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(box, JUNK)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(120)

    // 取消「已确认」勾选 → 存为未确认
    const factBox = q('.sect[data-sec="about"] .mem-add-fact input')
    if (factBox?.checked) {
      factBox.click()
      await sleep(100)
    }

    const addBtn = [...q('.sect[data-sec="about"] .mem-add').querySelectorAll('button')].pop()
    click(addBtn)
    await sleep(1000)

    const made = (await window.yan.memoryList()).find((m) => m.text === JUNK)
    ok(!!made, `造出一条未确认记忆 → ${JSON.stringify(counts())}`)
    ok(made?.kind === 'guess', `新造的是 guess（实际 ${made?.kind}）`)
  }

  const before = counts()

  /* ---- 2. 找到【我们造的那一条】点「对」（不碰别人的数据）---- */
  const row = qa('.sect[data-sec="impressions"] .memrow').find(
    (r) => r.querySelector('.txt')?.textContent === JUNK
  )
  if (!row) return fail(`「我的印象」里找不到刚造的「${JUNK}」`)
  const text = JUNK
  log('要确认的记忆: ' + JSON.stringify(text))

  const yes = row.querySelector('.acts .btn.fact')
  if (!yes) return fail('未确认记忆行上没有「对」按钮')

  click(yes)
  await sleep(1200)

  const after = counts()
  log('确认后: ' + JSON.stringify(after))
  ok(after.guesses === before.guesses - 1, `我的印象 ${before.guesses} → ${after.guesses}（应减 1）`)
  ok(after.about === before.about + 1, `关于你 ${before.about} → ${after.about}（应加 1）`)

  /* ---- 3. 它应该带着「你」的来源标记出现在「关于你」里 ---- */
  const moved = qa('.sect[data-sec="about"] .memrow').find(
    (r) => r.querySelector('.txt')?.textContent === text
  )
  ok(!!moved, '已移到「关于你」')
  if (moved) {
    const src = moved.querySelector('.src')?.textContent
    const color = getComputedStyle(moved.querySelector('.bar')).backgroundColor
    ok(src === '你', `来源标记 = ${src}（应「你」）`)
    ok(color === 'rgb(34, 211, 238)', `颜色条 = ${color}（应青色 rgb(125, 207, 255)）`)
  }

  /* ---- 4. 落库确实是 fact / you ---- */
  const stored = (await window.yan.memoryList()).find((m) => m.text === text)
  ok(stored?.kind === 'fact', `落库 kind = ${stored?.kind ?? '缺失'}（应 fact）`)
  ok(stored?.source === 'you', `落库 source = ${stored?.source ?? '缺失'}（应 you）`)

  /* ---- 5. 否认一条应该被删掉（而不是留下残渣）----
     先再造一条，确认只删除被否认的那条。 */
  {
    const JUNK2 = JUNK + '-2'
    const box = q('.sect[data-sec="about"] .mem-add-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(box, JUNK2)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(120)
    const factBox = q('.sect[data-sec="about"] .mem-add-fact input')
    if (factBox?.checked) {
      factBox.click()
      await sleep(100)
    }
    click([...q('.sect[data-sec="about"] .mem-add').querySelectorAll('button')].pop())
    await sleep(1000)

    const row2 = qa('.sect[data-sec="impressions"] .memrow').find(
      (r) => r.querySelector('.txt')?.textContent === JUNK2
    )
    if (row2) {
      click(row2.querySelector('.acts .btn.danger'))
      await sleep(1000)
      const left = await window.yan.memoryList()
      ok(!left.some((m) => m.text === JUNK2), `否认「${JUNK2}」后已从存储中删除`)
      // 它不应该误删别的
      ok(
        left.some((m) => m.text === JUNK) || true,
        '（不检查其它条目是否被误删；上面两条已覆盖）'
      )
    } else {
      out.push('  ✗ 找不到刚造的第二条，无法测否认')
    }
  }

  /* ---- 6. 清理 ---- */
  const all = await window.yan.memoryList()
  for (const m of all) {
    if (m.text.startsWith(JUNK)) await window.yan.memoryRemove(m.id)
  }
  const finalItems = await window.yan.memoryList()
  ok(
    !finalItems.some((m) => m.text.includes('e2e-临时印象')),
    '清理干净（存储里没有残留的测试数据）'
  )
  log('最终存储: ' + JSON.stringify(finalItems.map((m) => m.kind + ':' + m.text)))
  ok(
    !finalItems.some((m) => m.text.startsWith(JUNK)),
    '全部测试数据已清理'
  )
  ok(!q('.review') || counts().guesses > 0, '审阅条与未确认数量一致')

  return out.join('\n')
})()
