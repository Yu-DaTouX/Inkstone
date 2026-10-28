import { useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import type { RemoteAnswer, RemotePendingQuestion } from '../../../src/shared/remote-protocol'
import { capabilityAllowed } from '../../../src/shared/capability-negotiation'
import { idempotencyKey, RemoteHttpError } from '../api/client'
import { SpeechInputButton } from './SpeechInputButton'
import { Icon } from '../icons'
import { useRemote } from '../state'
import { font, icon, mono, radius, space, usePalette, weight } from '../theme'
import { Button, Input, STATUS_TEXT } from '../ui'

type ApprovalInfo = { kind?: string; tool?: string; detail?: string; reasons?: string[]; cwd?: string }

function approvalInfo(question: RemotePendingQuestion): ApprovalInfo | null {
  if (!question.id.startsWith('approval:')) return null
  try {
    const parsed = JSON.parse(question.message) as ApprovalInfo
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function QuestionCard({
  question,
  sessionTitle,
  onAnswer
}: {
  question: RemotePendingQuestion
  sessionTitle?: string
  onAnswer: (answer: RemoteAnswer, key: string) => Promise<unknown>
}) {
  const p = usePalette()
  const { client, info, refresh } = useRemote()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attempt = useRef<{ value: string; key: string } | null>(null)
  const approval = approvalInfo(question)
  const canApprove = !!approval && !!question.approvalDigest && capabilityAllowed(info, 'human-approval')
  const risky = approval?.kind === 'danger' || approval?.kind === 'outside' || approval?.kind === 'delete'

  const submit = async (value: string, run: (key: string) => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    const key = attempt.current?.value === value ? attempt.current.key : idempotencyKey()
    attempt.current = { value, key }
    try {
      await run(key)
      attempt.current = null
    } catch (err) {
      if (err instanceof RemoteHttpError && (err.status === 409 || err.status === 404)) {
        attempt.current = null
        if (err.status === 409) setError(err.message)
        return
      }
      if (!(err instanceof RemoteHttpError) || err.status !== 0) attempt.current = null
      setError(err instanceof Error ? err.message : '回答没发出去，请重试')
    } finally {
      setBusy(false)
    }
  }
  const send = (answer: RemoteAnswer) => submit(JSON.stringify(answer), (key) => onAnswer(answer, key))
  const decide = (confirmed: boolean) => submit(`approval:${confirmed}`, (key) => client.approve(question, confirmed, key).finally(() => refresh()))

  const tone = approval || question.sensitive ? p.warn : p.accent
  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: risky ? p.warn : p.border }]}>
      <View style={styles.head}>
        <Icon name={approval ? 'alert-circle' : 'bell'} size={icon.sm} color={tone} />
        <Text style={{ color: tone, fontSize: font.xs }}>{approval ? '等待批准' : question.sensitive ? '需要在电脑上确认' : STATUS_TEXT.wait}</Text>
        {sessionTitle ? <Text numberOfLines={1} style={[styles.session, { color: p.fgMute }]}>{sessionTitle}</Text> : null}
      </View>
      {question.title ? <Text style={[styles.title, { color: p.fg }]}>{question.title}</Text> : null}

      {approval ? <>
        {approval.reasons?.length ? <View style={{ gap: 2 }}>{approval.reasons.map((reason, index) => <Text key={index} style={[styles.message, { color: p.fgDim }]}>· {reason}</Text>)}</View> : null}
        {approval.cwd ? <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs }}>目录：{approval.cwd}</Text> : null}
        {approval.detail ? <ScrollView nestedScrollEnabled style={[styles.detail, { backgroundColor: p.sunken }]}><Text selectable style={{ color: p.fgDim, fontFamily: mono, fontSize: font.xs, lineHeight: 17 }}>{approval.detail}</Text></ScrollView> : null}
      </> : question.message ? <Text style={[styles.message, { color: p.fgDim }]}>{question.message}</Text> : null}

      {canApprove ? (
        <View style={styles.row}>
          <Button label="拒绝" busy={busy} style={styles.flex} onPress={() => void decide(false)} />
          <Button label="允许这一次" variant="primary" busy={busy} style={styles.flex} onPress={() => void decide(true)} />
        </View>
      ) : question.sensitive ? (
        <View style={styles.actions}>
          <Text style={[styles.note, { color: p.fgMute }]}>{approval ? '电脑端版本较旧，请到电脑上批准；在手机上只能拒绝。' : '这是敏感操作，请到电脑上确认；在手机上只能拒绝。'}</Text>
          <Button label="拒绝" variant="danger" busy={busy} onPress={() => void send({ cancelled: true })} />
        </View>
      ) : question.method === 'confirm' ? (
        <View style={styles.row}>
          <Button label="不同意" busy={busy} style={styles.flex} onPress={() => void send({ confirmed: false })} />
          <Button label="同意" variant="primary" busy={busy} style={styles.flex} onPress={() => void send({ confirmed: true })} />
        </View>
      ) : (
        <View style={styles.actions}>
          {question.method === 'select'
            ? (question.options ?? []).map((option) => (
                <Button key={option} label={option} busy={busy} onPress={() => void send({ value: option })} />
              ))
            : null}
          <Input
            style={styles.input}
            value={text}
            onChangeText={setText}
            multiline={question.method === 'editor' || question.method === 'input'}
            placeholder={question.method === 'select' ? '或自行撰写回复' : question.placeholder || '写下你的回答'}
            accessibilityLabel="回答内容"
          />
          <SpeechInputButton onText={(spoken) => setText((current) => current.trim() ? `${current.trimEnd()} ${spoken}` : spoken)} onStateChange={(state) => setVoiceBusy(state !== 'idle')} disabled={busy} />
          <View style={styles.row}>
            <Button label="跳过" variant="ghost" busy={busy} disabled={voiceBusy} onPress={() => void send({ cancelled: true })} />
            <Button
              label="发送回答"
              variant="primary"
              busy={busy}
              disabled={!text.trim() || voiceBusy}
              style={styles.flex}
              onPress={() => void send({ value: text.trim() })}
            />
          </View>
        </View>
      )}
      {error ? <Text style={[styles.error, { color: p.err }]}>{error}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space[3], gap: space[2], marginBottom: space[3] },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  session: { flex: 1, textAlign: 'right', fontSize: font.xs },
  title: { fontSize: font.body, fontWeight: weight.medium },
  message: { fontSize: font.sm, lineHeight: 20 },
  detail: { maxHeight: 180, borderRadius: radius.md, padding: space[2] },
  actions: { gap: space[2], marginTop: space[1] },
  row: { flexDirection: 'row', gap: space[2], marginTop: space[1] },
  flex: { flex: 1 },
  note: { fontSize: font.sm },
  input: { paddingVertical: space[3], fontSize: font.body },
  error: { fontSize: font.sm }
})
