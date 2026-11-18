import { cpSync, copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { measureUi } from '../lib/user-ui.mjs'

export const meta = { description: '长会话文件预览重挂载与末尾表格的空闲、流式位置稳定性；合成 fixture，可通过 YAN_FLICKER_SOURCE 加载只读会话副本' }

const answer = `建议按这个顺序，**先修安全问题，再打通数据，不先堆新功能。**

| 优先级 | 工作 | 完成标准 |
| --- | --- | --- |
| P0：立即修 | 小数 1,5 → 15；桥接中消防水、救护站的错误映射 | 不静默改值、不改变资源含义，有回归测试 |
| P1：数据适配主线 | 用一个地区、几本手册打通最小闭环 | 能离线导入、阅读原页、搜索、查看地图，并从回答回到正确出处 |
| P1：最低限度国际化 | 英文／中文界面、回答语言选择、日期和数字输入 | 维护者能直接试用；界面语言与资料语言分开 |
| P2：同步可靠性 | 版本、哈希、空间检查、失败回退；处理网络约定差异 | 中断或更新失败不破坏已有资料，不依赖电脑持续开机 |
| P2：验证与交付 | 修复经审阅确认的问题，测试兼容性、离线流程和功耗 | 明确支持范围，PR 只声明已验证能力 |
| P3：后续扩展 | 更多地区、完整视频／百科、其他语言和 RTL、个人数据双向同步 | 基础闭环稳定后逐步增加 |

数据适配内部也有先后：

1. 原始资料、来源、版本和页码；
2. 地名与求助点；
3. 地图底图转换；
4. 大型视频和百科库。

保留现有手机工具和 MapLibre，不先重写引擎，也不先搬桌面大模型。

PR 草稿可先作为合作提案讨论，不必等全部开发完成；但正式功能 PR 应按上述阶段拆小。当前下一项就是 P0 两处修复。`

export default async function run({ cdp, box, newSession, sleep, check, shot, report, out, waitFor }) {
  const ev = (code) => cdp.evaluate(code)
  await newSession()
  if (!report.userUi) await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1035, deviceScaleFactor: 1, mobile: false })
  await ev('window.__yanStore.getState().patchSettings({ theme: "dark", lang: "zh-CN", uiScale: 1.15, density: "comfortable", reduceMotion: false, rightPanelOpen: false, promptSuggestions: false })')
  const source = process.env.YAN_FLICKER_SOURCE
  const artifacts = [0, 1].map(i => {
    const path = join(box.project, `preview-${i}.md`)
    const text = Array.from({ length: 40 }, (_, line) => `预览 ${i} 第 ${line + 1} 行：已有成果不应在虚拟列表重挂载时退回加载占位。`).join('\n')
    writeFileSync(path, text)
    return { id: `preview-${i}`, sourceId: `preview-${i}`, filename: `preview-${i}.md`, path, kind: 'code', mediaType: 'text/markdown', bytes: Buffer.byteLength(text), createdAt: 1, previewable: true }
  })
  const messages = []
  for (let i = 0; i < 300; i++) {
    messages.push({ id: `stable-u-${i}`, role: 'user', text: `历史问题 ${i}` })
    messages.push({ id: `stable-a-${i}`, role: 'assistant', text: i === 299 ? answer : `历史回复 ${i}\n\n` + '完成本轮检查。\n\n'.repeat(i % 9 + 2), timestamp: Date.now() - 600000, ...(i === 298 ? { artifacts } : {}) })
  }
  if (source) {
    const dir = join(box.sessionsDir, '--flicker-fixture--')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, basename(source))
    copyFileSync(source, file)
    if (process.env.YAN_FLICKER_ARTIFACTS) cpSync(process.env.YAN_FLICKER_ARTIFACTS, join(box.dataDir, 'artifacts', basename(process.env.YAN_FLICKER_ARTIFACTS)), { recursive: true })
    report.fixture = { bytes: statSync(file).size }
    await ev('window.__yanStore.getState().refreshSessions()')
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
    await waitFor('!s.switchLoading && s.messages.length > 200', 90000)
    report.fixture.messages = await ev('window.__yanStore.getState().messages.length')
    report.fixture.artifacts = await ev('window.__yanStore.getState().messages.flatMap(m => (m.artifacts ?? []).map(a => ({ id: a.id, path: a.path, kind: a.kind, unavailable: a.unavailable, bytes: a.bytes }))).slice(-10)')
  } else {
    await ev(`(() => {
      const s = window.__yanStore.getState()
      window.__yanStore.setState({ messages: ${JSON.stringify(messages)}, session: { ...s.session, isAgentRunning: false, isStreaming: false }, historyLoading: false, switchLoading: false })
    })()`)
    await waitFor('!!document.querySelector("[data-turn-id=stable-a-299] table")')
  }
  await sleep(1200)
  report.ui = await measureUi(cdp)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1700, y: 900 })

  const record = async (name, action) => {
    await ev(`(() => {
      const stream = document.querySelector('.v3-stream')
      const state = window.__stability = { frames: [], scrolls: [], start: performance.now() }
      const proto = Element.prototype
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'scrollTop')
      Object.defineProperty(proto, 'scrollTop', { ...descriptor, set(value) {
        if (this === stream && Math.abs(this.scrollTop - value) > 1) state.scrolls.push({ t: performance.now() - state.start, before: this.scrollTop, value, stack: new Error().stack })
        descriptor.set.call(this, value)
      } })
      state.restore = () => Object.defineProperty(proto, 'scrollTop', descriptor)
      const tick = () => {
        const tail = [...stream.querySelectorAll('.v3-msg.assistant')].find(node => node.querySelector('table') && node.textContent.includes('数据适配内部也有先后'))
        const table = tail?.querySelector('table')
        state.frames.push({ t: performance.now() - state.start, top: stream.scrollTop, size: stream.scrollHeight, viewport: stream.clientHeight, tail: tail?.getBoundingClientRect().top, height: tail?.getBoundingClientRect().height, table: table?.getBoundingClientRect().top, rows: document.querySelectorAll('.v3-stream-row').length })
        state.frame = requestAnimationFrame(tick)
      }
      state.frame = requestAnimationFrame(tick)
    })()`)
    let stopCapture = false
    let capture = Promise.resolve(0)
    if (process.env.YAN_FLICKER_CAPTURE === '1') {
      let cursor = cdp.events.length
      const framesDir = join(out, `${name}-capture`)
      mkdirSync(framesDir, { recursive: true })
      await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 })
      capture = (async () => {
        let count = 0
        while (!stopCapture) {
          const events = cdp.events.slice(cursor)
          cursor += events.length
          for (const event of events) {
            if (event.method !== 'Page.screencastFrame') continue
            writeFileSync(join(framesDir, `${String(count++).padStart(4, '0')}.jpg`), Buffer.from(event.params.data, 'base64'))
            await cdp.call('Page.screencastFrameAck', { sessionId: event.params.sessionId })
          }
          await sleep(10)
        }
        return count
      })()
    }
    await action()
    stopCapture = true
    const capturedFrames = await capture
    if (capturedFrames) await cdp.call('Page.stopScreencast')
    const data = await ev('(() => { const s = window.__stability; cancelAnimationFrame(s.frame); s.restore(); return { frames: s.frames, scrolls: s.scrolls } })()')
    writeFileSync(join(out, `${name}-frames.json`), JSON.stringify(data))
    const tables = data.frames.map((f) => f.table).filter((n) => Number.isFinite(n))
    const shifts = tables.slice(1).map((n, i) => Math.abs(n - tables[i]))
    const result = { frames: data.frames.length, capturedFrames, tableFrames: tables.length, maxStep: Math.max(0, ...shifts), range: tables.length ? Math.max(...tables) - Math.min(...tables) : 0, programScrolls: data.scrolls.length }
    report[name] = result
    console.log(name, JSON.stringify(result))
    await shot(name)
    return result
  }
  {
    await ev('(() => { const root = document.querySelector(".v3-stream"); root.dispatchEvent(new CustomEvent("yan-scroll-intent", { bubbles: true })); root.scrollTop -= 600 })()')
    await waitFor('[...document.querySelectorAll(".v3-artifact-code")].some(n => n.textContent.length > 50)', 10000)
    await sleep(400)
    await ev(`(() => {
      const root = document.querySelector('.v3-stream')
      const original = [...root.querySelectorAll('.v3-artifact-code')].find(node => node.textContent.length > 50)
      window.__previewRemount = { original, text: original.textContent, placeholders: 0 }
      const check = node => {
        if (!(node instanceof Element)) return
        const previews = [...node.querySelectorAll('.v3-artifact-code'), ...(node.matches('.v3-artifact-code') ? [node] : [])]
        for (const preview of previews) if (preview.textContent.includes('正在读取文件')) window.__previewRemount.placeholders++
      }
      const observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) check(node) })
      observer.observe(root, { subtree: true, childList: true })
      window.__previewRemount.stop = () => observer.disconnect()
    })()`)

    await ev('(() => { const root = document.querySelector(".v3-stream"); root.dispatchEvent(new CustomEvent("yan-scroll-intent", { bubbles: true })); root.scrollTop -= 6000 })()')
    await waitFor('!window.__previewRemount.original.isConnected', 5000)
    await ev(`(() => {
      const root = document.querySelector('.v3-stream')
      root.scrollTop = root.scrollHeight
      root.dispatchEvent(new WheelEvent('wheel', { deltaY: 10000, bubbles: true }))
    })()`)
    await waitFor('[...document.querySelectorAll(".v3-artifact-code")].some(node => node !== window.__previewRemount.original && node.textContent === window.__previewRemount.text)', 5000)
    const preview = await ev('(() => { const s = window.__previewRemount; s.stop(); delete window.__previewRemount; return { remounted: !s.original.isConnected, placeholders: s.placeholders } })()')
    report.previewRemount = preview
    check('已读文件预览重挂载没有缩回加载占位', preview.remounted && preview.placeholders === 0, preview)
  }
  const idle = await record('idle-table', () => sleep(6500))
  check('空闲长会话的末尾表格没有逐帧跳变', idle.tableFrames > 100 && idle.maxStep < 2, idle)

  const streaming = await record('stream-table', async () => {
    await ev(`(() => {
      const s = window.__yanStore.getState()
      window.__yanStore.setState({ messages: [...s.messages, { id: 'stable-u-next', role: 'user', text: '继续，尽可能复用已有代码和数据。' }, { id: 'stable-a-next', role: 'assistant', text: '我会按先复用数据、少造新格式的方向推进。', timestamp: Date.now() }], session: { ...s.session, isAgentRunning: true, isStreaming: true } })
    })()`)
    for (let i = 0; i < 20; i++) {
      await ev(`(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ messages: s.messages.map(m => m.id === 'stable-a-next' ? { ...m, text: m.text + ${JSON.stringify('\n\n新增进度说明。')} } : m) }) })()`)
      await sleep(180)
    }
    await ev('(() => { const s = window.__yanStore.getState(); window.__yanStore.setState({ session: { ...s.session, isAgentRunning: false, isStreaming: false } }) })()')
    await sleep(1500)
  })
  check('流式更新没有超过一屏的瞬间回跳', streaming.tableFrames > 0 && streaming.maxStep < 500, streaming)
}
