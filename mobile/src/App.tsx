import { LIFE_ASSISTANT_ENABLED } from './features'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, AppState, BackHandler, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, StatusBar, StyleSheet, useColorScheme, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { RemoteClient, type Connection } from './api/client'
import { readUiPrefs, writeUiPrefs, type PhotoDraft } from './device'
import { parsePairingLink, type PairingPrefill } from './pairLink'
import { restoreQuestionAlerts, startQuestionAlerts, stopQuestionAlerts } from './questionAlerts'
import { ArtifactScreen } from './screens/ArtifactScreen'
import { AssistantScreen, type AssistantConversation } from './screens/AssistantScreen'
import { AssistantSettingsScreen } from './screens/AssistantSettingsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { PairScreen } from './screens/PairScreen'
import { SessionScreen } from './screens/SessionScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { DetailPane, type SessionDetail } from './components/DetailPane'
import { RemoteProvider, useRemote } from './state'
import { Button, EmptyState, Header, IconButton } from './ui'
import { clearConnection, loadConnection, saveConnection } from './storage'
import { space, usePalette } from './theme'
import { BootSplash, ContentEnter } from './motion'
import { useFoldLayout } from './foldLayout'
import { computeLayout, type Frame } from './windowLayout'
import { cancelSpeech, isSpeechActive } from './speech'

type ArtifactLink = { id: string; filename: string; mediaType: string; kind: string }

type Route =
  | { name: 'home' }
  | { name: 'assistant' }
  | { name: 'assistant-settings' }
  | { name: 'settings' }
  | { name: 'session'; sessionId: string; title: string }
  | { name: 'artifact'; sessionId: string; title: string; artifact: ArtifactLink }

function RemoteReady({ onReady }: { onReady: () => void }) {
  const { sessions, stream, error } = useRemote()
  const settled = sessions.length > 0 || stream === 'open' || !!error
  useEffect(() => { if (settled) onReady() }, [settled, onReady])
  return null
}

function Hidden({ hidden, children, style }: { hidden: boolean; children: ReactNode; style?: object }) {
  return <View style={[{ flex: 1, minWidth: 0 }, style, hidden ? { display: 'none' } : null]}>{children}</View>
}

