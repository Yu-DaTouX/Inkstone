import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { SubagentInfo } from '../api/client'
import { Icon } from '../icons'
import { MessageBody } from './MessageBody'
import { ModelBot, type BotSpriteMood } from './ModelBot'
import { GlyphSpinner } from '../motion'
import { font, icon, mono, radius, space, usePalette, weight } from '../theme'

const BOT_SIZE = 28

const isLive = (run: SubagentInfo) => run.status === 'starting' || run.status === 'running'

function shortModel(model?: string): string {
  if (!model) return ''
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

function duration(run: SubagentInfo, now: number): string {
  const ms = Math.max(0, (run.endedAt ?? now) - run.startedAt)
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function botMood(run: SubagentInfo): BotSpriteMood {
  if (run.status === 'starting') return 'wake'
  if (run.status === 'running') return 'work'
  if (run.status === 'cancelled') return 'rest'
  if (run.endReason === 'timeout' || run.endReason === 'budget') return 'ask'
  return run.status === 'error' ? 'fail' : 'done'
}

function statusText(run: SubagentInfo): string {
  if (isLive(run)) return run.status === 'starting' ? '启动中' : '运行中'
  if (run.status === 'error') return run.endReason === 'timeout' ? '超时' : '失败'
  if (run.status === 'cancelled') return '已停止'
  return '完成'
}

export function SubagentCard({ runs }: { runs: SubagentInfo[] }) {
  const p = usePalette()
  const live = runs.filter(isLive).length
  const failed = runs.filter((run) => run.status === 'error').length
  const done = runs.filter((run) => run.status === 'done').length
  const [stored, setStored] = useState<boolean | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  if (!runs.length) return null
  const expanded = stored ?? live > 0
  const now = Date.now()
  const counts = [live ? `${live} 运行中` : '', done ? `${done} 完成` : '', failed ? `${failed} 失败` : ''].filter(Boolean).join(' · ')
  return <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`子代理 ${runs.length} 个，${counts}`} onPress={() => setStored(!expanded)} style={styles.head}>
      {live ? <GlyphSpinner /> : null}
      <Text style={{ color: p.fg, fontSize: font.sm, fontWeight: weight.medium }}>子代理 {runs.length}</Text>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: p.fgMute, fontSize: font.sm }}>{[live ? `${live} 运行中` : '', done ? `${done} 完成` : ''].filter(Boolean).join(' · ')}{failed ? <Text style={{ color: p.err }}>{live || done ? ' · ' : ''}{failed} 失败</Text> : null}</Text>
      <View style={{ transform: [{ rotate: expanded ? '-90deg' : '90deg' }] }}><Icon name="chevron-right" size={icon.sm} color={p.fgMute} /></View>
    </Pressable>
    {expanded ? <ScrollView style={styles.list} nestedScrollEnabled>
      {runs.map((run) => {
        const open = openRun === run.id
        const tone = run.status === 'error' ? p.err : isLive(run) ? p.fg : p.fgDim
        const meta = [statusText(run), shortModel(run.model), typeof run.toolCalls === 'number' ? `${run.toolCalls} 次工具` : '', duration(run, now)].filter(Boolean).join(' · ')
        const detail = run.status === 'error' ? (run.error || run.summary) : (run.summary || (isLive(run) ? run.latestActivity : ''))
        return <Pressable key={run.id} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${run.title}，${meta}`} onPress={() => setOpenRun(open ? null : run.id)} style={styles.row}>
          <ModelBot model={run.model} mood={botMood(run)} size={BOT_SIZE} />
          <View style={styles.body}>
            <Text numberOfLines={open ? undefined : 1} style={{ color: tone, fontSize: font.sm, lineHeight: 20 }}>{run.title}</Text>
            <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs }}>{meta}</Text>
            {!open && isLive(run) && run.latestActivity ? <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs }}>{run.latestActivity}</Text> : null}
            {open && detail && run.status === 'error' ? <Text selectable style={[styles.detail, { color: p.err, backgroundColor: p.sunken }]}>{detail}</Text> : null}
            {open && detail && run.status !== 'error' ? <View style={[styles.summary, { backgroundColor: p.sunken }]}><MessageBody text={detail} /></View> : null}
            {open && run.task !== run.title ? <Text selectable style={{ color: p.fgMute, fontSize: font.xs, lineHeight: 17 }}>{run.task}</Text> : null}
          </View>
        </Pressable>
      })}
    </ScrollView> : null}
  </View>
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: space[3] },
  head: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  list: { maxHeight: 260, paddingBottom: space[2] },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2], paddingVertical: space[1] },
  body: { flex: 1, minWidth: 0, gap: 2 },
  summary: { borderRadius: radius.md, padding: space[2], marginTop: 2 },
  detail: { fontFamily: mono, fontSize: font.xs, lineHeight: 17, borderRadius: radius.md, padding: space[2], marginTop: 2 }
})
