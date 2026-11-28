import { pick } from '../../../src/shared/ui-lang'
import { useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { idempotencyKey } from '../api/client'
import { subagentActions } from '../sessionActions'
import { PatchSheet } from './PatchSheet'
import type { SubagentInfo } from '../api/client'
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
  if (interrupted(run)) return run.resumable === false ? pick('已中断', 'Interrupted') : pick('已中断 · 可续接', 'Interrupted · can resume')
  if (run.status === 'cancelled') return pick('已停止', 'Stopped')
  return pick('完成', 'Done')
}

function interrupted(run: Pick<SubagentInfo, 'status' | 'endReason'>): boolean {
  return run.status === 'cancelled' && run.endReason === 'interrupted'
}

function reviewText(run: SubagentInfo): string {
  if (run.review === 'pending') return pick('改动待处置', 'Changes awaiting review')
  if (run.review === 'conflict') return pick('合并有冲突', 'Merge conflict')
  if (run.review === 'merged') return pick('已合并', 'Merged')
  if (run.review === 'discarded') return pick('已放弃', 'Discarded')
  return ''
}

function SubagentReply({ sessionId, run }: { sessionId: string; run: SubagentInfo }) {
  const p = usePalette()
  const { client } = useRemote()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null)
  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true); setNote(null)
    try { await client.sendSubagent(sessionId, run.id, body, idempotencyKey()); setText(''); setNote({ error: false, text: pick('已发给它', 'Sent') }) }
    catch (err) { setNote({ error: true, text: err instanceof Error ? err.message : pick('没发出去', 'Not sent') }) }
    finally { setBusy(false) }
  }
  return <View style={{ gap: 2 }}>
    <View style={[styles.reply, { borderColor: p.borderSoft, backgroundColor: p.surface }]}>
      <TextInput disableFullscreenUI value={text} onChangeText={setText} editable={!busy} multiline placeholder={isLive(run) ? pick('给它补充指令…', 'Add instructions…') : pick('让它继续…', 'Ask it to continue…')} placeholderTextColor={p.fgMute} accessibilityLabel={pick(`发消息给子代理 ${run.title}`, `Message subagent ${run.title}`)} style={{ flex: 1, minWidth: 0, maxHeight: 120, color: p.fg, fontSize: font.sm, paddingVertical: space[1] }} />
      <Pressable accessibilityRole="button" accessibilityLabel={pick('发送', 'Send')} disabled={busy || !text.trim()} onPress={() => void send()} style={{ minWidth: 44, minHeight: 36, alignItems: 'center', justifyContent: 'center', opacity: busy || !text.trim() ? 0.4 : 1 }}>
        {busy ? <GlyphSpinner /> : <Icon name="send" size={icon.sm} color={p.accent} />}
      </Pressable>
    </View>
    {note ? <Text accessibilityLiveRegion="polite" style={{ color: note.error ? p.err : p.fgMute, fontSize: font.xs }}>{note.text}</Text> : null}
  </View>
}

