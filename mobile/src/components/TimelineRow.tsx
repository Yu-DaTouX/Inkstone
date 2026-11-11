import { pick } from '../../../src/shared/ui-lang'
import { memo } from 'react'
import { Alert, Pressable, Share, StyleSheet, Text, View } from 'react-native'
import { classifyModelError, type ModelErrorKind } from '../../../src/shared/model-errors'
import { redactCommandSecrets } from '../../../src/shared/command-redact'
import type { RemoteClient } from '../api/client'
import type { IconName } from '../../../src/renderer/src/icons/sprite'
import { Icon } from '../icons'
import { GlyphSpinner } from '../motion'
import { font, icon, mono, radius, space, usePalette } from '../theme'
import { Meta } from '../ui'
import { LIVE_STEPS, type ImageRef, type TimelineEntry } from '../timeline'
import { CodeBlock, MessageBody } from './MessageBody'
import { RemoteImage } from './RemoteImage'

function toolIcon(name: string): IconName {
  if (/bash|shell|exec|command|terminal/i.test(name)) return 'terminal'
  if (/read|view|cat/i.test(name)) return 'file'
  if (/write|edit|patch|apply/i.test(name)) return 'pencil'
  if (/grep|find|glob|search|ls/i.test(name)) return 'search'
  if (/web|fetch|browser|url/i.test(name)) return 'globe'
  if (/agent|subagent|task/i.test(name)) return 'agent'
  if (/todo|plan/i.test(name)) return 'checklist'
  return 'activity'
}

