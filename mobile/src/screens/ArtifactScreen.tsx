import { RemoteImage } from '../components/RemoteImage'
import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRemote } from '../state'
import { font, mono, space, usePalette } from '../theme'
import { EmptyState, Header, IconButton } from '../ui'

export function ArtifactScreen({
  sessionId,
  artifact,
  onBack,
  onToggleSidebar,
  sidebarVisible
}: {
  sessionId: string
  artifact: { id: string; filename: string; mediaType: string; kind: string }
  onBack: () => void
  onToggleSidebar?: () => void
  sidebarVisible?: boolean
}) {
  const p = usePalette()
  const { client } = useRemote()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isImage = artifact.kind === 'image' || artifact.mediaType.startsWith('image/')
  const isText = artifact.kind === 'code' || artifact.mediaType.startsWith('text/') || artifact.mediaType === 'application/json'

  useEffect(() => {
    if (!isText) return
    let alive = true
    setText(null)
    setError(null)
    client.artifactText(sessionId, artifact.id).then(value => { if (alive) setText(value) }).catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : '读取成果失败')
    })
    return () => { alive = false }
  }, [artifact.id, client, isText, sessionId])

  return (
    <View style={[styles.root, { backgroundColor: p.bg0 }]}>
      <Header
        title={artifact.filename}
        subtitle={artifact.mediaType}
        left={<View style={{ flexDirection: 'row' }}>{onToggleSidebar ? <IconButton name="sidebar-left" label={sidebarVisible ? '收起项目和会话列表' : '展开项目和会话列表'} onPress={onToggleSidebar} /> : null}<IconButton name="back" label="返回会话" onPress={onBack} /></View>}
      />
      {error ? <Text style={[styles.error, { color: p.err }]}>{error}</Text> : null}
      {isImage ? (
        <RemoteImage client={client} style={styles.image} resizeMode="contain" source={client.artifactSource(sessionId, artifact.id)} accessibilityLabel={artifact.filename} />
      ) : isText ? (
        <ScrollView contentContainerStyle={styles.textBox}>
          <Text selectable style={[styles.text, { color: p.fg }]}>{text ?? '读取中…'}</Text>
        </ScrollView>
      ) : (
        <EmptyState>请在电脑上打开 {artifact.mediaType} 文件。</EmptyState>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  error: { padding: space[4], fontSize: font.sm },
  image: { flex: 1, margin: space[3] },
  textBox: { padding: space[4] },
  text: { fontFamily: mono, fontSize: font.sm, lineHeight: 20 }
})
