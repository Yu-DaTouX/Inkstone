import { LIFE_ASSISTANT_ENABLED } from '../features'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { idempotencyKey, RemoteHttpError, type SessionListItem } from '../api/client'
import { approvalInfo, QuestionCard } from '../components/QuestionCard'
import { Icon, BrandMark } from '../icons'
import { GlyphSpinner } from '../motion'
import { useRemote } from '../state'
import { useBottomInset } from '../insets'
import { font, icon, mono, radius, space, touch, usePalette, useProjectLook, weight } from '../theme'
import { capabilityAllowed } from '../../../src/shared/capability-negotiation'
import { ActivityLine, IconButton, Meta, SectionTitle, STATUS_TEXT, StatusDot } from '../ui'

const UNGROUPED = 'folder:未分类'
const ARCHIVED = 'archived'
const SESSIONS_SHOWN = 5
const folderKey = (s: SessionListItem) => s.projectId || `folder:${s.cwdName?.trim() || '未分类'}`
const activityAt = (s: SessionListItem) => s.lastActivityAt ?? s.updatedAt

function timeAgo(at: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000))
  return minutes < 1 ? '<1m' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}

type Group = { id: string; name: string; cwd?: string; sessions: SessionListItem[]; latest: number }
type Row =
  | { kind: 'section'; key: string; title: string; count?: number }
  | { kind: 'ask'; key: string; questionId: string }
  | { kind: 'run'; key: string; session: SessionListItem }
  | { kind: 'group'; key: string; group: Group; open: boolean }
  | { kind: 'session'; key: string; session: SessionListItem; meta?: string }
  | { kind: 'more'; key: string; groupId: string; hidden: number }
  | { kind: 'assistant'; key: string }

