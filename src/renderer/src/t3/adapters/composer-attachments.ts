import { useCallback, useMemo } from 'react'
import type { Attachment } from '../../../../shared/ipc'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { composerSubmitIdentity } from '../../state/composer-recovery'
import { readFiles } from '../../features/composer/attachment-files'

export interface ComposerImageAttachment {
  readonly type: 'image'
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly previewUrl: string | null
  readonly file: File | null
}

export interface ComposerFileAttachment {
  readonly type: 'file'
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly file: File | null
  readonly path: string | null
  readonly isDirectory: boolean
}

export function isComposerImage(attachment: Attachment): boolean {
  return attachment.kind !== 'file'
}

export function composerImageFrom(attachment: Attachment): ComposerImageAttachment {
  return {
    type: 'image',
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.size,
    previewUrl: attachment.preview ? `data:${attachment.mimeType};base64,${attachment.preview}` : null,
    file: null
  }
}

export function composerFileFrom(attachment: Attachment): ComposerFileAttachment {
  return {
    type: 'file',
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.size,
    file: null,
    path: attachment.path ?? null,
    isDirectory: !!attachment.isDirectory
  }
}

export interface AttachmentAdapter {
  readonly images: ComposerImageAttachment[]
  readonly files: ComposerFileAttachment[]
  readonly count: number
  readonly addFiles: (files: File[]) => void
  readonly remove: (id: string) => void
}

export function useAttachmentAdapter(): AttachmentAdapter {
  const t = useT()
  const notify = useStore((s) => s.notify)
  const attachments = useStore((s) => s.attachments)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const { images, files } = useMemo(
    () => ({
      images: attachments.filter(isComposerImage).map(composerImageFrom),
      files: attachments.filter((item) => !isComposerImage(item)).map(composerFileFrom)
    }),
    [attachments]
  )
  const addFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return
      const identity = composerSubmitIdentity(useStore.getState())
      void readFiles(
        incoming,
        (items) => useStore.getState().addAttachments(items, identity),
        (names) => notify('error', t('attachment.skipped', { names: names.join(', ') }))
      )
    },
    [notify, t]
  )
  const remove = useCallback((id: string) => removeAttachment(id), [removeAttachment])
  return { images, files, count: attachments.length, addFiles, remove }
}
