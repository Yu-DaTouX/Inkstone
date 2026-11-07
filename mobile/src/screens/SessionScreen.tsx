import { pick } from '../../../src/shared/ui-lang'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, AppState, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ViewToken } from 'react-native'
import { idempotencyKey, RemoteHttpError, type HistoryMessage, type HistoryPage, type SubagentInfo } from '../api/client'
import type { SessionDetail } from '../components/DetailPane'
import { QuestionCard } from '../components/QuestionCard'
import { QueuedMessages } from '../components/QueuedMessages'
import { TimelineRow } from '../components/TimelineRow'
import { SHOWN_ROLES, liveProcessKey, makeTimeline, reuseMessages, stabilizeTimeline, type ImageRef, type TimelineEntry } from '../timeline'
import { ImageViewer } from '../components/ImageViewer'
import { SpeechInputButton } from '../components/SpeechInputButton'
import { useRemote } from '../state'
import { font, icon, mono, radius, space, touch, usePalette, weight } from '../theme'
import { ActivityLine, EmptyState, Header, IconButton, Meta, STATUS_TEXT } from '../ui'
import { Icon } from '../icons'
import { GlyphSpinner, RunDot } from '../motion'
import type { SpeechPhase } from '../speech'
import { mergeRecentHistory } from '../historyCache'
import { useBottomInset } from '../insets'
import { pickImages, type PhotoDraft } from '../device'
import { ModelPicker } from '../components/ModelPicker'
import { RenameSheet } from '../components/RenameSheet'
import type { RemoteModel, RemoteSessionChanges, RemoteSessionStats } from '../../../src/shared/remote-protocol'
import { capabilityAllowed } from '../../../src/shared/capability-negotiation'

