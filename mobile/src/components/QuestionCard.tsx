import { pick } from '../../../src/shared/ui-lang'
import { useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import type { RemoteAnswer, RemotePendingQuestion } from '../../../src/shared/remote-protocol'
import { capabilityAllowed } from '../../../src/shared/capability-negotiation'
import { idempotencyKey, RemoteHttpError } from '../api/client'
import { SpeechInputButton } from './SpeechInputButton'
import { QuestionForm } from './QuestionForm'
import { Icon } from '../icons'
import { useRemote } from '../state'
import { font, icon, mono, radius, space, usePalette, weight } from '../theme'
import { Button, Input, STATUS_TEXT } from '../ui'

type ApprovalInfo = { kind?: string; tool?: string; detail?: string; reasons?: string[]; cwd?: string }

export function approvalInfo(question: RemotePendingQuestion): ApprovalInfo | null {
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
  onAnswer,
  compact = false
}: {
  question: RemotePendingQuestion
  sessionTitle?: string
  onAnswer: (answer: RemoteAnswer, key: string) => Promise<unknown>
  compact?: boolean
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
      setError(err instanceof Error ? err.message : pick('回答没发出去，请重试', 'Answer not sent. Try again.'))
    } finally {
      setBusy(false)
    }
  }
  const send = (answer: RemoteAnswer) => submit(JSON.stringify(answer), (key) => onAnswer(answer, key))
  const decide = (confirmed: boolean) => submit(`approval:${confirmed}`, (key) => client.approve(question, confirmed, key).finally(() => refresh()))

  const tone = approval || question.sensitive ? p.warn : p.accent
  return (
    <View style={[styles.card, compact && styles.compact, { backgroundColor: p.surface, borderColor: risky ? p.warn : p.border }]}>
      <View style={styles.head}>
        <Icon name={approval ? 'alert-circle' : 'bell'} size={icon.sm} color={tone} />
        <Text style={{ color: tone, fontSize: font.xs }}>{approval ? pick('等待批准', 'Awaiting approval') : question.sensitive ? pick('需要在电脑上确认', 'Confirm on the desktop') : STATUS_TEXT.wait}</Text>
        {sessionTitle ? <Text numberOfLines={1} style={[styles.session, { color: p.fgMute }]}>{sessionTitle}</Text> : null}
      </View>
      {question.title ? <Text style={!approval && question.message ? [styles.kicker, { color: p.fgDim }] : [styles.title, { color: p.fg }]}>{question.title}</Text> : null}

      {approval && compact ? (approval.detail ? <Text numberOfLines={1} style={{ color: p.fgDim, fontFamily: mono, fontSize: font.xs }}>{approval.detail.split('\n')[0]}</Text> : null) : approval ? <>
        {approval.reasons?.length ? <View style={{ gap: 2 }}>{approval.reasons.map((reason, index) => <Text key={index} style={[styles.message, { color: p.fgDim }]}>· {reason}</Text>)}</View> : null}
        {approval.cwd ? <Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs }}>{pick('目录：', 'Folder: ')}{approval.cwd}</Text> : null}
        {approval.detail ? <ScrollView nestedScrollEnabled style={[styles.detail, { backgroundColor: p.sunken }]}><Text selectable style={{ color: p.fgDim, fontFamily: mono, fontSize: font.xs, lineHeight: 17 }}>{approval.detail}</Text></ScrollView> : null}
      </> : question.message ? <Text selectable style={[styles.question, { color: p.fg }]}>{question.message}</Text> : null}

      {canApprove ? (
        <View style={styles.row}>
          <Button label={pick('拒绝', 'Deny')} busy={busy} style={styles.flex} onPress={() => void decide(false)} />
          <Button label={pick('允许这一次', 'Allow once')} variant="primary" busy={busy} style={styles.flex} onPress={() => void decide(true)} />
        </View>
      ) : question.sensitive ? (
        <View style={styles.actions}>
          <Text style={[styles.note, { color: p.fgMute }]}>{approval ? pick('电脑端版本较旧，请到电脑上批准；在手机上只能拒绝。', 'Desktop is outdated. Approve on the desktop; you can only deny here.') : pick('这是敏感操作，请到电脑上确认；在手机上只能拒绝。', 'Sensitive action. Confirm on the desktop; you can only deny here.')}</Text>
          <Button label={pick('拒绝', 'Deny')} variant="danger" busy={busy} onPress={() => void send({ cancelled: true })} />
        </View>
      ) : question.form?.length ? (
        <QuestionForm fields={question.form} busy={busy} onSubmit={(json) => void send({ value: json })} onSkip={() => void send({ cancelled: true })} />
      ) : question.method === 'confirm' ? (
        <View style={styles.row}>
          <Button label={pick('不同意', 'No')} busy={busy} style={styles.flex} onPress={() => void send({ confirmed: false })} />
          <Button label={pick('同意', 'Yes')} variant="primary" busy={busy} style={styles.flex} onPress={() => void send({ confirmed: true })} />
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
            placeholder={question.method === 'select' ? pick('或自行撰写回复', 'Or write your own reply') : question.placeholder || pick('写下你的回答', 'Write your answer')}
            accessibilityLabel={pick('回答内容', 'Answer')}
          />
          <SpeechInputButton onText={(spoken) => setText((current) => current.trim() ? `${current.trimEnd()} ${spoken}` : spoken)} onStateChange={(state) => setVoiceBusy(state !== 'idle')} disabled={busy} />
          <View style={styles.row}>
            <Button label={pick('跳过', 'Skip')} variant="ghost" busy={busy} disabled={voiceBusy} onPress={() => void send({ cancelled: true })} />
            <Button
              label={pick('发送回答', 'Send answer')}
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
  compact: { marginBottom: 0 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  session: { flex: 1, textAlign: 'right', fontSize: font.xs },
  title: { fontSize: font.body, fontWeight: weight.medium },
  message: { fontSize: font.sm, lineHeight: 20 },
  kicker: { fontSize: font.xs },
  question: { fontSize: font.body, lineHeight: 22 },
  detail: { maxHeight: 180, borderRadius: radius.md, padding: space[2] },
  actions: { gap: space[2], marginTop: space[1] },
  row: { flexDirection: 'row', gap: space[2], marginTop: space[1] },
  flex: { flex: 1 },
  note: { fontSize: font.sm },
  input: { paddingVertical: space[3], fontSize: font.body },
  error: { fontSize: font.sm }
})
