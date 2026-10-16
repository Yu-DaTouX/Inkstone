;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore

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

  let ready = false
  for (let i = 0; i < 60; i++) {
    if (store.getState().session?.model) {
      ready = true
      break
    }
    await sleep(300)
  }
  ok(ready, '真实 pi 已就绪并报告当前模型')
  if (!ready) return out.join('\n')

  let models = 0
  for (let i = 0; i < 60; i++) {
    models = store.getState().models?.length ?? 0
    if (models > 0) break
    if (i === 5) void store.getState().reloadModels?.()
    await sleep(400)
  }
  out.push(`  连接=${store.getState().conn} 模型数=${models}`)
  ok(models > 0, '模型列表已加载（真实 IPC listModels）')

  const picker = q('[data-testid="model-picker"]')
  ok(!!picker, '模型触发器存在')
  if (!picker) return out.join('\n')
  click(picker)
  let menuOpen = false
  for (let i = 0; i < 30; i++) {
    if (q('[data-testid="model-menu"]')) {
      menuOpen = true
      break
    }
    await sleep(150)
  }
  ok(menuOpen, '模型菜单已打开')

  const search = q('[data-testid="model-search"]')
  ok(!!search, '搜索框存在（模型列表已渲染）')
  if (!search) return out.join('\n')

  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const provider=q('[data-testid="models-provider"]');provider.value='';provider.dispatchEvent(new Event('change',{bubbles:true}))
  setValue.call(search, 'v4.1 flash')
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(500)

  const rows = qa('[data-testid="model-option"]').map(el => ({ id: el.dataset.modelId, provider: el.dataset.provider, textContent: el.textContent }))
  out.push('  过滤结果 = ' + JSON.stringify(rows.map((el) => (el.textContent || '').trim())))
  ok(rows.length > 0, '搜索到候选模型行')

  for (const [idx, row] of rows.slice(0, 2).entries()) {
    const label = (row.textContent || '').trim()
    const before = store.getState().session?.model?.id ?? ''
    if(!q('[data-testid="model-menu"]')){click(picker);await sleep(200)}
    const filter=q('[data-testid="models-provider"]');filter.value=row.provider;filter.dispatchEvent(new Event('change',{bubbles:true}))
    const field=q('[data-testid="model-search"]');setValue.call(field,row.id);field.dispatchEvent(new Event('input',{bubbles:true}));await sleep(200)
    click(qa('[data-testid="model-option"]').find(el=>el.dataset.modelId===row.id))
    await sleep(1500)
    const after = store.getState().session?.model?.id ?? ''
    if(!q('[data-testid="model-menu"]')){click(picker);await sleep(200)}
    const details=q('[data-testid="model-thinking-settings"]');if(details&&!details.open)details.querySelector('summary').click()

    out.push('')
    out.push(`=== 点击第 ${idx + 1} 行：${label} ===`)
    out.push(`  模型 ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    ok(after !== before, '点击后模型真的切换了')

    const stopsOf = () => q('[data-testid="thinking-stops"]')
    let hasStops = false
    for (let i = 0; i < 25; i++) {
      if (stopsOf()) {
        hasStops = true
        break
      }
      await sleep(200)
    }
    const labels = stopsOf() ? qa('[data-testid^="thinking-dot-"]').map((b) => b.textContent.trim()) : []
    const status = store.getState().session?.thinkingLevelsStatus
    out.push(`  档位=${JSON.stringify(labels)} status=${JSON.stringify(status)}`)
    ok(hasStops && labels.length > 1, '显示真实档位按钮（不是“上游未提供思考档位信息”）')
    ok(status === 'known', 'thinkingLevelsStatus = known')

    await sleep(3000)
    const labelsLater = stopsOf() ? qa('[data-testid^="thinking-dot-"]').map((b) => b.textContent.trim()) : []
    const statusLater = store.getState().session?.thinkingLevelsStatus
    out.push(`  3s 后 status=${JSON.stringify(statusLater)} 档位数=${labelsLater.length}`)
    ok(statusLater === 'known' && labelsLater.length === labels.length, '3s 多次推送后档位没被清空')

    const menuText = q('[data-testid="model-menu"]')?.textContent ?? ''
    ok(!/上游未提供思考档位信息/.test(menuText), '菜单里没有“上游未提供思考档位信息”')

    if (!q('[data-testid="model-menu"]')) {
      click(q('[data-testid="model-picker"]'))
      await sleep(400)
      const s2 = q('[data-testid="model-search"]')
      if (s2) {
        setValue.call(s2, 'v4.1 flash')
        s2.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(400)
      }
    }
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(200)
  return out.join('\n')
})()
