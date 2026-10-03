/**
 * 排队消息的「插队 / 撤回」在**消息仍在队列时**必须真的成功。
 *
 * 背景（用户 2026-10-03 截图）：agent 跑长工具时发的消息排在队列里，
 * 点「插队」却报「消息已被 pi 接收，无法再插队」。根因是主进程把
 * `clear_queue` 之后 pi 推的**中间帧空队列**当真，覆盖了本地快照，
 * 之后按文本复用 id 的重建拿不到原来的 id，于是把「还在队列里」误判成
 * 「已被接收」（还会白白重建一次队列）。修复见 `AgentController.queueBusy`。
 *
 * 这个场景要一条真正耗时的工具命令（cost 1）：只有工具在跑时，消息才会
 * 稳定地停在 pi 队列里，才谈得上插队与撤回。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  if (!store) return '  ⤺ 跳过：没有 window.__yanStore'

  const st = () => store.getState()
  const queued = (text) => [...st().queue.steering, ...st().queue.followUp].some((i) => i.text === text)
  const steering = (text) => st().queue.steering.some((i) => i.text === text)
  const inChat = (text) => st().messages.some((m) => m.role === 'user' && String(m.text ?? '') === text)
  const notices = () => (st().notices || []).map((n) => n.text).join(' | ')
  const draft = () => q('[data-testid="composer"]')?.value ?? null
  /** 按行内文本找按钮 —— steering / followUp 行都有 queue-retract，不能只取第一个 */
  const rowButton = (text, testId) => {
    const row = [...document.querySelectorAll('[data-testid="queue-row"]')].find((r) =>
      (r.textContent ?? '').includes(text)
    )
    return row ? row.querySelector(`[data-testid="${testId}"]`) : null
  }

  for (let i = 0; i < 30; i++) {
    if (st().conn === 'ready') break
    await sleep(500)
  }
  if (st().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${st().conn}）`

  const ta = q('[data-testid="composer"]')
  if (!ta) return '  ✗ 找不到输入框'

  try {
    setVal(ta, '只做一件事：执行 bash 命令 `sleep 90`，等它结束后回答「完成」。不要执行别的命令。')
    await sleep(200)
    click(q('[data-testid="send"]'))

    let toolRunning = false
    for (let i = 0; i < 120; i++) {
      await sleep(500)
      if (st().messages.flatMap((m) => m.toolCalls ?? []).some((c) => c.status === 'running')) {
        toolRunning = true
        break
      }
    }
    ok(toolRunning, '长工具已经开始执行（sleep 90）')
    if (!toolRunning) return out.join('\n')

    /* ---------- 1. 消息仍在队列时点「插队」 ---------- */
    const A = '插队目标：请把这句话复述一遍'
    await st().send(A)
    await sleep(1500)
    ok(queued(A), 'A 已排队（此时工具还在跑）')

    const steerBtn = rowButton(A, 'queue-steer')
    ok(!!steerBtn, 'A 那一行有「插队」按钮')
    if (steerBtn) {
      click(steerBtn)
      await sleep(2000)
      log('  点插队 → notices = ' + JSON.stringify(notices().slice(-160)))
      ok(!/无法再插队/.test(notices()), '插队没有报「无法再插队」')
      ok(!notices().trim(), '插队成功（没有报错提示）')
      ok(steering(A) || inChat(A), 'A 进入了本轮（插话队列或对话里）')
    }

    /* ---------- 2. 消息仍在队列时点「撤回」 ---------- */
    const B = '撤回目标：这条应该回到输入框'
    await st().send(B)
    await sleep(1500)
    ok(queued(B), 'B 已排队')

    const retractBtn = rowButton(B, 'queue-retract')
    ok(!!retractBtn, 'B 那一行有「撤回」按钮')
    if (retractBtn) {
      click(retractBtn)
      await sleep(2000)
      log('  点撤回 → notices = ' + JSON.stringify(notices().slice(-160)))
      log('  点撤回 → 队列 = ' + JSON.stringify([...st().queue.steering, ...st().queue.followUp].map((i) => i.text)))
      log('  点撤回 → 草稿 = ' + JSON.stringify((draft() || '').slice(0, 60)))
      ok(/已撤回排队内容/.test(notices()), '撤回成功（明确提示已放回草稿）')
      ok(!queued(B), '撤回后 B 不再显示为排队')
      ok((draft() || '').includes(B), 'B 的文本回到输入草稿')
    }
  } catch (error) {
    out.push('  ✗ 探针异常：' + (error && error.stack ? error.stack : String(error)))
  }

  return out.join('\n')
})()
