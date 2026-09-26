/**
 * 按需获取能力（实施-25 P17）—— 真实窗口里走「说需求 → 拿到可执行路径」。
 *
 * 盯住三件事：
 *   · 说得清的需求 → 给场景化路径（含具体命令），**不是报错**；
 *   · 认不出的需求 → 给通用三步，**不编包名**；
 *   · 路径可以一键填进输入框（**只填不发**）。
 *
 * cost 0：这里只跑纯规则 + 渲染，不联网、不装任何东西。
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

  const setInput = (el, value) => {
    if (!el) return false
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
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

  for (let i = 0; i < 24; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  log('=== 1. 能力页的「按需求找能力」 ===')
  S().openSettings('capabilities')
  await sleep(1200)
  ok(!!q('[data-testid="cap-need"]'), '能力页有「按需求找能力」区块')
  ok(!!q('[data-testid="cap-need-input"]'), '有输入框')
  ok(q('[data-testid="cap-need-run"]')?.disabled === true, '没输入时按钮不可点')

  log('=== 2. 说得清的需求：给可执行的接入路径 ===')
  setInput(q('[data-testid="cap-need-input"]'), '我要把 PDF 里的表格做成汇总')
  await sleep(300)
  ok(q('[data-testid="cap-need-run"]')?.disabled !== true, '输入之后按钮可点')
  click(q('[data-testid="cap-need-run"]'))
  await sleep(900)
  const text = String(q('[data-testid="cap-need-text"]')?.textContent ?? '')
  ok(!!text, '拿到了结果')
  ok(/缺的能力：/.test(text), '先说缺什么', text.split('\n')[1] ?? '')
  ok(/yan capabilities search --query-text/.test(text), '给出第一步命令（search）')
  ok(/yan capabilities prepare --candidate/.test(text) && /yan capabilities acquire --candidate/.test(text), '给出 prepare → acquire')
  ok(/yan capabilities discover/.test(text), '给出去联网找的兜底')
  ok(!/已安装|已接入/.test(text), '没有「已安装」这种承诺')
  ok(!/报错|失败/.test(text), '给的是路径而不是报错')

  log('=== 3. 认不出的需求：不编包名 ===')
  setInput(q('[data-testid="cap-need-input"]'), '把两台打印机连起来')
  await sleep(300)
  click(q('[data-testid="cap-need-run"]'))
  await sleep(900)
  const generic = String(q('[data-testid="cap-need-text"]')?.textContent ?? '')
  ok(/不猜该装什么/.test(generic), '明说「不猜该装什么」', generic.slice(0, 24))
  ok(/capabilities search/.test(generic) && /capabilities discover/.test(generic), '通用三步里仍然给了 search / discover')
  ok(!/npm install|pip install/.test(generic), '不编具体安装命令')
  ok(!q('[data-testid="cap-need-have"]'), '认不出的需求不会说「你已经有这个能力了」')

  log('=== 4. 一键填进输入框（只填不发） ===')
  const before = (S().messages ?? []).length
  click(q('[data-testid="cap-need-send"]'))
  await sleep(600)
  const box = String(q('[data-testid="composer"]')?.value ?? '')
  ok(/capabilities search/.test(box), '路径被填进输入框', box.slice(0, 24))
  ok((S().messages ?? []).length === before && S().session?.isStreaming !== true, '没有发出任何消息（只填不发）')

  S().closeSettings?.()
  await sleep(300)
  return out.join('\n')
})()
