import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '../../ui'
import type { Attachment } from '../../../../shared/ipc'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { submitComposerInput } from '../../lib/composer-submit'
import { attachmentsAfterSubmit, runLocalCommandGuarded } from '../../lib/v3-submit-ownership'
import { readFiles } from '../../components/chat/attachment-files'
import { ModelThinkingPicker } from '../../patterns/ModelThinkingPicker'
import { ContextRing } from '../../patterns/ContextRing'
import { AttachmentStrip } from './AttachmentStrip'
import { ComposerBorder } from './ComposerBorder'
import { CompletionMenu } from './CompletionMenu'
import { ComposerUsage } from './ComposerUsage'
import { PermissionToggle } from './PermissionToggle'
import { PlusMenu } from './PlusMenu'
import { QueueEditor } from './QueueEditor'
import { VoiceButton } from './VoiceButton'
import { useCompletion } from './useCompletion'
import {
  composerMode,
  composerPrompt,
  composerSendKeyHint,
  composerSubmitAction
} from './composer-layout'
import './composer.css'

/**
 * 输入框（WP-24，方案 §8.7）。发送 / 插话 / 排队三条语义都在这里定：
 *
 *   · 空闲：`Enter` 按设置发送（`sendKey`；默认 Enter，长文模式 Ctrl+Enter）；
 *   · 运行中：`Enter` = **插话**（pi `steer`），`Alt+Enter` = **排队**（pi `follow_up`），
 *     `Shift+Enter` 始终换行。压缩维护期间插话没有意义，两种键都走排队；
 *   · 中文输入法组字（`isComposing`）期间 `Enter` 一律不发送。
 *
 * 发送**成功才**清空草稿与附件；失败原样保留（文字回填、附件并回）。
 * 停止走 `store.abort`：内部是 `clear_queue` → `abort` → 文本与图片回收进
 * `queueRestore` / `attachments`，本组件只负责消费 `queueRestore` 回填，不重造。
 *
 * 不直接改 store、不导入 v2 样式；附件/队列/模型等正式动作全部走 store。
 */

/** 已经交出光标的那次「点开会话」（模块级：切换会话时新挂载不重复取）。 */
let consumedComposerFocus = 0

const MIN_H = 56
const MAX_H = 200

