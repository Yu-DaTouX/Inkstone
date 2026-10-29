import { RemoteImage } from '../components/RemoteImage'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AppState, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, type ViewToken } from 'react-native'
import { idempotencyKey, RemoteHttpError, type HistoryMessage, type HistoryPage, type SubagentInfo } from '../api/client'
import { PlanCard } from '../components/PlanCard'
import { SubagentCard } from '../components/SubagentCard'
import { QuestionCard } from '../components/QuestionCard'
import { MessageBody } from '../components/MessageBody'
import { SpeechInputButton } from '../components/SpeechInputButton'
import { useRemote } from '../state'
import { font, icon, mono, radius, space, touch, usePalette } from '../theme'
import { ActivityLine, EmptyState, Header, IconButton, Meta, STATUS_TEXT } from '../ui'
import { Icon } from '../icons'
import { GlyphSpinner, RunDot } from '../motion'
import type { SpeechPhase } from '../speech'
import { mergeRecentHistory } from '../historyCache'
import { pickImages, type PhotoDraft } from '../device'
import { ModelPicker } from '../components/ModelPicker'
import type { RemoteModel } from '../../../src/shared/remote-protocol'
import { capabilityAllowed } from '../../../src/shared/capability-negotiation'

type ToolStep = { id: string; name: string; failed: boolean; denied: boolean; running: boolean; awaiting: boolean; summary: string; output: string; nested: boolean }
type ProcessStep =
  | { kind: 'text'; key: string; message: HistoryMessage }
  | { kind: 'thinking'; key: string; text: string; ms?: number }
  | { kind: 'tool'; key: string; tool: ToolStep }
type TimelineEntry =
  | { kind: 'message'; key: string; message: HistoryMessage }
  | { kind: 'process'; key: string; steps: ProcessStep[]; actions: number; thinking: number; failed: number }

const SHOWN_ROLES = new Set(['user', 'assistant', 'bash'])
const UNCOUNTED_TOOLS = new Set(['todo', 'todos', 'todo_write', 'update_todos'])
const LIVE_STEPS = 3
const ARG_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description', 'task', 'prompt']

function argSummary(args: unknown): string {
  if (typeof args === 'string') return args.split('\n')[0].slice(0, 160)
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  const key = ARG_KEYS.find((name) => typeof record[name] === 'string' && record[name])
  const text = key ? String(record[key]) : JSON.stringify(args)
  return text.split('\n')[0].slice(0, 160)
}

const SUBAGENT_NOTICE_RE = /^<subagent-notification id="[^"]+" status="[^"]+">/
const isSubagentNotice = (message: HistoryMessage) => message.role === 'user' && SUBAGENT_NOTICE_RE.test(message.text?.trimStart() ?? '')

const hasReply = (message: HistoryMessage) => !!(message.text?.trim() || message.error || message.artifacts?.length)

function makeTimeline(messages: HistoryMessage[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let turn: HistoryMessage[] = []
  const flushTurn = () => {
    if (!turn.length) return
    let replyIndex = -1
    turn.forEach((message, index) => { if (hasReply(message)) replyIndex = index })
    const steps: ProcessStep[] = []
    const tools = new Map<string, ToolStep>()
    turn.forEach((message, index) => {
      if (message.thinking?.trim()) steps.push({ kind: 'thinking', key: `thinking-${message.id}`, text: message.thinking.trim(), ms: message.thinkingMs })
      if (index !== replyIndex && hasReply(message)) steps.push({ kind: 'text', key: `text-${message.id}`, message })
      for (const [toolIndex, tool] of (message.toolCalls ?? []).entries()) {
        const key = tool.id || `${message.id}:${toolIndex}`
        const old = tools.get(key)
        const denied = tool.denied === true || !!old?.denied
        const next: ToolStep = {
          id: key,
          name: tool.name || old?.name || '工具',
          failed: (tool.status === 'error' && !denied) || !!old?.failed,
          denied,
          running: tool.status === 'running' || tool.status === 'pending',
          awaiting: tool.output === undefined && old?.output === undefined,
          summary: argSummary(tool.args) || old?.summary || '',
          output: tool.output ?? old?.output ?? '',
          nested: !!tool.parentToolCallId
        }
        if (old) Object.assign(old, next)
        else {
          tools.set(key, next)
          steps.push({ kind: 'tool', key: `tool-${key}`, tool: next })
        }
      }
    })
    const counted = [...tools.values()].filter((tool) => !tool.nested && !(UNCOUNTED_TOOLS.has(tool.name) && !tool.failed))
    const thinking = steps.filter((step) => step.kind === 'thinking').length
    if (counted.length || thinking) {
      entries.push({ kind: 'process', key: `process-${turn[0].id}`, steps, actions: counted.length, thinking, failed: counted.filter((tool) => tool.failed).length })
    } else {
      for (const step of steps) if (step.kind === 'text') entries.push({ kind: 'message', key: step.message.id, message: step.message })
    }
    if (replyIndex >= 0) entries.push({ kind: 'message', key: turn[replyIndex].id, message: turn[replyIndex] })
    turn = []
  }
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'bash') {
      flushTurn()
      if (!isSubagentNotice(message)) entries.push({ kind: 'message', key: message.id, message })
    } else turn.push(message)
  }
  flushTurn()
  return entries
}

