import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const m = await compile('src/renderer/src/features/changes/autorefresh-gate.ts')

  const harness = (start = 0) => {
    let now = start
    let visible = true
    let nextId = 1
    const timers = new Map()
    const fired = []
    const gate = m.createAutoRefreshGate({
      fire: () => fired.push(now),
      canFire: () => visible,
      now: () => now,
      setTimer: (fn, ms) => {
        const id = nextId++
        timers.set(id, { fn, at: now + ms })
        return id
      },
      clearTimer: (id) => timers.delete(id)
    })
    const advance = (ms) => {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    }
    return { gate, advance, fired, setVisible: (v) => (visible = v), pending: () => timers.size }
  }

  {
    const h = harness()
    h.gate.turnEnded()
    h.advance(m.TURN_END_DELAY_MS)
    ok(h.fired.length === 1, '回合结束后重读一次')
  }

  {
    const h = harness()
    for (let i = 0; i < 20; i++) {
      h.gate.activity(true)
      h.advance(200)
    }
    h.advance(10_000)
    ok(h.fired.length >= 1 && h.fired.length <= 3, '运行中连续写文件只按最小间隔重读', String(h.fired))
    const gaps = h.fired.slice(1).map((at, i) => at - h.fired[i])
    ok(gaps.every((gap) => gap >= m.RUNNING_MIN_GAP_MS), '运行中两次重读间隔不小于最小间隔', String(gaps))
  }

  {
    const h = harness()
    h.gate.activity(false)
    h.gate.activity(false)
    h.advance(m.IDLE_ACTIVITY_DELAY_MS)
    ok(h.fired.length === 1, '空闲时的活动去抖后重读一次')
  }

  {
    const h = harness()
    h.setVisible(false)
    h.gate.turnEnded()
    h.advance(5_000)
    ok(h.fired.length === 0, '面板不可见时不读 Git')
    h.setVisible(true)
    h.gate.shown()
    h.advance(0)
    ok(h.fired.length === 1, '重新可见后补读一次')
  }

  {
    const h = harness()
    h.gate.focused()
    h.advance(0)
    ok(h.fired.length === 0, '刚挂载时获得焦点不重复读')
    h.advance(m.FOCUS_MIN_GAP_MS)
    h.gate.focused()
    h.advance(0)
    ok(h.fired.length === 1, '窗口重新获得焦点时重读')
  }

  {
    const h = harness()
    h.gate.activity(true)
    h.gate.dispose()
    h.advance(10_000)
    ok(h.fired.length === 0 && h.pending() === 0, '卸载后取消待定重读')
  }
})