export function Composer({ className }: { className?: string } = {}) {
  const t = useT()
  const [value, setValue] = useState('')
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const cursorRef = useRef<number | null>(null)
  /* 光标位置要驱动 `/` 与 `@` 候选，所以除了 ref 还要有一份 state。 */
  const [cursor, setCursor] = useState<number | null>(null)
  const lastEsc = useRef(0)
  /* 一次提交在途时挡住重复回车（先发再清的那一小段窗口）。 */
  const submittingRef = useRef(false)

  /* ---- store 订阅 ---- */
  const send = useStore((s) => s.send)
  const abort = useStore((s) => s.abort)
  const runBash = useStore((s) => s.runBash)
  const notify = useStore((s) => s.notify)
  const commands = useStore((s) => s.commands)
  const models = useStore((s) => s.models)
  const thinkingLevels = useStore((s) => s.thinkingLevels)
  const session = useStore((s) => s.session)
  const sendKey = useStore((s) => s.settings?.sendKey ?? 'auto')
  const sessionId = session?.sessionId

  /* 回合级「在干活」：工具执行/压缩期间 isStreaming 为 false，必须用 running/compacting。 */
  const roundRunning = useStore(
    (s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running || !!s.session?.isCompacting
  )
  const compacting = useStore((s) => !!s.session?.isCompacting)

  /* 草稿：跟随「正在看的会话」（peek 身份优先）；尚未落盘时跟随 runId。
   * 显示旧 session.conversationId 时不能压过 peeked 身份（D5）。 */
  const runtimeKey = useStore((s) => {
    if (s.peekedSessionId) return s.peekedSessionId
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    const sid = s.session?.sessionId ?? runner?.sessionId
    return sid || (s.activeRunnerId ? `run:${s.activeRunnerId}` : '')
  })
  const conversationKey = useStore((s) => s.peekedSessionId ?? s.session?.conversationId) ?? runtimeKey
  const cachedDraft = useStore((s) => (runtimeKey ? s.sessionRuntimes[runtimeKey]?.draft ?? '' : ''))
  const setSessionDraft = useStore((s) => s.setSessionDraft)

  /* 外部注入（消费一次就清） */
  const editorInject = useStore((s) => s.editorInject)
  const consumeEditorInject = useStore((s) => s.consumeEditorInject)
  const composerInsert = useStore((s) => s.composerInsert)
  const clearComposerInsert = useStore((s) => s.clearComposerInsert)
  const queueRestore = useStore((s) => s.queueRestore)
  const consumeQueueRestore = useStore((s) => s.consumeQueueRestore)

  const attachmentCount = useStore((s) => s.attachments.length)
  const clearAttachments = useStore((s) => s.clearAttachments)
  const addAttachments = useStore((s) => s.addAttachments)
  const addFileRefs = useStore((s) => s.addFileRefs)
  const addFileRefPaths = useStore((s) => s.addFileRefPaths)
  const composerFocus = useStore((s) => s.composerFocus)

  /* ---- 外部注入：追加在末尾（与 pi 的 set_editor_text 同一语义） ---- */
  useEffect(() => {
    if (editorInject === null) return
    setValue((v) => (v ? `${v}\n${editorInject}` : editorInject))
    consumeEditorInject()
    ref.current?.focus()
  }, [editorInject, consumeEditorInject])

  useEffect(() => {
    if (composerInsert === null) return
    setValue((v) => (v ? `${v}\n${composerInsert}` : composerInsert))
    clearComposerInsert()
    ref.current?.focus()
  }, [composerInsert, clearComposerInsert])

  /* ---- 停止回收的排队内容：回填到**当前**草稿之前 ---- */
  useEffect(() => {
    if (queueRestore === null) return
    setValue((v) => (v ? `${queueRestore}\n${v}` : queueRestore))
    consumeQueueRestore()
    ref.current?.focus()
  }, [queueRestore, consumeQueueRestore])

  /* ---- 点开会话后取得光标 ---- */
  useEffect(() => {
    if (composerFocus.tick === consumedComposerFocus) return
    if (composerFocus.sessionId && composerFocus.sessionId !== sessionId) return
    consumedComposerFocus = composerFocus.tick
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }))
  }, [composerFocus, sessionId])

  /* ---- 按会话恢复 / 保存草稿 ---- */
  const hydratedKey = useRef<string | null>(null)
  const skipPersist = useRef(false)
  useEffect(() => {
    hydratedKey.current = conversationKey || null
    skipPersist.current = true
    setValue(runtimeKey ? cachedDraft : '')
    cursorRef.current = runtimeKey ? cachedDraft.length : null
    setCursor(cursorRef.current)
    // 只在切换会话时取一次缓存，避免每次敲字都重置输入框。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey])
  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false
      return
    }
    if (!runtimeKey || hydratedKey.current !== conversationKey) return
    /* 回写必须用恢复时的同一个键，否则会按一个键读、往另一个键写（D5）。 */
    setSessionDraft(value, runtimeKey)
  }, [runtimeKey, conversationKey, setSessionDraft, value])

  /* ---- 自动增高：随内容长高，56–200px ---- */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_H), MAX_H)}px`
  }, [value])

  /** 把一段文本插到光标处（光标不在输入框时按上次记下的位置）。 */
  const insertAtCursor = useCallback((text: string): void => {
    const el = ref.current
    setValue((current) => {
      const pos = el && document.activeElement === el ? el.selectionStart : cursorRef.current ?? current.length
      cursorRef.current = pos + text.length
      setCursor(pos + text.length)
      requestAnimationFrame(() => {
        el?.focus()
        el?.setSelectionRange(pos + text.length, pos + text.length)
      })
      return `${current.slice(0, pos)}${text}${current.slice(pos)}`
    })
  }, [])

  /* 补全后把光标放到新位置（值更新渲染后再选区，否则会被受控值重置）。 */
  const placeCursor = useCallback((pos: number): void => {
    cursorRef.current = pos
    setCursor(pos)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }, [])

  const completion = useCompletion({ value, cursor, setValue, placeCursor })

  const clearAll = useCallback((): void => {
    setValue('')
    clearAttachments()
  }, [clearAttachments])

  const restoreAttachments = useCallback((saved: Attachment[]): void => {
    useStore.setState((state) => ({
      attachments: [...saved, ...state.attachments.filter((item) => !saved.some((kept) => kept.id === item.id))]
    }))
  }, [])

  /* 本地命令（`!` / `/` 的 yan 内置与兼容项）走共用分发；普通消息在这里按 v3 语义发。 */
  const isLocalCommand = (raw: string): boolean => {
    if (value.startsWith('!')) return true
    if (raw === '/login' || raw.startsWith('/login ')) return true
    const name = /^\/([^\s]+)/.exec(raw)?.[1]?.toLowerCase()
    if (!name) return false
    return commands.some((c) => (c.source === 'yan' || c.source === 'compatibility') && c.name.toLowerCase() === name)
  }

  const runCommandPath = useCallback(async (): Promise<void> => {
    await submitComposerInput({
      text: value,
      attachments: useStore.getState().attachments,
      commands,
      models,
      t,
      session,
      thinkingLevels,
      roundRunning,
      isCompacting: compacting,
      actions: {
        runBash,
        openSettings: (tab) => useStore.getState().openSettings(tab),
        newSession: () => useStore.getState().newSession({ scope: 'global' }),
        compact: (custom) => useStore.getState().compact(custom),
        openBrowser: (url) => useStore.getState().openBrowser(url),
        setModel: (provider, id) => useStore.getState().setModel(provider, id),
        exportHtml: (path) => useStore.getState().exportHtml(path),
        copyLastReply: () => useStore.getState().copyLastReply(),
        clone: () => useStore.getState().clone(),
        setManualTitle: (id, title) => useStore.getState().setManualTitle(id, title),
        setThinking: (level) => useStore.getState().setThinking(level),
        nativeSession: (action, args) => useStore.getState().nativeSession(action, args),
        notify
      },
      clearText: () => setValue(''),
      clearAll,
      restoreText: (raw) => setValue((draft) => (draft ? `${raw}\n${draft}` : raw)),
      restoreAttachments,
      readAttachments: () => useStore.getState().attachments,
      send,
      holdSend: useStore.getState().holdSend,
      focusComposer: () => ref.current?.focus()
    })
  }, [value, commands, models, t, session, thinkingLevels, roundRunning, compacting, runBash, notify, clearAll, restoreAttachments, send])

  /**
   * 提交一次普通消息。`mode` 只在运行中有效：
   *   steer = 插话（当前这轮就看到）· followUp = 排队（这轮跑完再发）。
   * 成功才清空；失败把文字与附件原样放回。
   */
  const submitMessage = useCallback(
    async (mode: 'steer' | 'followUp'): Promise<void> => {
      const raw = value.trim()
      const attachments = useStore.getState().attachments
      if (!raw && attachments.length === 0) return
      if (submittingRef.current) return
      submittingRef.current = true
      try {
      if (isLocalCommand(raw)) {
        /*
         * `!` / `/model` / `/thinking` 等要落到「当前实例」上：先保证正在看的
         * 会话已激活。切换在途或激活失败时安全失败 —— 不执行、不清文字。
         * 这些动作内部（composer-submit）会先清草稿，所以守卫必须在它之前。
         */
        await runLocalCommandGuarded({
          raw: value,
          ensureActivated: () => useStore.getState().ensureActivated(),
          run: runCommandPath,
          notifyBlocked: () =>
            notify(
              'error',
              '这条命令需要先安全切换会话，当前没有执行，草稿已保留。请稍后重试，或回退 v2 界面执行。'
            )
        })
        return
      }
      /* 本次提交的附件 id：成功只移除这些，等待期间新增的必须留下（D1）。 */
      const sentIds = attachments.map((a) => a.id)
      const images = attachments
        .filter((a) => a.kind !== 'file')
        .map((a) => ({ data: a.data, mimeType: a.mimeType }))
      const fileRefs = attachments.filter((a) => a.kind === 'file' && a.path)
      const outgoing = fileRefs.length
        ? `${raw ? `${raw}\n\n` : ''}${t('composer.fileRefs', { list: fileRefs.map((a) => `- ${a.path}`).join('\n') })}`
        : raw
      /*
       * 先发再清：`store.send` 要读 store 里**还在**的附件来登记来源
       * （`collectSourceIds`）。清空只发生在成功之后，失败时输入区原样保留，
       * 不需要「先清再放回」那一步。
       */
      const ok = roundRunning ? await send(outgoing, images.length ? images : undefined, mode) : await send(outgoing, images.length ? images : undefined)
      if (ok) {
        /* 只清这一次提交的文本：等待期间若又敲了新字，保留它。 */
        setValue((draft) => (draft === value ? '' : draft))
        /* 附件同理：只移除本次提交的 id，不在途新增的一起吞掉。 */
        useStore.setState((state) => ({ attachments: attachmentsAfterSubmit(state.attachments, sentIds) }))
      }
      } finally {
        submittingRef.current = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [value, roundRunning, runCommandPath, notify, send, t]
  )

  /* ---- 粘贴图片 ---- */
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...e.clipboardData.items]
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f)
      if (files.length === 0) return
      e.preventDefault()
      void readFiles(files, addAttachments, (names) => notify('error', t('attachment.skipped', { names: names.join(', ') })))
    },
    [addAttachments, notify, t]
  )

  /* ---- 拖放：内部路径 → 文件引用；图片 → 附件；普通文件 → 文件引用 ---- */
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const internalPath = e.dataTransfer.getData('application/x-yan-file-path').trim()
      if (internalPath) {
        e.preventDefault()
        setDragging(false)
        void addFileRefPaths([internalPath])
        return
      }
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragging(false)
      const files = [...e.dataTransfer.files]
      if (files.length === 0) return
      const images = files.filter((f) => f.type.startsWith('image/'))
      const others = files.filter((f) => !f.type.startsWith('image/'))
      if (images.length) void readFiles(images, addAttachments, (names) => notify('error', t('attachment.skipped', { names: names.join(', ') })))
      if (others.length) void addFileRefs(others)
    },
    [addAttachments, addFileRefs, addFileRefPaths, notify, t]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.defaultPrevented) return
    /* 中文输入法组字期间（Enter 确认候选、Esc 取消候选）一律让路。 */
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return

    /* 补全菜单开着时，方向键 / Enter / Tab / Esc 归菜单。 */
    if (completion.handleKey(e)) return

    if (e.key === 'Enter') {
      const mod = e.ctrlKey || e.metaKey
      if (e.shiftKey) {
        /* 始终换行 */
        return
      }
      if (roundRunning) {
        e.preventDefault()
        /* 压缩维护期间「插话」没有意义，两种键都排队到这段之后。 */
        void submitMessage(compacting || e.altKey ? 'followUp' : 'steer')
        return
      }
      const wantsSend = mod ? true : sendKey === 'enter' ? true : sendKey === 'ctrlEnter' ? false : true
      if (wantsSend) {
        e.preventDefault()
        void submitMessage('steer')
      }
      return
    }

    if (e.key === 'Escape' && roundRunning) {
      /* 输入框为空时连按两次 Esc 停止（方案 §8.7）。 */
      if (value.trim() || attachmentCount > 0) return
      e.preventDefault()
      const now = Date.now()
      if (now - lastEsc.current < 500) {
        lastEsc.current = 0
        void abort()
      } else {
        lastEsc.current = now
      }
    }
  }

  const rememberCursor = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    cursorRef.current = e.currentTarget.selectionStart
    setCursor(e.currentTarget.selectionStart)
  }

  const canSend = value.trim().length > 0 || attachmentCount > 0
  const placeholder = roundRunning
    ? `${t('queue.steerNow')} · Enter ｜ ${t('queue.queueIt')} · Alt+Enter`
    : t('composer.ph')
  /* 底栏的三种派生：模式徽标 / 提示符、发送或停止、发送键提示（见 composer-layout）。 */
  const mode = composerMode(value)
  const prompt = composerPrompt(value)
  const submitAction = composerSubmitAction({
    running: roundRunning,
    hasText: value.trim().length > 0,
    hasAttachments: attachmentCount > 0
  })
  const sendKeyHint = composerSendKeyHint(sendKey, false)

  return (
    <div
      className={`composer-wrap ${dragging ? 'is-dropping' : ''} ${className ?? ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-yan-file-path')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      {/* 排队内容在**输入框外上方**（用户确认的对照表第 1 条） */}
      <QueueEditor />
      <div className="composer">
        <ComposerBorder />
        <AttachmentStrip />
        <div className="composer-input">
          <CompletionMenu completion={completion} />
          <div className="composer-line">
            <span className="composer-prompt" aria-hidden>
              {prompt}
            </span>
            <textarea
              ref={ref}
              className="composer-text"
              value={value}
              placeholder={placeholder}
              rows={1}
              data-testid="composer-input"
              spellCheck={false}
              role="combobox"
              aria-expanded={completion.open}
              aria-autocomplete="list"
              aria-activedescendant={completion.open ? (completion.slashMatches.length > 0 ? `composer-slash-option-${completion.index}` : completion.atMatches.length > 0 ? `composer-at-option-${completion.index}` : undefined) : undefined}
              onChange={(e) => {
                setValue(e.target.value)
                cursorRef.current = e.target.selectionStart
                setCursor(e.target.selectionStart)
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onSelect={rememberCursor}
              onClick={rememberCursor}
            />
          </div>
          <div className="composer-bar">
            {/* 左：模式徽标 · 权限 · ＋ · 发送键提示 */}
            <div className="composer-tools">
              {mode ? (
                <span className="composer-mode" data-mode={mode} data-testid="composer-mode">
                  {mode === 'bash' ? t('composer.bashMode') : t('composer.cmdMode')}
                </span>
              ) : null}
              <PermissionToggle />
              <PlusMenu onInsert={insertAtCursor} />
              {sendKeyHint ? (
                <span className="composer-keyhint" data-testid="composer-keyhint">
                  {sendKeyHint === 'enter' ? t('composer.keyEnterSend') : t('composer.keyCtrlSend')}
                </span>
              ) : null}
            </div>
            {/* 右：语音 · 上下文环 · 模型+思考 · 发送/停止；运行状态不在输入框里重复显示 */}
            <VoiceButton onText={insertAtCursor} />
            <ContextRing />
            <ModelThinkingPicker />
            {submitAction === 'stop' ? (
              <Button
                variant="secondary"
                size="sm"
                aria-label={t('composer.stop')}
                title={t('composer.stop')}
                className="composer-send composer-stop"
                data-testid="composer-stop"
                onPress={() => void abort()}
              >
                <Square size={14} aria-hidden />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                aria-label={t('composer.go')}
                className="composer-send"
                data-testid="composer-send"
                isDisabled={!canSend}
                onPress={() => void submitMessage('steer')}
              >
                <ArrowUp size={16} aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>
      <ComposerUsage />
    </div>
  )
}
