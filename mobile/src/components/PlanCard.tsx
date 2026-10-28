import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { PlanTodo } from '../api/client'
import { Icon } from '../icons'
import { GlyphSpinner } from '../motion'
import { font, icon, radius, space, usePalette, weight } from '../theme'

type RowKind = 'done' | 'running' | 'blocked' | 'pending'

const isDone = (todo: PlanTodo) => todo.done || todo.status === 'done'

function activeIndex(todos: PlanTodo[], running: boolean): number {
  const explicit = todos.findIndex((todo) => todo.status === 'running')
  if (explicit >= 0) return explicit
  if (todos.some((todo) => todo.status !== undefined) || !running) return -1
  return todos.findIndex((todo) => !isDone(todo))
}

export function PlanCard({ todos, stale, running }: { todos: PlanTodo[]; stale: boolean; running: boolean }) {
  const p = usePalette()
  const [expanded, setExpanded] = useState(false)
  const done = todos.filter(isDone).length
  if (!todos.length || done >= todos.length) return null
  const active = activeIndex(todos, running)
  const kindOf = (todo: PlanTodo, index: number): RowKind => isDone(todo) ? 'done' : todo.status === 'blocked' ? 'blocked' : index === active ? 'running' : 'pending'
  const now = !expanded && !stale && active >= 0 ? todos[active].text : ''
  return <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`计划 ${done}/${todos.length}${now ? `，正在：${now}` : ''}`} onPress={() => setExpanded(!expanded)} style={styles.head}>
      <Text style={{ color: p.fg, fontSize: font.sm, fontWeight: weight.medium }}>计划 {done}/{todos.length}</Text>
      {stale ? <Text style={{ color: p.fgMute, fontSize: font.xs }}>上一轮</Text> : null}
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: p.fgMute, fontSize: font.sm }}>{now ? `正在：${now}` : ''}</Text>
      <View style={{ transform: [{ rotate: expanded ? '-90deg' : '90deg' }] }}><Icon name="chevron-right" size={icon.sm} color={p.fgMute} /></View>
    </Pressable>
    {expanded ? <ScrollView style={styles.list} nestedScrollEnabled>
      {todos.map((todo, index) => {
        const kind = kindOf(todo, index)
        return <View key={index} style={styles.row}>
          <View style={styles.mark}>{kind === 'running' ? <GlyphSpinner /> : <Text style={{ color: kind === 'blocked' ? p.warn : p.fgMute, fontSize: font.sm }}>{kind === 'done' ? '✓' : kind === 'blocked' ? '!' : '○'}</Text>}</View>
          <Text style={{ flex: 1, minWidth: 0, color: kind === 'done' ? p.fgMute : p.fg, fontSize: font.sm, lineHeight: 20, textDecorationLine: kind === 'done' ? 'line-through' : 'none' }}>{todo.text}</Text>
        </View>
      })}
    </ScrollView> : null}
  </View>
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: space[3] },
  head: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  list: { maxHeight: 220, paddingBottom: space[2] },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2], paddingVertical: 3 },
  mark: { width: 16, minHeight: 20, alignItems: 'center', justifyContent: 'center' }
})
