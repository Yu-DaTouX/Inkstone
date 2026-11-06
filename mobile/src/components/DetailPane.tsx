import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { HistoryMessage, HistoryPage, PlanTodo, SubagentInfo } from '../api/client'
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
      <SubagentCard runs={detail.subagents} plain />
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
  empty: { fontSize: font.sm, textAlign: 'center', marginTop: touch.min * 2, lineHeight: 20 }
})
