import { pick } from '../../../src/shared/ui-lang'
import { Modal, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native'
import type { RemoteClient } from '../api/client'
import { Icon } from '../icons'
import { font, icon, space, touch, usePalette } from '../theme'
import { RemoteImage } from './RemoteImage'

export function ImageViewer({ client, source, label, onClose }: { client: RemoteClient; source: { uri: string; headers: Record<string, string> } | null; label: string; onClose: () => void }) {
  const p = usePalette()
  return (
    <Modal visible={!!source} animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel={pick('关闭图片', 'Close image')} onPress={onClose} style={[styles.backdrop, { backgroundColor: p.bg0 }]}>
        {source ? <RemoteImage client={client} source={source} resizeMode="contain" accessibilityLabel={label} style={styles.image} /> : null}
        <View style={[styles.bar, { top: (StatusBar.currentHeight ?? 0) + space[2] }]} pointerEvents="none">
          <Text numberOfLines={1} style={[styles.label, { color: p.fgDim }]}>{label}</Text>
          <Icon name="close" size={icon.md} color={p.fg} />
        </View>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  bar: { position: 'absolute', left: space[4], right: space[4], minHeight: touch.min, flexDirection: 'row', alignItems: 'center', gap: space[3] },
  label: { flex: 1, fontSize: font.sm }
})
