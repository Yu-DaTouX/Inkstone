/**
 * N04：真实 thinking 模型的**长中英混排推理流**截图前置。
 *
 * 用法（`YAN_SHOT_SETUP` 就是为这一步存在的）：
 *   env -u ELECTRON_RUN_AS_NODE \
 *     YAN_PI_DIR=<临时 pi 目录> YAN_DATA_DIR=... YAN_SESSIONS_DIR=... YAN_USER_DATA=... \
 *     YAN_TEST_MODEL=commandcode/deepseek/deepseek-v4.1-flash \
 *     YAN_SHOT=docs/design/preview/matrix-reasoninglive-....png YAN_SHOT_W=1440 YAN_SHOT_H=900 \
 *     YAN_SHOT_SETUP=scripts/shot-setup/reasoning-live.js \
 *     npx electron .
 *
 * ── 为什么必须真调模型 ──
 * 注入合成 thinking 的截图（`visual:matrix` 的 `reasoning` 状态）只能证明**渲染**，
 * N04 缺的恰恰是「真的有一段长中英混排推理在流」。所以这里发一条要求
 * 分步、中文+英文各说一遍的消息，并在**推理仍在流式**时返回 ——
 * 回合结束后推理块会折叠（那是产品契约），截出来就看不到流了。
 *
 * 探针脚本约定：自求值 async IIFE，不能用反引号 / ${}（它会被当字符串执行）。
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  if (!store) return 'no-store'

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const btn = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (btn) {
      click(btn)
      await sleep(250)
    } else await sleep(120)
  }

  /* 1. 等 pi 真的连上（会话里出现模型信息） */
  for (let i = 0; i < 100; i++) {
    if (store.getState().session?.model) break
    await sleep(300)
  }
  if (!store.getState().session?.model) return 'pi-not-ready'

  /*
   * 2. 确保思考档位不是 off。
   * 走真实用户路径（主进程的 cycleThinking，与快捷键、模型菜单同一个入口），
   * 不用私有 setState 去伪造档位。
   */
  for (let i = 0; i < 8; i++) {
    const level = store.getState().session?.thinkingLevel
    if (level && level !== 'off') break
    try {
      await window.yan.cycleThinking()
    } catch {
      /* 还没就绪就再等一轮 */
    }
    await sleep(400)
  }
  const level = store.getState().session?.thinkingLevel

  /*
   * 3. 一条明确要求「长、分步、中英混排」的消息（不调工具，避免把回合拖到工具阶段）。
   *
   * 「思考过程用中文」是**软约束**（项目刻意不注入语言要求，见 AGENTS 第五节）：
   * 第一次跑（未写这句）模型整段用英文推理 —— 图能用，但不是「中英混排」那个形态。
   * 所以这里明写要求；再不混合就如实登记，不靠注水冒充。
   */
  const text =
    '不要调用任何工具。思考过程请用中文，专业术语（如 grapheme cluster / surrogate / code unit）保留英文原文，' +
    '形成中英混排的推理。分 8 步详细推理这个问题：为什么流式渲染里推理文本要按字素（grapheme）' +
    '而不是按 UTF-16 code unit 切分。每一步先写两到三句中文分析，紧接着写一句英文小结（English summary），' +
    '最后给出 5 行结论。'
  try {
    await store.getState().send(text)
  } catch (error) {
    return 'send-failed: ' + String(error?.message ?? error)
  }

  /*
   * 4. 等推理流足够长，并且**还在流**（thinkingLive）时返回。
   * 等不到流式就退而求其次：只要有过足够长的推理文本也返回（会如实登记形态）。
   */
  const deadline = Date.now() + 90_000
  let best = 0
  let liveSeen = false
  let liveLength = 0
  let tick = 0
  while (Date.now() < deadline) {
    /* 消息在**顶层** messages（session 里没有）—— 实测读错这里会一直看到 n=0 */
    const msgs = store.getState().messages ?? []
    const last = [...msgs].reverse().find((m) => m.role === 'assistant')
    const len = (last?.thinking ?? '').length
    if (len > best) best = len
    /*
     * 诊断（每 ~5s 一条）：读不到 thinking 时要能分清是「没推」「推到了别的会话」
     * 还是「字段名不对」—— 这三种看着都是 len=0，靠猜会白烧第二遍额度。
     */
    if (tick % 12 === 0) {
      console.error(
        '[n04-tick] ' +
          JSON.stringify({
            n: msgs.length,
            roles: msgs.map((m) => m.role),
            th: msgs.filter((m) => m.role === 'assistant').map((m) => (m.thinking ?? '').length),
            live: msgs.filter((m) => m.role === 'assistant').map((m) => m.thinkingLive === true),
            runner: store.getState().activeRunnerId,
            conn: store.getState().conn
          })
      )
    }
    tick += 1
    if ((last?.thinkingLive || last?.thinkingMs) && len >= 900) {
      liveSeen = true
      liveLength = len
      break
    }
    await sleep(400)
  }

  /* 5. 推理块必须是展开可见的（默认展开）；折叠了就没有可截的东西 */
  const body = q('.reason-body')
  const open = !!body && !body.hasAttribute('hidden') && body.getBoundingClientRect().height > 20
  const summary = [
    'thinkingLevel=' + String(level),
    'thinkingLen=' + String(best),
    'streamingAtCapture=' + String(liveSeen),
    'captureLen=' + String(liveLength),
    'reasonOpen=' + String(open)
  ].join(' ')
  /*
   * 走 renderer console 的 error 级：主进程会把它转发到 stdout（见 index.ts 的
   * `console-message` 监听），于是跑图的人能直接从终端看到“当时到底流了多长”。
   */
  console.error('[n04-setup] ' + summary)
  return summary
})()
