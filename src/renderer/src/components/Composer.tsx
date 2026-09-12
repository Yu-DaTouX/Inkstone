import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { ComposerBorder } from './ComposerBorder'
import { UsageBar } from './UsageBar'
import type { Attachment } from '../../../shared/ipc'

/**
 * 输入区。四种输入模式共存：
 *
 *   · 普通文本      → prompt（发给模型）
 *   · `/` 开头       → 斜杠命令，带自动补全（扩展命令 / 提示词模板 / 技能）
 *   · `!` 开头       → 直接跑 shell，**不进模型**（`bash` 命令）
 *   · 贴/拖入图片    → 随 prompt 作为 images 发送
 *
 * Enter 发送 / Shift+Enter 换行 / Esc 中止。
 * 生成中按 Enter 会走 pi 的 steer（插话），这是 pi 的能力，值得暴露。
 */
export function Composer() {
  const t = useT()
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const send = useStore((s) => s.send)
  const abort = useStore((s) => s.abort)
  const runBash = useStore((s) => s.runBash)
  const busy = useStore((s) => !!s.session?.isStreaming)
  const conn = useStore((s) => s.conn)
  const commands = useStore((s) => s.commands)
  /** 常用排序（自动管理）、记录使用、以及列表的自动刷新 */
  const commandUse = useStore((s) => s.commandUse)
  const markCommandUsed = useStore((s) => s.markCommandUsed)
  const reloadCommands = useStore((s) => s.reloadCommands)
  const commandsAt = useStore((s) => s.commandsAt)
  const attachments = useStore((s) => s.attachments)
  const addAttachments = useStore((s) => s.addAttachments)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const clearAttachments = useStore((s) => s.clearAttachments)
  const pickImages = useStore((s) => s.pickImages)
  const editorInject = useStore((s) => s.editorInject)
  const consumeEditorInject = useStore((s) => s.consumeEditorInject)
  const queueRestore = useStore((s) => s.queueRestore)
  const consumeQueueRestore = useStore((s) => s.consumeQueueRestore)

  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ open: boolean; index: number }>({ open: false, index: 0 })

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
  /** 拖出来的高度（px）。0 = 用默认的 max-height */
  const [tall, setTall] = useState(0)

  /** 展开后的默认高度：够写一段，但不至于占半个屏 */
  const TALL_H = 180

  /** 开关长文模式。开启时给一个默认高度；关闭时完全回到默认尺寸 */
  const toggleExpanded = useCallback((): void => {
    setExpanded((v) => {
      if (v) {
        setTall(0)
        return false
      }
      setTall(TALL_H)
      return true
    })
  }, [])

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
      handle.classList.add('active')
      document.body.classList.add('resizing-composer')

      const onMove = (ev: PointerEvent): void => {
        const dy = startY - ev.clientY
        moved = Math.max(moved, Math.abs(dy))
        // 只有真的动了才改动高度（否则轻微抖动会把“点击”变成“拖拽”）
        if (moved < 4) return
        const next = Math.max(40, Math.min(560, startT + dy))
        setTall(next)
        if (next > 48) setExpanded(true)
      }

      const onUp = (): void => {
        handle.classList.remove('active')
        document.body.classList.remove('resizing-composer')
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)

        // 位移极小 → 当成一次点击：切换长文模式
        if (moved < 4) {
          toggleExpanded()
          return
        }
        // 拖回默认高度 → 退出长文模式（恢复 Enter 发送）
        if ((ref.current?.offsetHeight ?? 40) <= 48) {
          setExpanded(false)
          setTall(0)
        }
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [tall, toggleExpanded]
  )

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
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20
    const pad = 16
    if (el.scrollHeight > lh * 3 + pad) {
      setExpanded(true)
      setTall(TALL_H)
    }
  }, [value, tall, expanded])

  const disabled = conn !== 'ready'

  /* ---- 模式判定 ---- */
  const bashMode = value.startsWith('!')
  const slashQuery = useMemo(() => {
    const m = /^\/([^\s]*)$/.exec(value)
    return m ? m[1] : null
  }, [value])

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
      .filter((c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q))
      .slice(0, 12)
    return hit.sort((a, b) => {
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
   *   没写前缀时（刚打出一个 `@`）不做任何 IO —— 用户可以继续打。
   *
   * 为什么不做成「文件选择器」：那需要主进程递归扫目录（慢、权限问题多），
   * 而 pi 自己会处理 `@path` 的解析 —— 我们只需要帮用户**少打几个字**。
   */
  const atQuery = useMemo(() => {
    // 光标前最后一个 @token（允许路径分隔符与常见文件名字符）
    const m = /@([\w./\\-]*)$/.exec(value)
    return m ? m[1] : null
  }, [value])

  /**
   * `@` 路径补全的候选。
   *
   * 异步去主进程查（只读一层目录），所以用 state 存。
   * 防抖：每敲一个字都发 IPC 会白干活。
   */
  const [paths, setPaths] = useState<string[]>([])

  useEffect(() => {
    if (atQuery === null || atQuery.trim().length < 2) {
      setPaths([])
      return
    }
    let alive = true
    const id = setTimeout(() => {
      void window.yan
        .completePath(atQuery)
        .then((r) => {
          if (alive) setPaths(r)
        })
        .catch(() => {
          if (alive) setPaths([])
        })
    }, 120)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [atQuery])

  const atMatches = useMemo(() => {
    if (atQuery === null || paths.length === 0) return []
    return paths.slice(0, 10)
  }, [atQuery, paths])

  useEffect(() => {
    if (slashQuery !== null && slashMatches.length > 0) {
      setMenu({ open: true, index: 0 })
    } else if (atMatches.length > 0) {
      setMenu({ open: true, index: 0 })
    } else {
      setMenu((m) => (m.open ? { open: false, index: 0 } : m))
    }
  }, [slashQuery, slashMatches.length, atMatches.length])

  const completeSlash = useCallback(
    (name: string) => {
      setValue(`/${name} `)
      setMenu({ open: false, index: 0 })
      /* 记录使用 → 下次它排在前面（自动管理） */
      markCommandUsed(name)
      ref.current?.focus()
    },
    [markCommandUsed]
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
      setValue((v) => v.replace(/@([\w./\\-]*)$/, `@${p}`))
      // 目录：保持菜单开（等下一层的结果自动刷新）；文件：关
      if (!p.endsWith('/')) setMenu({ open: false, index: 0 })
      ref.current?.focus()
    },
    []
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

    const images = attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }))
    setValue('')
    clearAttachments()
    await send(raw, images.length ? images : undefined)
  }

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

  /* ---- 图片：拖放 ---- */
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
      if (files.length === 0) return
      void readFiles(files, addAttachments)
    },
    [addAttachments]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /*
     * 补全菜单的键盘导航。
     *
     * 两个菜单（`/` 命令与 `@` 文件）共用同一个 menu 状态与按键处理 ——
     * 它们不会同时出现（`@` 只在 slashMatches 为空时才渲染）。
     */
    const items = slashMatches.length > 0 ? slashMatches.map((c) => c.name) : atMatches
    if (menu.open && items.length > 0) {
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
        if (slashMatches.length > 0) completeSlash(items[menu.index])
        else completeAt(items[menu.index])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
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
     * 发送键。
     *
     * 默认：Enter 发送，Shift+Enter 换行。
     *
     * ⚠️ 进了长文模式之后意图就变了 —— 那时他是要写长文，
     *   Enter 应该是换行。用户明确要求：
     *     「按回车按钮是换行而不是输入；
     *       按下 Ctrl+回车 或者发送按钮再发送」。
     *
     * Ctrl/Cmd+Enter 任何时候都能发送（写长文时也不会误发）。
     */
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const wantsSend = e.ctrlKey || e.metaKey || (!e.shiftKey && !expanded)
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
  }

  return (
    <div
      className={`composer-wrap ${dragging ? 'dropping' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className={`composer ${expanded ? 'tall' : ''}`}>
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
              <div className="attach" key={a.id} title={`${a.name} · ${fmtSize(a.size)}`}>
                <img src={`data:${a.mimeType};base64,${a.preview}`} alt={a.name} />
                <span className="attach-name">{a.name}</span>
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
              <button
                key={c.name}
                className={`slash-item ${i === menu.index ? 'sel' : ''}`}
                onMouseEnter={() => setMenu((m) => ({ ...m, index: i }))}
                onClick={() => completeSlash(c.name)}
                role="option"
                aria-selected={i === menu.index}
              >
                <span className="slash-name">/{c.name}</span>
                <span className="slash-desc">{c.description ?? ''}</span>
                <span className="slash-src">{c.source}</span>
              </button>
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
            </div>
          </div>
        ) : null}

        {/* `@` 文件引用补全（pi 的 @files 用法）。
            只列主进程返回的那一层目录结果，不递归扫项目。 */}
        {menu.open && slashMatches.length === 0 && atMatches.length > 0 ? (
          <div className="slash-menu" role="listbox" data-testid="at-menu">
            {atMatches.map((p, i) => (
              <button
                key={p}
                className={`slash-item ${i === menu.index ? 'sel' : ''}`}
                onMouseEnter={() => setMenu((m) => ({ ...m, index: i }))}
                onClick={() => completeAt(p)}
                role="option"
                aria-selected={i === menu.index}
              >
                <span className="slash-name">{p.endsWith('/') ? '▸ ' : '· '}{p}</span>
                <span className="slash-src">{p.endsWith('/') ? t('composer.dir') : t('composer.file')}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* 拖拽调高：贴在顶边框上的一根小短横 */}
        <div
          className="composer-resize"
          onPointerDown={startResize}
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
          onChange={(e) => setValue(e.target.value)}
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

            <button
              className="ctool"
              onClick={() => void pickImages()}
              title={t('composer.attach')}
              data-testid="composer-attach"
            >
              <Icon name="plus" size={12} />
            </button>

            <QueueBadge />

            {/*
             * 放大状态下的提示。
             *
             * 为什么需要：拖大之后 Enter 的语义变了（换行），
             * 而这是**看不见的规则** —— 不提示的话用户会按 Enter 发现没发出去，
             * 以为是坏了。直接把当下规则写在旁边。
             */}
            {expanded ? (
              <span className="ctool-hint" data-testid="composer-keyhint">
                {t('composer.enterNewline')}
              </span>
            ) : null}
          </div>
          <button
            className={`send ${busy ? 'abort' : ''}`}
            data-testid="send"
            onClick={busy ? () => void abort() : () => void submit()}
            /* 有附件就能发 —— 与 submit() 的判据保持一致（否则按钮是灰的，点不动） */
            disabled={!busy && (!value.trim() && attachments.length === 0 ? true : disabled)}
            title={expanded ? t('composer.sendTipTall') : undefined}
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

/** 排队的插话 / 后续消息 —— 让「它知道我说了」可见 */
function QueueBadge() {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const n = queue.steering.length + queue.followUp.length
  if (n === 0) return null
  return (
    <span className="queue-badge" title={[...queue.steering, ...queue.followUp].join('\n')}>
      <Icon name="history" size={12} />
      <span>{t('queue.pending', { n })}</span>
    </span>
  )
}



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
