import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { RemoteChangedFile, RemoteSessionChanges, RemoteSessionStats } from '../../../src/shared/remote-protocol'
import type { HistoryMessage, HistoryPage, PlanTodo, SubagentInfo } from '../api/client'
import { compactCount, contextRatio, costText } from '../format'
import { Icon } from '../icons'
import { GlyphSpinner } from '../motion'
import { useRemote } from '../state'
import { useBottomInset } from '../insets'
import { font, icon, mono, space, touch, usePalette, weight } from '../theme'
import { SubagentCard } from './SubagentCard'

export type ArtifactRef = NonNullable<HistoryMessage['artifacts']>[number]

export interface SessionDetail {
  sessionId: string
  plan?: HistoryPage['plan']
  subagents: SubagentInfo[]
  artifacts: ArtifactRef[]
  running: boolean
  model?: string
  stats?: RemoteSessionStats
  changes?: RemoteSessionChanges | null
}

const isDone = (todo: PlanTodo) => todo.done || todo.status === 'done'

function Section({ title, value, children, initiallyOpen = true }: { title: string; value?: ReactNode; children: ReactNode; initiallyOpen?: boolean }) {
  const p = usePalette()
  const [open, setOpen] = useState(initiallyOpen)
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title} onPress={() => setOpen(!open)} style={styles.head}>
      <Text style={[styles.title, { color: p.fgDim }]}>{title}</Text>
      <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevron-right" size={12} color={p.fgMute} /></View>
      <Text numberOfLines={1} ellipsizeMode="clip" style={[styles.leader, { color: p.borderStr }]}>{'· '.repeat(60)}</Text>
      {typeof value === 'string' ? <Text style={[styles.value, { color: p.fgDim }]}>{value}</Text> : value}
    </Pressable>
    {open ? <View style={styles.body}>{children}</View> : null}
  </View>
}

function UsageSection({ stats }: { stats: RemoteSessionStats }) {
  const p = usePalette()
  const ratio = contextRatio(stats.context)
  const warn = ratio !== null && ratio >= 0.85
  const cost = costText(stats.cost)
  return <Section title="用量" value={ratio !== null ? `${Math.round(ratio * 100)}%` : undefined}>
    {ratio !== null && stats.context ? <View style={styles.usage}>
      <View style={[styles.meter, { backgroundColor: p.borderSoft }]}><View style={[styles.meterFill, { width: `${Math.max(2, Math.round(ratio * 100))}%`, backgroundColor: warn ? p.warn : p.accent }]} /></View>
      <Text style={[styles.value, { color: p.fgDim }]}>{stats.context.tokens !== null ? `${compactCount(stats.context.tokens)} / ${compactCount(stats.context.window)}` : compactCount(stats.context.window)}</Text>
    </View> : null}
    <View style={styles.row}>
      <Text style={[styles.rowText, styles.mono, { color: p.fg }]}>{compactCount(stats.tokens)} tokens{cost ? ` · ${cost}` : ''}</Text>
      <Text style={[styles.value, { color: p.fgMute }]}>{stats.toolCalls} 次工具</Text>
    </View>
  </Section>
}

const STATUS_COLOR: Record<RemoteChangedFile['status'], 'add' | 'del' | 'warn' | 'fgDim'> = { A: 'add', '?': 'add', D: 'del', M: 'fgDim', R: 'fgDim', U: 'warn' }

function ChangesSection({ changes }: { changes: RemoteSessionChanges }) {
  const p = usePalette()
  return <Section title="更改" value={<Text style={[styles.value, { color: p.fgDim }]}>{changes.added || changes.removed ? <><Text style={{ color: p.add }}>+{changes.added}</Text> <Text style={{ color: p.del }}>−{changes.removed}</Text></> : changes.total}</Text>}>
    {changes.branch ? <View style={styles.row}><Icon name="branch" size={icon.sm} color={p.fgDim} /><Text numberOfLines={1} style={[styles.rowText, styles.mono, { color: p.fgDim }]}>{changes.branch}</Text></View> : null}
    {changes.files.map((file) => <View key={file.path} style={styles.file}>
      <Text style={[styles.status, { color: p[STATUS_COLOR[file.status]] }]}>{file.status}</Text>
      <Text numberOfLines={1} ellipsizeMode="head" style={[styles.rowText, styles.mono, { color: p.fg, fontSize: font.sm }]}>{file.path}</Text>
      {typeof file.added === 'number' || typeof file.removed === 'number' ? <Text style={styles.value}><Text style={{ color: p.add }}>+{file.added ?? 0}</Text> <Text style={{ color: p.del }}>−{file.removed ?? 0}</Text></Text> : null}
    </View>)}
    {changes.truncated ? <Text style={[styles.value, { color: p.fgMute, paddingVertical: 4 }]}>另有 {changes.total - changes.files.length} 个文件</Text> : null}
  </Section>
}

