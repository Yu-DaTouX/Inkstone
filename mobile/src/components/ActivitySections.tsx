import { pick } from '../../../src/shared/ui-lang'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { RemoteJob, RemoteWorkflow } from '../../../src/shared/remote-protocol'
import { idempotencyKey } from '../api/client'
import { jobStateText, jobStoppable, workflowActions, workflowProgressText, workflowStatusText } from '../activity'
import { costText } from '../format'
import { GlyphSpinner } from '../motion'
import { useRemote } from '../state'
import { font, mono, radius, space, usePalette } from '../theme'
import { Button } from '../ui'
import { Section } from './Section'

function useSessionList<T>(sessionId: string, kind: 'jobs' | 'workflows', load: (sessionId: string) => Promise<T[]>): { items: T[]; reload: () => void } {
  const { onSessionEvent } = useRemote()
  const [items, setItems] = useState<T[]>([])
  const alive = useRef(true)
  const loadRef = useRef(load)
  loadRef.current = load
  const reload = useCallback(() => {
    void loadRef.current(sessionId).then((next) => { if (alive.current) setItems((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next) }).catch(() => undefined)
  }, [sessionId])
  useEffect(() => {
    alive.current = true
    setItems([])
    reload()
    const off = onSessionEvent(sessionId, (kinds) => { if (kinds.has(kind) || kinds.has('messages')) reload() })
    return () => { alive.current = false; off() }
  }, [kind, onSessionEvent, reload, sessionId])
  return { items, reload }
}

export function JobsSection({ sessionId }: { sessionId: string }) {
  const p = usePalette()
  const { client } = useRemote()
  const { items, reload } = useSessionList<RemoteJob>(sessionId, 'jobs', (id) => client.jobs(id))
  const [open, setOpen] = useState<string | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)
  const [stopError, setStopError] = useState<{ id: string; text: string } | null>(null)
  if (!items.length) return null
  const stop = (job: RemoteJob) => Alert.alert(pick('停止这个后台任务？', 'Stop this background task?'), job.command, [
    { text: pick('取消', 'Cancel'), style: 'cancel' },
    { text: pick('停止', 'Stop'), style: 'destructive', onPress: () => void (async () => {
      setStopping(job.id); setStopError(null)
      try { await client.stopJob(sessionId, job.id, idempotencyKey()); reload() }
      catch (err) { setStopError({ id: job.id, text: err instanceof Error ? err.message : pick('停止失败', 'Stop failed') }) }
      finally { setStopping(null) }
    })() }
  ])
  const live = items.filter((job) => job.live).length
  return <Section title={pick('后台任务', 'Background tasks')} value={live ? pick(`${live} 运行中`, `${live} running`) : String(items.length)} initiallyOpen={live > 0}>
    {items.map((job) => {
      const expanded = open === job.id
      return <View key={job.id}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${job.command}${pick('，', ', ')}${jobStateText(job)}`} onPress={() => setOpen(expanded ? null : job.id)} style={styles.row}>
          {job.live ? <GlyphSpinner /> : <Text style={{ width: 14, textAlign: 'center', color: job.exitCode ? p.err : p.fgMute, fontSize: font.sm }}>{job.exitCode ? '!' : '✓'}</Text>}
          <Text numberOfLines={expanded ? 4 : 1} style={[styles.command, { color: p.fg }]}>{job.command}</Text>
          <Text style={[styles.meta, { color: job.exitCode ? p.err : p.fgMute }]}>{jobStateText(job)}</Text>
        </Pressable>
        {expanded && jobStoppable(job) ? <View style={[styles.actions, { paddingLeft: space[5] }]}><Button compact label={pick('停止', 'Stop')} variant="danger" busy={stopping === job.id} disabled={stopping !== null} onPress={() => stop(job)} /></View> : null}
        {expanded && stopError?.id === job.id ? <Text accessibilityLiveRegion="polite" style={{ color: p.err, fontSize: font.xs, paddingLeft: space[5] }}>{stopError.text}</Text> : null}
        {expanded ? job.output ? <ScrollView nestedScrollEnabled style={[styles.output, { backgroundColor: p.sunken }]}>
          {job.outputTruncated ? <Text style={{ color: p.fgMute, fontSize: font.xs }}>{pick('（只显示最后一段输出）', '(showing the last part of the output)')}</Text> : null}
          <Text selectable style={{ color: p.fgDim, fontFamily: mono, fontSize: font.xs, lineHeight: 16 }}>{job.output}</Text>
        </ScrollView> : <Text style={{ color: p.fgMute, fontSize: font.xs, paddingLeft: space[5] }}>{job.kind === 'bash' ? pick('这个任务的输出在它结束后随通知回到会话里', 'This task\'s output comes back to the session when it ends') : pick('暂无输出', 'No output yet')}</Text> : null}
      </View>
    })}
  </Section>
}

const ACTION_LABEL = { pause: () => pick('暂停', 'Pause'), resume: () => pick('继续', 'Resume'), stop: () => pick('停止', 'Stop') }

export function WorkflowsSection({ sessionId }: { sessionId: string }) {
  const p = usePalette()
  const { client } = useRemote()
  const { items, reload } = useSessionList<RemoteWorkflow>(sessionId, 'workflows', (id) => client.workflows(id))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  if (!items.length) return null
  const act = async (run: RemoteWorkflow, action: 'pause' | 'resume' | 'stop') => {
    setBusy(run.id); setError(null)
    try { await client.workflowControl(sessionId, run.id, action, idempotencyKey()); reload() }
    catch (err) { setError({ id: run.id, text: err instanceof Error ? err.message : pick('操作失败', 'Action failed') }) }
    finally { setBusy(null) }
  }
  const confirm = (run: RemoteWorkflow, action: 'pause' | 'resume' | 'stop') => action !== 'stop' ? void act(run, action) : Alert.alert(pick('停止这个工作流？', 'Stop this workflow?'), pick('正在跑的步骤会被停下，已完成的结果保留。', 'Running steps are stopped; finished results are kept.'), [
    { text: pick('取消', 'Cancel'), style: 'cancel' },
    { text: pick('停止', 'Stop'), style: 'destructive', onPress: () => void act(run, 'stop') }
  ])
  const live = items.filter((run) => run.status === 'running').length
  return <Section title={pick('工作流', 'Workflows')} value={live ? pick(`${live} 运行中`, `${live} running`) : String(items.length)} initiallyOpen={live > 0 || items.some((run) => run.status === 'paused')}>
    {items.map((run) => {
      const ratio = run.progress.total ? run.progress.done / run.progress.total : 0
      const cost = typeof run.cost === 'number' ? costText(run.cost) : ''
      return <View key={run.id} style={styles.workflow}>
        <View style={styles.row}>
          {run.status === 'running' ? <GlyphSpinner /> : null}
          <Text numberOfLines={1} style={[styles.command, { color: p.fg, fontFamily: undefined, fontSize: font.base }]}>{run.name}</Text>
          <Text style={[styles.meta, { color: run.status === 'failed' ? p.err : p.fgMute }]}>{workflowStatusText(run)}</Text>
        </View>
        {run.progress.total ? <View style={[styles.meter, { backgroundColor: p.borderSoft }]}><View style={[styles.meterFill, { width: `${Math.max(2, Math.round(ratio * 100))}%`, backgroundColor: run.progress.failed ? p.warn : p.accent }]} /></View> : null}
        <Text style={[styles.meta, { color: p.fgMute }]}>{[workflowProgressText(run), cost].filter(Boolean).join(' · ')}</Text>
        {run.error ? <Text selectable style={{ color: p.err, fontSize: font.xs }}>{run.error}</Text> : null}
        {run.logs.length && run.status === 'running' ? <Text numberOfLines={2} style={{ color: p.fgMute, fontSize: font.xs, fontFamily: mono }}>{run.logs[run.logs.length - 1]}</Text> : null}
        {workflowActions(run).length ? <View style={styles.actions}>{workflowActions(run).map((action) => <Button key={action} compact label={ACTION_LABEL[action]()} variant={action === 'stop' ? 'danger' : 'secondary'} busy={busy === run.id} disabled={busy !== null} onPress={() => confirm(run, action)} />)}</View> : null}
        {error?.id === run.id ? <Text accessibilityLiveRegion="polite" style={{ color: p.err, fontSize: font.xs }}>{error.text}</Text> : null}
      </View>
    })}
  </Section>
}

const styles = StyleSheet.create({
  row: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  command: { flex: 1, minWidth: 0, fontFamily: mono, fontSize: font.sm },
  meta: { fontSize: font.xs },
  output: { maxHeight: 220, borderRadius: radius.md, padding: space[2], marginLeft: space[5], marginBottom: space[1] },
  workflow: { gap: 4, paddingVertical: space[1] },
  meter: { height: 4, borderRadius: 2, overflow: 'hidden' },
  meterFill: { height: 4, borderRadius: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }
})
