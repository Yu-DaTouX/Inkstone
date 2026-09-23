import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { identityForAwait, useStore } from '../../state/store'
import { ComposerBorder } from './ComposerBorder'
import { ModelThinkingPicker } from '../Pickers'
import { UsageBar } from './UsageBar'
import { findAtQuery, replaceAtQuery } from './at-query'
import { findSlashQuery, replaceSlashQuery } from './slash-query'
import type { Attachment, FileListingStatus, FileRequestContext, SlashCommand } from '../../../../shared/ipc'
import { WORK_MODES, type WorkMode } from '../../../../shared/work-mode'
import { parseSubagentCommand } from '../../../../shared/subagent-command'

/**
 * 输入区。四种输入模式共存：
 *
 *   · 普通文本      → prompt（发给模型）
 *   · `/` 开头       → 斜杠命令，带自动补全（扩展命令 / 提示词模板 / 技能）
 *   · `!` 开头       → 直接跑 shell，**不进模型**（`bash` 命令）
 *   · 贴/拖入图片    → 随 prompt 作为 images 发送
 *   · 拖入普通文件    → 作为**文件引用**（只带路径，模型按需读取）
 *
 * Enter 发送 / Shift+Enter 换行 / Esc 中止。
 * 生成中按 Enter 会**排队**（pi 的 follow-up，等这轮跑完再发）；
 * 想立刻插入当前这轮，用排队行右侧的「插队」（pi 的 steer）。
 */
