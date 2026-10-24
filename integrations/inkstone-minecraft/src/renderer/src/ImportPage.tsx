import { useEffect, useState, type ReactElement } from 'react'
import { FolderPlus, Import } from 'lucide-react'
import { Badge } from '@yan/ui/Badge'
import { Button } from '@yan/ui/Button'
import { Notice } from '@yan/ui/Notice'
import { SettingRow, SettingSection } from '@yan/ui/SettingRow'
import type { LauncherSettings, PclAccountRef, PclSnapshot } from '../../shared/api.ts'
import { PageHead } from './SubNavLayout.tsx'

const ACCOUNT_LABEL: Record<PclAccountRef['type'], string> = {
  microsoft: '正版',
  authlib: '外置登录',
  offline: '离线',
  unknown: '其他'
}

interface Props {
  settings: LauncherSettings
  apply(next: Promise<LauncherSettings>): Promise<void>
  onDone(): void
}

export function ImportPage({ settings, apply, onDone }: Props): ReactElement {
  const [snapshot, setSnapshot] = useState<PclSnapshot | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.craft.pclSnapshot().then(setSnapshot, (cause: unknown) => setError(String(cause)))
  }, [])

  const run = async (): Promise<void> => {
    setWorking(true)
    setError('')
    try {
      await apply(window.craft.importPcl())
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorking(false)
    }
  }

  const addFolder = async (): Promise<void> => {
    const path = await window.craft.pickFolder()
    if (!path) return
    const folders = settings.folders.some((item) => item.path.toLowerCase() === path.toLowerCase()) ? settings.folders : [...settings.folders, { name: path, path }]
    await apply(window.craft.updateSettings({ folders, selectedFolder: path }))
    onDone()
  }

  return (
    <div className="subpage">
      <PageHead title="从 PCL 迁移" description="只读取 PCL 的配置，不改动它的任何文件。" />
        <SettingSection
          title={snapshot?.found ? '找到的 PCL 设置' : 'PCL 设置'}
          actions={
            <>
              <Button size="sm" icon={<FolderPlus size={14} />} onPress={() => void addFolder()}>
                选择游戏目录
              </Button>
              <Button size="sm" variant="primary" icon={<Import size={14} />} isDisabled={!snapshot?.found || working} onPress={() => void run()}>
                {working ? '正在迁移…' : settings.importedFromPclAt ? '重新迁移' : '迁移这些设置'}
              </Button>
            </>
          }
        >
          {!snapshot ? (
            <SettingRow label="正在查找 PCL…" />
          ) : !snapshot.found ? (
            <SettingRow label="没有找到 PCL 的配置" description="可以直接选择一个 .minecraft 游戏目录。" />
          ) : (
            <>
              <SettingRow label="游戏目录" description={snapshot.folders.map((folder) => `${folder.name} · ${folder.path}`).join('\n') || '无'} block />
              <SettingRow label="上次选择的版本" description={snapshot.selectedVersion ?? '无'} />
              <SettingRow label="Java" description={snapshot.javaPaths.length > 0 ? `${snapshot.javaPaths.length} 个自定义 Java` : '没有自定义 Java'} />
              <SettingRow label="账号" block>
                <div className="import-accounts">
                  {snapshot.accounts.length === 0 ? <span className="page__muted">无</span> : null}
                  {snapshot.accounts.map((account) => (
                    <span key={`${account.type}:${account.uuid}`} className="import-account">
                      <Badge tone={account.type === 'microsoft' ? 'ok' : account.type === 'authlib' ? 'accent' : 'neutral'}>{account.serverName ?? ACCOUNT_LABEL[account.type]}</Badge>
                      {account.username}
                    </span>
                  ))}
                </div>
              </SettingRow>
            </>
          )}
        </SettingSection>
        <Notice tone="info" compact>
          账号只带走类型、名字和皮肤站地址，令牌和密码不会读取；正版与外置账号迁移后需要重新登录一次。
        </Notice>
        {error ? (
          <Notice tone="fail" compact>
            {error}
          </Notice>
        ) : null}
        {snapshot?.sources.length ? <p className="page__muted">读取自：{snapshot.sources.join('；')}</p> : null}
    </div>
  )
}
