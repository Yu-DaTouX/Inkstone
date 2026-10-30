import { useCallback, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowUp } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { ComposerFrame } from '../../t3/components/chat/ComposerFrame'
import {
  ComposerAttachmentFileList,
  ComposerAttachButton,
  ComposerAttachmentMediaRow
} from '../../t3/components/chat/ComposerAttachmentStrip'
import { ComposerNotice } from '../../t3/components/chat/ComposerPromptLengthValidation'
import { useAttachmentAdapter, useComposerDropTarget } from '../../t3/adapters/composer-attachments'
import { useComposerNotice } from '../../t3/adapters/notice'
import { ComposerEditor, type ComposerEditorChange, type ComposerEditorHandle } from './ComposerEditor'
import { composerPlaceholderKey } from './composer-layout'
import { imageRefLabel, imageRefPrefix, renumberImageRefsAfterRemoval } from './image-refs'
import { usePromptStashEntries } from './usePromptStash'
import { ImageViewer } from './image-viewer'
import './composer.css'

export function ComposerV3(): JSX.Element {
  const t = useT()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const editorRef = useRef<ComposerEditorHandle>(null)
  const attachments = useAttachmentAdapter()
  const drop = useComposerDropTarget()
  const notice = useComposerNotice(value)
  const stash = usePromptStashEntries()
  const { lang } = useI18n()
  const sessionId = useStore((s) => s.session?.sessionId)

  const prefix = imageRefPrefix(lang)
  const labelFor = useCallback((index: number) => imageRefLabel(prefix, index + 1), [prefix])

  const preview = previewId ? attachments.images.find((item) => item.id === previewId) : undefined

  const removeImage = useCallback(
    (id: string) => {
      const index = attachments.images.findIndex((item) => item.id === id)
      setValue((draft) => (index < 0 ? draft : renumberImageRefsAfterRemoval(draft, index + 1)))
      attachments.remove(id)
    },
    [attachments]
  )

  const placeholder = t(composerPlaceholderKey({ bash: false, session: !!sessionId, firstRun: false }))

  const editor = useMemo(
    () => (
      <ComposerEditor
        ref={editorRef}
        value={value}
        cursor={cursor}
        placeholder={placeholder}
        ariaLabel={t('composer.inputLabel')}
        expanded={false}
        data-testid="composer-input"
        onChange={(change: ComposerEditorChange) => {
          setValue(change.text)
          setCursor(change.cursor)
        }}
        onCursorChange={setCursor}
      />
    ),
    [value, cursor, placeholder, t]
  )

  const mediaRow = (
    <ComposerAttachmentMediaRow
      images={attachments.images}
      refLabel={labelFor}
      onExpandImage={setPreviewId}
      onRemoveImage={removeImage}
    />
  )
  const fileList = (
    <ComposerAttachmentFileList
      files={attachments.files}
      onPreviewFile={(id) => {
        const file = attachments.files.find((item) => item.id === id)
        if (file?.path) void useStore.getState().previewFile(file.path)
      }}
      onRemoveFile={attachments.remove}
    />
  )

  return (
    <div className="composer-v3" data-testid="composer-v3">
      <ComposerFrame
        editor={editor}
        attachments={
          <>
            {mediaRow}
            {fileList}
          </>
        }
        notice={notice ? <ComposerNotice message={notice.message} tone={notice.tone} slot="image-ref" /> : null}
        footerLeading={<ComposerAttachButton onFiles={attachments.addFiles} />}
        controls={null}
        primaryActions={
          <button
            type="button"
            data-composer-send-placeholder="true"
            className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover disabled:bg-foreground/12 disabled:text-muted-foreground"
            aria-label={t('composer.go')}
          >
            <ArrowUp size={14} strokeWidth={1.8} aria-hidden />
          </button>
        }
        stash={{
          count: stash.length,
          menuOpen: false,
          pulseKey: 0,
          label: t('composer.t3.stash'),
          ariaLabel: t('composer.t3.stashAria', { n: stash.length }),
          onToggleMenu: () => undefined
        }}
        dropActive={drop.active}
        dropProps={drop.handlers}
      />
      <ImageViewer
        isOpen={!!preview}
        src={preview ? preview.previewUrl : null}
        alt={preview?.name}
        caption={preview ? preview.name : undefined}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null)
        }}
      />
    </div>
  )
}
