/*
 * 界面结构勘察 —— 把**真实窗口**里的状态、DOM 层次和尺寸 dump 成文本。
 *
 * ── 为什么单独一个探针 ──
 * `docs/dev/CODE-MAP.md` 里的「关系」不能只靠读源码写：字段名（`sessionId` 还是 `id`）、
 * 谁渲染谁（模型选择器挂在用量条里）、空分区到底渲不渲染，只有真跑一次才知道。
 * 这个探针就是那次运行的复现入口，也是核对文档是否漂移的手段。
 *
 * ── 怎么跑 ──
 * 不属于 test-live 的 CASES（它不断言，只输出）。手动：
 *
 *   env -u ELECTRON_RUN_AS_NODE \
 *     YAN_USER_DATA=<临时目录> YAN_DATA_DIR=<临时目录> \
 *     YAN_SESSIONS_DIR="$HOME/.pi/agent/sessions" YAN_PI_DIR="$HOME/.pi/agent" \
 *     YAN_PROBE=scripts/probe/survey.js YAN_PROBE_DELAY=15000 \
 *     YAN_PROBE_OUT=<输出文件> npx electron .
 *
 * ⚠️ 三个必须注意的点：
 *   · 必须 `env -u ELECTRON_RUN_AS_NODE`，否则 Electron 退化成纯 Node，无窗口、静默退出。
 *   · 必须用**隔离的** YAN_USER_DATA，否则撞单实例锁（锁按 userData 路径命名）而静默 exit 0。
 *   · 结果要写 YAN_PROBE_OUT 文件：Windows 上 GUI 进程的 stdout 不保证可用。
 *
 * 会话/凭证目录是**只读**引用的，探针只读状态、不发消息、不写会话。
 */
;(async () => {
  const store = window.__yanStore
  if (!store) return '✗ window.__yanStore 不存在（src/renderer/src/main.tsx 未挂载？）'

  const lines = []
  const push = (d, str) => lines.push('  '.repeat(d) + str)
  const cls = (el) =>
    typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : []
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return Math.round(r.width) + '×' + Math.round(r.height)
  }

  const walk = (el, d, maxD, maxKids) => {
    if (!el || d > maxD) return
    const r = el.getBoundingClientRect()
    const size = r.width > 1 && r.height > 1 ? ' [' + box(el) + ']' : ''
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim()
    const txt = el.children.length === 0 && own ? ' “' + own.slice(0, 30) + '”' : ''
    const k = cls(el)
    push(d, '<' + el.tagName.toLowerCase() + (k.length ? '.' + k.slice(0, 3).join('.') : '') + '>' + size + txt)
    const kids = [...el.children]
    for (const c of kids.slice(0, maxKids)) walk(c, d + 1, maxD, maxKids)
    if (kids.length > maxKids) push(d + 1, '… 另有 ' + (kids.length - maxKids) + ' 个同级')
  }

  /* ── 一、运行状态 ── */
  const s = store.getState()
  lines.push('════ 一 · 运行状态 ════')
  push(0, 'conn: ' + JSON.stringify(s.conn))
  push(0, 'cwd: ' + JSON.stringify(s.settings && s.settings.cwd))
  push(0, '会话数: ' + (s.sessions || []).length)
  push(0, '模型数: ' + (s.models || []).length)
  push(0, '命令数: ' + (s.commands || []).length)
  push(0, 'piInfo: ' + JSON.stringify(s.piInfo))
  push(0, 'activeRunnerId: ' + JSON.stringify(s.activeRunnerId))
  lines.push('')

  /* ── 二、身份三件套（runners / statuses / sessionRuntimes）── */
  lines.push('════ 二 · 身份三件套 ════')
  push(0, 'runners: ' + JSON.stringify(s.runners).slice(0, 500))
  push(0, 'statuses: ' + JSON.stringify(s.statuses).slice(0, 300))
  push(0, 'sessionRuntimes 的键: ' + JSON.stringify(Object.keys(s.sessionRuntimes || {})))
  lines.push('')

  /* ── 三、session 的真实字段 ── */
  lines.push('════ 三 · session 字段 ════')
  push(0, JSON.stringify(s.session, null, 1).slice(0, 900))
  lines.push('')

  /* ── 四、settings 全貌 ── */
  lines.push('════ 四 · settings（工具分区顺序看 toolOrder）════')
  push(0, JSON.stringify(s.settings).slice(0, 1200))
  lines.push('')

  /* ── 五、模型与命令样本 ── */
  lines.push('════ 五 · 样本 ════')
  push(0, 'models[0]: ' + JSON.stringify((s.models || [])[0]))
  push(0, 'provider 去重: ' + JSON.stringify([...new Set((s.models || []).map((m) => m.provider))]))
  push(0, 'thinkingLevels: ' + JSON.stringify(s.thinkingLevels))
  push(0, 'commands[0..2]: ' + JSON.stringify((s.commands || []).slice(0, 3)))
  push(0, 'sessions[0]: ' + JSON.stringify((s.sessions || [])[0]).slice(0, 400))
  lines.push('')

  /* ── 六、骨架与各栏内部 ── */
  lines.push('════ 六 · 骨架 ════')
  const root = document.querySelector('.app') || document.body
  walk(root, 0, 2, 12)
  lines.push('')
  lines.push('════ 七 · 各栏内部 ════')
  for (const sel of ['.rail', '.shead', '.stream', '.composer-wrap', '.rp-top', '.rp-body']) {
    lines.push('──── ' + sel + ' ────')
    const el = document.querySelector(sel)
    if (!el) {
      push(0, '（不存在）')
    } else {
      walk(el, 0, 4, 9)
    }
    lines.push('')
  }

  return lines.join('\n')
})()