function liveProcessKey(timeline: TimelineEntry[], running: boolean): string | null {
  if (!running) return null
  for (let index = timeline.length - 1; index >= 0; index--) {
    const entry = timeline[index]
    if (entry.kind === 'process') return entry.key
    if (entry.message.role !== 'assistant') return null
  }
  return null
}

export function SessionScreen({
  sessionId,
  title,
  onBack,
  onOpenArtifact,
  draft,
  onDraftChange,
  photos,
  onPhotosChange,
  showPending = true,
  tabletop,
  onToggleSidebar,
  sidebarVisible
}: {
  sessionId: string
  title: string
  onBack: () => void
  onOpenArtifact: (artifact: { id: string; filename: string; mediaType: string; kind: string }) => void
  draft: string
  onDraftChange: (text: string) => void
  photos: PhotoDraft[]
  onPhotosChange: (photos: PhotoDraft[]) => void
  showPending?: boolean
  tabletop?: { top: number; gap: number }
  onToggleSidebar?: () => void
  sidebarVisible?: boolean
}) {
  const p = usePalette()
  const { client, questions, runners, sessions, stream, onSessionEvent, refresh, info, marksReady, markRead, unread } = useRemote()
  const cached = useRef(client.historyCache.get(sessionId)).current
  const [messages, setMessages] = useState<HistoryMessage[]>(cached?.messages.filter((m) => SHOWN_ROLES.has(m.role)) ?? [])
  const [loading, setLoading] = useState(!cached)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [limitedOlder, setLimitedOlder] = useState(false)
  const [hasOlder, setHasOlder] = useState(cached?.hasMore ?? (cached?.messages.length ?? 0) >= 60)
  const moreRef = useRef(hasOlder)
  const rawHistory = useRef(cached?.messages ?? [])
  const alive = useRef(true)
  const historyFlight = useRef<Promise<void> | null>(null)
  const refreshAgain = useRef(false)
  const olderBusy = useRef(false)
  const pagination = useRef(false)
  const legacyLimit = useRef(60)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<HistoryPage['plan']>(cached?.plan)
  const [subagents, setSubagents] = useState<SubagentInfo[]>([])
  const subagentsAllowed = capabilityAllowed(info, 'subagents')
  const [sending, setSending] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voicePhase, setVoicePhase] = useState<SpeechPhase>('idle')
  const [expandedTools, setExpandedTools] = useState<string[]>([])
  const toggleExpanded = (key: string) => setExpandedTools((current) => current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key])
  const listRef = useRef<FlatList<TimelineEntry>>(null)
  const listSize = useRef({ content: 0, viewport: 0 })
  const followBottom = useRef(true)
  const scrollGesture = useRef(false)
  const visibleMessages = useRef(new Set<string>())
  const readCurrent = useRef<() => void>(() => undefined)
  const viewability = useRef({ viewAreaCoveragePercentThreshold: 1, minimumViewTime: 300 }).current
  const onViewable = useRef(({ viewableItems }: { viewableItems: Array<ViewToken<TimelineEntry>> }) => {
    visibleMessages.current = new Set(viewableItems.filter((item) => item.isViewable && item.item.kind === 'message').map((item) => item.key))
    readCurrent.current()
  }).current
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const userScrolled = useRef(false)
  const topArmed = useRef(true)
  const [modelPicker, setModelPicker] = useState(false)
  const [selectedModel, setSelectedModel] = useState<RemoteModel | null>(null)
  const [picking, setPicking] = useState(false)
  const sendAttempt = useRef<{ text: string; key: string } | null>(null)
  const abortAttempt = useRef<{ runId: string; key: string } | null>(null)
  const runner = runners.find((entry) => entry.sessionId === sessionId)
  const pending = questions.filter((question) => question.sessionId === sessionId)
  const timeline = useMemo(() => makeTimeline(messages), [messages])
  const liveKey = liveProcessKey(timeline, !!runner?.running)
  const runInList = !!liveKey
  const snapBottom = (animated = false) => {
    if (alive.current && followBottom.current && listSize.current.viewport > 0) listRef.current?.scrollToOffset({ offset: Math.max(0, listSize.current.content - listSize.current.viewport), animated })
  }
  const model = selectedModel ?? runner?.model
  const cwdName = sessions.find((s) => s.id === sessionId)?.cwdName || '电脑工作目录'
  useEffect(() => { if (runner?.model) setSelectedModel(runner.model) }, [runner?.model?.id, runner?.model?.provider])
  const latestReply = [...messages].reverse().find((message) => message.role === 'assistant' && message.text?.trim() && message.timestamp)
  const readLatest = useCallback(() => {
    if (marksReady && !loading && followBottom.current && AppState.currentState === 'active' && latestReply?.timestamp && visibleMessages.current.has(latestReply.id)) markRead(sessionId, { id: latestReply.id, at: latestReply.timestamp })
  }, [latestReply?.id, latestReply?.timestamp, loading, markRead, marksReady, sessionId])
  useEffect(() => {
    readCurrent.current = readLatest
    const frame = requestAnimationFrame(readLatest)
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') readLatest() })
    return () => { cancelAnimationFrame(frame); subscription.remove() }
  }, [readLatest])

  const load = useCallback((): Promise<void> => {
    if (olderBusy.current || historyFlight.current) {
      refreshAgain.current = true
      return historyFlight.current ?? Promise.resolve()
    }
    const task = (async () => {
      try {
        const history = await client.history(sessionId, 60)
        if (!alive.current) return
        pagination.current = typeof history.hasMore === 'boolean'
        if (pagination.current) setLimitedOlder(false)
        setPlan(history.plan)
        const merged = mergeRecentHistory(rawHistory.current, history.messages)
        rawHistory.current = merged.messages
        setMessages(merged.messages.filter((message) => SHOWN_ROLES.has(message.role)))
        if (!merged.retained) {
          moreRef.current = history.hasMore ?? history.messages.length === 60
          setHasOlder(moreRef.current)
          legacyLimit.current = 60
        }
        client.historyCache.set(sessionId, { ...history, messages: merged.messages, hasMore: pagination.current ? moreRef.current : undefined })
        setError(null)
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : '读取失败')
      } finally {
        historyFlight.current = null
        if (alive.current) {
          setLoading(false)
          if (refreshAgain.current) { refreshAgain.current = false; void load() }
        }
      }
    })()
    historyFlight.current = task
    return task
  }, [client, sessionId])

  const loadOlder = async () => {
    if (olderBusy.current || historyFlight.current || !hasOlder) return
    olderBusy.current = true
    setLoadingOlder(true)
    followBottom.current = false
    try {
      const limit = pagination.current ? 60 : Math.min(500, Math.max(legacyLimit.current, rawHistory.current.length) + 60)
      const history = await client.history(sessionId, limit, pagination.current ? rawHistory.current[0]?.id : undefined)
      if (!alive.current) return
      const next = pagination.current ? [...history.messages, ...rawHistory.current] : history.messages
      const unique = [...new Map(next.map((message) => [message.id, message])).values()]
      rawHistory.current = unique
      legacyLimit.current = limit
      const more = history.hasMore ?? (history.messages.length === limit && limit < 500)
      setLimitedOlder(!pagination.current && limit === 500 && history.messages.length === 500)
      moreRef.current = more
      setHasOlder(more)
      setMessages(unique.filter((message) => SHOWN_ROLES.has(message.role)))
      client.historyCache.set(sessionId, { ...history, messages: unique, hasMore: pagination.current ? more : undefined })
      setError(null)
    } catch (err) {
      if (alive.current && err instanceof RemoteHttpError && err.code === 'history_cursor_expired') {
        rawHistory.current = []
        refreshAgain.current = true
        followBottom.current = true
      } else if (alive.current) setError(err instanceof Error ? err.message : '读取失败')
    } finally {
      olderBusy.current = false
      if (alive.current) {
        setLoadingOlder(false)
        if (refreshAgain.current) { refreshAgain.current = false; void load() }
      }
    }
  }

  const loadSubagents = useCallback(async (): Promise<void> => {
    if (!subagentsAllowed) return
    try {
      const runs = await client.subagents(sessionId)
      if (alive.current) setSubagents(runs)
    } catch { }
  }, [client, sessionId, subagentsAllowed])

  useEffect(() => {
    alive.current = true
    followBottom.current = true
    void load()
    const unsubscribe = onSessionEvent(sessionId, (kinds) => {
      if (kinds.has('messages')) void load()
      if (kinds.has('subagents')) void loadSubagents()
    })
    return () => { alive.current = false; unsubscribe() }
  }, [load, loadSubagents, onSessionEvent, sessionId])

  useEffect(() => { void loadSubagents() }, [loadSubagents])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text && !photos.length) return
    setSending(true)
    const fingerprint = `${text}\n${photos.map((photo) => photo.id).join(',')}`
    const key = sendAttempt.current?.text === fingerprint ? sendAttempt.current.key : idempotencyKey()
    sendAttempt.current = { text: fingerprint, key }
    try {
      await client.send(sessionId, text, key, photos.length ? photos.map(({ mimeType, data }) => ({ mimeType, data })) : undefined)
      sendAttempt.current = null
      onDraftChange('')
      onPhotosChange([])
      followBottom.current = true
      void load()
    } catch (err) {
      if (!(err instanceof RemoteHttpError) || err.status !== 0) sendAttempt.current = null
      setError(err instanceof RemoteHttpError ? err.message : '没发出去，请重试')
    } finally {
      setSending(false)
    }
  }

  const addPhotos = async () => {
    if (picking || sending || photos.length >= 4) return
    if (!info?.capabilities.includes('send-images')) { Alert.alert('请更新电脑端', '新版电脑端支持图片发送。'); return }
    if (model?.input && !model.input.includes('image')) { setError('当前模型不支持图片，请先切换模型'); return }
    setPicking(true); setError(null)
    try { const selected = await pickImages(4 - photos.length); if (selected?.length) onPhotosChange([...photos, ...selected].slice(0, 4)) }
    catch (err) { setError(err instanceof Error ? err.message : '无法读取图片') }
    finally { setPicking(false) }
  }

  const abort = async (runId: string): Promise<void> => {
    setAborting(true)
    const key = abortAttempt.current?.runId === runId ? abortAttempt.current.key : idempotencyKey()
    abortAttempt.current = { runId, key }
    try {
      await client.abort(runId, key)
      abortAttempt.current = null
      await refresh()
    } catch (err) {
      if (!(err instanceof RemoteHttpError) || err.status !== 0) abortAttempt.current = null
      setError(err instanceof Error ? err.message : '中止请求没发出去，请重试')
    } finally { setAborting(false) }
  }

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: p.bg0 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={tabletop ? { height: tabletop.top } : { flex: 1 }}>
      <Header
        title={title || '会话'}
        left={onToggleSidebar ? <IconButton name="sidebar-left" label={sidebarVisible ? '收起项目和会话列表' : '展开项目和会话列表'} onPress={onToggleSidebar} /> : <IconButton name="back" label="返回会话列表" onPress={onBack} />}
        subtitle={`${cwdName} · ${info?.computer?.name || client.connection.computerName || STATUS_TEXT[stream]}`}
      />
      {(loading || sending) && !runner?.running ? <View style={styles.loading}><GlyphSpinner /><Text style={{ color: p.fgDim, fontSize: font.sm, fontFamily: mono }}>{sending ? '正在发送' : '正在读取会话'}</Text></View> : null}
      {error ? <Text style={[styles.error, { color: p.err, backgroundColor: p.errSoft, borderLeftColor: p.err }]}>{error}</Text> : null}
      <FlatList
        ref={listRef}
        contentContainerStyle={styles.list}
        data={timeline}
        keyExtractor={(item) => item.key}
        initialNumToRender={8}
        maxToRenderPerBatch={6}
        windowSize={5}
        updateCellsBatchingPeriod={60}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        viewabilityConfig={viewability}
        onViewableItemsChanged={onViewable}
        ListHeaderComponent={hasOlder ? <View style={{ height: 28, alignItems: 'center', justifyContent: 'center' }}>{loadingOlder ? <RunDot label="读取更早消息" /> : null}</View> : limitedOlder ? <Meta style={{ textAlign: 'center' }}>更早记录在电脑查看</Meta> : null}
        onScrollBeginDrag={({ nativeEvent }) => {
          scrollGesture.current = true
          userScrolled.current = true
          if (nativeEvent.contentOffset.y < 80) { topArmed.current = false; void loadOlder() }
        }}
        onScrollEndDrag={() => { scrollGesture.current = false }}
        onMomentumScrollBegin={() => { scrollGesture.current = true }}
        onMomentumScrollEnd={() => { scrollGesture.current = false; readLatest() }}
        onScroll={({ nativeEvent }) => {
          const { contentOffset, contentSize, layoutMeasurement } = nativeEvent
          if (scrollGesture.current) {
            followBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 96
            setAwayFromBottom(!followBottom.current)
          }
          if (contentOffset.y > 160) topArmed.current = true
          if (userScrolled.current && scrollGesture.current && contentOffset.y < 80 && topArmed.current && !loading) { topArmed.current = false; void loadOlder() }
          if (followBottom.current) readLatest()
        }}
        scrollEventThrottle={100}
        onLayout={({ nativeEvent }) => { listSize.current.viewport = nativeEvent.layout.height; requestAnimationFrame(() => snapBottom()) }}
        onContentSizeChange={(_, height) => { listSize.current.content = height; requestAnimationFrame(() => snapBottom()) }}
        ListEmptyComponent={<EmptyState>{loading ? '正在读取会话…' : '输入消息，开始这段会话'}</EmptyState>}
        ListFooterComponent={
          showPending && pending.length > 0 ? (
            <View style={styles.pending}>
              {pending.map((question) => (
                <QuestionCard
                  key={question.id}
                  question={question}
                  onAnswer={(answer, key) => client.answer(question.id, answer, key).finally(() => refresh())}
                />
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          if (item.kind === 'process') {
            const expanded = expandedTools.includes(item.key)
            const live = item.key === liveKey
            const parts = [item.thinking ? `${item.thinking} 段思考` : '', item.actions ? `${item.actions} 次操作` : ''].filter(Boolean).join(' · ')
            const shown = expanded ? item.steps : live ? item.steps.slice(-LIVE_STEPS) : []
            return <View style={styles.process}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`过程，${parts}${item.failed ? `，${item.failed} 项失败` : ''}，${expanded ? '收起' : '展开'}`} onPress={() => toggleExpanded(item.key)} style={styles.processHead}>
                {live ? <GlyphSpinner /> : null}
                <Text style={{ color: p.fgMute, fontSize: font.sm }}>{parts}</Text>
                {item.failed ? <Text style={{ color: p.err, fontSize: font.sm }}>· {item.failed} 项失败</Text> : null}
                <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}><Icon name="chevron-right" size={icon.sm} color={p.fgMute} /></View>
              </Pressable>
              {shown.length ? <View style={[styles.steps, { borderLeftColor: p.borderSoft }]}>
                {live && !expanded && item.steps.length > LIVE_STEPS ? <Meta>前面还有 {item.steps.length - LIVE_STEPS} 步</Meta> : null}
                {shown.map((step) => {
                  if (step.kind === 'text') return <Text key={step.key} selectable style={{ color: p.fgDim, fontSize: font.sm, lineHeight: 20 }}>{step.message.text?.trim() || step.message.error}</Text>
                  const open = expandedTools.includes(step.key)
                  if (step.kind === 'thinking') return <View key={step.key}>
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => toggleExpanded(step.key)} style={styles.toolRow}>
                      <Icon name="sparkles" size={icon.sm} color={p.fgMute} />
                      <Text numberOfLines={open ? undefined : 1} style={{ flex: 1, minWidth: 0, color: p.fgMute, fontSize: font.sm }}>{open ? step.text : `思考${step.ms ? ` ${Math.max(1, Math.round(step.ms / 1000))} 秒` : ''} · ${step.text.split('\n')[0]}`}</Text>
                    </Pressable>
                  </View>
                  const tool = step.tool
                  return <View key={step.key}>
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${tool.name} ${tool.summary}`} disabled={!tool.output} onPress={() => toggleExpanded(step.key)} style={[styles.toolRow, tool.nested ? { paddingLeft: space[4] } : null]}>
                      {tool.running || (live && tool.awaiting && !tool.failed && !tool.denied) ? <GlyphSpinner /> :<Text style={[styles.toolMark, { color: tool.failed ? p.err : p.fgMute }]}>{tool.failed ? '✕' : tool.denied ? '–' : '✓'}</Text>}
                      <Text numberOfLines={open ? undefined : 1} style={{ flex: 1, minWidth: 0, color: tool.failed ? p.err : p.fgDim, fontSize: font.sm }}>{tool.name}{tool.summary ? <Text style={{ color: p.fgMute, fontFamily: mono, fontSize: font.xs }}>  {tool.summary}</Text> : null}</Text>
                    </Pressable>
                    {open ? <Text selectable style={[styles.output, { color: p.fgDim, backgroundColor: p.sunken }]}>{tool.output.length > 4000 ? `…${tool.output.slice(-4000)}` : tool.output}</Text> : null}
                  </View>
                })}
              </View> : null}
            </View>
          }
          const message = item.message
          if (message.role === 'bash' && message.bash) {
            const failed = message.bash.exitCode !== null && message.bash.exitCode !== 0
            const open = expandedTools.includes(message.id)
            return <View style={styles.process}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => toggleExpanded(message.id)} style={styles.processHead}>
                <Text numberOfLines={open ? undefined : 2} style={{ color: failed ? p.err : p.fgDim, fontSize: font.sm, fontFamily: mono }}>$ {message.bash.command}{message.bash.cancelled ? '  （已取消）' : failed ? `  （退出码 ${message.bash.exitCode}）` : ''}</Text>
              </Pressable>
              {open && message.text ? <Text selectable style={[styles.output, { color: p.fgDim, backgroundColor: p.sunken }]}>{message.text.length > 4000 ? `…${message.text.slice(-4000)}` : message.text}</Text> : null}
            </View>
          }
          const mine = message.role === 'user'
          return (
            <View style={mine ? [styles.bubble, { backgroundColor: p.bubble }] : styles.message}>
              <View style={styles.messageMain}>
              {message.text ? <MessageBody text={message.text} /> : null}
              {message.images?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{message.images.map((_, index) => <RemoteImage key={index} client={client} accessibilityLabel={`消息图片 ${index + 1}`} source={client.imageSource(sessionId, message.id, index)} resizeMode="contain" style={{ width: 144, height: 144, borderRadius: radius.md, backgroundColor: p.bg1 }} />)}</View> : null}
              {message.error ? <Text style={[styles.meta, { color: p.err }]}>{message.error}</Text> : null}
              {(message.artifacts ?? []).map((artifact) => (
                <Pressable
                  key={artifact.id}
                  accessibilityRole="button"
                  disabled={artifact.unavailable}
                  onPress={() => onOpenArtifact(artifact)}
                  style={[styles.artifact, { borderColor: p.border, opacity: artifact.unavailable ? 0.5 : 1 }]}
                >
                  <Text numberOfLines={1} style={{ color: p.fg, fontSize: font.sm }}>{artifact.version && artifact.version > 1 ? `${artifact.filename} · v${artifact.version}` : artifact.filename}</Text>
                  <Meta>{artifact.unavailable ? '文件已不可用' : `${Math.max(1, Math.round(artifact.bytes / 1024))} KB`}</Meta>
                </Pressable>
              ))}
              </View>
            </View>
          )
        }}
      />
      </View>
      {tabletop ? <View style={{ height: tabletop.gap }} /> : null}
      <View style={tabletop ? { flex: 1, justifyContent: 'flex-end' } : undefined}>
      <View style={[styles.composer, { backgroundColor: p.bg0 }]}>
        {awayFromBottom && unread.has(sessionId) ? <Pressable accessibilityRole="button" onPress={() => { followBottom.current = true; snapBottom(true); readLatest() }} style={{ alignSelf: 'center', minHeight: touch.min, justifyContent: 'center', paddingHorizontal: space[4] }}><Text style={{ color: p.accent, fontSize: font.sm }}>新回复 ↓</Text></Pressable> : null}
        {photos.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{photos.map((photo, index) => <View key={photo.id} style={{ width: 72, height: 72 }}><Image accessibilityLabel={`待发送图片 ${index + 1}`} source={{ uri: `data:${photo.mimeType};base64,${photo.data}` }} style={{ width: 72, height: 72, borderRadius: radius.md }} /><Pressable disabled={sending} accessibilityLabel={`移除图片 ${index + 1}`} accessibilityRole="button" onPress={() => onPhotosChange(photos.filter((entry) => entry.id !== photo.id))} style={{ position: 'absolute', top: -4, right: -4, width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'flex-start', padding: 3 }}><View style={{ backgroundColor: p.bg1, borderRadius: 12, padding: 3 }}><Icon name="close" size={icon.sm} color={p.fg} /></View></Pressable></View>)}</View> : null}
        {runner?.waiting || pending.length ? <ActivityLine state="wait" text={STATUS_TEXT.wait} /> : runner?.running && !runInList ? <ActivityLine state="run" text={STATUS_TEXT.run} /> : stream !== 'open' ? <ActivityLine state="offline" text={STATUS_TEXT[stream]} /> : null}
        {subagents.length ? <SubagentCard runs={subagents} /> : null}
        {plan ? <PlanCard todos={plan.todos} stale={plan.stale} running={!!runner?.running} /> : null}
        <View style={[styles.inputFrame, { backgroundColor: p.surface, borderColor: p.border }]}>
        <TextInput
          disableFullscreenUI
          style={[styles.input, { color: p.fg }]}
          value={draft}
          editable={!sending}
          onChangeText={onDraftChange}
          placeholder={runner?.running ? '补充指令…' : '描述要构建、修改或修复的内容'}
          placeholderTextColor={p.fgMute}
          multiline
          accessibilityLabel="消息内容"
        />
        <View style={styles.composerActions}>
          <IconButton name="plus" label="添加图片" busy={picking} disabled={!capabilityAllowed(info, 'send-images') || sending || photos.length >= 4 || voicePhase !== 'idle'} onPress={() => void addPhotos()} />
          <SpeechInputButton onText={(text) => onDraftChange(draft.trim() ? `${draft.trimEnd()} ${text}` : text)} onError={setVoiceError} onStateChange={setVoicePhase} disabled={sending} transcribe={capabilityAllowed(info, 'voice-transcribe') ? (wav) => client.transcribe(wav) : undefined} />
          {voicePhase !== 'idle' ? <Text accessibilityLiveRegion="polite" numberOfLines={1} style={[styles.flex, { color: p.accent, fontSize: font.xs }]}>{voicePhase === 'listening' ? '正在听…' : voicePhase === 'processing' ? '转写中…' : '准备中…'}</Text> : <>
            <View accessibilityLabel={`工作目录 ${cwdName}`} style={styles.chip}><Icon name="folder" size={icon.sm} color={p.fgMute} /><Text numberOfLines={1} style={{ flexShrink: 1, color: p.fgDim, fontSize: font.sm }}>{cwdName}</Text></View>
            <View style={styles.flex} />
            <Pressable accessibilityRole="button" accessibilityLabel={`选择模型，当前 ${model?.name || model?.id || '电脑模型'}`} disabled={sending} onPress={() => { if (info?.capabilities.includes('models')) setModelPicker(true); else Alert.alert('请更新电脑端', '新版电脑端支持模型选择。') }} style={[styles.chip, { minHeight: touch.min }]}><Text numberOfLines={1} style={{ flexShrink: 1, color: p.fgDim, fontSize: font.sm }}>{model?.name || model?.id || sessions.find((session) => session.id === sessionId)?.model || '模型'}</Text><View style={{ transform: [{ rotate: '90deg' }] }}><Icon name="chevron-right" size={icon.sm} color={p.fgMute} /></View></Pressable>
          </>}
          {runner?.running ? (
            <IconButton name="stop" label="停止当前运行" busy={aborting} disabled={!capabilityAllowed(info, 'abort')} onPress={() => void abort(runner.runId)} />
          ) : null}
          <IconButton name="send" label="发送消息" primary busy={sending} disabled={!capabilityAllowed(info, 'send') || (!draft.trim() && !photos.length) || stream !== 'open' || voicePhase !== 'idle' || picking} onPress={() => void send()} />
        </View>
        </View>
        {voiceError ? <Text accessibilityLiveRegion="polite" style={[styles.voiceError, { color: p.err }]}>{voiceError}</Text> : null}
      </View>
      </View>
      <ModelPicker sessionId={sessionId} visible={modelPicker} onClose={() => setModelPicker(false)} onChanged={setSelectedModel} />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { paddingHorizontal: space[4], paddingTop: space[4], paddingBottom: space[5], gap: space[4] },
  error: { fontSize: font.sm, paddingHorizontal: space[4], paddingVertical: space[2], borderLeftWidth: 2 },
  loading: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[4] },
  message: { flexDirection: 'row', gap: space[2], maxWidth: '100%' },
  bubble: { alignSelf: 'flex-end', maxWidth: '86%', flexDirection: 'row', borderRadius: radius.bubble, paddingHorizontal: space[3], paddingVertical: space[2] },
  messageMain: { flexShrink: 1, minWidth: 0, gap: space[1], alignItems: 'flex-start' },
  meta: { fontSize: font.xs },
  process: { alignSelf: 'stretch' },
  processHead: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: space[1], alignSelf: 'flex-start' },
  steps: { borderLeftWidth: 1, marginLeft: space[1], paddingLeft: space[3], gap: space[1], paddingVertical: space[1] },
  toolRow: { minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  toolMark: { width: 14, textAlign: 'center', fontSize: font.xs },
  output: { fontFamily: mono, fontSize: font.xs, lineHeight: 17, borderRadius: radius.md, padding: space[2], marginVertical: space[1] },
  artifact: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[2], gap: 2, maxWidth: '92%' },
  pending: { marginTop: space[4] },
  composer: { paddingHorizontal: space[3], paddingTop: space[2], paddingBottom: space[3], gap: space[2] },
  inputFrame: { minWidth: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.xl, paddingHorizontal: space[1], paddingTop: space[1] },
  input: { minWidth: 0, minHeight: touch.min, maxHeight: 160, paddingHorizontal: space[3], paddingTop: space[3], paddingBottom: space[1], fontSize: font.body, textAlignVertical: 'top' },
  composerActions: { flexDirection: 'row', alignItems: 'center' },
  chip: { flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space[1] },
  voiceError: { fontSize: font.sm, lineHeight: 19 },
  flex: { flex: 1 }
})
