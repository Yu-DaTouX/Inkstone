import { LIFE_ASSISTANT_ENABLED } from '../features'
import { useMemo, useRef, useState } from 'react'
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { idempotencyKey, RemoteHttpError, type SessionListItem } from '../api/client'
import { QuestionCard } from '../components/QuestionCard'
import { Icon, BrandMark } from '../icons'
import { ContentEnter } from '../motion'
import { useRemote } from '../state'
import { font, icon, radius, space, touch, usePalette } from '../theme'
import { ActivityLine, EmptyState, Header, IconButton, Meta, SectionTitle, STATUS_TEXT, StatusDot } from '../ui'

const folderKey = (s: SessionListItem) => s.projectId || `folder:${s.cwdName?.trim() || '未分类'}`
const activityAt = (s: SessionListItem) => s.lastActivityAt ?? s.updatedAt
function timeAgo(at: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000))
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时` : `${Math.floor(minutes / 1440)} 天`
}

export function HomeScreen({ onOpen, onOpenAssistant, onSettings, alertsEnabled, onEnableAlerts, selectedSessionId, project, onProjectChange }: {
  onOpen: (sessionId: string, title: string) => void
  onOpenAssistant: () => void
  onSettings: () => void
  alertsEnabled: boolean
  onEnableAlerts: () => void
  selectedSessionId?: string
  project: { id: string; name: string } | null
  onProjectChange: (project: { id: string; name: string } | null) => void
}) {
  const p = usePalette()
  const { sessions, projects, questions, runners, activeSessionId, previews, stream, error, refresh, client, info, unread } = useRemote()
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [picker, setPicker] = useState(false)
  const newAttempt = useRef<string | null>(null)
  const groups = useMemo(() => {
    const known = new Set(projects.map((item) => item.id))
    const map = new Map<string, { id: string; name: string; cwd?: string; count: number; latest: number }>()
    for (const item of projects) map.set(item.id, { id: item.id, name: item.name, cwd: item.cwd, count: 0, latest: 0 })
    for (const session of sessions) {
      const id = session.projectId && known.has(session.projectId) ? session.projectId : folderKey(session)
      const group = map.get(id) ?? { id, name: session.cwdName || '未分类', count: 0, latest: 0 }
      group.count++
      group.latest = Math.max(group.latest, activityAt(session))
      map.set(id, group)
    }
    return [...map.values()].sort((a, b) => b.latest - a.latest)
  }, [projects, sessions])
  const groupOf = (s: SessionListItem) => (s.projectId && projects.some((item) => item.id === s.projectId) ? s.projectId : folderKey(s))
  const asking = new Set(questions.map((q) => q.sessionId).filter(Boolean))
  const runningIds = new Set(runners.filter((r) => r.running || r.waiting).map((r) => r.sessionId))
  const visible = [...sessions].filter((s) => (!project || groupOf(s) === project.id)
    && `${s.title} ${s.cwdName ?? ''} ${previews[s.id]?.text ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => activityAt(b) - activityAt(a))
  const active = visible.filter((s) => runningIds.has(s.id) && !asking.has(s.id))
  const recent = project || query ? visible : visible.filter((s) => !runningIds.has(s.id) && !asking.has(s.id))
  const realProject = project && projects.some((item) => item.id === project.id) ? project : null
  const titleOf = (id: string | null) => sessions.find((s) => s.id === id)?.title ?? '会话'
  const renderSession = (session: SessionListItem, activity = false) => {
    const runner = runners.find((r) => r.sessionId === session.id)
    const waiting = runner?.waiting || questions.some((q) => q.sessionId === session.id)
    const current = session.id === activeSessionId || runner?.isActive
    return <Pressable accessibilityRole="button" accessibilityLabel={`${session.title}${waiting ? `，${STATUS_TEXT.wait}` : runner?.running ? `，${STATUS_TEXT.run}` : current ? '，电脑当前打开' : ''}`} onPress={() => onOpen(session.id, session.title)} style={({ pressed }) => [styles.session, { backgroundColor: selectedSessionId === session.id ? p.bg3 : 'transparent', opacity: pressed ? 0.6 : 1 }]}>
      <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.glyph, { color: waiting ? p.warn : p.accent }]}>{waiting ? '◆' : runner?.running || unread.has(session.id) ? '●' : ' '}</Text>
      <View style={styles.rowMain}>
        <Text numberOfLines={1} style={{ color: p.fg, fontSize: font.body }}>{session.title || '未命名会话'}</Text>
        {activity ? <Meta numberOfLines={1} color={waiting ? p.warn : unread.has(session.id) ? p.accent : undefined}>{waiting ? STATUS_TEXT.wait : runner?.running ? STATUS_TEXT.run : '未读回复'} · {session.cwdName || '未分类'}</Meta>
          : previews[session.id]?.text ? <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.sm }}>{previews[session.id].role === 'user' ? '你：' : ''}{previews[session.id].text}</Text> : !project ? <Meta numberOfLines={1}>{session.cwdName || '未分类'}</Meta> : null}
      </View>
      <Meta>{timeAgo(activityAt(session))}</Meta>
    </Pressable>
  }
  const create = async (projectId?: string) => {
    setPicker(false)
    setCreating(true)
    const key = newAttempt.current ?? idempotencyKey()
    newAttempt.current = key
    try {
      const result = await client.newSession(projectId, key)
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
    <Header
      title={project?.name ?? 'Inkstone'}
      left={project ? <IconButton name="back" label="返回所有项目" onPress={() => { onProjectChange(null); setQuery('') }} /> : <View style={{ width: touch.min, alignItems: 'center' }}><BrandMark size={24} /></View>}
      right={<IconButton name="pencil" label={realProject ? `在 ${realProject.name} 新建会话` : '新建会话'} busy={creating} disabled={stream !== 'open'} onPress={() => (realProject ? void create(realProject.id) : setPicker(true))} />}
    />
    <View style={[styles.search, { backgroundColor: p.field, borderColor: p.borderSoft }]}><Icon name="search" size={icon.sm} color={p.fgMute} /><TextInput disableFullscreenUI value={query} onChangeText={setQuery} placeholder={project ? '搜索此项目' : '搜索'} placeholderTextColor={p.fgMute} accessibilityLabel="搜索会话" style={{ flex: 1, minWidth: 0, minHeight: 40, paddingVertical: 6, color: p.fg, fontSize: font.base }} /></View>
    {(refreshing || creating || stream === 'connecting' || stream === 'reconnecting') ? <View style={styles.activity}><ActivityLine state="run" text={creating ? '正在新建会话' : refreshing ? '正在刷新会话' : STATUS_TEXT[stream]} /></View> : null}
    {error ? <Text style={[styles.error, { color: p.err, backgroundColor: p.errSoft, borderLeftColor: p.err }]}>{/连接超时/.test(error) ? '连接超时，请检查电脑和 Tailscale。' : error}</Text> : null}
    <ContentEnter key={project?.id ?? 'root'}>
      <FlatList data={recent} keyExtractor={(s) => s.id} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}
        ListHeaderComponent={<>
          {questions.length > 0 && !project ? <>
            <SectionTitle>{STATUS_TEXT.wait} · {questions.length}</SectionTitle>
            {questions.map((q) => q.sessionId ? <Pressable key={q.id} accessibilityRole="button" onPress={() => onOpen(q.sessionId!, titleOf(q.sessionId))} style={[styles.question, { borderColor: p.warn }]}>
              <Icon name="bell" color={p.warn} size={icon.md} /><View style={styles.rowMain}><Text numberOfLines={2} style={{ color: p.fg, fontSize: font.base }}>{q.title || q.message || '砚需要你回答'}</Text><Meta numberOfLines={1}>{titleOf(q.sessionId)}{q.sensitive ? ' · 需在电脑确认' : ''}</Meta></View><Icon name="chevron-right" color={p.fgMute} size={icon.sm} />
            </Pressable> : <QuestionCard key={q.id} question={q} onAnswer={(answer, key) => client.answer(q.id, answer, key).finally(() => refresh())} />)}
          </> : null}
          {!project && !query ? <>
            {LIFE_ASSISTANT_ENABLED ? <>
            <SectionTitle>生活助手</SectionTitle>
            <Pressable accessibilityRole="button" accessibilityLabel="打开生活助手" onPress={onOpenAssistant} style={({ pressed }) => [styles.question, { borderColor: p.borderSoft, opacity: pressed ? 0.7 : 1 }]}>
              <Icon name="sparkles" color={p.accent} size={icon.md} />
              <View style={styles.rowMain}><Text style={{ color: p.fg, fontSize: font.base }}>直接在手机上与模型对话</Text><Meta numberOfLines={1}>无需配对电脑 · 密钥只存手机</Meta></View>
              <Icon name="chevron-right" color={p.fgMute} size={icon.sm} />
            </Pressable>
            </> : null}
            {active.length ? <>
              <SectionTitle>运行中 · {active.length}</SectionTitle>
              {active.map((s) => <View key={s.id}>{renderSession(s, true)}</View>)}
            </> : null}
            <SectionTitle>项目</SectionTitle>
            {groups.map((group) => <Pressable key={group.id} accessibilityRole="button" accessibilityLabel={`${group.name}${group.cwd ? `，${group.cwd}` : ''}`} onPress={() => { onProjectChange(group); setQuery('') }} style={({ pressed }) => [styles.folder, { opacity: pressed ? 0.6 : 1 }]}>
              <Icon name="folder" color={p.fgDim} size={icon.md} />
              <View style={styles.rowMain}><Text numberOfLines={1} style={{ color: p.fg, fontSize: font.body }}>{group.name}</Text>{group.cwd ? <Meta numberOfLines={1}>{group.cwd}</Meta> : null}</View>
              <Meta>{group.count}</Meta><Icon name="chevron-right" color={p.fgMute} size={icon.sm} />
            </Pressable>)}
          </> : null}
          <SectionTitle>{query ? `搜索结果 · ${visible.length}` : project ? `会话 · ${visible.length}` : '最近'}</SectionTitle>
        </>}
        ListEmptyComponent={<EmptyState>{query ? '没有匹配的会话' : stream === 'open' ? '还没有会话' : '正在等待电脑的会话…'}</EmptyState>}
        renderItem={({ item }) => renderSession(item)} />
    </ContentEnter>
    {!alertsEnabled ? <Pressable accessibilityRole="button" onPress={onEnableAlerts} style={styles.alertPrompt}><Icon name="bell" color={p.accent} size={icon.sm} /><Text style={{ color: p.accent, fontSize: font.sm }}>开启待回答提醒</Text></Pressable> : null}
    <View style={[styles.dock, { borderTopColor: p.borderSoft }]}>
      <StatusDot color={stream === 'open' ? p.ok : p.warn} label={STATUS_TEXT[stream]} />
      <Text accessibilityLabel={client.connection.baseUrl} numberOfLines={1} style={{ flexShrink: 1, color: p.fgDim, fontSize: font.sm }}>{info?.computer?.name || client.connection.computerName || client.connection.baseUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '')}</Text>
      <Meta>{STATUS_TEXT[stream]}</Meta>
      <View style={{ flex: 1 }} />
      <IconButton name="refresh" label="刷新会话" busy={refreshing} onPress={() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)) }} />
      <IconButton name="settings" label="打开手机设置" onPress={onSettings} />
    </View>
    <Modal visible={picker} transparent animationType="fade" onRequestClose={() => setPicker(false)}>
      <Pressable accessibilityLabel="关闭" onPress={() => setPicker(false)} style={[styles.scrim, { backgroundColor: 'rgba(0,0,0,0.45)' }]}>
        <Pressable style={[styles.sheet, { backgroundColor: p.bg1, borderColor: p.border }]}>
          <Text style={{ color: p.fg, fontSize: font.body, paddingHorizontal: space[2], paddingBottom: space[2] }}>在哪个项目新建会话？</Text>
          <FlatList
            data={projects}
            keyExtractor={(item) => item.id}
            style={{ maxHeight: 360 }}
            renderItem={({ item }) => <Pressable accessibilityRole="button" onPress={() => void create(item.id)} style={({ pressed }) => [styles.folder, { opacity: pressed ? 0.6 : 1 }]}>
              <Icon name="folder" color={p.fgDim} size={icon.md} />
              <View style={styles.rowMain}><Text numberOfLines={1} style={{ color: p.fg, fontSize: font.body }}>{item.name}</Text><Meta numberOfLines={1}>{item.cwd}</Meta></View>
            </Pressable>}
            ListFooterComponent={<Pressable accessibilityRole="button" onPress={() => void create()} style={({ pressed }) => [styles.folder, { opacity: pressed ? 0.6 : 1 }]}>
              <Icon name="pencil" color={p.fgDim} size={icon.md} />
              <View style={styles.rowMain}><Text style={{ color: p.fg, fontSize: font.body }}>电脑当前目录</Text><Meta>不选项目，用电脑上正在用的目录</Meta></View>
            </Pressable>}
          />
        </Pressable>
      </Pressable>
    </Modal>
  </View>
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  rowMain: { flex: 1, gap: space[1], minWidth: 0 },
  list: { paddingHorizontal: space[2], paddingBottom: space[4] },
  glyph: { width: 10, textAlign: 'center', fontSize: font.xs },
  session: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[2], paddingVertical: space[2], borderRadius: radius.md },
  folder: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[2], borderRadius: radius.md },
  question: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderWidth: 1, padding: space[3], marginBottom: space[2], borderRadius: radius.md },
  error: { fontSize: font.sm, padding: space[3], borderLeftWidth: 2 },
  activity: { paddingHorizontal: space[4] },
  alertPrompt: { minHeight: touch.min, paddingHorizontal: space[4], flexDirection: 'row', alignItems: 'center', gap: space[2] },
  dock: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingLeft: space[4], paddingRight: space[2], paddingVertical: space[1], borderTopWidth: StyleSheet.hairlineWidth },
  search: { flexDirection: 'row', alignItems: 'center', gap: space[2], marginHorizontal: space[3], marginBottom: space[1], paddingHorizontal: space[3], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: 1, padding: space[4], paddingBottom: space[6] }
})
