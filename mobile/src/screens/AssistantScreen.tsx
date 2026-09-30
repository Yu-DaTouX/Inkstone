/** A phone conversation with an explicitly configured provider. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native'
import { Icon } from '../icons'
import { Markdown } from '../components/Markdown'
import { SpeechInputButton } from '../components/SpeechInputButton'
import { useLifePalette } from '../life'
import { font, icon, radius, space, touch } from '../theme'
import { EmptyState, Header, IconButton, Input, Meta } from '../ui'
import { chat, type ChatMessage } from '../assistant/model'
import { activeProvider, loadSettings, type AssistantSettings } from '../assistant/store'

/** 助手的基本分寸；记忆与事项的规则在 P3 之后由 core 统一提供，这里先给最小版本。 */
const SYSTEM_PROMPT = '你是用户的生活助手，用中文简短直接地回答。不确定的事就说不知道。你没有提醒、长期记忆或设备操作工具，不得声称已保存信息或已设置提醒。'

type LifeMessage = {
  id: string
  replyTo?: string
  role: 'user' | 'assistant'
  text: string
  at: number
  /** 助手消息仍在输出 */
  pending?: boolean
  error?: string
}

export type AssistantConversation = { messages: LifeMessage[]; draft: string }

export function AssistantScreen({ onBack, onOpenSettings, onConfigure, conversation, onConversationChange }: {
  conversation?: AssistantConversation
  onConversationChange?: (value: AssistantConversation) => void
  onBack: () => void
  onOpenSettings?: () => void
  /** 点「去配置模型」时跳设置；没有设置页时退化为提示 */
  onConfigure?: () => void
}) {
  const p = useLifePalette()
  const [messages, setMessages] = useState<LifeMessage[]>(conversation?.messages ?? [])
  const [draft, setDraft] = useState(conversation?.draft ?? '')
  const [sending, setSending] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const scrollRef = useRef<ScrollView | null>(null)
  const mounted = useRef(true)
  const request = useRef<AbortController | null>(null)
  const latest = useRef<AssistantConversation>({messages, draft})
  latest.current = {messages, draft}
  useEffect(() => { onConversationChange?.({messages, draft}) }, [messages, draft, onConversationChange])
  const provider = settings ? activeProvider(settings) : null

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current?.abort()
      onConversationChange?.({ ...latest.current, messages: latest.current.messages.map(message => message.pending ? {...message, pending: false, error: '已取消，可重试'} : message) })
    }
  }, [onConversationChange])

  useEffect(() => {
    let alive = true
    void loadSettings().then((next) => { if (alive) setSettings(next) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 40)
    return () => clearTimeout(timer)
  }, [messages])

  const runReply = useCallback(async (question: string, replyId: string, history: LifeMessage[]) => {
    if (!provider) { setSending(false); return }
    const controller = new AbortController()
    request.current = controller
    try {
      const payload: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.filter((m) => m.text.trim().length > 0).map((m) => ({ role: m.role, content: m.text })),
        { role: 'user', content: question }
      ]
      const result = await chat({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, temperature: provider.temperature, messages: payload, signal: controller.signal })
      if (!mounted.current) return
      setMessages((current) => current.map((m) => (m.id === replyId ? { ...m, text: result.text, pending: false } : m)))
    } catch (error) {
      if (!mounted.current) return
      const message = error instanceof Error ? error.message : '发送失败'
      setMessages((current) => current.map((m) => (m.id === replyId ? { ...m, pending: false, text: '', error: message } : m)))
    } finally {
      request.current = null
      if (mounted.current) setSending(false)
    }
  }, [provider])

  const send = useCallback((raw: string) => {
    const text = raw.trim()
    if (!text || sending || !provider || request.current) return
    const at = Date.now()
    const history = messages
    const replyId = `a-${at}`
    setMessages((current) => [...current, { id: `u-${at}`, role: 'user', text, at }, { id: replyId, replyTo: `u-${at}`, role: 'assistant', text: '', at, pending: true }])
    setDraft('')
    setSending(true)
    void runReply(text, replyId, history)
  }, [messages, runReply, sending, provider])

  const retry = useCallback((message: LifeMessage) => {
    const question = message.replyTo ? messages.find(m => m.id === message.replyTo) : [...messages].reverse().find((m) => m.role === 'user' && m.at <= message.at)
    if (!question || sending) return
    const history = messages.filter((m) => m.at < question.at)
    const replyId = `a-${Date.now()}`
    setMessages((current) => [...current.filter((m) => m.id !== message.id), { id: replyId, replyTo: question.id, role: 'assistant', text: '', at: Date.now(), pending: true }])
    setSending(true)
    void runReply(question.text, replyId, history)
  }, [messages, runReply, sending])


  /** 编辑用户消息：把那一条之后的对话去掉，内容放回输入框。 */
  const editUser = useCallback((message: LifeMessage) => {
    const index = messages.findIndex((m) => m.id === message.id)
    if (index < 0) return
    setDraft(message.text)
    setMessages((current) => current.slice(0, index))
    setSending(false)
  }, [messages])

  /** 重新生成：删掉这条回复，用它上面的那条用户消息重跑。 */
  const regenerate = useCallback((message: LifeMessage) => {
    if (sending) return
    const index = messages.findIndex((m) => m.id === message.id)
    if (index < 0) return
    const question = [...messages.slice(0, index)].reverse().find((m) => m.role === 'user')
    if (!question) return
    const history = messages.slice(0, messages.indexOf(question))
    const replyId = `a-${Date.now()}`
    setMessages((current) => [...current.slice(0, index), { id: replyId, replyTo: question.id, role: 'assistant', text: '', at: Date.now(), pending: true }])
    setSending(true)
    void runReply(question.text, replyId, history)
  }, [messages, runReply, sending])

  const openMenu = useCallback((message: LifeMessage) => {
    if (message.pending) return
    if (message.role === 'user') {
      Alert.alert('你的消息', undefined, [
        { text: '编辑', onPress: () => editUser(message) },
        { text: '分享', onPress: () => void Share.share({ message: message.text }) },
        { text: '取消', style: 'cancel' }
      ])
      return
    }
    Alert.alert('助手回复', undefined, [
      { text: '重新生成', onPress: () => regenerate(message) },
      { text: '分享', onPress: () => void Share.share({ message: message.text }) },
      { text: '取消', style: 'cancel' }
    ])
  }, [editUser, regenerate])

  const configure = useCallback(() => {
    if (onConfigure) onConfigure()
    else Alert.alert('配置模型', '在「模型与服务商」里填入地址、密钥和模型名，就可以用真实模型对话了。')
  }, [onConfigure])

  const renderMessage = (m: LifeMessage) => {
    const isUser = m.role === 'user'
    return (
      <View key={m.id} style={[styles.row, { alignItems: isUser ? 'flex-end' : 'flex-start' }]}>
        <Pressable
          onLongPress={() => openMenu(m)}
          delayLongPress={350}
          accessibilityRole="button"
          accessibilityLabel={isUser ? '你的消息，长按可编辑或分享' : '助手回复，长按可重新生成或分享'}
          style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant, { backgroundColor: isUser ? p.accentSoft : p.bg2, borderColor: p.borderSoft }]}
        >
          {isUser
            ? <Text style={[styles.bubbleText, { color: p.fg }]}>{m.text.length ? m.text : ' '}</Text>
            : <Markdown text={m.text.length ? m.text : ' '} color={p.fg} codeBg={p.bg3} accent={p.accent} />}
        </Pressable>
        {m.pending ? <Meta style={{ marginTop: space[1] }}>正在等待回复…</Meta> : null}
        {m.error ? (
          <View style={{ marginTop: space[1], gap: space[1] }}>
            <Text style={{ color: p.err, fontSize: font.sm }}>{m.error}</Text>
            <Pressable accessibilityRole="button" onPress={() => retry(m)}>
              <Text style={{ color: p.accent, fontSize: font.sm }}>重试</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: p.bg0 }}>
      <Header
        title="生活助手"
        subtitle={provider ? `${provider.label} · ${provider.model}` : '尚未配置模型'}
        left={<IconButton name="back" label="返回" onPress={onBack} />}
        right={<IconButton name="settings" label="助手设置" onPress={onOpenSettings ?? configure} />}
      />
      {!provider ? (
        <Pressable accessibilityRole="button" onPress={configure} style={[styles.notice, { borderBottomColor: p.borderSoft, backgroundColor: p.warnSoft }]}>
          <Icon name="key" size={icon.sm} color={p.warn} />
          <Text style={{ color: p.fg, fontSize: font.sm, flex: 1 }}>配置模型后即可对话。点这里添加服务商。</Text>
          <Icon name="chevron-right" size={icon.sm} color={p.fgMute} />
        </Pressable>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space[4], gap: space[4] }}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
          <View style={{ paddingTop: space[6], gap: space[2] }}>
            <EmptyState>说点什么。此对话提供模型回答，暂不设置系统提醒。</EmptyState>
            {!provider ? <EmptyState>添加模型服务商后可以发送消息。</EmptyState> : null}
          </View>
        ) : messages.map(renderMessage)}
      </ScrollView>
      {speechError ? <Meta style={{ paddingHorizontal: space[4], color: p.warn }}>{speechError}</Meta> : null}
      <View style={[styles.composer, { borderTopColor: p.borderSoft, backgroundColor: p.bg1 }]}>
        <SpeechInputButton onText={(text) => setDraft((current) => (current ? `${current}${text}` : text))} onError={setSpeechError} disabled={sending} />
        <Input
          style={styles.input}
          multiline
          value={draft}
          onChangeText={setDraft}
          placeholder="说点什么…"
          accessibilityLabel="输入内容"
        />
        <IconButton name="send" primary label="发送" disabled={!provider || !draft.trim() || sending} onPress={() => send(draft)} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { gap: space[1] },
  bubble: { maxWidth: '86%', borderWidth: 1, paddingHorizontal: space[3], paddingVertical: space[2] },
  bubbleUser: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.sm },
  bubbleAssistant: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderBottomLeftRadius: radius.sm, borderBottomRightRadius: radius.lg },
  bubbleText: { fontSize: font.body, lineHeight: 24 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[4], paddingVertical: space[2], borderBottomWidth: StyleSheet.hairlineWidth },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space[1], paddingHorizontal: space[2], paddingVertical: space[2], borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, maxHeight: 120, minHeight: touch.min }
})