const REFRESH_WINDOW = 24
const INSIGHT_REFRESH_MS = 15_000
const NO_EXPANDED: readonly string[] = []

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
  sidebarVisible,
  onOpenDetail,
  detailOpen,
  onDetail,
  detailVisible,
  banner
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
  onOpenDetail?: () => void
  detailOpen?: boolean
  onDetail?: (detail: SessionDetail) => void
  detailVisible?: boolean
  banner?: ReactNode
}) {
  const p = usePalette()
  const bottomInset = useBottomInset()
  const { client, questions, runners, sessions, projects, stream, onSessionEvent, refresh, info, marksReady, markRead, unread, latestStats } = useRemote()
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
  const [queue, setQueue] = useState<HistoryPage['queue']>(cached?.queue)
  const [subagents, setSubagents] = useState<SubagentInfo[]>([])
  const subagentsAllowed = capabilityAllowed(info, 'subagents')
  const insightAllowed = capabilityAllowed(info, 'insight')
  const [stats, setStats] = useState<RemoteSessionStats | undefined>(() => latestStats(sessionId))
  const [changes, setChanges] = useState<RemoteSessionChanges | null>(null)
  const insightAt = useRef(0)
  const detailSeen = useRef(false)
  const [sending, setSending] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voicePhase, setVoicePhase] = useState<SpeechPhase>('idle')
  const [expandedTools, setExpandedTools] = useState<string[]>([])
  const [viewing, setViewing] = useState<(ImageRef & { label: string }) | null>(null)
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
  const [renaming, setRenaming] = useState(false)
  const [selectedModel, setSelectedModel] = useState<RemoteModel | null>(null)
  const [picking, setPicking] = useState(false)
  const sendAttempt = useRef<{ text: string; key: string } | null>(null)
  const abortAttempt = useRef<{ runId: string; key: string } | null>(null)
  const runner = runners.find((entry) => entry.sessionId === sessionId)
  const pending = questions.filter((question) => question.sessionId === sessionId)
  const timelineRef = useRef<TimelineEntry[]>([])
  const timeline = useMemo(() => (timelineRef.current = stabilizeTimeline(timelineRef.current, makeTimeline(messages))), [messages])
  const liveKey = liveProcessKey(timeline, !!runner?.running)
  const failedKey = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index--) {
      const entry = timeline[index]
      if (entry.kind !== 'message') continue
      if (entry.message.role === 'user') return null
      if (entry.message.error) return entry.key
    }
    return null
  }, [timeline])
  const draftRef = useRef(draft)
  draftRef.current = draft
  const compose = useCallback((text: string) => {
    const current = draftRef.current.trim()
    onDraftChange(current ? `${draftRef.current.trimEnd()}\n${text}` : text)
  }, [onDraftChange])
  const runInList = !!liveKey
  const snapBottom = (animated = false) => {
    if (alive.current && followBottom.current && listSize.current.viewport > 0) listRef.current?.scrollToOffset({ offset: Math.max(0, listSize.current.content - listSize.current.viewport), animated })
  }
  const snapFrame = useRef<number | null>(null)
  const scheduleSnap = () => {
    if (snapFrame.current !== null) return
    snapFrame.current = requestAnimationFrame(() => { snapFrame.current = null; snapBottom() })
  }
  useEffect(() => () => { if (snapFrame.current !== null) cancelAnimationFrame(snapFrame.current) }, [])
  const model = selectedModel ?? runner?.model
  const cwdName = sessions.find((s) => s.id === sessionId)?.cwdName || pick('电脑工作目录', 'Desktop working folder')
  useEffect(() => { if (runner?.model) setSelectedModel(runner.model) }, [runner?.model?.id, runner?.model?.provider])
  const latestReply = [...messages].reverse().find((message) => message.role === 'assistant' && message.text?.trim() && message.timestamp)
  const modelName = model?.name || model?.id || sessions.find((session) => session.id === sessionId)?.model || ''
  const artifacts = useMemo(() => {
    const byName = new Map<string, NonNullable<HistoryMessage['artifacts']>[number]>()
    for (const message of messages) for (const artifact of message.artifacts ?? []) byName.set(artifact.filename, artifact)
    return [...byName.values()]
  }, [messages])
  const todosLeft = plan?.todos.filter((todo) => !(todo.done || todo.status === 'done')).length ?? 0
  const liveSubagents = subagents.filter((run) => run.status === 'starting' || run.status === 'running').length
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
        let history = await client.history(sessionId, rawHistory.current.length > REFRESH_WINDOW ? REFRESH_WINDOW : 60)
        if (history.messages.length === REFRESH_WINDOW && rawHistory.current.length > REFRESH_WINDOW && !mergeRecentHistory(rawHistory.current, history.messages).retained) history = await client.history(sessionId, 60)
        if (!alive.current) return
        pagination.current = typeof history.hasMore === 'boolean'
        if (pagination.current) setLimitedOlder(false)
        setPlan((current) => (JSON.stringify(current) === JSON.stringify(history.plan) ? current : history.plan))
        setQueue((current) => (JSON.stringify(current) === JSON.stringify(history.queue) ? current : history.queue))
        const merged = mergeRecentHistory(rawHistory.current, history.messages)
        const reused = reuseMessages(rawHistory.current, merged.messages)
        if (reused !== rawHistory.current) {
          rawHistory.current = reused
          setMessages(reused.filter((message) => SHOWN_ROLES.has(message.role)))
        }
        if (!merged.retained) {
          moreRef.current = history.hasMore ?? history.messages.length === 60
          setHasOlder(moreRef.current)
          legacyLimit.current = 60
        }
        client.historyCache.set(sessionId, { ...history, messages: reused, hasMore: pagination.current ? moreRef.current : undefined })
        setError(null)
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : pick('读取失败', 'Load failed'))
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
      } else if (alive.current) setError(err instanceof Error ? err.message : pick('读取失败', 'Load failed'))
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
      if (alive.current) setSubagents((current) => (JSON.stringify(current) === JSON.stringify(runs) ? current : runs))
    } catch { }
  }, [client, sessionId, subagentsAllowed])

  const loadInsight = useCallback(async (): Promise<void> => {
    if (!insightAllowed) return
    insightAt.current = Date.now()
    try {
      const next = await client.insight(sessionId)
      if (!alive.current) return
      setStats((current) => next.stats ?? current)
      setChanges((current) => (JSON.stringify(current) === JSON.stringify(next.changes) ? current : next.changes))
    } catch { }
  }, [client, insightAllowed, sessionId])

  useEffect(() => {
    onDetail?.({ sessionId, plan, subagents, artifacts, running: !!runner?.running, model: modelName, stats, changes, reloadInsight: () => void loadInsight() })
  }, [onDetail, sessionId, plan, subagents, artifacts, runner?.running, modelName, stats, changes, loadInsight])
  const wasRunning = useRef(false)
  useEffect(() => {
    const running = !!runner?.running
    if (wasRunning.current && !running) void loadInsight()
    wasRunning.current = running
  }, [loadInsight, runner?.running])

  useEffect(() => { void loadInsight() }, [loadInsight])

  useEffect(() => {
    if (detailVisible && !detailSeen.current && Date.now() - insightAt.current > 4000) void loadInsight()
    detailSeen.current = !!detailVisible
  }, [detailVisible, loadInsight])

  const detailVisibleRef = useRef(detailVisible)
  detailVisibleRef.current = detailVisible

  useEffect(() => {
    alive.current = true
    followBottom.current = true
    void load()
    const unsubscribe = onSessionEvent(sessionId, (kinds) => {
      if (kinds.has('messages')) {
        void load()
        if (detailVisibleRef.current && Date.now() - insightAt.current > INSIGHT_REFRESH_MS) void loadInsight()
      }
      if (kinds.has('subagents')) void loadSubagents()
      if (kinds.has('stats')) {
        const live = latestStats(sessionId)
        if (live) setStats(live)
      }
    })
    return () => { alive.current = false; unsubscribe() }
  }, [latestStats, load, loadInsight, loadSubagents, onSessionEvent, sessionId])

  useEffect(() => { void loadSubagents() }, [loadSubagents])

  const retryFailed = useCallback(async () => {
    const at = rawHistory.current.findIndex((message) => message.id === failedKey)
    let text = ''
    for (let index = at - 1; index >= 0 && !text; index--) if (rawHistory.current[index].role === 'user') text = rawHistory.current[index].text?.trim() ?? ''
    if (!text) { setError(pick('找不到要重试的消息，请重新输入', 'Could not find the message to retry. Type it again.')); return }
    try {
      await client.send(sessionId, text, idempotencyKey())
      followBottom.current = true
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : pick('重试没发出去', 'Retry not sent'))
    }
  }, [client, failedKey, sessionId, load])
  const compactNow = useCallback(async () => {
    try {
      await client.compact(sessionId)
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : pick('压缩失败', 'Compaction failed'))
    }
  }, [client, sessionId, load])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text && !photos.length) return
    setSending(true)
    const fingerprint = `${text}\n${photos.map((photo) => photo.id).join(',')}`
    const key = sendAttempt.current?.text === fingerprint ? sendAttempt.current.key : idempotencyKey()
    sendAttempt.current = { text: fingerprint, key }
    try {
      await client.send(sessionId, text, key, photos.length ? photos.map(({ mimeType, data }) => ({ mimeType, data })) : undefined, runner?.running ? 'steer' : undefined)
      sendAttempt.current = null
      onDraftChange('')
      onPhotosChange([])
      followBottom.current = true
      void load()
    } catch (err) {
      if (!(err instanceof RemoteHttpError) || err.status !== 0) sendAttempt.current = null
      setError(err instanceof RemoteHttpError ? err.message : pick('没发出去，请重试', 'Not sent. Try again.'))
    } finally {
      setSending(false)
    }
  }

  const addPhotos = async () => {
    if (picking || sending || photos.length >= 4) return
    if (!info?.capabilities.includes('send-images')) { Alert.alert(pick('请更新电脑端', 'Update the desktop app'), pick('新版电脑端支持图片发送。', 'Newer desktop versions support sending images.')); return }
    if (model?.input && !model.input.includes('image')) { setError(pick('当前模型不支持图片，请先切换模型', 'This model does not support images. Switch models first.')); return }
    setPicking(true); setError(null)
    try { const selected = await pickImages(4 - photos.length); if (selected?.length) onPhotosChange([...photos, ...selected].slice(0, 4)) }
    catch (err) { setError(err instanceof Error ? err.message : pick('无法读取图片', 'Cannot read image')) }
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
      setError(err instanceof Error ? err.message : pick('中止请求没发出去，请重试', 'Stop request not sent. Try again.'))
    } finally { setAborting(false) }
  }

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: p.bg0 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={tabletop ? { height: tabletop.top } : { flex: 1 }}>
      <Header
        title={sessions.find((entry) => entry.id === sessionId)?.title || title || pick('会话', 'Session')}
        onTitleLongPress={capabilityAllowed(info, 'rename') ? () => setRenaming(true) : undefined}
        crumb={projects.find((project) => project.id === sessions.find((s) => s.id === sessionId)?.projectId)?.name || cwdName}
        left={onToggleSidebar ? <IconButton name="sidebar-left" selected={sidebarVisible} label={sidebarVisible ? pick('收起项目和会话列表', 'Hide project and session list') : pick('展开项目和会话列表', 'Show project and session list')} onPress={onToggleSidebar} /> : <IconButton name="back" label={pick('返回会话列表', 'Back to session list')} onPress={onBack} />}
        right={onOpenDetail ? <IconButton name="sidebar-right" selected={detailOpen} label={detailOpen ? pick('收起会话详情', 'Hide session details') : pick('打开会话详情', 'Open session details')} onPress={onOpenDetail} /> : undefined}
      />
      <View style={styles.flex}>
      {(loading || sending) && !runner?.running ? <View style={styles.loading}><GlyphSpinner /><Text style={{ color: p.fgDim, fontSize: font.sm, fontFamily: mono }}>{sending ? pick('正在发送', 'Sending') : pick('正在读取会话', 'Loading session')}</Text></View> : null}
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
        ListHeaderComponent={hasOlder ? <View style={{ height: 28, alignItems: 'center', justifyContent: 'center' }}>{loadingOlder ? <RunDot label={pick('读取更早消息', 'Loading earlier messages')} /> : null}</View> : limitedOlder ? <Meta style={{ textAlign: 'center' }}>{pick('更早记录在电脑查看', 'Earlier history is on the desktop')}</Meta> : null}
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
        onLayout={({ nativeEvent }) => { listSize.current.viewport = nativeEvent.layout.height; scheduleSnap() }}
        onContentSizeChange={(_, height) => { listSize.current.content = height; scheduleSnap() }}
        ListEmptyComponent={<EmptyState>{loading ? pick('正在读取会话…', 'Loading session…') : pick('输入消息，开始这段会话', 'Type a message to start')}</EmptyState>}
        ListFooterComponent={<>
          {runner?.running && !runInList ? <View style={styles.live}><GlyphSpinner /><Text style={{ color: p.accent, fontSize: font.sm }}>{pick('进行中', 'In progress')}</Text></View> : null}
          {showPending && !tabletop && pending.length > 0 ? (
            <View style={styles.pending}>
              {pending.map((question) => (
                <QuestionCard
                  key={question.id}
                  question={question}
                  onAnswer={(answer, key) => client.answer(question.id, answer, key).finally(() => refresh())}
                />
              ))}
            </View>
          ) : null}
        </>}
        renderItem={({ item }) => <TimelineRow item={item} live={item.key === liveKey} expandedTools={item.kind === 'process' || item.kind === 'notice' || item.message.role === 'bash' ? expandedTools : NO_EXPANDED} client={client} sessionId={sessionId} modelName={modelName} onToggle={toggleExpanded} onView={setViewing} onOpenArtifact={onOpenArtifact} onCompose={compose} onRetry={item.key === failedKey && !runner?.running && capabilityAllowed(info, 'send') ? retryFailed : undefined} onCompact={item.key === failedKey && !runner?.running && capabilityAllowed(info, 'compact') ? compactNow : undefined} />}
      />
      {banner ? <View style={StyleSheet.absoluteFill}>{banner}</View> : null}
      <ImageViewer client={client} source={viewing ? client.imageSource(sessionId, viewing.messageId, viewing.index) : null} label={viewing?.label ?? ''} onClose={() => setViewing(null)} />
      </View>
      </View>
      {tabletop ? <View style={{ height: tabletop.gap }} /> : null}
      <View style={tabletop ? { flex: 1, justifyContent: 'flex-end' } : undefined}>
      {tabletop && showPending && pending.length ? <ScrollView style={styles.deckQuestions} contentContainerStyle={{ gap: space[2], paddingHorizontal: space[3] }}>{pending.map((question) => <QuestionCard compact key={question.id} question={question} onAnswer={(answer, key) => client.answer(question.id, answer, key).finally(() => refresh())} />)}</ScrollView> : null}
      <View style={[styles.composer, { backgroundColor: p.bg0, paddingBottom: Math.max(space[2], bottomInset) }]}>
        {awayFromBottom && unread.has(sessionId) ? <Pressable accessibilityRole="button" onPress={() => { followBottom.current = true; snapBottom(true); readLatest() }} style={{ alignSelf: 'center', minHeight: touch.min, justifyContent: 'center', paddingHorizontal: space[4] }}><Text style={{ color: p.accent, fontSize: font.sm }}>{pick('新回复 ↓', 'New reply ↓')}</Text></Pressable> : null}
        {photos.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{photos.map((photo, index) => <View key={photo.id} style={{ width: 72, height: 72 }}><Image accessibilityLabel={pick(`待发送图片 ${index + 1}`, `Pending image ${index + 1}`)} source={{ uri: `data:${photo.mimeType};base64,${photo.data}` }} style={{ width: 72, height: 72, borderRadius: radius.md }} /><Pressable disabled={sending} accessibilityLabel={pick(`移除图片 ${index + 1}`, `Remove image ${index + 1}`)} accessibilityRole="button" onPress={() => onPhotosChange(photos.filter((entry) => entry.id !== photo.id))} style={{ position: 'absolute', top: -4, right: -4, width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'flex-start', padding: 3 }}><View style={{ backgroundColor: p.bg1, borderRadius: 12, padding: 3 }}><Icon name="close" size={icon.sm} color={p.fg} /></View></Pressable></View>)}</View> : null}
        {tabletop && pending.length ? null : runner?.waiting || pending.length ? <ActivityLine state="wait" text={STATUS_TEXT.wait} /> : stream !== 'open' ? <ActivityLine state="offline" text={STATUS_TEXT[stream]} /> : runner?.compacting ? <ActivityLine state="run" text={pick('正在压缩上下文', 'Compacting context')} /> : runner?.retry ? <ActivityLine state="run" text={pick(`模型请求失败，自动重试 ${runner.retry.attempt}/${runner.retry.maxAttempts}`, `Model request failed, retrying ${runner.retry.attempt}/${runner.retry.maxAttempts}`)} /> : null}
        {(todosLeft || subagents.length) && !(tabletop && pending.length) ? <Pressable accessibilityRole="button" accessibilityLabel={pick('查看计划与子代理', 'View plan and subagents')} disabled={!onOpenDetail} onPress={onOpenDetail} style={[styles.strip, { backgroundColor: p.bg3 }]}>
          {plan?.todos.length ? <Text style={{ color: p.fgDim, fontSize: font.sm }}>{pick('计划', 'Plan')} <Text style={{ color: p.fg, fontFamily: mono }}>{plan.todos.length - todosLeft}/{plan.todos.length}</Text></Text> : null}
          {subagents.length ? <View style={styles.stripItem}>{liveSubagents ? <GlyphSpinner /> : null}<Text style={{ color: p.fgDim, fontSize: font.sm }}>{pick('子代理', 'Subagents')} <Text style={{ color: p.fg, fontFamily: mono }}>{subagents.length}</Text></Text></View> : null}
          <View style={styles.flex} />
          {onOpenDetail ? <Icon name="chevron-right" size={icon.sm} color={p.fgMute} /> : null}
        </Pressable> : null}
        <QueuedMessages queue={queue} />
        <View style={[styles.inputFrame, { backgroundColor: p.surface, borderColor: p.borderSoft }]}>
        <TextInput
          disableFullscreenUI
          style={[styles.input, { color: p.fg }]}
          value={draft}
          editable={!sending}
          onChangeText={onDraftChange}
          placeholder={runner?.running ? pick('补充指令…', 'Add instructions…') : pick('描述要构建、修改或修复的内容', 'Describe what to build, change or fix')}
          placeholderTextColor={p.fgMute}
          multiline
          accessibilityLabel={pick('消息内容', 'Message')}
        />
        <View style={styles.composerActions}>
          <IconButton name="plus" label={pick('添加图片', 'Add image')} busy={picking} disabled={!capabilityAllowed(info, 'send-images') || sending || photos.length >= 4 || voicePhase !== 'idle'} onPress={() => void addPhotos()} />
          <SpeechInputButton onText={(text) => onDraftChange(draft.trim() ? `${draft.trimEnd()} ${text}` : text)} onError={setVoiceError} onStateChange={setVoicePhase} disabled={sending} transcribe={capabilityAllowed(info, 'voice-transcribe') ? (wav) => client.transcribe(wav) : undefined} />
          {voicePhase !== 'idle' ? <Text accessibilityLiveRegion="polite" numberOfLines={1} style={[styles.flex, { color: p.accent, fontSize: font.xs }]}>{voicePhase === 'listening' ? pick('正在听…', 'Listening…') : voicePhase === 'processing' ? pick('转写中…', 'Transcribing…') : pick('准备中…', 'Preparing…')}</Text> : <>
            <View style={styles.flex} />
            <Pressable accessibilityRole="button" accessibilityLabel={pick(`选择模型，当前 ${modelName || '电脑模型'}`, `Choose model, current ${modelName || 'desktop model'}`)} disabled={sending} onPress={() => { if (info?.capabilities.includes('models')) setModelPicker(true); else Alert.alert(pick('请更新电脑端', 'Update the desktop app'), pick('新版电脑端支持模型选择。', 'Newer desktop versions support model selection.')) }} style={[styles.chip, { minHeight: touch.min }]}><Text numberOfLines={1} style={{ flexShrink: 1, color: p.fg, fontSize: font.sm, fontWeight: weight.strong }}>{modelName || pick('模型', 'Model')}</Text></Pressable>
          </>}
          {runner?.running && !draft.trim() && !photos.length ? (
            <IconButton name="stop" label={pick('停止当前运行', 'Stop current run')} danger busy={aborting} disabled={!capabilityAllowed(info, 'abort')} onPress={() => void abort(runner.runId)} />
          ) : <IconButton name="send" label={pick('发送消息', 'Send message')} primary busy={sending} disabled={!capabilityAllowed(info, 'send') || (!draft.trim() && !photos.length) || stream !== 'open' || voicePhase !== 'idle' || picking} onPress={() => void send()} />}
        </View>
        </View>
        {voiceError ? <Text accessibilityLiveRegion="polite" style={[styles.voiceError, { color: p.err }]}>{voiceError}</Text> : null}
      </View>
      </View>
      <RenameSheet sessionId={sessionId} initial={sessions.find((entry) => entry.id === sessionId)?.title || title} visible={renaming} onClose={() => setRenaming(false)} />
      <ModelPicker sessionId={sessionId} running={!!runner?.running} visible={modelPicker} onClose={() => setModelPicker(false)} onChanged={setSelectedModel} />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[5], gap: space[4] },
  error: { fontSize: font.sm, paddingHorizontal: space[4], paddingVertical: space[2], borderLeftWidth: 2 },
  loading: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[4] },
  message: { flexDirection: 'row', gap: space[2], maxWidth: '100%' },
  bubble: { alignSelf: 'flex-end', maxWidth: '86%', flexDirection: 'row', borderRadius: radius.bubble, paddingHorizontal: space[3], paddingVertical: space[2] - 1 },
  metaLine: { fontSize: font.xs, fontFamily: mono, marginTop: space[1] },
  live: { flexDirection: 'row', alignItems: 'center', gap: space[1], marginTop: space[3] },
  strip: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[3], borderRadius: radius.lg },
  stripItem: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  deckQuestions: { flex: 1, marginTop: space[2] },
  messageMain: { flexShrink: 1, minWidth: 0, gap: space[1], alignItems: 'flex-start' },
  meta: { fontSize: font.xs },
  process: { alignSelf: 'stretch' },
  processHead: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[1], alignSelf: 'flex-start' },
  steps: { borderLeftWidth: 1, marginLeft: space[1], paddingLeft: space[3], gap: space[1], paddingVertical: space[1] },
  toolRow: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  toolMark: { width: 14, textAlign: 'center', fontSize: font.xs },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], paddingVertical: space[1] },
  thumb: { width: 96, height: 96, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  artifact: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[2], maxWidth: '100%' },
  pending: { marginTop: space[4] },
  composer: { paddingHorizontal: space[3], paddingTop: space[2], paddingBottom: space[3], gap: space[2] },
  inputFrame: { minWidth: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.composer, paddingHorizontal: space[1], paddingTop: space[1] },
  input: { minWidth: 0, minHeight: touch.min, maxHeight: 160, paddingHorizontal: space[3], paddingTop: space[3], paddingBottom: space[1], fontSize: font.body, textAlignVertical: 'top' },
  composerActions: { flexDirection: 'row', alignItems: 'center' },
  chip: { flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space[1] },
  voiceError: { fontSize: font.sm, lineHeight: 19 },
  flex: { flex: 1 }
})
