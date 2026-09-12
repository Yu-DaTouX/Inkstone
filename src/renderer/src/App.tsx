import { useEffect, useMemo, useRef, useState } from 'react'
/* touch 1789070960743 */import { VList, type VListHandle } from 'virtua'
import { IconSprite } from './icons/Icon'
import { useI18n } from './i18n'
import { TitleBar, type Theme } from './components/TitleBar'
import { Rail } from './components/Rail'
import { RightPanel } from './components/RightPanel'
import { Resizer } from './components/Resizer'
import { Icon } from './icons/Icon'
import { ConversationOutline } from './components/ConversationOutline'
import { Continuity, EmptyStream, ReviewBar } from './components/Continuity'
import { TurnView } from './components/TurnView'
import { groupIntoTurns } from '../../shared/turns'
import { Composer } from './components/Composer'
import { Settings, type SettingsTab } from './components/Settings'
import { Onboarding, markOnboarded, shouldAutoOnboard } from './components/Onboarding'
import { ConnBar, Notices, UiDialog } from './components/UiBridge'
import { useStore } from './state/store'
import './styles/tokens.css'
import './styles/app.css'
import './styles/stage1.css'
import './styles/stage2.css'
import './styles/redesign.css'
// 动效放最后：它要覆盖同名选择器上的旧动画（第 43 节那套已废弃）
import './styles/motion.css'
import './styles/settings.css'
import './styles/electron.css'
import './styles/highlight.css'

/**
 * 超过这么多条消息才开启虚拟化。
 *
 * 为什么不平一直开：虚拟化会改变 DOM 结构（外层变成绝对定位的项），
 * 而消息高度是**动态**的（流式文本在长、工具卡在展开/折叠），
 * 短会话里收益为零、风险却真实。长会话（上千条）才是会卡死的场景。
 */
const VIRTUALIZE_AT = 80

function readTheme(parent: Theme | undefined): Theme {
  if (parent) return parent
  try {
    const v = localStorage.getItem('yan.theme')
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* file:// 下 localStorage 会抛，忽略 */
  }
  return 'dark'
}