export function SubagentCard({ runs, plain = false, sessionId }: { runs: SubagentInfo[]; plain?: boolean; sessionId?: string }) {
  const p = usePalette()
  const { client } = useRemote()
  const [stopping, setStopping] = useState<string | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)
  const canAct = !!sessionId
  const [patchRun, setPatchRun] = useState<SubagentInfo | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState<{ id: string; error: boolean; text: string } | null>(null)
  const review = (run: SubagentInfo, action: 'merge' | 'discard') => {
    if (!sessionId || reviewing) return
    const files = run.diff?.files ?? 0
    const title = action === 'merge' ? pick('合并这些改动？', 'Merge these changes?') : pick('放弃这些改动？', 'Discard these changes?')
    const body = action === 'merge'
      ? pick(`把子代理在工作树里改的 ${files} 个文件合进电脑上的项目目录。`, `Apply the ${files} files the subagent changed in its worktree to the project folder on the desktop.`)
      : pick('会删掉子代理的工作树，补丁留在电脑上；手机上不能撤销。', 'Removes the subagent worktree and keeps its patch on the desktop. This cannot be undone here.')
    Alert.alert(title, body, [
      { text: pick('取消', 'Cancel'), style: 'cancel' },
      { text: action === 'merge' ? pick('合并', 'Merge') : pick('放弃', 'Discard'), style: action === 'merge' ? 'default' : 'destructive', onPress: () => void (async () => {
        setReviewing(run.id); setReviewNote(null)
        try {
          const result = await client.reviewSubagent(sessionId, run.id, action, idempotencyKey())
          setReviewNote({ id: run.id, error: false, text: result.warning || (action === 'merge' ? pick('已合并', 'Merged') : pick('已放弃', 'Discarded')) })
        } catch (err) {
          setReviewNote({ id: run.id, error: true, text: err instanceof Error ? err.message : pick('操作失败', 'Action failed') })
        } finally { setReviewing(null) }
      })() }
    ])
  }
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
        const actions = canAct ? subagentActions(run) : { merge: false, discard: false, send: false }
        const meta = [statusText(run), reviewText(run), shortModel(run.model), typeof run.toolCalls === 'number' ? pick(`${run.toolCalls} 次工具`, `${run.toolCalls} tool calls`) : '', duration(run, now)].filter(Boolean).join(' · ')
        const detail = run.status === 'error' ? (run.error || run.summary) : (run.summary || (isLive(run) ? run.latestActivity : ''))
        return <View key={run.id}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${run.title}${pick('，', ', ')}${meta}`} onPress={() => setOpenRun(open ? null : run.id)} style={styles.row}>
            <ModelBot model={run.model} mood={botMood(run)} size={BOT_SIZE} />
            <View style={styles.body}>
              <Text numberOfLines={open ? undefined : 1} style={{ color: tone, fontSize: font.sm, lineHeight: 20 }}>{run.title}</Text>
              <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs }}>{meta}</Text>
              {!open && isLive(run) && run.latestActivity ? <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs }}>{run.latestActivity}</Text> : null}
            </View>
          </Pressable>
          {open ? <View style={styles.expanded}>
            {detail && run.status === 'error' ? <Text selectable style={[styles.detail, { color: p.err, backgroundColor: p.sunken }]}>{detail}</Text> : null}
            {detail && run.status !== 'error' ? <View style={[styles.summary, { backgroundColor: p.sunken }]}><MessageBody text={detail} /></View> : null}
            {canAct && isLive(run) ? <Pressable accessibilityRole="button" accessibilityLabel={pick(`停止子代理 ${run.title}`, `Stop subagent ${run.title}`)} disabled={stopping !== null} onPress={() => void stop(run.id)} style={[styles.stop, { borderColor: p.err, opacity: stopping === run.id ? 0.5 : 1 }]}><Icon name="stop" size={icon.sm} color={p.err} /><Text style={{ color: p.err, fontSize: font.sm }}>{pick('停止', 'Stop')}</Text></Pressable> : null}
            {stopError ? <Text style={{ color: p.err, fontSize: font.xs }}>{stopError}</Text> : null}
            {run.diff ? <View style={[styles.summary, { backgroundColor: p.sunken, gap: 2 }]}>
              <Text style={{ color: p.fgDim, fontSize: font.xs, fontFamily: mono }}>{pick(`${run.diff.files} 个文件`, `${run.diff.files} files`)} <Text style={{ color: p.add }}>+{run.diff.additions}</Text> <Text style={{ color: p.del }}>−{run.diff.deletions}</Text></Text>
              {run.diff.paths.map((path) => <Text key={path} numberOfLines={1} ellipsizeMode="head" style={{ color: p.fg, fontSize: font.xs, fontFamily: mono }}>{path}</Text>)}
              {run.diff.truncated ? <Text style={{ color: p.fgMute, fontSize: font.xs }}>{pick('更多文件在电脑上查看', 'More files on the desktop')}</Text> : null}
            </View> : null}
            {canAct && run.diff?.files ? <Pressable accessibilityRole="button" accessibilityLabel={pick(`查看子代理 ${run.title} 的补丁`, `View the patch from subagent ${run.title}`)} onPress={() => setPatchRun(run)} style={[styles.stop, { borderColor: p.borderSoft }]}><Icon name="file" size={icon.sm} color={p.fgDim} /><Text style={{ color: p.fg, fontSize: font.sm }}>{pick('查看补丁', 'View patch')}</Text></Pressable> : null}
            {(actions.merge || actions.discard) ? <View style={styles.reviewRow}>
              {actions.merge ? <Pressable accessibilityRole="button" accessibilityLabel={pick(`合并子代理 ${run.title} 的改动`, `Merge changes from subagent ${run.title}`)} disabled={reviewing !== null} onPress={() => review(run, 'merge')} style={[styles.stop, { borderColor: p.accent, opacity: reviewing === run.id ? 0.5 : 1 }]}><Icon name="check" size={icon.sm} color={p.accent} /><Text style={{ color: p.accent, fontSize: font.sm }}>{pick('合并', 'Merge')}</Text></Pressable> : null}
              {actions.discard ? <Pressable accessibilityRole="button" accessibilityLabel={pick(`放弃子代理 ${run.title} 的改动`, `Discard changes from subagent ${run.title}`)} disabled={reviewing !== null} onPress={() => review(run, 'discard')} style={[styles.stop, { borderColor: p.err, opacity: reviewing === run.id ? 0.5 : 1 }]}><Icon name="close" size={icon.sm} color={p.err} /><Text style={{ color: p.err, fontSize: font.sm }}>{pick('放弃', 'Discard')}</Text></Pressable> : null}
            </View> : null}
            {reviewNote?.id === run.id ? <Text accessibilityLiveRegion="polite" style={{ color: reviewNote.error ? p.err : p.fgMute, fontSize: font.xs }}>{reviewNote.text}</Text> : null}
            {actions.send && sessionId ? <SubagentReply sessionId={sessionId} run={run} /> : null}
            {run.task !== run.title ? <Text selectable style={{ color: p.fgMute, fontSize: font.xs, lineHeight: 17 }}>{run.task}</Text> : null}
          </View> : null}
        </View>
      })}
    </ScrollView> : null}
    {sessionId ? <PatchSheet sessionId={sessionId} runId={patchRun?.id ?? null} title={patchRun?.title ?? ''} onClose={() => setPatchRun(null)} /> : null}
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
  expanded: { marginLeft: BOT_SIZE + space[2], gap: 2, paddingBottom: space[1] },
  reviewRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  reply: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingLeft: space[2], marginTop: 2 },
  detail: { fontFamily: mono, fontSize: font.xs, lineHeight: 17, borderRadius: radius.md, padding: space[2], marginTop: 2 }
})
