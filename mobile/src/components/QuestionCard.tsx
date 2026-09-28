import { useRef, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import type { RemoteAnswer, RemotePendingQuestion } from '../../../src/shared/remote-protocol'
import { idempotencyKey, RemoteHttpError } from '../api/client'
import { SpeechInputButton } from './SpeechInputButton'
import { font, radius, space, touch, usePalette } from '../theme'
import { Badge, Button } from '../ui'

/**
 * 一个等待回答的问题。
 *
 * 敏感确认（删除、授权、付费……）在手机上只能「拒绝」：同意必须在电脑上做（需求稿第 6 节）。
 * 提交用幂等键，弱网重试不会重复作答；已被电脑端答复时服务端返回 409，这里当作「已处理」。
 */
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
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attempt = useRef<{ value: string; key: string } | null>(null)

  const send = async (answer: RemoteAnswer): Promise<void> => {
    setBusy(true)
    setError(null)
    const value = JSON.stringify(answer)
    const key = attempt.current?.value === value ? attempt.current.key : idempotencyKey()
    attempt.current = { value, key }
    try {
      await onAnswer(answer, key)
      attempt.current = null
    } catch (err) {
      if (err instanceof RemoteHttpError && (err.status === 409 || err.status === 404)) {
        attempt.current = null
        return
      }
      if (!(err instanceof RemoteHttpError) || err.status !== 0) attempt.current = null
      setError(err instanceof Error ? err.message : '回答没发出去，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[styles.card, { backgroundColor: p.bg1, borderColor: question.sensitive ? p.warn : p.accent }]}>
      <View style={styles.head}>
        <Badge tone={question.sensitive ? 'warn' : 'accent'}>{question.sensitive ? '需要在电脑上确认' : '等你回答'}</Badge>
        {sessionTitle ? <Text numberOfLines={1} style={[styles.session, { color: p.fgMute }]}>{sessionTitle}</Text> : null}
      </View>
      {question.title ? <Text style={[styles.title, { color: p.fg }]}>{question.title}</Text> : null}
      {question.message ? <Text style={[styles.message, { color: p.fgDim }]}>{question.message}</Text> : null}

      {question.sensitive ? (
        <View style={styles.actions}>
          <Text style={[styles.note, { color: p.fgMute }]}>这是敏感操作，请到电脑上确认；在手机上只能拒绝。</Text>
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
          <TextInput
            disableFullscreenUI
            style={[styles.input, { backgroundColor: p.bg2, borderColor: p.border, color: p.fg }]}
            value={text}
            onChangeText={setText}
            multiline={question.method === 'editor' || question.method === 'input'}
            placeholder={question.method === 'select' ? '或自行撰写回复' : question.placeholder || '写下你的回答'}
            placeholderTextColor={p.fgMute}
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
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[2], marginBottom: space[3] },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  session: { flex: 1, fontSize: font.xs },
  title: { fontSize: font.body, fontWeight: '600' },
  message: { fontSize: font.base, lineHeight: 22 },
  actions: { gap: space[2], marginTop: space[1] },
  row: { flexDirection: 'row', gap: space[2], marginTop: space[1] },
  flex: { flex: 1 },
  note: { fontSize: font.sm },
  input: { minHeight: touch.min, borderWidth: 1, borderRadius: radius.md, padding: space[3], fontSize: font.body },
  error: { fontSize: font.sm }
})
