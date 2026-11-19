import { pick } from '../../../src/shared/ui-lang'
import { useEffect, useState } from 'react'
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { RemoteQueue, RemoteQueueOp } from '../../../src/shared/remote-protocol'
import { queueOp, queueRowActions, queuedRows, withdrawAllOp, type QueuedRow, type QueueRowAction } from '../sessionActions'
import { RunDot } from '../motion'
import { font, mono, radius, space, usePalette, weight } from '../theme'
import { Button, IconButton, Input } from '../ui'

const SHOWN = 3

const ACTION_LABEL: Record<QueueRowAction, () => string> = {
  steer: () => pick('立即插话', 'Steer now'),
  edit: () => pick('编辑', 'Edit'),
  remove: () => pick('撤回', 'Withdraw')
}

function EditSheet({ row, onClose, onSave }: { row: QueuedRow | null; onClose(): void; onSave(text: string): Promise<void> }) {
  const p = usePalette()
  const [text, setText] = useState(row?.text ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (row) { setText(row.text); setError(null) } }, [row])
  const save = async () => {
    if (busy || !text.trim()) return
    setBusy(true); setError(null)
    try { await onSave(text); onClose() }
    catch (err) { setError(err instanceof Error ? err.message : pick('没改成', 'Not saved')) }
    finally { setBusy(false) }
  }
  return <Modal visible={!!row} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose() }} statusBarTranslucent navigationBarTranslucent>
    <View style={styles.backdrop}>
      <Pressable accessibilityLabel={pick('关闭', 'Close')} onPress={() => { if (!busy) onClose() }} style={StyleSheet.absoluteFill} />
      <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.sheet, { backgroundColor: p.bg1 }]}>
        <View style={styles.sheetHead}>
          <Text accessibilityRole="header" style={{ flex: 1, fontFamily: mono, fontSize: font.base, color: p.fgMute }}>{pick('编辑排队消息', 'Edit queued message')}</Text>
          {busy ? <RunDot label={pick('正在保存', 'Saving')} /> : <IconButton name="check" label={pick('保存', 'Save')} primary disabled={!text.trim()} onPress={() => void save()} />}
        </View>
        {row?.text.endsWith('…') ? <Text style={{ marginHorizontal: space[4], marginBottom: space[2], color: p.fgMute, fontSize: font.xs }}>{pick('原文较长，手机上只显示了前 500 字；保存会用这里的内容替换整条消息。', 'The original is long and only its first 500 characters are shown; saving replaces the whole message with this text.')}</Text> : null}
        <Input inset autoFocus multiline value={text} onChangeText={setText} maxLength={20000} accessibilityLabel={pick('排队消息内容', 'Queued message text')} style={{ marginHorizontal: space[4], maxHeight: 220 }} />
        {error ? <Text accessibilityLiveRegion="polite" style={{ padding: space[4], color: p.err, fontSize: font.sm }}>{error}</Text> : null}
      </SafeAreaView>
    </View>
  </Modal>
}

