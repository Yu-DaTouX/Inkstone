import { LIFE_ASSISTANT_ENABLED } from './features'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, BackHandler, Keyboard, KeyboardAvoidingView, Linking, Platform, StatusBar, useColorScheme, useWindowDimensions, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import type { Connection } from './api/client'
import type { PhotoDraft } from './device'
import { parsePairingLink, type PairingPrefill } from './pairLink'
import { restoreQuestionAlerts, startQuestionAlerts, stopQuestionAlerts } from './questionAlerts'
import { ArtifactScreen } from './screens/ArtifactScreen'
import { AgentHubScreen } from './screens/AgentHubScreen'
import { AssistantScreen, type AssistantConversation } from './screens/AssistantScreen'
import { AssistantSettingsScreen } from './screens/AssistantSettingsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { PairScreen } from './screens/PairScreen'
import { SessionScreen } from './screens/SessionScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { RemoteProvider, useRemote } from './state'
import { Button, EmptyState } from './ui'
import { clearConnection, loadConnection, saveConnection } from './storage'
import { space, usePalette } from './theme'
import { BootSplash, ContentEnter } from './motion'
import { useFoldLayout } from './foldLayout'
import { cancelSpeech, isSpeechActive } from './speech'

type Route =
  | { name: 'home' }
  | { name: 'assistant' }
  | { name: 'assistant-settings' }
  | { name: 'settings' }
  | { name: 'hub' }
  | { name: 'session'; sessionId: string; title: string }
  | { name: 'artifact'; sessionId: string; title: string; artifact: { id: string; filename: string; mediaType: string; kind: string } }

/**
 * 砚手机端：配对一台电脑 → 首页（等你回答的问题 + 会话）→ 会话（历史 / 回复 / 中止）→ 成果。
 * 路由与会话草稿由应用层保存，窗口和列表宽度变化不重置正在阅读的会话。
 */
/** 已配对时：会话列表首次返回、流连上或出错（任一有结论）即可撤启动画面 */
function RemoteReady({ onReady }: { onReady: () => void }) {
  const { sessions, stream, error } = useRemote()
  const settled = sessions.length > 0 || stream === 'open' || !!error
  useEffect(() => { if (settled) onReady() }, [settled, onReady])
  return null
}

