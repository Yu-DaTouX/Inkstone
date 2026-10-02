import { RemoteImage } from '../components/RemoteImage'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AppState, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, type ViewToken } from 'react-native'
import { idempotencyKey, RemoteHttpError, type HistoryMessage } from '../api/client'
import { QuestionCard } from '../components/QuestionCard'
import { MessageBody } from '../components/MessageBody'
import { SpeechInputButton } from '../components/SpeechInputButton'
import { useRemote } from '../state'
import { font, icon, mono, radius, space, touch, usePalette } from '../theme'
import { EmptyState, Header, IconButton, Meta, RunBar, STATUS_TEXT, StatusDot } from '../ui'
import { Icon } from '../icons'
import { RunDot, Spinner } from '../motion'
import type { SpeechPhase } from '../speech'
import { mergeRecentHistory } from '../historyCache'
import { pickImages, type PhotoDraft } from '../device'
import { ModelPicker } from '../components/ModelPicker'
import type { RemoteModel } from '../../../src/shared/remote-protocol'

type TimelineEntry = { kind: 'message'; key: string; message: HistoryMessage } | { kind: 'tools'; key: string; tools: Array<{ name: string; failed: boolean }> }

function makeTimeline(messages: HistoryMessage[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const tools = new Map<string, { name: string; failed: boolean }>()
  let firstToolMessage = ''
  const flushTools = () => {
    if (!tools.size) return
    const values = [...tools.values()]
    entries.push({ kind: 'tools', key: `tools-${firstToolMessage}`, tools: values })
    tools.clear()
    firstToolMessage = ''
  }
  for (const message of messages) {
    if (message.role === 'user') flushTools()
    for (const [index, tool] of (message.toolCalls ?? []).entries()) {
      if (!firstToolMessage) firstToolMessage = message.id
      const key = tool.id || `${message.id}:${index}`
      const old = tools.get(key)
      tools.set(key, { name: tool.name || old?.name || '工具', failed: tool.status === 'error' || !!old?.failed })
    }
    if (message.role === 'assistant' && (message.text?.trim() || message.error || message.artifacts?.length)) flushTools()
    if (message.role === 'user' || message.text?.trim() || message.error || message.artifacts?.length) {
      entries.push({ kind: 'message', key: message.id, message })
    }
  }
  flushTools()
  return entries
}

/**
 * 一个会话：历史、这个会话里等你回答的问题、发送文字、中止运行。
 *
 * 发送带幂等键：弱网下点两次或自动重试，电脑只收到一次。
 * 历史只读电脑上的持久记录（不在手机上拼流式片段），事件到达时重新拉取。
 */
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
  const [messages, setMessages] = useState<HistoryMessage[]>(cached?.messages.filter((m) => m.role === 'user' || m.role === 'assistant') ?? [])
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
  const [sending, setSending] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voicePhase, setVoicePhase] = useState<SpeechPhase>('idle')
  const [expandedTools, setExpandedTools] = useState<string[]>([])
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
  const snapBottom = (animated = false) => {
    if (alive.current && followBottom.current && listSize.current.viewport > 0) listRef.current?.scrollToOffset({ offset: Math.max(0, listSize.current.content - listSize.current.viewport), animated })
  }
  const model = selectedModel ?? runner?.model
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
        const merged = mergeRecentHistory(rawHistory.current, history.messages)
        rawHistory.current = merged.messages
        setMessages(merged.messages.filter((message) => message.role === 'user' || message.role === 'assistant'))
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
      setMessages(unique.filter((message) => message.role === 'user' || message.role === 'assistant'))
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

  useEffect(() => {
    alive.current = true
    followBottom.current = true
    void load()
    const unsubscribe = onSessionEvent(sessionId, () => void load())
    return () => { alive.current = false; unsubscribe() }
  }, [load, onSessionEvent, sessionId])

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
        left={<IconButton name="back" label="返回会话列表" onPress={onBack} />}
        subtitle={`${sessions.find((s) => s.id === sessionId)?.cwdName || '电脑工作目录'} · ${info?.computer?.name || client.connection.computerName || STATUS_TEXT[stream]}`}
        right={onToggleSidebar ? <IconButton name="sidebar-left" label={sidebarVisible ? '收起项目和会话列表' : '展开项目和会话列表'} onPress={onToggleSidebar} /> : undefined}
      />
      {(loading || sending) && !runner?.running ? <View style={styles.loading}><Spinner label={sending ? '正在发送' : '正在读取会话'} /><Text style={{ color: p.fgDim, fontSize: font.sm }}>{sending ? '正在发送' : '正在读取会话'}</Text></View> : null}
      {error ? <Text style={[styles.error, { color: p.err, backgroundColor: p.errSoft }]}>{error}</Text> : null}
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
          if (item.kind === 'tools') {
            const expanded = expandedTools.includes(item.key)
            const hidden = item.tools.length >= 7 && !expanded ? item.tools.length - 4 : 0
            const failed = item.tools.filter((tool) => tool.failed).length
            return <View style={[styles.toolSummary, { backgroundColor: p.bg1, borderColor: p.borderSoft }]}>
              <View style={styles.toolHeading}><Text style={{ flex: 1, color: p.fgDim, fontSize: font.sm }}>工具调用 · {item.tools.length}</Text>{failed ? <Text style={{ color: p.err, fontSize: font.xs }}>失败 {failed}</Text> : null}</View>
              {hidden > 0 ? <Pressable accessibilityRole="button" accessibilityLabel={`展开较早的 ${hidden} 次工具调用`} onPress={() => setExpandedTools((current) => [...current, item.key])} style={styles.toolFold}><Text style={{ color: p.fgMute, fontSize: font.sm }}>较早的 {hidden} 步 · 展开</Text></Pressable> : null}
              {item.tools.slice(hidden).map((tool, index) => <View key={`${item.key}:${index + hidden}`} style={[styles.toolRow, { borderTopColor: p.borderSoft }]}><StatusDot color={tool.failed ? p.err : p.ok} /><Text numberOfLines={1} style={{ flex: 1, color: p.fg, fontSize: font.sm, fontFamily: mono }}>{tool.name}</Text><Text style={{ color: tool.failed ? p.err : p.fgMute, fontSize: font.xs }}>{tool.failed ? '失败' : '完成'}</Text></View>)}
              {item.tools.length >= 7 && expanded ? <Pressable accessibilityRole="button" accessibilityLabel="收起较早的工具调用" onPress={() => setExpandedTools((current) => current.filter((key) => key !== item.key))} style={styles.toolFold}><Text style={{ color: p.fgMute, fontSize: font.sm }}>收起较早步骤</Text></Pressable> : null}
            </View>
          }
          const message = item.message
          const mine = message.role === 'user'
          return (
            <View style={[styles.message, mine ? [styles.mine, { backgroundColor: p.bg2, borderColor: p.borderSoft }] : null]}>
              {mine ? <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.prompt, { color: p.accent }]}>›</Text> : null}
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
                  style={[styles.artifact, { borderColor: p.border, backgroundColor: p.bg1, opacity: artifact.unavailable ? 0.5 : 1 }]}
                >
                  <Text numberOfLines={1} style={{ color: p.fg, fontSize: font.sm }}>{artifact.filename}</Text>
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
      <View style={[styles.composer, { borderTopColor: p.borderSoft, backgroundColor: p.bg1 }]}>
        {awayFromBottom && unread.has(sessionId) ? <Pressable accessibilityRole="button" onPress={() => { followBottom.current = true; snapBottom(true); readLatest() }} style={{ alignSelf: 'center', minHeight: touch.min, justifyContent: 'center', paddingHorizontal: space[4] }}><Text style={{ color: p.accent, fontSize: font.sm }}>新回复 ↓</Text></Pressable> : null}
        {photos.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{photos.map((photo, index) => <View key={photo.id} style={{ width: 72, height: 72 }}><Image accessibilityLabel={`待发送图片 ${index + 1}`} source={{ uri: `data:${photo.mimeType};base64,${photo.data}` }} style={{ width: 72, height: 72, borderRadius: radius.md }} /><Pressable disabled={sending} accessibilityLabel={`移除图片 ${index + 1}`} accessibilityRole="button" onPress={() => onPhotosChange(photos.filter((entry) => entry.id !== photo.id))} style={{ position: 'absolute', top: -4, right: -4, width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'flex-start', padding: 3 }}><View style={{ backgroundColor: p.bg1, borderRadius: 12, padding: 3 }}><Icon name="close" size={icon.sm} color={p.fg} /></View></Pressable></View>)}</View> : null}
        {runner?.waiting || pending.length ? <RunBar mode="wait" /> : runner?.running ? <RunBar mode="run" /> : stream !== 'open' ? <RunBar mode="offline" text={STATUS_TEXT[stream]} /> : null}
        <View style={[styles.inputFrame, { backgroundColor: p.bg0, borderColor: p.border }]}>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.prompt, { color: p.accent, paddingTop: space[3] }]}>›</Text>
        <TextInput
          disableFullscreenUI
          style={[styles.input, { color: p.fg }]}
          value={draft}
          editable={!sending}
          onChangeText={onDraftChange}
          placeholder={runner?.running ? '补充指令…' : '输入消息…'}
          placeholderTextColor={p.fgMute}
          multiline
          accessibilityLabel="消息内容"
        />
        </View>
        <View style={styles.composerActions}>
          <IconButton name="image" label="添加图片" busy={picking} disabled={sending || photos.length >= 4 || voicePhase !== 'idle'} onPress={() => void addPhotos()} />
          <SpeechInputButton onText={(text) => onDraftChange(draft.trim() ? `${draft.trimEnd()} ${text}` : text)} onError={setVoiceError} onStateChange={setVoicePhase} disabled={sending} />
          {voicePhase !== 'idle' ? <Text accessibilityLiveRegion="polite" numberOfLines={1} style={[styles.flex, { color: p.accent, fontSize: font.xs }]}>{voicePhase === 'listening' ? '正在听…' : voicePhase === 'processing' ? '转写中…' : '准备中…'}</Text> : <Pressable accessibilityRole="button" accessibilityLabel={`选择模型，当前 ${model?.name || model?.id || '电脑模型'}`} disabled={sending} onPress={() => { if (info?.capabilities.includes('models')) setModelPicker(true); else Alert.alert('请更新电脑端', '新版电脑端支持模型选择。') }} style={{ flex: 1, minWidth: 0, minHeight: touch.min, flexDirection: 'row', alignItems: 'center', gap: 4 }}><Text numberOfLines={1} style={{ flexShrink: 1, color: p.fgMute, fontSize: font.xs }}>{model?.name || model?.id || sessions.find((session) => session.id === sessionId)?.model || '模型'}</Text><View style={{ transform: [{ rotate: '90deg' }] }}><Icon name="chevron-right" size={icon.sm} color={p.fgMute} /></View></Pressable>}
          {runner?.running ? (
            <IconButton name="stop" label="停止当前运行" busy={aborting} onPress={() => void abort(runner.runId)} />
          ) : null}
          <IconButton name="send" label="发送消息" primary busy={sending} disabled={(!draft.trim() && !photos.length) || stream !== 'open' || voicePhase !== 'idle' || picking} onPress={() => void send()} />
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
  list: { paddingHorizontal: space[5], paddingTop: space[5], paddingBottom: space[6], gap: space[5] },
  error: { fontSize: font.sm, paddingHorizontal: space[4], paddingVertical: space[2] },
  loading: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[4] },
  message: { flexDirection: 'row', gap: space[2], maxWidth: '100%' },
  mine: { borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space[3], paddingVertical: space[2] },
  messageMain: { flex: 1, minWidth: 0, gap: space[1], alignItems: 'flex-start' },
  prompt: { fontFamily: mono, fontSize: font.body, lineHeight: 23 },
  meta: { fontSize: font.xs },
  toolSummary: { alignSelf: 'stretch', borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[3], gap: space[2] },
  toolHeading: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  toolFold: { minHeight: touch.min, justifyContent: 'center' },
  toolRow: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: space[2], borderTopWidth: StyleSheet.hairlineWidth },
  artifact: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[2], gap: 2, maxWidth: '92%' },
  pending: { marginTop: space[4] },
  composer: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[2], gap: space[2], borderTopWidth: StyleSheet.hairlineWidth },
  /*
   * `minWidth: 0` 不能省：Android 的 TextInput 在 row 里会按内容报一个很大的最小宽度，
   * 缺少它时输入框不随屏幕／键盘缩窄（与本文件其它 row 容器同一处理）。
   */
  inputFrame: { flexDirection: 'row', minWidth: 0, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], gap: space[2] },
  input: { flex: 1, minWidth: 0, minHeight: touch.min, maxHeight: 160, paddingVertical: space[3], fontSize: font.body, textAlignVertical: 'top' },
  composerActions: { flexDirection: 'row', gap: space[2], alignItems: 'center' },
  voiceError: { fontSize: font.sm, lineHeight: 19 },
  flex: { flex: 1 }
})