export default function App() {
  const p = usePalette()
  const scheme = useColorScheme()
  const fold = useFoldLayout()
  const frameRef = useRef<View>(null)
  const [frame, setFrame] = useState<Frame>({ x: 0, y: 0, width: 0, height: 0 })
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null)
  const measure = useCallback(() => frameRef.current?.measureInWindow((x, y, width, height) => setFrame({ x, y, width, height })), [])
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardTop(event.endCoordinates.screenY)
      for (const delay of [120, 400]) timers.push(setTimeout(measure, delay))
    })
    const hide = Keyboard.addListener('keyboardDidHide', () => { setKeyboardTop(null); timers.push(setTimeout(measure, 120)) })
    return () => { timers.forEach(clearTimeout); show.remove(); hide.remove() }
  }, [measure])
  const statusOffset = frame.y < (StatusBar.currentHeight ?? 0) / 2 ? StatusBar.currentHeight ?? 0 : 0
  const keyboardOverlap = keyboardTop === null ? 0 : Math.max(0, Math.round(frame.y + statusOffset + frame.height - keyboardTop))
  const layout = computeLayout(frame, fold)
  const mode = layout.mode

  const [connection, setConnection] = useState<Connection | null | undefined>(undefined)
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [assistantConversation, setAssistantConversation] = useState<AssistantConversation>({ messages: [], draft: '' })
  const [localRoute, setLocalRoute] = useState<'welcome' | 'assistant' | 'assistant-settings'>('welcome')
  const assistantSettingsFrom = useRef<'assistant' | 'settings'>('assistant')
  const [pairingPrefill, setPairingPrefill] = useState<PairingPrefill | null>(null)
  const [alertsEnabled, setAlertsEnabled] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [photoDrafts, setPhotoDrafts] = useState<Record<string, PhotoDraft[]>>({})
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [leftHanded, setLeftHanded] = useState(false)
  useEffect(() => { void readUiPrefs().then((prefs) => setLeftHanded(!!prefs.leftHanded)) }, [])
  const changeLeftHanded = useCallback((value: boolean) => {
    setLeftHanded(value)
    void writeUiPrefs({ leftHanded: value }).catch(() => undefined)
  }, [])
  const [booting, setBooting] = useState(true)
  const [remoteReady, setRemoteReady] = useState(false)
  const markRemoteReady = useCallback(() => setRemoteReady(true), [])
  const endBoot = useCallback(() => setBooting(false), [])
  const sessionId = 'sessionId' in route ? route.sessionId : undefined

  useEffect(() => { void loadConnection().then(setConnection) }, [])

  useEffect(() => {
    const receive = (url: string | null) => {
      if (!url) return
      if (url === 'inkstone://inbox' || url === 'inkstone://hub') { setRoute({ name: 'home' }); return }
      const parsed = parsePairingLink(url)
      if (parsed) setPairingPrefill(parsed)
    }
    void Linking.getInitialURL().then(receive)
    const subscription = Linking.addEventListener('url', ({ url }) => receive(url))
    return () => subscription.remove()
  }, [])

  const unpair = useCallback(async () => {
    await stopQuestionAlerts()
    if (connection) {
      try {
        await new RemoteClient(connection).revokeSelf()
      } catch {
        const confirmed = await new Promise<boolean>((resolve) => Alert.alert(
          '电脑暂时无法撤销设备', '若继续退出，将只清除此手机的钥匙串；电脑端令牌可能仍有效，请恢复连接后在设备设置中撤销。',
          [{ text: '取消', style: 'cancel', onPress: () => resolve(false) }, { text: '仍然清除此手机', style: 'destructive', onPress: () => resolve(true) }],
          { cancelable: false }
        ))
        if (!confirmed) return
      }
    }
    await clearConnection()
    setConnection(null)
    setAlertsEnabled(false)
    setRoute({ name: 'home' })
    setDrafts({})
    setPhotoDrafts({})
    setDetail(null)
  }, [connection])

  const enableAlerts = useCallback(async () => {
    if (!connection) return
    try { setAlertsEnabled(await startQuestionAlerts(connection, true)) }
    catch { setAlertsEnabled(false) }
  }, [connection])

  const onDraftChange = useCallback((id: string, text: string) => {
    setDrafts((current) => ({ ...current, [id]: text }))
  }, [])
  const onDetail = useCallback((next: SessionDetail) => setDetail(next), [])

  useEffect(() => {
    const restore = async () => {
      if (!connection) return
      try { setAlertsEnabled(await restoreQuestionAlerts(connection)) }
      catch { setAlertsEnabled(false) }
    }
    void restore()
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void restore() })
    return () => subscription.remove()
  }, [connection])

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isSpeechActive()) { cancelSpeech(); return true }
      if (Keyboard.isVisible()) { Keyboard.dismiss(); return true }
      if (pairingPrefill && connection) { setPairingPrefill(null); return true }
      if (!connection && localRoute !== 'welcome') { setLocalRoute(localRoute === 'assistant-settings' ? 'assistant' : 'welcome'); return true }
      if (route.name === 'assistant-settings') { setRoute(assistantSettingsFrom.current === 'settings' ? { name: 'settings' } : { name: 'assistant' }); return true }
      if (route.name === 'assistant') { setRoute({ name: 'home' }); return true }
      if (route.name === 'artifact') { setRoute({ name: 'session', sessionId: route.sessionId, title: route.title }); return true }
      if (route.name === 'session' && detailOpen && mode !== 'triple' && mode !== 'tabletop') { setDetailOpen(false); return true }
      if (route.name === 'session' || route.name === 'settings') { setRoute({ name: 'home' }); return true }
      return false
    })
    return () => sub.remove()
  }, [connection, pairingPrefill, route, localRoute, mode, detailOpen])

  const openSession = useCallback((id: string, title: string) => {
    setRoute({ name: 'session', sessionId: id, title })
    setDetailOpen(false)
    setDetail((current) => (current?.sessionId === id ? current : null))
  }, [])
  const openArtifact = useCallback((artifact: ArtifactLink) => {
    if (route.name === 'session') setRoute({ name: 'artifact', sessionId: route.sessionId, title: route.title, artifact })
  }, [route])

  const paired = !!connection && !pairingPrefill
  const multi = mode === 'split' || mode === 'book' || mode === 'triple'
  const detailShown = !!sessionId && route.name === 'session' && detailOpen && (mode === 'split' || mode === 'book')
  const listShown = multi && !detailShown && (mode !== 'split' || !sidebarCollapsed || route.name === 'home')
  const toggleSidebar = mode === 'split'
    ? () => { if (detailOpen) { setDetailOpen(false); setSidebarCollapsed(false) } else setSidebarCollapsed((c) => !c) }
    : mode === 'book' ? () => setDetailOpen(false) : undefined
  const toggleDetail = mode === 'single' || mode === 'split' || mode === 'book' ? () => setDetailOpen((open) => !open) : undefined
  const singleRegion = mode === 'book'
    ? leftHanded ? { width: layout.side } : { marginLeft: layout.side + layout.gap, flex: 1 }
    : mode === 'tabletop' && route.name !== 'session'
      ? { height: layout.top }
      : { flex: 1 }

  const sessionScreen = route.name === 'session' ? <SessionScreen
    key={route.sessionId}
    sessionId={route.sessionId}
    title={route.title}
    onBack={() => setRoute({ name: 'home' })}
    onOpenArtifact={openArtifact}
    draft={drafts[route.sessionId] ?? ''}
    onDraftChange={(text) => onDraftChange(route.sessionId, text)}
    photos={photoDrafts[route.sessionId] ?? []}
    onPhotosChange={(photos) => setPhotoDrafts((current) => ({ ...current, [route.sessionId]: photos }))}
    tabletop={mode === 'tabletop' ? { top: layout.top, gap: layout.topGap } : undefined}
    sidebarVisible={mode === 'split' || mode === 'book' ? listShown : undefined}
    onToggleSidebar={toggleSidebar}
    onOpenDetail={toggleDetail}
    detailOpen={detailOpen && mode !== 'triple'}
    onDetail={onDetail}
    banner={mode === 'single' && detailOpen ? <View style={{ flex: 1 }}>
      <View style={[styles.banner, { backgroundColor: p.surface3, borderColor: p.borderSoft }]}>
        <DetailPane detail={detail?.sessionId === route.sessionId ? detail : null} onOpenArtifact={(artifact) => { setDetailOpen(false); openArtifact(artifact) }} background={p.surface3} inset={false} />
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="收起会话详情" onPress={() => setDetailOpen(false)} style={[styles.scrim, { backgroundColor: p.press }]} />
    </View> : undefined}
  /> : null

  const mainContent = route.name === 'settings' ? (
    <SettingsScreen
      connection={connection!}
      alertsEnabled={alertsEnabled}
      onEnableAlerts={() => void enableAlerts()}
      onDisableAlerts={() => { void stopQuestionAlerts(); setAlertsEnabled(false) }}
      onUnpair={unpair}
      onBack={() => setRoute({ name: 'home' })}
      sidebarVisible={listShown}
      onToggleSidebar={mode === 'split' ? () => setSidebarCollapsed((c) => !c) : undefined}
      onOpenAssistantSettings={() => { assistantSettingsFrom.current = 'settings'; setRoute({ name: 'assistant-settings' }) }}
      leftHanded={leftHanded}
      onLeftHandedChange={changeLeftHanded}
    />
  ) : route.name === 'artifact' ? (
    <ArtifactScreen
      sessionId={route.sessionId}
      artifact={route.artifact}
      onBack={() => setRoute({ name: 'session', sessionId: route.sessionId, title: route.title })}
      sidebarVisible={listShown}
      onToggleSidebar={mode === 'split' ? () => setSidebarCollapsed((c) => !c) : undefined}
    />
  ) : route.name === 'assistant' ? (
    <AssistantScreen conversation={assistantConversation} onConversationChange={setAssistantConversation} onBack={() => setRoute({ name: 'home' })} onConfigure={() => { assistantSettingsFrom.current = 'assistant'; setRoute({ name: 'assistant-settings' }) }} />
  ) : route.name === 'assistant-settings' ? (
    <AssistantSettingsScreen onBack={() => setRoute(assistantSettingsFrom.current === 'settings' ? { name: 'settings' } : { name: 'assistant' })} />
  ) : null

  const home = connection ? <HomeScreen
    onOpen={openSession}
    onSettings={() => setRoute({ name: 'settings' })}
    onOpenAssistant={() => setRoute({ name: 'assistant' })}
    alertsEnabled={alertsEnabled}
    onEnableAlerts={() => void enableAlerts()}
    selectedSessionId={sessionId}
  /> : null

  const detailPane = (onClose?: () => void) => <View style={{ flex: 1, backgroundColor: p.bg1 }}>
    <Header title="会话详情" background={p.bg1} right={onClose ? <IconButton name="close" label="收起会话详情" onPress={onClose} /> : undefined} />
    <DetailPane detail={detail?.sessionId === sessionId ? detail : null} onOpenArtifact={openArtifact} />
  </View>

  const remoteBody = () => {
    if (!multi) {
      return <View style={[singleRegion]}>
        <Hidden hidden={route.name !== 'home'}>{home}</Hidden>
        {sessionScreen ? <ContentEnter key={sessionId}>{sessionScreen}</ContentEnter> : null}
        {mainContent ? <ContentEnter key={route.name}>{mainContent}</ContentEnter> : null}
      </View>
    }
    const firstWidth = leftHanded && mode === 'book' ? frame.width - layout.side - layout.gap : layout.side
    const hairline = StyleSheet.hairlineWidth
    const edge = (toward: 'main' | 'outer') => mode === 'book' ? {} : (toward === 'main') !== leftHanded ? { borderRightWidth: hairline, borderColor: p.borderSoft } : { borderLeftWidth: hairline, borderColor: p.borderSoft }
    const main = sessionScreen ? <ContentEnter key={sessionId}>{sessionScreen}</ContentEnter> : mainContent ? <ContentEnter key={route.name}>{mainContent}</ContentEnter> : <View style={styles.center}><EmptyState>选择会话</EmptyState></View>
    const spacer = mode === 'book' ? <View style={{ width: layout.gap }} /> : null
    return <View style={{ flex: 1, flexDirection: leftHanded ? 'row-reverse' : 'row' }}>
      <View style={[styles.side, { width: firstWidth }, edge('main'), listShown ? null : { display: 'none' }]}>{home}</View>
      {listShown ? spacer : null}
      <View style={[{ minWidth: 0, backgroundColor: p.bg0 }, mode === 'book' && detailShown ? { width: firstWidth } : { flex: 1 }]}>{main}</View>
      {detailShown ? <>
        {spacer}
        <View style={[mode === 'book' ? { flex: 1 } : { width: Math.min(420, Math.max(300, Math.round(frame.width * 0.45))) }, edge('outer')]}>{detailPane(() => setDetailOpen(false))}</View>
      </> : null}
      {mode === 'triple' && sessionId ? <View style={[{ width: layout.aside }, edge('outer')]}>{detailPane()}</View> : null}
    </View>
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} backgroundColor={p.bg1} />
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: paired && route.name !== 'home' && mode === 'single' ? p.bg0 : p.bg1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={frame.y} style={{ flex: 1 }}>
        <View ref={frameRef} collapsable={false} onLayout={measure} style={{ flex: 1, paddingBottom: keyboardOverlap }}>
        {connection === undefined ? null : !paired ? (
          <View style={[singleRegion, { backgroundColor: p.bg0 }]}>
            {localRoute !== 'welcome' && !pairingPrefill ? (
              localRoute === 'assistant-settings' ? (
                <AssistantSettingsScreen onBack={() => setLocalRoute('assistant')} />
              ) : (
                <AssistantScreen conversation={assistantConversation} onConversationChange={setAssistantConversation} onBack={() => setLocalRoute('welcome')} onConfigure={() => setLocalRoute('assistant-settings')} />
              )
            ) : <>
              {LIFE_ASSISTANT_ENABLED ? <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: space[3], paddingTop: space[2] }}>
                <Button compact variant="ghost" label="先用生活助手" onPress={() => setLocalRoute('assistant')} />
              </View> : null}
              <PairScreen
                prefill={pairingPrefill}
                onCancel={connection ? () => setPairingPrefill(null) : undefined}
                onPaired={async (next) => {
                  await saveConnection(next)
                  setConnection(next)
                  setPairingPrefill(null)
                  setRoute({ name: 'home' })
                }}
              />
            </>}
          </View>
        ) : (
          <RemoteProvider connection={connection} onUnauthorized={unpair}>
            {booting ? <RemoteReady onReady={markRemoteReady} /> : null}
            {remoteBody()}
          </RemoteProvider>
        )}
        </View>
        </KeyboardAvoidingView>
        {booting ? <BootSplash ready={connection === null || (connection !== undefined && (!!pairingPrefill || remoteReady))} onDone={endBoot} /> : null}
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  side: { minWidth: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  banner: { maxHeight: '75%', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: 16, borderBottomRightRadius: 16, overflow: 'hidden' },
  scrim: { flex: 1 }
})