export default function App() {
  const p = usePalette()
  const scheme = useColorScheme()
  const { width } = useWindowDimensions()
  const fold = useFoldLayout()
  const frameRef = useRef<View>(null)
  const [frame, setFrame] = useState({ x: 0, y: 0, width: 0, height: 0 })
  const extraGap = fold.orientation === 'vertical' ? Math.max(0, 12 - ((fold.right ?? 0) - (fold.left ?? 0))) : Math.max(0, 12 - ((fold.bottom ?? 0) - (fold.top ?? 0)))
  const vertical = fold.separating && fold.orientation === 'vertical' && frame.width > 0 ? {
    left: (fold.left ?? 0) - frame.x - extraGap / 2,
    gap: (fold.right ?? 0) - (fold.left ?? 0) + extraGap
  } : null
  const horizontal = fold.separating && fold.orientation === 'horizontal' && frame.height > 0 ? {
    top: (fold.top ?? 0) - frame.y - extraGap / 2,
    gap: (fold.bottom ?? 0) - (fold.top ?? 0) + extraGap
  } : null
  const verticalInside = vertical && vertical.left > 0 && vertical.left + vertical.gap < frame.width ? vertical : null
  const horizontalInside = horizontal && horizontal.top > 0 && horizontal.top + horizontal.gap < frame.height ? horizontal : null
  const twoPanes = !!verticalInside && verticalInside.left >= 220 && frame.width - verticalInside.left - verticalInside.gap >= 220
  const expanded = !horizontalInside && (verticalInside ? twoPanes : width >= 600)
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined)
  const [route, setRoute] = useState<Route>({ name: 'home' })
  /** 未配对时也能用生活助手：welcome = 配对页，assistant = 本机助手 */
  const [assistantConversation, setAssistantConversation] = useState<AssistantConversation>({ messages: [], draft: '' })
  const [localRoute, setLocalRoute] = useState<'welcome' | 'assistant' | 'assistant-settings'>('welcome')
  /** 助手设置的返回目标：从设置页进来就回设置，从对话页进来就回对话 */
  const assistantSettingsFrom = useRef<'assistant' | 'settings'>('assistant')
  const [pairingPrefill, setPairingPrefill] = useState<PairingPrefill | null>(null)
  const [alertsEnabled, setAlertsEnabled] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [photoDrafts, setPhotoDrafts] = useState<Record<string, PhotoDraft[]>>({})
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  /* 启动画面：读完配对信息；已配对再等首批会话（设计规范 §3.4.1） */
  const [booting, setBooting] = useState(true)
  const [remoteReady, setRemoteReady] = useState(false)
  const markRemoteReady = useCallback(() => setRemoteReady(true), [])
  const endBoot = useCallback(() => setBooting(false), [])
  const sidebarVisible = expanded && (!sidebarCollapsed || route.name === 'home')
  // Short windows use one unobstructed region. Tabletop chat reserves both regions.
  const tabletop = route.name === 'session' && horizontalInside && horizontalInside.top >= 140 && frame.height - horizontalInside.top - horizontalInside.gap >= 220 ? horizontalInside : null
  const pairing = connection === null || !!pairingPrefill
  const safeRegion = horizontalInside && !tabletop
    ? horizontalInside.top >= frame.height - horizontalInside.top - horizontalInside.gap
      ? { height: horizontalInside.top } : { marginTop: horizontalInside.top + horizontalInside.gap, flex: 1 }
    : verticalInside && (!twoPanes || pairing || !sidebarVisible)
      ? verticalInside.left >= frame.width - verticalInside.left - verticalInside.gap
        ? { width: verticalInside.left } : { marginLeft: verticalInside.left + verticalInside.gap, flex: 1 }
      : { flex: 1 }

  useEffect(() => {
    void loadConnection().then(setConnection)
  }, [])

  useEffect(() => {
    const receive = (url: string | null) => {
      if (!url) return
      if (url === 'inkstone://inbox') { setRoute({ name: 'home' }); return }
      if (url === 'inkstone://hub') { setRoute({ name: 'hub' }); return }
      const parsed = parsePairingLink(url)
      if (parsed) setPairingPrefill(parsed)
    }
    void Linking.getInitialURL().then(receive)
    const subscription = Linking.addEventListener('url', ({ url }) => receive(url))
    return () => subscription.remove()
  }, [])

  const unpair = useCallback(() => {
    void stopQuestionAlerts()
    void clearConnection()
    setConnection(null)
    setAlertsEnabled(false)
    setRoute({ name: 'home' })
    setProject(null)
    setDrafts({})
    setPhotoDrafts({})
  }, [])

  const enableAlerts = useCallback(async () => {
    if (!connection) return
    try { setAlertsEnabled(await startQuestionAlerts(connection, true)) }
    catch { setAlertsEnabled(false) }
  }, [connection])

  const onDraftChange = useCallback((sessionId: string, text: string) => {
    setDrafts((current) => ({ ...current, [sessionId]: text }))
  }, [])

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
      if (pairingPrefill && connection) {
        setPairingPrefill(null)
        return true
      }
      if (!connection && localRoute !== 'welcome') { setLocalRoute(localRoute === 'assistant-settings' ? 'assistant' : 'welcome'); return true }
      if (route.name === 'assistant-settings') { setRoute(assistantSettingsFrom.current === 'settings' ? { name: 'settings' } : { name: 'assistant' }); return true }
      if (route.name === 'assistant') { setRoute({name: 'home'}); return true }
      if (route.name === 'artifact') {
        setRoute({ name: 'session', sessionId: route.sessionId, title: route.title })
        return true
      }
      if (route.name === 'session' || route.name === 'settings' || route.name === 'hub') {
        setRoute({ name: 'home' })
        return true
      }
      if (project) { setProject(null); return true }
      return false
    })
    return () => sub.remove()
  }, [connection, pairingPrefill, route, project, localRoute])

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} backgroundColor={p.bg1} />
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg1 }}>
        {/*
          * Android 不包 KAV：AndroidManifest 已设 windowSoftInputMode="adjustResize"，系统自己收缩窗口。
          * height 模式会把高度锁在首次测量值上，旋转或折叠展开后不重新收缩，底部输入框被推到屏幕外。
          */}
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={frame.y} style={{ flex: 1 }}>
        <View ref={frameRef} collapsable={false} onLayout={() => frameRef.current?.measureInWindow((x, y, measuredWidth, height) => setFrame({ x, y, width: measuredWidth, height }))} style={{ flex: 1 }}>
        {connection === undefined ? null : connection === null || pairingPrefill ? (
          localRoute !== 'welcome' && !pairingPrefill ? (
            <View style={safeRegion}>{localRoute === 'assistant-settings' ? (
              <AssistantSettingsScreen onBack={() => setLocalRoute('assistant')} />
            ) : (
              <AssistantScreen conversation={assistantConversation} onConversationChange={setAssistantConversation} onBack={() => setLocalRoute('welcome')} onConfigure={() => setLocalRoute('assistant-settings')} />
            )}</View>
          ) : (
          <View style={safeRegion}>
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
          </View>
          )
        ) : (
          /* 令牌被撤销（401）时回到配对页 */
          <RemoteProvider connection={connection} onUnauthorized={unpair}>
            {booting ? <RemoteReady onReady={markRemoteReady} /> : null}
            <View style={[safeRegion, { flexDirection: expanded ? 'row' : 'column' }]}>
              {(expanded || route.name === 'home') ? (
                <View style={expanded ? { display: sidebarVisible ? 'flex' : 'none', width: verticalInside?.left ?? Math.min(380, Math.round(width * 0.42)), borderRightWidth: 1, borderRightColor: p.borderSoft } : { flex: 1 }}>
                  <HomeScreen
                    onOpen={(sessionId, title) => setRoute({ name: 'session', sessionId, title })}
                    onSettings={() => setRoute({ name: 'settings' })}
                    onHub={() => setRoute({ name: 'hub' })}
                    onOpenAssistant={() => setRoute({ name: 'assistant' })}
                    alertsEnabled={alertsEnabled}
                    onEnableAlerts={() => void enableAlerts()}
                    selectedSessionId={'sessionId' in route ? route.sessionId : undefined}
                    project={project}
                    onProjectChange={setProject}
                  />
                </View>
              ) : null}
              {sidebarVisible && verticalInside ? <View style={{ width: verticalInside.gap }} /> : null}
              {(expanded || route.name !== 'home') ? (
                <ContentEnter key={route.name === 'session' ? route.sessionId : route.name}>
                  {route.name === 'hub' ? <AgentHubScreen onBack={() => setRoute({ name: 'home' })} /> : route.name === 'settings' ? (
                    <SettingsScreen
                      connection={connection}
                      alertsEnabled={alertsEnabled}
                      onEnableAlerts={() => void enableAlerts()}
                      onDisableAlerts={() => { void stopQuestionAlerts(); setAlertsEnabled(false) }}
                      onUnpair={unpair}
                      onBack={() => setRoute({ name: 'home' })}
                      sidebarVisible={sidebarVisible}
                      onToggleSidebar={expanded ? () => setSidebarCollapsed((current) => !current) : undefined}
                      onOpenAssistantSettings={() => { assistantSettingsFrom.current = 'settings'; setRoute({ name: 'assistant-settings' }) }}
                    />
                  ) : route.name === 'session' ? (
                    <SessionScreen
                      key={route.sessionId}
                      sessionId={route.sessionId}
                      title={route.title}
                      onBack={() => setRoute({ name: 'home' })}
                      onOpenArtifact={(artifact) => setRoute({ name: 'artifact', sessionId: route.sessionId, title: route.title, artifact })}
                      draft={drafts[route.sessionId] ?? ''}
                      onDraftChange={(text) => onDraftChange(route.sessionId, text)}
                      photos={photoDrafts[route.sessionId] ?? []}
                      onPhotosChange={(photos) => setPhotoDrafts((current) => ({ ...current, [route.sessionId]: photos }))}
                      tabletop={tabletop ?? undefined}
                      sidebarVisible={sidebarVisible}
                      onToggleSidebar={expanded ? () => setSidebarCollapsed((current) => !current) : undefined}
                    />
                  ) : route.name === 'artifact' ? (
                    <ArtifactScreen
                      sessionId={route.sessionId}
                      artifact={route.artifact}
                      onBack={() => setRoute({ name: 'session', sessionId: route.sessionId, title: route.title })}
                      sidebarVisible={sidebarVisible}
                      onToggleSidebar={expanded ? () => setSidebarCollapsed((current) => !current) : undefined}
                    />
                  ) : route.name === 'assistant' ? (
                    <AssistantScreen conversation={assistantConversation} onConversationChange={setAssistantConversation} onBack={() => setRoute({ name: 'home' })} onConfigure={() => { assistantSettingsFrom.current = 'assistant'; setRoute({ name: 'assistant-settings' }) }} />
                  ) : route.name === 'assistant-settings' ? (
                    <AssistantSettingsScreen onBack={() => setRoute(assistantSettingsFrom.current === 'settings' ? { name: 'settings' } : { name: 'assistant' })} />
                  ) : (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                      <EmptyState>选择会话</EmptyState>
                    </View>
                  )}
                </ContentEnter>
              ) : null}
            </View>
          </RemoteProvider>
        )}
        </View>
        </KeyboardAvoidingView>
        {booting ? <BootSplash ready={connection === null || (connection !== undefined && (!!pairingPrefill || remoteReady))} onDone={endBoot} /> : null}
      </SafeAreaView>
    </SafeAreaProvider>
  )
}
