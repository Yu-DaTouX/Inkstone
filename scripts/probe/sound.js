/**
 * 声音提示（对齐 opencode 的 attention）。
 *
 * 无头环境下真实播放是听不到的，所以这里**替换 window.AudioContext**，
 * 只数「到底有没有按设置发出对应事件的声音」：
 *   · 总开关关 → 一声不出
 *   · 回合完成 / 需要回答 / 出错 → 各出各的（音符数不同）
 *   · 单事件关掉 → 只有它不出声
 *   · 切会话导致 isAgentRunning 变 false → 不该被当成「完成」乱响
 *
 * 为什么能替换：sound.ts 在**播放时**才读 window.AudioContext（懒创建），
 * 探针在应用启动 9s 后才跑，那时还没有过任何一次播放。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  /* ---- 用假 AudioContext 数音符 ---- */
  let starts = 0
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {}
  })
  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
    }
    resume() {
      this.state = 'running'
      return Promise.resolve()
    }
    createGain() {
      return { gain: param(), connect() {}, disconnect() {} }
    }
    createOscillator() {
      return {
        type: 'sine',
        frequency: { value: 0 },
        connect() {},
        start() {
          starts++
        },
        stop() {}
      }
    }
  }
  window.AudioContext = FakeAudioContext

  const allOn = { enabled: true, volume: 0.5, events: { done: true, question: true, error: true } }
  const setSound = async (patch) => {
    const cur = store.getState().settings.sound
    await store.getState().patchSettings({ sound: { ...cur, ...patch, events: { ...cur.events, ...(patch.events ?? {}) } } })
  }

  /*
   * 等一个条件成立（而不是固定 sleep）。
   *
   * ⚠️ 为什么必须这样：音频是**异步**的（AudioContext 调度 + 节流窗口），
   *    固定 80ms 在批量跑、机器负载高时会漏 —— 实测出现过「第一次批量跑失败、
   *    单独跑必过」的 flaky（方案 B4）。轮询把「等多久」变成「等到为止」，
   *    只在真的没发生时失败。
   */
  const waitFor = async (fn, ms = 1500) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(30)
    }
    return fn()
  }

  /* ---- 造一次「回合结束」的 state 推送 ---- */
  const statePush = (sessionId, isAgentRunning) => ({
    ch: 'state',
    payload: {
      sessionId,
      thinkingLevel: 'off',
      availableThinkingLevels: [],
      isStreaming: false,
      isAgentRunning,
      isCompacting: false,
      messageCount: 0,
      pendingMessageCount: 0,
      cwd: 'C:/probe'
    }
  })

  log('=== 1. 默认关，一声不出 ===')
  await setSound({ enabled: false })
  await sleep(50)
  const before0 = starts
  store.getState().applyPush(statePush('probe-a', true))
  store.getState().applyPush(statePush('probe-a', false))
  store.getState().applyPush({
    ch: 'ui-request',
    payload: { id: 'q1', method: 'select', message: '选一个', options: ['a', 'b'] }
  })
  store.getState().applyPush({
    ch: 'notify',
    payload: { id: 'e1', method: 'notify', notifyType: 'error', message: '炸了' }
  })
  await sleep(120)
  ok(starts === before0, `总开关关时没有任何音符（+${starts - before0}）`)

  log('')
  log('=== 2. 三类事件各发各的声 ===')
  await setSound({ enabled: true, events: { done: true, question: true, error: true } })
  await sleep(50)

  store.getState().applyPush(statePush('probe-b', true))
  const d0 = starts
  store.getState().applyPush(statePush('probe-b', false))
  await waitFor(() => starts > d0)
  const doneN = starts - d0
  ok(doneN > 0, `回合完成出声（${doneN} 个音符）`)

  // 切会话：sessionId 变了，不是「完成」，不能响
  store.getState().applyPush(statePush('probe-b', true))
  const s0 = starts
  store.getState().applyPush(statePush('probe-c', false))
  await sleep(250)
  ok(starts === s0, `切会话导致的 isAgentRunning=false 不响（+${starts - s0}）`)

  await sleep(300) // 越过 done 的节流窗口
  const q0 = starts
  store.getState().applyPush({
    ch: 'ui-request',
    payload: { id: 'q2', method: 'confirm', message: '继续吗' }
  })
  await waitFor(() => starts > q0)
  const questionN = starts - q0
  ok(questionN > 0, `需要回答出声（${questionN} 个音符）`)

  await sleep(450)
  const e0 = starts
  store.getState().applyPush({
    ch: 'notify',
    payload: { id: 'e2', method: 'notify', notifyType: 'error', message: '又炸了' }
  })
  await waitFor(() => starts > e0)
  const errorN = starts - e0
  ok(errorN > 0, `出错出声（${errorN} 个音符）`)
  log(`  音符数：done=${doneN} question=${questionN} error=${errorN}`)

  log('')
  log('=== 3. 单事件关掉就不出那一类声 ===')
  await setSound({ events: { done: true, question: false, error: true } })
  await sleep(50)
  await sleep(500) // 越过上一次 question 的节流
  const q1 = starts
  store.getState().applyPush({
    ch: 'ui-request',
    payload: { id: 'q3', method: 'select', message: '不该响', options: ['a'] }
  })
  await sleep(80)
  ok(starts === q1, `question 关掉后不响（+${starts - q1}）`)

  const d1 = starts
  await sleep(300)
  store.getState().applyPush(statePush('probe-d', true))
  store.getState().applyPush(statePush('probe-d', false))
  await waitFor(() => starts > d1)
  ok(starts > d1, `done 仍开着，照常响（+${starts - d1}）`)

  log('')
  log('=== 4. 校验非法音量不炸 ===')
  await store.getState().patchSettings({ sound: { enabled: true, volume: 99, events: { done: true, question: true, error: true } } })
  await sleep(50)
  const vol = store.getState().settings.sound.volume
  ok(vol <= 1 && vol >= 0, `音量被夹回合法区间（读回 ${vol}）`)

  log('')
  log('=== 5. 系统通知：失焦才发、开关可关 ===')
  // 探针窗口是 showInactive（本来就失焦），再显式钉死一次避免环境差异
  document.hasFocus = () => false
  await setSound({ enabled: true, notifications: true, events: { done: true, question: true, error: true } })
  await sleep(450)
  store.getState().applyPush({
    ch: 'ui-request',
    payload: { id: 'n1', method: 'confirm', message: '通知测试' }
  })
  await sleep(200)
  ok(
    store.getState().logs.some((x) => x.includes('[通知] question')),
    '失焦时发出系统通知（探针下由主进程写日志代替弹窗）'
  )

  await setSound({ notifications: false })
  await sleep(450)
  const countLog = (needle) => store.getState().logs.filter((x) => x.includes(needle)).length
  const errBefore = countLog('[通知] error')
  store.getState().applyPush({
    ch: 'notify',
    payload: { id: 'n2', method: 'notify', notifyType: 'error', message: '不该通知' }
  })
  await sleep(200)
  ok(
    countLog('[通知] error') === errBefore,
    '通知关掉后不再发'
  )

  // 收尾：关回声，避免影响后续场景
  await setSound({ enabled: false })

  return out.join('\n')
})()
