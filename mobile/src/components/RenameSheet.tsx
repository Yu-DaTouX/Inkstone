import { pick } from '../../../src/shared/ui-lang'
import { useEffect, useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { RemoteHttpError } from '../api/client'
import { useRemote } from '../state'
import { IconButton, Input } from '../ui'
import { RunDot } from '../motion'
import { font, mono, radius, space, usePalette } from '../theme'

export function RenameSheet({ sessionId, initial, visible, onClose }: { sessionId: string; initial: string; visible: boolean; onClose(): void }) {
  const p = usePalette()
  const { client, refresh } = useRemote()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (visible) { setName(initial); setError(null) }
  }, [initial, visible])
  const save = async () => {
    const next = name.trim()
    if (!next || busy) return
    if (next === initial.trim()) { onClose(); return }
    setBusy(true); setError(null)
    try {
      await client.renameSession(sessionId, next)
      void refresh()
      onClose()
    } catch (err) {
      setError(err instanceof RemoteHttpError ? err.message : pick('改名失败', 'Rename failed'))
    } finally { setBusy(false) }
  }
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose() }} statusBarTranslucent navigationBarTranslucent>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'center' }}>
      <Pressable accessibilityLabel={pick('关闭', 'Close')} onPress={() => { if (!busy) onClose() }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <SafeAreaView edges={['bottom', 'left', 'right']} style={{ width: '100%', maxWidth: 640, backgroundColor: p.bg1, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingBottom: space[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: space[3] }}>
          <Text accessibilityRole="header" style={{ flex: 1, fontFamily: mono, fontSize: font.base, color: p.fgMute }}>{pick('重命名', 'Rename')}</Text>
          {busy ? <RunDot label={pick('正在保存', 'Saving')} /> : <IconButton name="check" label={pick('保存名称', 'Save name')} primary disabled={!name.trim()} onPress={() => void save()} />}
        </View>
        <Input inset autoFocus value={name} onChangeText={setName} maxLength={200} returnKeyType="done" onSubmitEditing={() => void save()} accessibilityLabel={pick('会话名称', 'Session name')} style={{ marginHorizontal: space[4] }} />
        {error ? <Text accessibilityLiveRegion="polite" style={{ padding: space[4], color: p.err, fontSize: font.sm }}>{error}</Text> : null}
      </SafeAreaView>
    </View>
  </Modal>
}