export function DetailPane({ detail, onOpenArtifact, background, inset = true }: { detail: SessionDetail | null; onOpenArtifact: (artifact: ArtifactRef) => void; background?: string; inset?: boolean }) {
  const p = usePalette()
  const bottomInset = useBottomInset()
  const { sessions, projects, info, client } = useRemote()
  if (!detail) return <View style={[styles.root, { backgroundColor: background ?? p.bg1 }]}><Text style={[styles.empty, { color: p.fgMute }]}>打开一个会话后，这里显示它的环境、计划与子代理</Text></View>
  const session = sessions.find((entry) => entry.id === detail.sessionId)
  const project = projects.find((entry) => entry.id === session?.projectId)
  const todos = detail.plan?.todos ?? []
  const done = todos.filter(isDone).length
  const activeIndex = todos.findIndex((todo) => todo.status === 'running' || (!isDone(todo) && detail.running && !todos.some((t) => t.status === 'running')))
  return <ScrollView style={{ backgroundColor: background ?? p.bg1 }} contentContainerStyle={[styles.root, inset ? { paddingBottom: space[5] + bottomInset } : null]}>
    <Section title="环境">
      <View style={styles.row}><Icon name="terminal" size={icon.sm} color={p.fgDim} /><Text numberOfLines={1} style={[styles.rowText, { color: p.fg }]}>{info?.computer?.name || client.connection.computerName || '电脑'}</Text></View>
      <View style={styles.row}><Icon name="folder" size={icon.sm} color={p.fgDim} /><Text numberOfLines={1} ellipsizeMode="head" style={[styles.rowText, { color: p.fg }]}>{project?.cwd || session?.cwdName || '电脑工作目录'}</Text></View>
      {detail.model ? <View style={styles.row}><Icon name="sparkles" size={icon.sm} color={p.fgDim} /><Text numberOfLines={1} style={[styles.rowText, { color: p.fg }]}>{detail.model}</Text></View> : null}
    </Section>
    {detail.stats ? <UsageSection stats={detail.stats} /> : null}
    {detail.changes && detail.changes.total > 0 ? <ChangesSection changes={detail.changes} /> : null}
    {todos.length ? <Section title="计划" initiallyOpen={done < todos.length && !detail.plan?.stale} value={`${done}/${todos.length}${detail.plan?.stale ? ' · 上一轮' : ''}`}>
      {todos.map((todo, index) => {
        const finished = isDone(todo)
        const active = index === activeIndex
        return <View key={index} style={styles.todo}>
          <View style={styles.mark}>{active ? <GlyphSpinner /> : <Text style={{ color: todo.status === 'blocked' ? p.warn : p.fgMute, fontSize: font.sm }}>{finished ? '✓' : todo.status === 'blocked' ? '!' : '○'}</Text>}</View>
          <Text style={[styles.todoText, { color: finished ? p.fgMute : p.fg, textDecorationLine: finished ? 'line-through' : 'none' }]}>{todo.text}</Text>
        </View>
      })}
    </Section> : null}
    {detail.subagents.length ? <Section title="子代理" value={String(detail.subagents.length)}>
      <SubagentCard runs={detail.subagents} plain sessionId={detail.sessionId} />
    </Section> : null}
    {detail.artifacts.length ? <Section title="产物" value={String(detail.artifacts.length)}>
      {detail.artifacts.map((artifact) => <Pressable key={artifact.id} accessibilityRole="button" disabled={artifact.unavailable} onPress={() => onOpenArtifact(artifact)} style={[styles.row, { opacity: artifact.unavailable ? 0.5 : 1 }]}>
        <Icon name="file" size={icon.sm} color={p.fgDim} />
        <Text numberOfLines={1} style={[styles.rowText, { color: p.accent }]}>{artifact.filename}</Text>
        <Text style={[styles.value, { color: p.fgMute }]}>{artifact.unavailable ? '不可用' : `${Math.max(1, Math.round(artifact.bytes / 1024))} KB`}</Text>
      </Pressable>)}
    </Section> : null}
  </ScrollView>
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: space[4], paddingBottom: space[5], flexGrow: 1 },
  head: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: space[1], marginTop: space[2] },
  title: { fontSize: font.sm, fontWeight: weight.medium },
  leader: { flex: 1, minWidth: 0, fontSize: font.xs, marginHorizontal: space[2], overflow: 'hidden' },
  value: { fontSize: font.xs, fontFamily: mono, fontVariant: ['tabular-nums'] },
  body: { gap: 2 },
  row: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[3] },
  rowText: { flex: 1, minWidth: 0, fontSize: font.base },
  todo: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2], paddingVertical: 4 },
  mark: { width: 16, minHeight: 20, alignItems: 'center', justifyContent: 'center' },
  todoText: { flex: 1, minWidth: 0, fontSize: font.base, lineHeight: 20 },
  usage: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 28 },
  meter: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  meterFill: { height: 4, borderRadius: 2 },
  mono: { fontFamily: mono, fontSize: font.sm },
  file: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  status: { width: 14, fontFamily: mono, fontSize: font.xs, textAlign: 'center' },
  empty: { fontSize: font.sm, textAlign: 'center', marginTop: touch.min * 2, lineHeight: 20 }
})