export function HomeScreen({ onOpen, onOpenAssistant, onSettings, alertsEnabled, onEnableAlerts, selectedSessionId }: {
  onOpen: (sessionId: string, title: string) => void
  onOpenAssistant: () => void
  onSettings: () => void
  alertsEnabled: boolean
  onEnableAlerts: () => void
  selectedSessionId?: string
}) {
  const p = usePalette()
  const bottomInset = useBottomInset()
  const { sessions, projects, questions, runners, stream, error, refresh, client, info, unread } = useRemote()
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [picker, setPicker] = useState(false)
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const [contentHits, setContentHits] = useState<Array<{ sessionId: string; snippet: string }>>([])
  const newAttempt = useRef<{ key: string; projectId: string | null } | null>(null)

  const searchAllowed = capabilityAllowed(info, 'search')
  useEffect(() => {
    const needle = query.trim()
    if (!searchAllowed || needle.length < 2) { setContentHits([]); return }
    let alive = true
    const timer = setTimeout(() => {
      void client.search(needle).then((hits) => { if (alive) setContentHits(hits) }).catch(() => { if (alive) setContentHits([]) })
    }, 400)
    return () => { alive = false; clearTimeout(timer) }
  }, [client, query, searchAllowed])

  const asking = useMemo(() => new Set(questions.map((q) => q.sessionId).filter(Boolean)), [questions])
  const running = useMemo(() => new Set(runners.filter((r) => r.running || r.waiting).map((r) => r.sessionId)), [runners])
  const groups = useMemo(() => {
    const known = new Set(projects.map((item) => item.id))
    const map = new Map<string, Group>()
    for (const item of projects) map.set(item.id, { id: item.id, name: item.name, cwd: item.cwd, sessions: [], latest: 0 })
    const archived: SessionListItem[] = []
    for (const session of [...sessions].sort((a, b) => activityAt(b) - activityAt(a))) {
      if (session.archivedAt) { archived.push(session); continue }
      const id = session.projectId && known.has(session.projectId) ? session.projectId : folderKey(session)
      const group = map.get(id) ?? { id, name: session.cwdName || '未分类', sessions: [], latest: 0 }
      group.sessions.push(session)
      group.latest = Math.max(group.latest, activityAt(session))
      map.set(id, group)
    }
    const ordered = [...map.values()].sort((a, b) => (a.id === UNGROUPED ? 1 : b.id === UNGROUPED ? -1 : b.latest - a.latest))
    if (archived.length) ordered.push({ id: ARCHIVED, name: '已归档', sessions: archived, latest: 0 })
    return ordered
  }, [projects, sessions])
  const lookOf = useProjectLook(useMemo(() => projects.map((item) => item.id), [projects]))
  const projectName = (session: SessionListItem) => groups.find((group) => group.sessions.includes(session))?.name ?? session.cwdName ?? ''
  const titleOf = (id: string | null | undefined) => sessions.find((s) => s.id === id)?.title ?? '会话'

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const needle = query.trim().toLowerCase()
    if (needle) {
      const hits = [...sessions].filter((s) => `${s.title} ${s.cwdName ?? ''}`.toLowerCase().includes(needle)).sort((a, b) => activityAt(b) - activityAt(a))
      out.push({ kind: 'section', key: 'search', title: '搜索结果', count: hits.length })
      for (const s of hits) out.push({ kind: 'session', key: `hit-${s.id}`, session: s, meta: s.cwdName })
      const titled = new Set(hits.map((s) => s.id))
      const inside = contentHits.filter((hit) => !titled.has(hit.sessionId)).flatMap((hit) => { const found = sessions.find((s) => s.id === hit.sessionId); return found ? [{ session: found, snippet: hit.snippet }] : [] })
      if (inside.length) {
        out.push({ kind: 'section', key: 'content', title: '内容匹配', count: inside.length })
        for (const entry of inside) out.push({ kind: 'session', key: `content-${entry.session.id}`, session: entry.session, meta: entry.snippet })
      }
      return out
    }
    if (questions.length) {
      out.push({ kind: 'section', key: 'ask', title: STATUS_TEXT.wait, count: questions.length })
      for (const q of questions) out.push({ kind: 'ask', key: `ask-${q.id}`, questionId: q.id })
    }
    const pinned = sessions.filter((s) => s.pinned && !s.archivedAt).sort((a, b) => activityAt(b) - activityAt(a))
    if (pinned.length) {
      out.push({ kind: 'section', key: 'pinned', title: '置顶', count: pinned.length })
      for (const s of pinned) out.push({ kind: 'session', key: `pin-${s.id}`, session: s, meta: s.cwdName })
    }
    const live = sessions.filter((s) => running.has(s.id) && !asking.has(s.id) && !s.archivedAt)
    if (live.length) {
      out.push({ kind: 'section', key: 'run', title: STATUS_TEXT.run, count: live.length })
      for (const s of live) out.push({ kind: 'run', key: `run-${s.id}`, session: s })
    }
    if (LIFE_ASSISTANT_ENABLED) out.push({ kind: 'assistant', key: 'assistant' })
    out.push({ kind: 'section', key: 'projects', title: '项目' })
    groups.forEach((group, index) => {
      const holdsCurrent = group.sessions.some((s) => s.id === selectedSessionId)
      const open = toggled[group.id] ?? (holdsCurrent || (index === 0 && group.id !== ARCHIVED))
      out.push({ kind: 'group', key: `group-${group.id}`, group, open })
      if (!open) return
      const all = showAll[group.id]
      const shown = all ? group.sessions : group.sessions.slice(0, SESSIONS_SHOWN)
      for (const s of shown) out.push({ kind: 'session', key: `s-${s.id}`, session: s })
      if (!all && group.sessions.length > SESSIONS_SHOWN) out.push({ kind: 'more', key: `more-${group.id}`, groupId: group.id, hidden: group.sessions.length - SESSIONS_SHOWN })
    })
    return out
  }, [query, sessions, contentHits, questions, running, asking, groups, toggled, showAll, selectedSessionId])

  const create = async (projectId?: string) => {
    setPicker(false)
    setCreating(true)
    const target = projectId ?? null
    const attempt = newAttempt.current?.projectId === target ? newAttempt.current : { key: idempotencyKey(), projectId: target }
    newAttempt.current = attempt
    try {
      const result = await client.newSession(projectId, attempt.key)
      newAttempt.current = null
      await refresh()
      if (result.sessionId) onOpen(result.sessionId, '新会话')
      else Alert.alert('电脑已接收', '新会话尚未返回，请在会话列表中查看。')
    } catch (err) {
      if (!(err instanceof RemoteHttpError) || err.status !== 0) newAttempt.current = null
      Alert.alert('创建失败', err instanceof Error ? err.message : '请稍后重试')
    } finally { setCreating(false) }
  }

  const sessionStatus = (session: SessionListItem) => {
    const runner = runners.find((r) => r.sessionId === session.id)
    if (runner?.waiting || asking.has(session.id)) return { text: STATUS_TEXT.wait, color: p.warn }
    if (runner?.running) return { text: STATUS_TEXT.run, color: p.accent }
    return null
  }

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === 'section') return <SectionTitle count={item.count}>{item.title}</SectionTitle>
    if (item.kind === 'assistant') return <Pressable accessibilityRole="button" accessibilityLabel="打开生活助手" onPress={onOpenAssistant} style={({ pressed }) => [styles.group, { opacity: pressed ? 0.6 : 1 }]}>
      <Icon name="sparkles" color={p.accent} size={icon.sm} /><Text style={[styles.groupName, { color: p.fg }]}>生活助手</Text><Icon name="chevron-right" color={p.fgMute} size={icon.sm} />
    </Pressable>
    if (item.kind === 'ask') {
      const q = questions.find((entry) => entry.id === item.questionId)
      if (!q) return null
      if (!q.sessionId) return <View style={styles.cardWrap}><QuestionCard question={q} onAnswer={(answer, key) => client.answer(q.id, answer, key).finally(() => refresh())} /></View>
      const session = sessions.find((s) => s.id === q.sessionId)
      const headline = (approvalInfo(q) ? q.title : q.message || q.title) || '砚需要你回答'
      return <Pressable accessibilityRole="button" accessibilityLabel={`${STATUS_TEXT.wait}：${headline}，${titleOf(q.sessionId)}`} onPress={() => onOpen(q.sessionId!, titleOf(q.sessionId))} style={({ pressed }) => [styles.card, { backgroundColor: p.warnSoft, opacity: pressed ? 0.75 : 1 }]}>
        <View style={styles.cardTop}><Text numberOfLines={1} style={[styles.cardProject, { color: p.fgMute }]}>{session ? projectName(session) : ''}</Text><Text style={{ color: p.warn, fontSize: font.xs }}>◆ {approvalInfo(q) ? '等待批准' : q.sensitive ? '需在电脑确认' : STATUS_TEXT.wait}</Text></View>
        <Text numberOfLines={3} style={[styles.cardTitle, { color: p.fg }]}>{headline}</Text>
        <Text numberOfLines={1} style={{ color: p.fgDim, fontSize: font.sm }}>{titleOf(q.sessionId)}</Text>
      </Pressable>
    }
    if (item.kind === 'run') {
      const selected = item.session.id === selectedSessionId
      return <Pressable accessibilityRole="button" accessibilityLabel={`${item.session.title}，${STATUS_TEXT.run}`} onPress={() => onOpen(item.session.id, item.session.title)} style={({ pressed }) => [styles.card, { backgroundColor: selected ? p.press : p.bg3, borderColor: p.borderSoft, borderWidth: StyleSheet.hairlineWidth, opacity: pressed ? 0.75 : 1 }]}>
        <View style={styles.cardTop}><Text numberOfLines={1} style={[styles.cardProject, { color: p.fgMute }]}>{projectName(item.session)}</Text><View style={styles.runState}><GlyphSpinner /><Text style={{ color: p.accent, fontSize: font.xs, fontFamily: mono }}>{STATUS_TEXT.run}</Text></View></View>
        <Text numberOfLines={1} style={[styles.cardTitle, { color: p.fg }]}>{item.session.title || '未命名会话'}</Text>
      </Pressable>
    }
    if (item.kind === 'group') {
      const { color, text } = lookOf(item.group.id, item.group.name)
      return <Pressable accessibilityRole="button" accessibilityState={{ expanded: item.open }} accessibilityLabel={`${item.group.name}，${item.group.sessions.length} 个会话${item.group.cwd ? `，${item.group.cwd}` : ''}`} onPress={() => setToggled((current) => ({ ...current, [item.group.id]: !item.open }))} style={({ pressed }) => [styles.group, { opacity: pressed ? 0.6 : 1 }]}>
        <View style={[styles.badge, { backgroundColor: `${color}2E` }]}><Text style={[styles.badgeText, { color }]}>{text}</Text></View>
        <Text numberOfLines={1} style={[styles.groupName, { color: p.fg }]}>{item.group.name}</Text>
        <View style={{ transform: [{ rotate: item.open ? '90deg' : '0deg' }] }}><Icon name="chevron-right" color={p.fgMute} size={icon.sm} /></View>
      </Pressable>
    }
    if (item.kind === 'more') return <Pressable accessibilityRole="button" onPress={() => setShowAll((current) => ({ ...current, [item.groupId]: true }))} style={[styles.session, styles.indent]}><Text style={{ color: p.fgMute, fontSize: font.sm }}>更多（{item.hidden}）</Text></Pressable>
    const session = item.session
    const selected = session.id === selectedSessionId
    const status = sessionStatus(session)
    const isUnread = unread.has(session.id)
    return <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${session.title}${status ? `，${status.text}` : isUnread ? '，未读回复' : ''}`} onPress={() => onOpen(session.id, session.title)} style={({ pressed }) => [styles.session, item.meta === undefined && styles.indent, { backgroundColor: selected ? p.press : pressed ? p.bg3 : 'transparent' }]}>
      {isUnread && !status ? <View style={[styles.unread, { backgroundColor: p.accent }]} /> : null}
      <View style={styles.rowMain}>
        <Text numberOfLines={1} style={{ color: p.fg, fontSize: font.base, fontWeight: selected ? weight.strong : weight.regular }}>{session.title || '未命名会话'}</Text>
        {item.meta ? <Meta numberOfLines={1}>{item.meta}</Meta> : null}
      </View>
      {status ? <Text style={{ color: status.color, fontSize: font.xs }}>{status.text}</Text> : <Text style={[styles.time, { color: p.fgMute }]}>{timeAgo(activityAt(session))}</Text>}
    </Pressable>
  }

  const liveCount = runners.filter((r) => r.running).length
  return <View style={[styles.root, { backgroundColor: p.bg1 }]}>
    <View style={styles.head}>
      <BrandMark size={20} />
      <Text style={[styles.brand, { color: p.fg }]}>Inkstone</Text>
      {liveCount ? <View accessibilityLabel={`${liveCount} 个会话运行中`} style={styles.runState}><GlyphSpinner /><Text style={{ color: p.accent, fontSize: font.xs, fontFamily: mono }}>{liveCount}</Text></View> : null}
      {questions.length ? <Text accessibilityLabel={`${questions.length} 个待回答`} style={{ color: p.warn, fontSize: font.xs, fontFamily: mono }}>◆ {questions.length}</Text> : null}
    </View>
    <View style={styles.searchRow}>
      <Icon name="search" size={icon.sm} color={p.fgMute} />
      <TextInput disableFullscreenUI value={query} onChangeText={setQuery} placeholder="搜索" placeholderTextColor={p.fgMute} accessibilityLabel="搜索会话" style={[styles.search, { color: p.fg }]} />
      <IconButton name="pencil" label="新建会话" busy={creating} disabled={stream !== 'open'} onPress={() => setPicker(true)} />
    </View>
    {(refreshing || creating || stream === 'connecting' || stream === 'reconnecting') ? <View style={styles.activity}><ActivityLine state="run" text={creating ? '正在新建会话' : refreshing ? '正在刷新会话' : STATUS_TEXT[stream]} /></View> : null}
    {error ? <Text style={[styles.error, { color: p.err, backgroundColor: p.errSoft }]}>{/连接超时/.test(error) ? '连接超时，请检查电脑和 Tailscale。' : error}</Text> : null}
    <FlatList data={rows} keyExtractor={(row) => row.key} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list} renderItem={renderRow}
      ListFooterComponent={rows.length && !query && !sessions.length ? <Meta style={styles.empty}>{stream === 'open' ? '还没有会话' : '正在等待电脑的会话…'}</Meta> : null} />
    {!alertsEnabled ? <Pressable accessibilityRole="button" onPress={onEnableAlerts} style={styles.alertPrompt}><Icon name="bell" color={p.accent} size={icon.sm} /><Text style={{ color: p.accent, fontSize: font.sm }}>开启待回答提醒</Text></Pressable> : null}
    <View style={[styles.foot, { borderTopColor: p.borderSoft, paddingBottom: Math.max(0, bottomInset - space[2]) }]}>
      <StatusDot color={stream === 'open' ? p.online : p.warn} label={STATUS_TEXT[stream]} />
      <Text accessibilityLabel={`${client.connection.baseUrl}，${STATUS_TEXT[stream]}`} numberOfLines={1} style={[styles.computer, { color: p.fgDim }]}>{info?.computer?.name || client.connection.computerName || client.connection.baseUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '')}</Text>
      <IconButton name="refresh" label="刷新会话" busy={refreshing} onPress={() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)) }} />
      <IconButton name="settings" label="打开手机设置" onPress={onSettings} />
    </View>
    <Modal visible={picker} transparent animationType="fade" onRequestClose={() => setPicker(false)}>
      <Pressable accessibilityLabel="关闭" onPress={() => setPicker(false)} style={styles.scrim}>
        <Pressable style={[styles.sheet, { backgroundColor: p.surface3, borderColor: p.borderSoft }]}>
          <Text style={[styles.sheetTitle, { color: p.fg }]}>在哪个项目新建会话？</Text>
          <FlatList
            data={projects}
            keyExtractor={(item) => item.id}
            style={{ maxHeight: 360 }}
            renderItem={({ item }) => {
              const { color, text } = lookOf(item.id, item.name)
              return <Pressable accessibilityRole="button" onPress={() => void create(item.id)} style={({ pressed }) => [styles.group, { opacity: pressed ? 0.6 : 1 }]}>
                <View style={[styles.badge, { backgroundColor: `${color}2E` }]}><Text style={[styles.badgeText, { color }]}>{text}</Text></View>
                <View style={styles.rowMain}><Text numberOfLines={1} style={{ color: p.fg, fontSize: font.base, fontWeight: weight.medium }}>{item.name}</Text><Meta numberOfLines={1}>{item.cwd}</Meta></View>
              </Pressable>
            }}
            ListFooterComponent={<Pressable accessibilityRole="button" onPress={() => void create()} style={({ pressed }) => [styles.group, { opacity: pressed ? 0.6 : 1 }]}>
              <Icon name="folder" color={p.fgDim} size={icon.md} />
              <View style={styles.rowMain}><Text style={{ color: p.fg, fontSize: font.base }}>电脑当前目录</Text><Meta>不选项目，用电脑上正在用的目录</Meta></View>
            </Pressable>}
          />
        </Pressable>
      </Pressable>
    </Modal>
  </View>
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[4] },
  brand: { fontSize: font.lg, fontWeight: weight.strong },
  runState: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingLeft: space[4], paddingRight: space[1] },
  search: { flex: 1, minWidth: 0, minHeight: 40, paddingVertical: 6, fontSize: font.base },
  list: { paddingHorizontal: space[2], paddingBottom: space[4] },
  rowMain: { flex: 1, gap: 2, minWidth: 0 },
  card: { marginHorizontal: space[1], marginBottom: space[2], paddingHorizontal: space[3], paddingVertical: space[2] + 2, borderRadius: radius.bubble, gap: 3 },
  cardWrap: { marginHorizontal: space[1], marginBottom: space[2] },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: space[2], justifyContent: 'space-between' },
  cardProject: { flexShrink: 1, fontSize: font.xs },
  cardTitle: { fontSize: font.body, fontWeight: weight.strong, lineHeight: 22 },
  group: { minHeight: touch.min, flexDirection: 'row', alignItems: 'center', gap: space[3], paddingLeft: space[2], paddingRight: space[3], borderRadius: radius.md },
  groupName: { flex: 1, minWidth: 0, fontSize: font.body, fontWeight: weight.strong },
  badge: { width: 20, height: 20, borderRadius: radius.xs, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 9, fontWeight: weight.strong },
  session: { minHeight: touch.min, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingLeft: space[3], paddingRight: space[3], borderRadius: radius.md },
  indent: { paddingLeft: 40 },
  unread: { position: 'absolute', left: 26, width: 6, height: 6, borderRadius: 3 },
  time: { fontSize: font.xs, fontFamily: mono, fontVariant: ['tabular-nums'] },
  error: { fontSize: font.sm, paddingHorizontal: space[4], paddingVertical: space[2] },
  activity: { paddingHorizontal: space[4] },
  empty: { textAlign: 'center', paddingVertical: space[4] },
  alertPrompt: { minHeight: touch.min, paddingHorizontal: space[4], flexDirection: 'row', alignItems: 'center', gap: space[2] },
  foot: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingLeft: space[4], paddingRight: space[1], borderTopWidth: StyleSheet.hairlineWidth },
  computer: { flex: 1, minWidth: 0, fontSize: font.sm },
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { borderTopLeftRadius: radius.composer, borderTopRightRadius: radius.composer, borderWidth: StyleSheet.hairlineWidth, padding: space[4], paddingBottom: space[6] },
  sheetTitle: { fontSize: font.body, fontWeight: weight.strong, paddingHorizontal: space[2], paddingBottom: space[2] }
})
