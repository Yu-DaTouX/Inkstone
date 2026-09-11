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
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 34), 240)}px`
  }, [value])

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
    return commands
      .filter((c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q))
      .slice(0, 12)
  }, [commands, slashQuery])

  useEffect(() => {
    if (slashQuery !== null && slashMatches.length > 0) {
      setMenu({ open: true, index: 0 })
    } else {
      setMenu((m) => (m.open ? { open: false, index: 0 } : m))
    }
  }, [slashQuery, slashMatches.length])

  const completeSlash = useCallback(
    (name: string) => {
      setValue(`/${name} `)
      setMenu({ open: false, index: 0 })
      ref.current?.focus()
    },
    []
  )

  const submit = async () => {
    const raw = value.trim()
    if (!raw) return

    if (bashMode) {
      // `!` 开头的走直接执行，不进模型
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
    // 斜杠菜单打开时，方向键/Enter/Tab 归菜单
    if (menu.open && slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMenu((m) => ({ ...m, index: (m.index + 1) % slashMatches.length }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMenu((m) => ({ ...m, index: (m.index - 1 + slashMatches.length) % slashMatches.length }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        completeSlash(slashMatches[menu.index].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu({ open: false, index: 0 })
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape' && busy) {
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
      <div className="composer">
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
          </div>
        ) : null}

        <textarea
          ref={ref}
          rows={2}
          data-testid="composer"
          value={value}
          disabled={disabled}
          placeholder={
            disabled
              ? t('conn.starting')
              : busy
                ? t('composer.busy')
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
          </div>
          <button
            className={`send ${busy ? 'abort' : ''}`}
            data-testid="send"
            onClick={busy ? () => void abort() : () => void submit()}
            disabled={!busy && (!value.trim() || disabled)}
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
