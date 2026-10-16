import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import type { HubAttachment, HubAttachmentInput } from '../../../../shared/agent-hub'
import { useT } from '../../i18n'
import { IconButton } from '../ui'

const LIMIT = 8
const BYTES = 15 * 1024 * 1024

export interface PendingAttachment { key: string; name: string; image: boolean; preview?: string; input: HubAttachmentInput }

export function useAttachments() {
  const t = useT()
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [error, setError] = useState('')
  const currentItems = useRef<PendingAttachment[]>([])
  const pendingSlots = useRef(0)
  const generation = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; generation.current++; pendingSlots.current = 0 }
  }, [])
  const add = useCallback(async (files: FileList | File[]) => {
    setError('')
    const requestGeneration = generation.current
    const candidates = [...files]
    const available = Math.max(0, LIMIT - currentItems.current.length - pendingSlots.current)
    const list = candidates.slice(0, available)
    if (candidates.length > available) setError(t('hub.att.tooMany', { n: LIMIT }))
    pendingSlots.current += list.length
    const read: PendingAttachment[] = []
    try {
      for (const file of list) {
        if (!alive.current || generation.current !== requestGeneration) return
        if (file.size > BYTES) { setError(t('hub.att.tooLarge', { name: file.name })); continue }
        try {
          const url = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.onabort = () => reject(new Error('Attachment read cancelled')); r.readAsDataURL(file) })
          if (!alive.current || generation.current !== requestGeneration) return
          const image = file.type.startsWith('image/')
          read.push({ key: crypto.randomUUID(), name: file.name || (image ? '粘贴的图片.png' : 'file'), image, preview: image ? url : undefined, input: { name: file.name || (image ? '粘贴的图片.png' : 'file'), data: url.slice(url.indexOf(',') + 1), mime: file.type || undefined } })
        } catch (error) { if (alive.current && generation.current === requestGeneration) setError(error instanceof Error ? error.message : String(error)) }
      }
      if (!alive.current || generation.current !== requestGeneration) return
      currentItems.current = [...currentItems.current, ...read].slice(0, LIMIT)
      setItems(currentItems.current)
    } finally { if (generation.current === requestGeneration) pendingSlots.current -= list.length }
  }, [t])
  const remove = useCallback((key: string) => { currentItems.current = currentItems.current.filter(i => i.key !== key); setItems(currentItems.current) }, [])
  const clear = useCallback(() => { generation.current++; pendingSlots.current = 0; currentItems.current = []; setItems([]); setError('') }, [])
  const onPaste = useCallback((e: ClipboardEvent) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); void add(files) } }, [add])
  const onDrop = useCallback((e: DragEvent) => { if (e.dataTransfer.files.length) { e.preventDefault(); void add(e.dataTransfer.files) } }, [add])
  return { items, error, add, remove, clear, onPaste, onDrop, inputs: () => items.map(i => i.input) }
}

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
