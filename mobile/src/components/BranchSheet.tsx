import { useEffect, useState } from 'react'
import { FlatList, Modal, Pressable, Text, useWindowDimensions, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRemote } from '../state'
import { Icon } from '../icons'
import { IconButton, Meta } from '../ui'
import { RunDot } from '../motion'
import { font, icon, mono, radius, space, usePalette } from '../theme'

type Branch = { name: string; current: boolean; busy?: boolean }

export function BranchSheet({ sessionId, visible, running, onClose, onSwitched }: { sessionId: string; visible: boolean; running: boolean; onClose(): void; onSwitched(): void }) {
  const p = usePalette()
  const { height } = useWindowDimensions()
  const { client } = useRemote()
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!visible) return
    let alive = true
    setLoading(true); setError(null)
    void client.branches(sessionId).then((result) => { if (alive) setBranches(result.branches) })
      .catch((err: Error) => { if (alive) setError(err.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [client, sessionId, visible])
  const choose = async (branch: Branch) => {
    if (busy || branch.current) return
    setBusy(branch.name); setError(null)
    try {
      await client.switchBranch(sessionId, branch.name)
      onSwitched()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换失败')
    } finally { setBusy(null) }
  }
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose() }} statusBarTranslucent navigationBarTranslucent>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'center' }}>
      <Pressable accessibilityLabel="关闭分支选择" onPress={() => { if (!busy) onClose() }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <SafeAreaView edges={['bottom', 'left', 'right']} style={{ width: '100%', maxWidth: 640, maxHeight: height * 0.7, backgroundColor: p.bg1, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: space[3] }}>
          <Text accessibilityRole="header" style={{ flex: 1, fontFamily: mono, fontSize: font.base, color: p.fgMute }}>分支</Text>
          {running ? <Text style={{ fontSize: font.xs, color: p.fgMute, marginRight: space[2] }}>运行中不能切换</Text> : null}
          {busy ? <RunDot label="正在切换" /> : <IconButton name="close" label="关闭分支选择" onPress={onClose} />}
        </View>
        {error ? <Text accessibilityLiveRegion="polite" style={{ paddingHorizontal: space[4], paddingBottom: space[2], color: p.err, fontSize: font.sm }}>{error}</Text> : null}
        <FlatList
          data={branches}
          keyExtractor={(branch) => branch.name}
          contentContainerStyle={{ padding: space[4] }}
          ListEmptyComponent={loading ? <View style={{ alignItems: 'center', paddingVertical: space[4] }}><RunDot label="读取分支" /></View> : <Meta style={{ fontSize: font.sm }}>{error ? '' : '没有本地分支'}</Meta>}
          renderItem={({ item }) => <Pressable disabled={!!busy || running || item.current} accessibilityRole="button" accessibilityState={{ selected: item.current, disabled: !!busy || running }} accessibilityLabel={item.current ? `当前分支 ${item.name}` : `切换到 ${item.name}`} onPress={() => void choose(item)} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48, paddingHorizontal: space[2], borderRadius: radius.sm, backgroundColor: item.current ? p.bg3 : 'transparent', opacity: running && !item.current ? 0.5 : 1 }}>
            <View style={{ width: 20 }}>{item.current ? <Icon name="check" size={icon.sm} color={p.accent} /> : <Icon name="branch" size={icon.sm} color={p.fgMute} />}</View>
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: p.fg, fontFamily: mono, fontSize: font.sm }}>{item.name}</Text>
            {item.busy ? <Meta>其他工作区</Meta> : null}
          </Pressable>}
        />
      </SafeAreaView>
    </View>
  </Modal>
}