export function Composer() {
  const t = useT()
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const send = useStore((s) => s.send)
  const abort = useStore((s) => s.abort)
  const runBash = useStore((s) => s.runBash)
  const busy = useStore((s) => !!s.session?.isStreaming)
  /**
   * 「模型在干活」的**回合级**判据（agent_start → agent_settled）。
   *
   * ⚠️ 不能用 `busy` 代替：`busy` 是 `session.isStreaming`，只在「有一条
   *    assistant 消息正在流」时为真 —— 工具执行期间是 false，而那时 pi 同样
   *    不接受不带 streamingBehavior 的 prompt（用户报过这个错）。
   *    「生成中发送 = 先悬在输入框上方」必须用回合级判据，否则用户在工具执行时
   *    发消息会被直接投出去，等于又替用户决定了投递方式。
   *
   * ⚠️ `isCompacting` 必须算进来（用户 2026-09-19：「自动压缩的时候仍要允许用户
   *    发送消息」）。压缩期间 pi 照样不接受裸 prompt：
   *      · 压缩发生在回合内部时 `running` 是真的，这条不影响；
   *      · **pi 在回合之间自动压缩**（threshold）时 `agent_settled` 已经发过、
   *        `running` 已经是 false，而 pi 忙着压缩 —— 那时按发送会**直接投出去**，
   *        pi 报「Agent is already processing」而输入框已经被 `submit` 清空，
   *        用户的消息就丢了（真正该做的是先进待定区，压缩完再自动按「排队」发）。
   */
  const roundRunning = useStore(
    (s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running || !!s.session?.isCompacting
  )
  const holdSend = useStore((s) => s.holdSend)
  const pendingSends = useStore((s) => s.pendingSends)
  const conn = useStore((s) => s.conn)
  const commands = useStore((s) => s.commands)
  /** 常用排序（自动管理）、记录使用、以及列表的自动刷新 */
  const commandUse = useStore((s) => s.commandUse)
  const markCommandUsed = useStore((s) => s.markCommandUsed)
  /**
   * 发送键（用户可在设置里选）。
   *
   * `auto` 是默认值，也是**改动前的行为**：短输入框 Enter 发送，
   * 长文模式里 Enter 换行。见 AppSettings.sendKey 的注释。
   */
  const sendKey = useStore((s) => s.settings?.sendKey ?? 'auto')
  const reloadCommands = useStore((s) => s.reloadCommands)
  const openSettings = useStore((s) => s.openSettings)
  const notify = useStore((s) => s.notify)
  const commandsAt = useStore((s) => s.commandsAt)
  const attachments = useStore((s) => s.attachments)
  const activeSessionId = useStore((s) => s.session?.sessionId ?? '')
  const activeCwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const activeRunnerId = useStore((s) => s.activeRunnerId ?? '')
  const activeGeneration = useStore((s) =>
    s.runners.find((runner) => (runner.runId ?? runner.id) === s.activeRunnerId)?.generation ?? 0
  )
  /** 草稿跟随稳定 sessionId；尚未落盘的会话暂时跟随 runId。 */
  const activeRuntimeKey = useStore((s) => {
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    const sessionId = s.session?.sessionId ?? runner?.sessionId
    return sessionId || (s.activeRunnerId ? `run:${s.activeRunnerId}` : '')
  })
  const conversationKey = useStore((s) => s.session?.conversationId) ?? activeRuntimeKey
  const cachedDraft = useStore((s) =>
    activeRuntimeKey ? s.sessionRuntimes[activeRuntimeKey]?.draft ?? '' : ''
  )
  const setSessionDraft = useStore((s) => s.setSessionDraft)
  const activeProjectId = useStore((s) => {
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    if (runner?.projectId) return runner.projectId
    const summary = s.sessions.find((item) => item.id === s.session?.sessionId || item.path === s.session?.sessionFile)
    if (summary?.scope === 'global') return undefined
    const cwd = s.session?.cwd ?? s.settings?.cwd ?? ''
    return summary?.projectId ?? s.settings?.projects.find((project) => {
      const a = project.cwd.replace(/[\\/]+$/, '').toLowerCase()
      const b = cwd.replace(/[\\/]+$/, '').toLowerCase()
      return a === b
    })?.id
  })
  const addAttachments = useStore((s) => s.addAttachments)
  const addFileRefs = useStore((s) => s.addFileRefs)
  const addFileRefPaths = useStore((s) => s.addFileRefPaths)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const clearAttachments = useStore((s) => s.clearAttachments)
  const startSubagent = useStore((s) => s.startSubagent)
  const newSession = useStore((s) => s.newSession)
  const compact = useStore((s) => s.compact)
  const setModel = useStore((s) => s.setModel)
  const models = useStore((s) => s.models)
  const openBrowser = useStore((s) => s.openBrowser)
  /*
   * 工作模式（实施-05）：状态在**会话级**（主进程推 `work-mode`），
   * 启动早期还没收到推送时按设置里的新会话默认值渲染 —— 不能拿一个
   * 全局布尔当当前模式（那正是这次要拆掉的东西）。
   */
  const workModeState = useStore((s) => s.workMode)
  const defaultWorkMode = useStore((s) => s.settings?.defaultWorkMode ?? 'standard')
  const activeWorkMode: WorkMode = workModeState?.mode ?? defaultWorkMode
  const autonomous = activeWorkMode === 'autonomous'
  /** 模式按钮：Esc 从输入框把焦点送到这里（避开键盘陷阱） */
  const modeButtonRef = useRef<HTMLButtonElement>(null)
  const editorInject = useStore((s) => s.editorInject)
  const consumeEditorInject = useStore((s) => s.consumeEditorInject)
  const queueRestore = useStore((s) => s.queueRestore)
  const consumeQueueRestore = useStore((s) => s.consumeQueueRestore)

  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ open: boolean; index: number }>({ open: false, index: 0 })
  /** 最近一次 textarea 光标位置；null 表示还没有收到真实编辑事件。 */
  const [cursor, setCursor] = useState<number | null>(null)
  const hydratedDraftKey = useRef<string | null>(null)
  const skipDraftPersist = useRef(false)

  /**
   * 写长文模式。
   *
   * 这个状态**影响回车键的语义**：
   *   普通模式 → Enter 发送，Shift+Enter 换行
   *   长文模式 → Enter 换行，Ctrl+Enter 或点发送按钮才发
   * 因为长文模式下 Enter 是“分段”，而不是“说完了”。
   *
   * ── 怎么进入（用户指定的两种方式）──
   *   ① **双击 ↑ 键**（输入框为空时）—— Slack / Discord / Claude Code
   *      都是这个手势，所以用户的肌肉记忆里已经有它了
   *   ② **点一下拖拽柄** —— 看得见的入口，不用猜
   *
   * ⚠️ 拖拽柄上「拖」与「点」要分开：拖 = 调高度，点 = 切换模式。
   *   判据是位移量（< 4px 算点）—— 与系统里拖拽/点击的惯例一致。
   *   本会话实测过一个反面例子：用 64×10 的小把手配元素自己的
   *   pointermove 监听，鼠标拖快了就“掉”（指针跑出把手）。
   *   所以 move/up 挂在 document 上。
   */
  /** 上一次按 ↑ 的时间（双击判定） */
  const lastArrowUp = useRef(0)

  const [expanded, setExpanded] = useState(false)
  /**
   * 当前生效的发送规则 —— 输入区常显的那句提示就是从它来的。
   *
   * `auto` 模式下规则会跟着展开态变（这正是要写出来的原因）。
   */
  const sendRule: 'enter' | 'ctrl' =
    sendKey === 'enter' ? 'enter' : sendKey === 'ctrlEnter' ? 'ctrl' : expanded ? 'ctrl' : 'enter'
  /** 拖出来的高度（px）。0 = 用默认的 max-height */
  const [tall, setTall] = useState(0)
  /** pointerup 后由 click 事件完成“点一下切换”；拖动则抑制 click */
  const resizeMoved = useRef(false)
  /** 用户明确收起后，同一份长文本不能在自动长高检查里立刻重新展开。 */
  const collapsedValue = useRef<string | null>(null)

  const resetComposerHeight = useCallback((): void => {
    if (!ref.current) return
    ref.current.style.height = '40px'
    ref.current.style.maxHeight = ''
  }, [])

  /** 展开后的默认高度：够写一段，但不至于占半个屏 */
  const TALL_H = 180

  /**
   * 让**这一次**高度变化走过渡。
   *
   * 为什么不给 textarea 常开 `transition: height`：它每次输入都可能自动长高，
   * 常开的话打字时高度永远慢半拍，拖拽柄跟手也会变成“藕断丝连”。
   * 所以只在「模式切换」这个瞬间把过渡打开，动画结束就关掉。
   *
   * 为什么需要它：以前点拖拽柄收起长文模式是**瞬跳**（180px 直接变回内容高），
   * 而展开那一下是跟着手/或者感受不到跳变 —— 于是“关的时候没有动画”很突兀。
   */
  const [heightAnimating, setHeightAnimating] = useState(false)
  const heightAnimTimer = useRef<number | null>(null)
  const animateHeight = useCallback((): void => {
    setHeightAnimating(true)
    if (heightAnimTimer.current !== null) window.clearTimeout(heightAnimTimer.current)
    heightAnimTimer.current = window.setTimeout(() => {
      heightAnimTimer.current = null
      setHeightAnimating(false)
    }, 240)
  }, [])
  useEffect(
    () => () => {
      if (heightAnimTimer.current !== null) window.clearTimeout(heightAnimTimer.current)
    },
    []
  )

  /** 开关长文模式。开启时给一个默认高度；关闭时完全回到默认尺寸 */
  const toggleExpanded = useCallback((): void => {
    animateHeight()
    setExpanded((v) => {
      if (v) {
        collapsedValue.current = value
        resetComposerHeight()
        setTall(0)
        return false
      }
      collapsedValue.current = null
      setTall(TALL_H)
      return true
    })
  }, [value, resetComposerHeight, animateHeight])

  /**
   * 拖拽柄：拖 = 调高，点 = 切换长文模式。
   *
   * 用 document 上的 pointermove/up（而不是元素自己的）——
   * 鼠标拖得快时会跑出那个小把手，挂在元素上会“掉”。
   * pointer 事件而不是 mouse：自动兼得触控与指针捕获。
   */
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startT = tall || (ref.current?.offsetHeight ?? TALL_H)
      const handle = e.currentTarget as HTMLElement
      let moved = 0
      let lastHeight = startT
      resizeMoved.current = false
      // Electron/Chromium 下确保快速拖动仍由这个把手持续接收指针事件。
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        /* 某些测试环境不实现 pointer capture，document 监听仍可工作 */
      }
      handle.classList.add('active')
      document.body.classList.add('resizing-composer')

      const onMove = (ev: PointerEvent): void => {
        const dy = startY - ev.clientY
        moved = Math.max(moved, Math.abs(dy))
        // 只有真的动了才改动高度（否则轻微抖动会把“点击”变成“拖拽”）
        if (moved < 4) return
        const next = Math.max(40, Math.min(560, startT + dy))
        lastHeight = next
        setTall(next)
        if (next > 48) setExpanded(true)
        else setExpanded(false)
      }

      const onUp = (): void => {
        handle.classList.remove('active')
        document.body.classList.remove('resizing-composer')
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)

        resizeMoved.current = moved >= 4
        if (moved < 4) return
        // 拖回默认高度 → 退出长文模式（恢复 Enter 发送）
        if (lastHeight <= 48) {
          collapsedValue.current = value
          resetComposerHeight()
          setExpanded(false)
          setTall(0)
        }
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [tall, toggleExpanded, value, resetComposerHeight]
  )

  const finishResizeClick = useCallback((): void => {
    if (!resizeMoved.current) toggleExpanded()
    resizeMoved.current = false
  }, [toggleExpanded])

  /* ---- 扩展调 set_editor_text ---- */
  useEffect(() => {
    if (editorInject === null) return
    setValue((v) => (v ? `${v}\n${editorInject}` : editorInject))
    consumeEditorInject()
    ref.current?.focus()
  }, [editorInject, consumeEditorInject])

  /* ---- 中止时回收的排队文本回填 ---- */
  useEffect(() => {
    if (queueRestore === null) return
    setValue((v) => (v ? `${queueRestore}\n${v}` : queueRestore))
    consumeQueueRestore()
    ref.current?.focus()
  }, [queueRestore, consumeQueueRestore])

  /* ---- 按会话恢复 / 保存输入框草稿 ---- */
  useEffect(() => {
    hydratedDraftKey.current = conversationKey || null
    /* 这次 value 变化来自“换会话”而不是用户输入，跳过一次回写。 */
    skipDraftPersist.current = true
    setValue(activeRuntimeKey ? cachedDraft : '')
    setCursor(activeRuntimeKey ? cachedDraft.length : null)
    // cachedDraft 只在 activeRuntimeKey 变化时取一次，避免每次敲字都重置输入框。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey])

  useEffect(() => {
    if (skipDraftPersist.current) {
      skipDraftPersist.current = false
      return
    }
    if (!activeRuntimeKey || hydratedDraftKey.current !== conversationKey) return
    setSessionDraft(value)
  }, [activeRuntimeKey, conversationKey, setSessionDraft, value])

  /* ---- 自动长高 ---- */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    /*
     * ⚠️ 这里曾经一句写死了：
     *
     *     el.style.height = `${min(max(scrollHeight,34),240)}px`
     *
     * 它每次 value 变化都执行 —— 于是**长文模式下拉出的高度被冲掉**：
     * 在长文模式里按回车（value 变了）→ 高度被改成「内容高」→
     * 输入框肉眼可见地变小（用户报的 bug）。
     *
     * 现在：tall > 0（长文模式/手动拖过）时，高度是**下限**而不是结果 ——
     * 内容更多可以长高，但不会缩回去。
     */
    const need = Math.min(Math.max(el.scrollHeight, 34), 240)
    const h = tall > 0 ? Math.max(tall, need) : need
    el.style.height = `${h}px`
    el.style.maxHeight = tall > 0 ? `${Math.max(tall, 240)}px` : ''

    /*
     * 超过三行就**自动进入长文模式**（用户要求）。
     * 判据用真实行高而不是数换行符 —— 一行很长的文字会被自动折行，
     * 那也是「三行」。所以量 scrollHeight 与 lineHeight 的比。
     * 只自动**进入**，不自动退出：编辑到一半高度自己收回去很难受。
     */
    if (expanded) return
    if (collapsedValue.current === value) {
      resetComposerHeight()
      return
    }
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20
    const pad = 16
    if (el.scrollHeight > lh * 3 + pad) {
      animateHeight()
      setExpanded(true)
      setTall(TALL_H)
    }
  }, [value, tall, expanded])

  const disabled = conn !== 'ready'
  /* N18：本地 Yan 命令不需要先连上 pi（例如 /login、/model、/browser）。 */
  const localCommandName = /^\/([^\s]+)/.exec(value.trim())?.[1]?.toLowerCase()
  const canRunLocalCommand = !!localCommandName && commands.some(
    (command) => command.source === 'yan' && command.executable && command.name.toLowerCase() === localCommandName
  )

  /* ---- 模式判定 ---- */
  const bashMode = value.startsWith('!')
  const slashRange = useMemo(
    () => findSlashQuery(value, cursor ?? value.length),
    [cursor, value]
  )
  const slashQuery = slashRange?.query ?? null

  const slashMatches = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    /*
     * 排序：**用过的排前面**（用户要的「自动管理」）。
     *
     * 为什么不改成完全按频率排：命令列表是用户背下来的东西，
     * 顺序乱变会让「第三个是 /compact」这种肌肉记忆失效。
     * 所以只把**用过的**提到前面，其余仍按名字 —— 稳定又有用。
     */
    const hit = commands
      /*
       * 实施-02 S4：`compatibility` 里标了 `hiddenInMenu` 的命令（目前只有
       * `/panel`）不进候选列表。它人还在注册表里 —— 手打时由 submit 里的
       * 兼容分支给明确反馈（而不是静默清空、也不是当消息发给模型）。
       */
      .filter((c) => !c.hiddenInMenu)
      .filter((c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q))
    return hit.sort((a, b) => {
      const sa = commandSourceRank(a)
      const sb = commandSourceRank(b)
      if (sa !== sb) return sa - sb
      const ua = commandUse[a.name] ?? 0
      const ub = commandUse[b.name] ?? 0
      if (ua !== ub) return ub - ua
      return a.name.localeCompare(b.name)
    })
  }, [commands, slashQuery, commandUse])

  /**
   * `@` 文件引用补全。
   *
   * pi 的命令行支持 `@files`（把文件内容当上下文），这是它的核心用法之一，
   * 但桌面端之前没有 —— 用户只能自己在路径里手打。
   *
   * ⚠️ 与 `/` 命令不同，这里**不能列整个文件树**：
   *   仓库里动辄几万个文件，列出来既慢又没用。
   *   所以只对**已经在输入里写出的路径前缀**做提示：
   *   `@src/ma` → 提示 `@src/main/` 下有哪几个条目。
   *   没写前缀时（刚打出一个 `@`）也只读项目根层，方便发现可用文件。
   *
   * 为什么不做成「文件选择器」：那需要主进程递归扫目录（慢、权限问题多），
   * 而 pi 自己会处理 `@path` 的解析 —— 我们只需要帮用户**少打几个字**。
   */
  const atQuery = useMemo(
    () => findAtQuery(value, cursor ?? value.length),
    [cursor, value]
  )

  /**
   * `@` 路径补全的候选。
   *
   * 异步去主进程查（只读一层目录），所以用 state 存。
   * 防抖：每敲一个字都发 IPC 会白干活。
   */
  const [paths, setPaths] = useState<string[]>([])
  const [pathsLoading, setPathsLoading] = useState(false)
  const [pathsError, setPathsError] = useState(false)
  const [pathsStatus, setPathsStatus] = useState<FileListingStatus>('empty')
  const [pathsTruncated, setPathsTruncated] = useState(false)
  /** Esc / 接受文件候选后，旧的异步结果不能把菜单重新打开。 */
  const [atMenuDismissed, setAtMenuDismissed] = useState(false)
  /**
   * 同上，但针对 `/` 命令菜单（N18）。
   *
   * 为什么单独一个：Esc 关菜单时会顺手置 `atMenuDismissed`，而它在上面那个
   * effect 的依赖里 —— effect 因此重跑，又因为 `slashQuery` 仍在、匹配仍在，
   * 就把命令菜单**又打开**了（实测：按 Esc 菜单不消失）。
   * 用户在命令名里继续打字时（`slashQuery` 变化）才算重新开始，那时清掉标记。
   */
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false)

  useEffect(() => {
    if (atQuery === null) {
      setPaths([])
      setPathsLoading(false)
      setPathsError(false)
      setPathsStatus('empty')
      setPathsTruncated(false)
      setAtMenuDismissed(false)
      return
    }
    setPaths([])
    setPathsLoading(true)
    setPathsError(false)
    setPathsStatus('empty')
    setPathsTruncated(false)
    let alive = true
    const context: FileRequestContext = {
      cwd: activeCwd,
      generation: activeGeneration,
      ...(activeProjectId ? { projectId: activeProjectId } : {})
    }
    const requestKey = `${activeRunnerId}\0${activeSessionId}\0${activeCwd}\0${activeProjectId ?? ''}\0${activeGeneration}\0${atQuery.query}`
    const id = setTimeout(() => {
      void window.yan
        .completePath(atQuery.query, activeCwd, context)
        .then((result) => {
          const current = useStore.getState()
          const currentRunner = current.runners.find((runner) => (runner.runId ?? runner.id) === current.activeRunnerId)
          const currentSummary = current.sessions.find(
            (item) => item.id === current.session?.sessionId || item.path === current.session?.sessionFile
          )
          const currentCwd = current.session?.cwd ?? current.settings?.cwd ?? ''
          const currentProject = currentRunner?.projectId ?? (
            currentSummary?.scope === 'global'
              ? undefined
              : currentSummary?.projectId ?? current.settings?.projects.find((project) => {
                return sameFileCwd(project.cwd, currentCwd)
              })?.id
          ) ?? ''
          const currentKey = `${current.activeRunnerId ?? ''}\0${current.session?.sessionId ?? ''}\0${current.session?.cwd ?? current.settings?.cwd ?? ''}\0${currentProject}\0${currentRunner?.generation ?? 0}\0${atQuery.query}`
          const response = result.request
          const responseMatches = !response || (
            sameFileCwd(response.cwd, context.cwd) &&
            response.projectId === context.projectId &&
            response.generation === context.generation
          )
          if (alive && currentKey === requestKey && responseMatches) {
            setPaths(result.paths)
            setPathsLoading(false)
            setPathsStatus(result.status)
            setPathsTruncated(result.truncated)
            setPathsError(result.status !== 'ok' && result.status !== 'empty')
          }
        })
        .catch(() => {
          if (alive) {
            setPaths([])
            setPathsLoading(false)
            setPathsError(true)
          }
        })
    }, 120)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [activeCwd, activeGeneration, activeProjectId, activeRunnerId, activeSessionId, atQuery])

  const atMatches = useMemo(() => {
    if (atQuery === null || paths.length === 0) return []
    return paths
  }, [atQuery, paths])

  useEffect(() => {
    if (slashQuery !== null && slashMatches.length > 0 && !slashMenuDismissed) {
      setMenu({ open: true, index: 0 })
    } else if (atQuery !== null && !atMenuDismissed && (atMatches.length > 0 || pathsLoading || pathsError)) {
      setMenu({ open: true, index: 0 })
    } else {
      setMenu((m) => (m.open ? { open: false, index: 0 } : m))
    }
  }, [
    atMatches.length,
    atMenuDismissed,
    atQuery,
    pathsError,
    pathsLoading,
    slashMatches.length,
    slashMenuDismissed,
    slashQuery
  ])

  /* 继续在命令名里打字 = 重新开始补全（清掉 Esc 留下的关闭标记） */
  useEffect(() => {
    setSlashMenuDismissed(false)
  }, [slashQuery])

  const completeSlash = useCallback(
    (command: SlashCommand) => {
      if (!command.executable) return
      const range = findSlashQuery(value, cursor ?? value.length)
      if (!range) return
      const next = replaceSlashQuery(value, range, command.name)
      setValue(next.value)
      setCursor(next.cursor)
      setMenu({ open: false, index: 0 })
      /* 记录使用 → 下次它排在前面（自动管理） */
      markCommandUsed(command.name)
      ref.current?.focus()
    },
    [cursor, markCommandUsed, value]
  )

  /*
   * 命令列表的**自动刷新**（用户要的「自动管理」）。
   *
   * 为什么需要：命令来自扩展 / 技能 / 提示词模板，它们是**运行时**加载的
   * （启动那一刻可能还没就绪），而旧实现只在启动时拉一次 ——
   * 之后新增的命令永远看不到，用户会以为「我的扩展没生效」。
   *
   * 策略：菜单一打开就检查，超过 30s 就重拉（一条子命令，很快，不烧钱）。
   * 不用定时轮询：命令变更是低频事件，轮询会在后台白跑。
   */
  useEffect(() => {
    if (slashQuery === null) return
    if (Date.now() - commandsAt < 30_000) return
    void reloadCommands()
  }, [slashQuery, commandsAt, reloadCommands])

  /**
   * 把 `@前缼` 补成 `@完整路径`。
   *
   * 目录（带尾斜杠）补完后**不关菜单** —— 用户通常要接着选下一层
   * （`@src/` → `@src/main/` → `@src/main/agent.ts`）。
   * 文件则补完就关。这是与 `/` 命令补全的关键差别。
   */
  const completeAt = useCallback(
    (p: string) => {
      const range = findAtQuery(value, cursor ?? value.length)
      if (!range) return
      const next = replaceAtQuery(value, range, p)
      setValue(next.value)
      setCursor(next.cursor)
      // 目录：保持菜单开（等下一层的结果自动刷新）；文件：关
      if (!p.endsWith('/')) {
        setAtMenuDismissed(true)
        setMenu({ open: false, index: 0 })
      } else {
        setAtMenuDismissed(false)
      }
      ref.current?.focus()
    },
    [cursor, value]
  )

  const submit = async () => {
    const raw = value.trim()

    /*
     * ⚠️ 这里曾经是一行 `if (!raw) return`，而它挡住了**只带图片**的发送：
     *   用户拖一张图进来、一个字不打就点发送 —— 附件已经显示了，
     *   但 submit 在第一行就返回了。用户报的「拖入文件可以正常显示但没办法发送」
     *   就是这个。
     *
     * 正确的判据是「文字或附件至少有一个」——
     * 这与输入框的 placeholder 提示（「发图片不必配文字」）也对得上。
     * 文件引用同样适用：只有附件也能发。
     */
    if (!raw && attachments.length === 0) return

    if (bashMode) {
      // `!` 开头的走直接执行，不进模型（图片对它无意义）
      const cmd = raw.slice(1).trim()
      if (!cmd) return
      setValue('')
      await runBash(cmd)
      return
    }

    const images = attachments
      .filter((a) => a.kind !== 'file')
      .map((a) => ({ data: a.data, mimeType: a.mimeType }))
    /*
     * 文件引用：**不**把内容拼进来（大文件会爆上下文），
     * 只把路径交给模型，由它自己 `read`（方案 5.1）。
     */
    const fileRefs = attachments.filter((a) => a.kind === 'file' && a.path)
    const outgoing = fileRefs.length
      ? `${raw ? raw + '\n\n' : ''}${t('composer.fileRefs', {
          list: fileRefs.map((a) => `- ${a.path}`).join('\n')
        })}`
      : raw

    /*
     * `/login` 不能当普通消息发给模型。
     *
     * pi 的订阅制登录是**交互式**的（OAuth 要开浏览器、回调回连 localhost），
     * RPC 的 47 个命令里没有 login —— 直接发过去模型会把它当一句话回答
     *（用户报的「输入 /login 模型没办法正常接受」）。
     * 这里路由到「设置 → 模型接入」：那里列出了准确的登录方式。
     */
    if (raw === '/login' || raw.startsWith('/login ')) {
      setValue('')
      clearAttachments()
      openSettings('auth')
      return
    }

    /*
     * `/subagent <任务>`：把这件事交给一个**独立 pi 子进程**去跑（方案第 8 节）。
     * 不进模型 —— 这是本地命令（与 `/login` 同一类）。
     * 没有任务描述时不发：避免起一个什么都干不了的子代理。
     */
    const subagentCommand = parseSubagentCommand(raw)
    if (subagentCommand) {
      const { task, isolation } = subagentCommand
      if (!task) return
      setValue('')
      clearAttachments()
      await startSubagent(task, undefined, isolation)
      return
    }

    /*
     * N18：Yan 本地命令与 pi 命令共用一个注册表，但本地命令必须在桌面端
     * 由明确的 UI 动作承接，不能把 `/new` / `/browser` 当自然语言发给模型。
     * 参数仍保留在输入框语义里：`/model provider/id` 可以直接选中已发现的模型，
     * 没有参数时打开状态页让用户从权威列表选择。
     */
    const localMatch = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(raw)
    const localName = localMatch?.[1]?.toLowerCase()
    const localArgs = localMatch?.[2]?.trim() ?? ''
    const localCommand = localName
      ? commands.find((command) => command.source === 'yan' && command.name.toLowerCase() === localName)
      : undefined
    const compatibilityCommand = localName
      ? commands.find((command) => command.source === 'compatibility' && command.name.toLowerCase() === localName)
      : undefined

    if (compatibilityCommand || (localCommand && !localCommand.executable)) {
      /*
       * 兼容命令在桌面端**没有可执行动作**。
       *
       * ⚠️ 旧实现是 `setValue('') + clearAttachments()` 然后沉默：用户打了
       * `/panel` 后输入框被清空、什么也没发生，只会以为「命令执行完了」。
       * 而且草稿和附件是真丢了（用户会重新写一遍）。
       * 现在：草稿与附件**原样保留**，只推一条说明为什么没动作。
       *
       * 同名 runtime 命令不会在此处「接管」：能走到这里的只有注册表里
       * source=compatibility 的那条；即使 pi 侧也注册了同名命令，
       * 它也不会被当成消息发出去（那会让模型收到一个斜杠命令文本）。
       */
      const command = compatibilityCommand ?? localCommand
      notify('info', t('composer.compatCommand', { cmd: `/${command?.name ?? localName ?? ''}` }))
      const note = command?.availability ?? command?.description
      if (note) notify('info', note)
      ref.current?.focus()
      return
    }

    if (localCommand) {
      setValue('')
      clearAttachments()
      if (localName === 'new') {
        await newSession({ scope: 'global' })
      } else if (localName === 'compact') {
        await compact()
      } else if (localName === 'browser') {
        await openBrowser(localArgs || undefined)
      } else if (localName === 'model') {
        const spec = localArgs.toLowerCase()
        const selected = spec
          ? models.find((model) => {
              const full = `${model.provider}/${model.id}`.toLowerCase()
              return full === spec || model.id.toLowerCase() === spec || model.name.toLowerCase() === spec
            })
          : undefined
        if (selected) await setModel(selected.provider, selected.id)
        else openSettings('status')
      }
      return
    }

    /*
     * 生成中不直接投递：先把消息**悬在输入框上方**，由用户选「插话」还是
     * 「排队」（用户 2026-09-19：「发送的消息默认悬浮在输入框上方，让用户
     * 自己选择是插话还是排队」）。
     *
     * 悬着的消息在回合结束后会**自动按「排队」发出**（见下面的 effect）：
     * 那时“插话”已经没有意义，而用户不选也不该把消息丢掉。
     */
    if (roundRunning) {
      setValue('')
      clearAttachments()
      holdSend(outgoing, images.length ? images : undefined)
      return
    }

    setValue('')
    clearAttachments()
    await send(outgoing, images.length ? images : undefined)
  }

  /**
   * 回合结束后把悬着的消息按「排队」投出去。
   *
   * 一条一条发：`releaseSend` 成功后会改 `pendingSends`，本 effect 因此
   * 再触发一次，顺序天然保持。投递失败时 `pendingSends` 不变、依赖不变，
   * 所以不会重试到死 —— 卡片留在原地让用户处理。
   */
  useEffect(() => {
    if (roundRunning || pendingSends.length === 0) return
    void useStore.getState().releaseSend(pendingSends[0].id, 'followUp')
  }, [roundRunning, pendingSends])

  /* ---- 图片：粘贴 ---- */
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...e.clipboardData.items]
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f)
      if (files.length === 0) return
      e.preventDefault()
      void readFiles(files, addAttachments)
    },
    [addAttachments]
  )

  /* ---- 图片：拖放；普通文件 → 文件引用 ---- */
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const internalPath = e.dataTransfer.getData('application/x-yan-file-path').trim()
      if (internalPath) {
        e.preventDefault()
        setDragging(false)
        void addFileRefPaths([internalPath])
        return
      }
      /*
       * 从编辑器拖一段**选中的文字**进来时，dataTransfer 里没有 Files ——
       * 这时候不要 preventDefault，否则浏览器自带的「拖入即插入文本」体验就没了
       * （方案 5.1 明确要求保留）。
       */
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragging(false)
      const files = [...e.dataTransfer.files]
      if (files.length === 0) return
      const images = files.filter((f) => f.type.startsWith('image/'))
      const others = files.filter((f) => !f.type.startsWith('image/'))
      if (images.length) void readFiles(images, addAttachments)
      if (others.length) void addFileRefs(others)
    },
    [addAttachments, addFileRefPaths, addFileRefs]
  )

  const rememberCursor = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    setCursor(el.selectionStart)
  }, [])

  /**
   * 把一段文本插到光标处（`+` 菜单里的「能力」用它把引用写进输入框）。
   *
   * 为何不直接 `setValue(value + text)`：那会把光标丢到末尾，
   * 用户接着写的位置就没了。这里插在光标处，并把光标移到插入内容之后。
   */
  const insertAtCursor = (text: string): void => {
    const el = ref.current
    const at = el && document.activeElement === el ? el.selectionStart : (cursor ?? value.length)
    const next = `${value.slice(0, at)}${text}${value.slice(at)}`
    setValue(next)
    const pos = at + text.length
    setCursor(pos)
    /* 选区必须在 React 写完 value 之后设，否则会被这一帧的渲染覆盖 */
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /* 原生 capture 兜底已经处理过的 Tab 不得再被 React 处理一次。 */
    if (e.defaultPrevented) return

    /*
     * 补全菜单的键盘导航。
     *
     * 两个菜单（`/` 命令与 `@` 文件）共用同一个 menu 状态与按键处理 ——
     * 它们不会同时出现（`@` 只在 slashMatches 为空时才渲染）。
     */
    const items = slashMatches.length > 0 ? slashMatches.map((c) => c.name) : atMatches
    if (menu.open && items.length > 0) {
      /*
       * 中文输入法组合期间，Enter / Tab / 方向键 / Esc 都是**输入法自己的**：
       * Enter 确认候选、Esc 取消候选。这里必须让路，否则中文用户选词时
       * 会把候选命令填进输入框（实测：组合态按 Enter → "/help " 被填入）。
       * 下面的“发送键”分支一直有这个检查，菜单分支之前漏了。
       */
      if (e.nativeEvent.isComposing) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMenu((m) => ({ ...m, index: (m.index + 1) % items.length }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMenu((m) => ({ ...m, index: (m.index - 1 + items.length) % items.length }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (slashMatches.length > 0) completeSlash(slashMatches[menu.index])
        else completeAt(items[menu.index])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtMenuDismissed(true)
        /* `/` 菜单也要记住“被 Esc 关过”：它有自己的重开 effect（见上面的说明） */
        if (slashMatches.length > 0) setSlashMenuDismissed(true)
        setMenu({ open: false, index: 0 })
        return
      }
    }

    /*
     * 双击 ↑ 进入 / 退出长文模式（用户指定的手势）。
     *
     * 为什么只在**输入框为空**时手：
     *   有文字时 ↑ 是“把光标移到上一行”的正常编辑操作，不能抢。
     *   空输入框里 ↑ 本来什么都不做 —— 把它借来当快捷方式无副作用。
     *   （Slack / Discord / Claude Code 都是这个约定。）
     *
     * 400ms 内两次算双击：与系统的双击间隔一致，不另设参数。
     */
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (value.length === 0) {
        const now = Date.now()
        if (now - lastArrowUp.current < 400) {
          e.preventDefault()
          lastArrowUp.current = 0
          toggleExpanded()
          return
        }
        lastArrowUp.current = now
        // 不 preventDefault —— 第一次 ↑ 该干什么还干什么
      }
    }

    /*
     * 工作模式快切（实施-05 §3）在 2026-09-22 改成**全局快捷键**（默认 `Ctrl+Tab`）。
     *
     * 这里不再拦裸 Tab：那是输入框里唯一的「移到下一个控件」键，被抢掉后
     * 键盘用户只能靠 Esc 逃出输入框，Tab 补全弹窗也要绕开它。
     * 快捷键的实现在 `App.tsx`（焦点在哪都生效），与输入框无关。
     */

    /*
     * 发送键。
     *
     * 三种规则（用户可在设置里选，见 AppSettings.sendKey）：
     *   auto（默认）短输入框 Enter 发送；长文模式里 Enter 换行、
     *         Ctrl/Cmd+Enter 发送 —— 用户明确要求过「写长文时别误发」。
     *   enter      任何时候 Enter 发送（Shift+Enter 换行）
     *   ctrlEnter  任何时候 Ctrl/Cmd+Enter 发送（Enter 换行）
     *
     * ⚠️ 为什么把这条规则提出来做成设置：`auto` 让「输入框高度」**隐式**
     *    决定了 Enter 的语义 —— 按下去之前无法确定会发生什么。
     *    现在规则既可选，也常显在输入区里（见下面的 sendRule 提示）。
     *
     * Ctrl/Cmd+Enter 在任何模式下都能发送 —— 这是跨应用的通用约定，
     * 也是「写长文时想发出去」的退路。
     */
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const wantsSend =
        e.ctrlKey || e.metaKey
          ? true
          : sendKey === 'enter'
            ? !e.shiftKey
            : sendKey === 'ctrlEnter'
              ? false
              : !e.shiftKey && !expanded
      if (wantsSend) {
        e.preventDefault()
        void submit()
        return
      }
      // 否则放行，让 textarea 插入换行
    }

    /* 长文模式下 Esc 退出（不用先清空再双击 ↑） */
    if (e.key === 'Escape' && expanded && !busy) {
      e.preventDefault()
      toggleExpanded()
      return
    }

    if (e.key === 'Escape' && busy) {
      e.preventDefault()
      void abort()
    }

    /*
     * Esc → 焦点送到模式按钮（实施-05 §3）。
     *
     * 快捷键改成 `Ctrl+Tab` 之后这条依然有用：键盘用户得先能**走到**模式按钮上
     * （按钮上方向键 / Enter 都能用），而不是只能记住一个组合键。
     * 无补全、非长文、不在跑回合时把焦点交出去。
     */
    if (e.key === 'Escape' && !expanded && !busy && !disabled) {
      e.preventDefault()
      modeButtonRef.current?.focus()
    }
  }

  return (
    <div
      className={`composer-wrap ${dragging ? 'dropping' : ''} ${autonomous ? 'autonomous' : ''}`}
      data-autonomous={autonomous ? '1' : '0'}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-yan-file-path')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {/* 排队的消息：显示在输入框**上方**（用户要求） */}
      <QueueStack />
      <div className={`composer ${expanded ? 'tall' : ''} ${heightAnimating ? 'animating' : ''}`}>
        {/*
         * 顶边框 **内含工作状态**（pi 的 renderTopBorder 做法）。
         *
         * 为什么放在输入框的边框上而不是消息流底部单独一行：
         *   · 「它在干活」与「我能输入」是同一件事的两面 —— 放一起不用两头看
         *   · 不额外占垂直空间（消息流已经很长了）
         *   · 边框颜色顺便承载了当前思考强度
         */}
        <ComposerBorder />
        {attachments.length > 0 ? (
          <div className="attach-strip">
            {attachments.map((a) => (
              <div className="attach" key={a.id} title={`${a.name} · ${fmtSize(a.size)}`} data-kind={a.kind ?? 'image'}>
                {a.kind === 'file' ? (
                  <span className="attach-file-ico" aria-hidden>
                    <Icon name="tag" size={12} />
                  </span>
                ) : (
                  <img src={`data:${a.mimeType};base64,${a.preview}`} alt={a.name} />
                )}
                <span className="attach-name">{a.name}</span>
                {a.kind === 'file' ? <span className="attach-size">{fmtSize(a.size)}</span> : null}
                <button className="attach-del" onClick={() => removeAttachment(a.id)} title={t('composer.removeImage')}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {menu.open && slashMatches.length > 0 ? (
          <div className="slash-menu" role="listbox">
            {slashMatches.map((c, i) => (
              <Fragment key={`${c.source}:${c.name}:${c.module ?? ''}`}>
                {i === 0 || slashMatches[i - 1].source !== c.source ? (
                  <div className="slash-group" data-source={c.source}>{commandSourceLabel(c.source)}</div>
                ) : null}
                <button
                  className={`slash-item ${i === menu.index ? 'sel' : ''} ${c.executable ? '' : 'compat'}`}
                  onMouseEnter={() => setMenu((m) => ({ ...m, index: i }))}
                  onClick={() => completeSlash(c)}
                  disabled={!c.executable}
                  title={c.availability}
                  role="option"
                  aria-disabled={!c.executable}
                  aria-selected={i === menu.index}
                >
                  <span className="slash-name">/{c.name}</span>
                  <span className="slash-desc">{c.description ?? ''}</span>
                  <span className="slash-src">{c.source}{c.module ? ` · ${c.module}` : ''}</span>
                </button>
              </Fragment>
            ))}
            {/*
             * 底部按键说明。
             * 为什么要写：菜单支持 ↑↓ / Enter / Tab / Esc，但这些都是**看不见的**，
             * 不提示的话用户只会用鼠标点（或者以为只能点）。
             */}
            <div className="slash-hint" data-testid="slash-hint">
              <span>↑↓ 选</span>
              <span>Enter / Tab 填入</span>
              <span>Esc 关闭</span>
              <span>{slashMatches.length} 项 · 可滚动</span>
            </div>
          </div>
        ) : null}

        {/* `@` 文件引用补全（pi 的 @files 用法）。
            只列主进程返回的那一层目录结果，不递归扫项目。 */}
        {menu.open && slashMatches.length === 0 && atQuery !== null ? (
          <div className="slash-menu" role="listbox" data-testid="at-menu">
            {pathsLoading ? <div className="slash-empty" data-testid="at-loading">{t('composer.pathLoading')}</div> : null}
            {!pathsLoading && pathsError ? (
              <div className="slash-empty" data-testid="at-error">
                {pathsStatus === 'permission' ? t('composer.pathPermission') : t('composer.pathError')}
              </div>
            ) : null}
            {!pathsLoading && !pathsError && atMatches.length === 0 ? (
              <div className="slash-empty" data-testid="at-empty">{t('composer.pathNoMatch')}</div>
            ) : null}
            {!pathsLoading && !pathsError ? atMatches.map((p, i) => (
              <button
                key={p}
                className={`slash-item ${i === menu.index ? 'sel' : ''}`}
                onMouseEnter={() => setMenu((m) => ({ ...m, index: i }))}
                onClick={() => completeAt(p)}
                role="option"
                aria-selected={i === menu.index}
                title={toAbsoluteFilePath(activeCwd, p)}
              >
                <span className="slash-name">{p.endsWith('/') ? '▸ ' : '· '}{p}</span>
                <span className="slash-src">{p.endsWith('/') ? t('composer.dir') : t('composer.file')}</span>
              </button>
            )) : null}
            {!pathsLoading && !pathsError && pathsTruncated ? (
              <div className="slash-hint" data-testid="at-truncated">{t('composer.pathTruncated')}</div>
            ) : null}
          </div>
        ) : null}

        {/* 拖拽调高：贴在顶边框上的一根小短横 */}
        <div
          className="composer-resize"
          onPointerDown={startResize}
          onClick={finishResizeClick}
          title={expanded ? t('composer.resizeExpanded') : t('composer.resizeHint')}
          data-testid="composer-resize"
          role="separator"
          aria-orientation="horizontal"
        />

        <textarea
          ref={ref}
          rows={2}
          data-testid="composer"
          value={value}
          disabled={disabled}
          /*
           * 高度由上面那个 effect 统一写（它要知道 tall 与内容两个因素）。
           * 这里**不能**再写一次 inline height —— 两处写同一个属性正是
           * 「回车后变矮」那个 bug 的来源（React 写的会被 effect 覆盖，反之亦然）。
           */
          placeholder={
            disabled
              ? t('conn.starting')
              : busy
                ? t('composer.busy')
                : expanded
                  ? t('composer.phTall')
                  : t('composer.ph')
          }
          onChange={(e) => {
            setValue(e.target.value)
            setCursor(e.target.selectionStart)
            setAtMenuDismissed(false)
          }}
          onSelect={rememberCursor}
          onClick={rememberCursor}
          onKeyUp={rememberCursor}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <div className="composer-bar">
          <div className="composer-tools">
            {bashMode ? (
              <span className="mode-badge bash">{t('composer.bashMode')}</span>
            ) : value.startsWith('/') ? (
              <span className="mode-badge cmd">{t('composer.cmdMode')}</span>
            ) : null}

            <PlusMenu onInsert={insertAtCursor} />

            {/* 工作模式（实施-05）：原位显示当前模式 + 菜单，Tab 可快切 */}
            <WorkModePicker buttonRef={modeButtonRef} />

            {/*
             * 当前发送规则 —— **常显**（不只是长文模式）。
             *
             * 为什么必须写出来：Enter 到底是发送还是换行，取决于
             * 设置的发送键 + 是否长文模式。不写出来就得靠试 ——
             * 而“试”的代价是一条没写完就发出去的消息。
             *
             * ⚠️ 不用 `!disabled` 包住：规则是**设置状态**的反映，
             *    不是“现在能不能输入”。禁用时留空反而让探针
             *    和用户都不知道当前规则是什么。
             */}
            {/*
             * 只在**非默认状态**显示。
             *
             * 默认短输入框 + 默认发送键时，规则就是「Enter 发送 / Shift+Enter 换行」，
             * 写出来只是给输入区添噪声（用户要求：默认不显示）。
             * 真正需要写出来的是「不写就得靠试」的两种情况：
             *   ① 长文模式 —— Enter 的语义变了（换行），发不出去会让人以为卡了
             *   ② 用户改过发送键 —— 那是他自己配的，得让他看得见当前规则
             * 两种情况下文字仍然与 `sendRule` 同源，不会出现“提示与行为不一致”。
             */}
            {expanded || sendKey !== 'auto' ? (
              <span className="ctool-hint" data-testid="composer-keyhint">
                {sendRule === 'enter' ? t('composer.keyEnterSend') : t('composer.keyCtrlSend')}
              </span>
            ) : null}
          </div>

          {/*
           * 模型 + 思考强度：放在**输入框内部**右下角（用户要求，
           * 原来在输入框下方的 UsageBar 里）。
           *   · 准备打字时先确认“用什么模型”，视线不用往下扫到输入区之外
           *   · 与发送键同行 —— 这两个是同一个动作的前后两步
           * 强度文字的颜色由 `.mt-level[data-level]` 按档位染（见 composer.css）。
           */}
          <ModelThinkingPicker />
          <button
            className={`send ${busy ? 'abort' : ''}`}
            data-testid="send"
            onClick={busy ? () => void abort() : () => void submit()}
            /* 有附件就能发 —— 与 submit() 的判据保持一致（否则按钮是灰的，点不动） */
            disabled={!busy && (!value.trim() && attachments.length === 0 ? true : disabled && !canRunLocalCommand)}
            title={
              sendRule === 'ctrl'
                ? t('composer.keyCtrlSend')
                : expanded
                  ? t('composer.sendTipTall')
                  : undefined
            }
          >
            <Icon name={busy ? 'alert-circle' : bashMode ? 'activity' : 'send'} size={12} />
            <span>{busy ? t('composer.stop') : bashMode ? t('composer.run') : t('composer.go')}</span>
          </button>
        </div>

      </div>

      {/* 用量条：合并版，放在输入框下方 */}
      <UsageBar />
    </div>
  )
}

function sameFileCwd(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

function toAbsoluteFilePath(cwd: string, rel: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  return rel ? `${root}\\${rel.replace(/\//g, '\\')}` : root
}

/**
 * 输入框上方的消息栈：**悬着的（待投递）** + pi 队列里（已投递）的。
 *
 * 两层语义要分清：
 *   · `pendingSends` —— 还没投给 pi，用户点「插话 / 排队」之后才投递。
 *     用户 2026-09-19：「发送的消息默认悬浮在输入框上方，让用户自己选择
 *     是插话还是排队」。它只存在于渲染端（`store.pendingSends`）。
 *   · `queue.steering` / `queue.followUp` —— pi **已经收下**的（插话中 /
 *     排队中）。每行右侧的「撤回」只操作仍在队列快照中的条目：目标一旦被
 *     pi 取走就会从快照消失，不会给用户一个虚假的撤回成功。
 */
function QueueStack() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const steerQueued = useStore((s) => s.steerQueued)
  const removeQueued = useStore((s) => s.removeQueued)
  const pendingSends = useStore((s) => s.pendingSends)
  const releaseSend = useStore((s) => s.releaseSend)
  const restoreSend = useStore((s) => s.restoreSend)
  /*
   * 回合跑着才需要「插话 / 排队」二选一；停了就只剩「发送」一个动作。
   *
   * ⚠️ 这里**故意不算 `isCompacting`**（与上面 `Composer` 里那个同名判据不同）：
   *    压缩期间模型没有在生成，“插话”没有意义 —— 卡片上只给一个
   *    「发送」（内部走 `followUp`：等压缩完再投）才是对的。
   *    `Composer` 那个判据加上压缩，是为了让这个时候按 Enter 先进待定区、
   *    不要拿着裸 prompt 去撞 pi。两处职责不同，不是写漏了。
   */
  const roundRunning = useStore(
    (s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running
  )
  const steering = queue.steering
  const followUp = queue.followUp
  if (steering.length + followUp.length + pendingSends.length === 0) return null

  return (
    <div className="queue-stack" data-testid="queue-stack">
      {pendingSends.map((item) => (
        <div className="qrow pending" key={item.id} title={item.text} data-testid="queue-pending">
          <Icon name="send" size={12} />
          <span className="qrow-text">{item.text}</span>
          <span className="qrow-tag">{t('queue.hold')}</span>
          {roundRunning ? (
            <>
              <button
                className="qrow-jump primary"
                data-testid="pending-steer"
                title={t('queue.steerNowTip')}
                onClick={() => void releaseSend(item.id, 'steer')}
              >
                {t('queue.steerNow')}
              </button>
              <button
                className="qrow-jump"
                data-testid="pending-follow"
                title={t('queue.queueItTip')}
                onClick={() => void releaseSend(item.id, 'followUp')}
              >
                {t('queue.queueIt')}
              </button>
            </>
          ) : (
            <button
              className="qrow-jump primary"
              data-testid="pending-send"
              title={t('queue.sendNowTip')}
              onClick={() => void releaseSend(item.id, 'followUp')}
            >
              {t('queue.sendNow')}
            </button>
          )}
          <button
            className="qrow-jump"
            data-testid="pending-restore"
            title={t('queue.restoreTip')}
            onClick={() => restoreSend(item.id)}
          >
            {t('queue.restore')}
          </button>
        </div>
      ))}
      {steering.map((item) => (
        <div className="qrow steering" key={item.id} title={item.text} data-testid="queue-row">
          <Icon name="activity" size={12} />
          <span className="qrow-text">{item.text}</span>
          <span className="qrow-tag">{t('queue.inserting')}</span>
          <button
            className="qrow-jump"
            data-testid="queue-retract"
            title={t('queue.retractTip')}
            onClick={() => void removeQueued(item.id)}
          >
            {t('queue.retract')}
          </button>
        </div>
      ))}
      {followUp.map((item) => (
        <div className="qrow" key={item.id} title={item.text} data-testid="queue-row">
          <Icon name="history" size={12} />
          <span className="qrow-text">{item.text}</span>
          <button
            className="qrow-jump"
            data-testid="queue-steer"
            title={t('queue.steerTip')}
            onClick={() => void steerQueued(item.id)}
          >
            {t('queue.steer')}
          </button>
          <button
            className="qrow-jump"
            data-testid="queue-retract"
            title={t('queue.retractTip')}
            onClick={() => void removeQueued(item.id)}
          >
            {t('queue.retract')}
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * 工作模式菜单（实施-05 §3）。
 *
 * 原位显示「标准 / 计划 / 自主 ▾」，菜单单选项带一句说明。三种输入方式：
 *   · 鼠标：点按钮 → 点选项；
 *   · 键盘：按钮上 ↑↓ 打开，菜单里 ↑↓ 移动、Enter / Space 选定、Esc 关闭；
 *   · Tab 快切（可在设置里关）：输入框里裸 Tab 循环三档。
 *
 * ⚠️ 模式是**按会话**的：这里读 store 里当前会话的投影；提交失败（版本冲突）
 *    时把显示恢复成主进程回传的当前值 —— 不能出现「界面已自主而模型仍标准」。
 */
function WorkModePicker({ buttonRef }: { buttonRef: React.RefObject<HTMLButtonElement | null> }) {
  const t = useT()
  const stored = useStore((s) => s.workMode)
  const fallback = useStore((s) => s.settings?.defaultWorkMode ?? 'standard')
  const setWorkMode = useStore((s) => s.setWorkMode)
  const state: WorkMode = stored?.mode ?? fallback
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  /**
   * 菜单坐标（fixed 定位）。
   *
   * 为何不 absolute 贴按钮：`.composer` 有 `overflow: hidden`（圆角与自主光带
   * 需要它），absolute 菜单会被整块裁掉 —— 模型选择器踩过同一个坑
   *（见 redesign.css 的 `.mt-pop`）。所以量按钮 rect，向上弹。
   */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const MENU_WIDTH = 288

  /* 打开时高亮当前档、量坐标、并把焦点交给菜单 —— 否则方向键到不了这里 */
  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    setIndex(Math.max(0, WORK_MODES.indexOf(state)))
    const el = buttonRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8))
      setAnchor({ left, bottom: Math.max(8, window.innerHeight - r.top + 6) })
    }
    menuRef.current?.focus()
  }, [open, state, buttonRef])

  /* 点外部关闭（菜单是浮层，不能一直挡着输入区） */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const commit = (mode: WorkMode) => {
    setOpen(false)
    buttonRef.current?.focus()
    if (mode !== state) void setWorkMode(mode)
  }

  return (
    <div className="mode-picker" ref={rootRef}>
      <button
        ref={buttonRef}
        className="ctool mode-button"
        data-testid="work-mode-button"
        data-mode={state}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t(`workMode.desc.${state}`)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          } else if (e.key === 'Escape' && open) {
            e.preventDefault()
            setOpen(false)
          }
        }}
      >
        <Icon name="sparkles" size={12} />
        <span className="mode-label" data-testid="work-mode-label">
          {t(`workMode.label.${state}`)}
        </span>
        <span className="mode-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <div
          className="mode-menu"
          role="menu"
          data-testid="work-mode-menu"
          data-mode={state}
          ref={menuRef}
          tabIndex={-1}
          style={{
            width: MENU_WIDTH,
            ...(anchor ? { left: anchor.left, bottom: anchor.bottom } : {})
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => (i + 1) % WORK_MODES.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => (i - 1 + WORK_MODES.length) % WORK_MODES.length)
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              commit(WORK_MODES[index])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
              buttonRef.current?.focus()
            }
            /* Tab：不拦 —— 焦点自然离开菜单（tabIndex=-1 的容器不在 Tab 序列里） */
          }}
        >
          {WORK_MODES.map((mode, i) => (
            <button
              key={mode}
              role="menuitemradio"
              aria-checked={mode === state}
              tabIndex={-1}
              className={`mode-item ${i === index ? 'active' : ''} ${mode === state ? 'current' : ''}`}
              data-testid={`work-mode-option-${mode}`}
              data-mode={mode}
              onMouseEnter={() => setIndex(i)}
              onClick={() => commit(mode)}
            >
              <span className="mode-item-label">{t(`workMode.label.${mode}`)}</span>
              <span className="mode-item-desc">{t(`workMode.desc.${mode}`)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * `+` 菜单（2026-09-22）：codex 式「添加」入口。
 *
 * 为什么不再让 `+` 直接开图片选择器：图片只是**其中一种**能加进来的东西。
 * 「文件和文件夹」「图片」「能力」并排之后，用户不用先猜 `+` 会做什么。
 *
 * ⚠️ 菜单是 `fixed` 定位：`.composer` 有 `overflow: hidden`（圆角与自主光带
 *    需要它），`absolute` 会被整块裁掉 —— 与 `.mode-menu` / `.mt-pop` 同一个坑。
 */
function PlusMenu({ onInsert }: { onInsert: (text: string) => void }) {
  const t = useT()
  const pickImages = useStore((s) => s.pickImages)
  const pickFiles = useStore((s) => s.pickFiles)
  const setGoal = useStore((s) => s.setGoal)
  const openSettings = useStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const [caps, setCaps] = useState<{ id: string; title: string; hint: string }[] | null>(null)
  /* 目标表单：菜单内的第二层，不另开浮层（浮层叠浮层在窄屏上会互相遮） */
  const [composing, setComposing] = useState(false)
  const [goalText, setGoalText] = useState('')
  const [outcomeText, setOutcomeText] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const goalInputRef = useRef<HTMLTextAreaElement>(null)
  const MENU_WIDTH = 340

  /* 打开时量按钮坐标并把焦点交给菜单 —— 否则方向键到不了菜单里 */
  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const el = buttonRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8))
      setAnchor({ left, bottom: Math.max(8, window.innerHeight - r.top + 6) })
    }
    menuRef.current?.focus()
  }, [open])

  /* 点外部关闭（菜单是浮层，不能一直挡着输入区） */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  /*
   * 能力清单**打开时才拉**：它要读磁盘上的技能目录与 MCP 配置，
   * 每次渲染都拉会把输入区变成一个会打磁盘的组件。
   */
  useEffect(() => {
    if (!open || caps) return
    let alive = true
    void (async () => {
      try {
        const snap = await window.yan.capabilities.snapshot()
        if (!alive) return
        setCaps([
          ...snap.skills.map((s) => ({ id: `skill:${s.id}`, title: s.title, hint: s.description })),
          ...snap.servers.map((s) => ({
            id: `mcp:${s.id}`,
            title: s.title,
            hint: s.enabled ? s.transport : `${s.transport} · ${t('cap.disabled')}`
          }))
        ])
      } catch {
        /* 读不到就当没有能力 —— 菜单本身仍然可用 */
        if (alive) setCaps([])
      }
    })()
    return () => {
      alive = false
    }
  }, [open, caps, t])

  const close = (): void => {
    setOpen(false)
    setComposing(false)
    buttonRef.current?.focus()
  }

  /* 进目标表单时把焦点交给第一栏 —— 否则键盘用户要 Tab 一路找过去 */
  useEffect(() => {
    if (open && composing) goalInputRef.current?.focus()
  }, [open, composing])

  /** 建立持续目标：成功才把消息模板写进输入框（失败时输入框不该被动过） */
  const startGoal = async (): Promise<void> => {
    const goal = goalText.trim()
    const outcome = outcomeText.trim()
    if (!goal || !outcome) return
    /*
     * A7（实施-14 F5）：await 之前记下会话身份，回来先核对。
     * 用户在等响应的这几百毫秒里切了会话时，不能把目标模板插到另一条会话的输入框。
     */
    const before = identityForAwait(useStore.getState())
    const res = await setGoal({ goal, outcome })
    if (!res.ok) return
    if (identityForAwait(useStore.getState()) !== before) return
    close()
    onInsert(t('plus.goalSeed', { goal, outcome }))
    setGoalText('')
    setOutcomeText('')
  }

  return (
    <div className="mode-picker" ref={rootRef}>
      <button
        ref={buttonRef}
        className="ctool"
        title={t('composer.attach')}
        data-testid="composer-attach"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
          } else if (e.key === 'Escape' && open) {
            e.preventDefault()
            close()
          }
        }}
      >
        <Icon name="plus" size={12} />
      </button>

      {open ? (
        <div
          className="mode-menu plus-menu"
          role="menu"
          data-testid="plus-menu"
          ref={menuRef}
          tabIndex={-1}
          style={{ width: MENU_WIDTH, ...(anchor ? { left: anchor.left, bottom: anchor.bottom } : {}) }}
        >
          {composing ? (
            /*
             * 目标表单：目标 + **可衡量的成果**两栏。
             * 第二栏不是可选的 —— 「不达成不结束」需要一条能验收的判据，
             * 否则模型永远可以宣布自己完成了。
             */
            <div className="plus-compose" data-testid="plus-goal-compose">
              <span className="plus-group-label">{t('plus.goalTitle')}</span>
              <label className="plus-field">
                <span className="plus-field-label">{t('plus.goalField')}</span>
                <textarea
                  ref={goalInputRef}
                  className="plus-input"
                  data-testid="plus-goal-text"
                  rows={2}
                  value={goalText}
                  placeholder={t('plus.goalPlaceholder')}
                  onChange={(e) => setGoalText(e.target.value)}
                />
              </label>
              <label className="plus-field">
                <span className="plus-field-label">{t('plus.outcomeField')}</span>
                <textarea
                  className="plus-input"
                  data-testid="plus-outcome-text"
                  rows={2}
                  value={outcomeText}
                  placeholder={t('plus.outcomePlaceholder')}
                  onChange={(e) => setOutcomeText(e.target.value)}
                />
              </label>
              <div className="plus-actions">
                <button
                  className="plus-start"
                  data-testid="plus-goal-start"
                  disabled={!goalText.trim() || !outcomeText.trim()}
                  onClick={() => void startGoal()}
                >
                  {t('plus.goalStart')}
                </button>
                <button
                  className="plus-back"
                  data-testid="plus-goal-back"
                  onClick={() => setComposing(false)}
                >
                  {t('plus.goalBack')}
                </button>
              </div>
            </div>
          ) : (
            <>
          <button
            className="mode-item"
            role="menuitem"
            data-testid="plus-files"
            onClick={() => {
              close()
              void pickFiles()
            }}
          >
            <span className="mode-item-label">{t('plus.files')}</span>
            <span className="mode-item-desc">{t('plus.filesHint')}</span>
          </button>
          <button
            className="mode-item"
            role="menuitem"
            data-testid="plus-images"
            onClick={() => {
              close()
              void pickImages()
            }}
          >
            <span className="mode-item-label">{t('plus.images')}</span>
            <span className="mode-item-desc">{t('plus.imagesHint')}</span>
          </button>
          <button
            className="mode-item"
            role="menuitem"
            data-testid="plus-goal"
            onClick={() => setComposing(true)}
          >
            <span className="mode-item-label">{t('plus.goal')}</span>
            <span className="mode-item-desc">{t('plus.goalHint')}</span>
          </button>

          <div className="plus-group" data-testid="plus-capabilities">
            <span className="plus-group-label">{t('plus.capabilities')}</span>
            {caps === null ? null : caps.length === 0 ? (
              /*
               * 空态可直接点：用户看到「去设置里加」时的下一个动作就是去那里，
               * 让他再自己找一遍设置入口是多一层无用功。
               */
              <button
                className="mode-item plus-empty"
                data-testid="plus-cap-empty"
                onClick={() => {
                  close()
                  openSettings('capabilities')
                }}
              >
                <span className="mode-item-label">{t('plus.capEmpty')}</span>
                <span className="mode-item-desc">{t('plus.capEmptyHint')}</span>
              </button>
            ) : (
              caps.map((cap) => (
                <button
                  key={cap.id}
                  className="mode-item"
                  role="menuitem"
                  data-testid={`plus-cap-${cap.id}`}
                  onClick={() => {
                    close()
                    onInsert(t('plus.useCapability', { title: cap.title }))
                  }}
                >
                  <span className="mode-item-label">{cap.title}</span>
                  <span className="mode-item-desc">{cap.hint}</span>
                </button>
              ))
            )}
          </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 把 File 读成 base64 附件 */
async function readFiles(files: File[], add: (a: Attachment[]) => void): Promise<void> {
  const out: Attachment[] = []
  for (const f of files) {
    if (f.size > 12 * 1024 * 1024) continue
    try {
      const buf = await f.arrayBuffer()
      const data = bytesToBase64(new Uint8Array(buf))
      out.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.name || 'pasted.png',
        mimeType: f.type || 'image/png',
        size: f.size,
        data,
        preview: data
      })
    } catch {
      /* 读不了就跳过 */
    }
  }
  add(out)
}

/** 不用 FileReader：它返回 data: 前缀，而 pi 要的是裸 base64 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 分类只影响候选菜单的视觉顺序，不改变 pi 原始命令的身份。 */
function commandSourceRank(command: SlashCommand): number {
  return {
    yan: 0,
    pi: 1,
    extension: 2,
    skill: 3,
    prompt: 4,
    compatibility: 5
  }[command.source]
}

function commandSourceLabel(source: SlashCommand['source']): string {
  return {
    yan: 'Yan 内置',
    pi: 'pi 内置',
    extension: '扩展',
    skill: '技能',
    prompt: '提示词模板',
    compatibility: '兼容显示'
  }[source]
}

/** 排队的插话 / 后续消息 —— 让「它知道我说了」可见 */



/**
 * 输入区里的模型胶囊 —— 点它打开设置的「状态」页。
 *
 * 为什么在这里再放一个（用量条里已经有了）：
 *   用量条在输入框**下面**，视线是「打完字往下扫」；
 *   而这里是「准备打字时先确认用什么模型」。
 *   Agents-Anywhere 也是这个位置放模型选择器。
 */
/* 输入区不再放模型胶囊 —— 
   顶部头部与底部用量条已经显示了模型，
   同一件事说三遍只会让人不确定该看哪个。 */
