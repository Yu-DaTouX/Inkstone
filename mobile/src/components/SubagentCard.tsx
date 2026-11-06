import { pick } from '../../../src/shared/ui-lang'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { SubagentInfo } from '../api/client'
import { capabilityAllowed } from '../../../src/shared/capability-negotiation'
import { useRemote } from '../state'
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
  if (seconds < 60) return pick(`${seconds} 秒`, `${seconds}s`)
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? pick(`${minutes} 分 ${seconds % 60} 秒`, `${minutes}m ${seconds % 60}s`) : pick(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`, `${Math.floor(minutes / 60)}h ${minutes % 60}m`)
}

function botMood(run: SubagentInfo): BotSpriteMood {
  if (run.status === 'starting') return 'wake'
  if (run.status === 'running') return 'work'
  if (run.status === 'cancelled') return 'rest'
  if (run.endReason === 'timeout' || run.endReason === 'budget') return 'ask'
  return run.status === 'error' ? 'fail' : 'done'
}

function statusText(run: SubagentInfo): string {
  if (isLive(run)) return run.status === 'starting' ? pick('启动中', 'Starting') : pick('运行中', 'Running')
  if (run.status === 'error') return run.endReason === 'timeout' ? pick('超时', 'Timed out') : pick('失败', 'Failed')
  if (run.status === 'cancelled') return pick('已停止', 'Stopped')
  return pick('完成', 'Done')
}

export function SubagentCard({ runs, plain = false, sessionId }: { runs: SubagentInfo[]; plain?: boolean; sessionId?: string }) {
  const p = usePalette()
  const { client, info } = useRemote()
  const [stopping, setStopping] = useState<string | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)
  const canStop = !!sessionId && capabilityAllowed(info, 'subagent-stop')
  const stop = async (runId: string) => {
    if (!sessionId || stopping) return
    setStopping(runId); setStopError(null)
    try { await client.stopSubagent(sessionId, runId) }
    catch (err) { setStopError(err instanceof Error ? err.message : pick('停止失败', 'Stop failed')) }
    finally { setStopping(null) }
  }
  const live = runs.filter(isLive).length
  const failed = runs.filter((run) => run.status === 'error').length
  const done = runs.filter((run) => run.status === 'done').length
  const [stored, setStored] = useState<boolean | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  if (!runs.length) return null
  const expanded = plain || (stored ?? live > 0)
  const now = Date.now()
  const counts = [live ? pick(`${live} 运行中`, `${live} running`) : '', done ? pick(`${done} 完成`, `${done} done`) : '', failed ? pick(`${failed} 失败`, `${failed} failed`) : ''].filter(Boolean).join(' · ')
  return <View style={plain ? null : [styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
    {plain ? null : <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={pick(`子代理 ${runs.length} 个，${counts}`, `${runs.length} subagents, ${counts}`)} onPress={() => setStored(!expanded)} style={styles.head}>
      {live ? <GlyphSpinner /> : null}
      <Text style={{ color: p.fg, fontSize: font.sm, fontWeight: weight.medium }}>{pick('子代理', 'Subagents')} {runs.length}</Text>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: p.fgMute, fontSize: font.sm }}>{[live ? pick(`${live} 运行中`, `${live} running`) : '', done ? pick(`${done} 完成`, `${done} done`) : ''].filter(Boolean).join(' · ')}{failed ? <Text style={{ color: p.err }}>{live || done ? ' · ' : ''}{pick(`${failed} 失败`, `${failed} failed`)}</Text> : null}</Text>
      <View style={{ transform: [{ rotate: expanded ? '-90deg' : '90deg' }] }}><Icon name="chevron-right" size={icon.sm} color={p.fgMute} /></View>
    </Pressable>}
    {expanded ? <ScrollView style={plain ? null : styles.list} scrollEnabled={!plain} nestedScrollEnabled>
      {runs.map((run) => {
        const open = openRun === run.id
        const tone = run.status === 'error' ? p.err : isLive(run) ? p.fg : p.fgDim
        const meta = [statusText(run), shortModel(run.model), typeof run.toolCalls === 'number' ? pick(`${run.toolCalls} 次工具`, `${run.toolCalls} tool calls`) : '', duration(run, now)].filter(Boolean).join(' · ')
        const detail = run.status === 'error' ? (run.error || run.summary) : (run.summary || (isLive(run) ? run.latestActivity : ''))
        return <Pressable key={run.id} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${run.title}，${meta}`} onPress={() => setOpenRun(open ? null : run.id)} style={styles.row}>
          <ModelBot model={run.model} mood={botMood(run)} size={BOT_SIZE} />
          <View style={styles.body}>
            <Text numberOfLines={open ? undefined : 1} style={{ color: tone, fontSize: font.sm, lineHeight: 20 }}>{run.title}</Text>
            <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs }}>{meta}</Text>
            {!open && isLive(run) && run.latestActivity ? <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs }}>{run.latestActivity}</Text> : null}
            {open && detail && run.status === 'error' ? <Text selectable style={[styles.detail, { color: p.err, backgroundColor: p.sunken }]}>{detail}</Text> : null}
            {open && detail && run.status !== 'error' ? <View style={[styles.summary, { backgroundColor: p.sunken }]}><MessageBody text={detail} /></View> : null}
            {open && canStop && isLive(run) ? <Pressable accessibilityRole="button" accessibilityLabel={pick(`停止子代理 ${run.title}`, `Stop subagent ${run.title}`)} disabled={stopping !== null} onPress={() => void stop(run.id)} style={[styles.stop, { borderColor: p.err, opacity: stopping === run.id ? 0.5 : 1 }]}><Icon name="stop" size={icon.sm} color={p.err} /><Text style={{ color: p.err, fontSize: font.sm }}>{pick('停止', 'Stop')}</Text></Pressable> : null}
            {open && stopError ? <Text style={{ color: p.err, fontSize: font.xs }}>{stopError}</Text> : null}
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
  stop: { alignSelf: 'flex-start', minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: space[1], paddingHorizontal: space[3], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md },
  summary: { borderRadius: radius.md, padding: space[2], marginTop: 2 },
  detail: { fontFamily: mono, fontSize: font.xs, lineHeight: 17, borderRadius: radius.md, padding: space[2], marginTop: 2 }
})