function spanText(ms?: number): string {
  if (!ms || ms < 1000) return ''
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const clock = (at?: number) => at ? new Date(at).toTimeString().slice(0, 5) : ''

export function errorTitle(kind: ModelErrorKind): string {
  if (kind === 'quota') return pick('额度用完或被限流', 'Quota or rate limit reached')
  if (kind === 'auth') return pick('登录或密钥失效', 'Sign-in or key problem')
  if (kind === 'context') return pick('上下文超出模型上限', 'Context is too long for the model')
  if (kind === 'request') return pick('模型或请求配置不受支持', 'Model or request not supported')
  if (kind === 'refused') return pick('被服务商安全审核拦截', 'Blocked by the provider\'s safety filter')
  if (kind === 'aborted') return pick('本轮已取消', 'This turn was cancelled')
  if (kind === 'truncated') return pick('输出被截断', 'Output cut off')
  return pick('模型请求出错', 'Model request failed')
}

function quoted(text: string): string {
  return `${text.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`
}

export interface TimelineRowProps {
  item: TimelineEntry
  live: boolean
  expandedTools: readonly string[]
  client: RemoteClient
  sessionId: string
  modelName: string
  onToggle(key: string): void
  onView(image: ImageRef & { label: string }): void
  onOpenArtifact(artifact: { id: string; filename: string; mediaType: string; kind: string }): void
  onCompose?(text: string): void
  onRetry?(): void
  onCompact?(): void
}

export const TimelineRow = memo(function TimelineRow({ item, live, expandedTools, client, sessionId, modelName, onToggle, onView, onOpenArtifact, onCompose, onRetry, onCompact }: TimelineRowProps) {
  const p = usePalette()
  if (item.kind === 'notice') {
    const open = !!item.body && expandedTools.includes(item.key)
    const time = clock(item.message.timestamp)
    return <View style={styles.notice}>
      <Pressable accessibilityRole={item.body ? 'button' : 'text'} accessibilityState={item.body ? { expanded: open } : undefined} accessibilityLabel={[item.label, time].filter(Boolean).join(' ')} disabled={!item.body} onPress={() => onToggle(item.key)} style={styles.noticeHead}>
        <View style={[styles.rule, { backgroundColor: p.borderSoft }]} />
        <Icon name={item.icon} size={14} color={p.fgMute} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: p.fgMute, fontSize: font.xs }}>{item.label}</Text>
        {time ? <Text style={{ color: p.fgMute, fontSize: font.xs, fontFamily: mono }}>{time}</Text> : null}
        {item.body ? <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevron-right" size={12} color={p.fgMute} /></View> : null}
        <View style={[styles.rule, { backgroundColor: p.borderSoft }]} />
      </Pressable>
      {open && item.body ? <MessageBody text={item.body} /> : null}
    </View>
  }
  if (item.kind === 'process') {
    const expanded = expandedTools.includes(item.key)
      const parts = [item.actions ? pick(`${item.actions} 次操作`, `${item.actions} actions`) : '', item.thinking ? pick(`${item.thinking} 段思考`, `${item.thinking} thoughts`) : '', item.images ? pick(`${item.images} 张图`, `${item.images} images`) : '', spanText(item.ms)].filter(Boolean).join(' · ')
    const shown = expanded ? item.steps : live ? item.steps.slice(-LIVE_STEPS) : []
    return <View style={styles.process}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={pick(`过程，${parts}${item.failed ? `，${item.failed} 项失败` : ''}，${expanded ? '收起' : '展开'}`, `Process, ${parts}${item.failed ? `, ${item.failed} failed` : ''}, ${expanded ? 'collapse' : 'expand'}`)} onPress={() => onToggle(item.key)} style={styles.processHead}>
        <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}><Icon name="chevron-right" size={14} color={p.fgMute} /></View>
        <Text style={{ color: p.fgDim, fontSize: font.sm }}>{parts}</Text>
        {item.failed ? <Text style={{ color: p.err, fontSize: font.sm }}>{pick(`· ${item.failed} 项失败`, `· ${item.failed} failed`)}</Text> : null}
        {live ? <GlyphSpinner /> : null}
      </Pressable>
      {shown.length ? <View style={[styles.steps, { borderLeftColor: p.borderSoft }]}>
        {live && !expanded && item.steps.length > LIVE_STEPS ? <Meta>{pick(`前面还有 ${item.steps.length - LIVE_STEPS} 步`, `${item.steps.length - LIVE_STEPS} earlier steps`)}</Meta> : null}
        {shown.map((step) => {
          if (step.kind === 'text') return <Text key={step.key} selectable style={{ color: p.fgDim, fontSize: font.sm, lineHeight: 20 }}>{step.message.text?.trim() || step.message.error}</Text>
          const open = expandedTools.includes(step.key)
          if (step.kind === 'thinking') return <View key={step.key}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => onToggle(step.key)} style={styles.toolRow}>
              <Icon name="sparkles" size={icon.sm} color={p.fgMute} />
              <Text numberOfLines={open ? undefined : 1} style={{ flex: 1, minWidth: 0, color: p.fgMute, fontSize: font.sm }}>{open ? step.text : `${pick('思考', 'Thinking')}${step.ms ? pick(` ${Math.max(1, Math.round(step.ms / 1000))} 秒`, ` ${Math.max(1, Math.round(step.ms / 1000))}s`) : ''} · ${step.text.split('\n')[0]}`}</Text>
            </Pressable>
          </View>
          const tool = step.tool
          return <View key={step.key}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${tool.name} ${tool.summary}`} disabled={!tool.output && !tool.images.length} onPress={() => onToggle(step.key)} style={[styles.toolRow, tool.nested ? { paddingLeft: space[4] } : null]}>
              <Icon name={toolIcon(tool.name)} size={14} color={tool.failed ? p.err : p.fgMute} />
              <Text numberOfLines={open ? undefined : 1} style={{ flex: 1, minWidth: 0, color: tool.failed ? p.err : p.fgDim, fontSize: font.sm }}>{tool.name}{tool.summary ? <Text style={{ color: p.fgMute, fontFamily: mono, fontSize: font.xs }}>  {tool.summary}</Text> : null}</Text>
              {tool.running || (live && tool.awaiting && !tool.failed && !tool.denied) ? <GlyphSpinner /> : <Text style={[styles.toolMark, { color: tool.failed ? p.err : p.fgMute }]}>{tool.failed ? '✕' : tool.denied ? '–' : '✓'}</Text>}
            </Pressable>
            {tool.images.length ? <View style={styles.thumbs}>{tool.images.map((image, index) => (
              <Pressable key={`${image.messageId}:${image.index}`} accessibilityRole="imagebutton" accessibilityLabel={pick(`${tool.name} 图片 ${index + 1}，点按放大`, `${tool.name} image ${index + 1}, tap to enlarge`)} onPress={() => onView({ ...image, label: `${tool.name} · ${index + 1}/${tool.images.length}` })}>
                <RemoteImage client={client} source={client.imageSource(sessionId, image.messageId, image.index)} resizeMode="cover" style={[styles.thumb, { backgroundColor: p.bg1, borderColor: p.borderSoft }]} />
              </Pressable>
            ))}</View> : null}
            {open && tool.output ? <CodeBlock value={tool.output.length > 4000 ? `…${tool.output.slice(-4000)}` : tool.output} size={font.xs} /> : null}
          </View>
        })}
      </View> : null}
    </View>
  }
  const message = item.message
  if (message.role === 'bash' && message.bash) {
    const failed = message.bash.exitCode !== null && message.bash.exitCode !== 0
    const open = expandedTools.includes(message.id)
    return <View style={styles.process}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => onToggle(message.id)} style={styles.processHead}>
        <Text numberOfLines={open ? undefined : 2} style={{ color: failed ? p.err : p.fgDim, fontSize: font.sm, fontFamily: mono }}>$ {redactCommandSecrets(message.bash.command)}{message.bash.cancelled ? pick('  （已取消）', '  (cancelled)') : failed ? pick(`  （退出码 ${message.bash.exitCode}）`, `  (exit code ${message.bash.exitCode})`) : ''}</Text>
      </Pressable>
      {open && message.text ? <CodeBlock value={message.text.length > 4000 ? `…${message.text.slice(-4000)}` : message.text} size={font.xs} /> : null}
    </View>
  }
  const mine = message.role === 'user'
  const text = message.text?.trim() ?? ''
  const userMenu = mine && text && onCompose ? () => Alert.alert(pick('你的消息', 'Your message'), undefined, [
    { text: pick('编辑后重发', 'Edit and resend'), onPress: () => onCompose(message.text ?? '') },
    { text: pick('分享 / 复制', 'Share / copy'), onPress: () => void Share.share({ message: message.text ?? '' }) },
    { text: pick('取消', 'Cancel'), style: 'cancel' }
  ]) : undefined
  const replyMenu = !mine && text && onCompose ? () => Alert.alert(pick('这条回复', 'This reply'), undefined, [
    { text: pick('引用到输入框', 'Quote in composer'), onPress: () => onCompose(quoted(message.text ?? '')) },
    { text: pick('分享 / 复制', 'Share / copy'), onPress: () => void Share.share({ message: message.text ?? '' }) },
    { text: pick('取消', 'Cancel'), style: 'cancel' }
  ]) : undefined
  const failure = message.error ? classifyModelError(message.error) : null
  const Frame = userMenu ? Pressable : View
  return (
    <Frame {...(userMenu ? { onLongPress: userMenu, accessibilityHint: pick('长按可编辑后重发或分享', 'Long press to edit, resend or share') } : {})} style={mine ? [styles.bubble, { backgroundColor: p.bubble }] : styles.message}>
      <View style={styles.messageMain}>
      {mine && message.question ? <Text style={[styles.tag, { color: p.accent, borderColor: p.borderSoft }]}>{pick('提问', 'Question')}</Text> : null}
      {mine && message.qa?.length ? <View style={{ gap: space[1] }}>{message.qa.map((entry, index) => (
        <View key={index} style={{ gap: 2 }}>
          <Text style={{ color: p.fgDim, fontSize: font.sm }}>{entry.question}</Text>
          {entry.answer ? <Text style={{ color: p.fg, fontSize: font.body }}>{entry.answer}</Text> : null}
        </View>
      ))}</View> : message.text ? <MessageBody text={message.text} selectable={!userMenu} /> : null}
      {message.images?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{message.images.map((_, index) => <Pressable key={index} accessibilityRole="imagebutton" accessibilityLabel={pick(`消息图片 ${index + 1}，点按放大`, `Message image ${index + 1}, tap to enlarge`)} onPress={() => onView({ messageId: message.id, index, label: pick(`图片 ${index + 1}/${message.images!.length}`, `Image ${index + 1}/${message.images!.length}`) })}><RemoteImage client={client} source={client.imageSource(sessionId, message.id, index)} resizeMode="contain" style={{ width: 144, height: 144, borderRadius: radius.md, backgroundColor: p.bg1 }} /></Pressable>)}</View> : null}
      {failure ? <View accessibilityRole="alert" style={[styles.errorCard, { borderColor: p.err }]}>
        <Text style={{ color: p.err, fontSize: font.sm, fontWeight: '600' }}>{errorTitle(failure.kind)}</Text>
        <Text selectable numberOfLines={4} style={{ color: p.fgDim, fontSize: font.xs, fontFamily: mono }}>{message.error}</Text>
        {(onRetry && failure.kind !== 'truncated') || (onCompact && failure.kind === 'context') ? <View style={styles.errorActions}>
          {onCompact && failure.kind === 'context' ? <Pressable accessibilityRole="button" onPress={onCompact} style={styles.errorButton}><Text style={{ color: p.accent, fontSize: font.sm }}>{pick('压缩上下文', 'Compact context')}</Text></Pressable> : null}
          {onRetry && failure.kind !== 'aborted' && failure.kind !== 'truncated' ? <Pressable accessibilityRole="button" onPress={onRetry} style={styles.errorButton}><Text style={{ color: p.accent, fontSize: font.sm }}>{pick('重试', 'Retry')}</Text></Pressable> : null}
        </View> : null}
      </View> : null}
      {(message.artifacts ?? []).map((artifact) => (
        <Pressable
          key={artifact.id}
          accessibilityRole="button"
          disabled={artifact.unavailable}
          onPress={() => onOpenArtifact(artifact)}
          style={[styles.artifact, { opacity: artifact.unavailable ? 0.5 : 1 }]}
        >
          <Icon name="file" size={icon.sm} color={p.fgDim} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: p.accent, fontSize: font.base }}>{artifact.version && artifact.version > 1 ? `${artifact.filename} · v${artifact.version}` : artifact.filename}</Text>
          <Meta>{artifact.unavailable ? pick('文件已不可用', 'File unavailable') : `${Math.max(1, Math.round(artifact.bytes / 1024))} KB`}</Meta>
        </Pressable>
      ))}
      {!mine && message.timestamp && (message.text?.trim() || message.artifacts?.length) ? <View style={styles.metaRow}>
        <Text style={[styles.metaLine, { color: p.fgMute }]}>{[clock(message.timestamp), modelName].filter(Boolean).join(' · ')}</Text>
        {replyMenu ? <Pressable accessibilityRole="button" accessibilityLabel={pick('回复操作：引用或分享', 'Reply actions: quote or share')} hitSlop={10} onPress={replyMenu} style={styles.more}><Text style={{ color: p.fgMute, fontSize: font.sm }}>⋯</Text></Pressable> : null}
      </View> : null}
      </View>
    </Frame>
  )
})

const styles = StyleSheet.create({
  message: { flexDirection: 'row', gap: space[2], maxWidth: '100%' },
  bubble: { alignSelf: 'flex-end', maxWidth: '86%', flexDirection: 'row', borderRadius: radius.bubble, paddingHorizontal: space[3], paddingVertical: space[2] - 1 },
  metaLine: { fontSize: font.xs, fontFamily: mono },
  messageMain: { flexShrink: 1, minWidth: 0, gap: space[1], alignItems: 'flex-start' },
  meta: { fontSize: font.xs },
  process: { alignSelf: 'stretch' },
  processHead: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[1], alignSelf: 'flex-start' },
  steps: { borderLeftWidth: 1, marginLeft: space[1], paddingLeft: space[3], gap: space[1], paddingVertical: space[1] },
  toolRow: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  toolMark: { width: 14, textAlign: 'center', fontSize: font.xs },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], paddingVertical: space[1] },
  thumb: { width: 96, height: 96, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  artifact: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space[2], maxWidth: '100%' },
  notice: { alignSelf: 'stretch', gap: space[1] },
  noticeHead: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  rule: { flex: 1, minWidth: space[3], height: StyleSheet.hairlineWidth },
  tag: { alignSelf: 'flex-end', fontSize: font.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space[1] },
  errorCard: { alignSelf: 'stretch', gap: space[1], borderLeftWidth: 2, paddingLeft: space[2], paddingVertical: space[1] },
  errorActions: { flexDirection: 'row', gap: space[3] },
  errorButton: { minHeight: 36, justifyContent: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space[2], marginTop: space[1] },
  more: { minWidth: 28, minHeight: 24, alignItems: 'center', justifyContent: 'center' }
})