export default function App() {
  const { lang, setLang, t } = useI18n()
  const [theme, setTheme] = useState<Theme>(() => readTheme(undefined))
  /** 首次使用引导（默认关；启动后按条件自动开） */
  const [onboarding, setOnboarding] = useState(false)
  /** 只在第一次判定时决定是否自动弹，之后用户关了就不管了 */
  const onboardDecided = useRef(false)
  /**
   * 左栏自动隐藏。
   *
   * 三种状态：
   *   pinned  用户点了标题栏的按钮 → 展开
   *   其余    收起
   *
   * 为什么默认收起：会话列表是「偶尔翻找」的东西，
   * 让它常驻占 300px 不如把宽度让给对话。
   */
  /**
   * 左栏只由标题栏那个按钮控制（用户要求取消鼠标悬停自动展开）。
   *
   * ⚠️ 以前有三种状态：pinned / hover / 收起。悬停那套实现是
   *   “鼠标靠近左边缘 12px → 延迟 320ms 展开，离开 1.5s 后收回”。
   *   为什么去掉：
   *     · 它会**抢走鼠标**——想去点中栏最左边的导航轨时，
   *       侧栏先弹出来把内容推走（推挤式布局会重排）
   *     · “1.5s 后收回”让界面在你还没读完时就开始动
   *     · 现在开关在**各自面板的头部**（用户要求），
   *       收起后左栏左边留一个把手（.rail-stub）用于展开，
   *       显式控制比猜测意图可靠
   */
  const railPinned = useStore((s) => s.railPinned)
  const setRailPinned = useStore((s) => s.setRailPinned)
  const rightPanelOpen = useStore((s) => s.settings?.rightPanelOpen ?? true)
  const toggleRightPanel = useStore((s) => s.toggleRightPanel)
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const cycleModel = useStore((s) => s.cycleModel)
  const cycleThinking = useStore((s) => s.cycleThinking)

  /* 左栏是否可见：只取决于那个开关 */
  const railOpen = railPinned
  // 设置面板状态放 store（ContextBar 等深层组件要能直接打开）
  const settingsOpen = useStore((s) => s.settingsOpen)
  const settingsTab = useStore((s) => s.settingsTab as SettingsTab)
  const openSettings = useStore((s) => s.openSettings)
  const closeSettings = useStore((s) => s.closeSettings)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  /** 用户的显式选择优先于主进程存的设置，避免来回打架 */
  const userTouched = useRef({ theme: false, lang: false })

  const conn = useStore((s) => s.conn)
  const messages = useStore((s) => s.messages)
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const bootstrap = useStore((s) => s.bootstrap)
  const startConnWatch = useStore((s) => s.startConnWatch)
  const maximized = useStore((s) => s.maximized)
  const setScrollProgress = useStore((s) => s.setScrollProgress)
  const registerScrollToTurn = useStore((s) => s.registerScrollToTurn)
  const applyPush = useStore((s) => s.applyPush)
  const changeCwd = useStore((s) => s.changeCwd)
  const piInfo = useStore((s) => s.piInfo)
  const models = useStore((s) => s.models)

  const streamRef = useRef<HTMLDivElement>(null)
  const vlistRef = useRef<VListHandle>(null)
  /*
   * 「跟随底部」开关。
   *
   * ⚠️ 为什么 state 之外还要一个 ref：
   *   state 的更新是**异步**的（React 批处理），而消息推送随时可能到达。
   *   实测踩到的 bug：点导航轨往上跳 → setStick(false) 还没生效 →
   *   同一帧来了一条 msg-update → 贴底 effect 读到旧的 stick=true
   *   → 把用户**拽回底部**。表现就是「点了跳转但没跳过去」（探针实测
   *   时而 scrollTop=24 ✓，时而 1158 = 到底 ✗）。
   *   ref 是同步写的，effect 读它就不会被批处理坑到。
   */
  const [stick, setStick] = useState(true)
  const stickRef = useRef(true)
  const setStickNow = (v: boolean): void => {
    stickRef.current = v
    setStick(v)
  }

  /**
   * 正在流式的那条消息（给回合视图标记「还在写」）。
   *
   * 注意取的是**最后一条**消息的 id，而不是「最后一条 assistant」——
   * 流式刚开始时最后一条还是用户消息，那时不该有任何回合在闪光标。
   */
  const streamingId = session?.isStreaming ? messages[messages.length - 1]?.id : undefined

  /**
   * 回合分组 —— 把扁平的 messages 折成「一轮一块」。
   *
   * 为什么要记 memoize：每次 msg-update 推送（流式时几十次/秒）都会重算，
   * 而分组要遍历整个消息数组。依赖只有 messages 与 streamingId。
   */
  const turns = useMemo(() => groupIntoTurns(messages, streamingId), [messages, streamingId])

  const virtual = turns.length >= VIRTUALIZE_AT

  /* ---- 主进程推送 → store；并做一次全量 bootstrap ---- */
  useEffect(() => {
    const off = window.yan.onPush(applyPush)
    void bootstrap()
    // 连接状态自愈：push 可能丢（见 store 里的说明），不 ready 就主动拉
    startConnWatch()
    return off
  }, [applyPush, bootstrap, startConnWatch])

  /* ---- 首次引导：数据到位后判定一次 ---- */
  useEffect(() => {
    if (onboardDecided.current) return
    if (!settings) return // 等 bootstrap 有结果
    onboardDecided.current = true
    if (shouldAutoOnboard({ conn, piInfo, models })) setOnboarding(true)
  }, [settings, conn, piInfo, models])

  /* ---- 设置只在首次到达时对齐 UI（之后以 UI 为准） ---- */
  useEffect(() => {
    if (!settings) return
    if (!userTouched.current.theme && settings.theme !== theme) setTheme(settings.theme)
    if (!userTouched.current.lang && settings.lang !== lang) setLang(settings.lang)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  /* ---- 设置面板里改主题时同步 App 的 state ---- */
  useEffect(() => {
    const onTheme = (e: Event): void => {
      const next = (e as CustomEvent).detail
      if (next === 'dark' || next === 'light') {
        userTouched.current.theme = true
        setTheme(next)
      }
    }
    window.addEventListener('yan:theme', onTheme)
    return () => window.removeEventListener('yan:theme', onTheme)
  }, [])

  /* ---- 主题令牌挂在 <html data-theme>（DESIGN §2.6） ---- */
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('yan.theme', theme)
    } catch {
      /* 忽略 */
    }
    if (settings && settings.theme !== theme) void window.yan.patchSettings({ theme })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  useEffect(() => {
    if (settings && settings.lang !== lang) void window.yan.patchSettings({ lang })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  /* ---- 贴底滚动：用户往上翻了就不打扰 ---- */
  useEffect(() => {
    if (!stickRef.current) return
    if (virtual) {
      // 虚拟列表：滚到最后一项的末尾
      vlistRef.current?.scrollToIndex(turns.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
    // 依赖 turns 而不是 messages：回合合并后一块里也可能长高（新段落）
  }, [turns, stick, virtual])

  const onScroll = () => {
    const el = streamRef.current
    if (!el) return
    setStickNow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)

    // 滚动进度 → 导航轨用它算「当前读到第几轮」
    const range = el.scrollHeight - el.clientHeight
    setScrollProgress(range > 0 ? el.scrollTop / range : 0)
  }

  /**
   * 跳到第 N 轮。把它注册到 store 给导航轨用。
   *
   * 两种渲染路径要分开处理：
   *   · 虚拟化（长会话）→ VList 的 scrollToIndex
   *   · 普通 → 找到对应的 DOM 节点 scrollIntoView
   * 不能统一用 scrollIntoView —— 虚拟化时目标节点可能还没渲染。
   */
  useEffect(() => {
    registerScrollToTurn((turnIndex: number) => {
      /*
       * 先**同步**关掉「跟随底部」。
       *
       * 跳转是用户明确表达「我要看前面」。而在平滑滚动开始到第一个
       * scroll 事件之间有一段时间，其间若来一条消息推送，
       * 贴底 effect 会把用户拉回底部。同步写 ref 就把这个窗口封死了。
       */
      setStickNow(false)

      /*
       * 导航轨的「第 N 轮」= 第 N 个**用户回合**。
       *
       * 合并后一块助手回合里可能含 34 条原始消息，所以不能再用
       * messages 的下标去定位 —— 要用**回合数组的下标**。
       */
      const userTurns: number[] = []
      turns.forEach((tt, i) => {
        if (tt.kind === 'user') userTurns.push(i)
      })
      const target = userTurns[turnIndex]
      if (target === undefined) return

      if (virtual) {
        vlistRef.current?.scrollToIndex(target, { align: 'start' })
        return
      }

      const turn = turns[target]

      /*
       * ⚠️ 必须等**这一帧的提交**结束再滚。
       *
       * 上面 `setStickNow(false)` 会让 React 重渲染（`!stick` 时会挂出
       * 「回到底部」按钮），而重渲染会让浏览器**取消正在进行的平滑滚动**。
       * 推到下一帧（提交后）再滚，就不会被取消。
       */
      requestAnimationFrame(() => {
        const el = streamRef.current?.querySelector<HTMLElement>(`[data-turn-id="${turn.id}"]`)
        if (!el) return

        /*
         * **一律瞬移，不用平滑滚动。**
         *
         * 本会话实测（这是第二次在这个点上耽误时间了）：
         *   scrollIntoView({behavior:'smooth'}) 单独调用  → 能滑到位
         *   同一行代码放进这里（重渲染之后）            → **永远不动**
         * 原因是平滑滚动会被任何一次重渲染取消，而这条路径上
         * 总有重渲染（setStickNow / setHover / 流式推送）。
         *
         * 曾经写过「跳得远就瞬移、跳得近就平滑」来缓解 —— 那只是拆中一半：
         * 距离阈值是 `box.height * 1.5`，而实测的跳动距离（594px）
         * 恰好小于阈值（954px）→ 又走回平滑 → 又不动。
         *
         * 现在直接不用平滑：「跳到第 N 轮」本来就是**定位**，不是看动画。
         * 代价只是少一个滚动动效，换来的是它真的能用。
         */
        el.scrollIntoView({ behavior: 'auto', block: 'start' })
      })
    })
  }, [turns, virtual, registerScrollToTurn])

  /** 虚拟列表的滚动回调：用 handle 的尺寸算「是否贴底」 */
  const onVirtualScroll = () => {
    const h = vlistRef.current
    if (!h) return
    setStickNow(h.scrollSize - h.scrollOffset - h.viewportSize < 40)
  }

  const jumpToBottom = () => {
    setStickNow(true)
    if (virtual) {
      vlistRef.current?.scrollToIndex(turns.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  /**
   * 全局快捷键 —— 对齐 pi TUI 的默认绑定。
   *
   *   Ctrl+P     下一模型   （pi: app.model.cycleForward）
   *   Shift+Tab  下一强度   （pi: app.thinking.cycle）
   *
   * ⚠️ 主路径在**主进程**（before-input-event），它先在渲染端之前拦下来，
   *   再把动作名发过来；这里只负责执行 + 给反馈。
   *   为什么不在渲染端直接监听 window keydown：实测会漏 ——
   *   输入法组合态、焦点不在 webContents、菜单 accelerator 先吃，
   *   三种情况都真实存在。主进程那条路是可靠的。
   */
  useEffect(() => {
    const off = window.yan.onHotkey((action) => {
      if (action === 'cycleModel') void cycleModel()
      else if (action === 'cycleThinking') void cycleThinking()
    })

    /**
     * 兑底：窗口失焦后的第一下按键 / 旧版 preload（没有 onHotkey）时，
     * 渲染端的监听仍能接住。两条路都会跑，但重复触发是有害的
     * （快速按两下 Ctrl+P 会跳两个模型而不是一个），所以用时间锁去重。
     */
    let lastAt = 0
    const guard = (action: 'cycleModel' | 'cycleThinking'): void => {
      const now = Date.now()
      if (now - lastAt < 250) return
      lastAt = now
      if (action === 'cycleModel') void cycleModel()
      else void cycleThinking()
    }

    const onKey = (e: KeyboardEvent): void => {
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        guard('cycleModel')
        return
      }
      if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault()
        guard('cycleThinking')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off?.()
      window.removeEventListener('keydown', onKey)
    }
  }, [cycleModel, cycleThinking])

  const pickCwd = async () => {
    const p = await window.yan.pickCwd()
    if (p) await changeCwd(p)
  }

  const appCls = [
    'app',
    !railOpen && 'rail-off',
    railPinned && 'rail-pinned'
  ]
    .filter(Boolean)
    .join(' ')

  /**
   * 流式开始了但还没有可见内容。
   *
   * 只判断 text 不够 —— 工具行也算「有进展」，
   * 否则工具跑起来之后 spinner 还一直转，看着像卡住。
   */
  const lastTurn = turns[turns.length - 1]
  const hasVisibleBody =
    !!lastTurn &&
    (lastTurn.kind === 'user' ||
      lastTurn.kind === 'bash' ||
      lastTurn.commentary.length > 0 ||
      !!lastTurn.response ||
      lastTurn.tools.length > 0 ||
      !!lastTurn.thinking)

  return (
    <>
      <IconSprite />
      <div className={appCls}>
        <TitleBar
          onToggleRail={() => setRailPinned(!railPinned)}
          railOpen={railOpen}
          onToggleRightPanel={() => void toggleRightPanel()}
          rightPanelOpen={rightPanelOpen}
          alwaysOnTop={alwaysOnTop}
          onToggleAlwaysOnTop={() => void toggleAlwaysOnTop()}
          maximized={maximized}
          onSettings={() => (settingsOpen ? closeSettings() : openSettings())}
          conn={conn}
          cwd={settings?.cwd}
          onPickCwd={() => void pickCwd()}
        />

        <div className="workspace">
          {/* ⚠️ 这里曾经有一个 .rail-hotzone —— 
              它是 .workspace 的第一个 grid item，会白占掉第一列，
              导致 .rail-slot 被挤到第二列、.center 落到 0px 宽的第三列。
              而「鼠标靠近左边缘」是用 window mousemove 的 clientX 判断的，
              根本不需要 DOM 元素。 */}
        {/*
         * 展开把手**已删除**（曾经用 .rail-stub）。
         *
         * 为什么删：它和左栏头部的开关是**两个不同的元素、两套几何**，
         * 所以展开前/后按钮的位置与大小对不上（用户报的第二个问题）。
         * 而且收起时左栏虽然透明却仍然盖在把手上（过时的
         * `.app.rail-off .rail{pointer-events:auto}`），导致把手根本点不到 ——
         * 实测 elementFromPoint 命中的是 rail-brand-btn。
         *
         * 现在改成：**同一个按钮**（左栏头部的 .rail-brand-btn）在收起时
         * 仍然可见可点 —— 收起宽度 50px 刚好容纳它，几何完全一致。
         */}
        <div className="rail-slot">
          {/*
            左栏开关在标题栏最左上（用户要求，参考 Codex）——
            所以收起就是真的 0 宽，这里不再需要留槽/悬停按钮。
            收起后仍能展开：标题栏那个按钮的位置从不变。
          */}
          <Rail />
          {/* 宽度把手：贴在左栏右缘（放进 slot 内部，不占 grid 列） */}
          <Resizer side="rail" />
        </div>

          <section className="center">
            <Continuity />

            {conn !== 'ready' ? <ConnBar conn={conn} /> : null}

            <ConversationOutline />

            {virtual ? (
              <VList
                ref={vlistRef}
                data={turns}
                className="stream"
                bufferSize={800}
                onScroll={onVirtualScroll}
              >
                {(tt) => (
                  <div className="stream-row">
                    <TurnView turn={tt} streaming={tt.kind === 'assistant' && tt.streaming} />
                  </div>
                )}
              </VList>
            ) : (
              <div className="stream" ref={streamRef} onScroll={onScroll}>
                <div className="stream-inner">
                  {turns.length === 0 ? (
                    <EmptyStream />
                  ) : (
                    turns.map((tt) => (
                      <TurnView
                        key={tt.id}
                        turn={tt}
                        streaming={tt.kind === 'assistant' && tt.streaming}
                      />
                    ))
                  )}
                </div>
              </div>
            )}

            {/*
             * 「⠋ 正在处理…」已搬到**输入框的顶边框**上
             * （pi 的做法，见 ComposerBorder.tsx）。
             * 这里不再占一行，也不再有独立的像素 spinner。
             */}

            {!stick ? (
              <button className="jump-bottom" onClick={jumpToBottom}>
                <span className="jump-ico">↓</span>
              </button>
            ) : null}

            <ReviewBar />
            <Composer />
          </section>

          <RightPanel />
        </div>
      </div>

      {onboarding ? (
        <Onboarding
          onClose={() => {
            markOnboarded()
            setOnboarding(false)
          }}
        />
      ) : null}

      <UiDialog />
      <Notices />

      <Settings
        open={settingsOpen}
        tab={settingsTab}
        onClose={closeSettings}
        onTabChange={setSettingsTab}
      />
    </>
  )
}
