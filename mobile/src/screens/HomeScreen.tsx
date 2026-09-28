import { useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { idempotencyKey, RemoteHttpError, type SessionListItem } from '../api/client'
import { QuestionCard } from '../components/QuestionCard'
import { Icon, BrandMark } from '../icons'
import { ContentEnter, LoadingBar } from '../motion'
import { useRemote } from '../state'
import { font, mono, radius, space, touch, usePalette } from '../theme'
import { EmptyState, IconButton, SectionTitle } from '../ui'

const STREAM_LABEL = { connecting: '连接中', open: '已连接', reconnecting: '重新连接中', closed: '已断开' } as const
const folderKey = (s: SessionListItem) => s.projectId || `folder:${s.cwdName?.trim() || '未分类'}`
const activityAt = (s: SessionListItem) => s.lastActivityAt ?? s.updatedAt
function timeAgo(at: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000))
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时` : `${Math.floor(minutes / 1440)} 天`
}

/** Projects are navigation; recent messages and live activity remain visible at the root. */
export function HomeScreen({ onOpen, onSettings, alertsEnabled, onEnableAlerts, selectedSessionId, project, onProjectChange }: {
  onOpen: (sessionId: string, title: string) => void
  onSettings: () => void
  alertsEnabled: boolean
  onEnableAlerts: () => void
  selectedSessionId?: string
  project: { id: string; name: string } | null
  onProjectChange: (project: { id: string; name: string } | null) => void
}) {
  const p = usePalette()
  const { sessions, questions, runners, activeSessionId, previews, stream, error, refresh, client, info, unread } = useRemote()
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const newAttempt = useRef<string | null>(null)
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; latest: number }>()
    for (const session of sessions) {
      const id = folderKey(session)
      const group = map.get(id) ?? { id, name: session.cwdName || '未分类', count: 0, latest: 0 }
      group.count++
      group.latest = Math.max(group.latest, activityAt(session))
      map.set(id, group)
    }
    return [...map.values()].sort((a, b) => b.latest - a.latest)
  }, [sessions])
  const activeIds = new Set(runners.filter((r) => r.running || r.waiting).map((r) => r.sessionId))
  for (const question of questions) if (question.sessionId) activeIds.add(question.sessionId)
  for (const id of unread) activeIds.add(id)
  const visible = [...sessions].filter((s) => (!project || folderKey(s) === project.id)
    && `${s.title} ${s.cwdName ?? ''} ${previews[s.id]?.text ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => activityAt(b) - activityAt(a))
  const active = visible.filter((s) => activeIds.has(s.id))
  const titleOf = (id: string | null) => sessions.find((s) => s.id === id)?.title ?? '会话'
  const renderSession = (session: SessionListItem, activity = false) => {
    const runner = runners.find((r) => r.sessionId === session.id)
    const waiting = runner?.waiting || questions.some((q) => q.sessionId === session.id)
    const current = session.id === activeSessionId || runner?.isActive
    return <Pressable accessibilityRole="button" accessibilityLabel={`${session.title}${waiting ? '，等待回答' : runner?.running ? '，运行中' : current ? '，电脑当前打开' : ''}`} onPress={() => onOpen(session.id, session.title)} style={({ pressed }) => [styles.session, { backgroundColor: selectedSessionId === session.id ? p.accentSoft : 'transparent', opacity: pressed ? 0.6 : 1 }]}>
      <View style={styles.rowMain}>
        <Text numberOfLines={1} style={{ color: p.fg, fontSize: font.body, fontWeight: '500' }}>{session.title || '未命名会话'}</Text>
        {activity ? <Text style={{ color: waiting ? p.warn : unread.has(session.id) ? p.accent : p.fgMute, fontSize: font.xs, fontFamily: mono }}>{waiting ? '等待回答' : runner?.running ? '模型正在工作' : '未读回复'} · {session.cwdName || '未分类'}</Text>
          : previews[session.id]?.text ? <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.sm }}>{previews[session.id].role === 'user' ? '你 › ' : '砚 › '}{previews[session.id].text}</Text> : !project ? <Text style={{ color: p.fgMute, fontSize: font.xs, fontFamily: mono }} numberOfLines={1}>{session.cwdName || '未分类'}</Text> : null}
      </View>
      {waiting ? <Icon name="bell" size={18} color={p.warn} /> : runner?.running ? <ActivityIndicator size="small" color={p.accent} /> : unread.has(session.id) ? <View accessibilityLabel="未读回复" style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.accent }} /> : <Text style={{ color: p.fgMute, fontSize: font.xs, fontFamily: mono }}>{timeAgo(activityAt(session))}</Text>}
    </Pressable>
  }
  const create = async () => {
    setCreating(true)
    const key = newAttempt.current ?? idempotencyKey()
    newAttempt.current = key
    try {
      const result = await client.newSession(key)
      newAttempt.current = null
      await refresh()
      if (result.sessionId) onOpen(result.sessionId, '新会话')
      else Alert.alert('电脑已接收', '新会话尚未返回，请在会话列表中查看。')
    } catch (err) {
      if (!(err instanceof RemoteHttpError) || err.status !== 0) newAttempt.current = null
      Alert.alert('创建失败', err instanceof Error ? err.message : '请稍后重试')
    } finally { setCreating(false) }
  }
  return <View style={[styles.root, { backgroundColor: p.bg0 }]}>
    <View style={[styles.header, { borderBottomColor: p.borderSoft }]}>
      {project ? <IconButton name="back" label="返回所有项目" onPress={() => { onProjectChange(null); setQuery('') }} /> : <View style={{ width: touch.min, alignItems: 'center' }}><BrandMark /></View>}
      <View style={styles.rowMain}>
        <Text accessibilityRole="header" style={{ color: p.fg, fontSize: font.lg, fontWeight: '600' }} numberOfLines={1}>{project?.name ?? '工作台'}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: stream === 'open' ? p.ok : p.warn }} />
          <Text accessibilityLabel={client.connection.baseUrl} numberOfLines={1} style={{ flexShrink: 1, color: p.fgMute, fontSize: font.xs, fontFamily: mono }}>{info?.computer?.name || client.connection.computerName || client.connection.baseUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '')}</Text>
          <Text style={{ color: p.fgMute, fontSize: font.xs }}>· {STREAM_LABEL[stream]}</Text>
        </View>
      </View>
      <IconButton name="settings" label="打开手机设置" onPress={onSettings} />
    </View>
    <LoadingBar active={refreshing || creating || stream === 'connecting' || stream === 'reconnecting'} />
    {error ? <Text style={[styles.error, { color: p.err, backgroundColor: p.errSoft }]}>{error}</Text> : null}
    <ContentEnter key={project?.id ?? 'root'}>
      <FlatList data={visible} keyExtractor={(s) => s.id} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)) }} tintColor={p.accent} />}
        ListHeaderComponent={<>
          {questions.length > 0 && !project ? <>
            <SectionTitle>等你回答 · {questions.length}</SectionTitle>
            {questions.map((q) => q.sessionId ? <Pressable key={q.id} accessibilityRole="button" onPress={() => onOpen(q.sessionId!, titleOf(q.sessionId))} style={[styles.question, { borderLeftColor: p.warn, backgroundColor: p.bg1 }]}>
              <Icon name="bell" color={p.warn} size={18} /><View style={styles.rowMain}><Text numberOfLines={2} style={{ color: p.fg, fontSize: font.base }}>{q.title || q.message || '砚需要你回答'}</Text><Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs }}>{titleOf(q.sessionId)}{q.sensitive ? ' · 需在电脑确认' : ''}</Text></View><Icon name="chevron-right" color={p.fgMute} size={16} />
            </Pressable> : <QuestionCard key={q.id} question={q} onAnswer={(answer, key) => client.answer(q.id, answer, key).finally(() => refresh())} />)}
          </> : null}
          {!project && !query ? <>
            <SectionTitle>活动会话{active.length ? ` · ${active.length}` : ''}</SectionTitle>
            {active.length ? active.map((s) => <View key={s.id}>{renderSession(s, true)}</View>) : <Text style={{ color: p.fgMute, fontSize: font.sm, paddingVertical: space[2] }}>{stream === 'open' ? '暂无活动' : '等待连接'}</Text>}
            <SectionTitle>项目</SectionTitle>
            {groups.map((group) => <Pressable key={group.id} accessibilityRole="button" onPress={() => { onProjectChange(group); setQuery('') }} style={({ pressed }) => [styles.folder, { opacity: pressed ? 0.6 : 1 }]}>
              <Icon name="folder" color={p.fgDim} size={22} /><Text numberOfLines={1} style={{ flex: 1, color: p.fg, fontSize: font.body }}>{group.name}</Text><Text style={{ color: p.fgMute, fontSize: font.xs, fontFamily: mono }}>{group.count}</Text><Icon name="chevron-right" color={p.fgMute} size={16} />
            </Pressable>)}
          </> : null}
          <SectionTitle>{query ? `搜索结果 · ${visible.length}` : project ? `会话 · ${visible.length}` : '最近'}</SectionTitle>
        </>}
        ListEmptyComponent={<EmptyState>{query ? '没有匹配的会话' : stream === 'open' ? '还没有会话' : '正在等待电脑的会话…'}</EmptyState>}
        renderItem={({ item }) => renderSession(item)} />
    </ContentEnter>
    {!alertsEnabled ? <Pressable accessibilityRole="button" onPress={onEnableAlerts} style={styles.alertPrompt}><Icon name="bell" color={p.accent} size={16} /><Text style={{ color: p.accent, fontSize: font.sm }}>开启待回答提醒</Text></Pressable> : null}
    <View style={[styles.dock, { borderTopColor: p.borderSoft, backgroundColor: p.bg1 }]}>
      <View style={[styles.search, { borderColor: p.border, backgroundColor: p.bg0 }]}><Icon name="search" size={18} color={p.fgMute} /><TextInput disableFullscreenUI value={query} onChangeText={setQuery} placeholder={project ? '搜索此项目' : '搜索会话'} placeholderTextColor={p.fgMute} accessibilityLabel="搜索会话" style={{ flex: 1, minHeight: touch.min, paddingVertical: 6, color: p.fg, fontSize: font.base, fontFamily: mono }} /></View>
      <IconButton name="pencil" primary label="新建会话" busy={creating} disabled={stream !== 'open'} onPress={() => Alert.alert('新建会话', '使用电脑当前目录，并切换电脑会话。', [{ text: '取消', style: 'cancel' }, { text: '新建', onPress: () => void create() }])} />
    </View>
  </View>
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[2], gap: space[2], borderBottomWidth: StyleSheet.hairlineWidth },
  rowMain: { flex: 1, gap: space[1], minWidth: 0 },
  list: { paddingHorizontal: space[4], paddingBottom: space[5] },
  session: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[2], paddingVertical: space[3], borderRadius: radius.sm },
  folder: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[2] },
  question: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderLeftWidth: 2, padding: space[3], marginBottom: space[2], borderRadius: radius.sm },
  error: { fontSize: font.sm, padding: space[3] },
  alertPrompt: { minHeight: touch.min, paddingHorizontal: space[4], flexDirection: 'row', alignItems: 'center', gap: space[2] },
  dock: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[4], paddingVertical: space[3], borderTopWidth: StyleSheet.hairlineWidth },
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], borderWidth: 1, borderRadius: radius.md }
})