export function QueuedMessages({ queue, onOp }: { queue: RemoteQueue | undefined; onOp?: (op: RemoteQueueOp) => Promise<void> }) {
  const p = usePalette()
  const rows = queuedRows(queue)
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<QueuedRow | null>(null)
  if (!rows.length) return null
  const shown = all ? rows : rows.slice(0, SHOWN)
  const more = rows.length - shown.length
  const total = Math.max(queue?.total ?? rows.length, rows.length)
  const omitted = total - rows.length
  const editable = !!onOp
  const run = async (op: RemoteQueueOp | null) => {
    if (!op || !onOp || busy) return
    setBusy(true); setError(null)
    try { await onOp(op); setOpen(null) }
    catch (err) { setError(err instanceof Error ? err.message : pick('排队消息没改成', 'Queued message not changed')) }
    finally { setBusy(false) }
  }
  const act = (row: QueuedRow, action: QueueRowAction) => {
    if (action === 'edit') { setEditing(row); return }
    void run(queueOp(row, action))
  }
  const withdrawAll = editable ? withdrawAllOp(rows) : null
  const withdrawCount = withdrawAll?.op === 'clear' ? withdrawAll.items.length : 0
  const withdrawLabel = pick(`撤回这 ${withdrawCount} 条`, `Withdraw these ${withdrawCount}`)
  const clearAll = () => Alert.alert(pick('撤回这些排队消息？', 'Withdraw these queued messages?'), pick(`这 ${withdrawCount} 条还没发出的消息会撤回；子代理和系统的自动通知不受影响。`, `These ${withdrawCount} unsent messages will be withdrawn; automatic subagent and system notices are kept.`), [
    { text: pick('取消', 'Cancel'), style: 'cancel' },
    { text: pick('撤回', 'Withdraw'), style: 'destructive', onPress: () => void run(withdrawAll) }
  ])
  return (
    <View accessibilityLabel={pick(`${total} 条消息等待发送`, `${total} messages waiting to send`)} style={[styles.box, { backgroundColor: p.bg3 }]}>
      {shown.map((row, index) => {
        const actions = queueRowActions(row, editable)
        const key = row.id ?? `${row.kind}:${index}`
        const expanded = open === key && actions.length > 0
        const label = row.kind === 'steer' ? pick('插话', 'Steer') : pick('排队', 'Queued')
        return (
          <View key={key}>
            <Pressable disabled={!actions.length} accessibilityRole={actions.length ? 'button' : undefined} accessibilityState={actions.length ? { expanded } : undefined} accessibilityHint={actions.length ? pick('显示撤回、编辑等操作', 'Shows withdraw, edit and more') : undefined} onPress={() => setOpen(expanded ? null : key)} style={styles.row}>
              <Text style={[styles.tag, { color: row.kind === 'steer' ? p.accent : p.fgMute }]}>{label}</Text>
              <Text numberOfLines={expanded ? 6 : 2} style={[styles.text, { color: p.fgDim }]}>{row.text.replace(/\s+/g, ' ').trim() || pick('（图片）', '(image)')}{row.images ? pick(` · ${row.images} 张图`, ` · ${row.images} image${row.images > 1 ? 's' : ''}`) : ''}</Text>
            </Pressable>
            {expanded ? <View style={styles.actions}>
              {actions.map((action) => <Button key={action} compact label={ACTION_LABEL[action]()} variant={action === 'remove' ? 'danger' : 'secondary'} busy={busy} onPress={() => act(row, action)} />)}
            </View> : null}
          </View>
        )
      })}
      {omitted > 0 ? <Text style={[styles.link, { color: p.fgMute, fontSize: font.xs }]}>{pick(`还有 ${omitted} 条未显示`, `${omitted} more not shown`)}</Text> : null}
      {more > 0 || withdrawCount > 1 ? <View style={styles.foot}>
        {more > 0 ? <Pressable accessibilityRole="button" onPress={() => setAll(true)} style={styles.link}><Text style={{ color: p.fgMute, fontSize: font.xs }}>{pick(`还有 ${more} 条`, `${more} more`)}</Text></Pressable> : all && rows.length > SHOWN ? <Pressable accessibilityRole="button" onPress={() => setAll(false)} style={styles.link}><Text style={{ color: p.fgMute, fontSize: font.xs }}>{pick('收起', 'Collapse')}</Text></Pressable> : <View />}
        {withdrawCount > 1 ? <Pressable accessibilityRole="button" accessibilityLabel={withdrawLabel} disabled={busy} onPress={clearAll} style={styles.link}><Text style={{ color: p.err, fontSize: font.xs }}>{withdrawLabel}</Text></Pressable> : null}
      </View> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: p.err, fontSize: font.xs }}>{error}</Text> : null}
      <EditSheet row={editing} onClose={() => setEditing(null)} onSave={async (text) => {
        const op = editing ? queueOp(editing, 'edit', text) : null
        if (op && onOp) await onOp(op)
        setOpen(null)
      }} />
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[2], gap: space[1] },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2], minHeight: 28 },
  tag: { fontSize: font.xs, fontWeight: weight.strong, lineHeight: 20 },
  text: { flex: 1, fontSize: font.sm, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], paddingLeft: space[6], paddingVertical: space[1] },
  foot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { minHeight: 32, justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'center' },
  sheet: { width: '100%', maxWidth: 640, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingBottom: space[3] },
  sheetHead: { flexDirection: 'row', alignItems: 'center', padding: space[3] }
})
