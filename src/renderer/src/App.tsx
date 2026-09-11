import { useEffect, useRef, useState } from 'react'
/* touch 1789070960743 */import { VList, type VListHandle } from 'virtua'
import { IconSprite } from './icons/Icon'
import { useI18n } from './i18n'
import { TitleBar, type Theme } from './components/TitleBar'
import { Rail } from './components/Rail'
import { RightPanel } from './components/RightPanel'
import { ConversationOutline } from './components/ConversationOutline'
import { Continuity, EmptyStream, ReviewBar } from './components/Continuity'
import { Message } from './components/Message'
import { Composer } from './components/Composer'
import { Settings, type SettingsTab } from './components/Settings'
import { ConnBar, Notices, StatusBar, UiDialog } from './components/UiBridge'
import { useStore } from './state/store'
import './styles/tokens.css'
import './styles/app.css'
import './styles/stage1.css'
import './styles/stage2.css'
import './styles/redesign.css'
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
  const { lang, setLang } = useI18n()
  const [theme, setTheme] = useState<Theme>(() => readTheme(undefined))
  /**
   * 左栏自动隐藏。
   *
   * 三种状态：
   *   pinned  用户点了标题栏的按钮 → 常驻，不自动收
   *   hover   鼠标靠近左边缘 → 展开（并会重算计时器）
   *   其余    收起
   *
   * 为什么默认收起：会话列表是「偶尔翻找」的东西，
   * 让它常驻占 224px 不如把宽度让给对话。
   */
  const railPinned = useStore((s) => s.railPinned)
  const setRailPinned = useStore((s) => s.setRailPinned)
  const [railHover, setRailHover] = useState(false)
  const railTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const railOpen = railPinned || railHover
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
  const setScrollProgress = useStore((s) => s.setScrollProgress)
  const registerScrollToTurn = useStore((s) => s.registerScrollToTurn)
  const applyPush = useStore((s) => s.applyPush)
  const changeCwd = useStore((s) => s.changeCwd)

  const streamRef = useRef<HTMLDivElement>(null)
  const vlistRef = useRef<VListHandle>(null)
  const [stick, setStick] = useState(true)

  const virtual = messages.length >= VIRTUALIZE_AT

  /* ---- 主进程推送 → store；并做一次全量 bootstrap ---- */
  useEffect(() => {
    const off = window.yan.onPush(applyPush)
    void bootstrap()
    // 连接状态自愈：push 可能丢（见 store 里的说明），不 ready 就主动拉
    startConnWatch()
    return off
  }, [applyPush, bootstrap, startConnWatch])

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
    if (!stick) return
    if (virtual) {
      // 虚拟列表：滚到最后一项的末尾
      vlistRef.current?.scrollToIndex(messages.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, stick, virtual])

  const onScroll = () => {
    const el = streamRef.current
    if (!el) return
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40)

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
      const users = messages.filter((m) => m.role === 'user')
      const target = users[turnIndex]
      if (!target) return

      const fullIndex = messages.findIndex((m) => m.id === target.id)
      if (fullIndex < 0) return

      if (virtual) {
        vlistRef.current?.scrollToIndex(fullIndex, { align: 'start' })
        return
      }
      const el = streamRef.current?.querySelector<HTMLElement>(
        `[data-msg-id="${target.id}"]`
      )
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [messages, virtual, registerScrollToTurn])

  /** 虚拟列表的滚动回调：用 handle 的尺寸算「是否贴底」 */
  const onVirtualScroll = () => {
    const h = vlistRef.current
    if (!h) return
    setStick(h.scrollSize - h.scrollOffset - h.viewportSize < 40)
  }

  const jumpToBottom = () => {
    setStick(true)
    if (virtual) {
      vlistRef.current?.scrollToIndex(messages.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const pickCwd = async () => {
    const p = await window.yan.pickCwd()
    if (p) await changeCwd(p)
  }

  /**
   * 左栏自动显隐。
   *
   * 用「指针 x 坐标」当唯一判据，不用 mouseenter/mouseleave 配对 ——
   * 配对很脆：鼠标快速划过或跨窗口时会漏掉 leave，侧栏就永久卡在展开态。
   *
   * 两个延迟：
   *   OPEN_DELAY  悬停多久才弹出。给一点延迟是为了**避免误触** ——
   *               鼠标只是路过左边缘时不该弹出来。
   *   CLOSE_DELAY 离开多久才收回。给 1.5s 是为了「不小心划出去」能回来。
   */
  useEffect(() => {
    if (railPinned) return

    const HOT = 12 // 左边缘多少像素内算「想打开」
    const MARGIN = 24 // 离开侧栏多远才算「走开」
    const OPEN_DELAY = 320
    const CLOSE_DELAY = 1500

    /** 当前左栏宽度 —— 从 CSS 变量读，不写死。
        写死过 224，结果左栏加宽到 300 后，鼠标停在侧栏中间就被判为「走开」。 */
    const railWidth = (): number => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--w-rail')
      const n = parseFloat(v)
      return Number.isFinite(n) && n > 0 ? n : 300
    }

    const clear = (): void => {
      if (railTimer.current) {
        clearTimeout(railTimer.current)
        railTimer.current = null
      }
    }

    const onMove = (e: MouseEvent): void => {
      const x = e.clientX
      const railW = railHover ? railWidth() : 0

      // 1) 靠近左边缘 → 延迟展开（不是立刻）
      if (x <= HOT) {
        if (!railHover && !railTimer.current) {
          railTimer.current = setTimeout(() => {
            railTimer.current = null
            setRailHover(true)
          }, OPEN_DELAY)
        } else if (railHover) {
          clear() // 已展开，取消任何待执行的收回
        }
        return
      }

      // 2) 还在侧栏里（或紧邻）→ 取消收回
      if (railHover && x <= railW + MARGIN) {
        clear()
        return
      }

      // 3) 走开了 → 把「待展开」取消掉；已展开的则延迟收回
      if (!railHover) {
        clear() // 还没展开就走开 → 别弹了
        return
      }
      if (!railTimer.current) {
        railTimer.current = setTimeout(() => {
          railTimer.current = null
          setRailHover(false)
        }, CLOSE_DELAY)
      }
    }

    window.addEventListener('mousemove', onMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      clear()
    }
  }, [railPinned, railHover])

  const appCls = [
    'app',
    !railOpen && 'rail-off',
    railPinned && 'rail-pinned'
  ]
    .filter(Boolean)
    .join(' ')

  const streamingId = session?.isStreaming ? messages[messages.length - 1]?.id : undefined

  return (
    <>
      <IconSprite />
      <div className={appCls}>
        <TitleBar
          theme={theme}
          onToggleTheme={() => {
            userTouched.current.theme = true
            setTheme((v) => (v === 'dark' ? 'light' : 'dark'))
          }}
          onToggleRail={() => setRailPinned(!railPinned)}
          railPinned={railPinned}
          railOpen={railOpen}
          onSettings={() => (settingsOpen ? closeSettings() : openSettings())}
          subtitle={session?.sessionName ?? session?.model?.name}
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
          <div className="rail-slot">
            <Rail />
          </div>

          <section className="center">
            <Continuity />

            {conn !== 'ready' ? <ConnBar conn={conn} /> : null}

            <ConversationOutline />

            {virtual ? (
              <VList
                ref={vlistRef}
                data={messages}
                className="stream"
                bufferSize={800}
                onScroll={onVirtualScroll}
              >
                {(m) => (
                  <div className="stream-row">
                    <Message msg={m} streaming={m.id === streamingId} />
                  </div>
                )}
              </VList>
            ) : (
              <div className="stream" ref={streamRef} onScroll={onScroll}>
                <div className="stream-inner">
                  {messages.length === 0 ? (
                    <EmptyStream />
                  ) : (
                    messages.map((m) => (
                      <Message key={m.id} msg={m} streaming={m.id === streamingId} />
                    ))
                  )}
                </div>
              </div>
            )}

            {!stick ? (
              <button className="jump-bottom" onClick={jumpToBottom}>
                <span className="jump-ico">↓</span>
              </button>
            ) : null}

            <ReviewBar />
            <StatusBar />
            <Composer />
          </section>

          <RightPanel />
        </div>
      </div>

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
