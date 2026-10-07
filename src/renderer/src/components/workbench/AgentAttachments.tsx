import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import type { HubAttachment, HubAttachmentInput } from '../../../../shared/agent-hub'
import { useT } from '../../i18n'
import { IconButton } from '../ui'

const LIMIT = 8
const BYTES = 15 * 1024 * 1024

export interface PendingAttachment { key: string; name: string; image: boolean; preview?: string; input: HubAttachmentInput }

/** Pending files for an Agent message: picked, pasted or dropped; read as base64 for the host to store. */
export function useAttachments() {
  const t = useT()
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [error, setError] = useState('')
  const add = useCallback(async (files: FileList | File[]) => {
    setError('')
    const list = [...files]
    const read: PendingAttachment[] = []
    for (const file of list) {
      if (file.size > BYTES) { setError(t('hub.att.tooLarge', { name: file.name })); continue }
      const url = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file) })
      const image = file.type.startsWith('image/')
      read.push({ key: crypto.randomUUID(), name: file.name || (image ? '粘贴的图片.png' : 'file'), image, preview: image ? url : undefined, input: { name: file.name || (image ? '粘贴的图片.png' : 'file'), data: url.slice(url.indexOf(',') + 1), mime: file.type || undefined } })
    }
    setItems(old => {
      const next = [...old, ...read]
      if (next.length > LIMIT) setError(t('hub.att.tooMany', { n: LIMIT }))
      return next.slice(0, LIMIT)
    })
  }, [t])
  const remove = useCallback((key: string) => setItems(old => old.filter(i => i.key !== key)), [])
  const clear = useCallback(() => { setItems([]); setError('') }, [])
  /* Paste and drop handlers for the input area that owns this tray. */
  const onPaste = useCallback((e: ClipboardEvent) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); void add(files) } }, [add])
  const onDrop = useCallback((e: DragEvent) => { if (e.dataTransfer.files.length) { e.preventDefault(); void add(e.dataTransfer.files) } }, [add])
  return { items, error, add, remove, clear, onPaste, onDrop, inputs: () => items.map(i => i.input) }
}

/** The "+" button plus the tray of pending files. */
export function AttachmentPicker({ state, disabled }: { state: ReturnType<typeof useAttachments>; disabled?: boolean }) {
  const t = useT()
  const file = useRef<HTMLInputElement>(null)
  return <>
    <input ref={file} type="file" multiple hidden onChange={e => { if (e.target.files) void state.add(e.target.files); e.target.value = '' }} />
    <IconButton size="sm" icon="plus" label={t('hub.att.add')} disabled={disabled} onClick={() => file.current?.click()} data-testid="agent-attach" />
  </>
}

export function AttachmentTray({ state }: { state: ReturnType<typeof useAttachments> }) {
  const t = useT()
  if (!state.items.length && !state.error) return null
  return <div className="agent-attach-tray" data-testid="agent-attach-tray">
    {state.items.map(item => <span key={item.key} className="ui-file-chip">
      {item.preview ? <img src={item.preview} alt="" /> : <span className="ui-file-chip-ext">{ext(item.name)}</span>}
      <span className="ui-file-chip-name" title={item.name}>{item.name}</span>
      <button type="button" aria-label={t('hub.att.remove', { name: item.name })} onClick={() => state.remove(item.key)}>×</button>
    </span>)}
    {state.error ? <span className="agent-new-error">{state.error}</span> : null}
  </div>
}

/** Attachments already sent; the page cannot load local files, so each shows as a chip with its name. */
export function SentAttachments({ list }: { list?: HubAttachment[] }) {
  const t = useT()
  if (!list?.length) return null
  return <div className="agent-sent-attachments">
    {list.map((a, i) => <span key={a.path || a.name + i} className="ui-file-chip" title={a.image ? t('hub.att.imageTitle', { name: a.name }) : a.name}>
      <span className="ui-file-chip-ext">{a.image ? t('hub.att.imageBadge') : ext(a.name)}</span><span className="ui-file-chip-name">{a.name}</span>
    </span>)}
  </div>
}

const ext = (name: string) => (name.split('.').pop() ?? '').slice(0, 4).toUpperCase()
