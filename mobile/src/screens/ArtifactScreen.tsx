import { useEffect, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRemote } from '../state'
import { font, space, usePalette } from '../theme'
import { EmptyState, Header, IconButton } from '../ui'

/**
 * 查看成果：图片与文本直接显示真实文件内容（从电脑按成果 id 读取），其它格式提示到电脑上打开。
 * 需求稿：预览必须对应实际文件，不能用模型声称「已修改」的文字代替。
 */
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
    client.artifactText(sessionId, artifact.id).then(setText).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : '读取成果失败')
    })
  }, [artifact.id, client, isText, sessionId])

  return (
    <View style={[styles.root, { backgroundColor: p.bg0 }]}>
      <Header
        title={artifact.filename}
        right={onToggleSidebar ? <IconButton name="sidebar-left" label={sidebarVisible ? '收起项目和会话列表' : '展开项目和会话列表'} onPress={onToggleSidebar} /> : undefined}
        left={
          <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={onBack} hitSlop={12}>
            <Text style={{ color: p.accent, fontSize: font.base }}>返回</Text>
          </Pressable>
        }
      />
      {error ? <Text style={[styles.error, { color: p.err }]}>{error}</Text> : null}
      {isImage ? (
        <Image style={styles.image} resizeMode="contain" source={client.artifactSource(sessionId, artifact.id)} accessibilityLabel={artifact.filename} />
      ) : isText ? (
        <ScrollView contentContainerStyle={styles.textBox}>
          <Text selectable style={[styles.text, { color: p.fg }]}>{text ?? '读取中…'}</Text>
        </ScrollView>
      ) : (
        <EmptyState>这种格式（{artifact.mediaType}）请在电脑上打开查看</EmptyState>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  error: { padding: space[4], fontSize: font.sm },
  image: { flex: 1, margin: space[3] },
  textBox: { padding: space[4] },
  text: { fontFamily: 'monospace', fontSize: font.sm, lineHeight: 20 }
})
